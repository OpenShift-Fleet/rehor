import type { Event as OpenCodeEvent, OpencodeClient } from "@opencode-ai/sdk";

import type { RehorRun } from "../../src/domain";
import type { AgentRuntime } from "../../src/ports/agent-runtime";
import { ClaudeAgentRuntime, type ClaudeQueryFunction } from "../../src/runtimes/claude-agent";
import {
  type OpenCodeServerController,
  type OpenCodeServerInfo,
  OpenCodeV1Runtime,
  renderOpenCodeV1Config,
} from "../../src/runtimes/opencode-v1";

/**
 * Scripts one production adapter through the situations the AgentRuntime
 * contract covers. Each call returns a fresh, unstarted runtime whose SDK or
 * server boundary is scripted; everything behind that boundary is real.
 */
export interface RuntimeContractHarness {
  name: string;
  run: RehorRun;
  /** The provider session finishes successfully. */
  completed(): AgentRuntime;
  /** Setup fails before any provider session exists. */
  failsBeforeSession(): AgentRuntime;
  /** A session starts and then waits until the attempt is aborted. */
  blocksUntilAborted(): { runtime: AgentRuntime; waiting: Promise<void> };
  /** The session finishes, then releasing its resources fails. */
  completedWithCleanupFailure?(): AgentRuntime;
}

const baseRun: Omit<RehorRun, "provider"> = {
  schemaVersion: "1",
  runId: "run-contract",
  attemptId: "attempt-contract",
  instanceId: "instance-contract",
  label: "hcc-ai-framework",
  workflowId: "jira-sprint",
  prompt: "Follow the instructions and handle the preflight data.",
  task: null,
  worktree: {
    path: "/work/rehor",
    repository: "https://github.com/OpenShift-Fleet/rehor.git",
    snapshot: { ref: "refs/heads/contract", commitSha: "abc123", dirty: false },
  },
  instructionHash: { algorithm: "sha256", value: "1".repeat(64) },
  configHash: { algorithm: "sha256", value: "2".repeat(64) },
  policyHash: { algorithm: "sha256", value: "3".repeat(64) },
  limits: { timeoutMs: 5_000, maxTurns: 20 },
  preflightPayloadRef: null,
};

function waitForAbort(signal: AbortSignal, onWaiting: () => void): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
    } else {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }
    onWaiting();
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function claudeHarness(): RuntimeContractHarness {
  const run: RehorRun = {
    ...baseRun,
    provider: { id: "vertex", requestedModel: "claude-opus-4-6" },
  };
  const scripted =
    (messages: (signal: AbortSignal) => AsyncGenerator<unknown>): ClaudeQueryFunction =>
    ({ options }) => {
      const controller = options.abortController as AbortController;
      return Object.assign(messages(controller.signal), { close: () => undefined });
    };

  return {
    name: "claude",
    run,
    completed: () =>
      new ClaudeAgentRuntime({
        query: scripted(async function* () {
          yield { type: "system", subtype: "init", session_id: "session-contract", uuid: "init" };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "Contract cycle finished",
            num_turns: 1,
            duration_ms: 5,
            session_id: "session-contract",
            uuid: "result",
          };
        }),
      }),
    failsBeforeSession: () =>
      new ClaudeAgentRuntime({
        query: () => {
          throw new Error("Claude CLI executable not found");
        },
      }),
    blocksUntilAborted: () => {
      const waiting = deferred();
      const runtime = new ClaudeAgentRuntime({
        query: scripted(async function* (signal) {
          yield { type: "system", subtype: "init", session_id: "session-contract", uuid: "init" };
          await waitForAbort(signal, waiting.resolve);
          const error = new Error("Claude query aborted");
          error.name = "AbortError";
          throw error;
        }),
      });
      return { runtime, waiting: waiting.promise };
    },
  };
}

interface OpenCodeScript {
  serverStartError?: Error;
  deleteError?: Error;
  blockUntilAborted?: () => void;
}

export function openCodeHarness(): RuntimeContractHarness {
  const run: RehorRun = {
    ...baseRun,
    provider: { id: "rehor-openai", requestedModel: "rehor-openai/gpt-5.6-luna" },
  };
  const renderedConfig = renderOpenCodeV1Config({
    model: run.provider.requestedModel,
    providerId: run.provider.id,
  });

  const create = (script: OpenCodeScript): AgentRuntime => {
    const server: OpenCodeServerInfo = {
      baseUrl: "http://127.0.0.1:41236",
      hostname: "127.0.0.1",
      port: 41236,
      directory: run.worktree.path,
      healthy: true,
      version: "1.18.29",
      configHash: run.configHash.value,
      capabilities: ["sse", "sessions"],
    };
    let active: OpenCodeServerInfo | undefined;
    const supervisor: OpenCodeServerController = {
      crashSignal: new AbortController().signal,
      crashError: undefined,
      get info() {
        return active;
      },
      async start() {
        if (script.serverStartError) throw script.serverStartError;
        active = server;
        return server;
      },
      async stop() {
        active = undefined;
      },
    };
    const sessionId = "session-contract";
    const stream = async function* (signal: AbortSignal): AsyncGenerator<OpenCodeEvent> {
      yield { type: "server.connected", properties: {} } as unknown as OpenCodeEvent;
      if (script.blockUntilAborted) {
        await waitForAbort(signal, script.blockUntilAborted);
        throw new Error("OpenCode event stream aborted");
      }
      yield {
        type: "session.idle",
        properties: { sessionID: sessionId },
      } as unknown as OpenCodeEvent;
    };
    const client = {
      event: {
        subscribe: async ({ signal }: { signal: AbortSignal }) => ({ stream: stream(signal) }),
      },
      session: {
        create: async () => ({ data: { id: sessionId } }),
        promptAsync: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        status: async () => ({ data: { [sessionId]: { type: "busy" } } }),
        abort: async () => ({ data: {} }),
        delete: async () => {
          if (script.deleteError) throw script.deleteError;
          return { data: {} };
        },
      },
    } as unknown as OpencodeClient;

    return new OpenCodeV1Runtime({
      supervisor: () => supervisor,
      clientFactory: () => client,
      renderedConfig,
      reconciliationTimeoutMs: 50,
      cleanupTimeoutMs: 200,
    });
  };

  return {
    name: "opencode-v1",
    run,
    completed: () => create({}),
    failsBeforeSession: () => create({ serverStartError: new Error("OpenCode server not ready") }),
    blocksUntilAborted: () => {
      const waiting = deferred();
      return { runtime: create({ blockUntilAborted: waiting.resolve }), waiting: waiting.promise };
    },
    completedWithCleanupFailure: () =>
      create({ deleteError: new Error("session delete rejected") }),
  };
}
