import type { OpenCodeClient, OpenCodeEvent, SessionInfo } from "@opencode/client";

import { createEventFactory, type RehorEvent, type RehorRun } from "../../src/domain";
import type { AgentRuntime } from "../../src/ports/agent-runtime";
import { LegacyCompatibilityProjection } from "../../src/projections/compatibility";
import { ClaudeAgentRuntime, type ClaudeQueryFunction } from "../../src/runtimes/claude-agent";
import {
  OpenCodeRuntime,
  type OpenCodeServerController,
  type OpenCodeServerInfo,
  renderOpenCodeConfig,
} from "../../src/runtimes/opencode";
import { FakeAgentRuntime } from "../../src/testing/fake-agent-runtime";

const TASK_UPDATE_INPUT = {
  jira_key: "REHOR-146",
  repo: "rehor",
  status: "pr_open",
  summary: "Follow-up A",
};
const TASK_UPDATE_RESULT = JSON.stringify({ id: 42, external_key: "REHOR-146" });
const NO_WORK_TEXT = "No actionable work was found.";

export function metricsProjection(metrics: unknown[]): LegacyCompatibilityProjection {
  return new LegacyCompatibilityProjection({
    metrics: { observe: (point) => void metrics.push(point) },
  });
}

/**
 * Scripts one production adapter through the situations the AgentRuntime
 * contract covers. Each call returns a fresh, unstarted runtime whose SDK or
 * server boundary is scripted; everything behind that boundary is real.
 */
export interface RuntimeContractHarness {
  name: string;
  enforcesTurnLimit: boolean;
  run: RehorRun;
  /** The provider session finishes successfully. */
  completed(): AgentRuntime;
  /** The provider session completes with a recognized no-work result. */
  noWork(): AgentRuntime;
  /** Setup fails before any provider session exists. */
  failsBeforeSession(): AgentRuntime;
  /** A session starts and then waits until the attempt is aborted. */
  blocksUntilAborted(): { runtime: AgentRuntime; waiting: Promise<void> };
  /** A session reports this many successful normalized tool completions. */
  toolCalls(count: number): AgentRuntime;
  /** The session finishes, then releasing its resources fails. */
  completedWithCleanupFailure?(): AgentRuntime;
}

export function fakeHarness(): RuntimeContractHarness {
  const run: RehorRun = {
    ...baseRun,
    provider: { id: "fake-provider", requestedModel: "fake-model" },
  };
  const eventsFor = (resultText = "Contract cycle finished"): RehorEvent[] => {
    const createEvent = createEventFactory(run, "fake-runtime-v1");
    return [
      createEvent("run", { state: "started" }),
      createEvent("terminal", { state: "completed", resultText }),
    ];
  };

  return {
    name: "fake",
    enforcesTurnLimit: false,
    run,
    completed: () => new FakeAgentRuntime({ events: eventsFor() }),
    noWork: () => new FakeAgentRuntime({ events: eventsFor(NO_WORK_TEXT) }),
    failsBeforeSession: () =>
      new FakeAgentRuntime({
        events: eventsFor().slice(0, 1),
        error: new Error("Fake runtime setup failed"),
      }),
    blocksUntilAborted: () => {
      const waiting = deferred();
      const runtime = new FakeAgentRuntime();
      runtime.run = (input, signal) =>
        (async function* (): AsyncGenerator<RehorEvent> {
          const createEvent = createEventFactory(input, "fake-runtime-v1");
          yield createEvent("run", { state: "started" });
          waiting.resolve();
          await waitForAbort(signal, () => undefined);
          yield createEvent("terminal", { state: "failed", reason: "Fake runtime aborted" });
        })();
      return { runtime, waiting: waiting.promise };
    },
    toolCalls: (count) => {
      const createEvent = createEventFactory(run, "fake-runtime-v1");
      return new FakeAgentRuntime({
        events: [
          createEvent("run", { state: "started" }),
          ...Array.from({ length: count }, (_, index) =>
            createEvent("tool", {
              state: "completed",
              toolUseId: `fake-tool-${index}`,
              name: "mcp__bot-memory__task_update",
              input: TASK_UPDATE_INPUT,
              content: TASK_UPDATE_RESULT,
            }),
          ),
          createEvent("run", { state: "turn_started" }),
          createEvent("terminal", { state: "completed", resultText: "Contract cycle finished" }),
        ],
      });
    },
  };
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
    enforcesTurnLimit: true,
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
    noWork: () =>
      new ClaudeAgentRuntime({
        query: scripted(async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: NO_WORK_TEXT,
            num_turns: 1,
            session_id: "session-contract",
            uuid: "no-work-result",
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
    toolCalls: (count) =>
      new ClaudeAgentRuntime({
        query: ({ options }) => {
          const postToolUse = postToolUseHook(options);
          return Object.assign(
            (async function* (): AsyncGenerator<unknown> {
              for (let index = 0; index < count; index += 1) {
                const toolUseId = `claude-tool-${index}`;
                yield {
                  type: "assistant",
                  session_id: "session-budget",
                  message: {
                    model: "claude-opus-4-6",
                    content: [
                      {
                        type: "tool_use",
                        id: toolUseId,
                        name: "mcp__bot-memory__task_update",
                        input: {
                          ...TASK_UPDATE_INPUT,
                        },
                      },
                    ],
                  },
                };
                await postToolUse?.({}, toolUseId, {});
                yield {
                  type: "user",
                  session_id: "session-budget",
                  message: [
                    {
                      type: "tool_result",
                      tool_use_id: toolUseId,
                      content: TASK_UPDATE_RESULT,
                      is_error: false,
                    },
                  ],
                };
              }
              yield {
                type: "result",
                subtype: count >= Number(options.maxTurns) ? "error_max_turns" : "success",
                result: "Contract cycle finished",
                num_turns: count,
                session_id: "session-budget",
                uuid: "budget-result",
              };
            })(),
            { close: () => undefined },
          );
        },
      }),
  };
}

interface OpenCodeScript {
  serverStartError?: Error;
  deleteError?: Error;
  blockUntilAborted?: () => void;
  events?: OpenCodeEvent[];
}

export function postToolUseHook(options: Record<string, unknown>) {
  const hooks = options.hooks as {
    PostToolUse?: Array<{
      hooks: Array<(...args: unknown[]) => Promise<Record<string, unknown>>>;
    }>;
  };
  return hooks.PostToolUse?.[0]?.hooks[0];
}

export function openCodeHarness(): RuntimeContractHarness {
  const run: RehorRun = {
    ...baseRun,
    runtimeId: "opencode",
    provider: { id: "rehor-openai", requestedModel: "rehor-openai/gpt-5.6-luna" },
  };
  const renderedConfig = renderOpenCodeConfig({
    model: run.provider.requestedModel,
    providerId: run.provider.id,
  });
  let sequence = 0;
  const envelope = (version: 1 | 2 = 1) => ({
    id: `event-contract-${++sequence}`,
    created: sequence,
    durable: { aggregateID: "session-contract", seq: sequence, version },
  });
  const assistantMessage = (id: string, created: number): OpenCodeEvent => ({
    ...envelope(),
    type: "session.step.started",
    durable: { aggregateID: "session-contract", seq: sequence, version: 1 },
    data: {
      sessionID: "session-contract",
      assistantMessageID: id,
      agent: "build",
      model: { providerID: "rehor-openai", id: "gpt-5.6-luna" },
      started: created,
    },
  });
  const idle = (): OpenCodeEvent => ({
    id: `idle-contract-${++sequence}`,
    created: sequence,
    type: "session.idle",
    data: { sessionID: "session-contract" },
  });
  const create = (script: OpenCodeScript): AgentRuntime => {
    const server: OpenCodeServerInfo = {
      baseUrl: "http://127.0.0.1:41236",
      hostname: "127.0.0.1",
      port: 41236,
      directory: run.worktree.path,
      healthy: true,
      version: "2.1.2",
      configHash: run.configHash.value,
      capabilities: {},
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
      yield { id: "connected-contract", type: "server.connected", data: {} };
      if (script.blockUntilAborted) {
        await waitForAbort(signal, script.blockUntilAborted);
        throw new Error("OpenCode event stream aborted");
      }
      for (const event of script.events ?? []) {
        yield event;
      }
      yield {
        ...envelope(),
        type: "session.execution.succeeded",
        durable: { aggregateID: sessionId, seq: sequence, version: 1 },
        data: { sessionID: sessionId },
      };
      yield idle();
    };
    const session: SessionInfo = {
      id: sessionId,
      projectID: "project-contract",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
      location: { directory: run.worktree.path },
    };
    const client = {
      event: {
        subscribe: ({ signal }: { signal: AbortSignal }) => stream(signal),
      },
      plugin: {
        list: async () => ({
          location: { directory: run.worktree.path },
          data: [
            {
              id: "rehor-policy",
              source: { type: "local", path: "/policy.js" },
              features: { server: true },
              state: { status: "active" },
            },
          ],
        }),
      },
      session: {
        create: async () => session,
        prompt: async () => ({
          id: "input-contract",
          sessionID: sessionId,
          time: { created: 0 },
          type: "user",
          payload: { text: run.prompt },
          delivery: "queue",
        }),
        active: async () => ({ [sessionId]: { type: "running" } }),
        get: async () => session,
        interrupt: async () => ({}),
        remove: async () => {
          if (script.deleteError) throw script.deleteError;
        },
      },
      message: { list: async () => ({ data: [], cursor: {} }) },
    } as unknown as OpenCodeClient;

    return new OpenCodeRuntime({
      supervisor: () => supervisor,
      clientFactory: () => client,
      renderedConfig,
      reconciliationTimeoutMs: 50,
      cleanupTimeoutMs: 200,
    });
  };

  return {
    name: "opencode",
    enforcesTurnLimit: false,
    run,
    completed: () => create({}),
    noWork: () =>
      create({
        events: [
          assistantMessage("no-work-message", 1),
          {
            ...envelope(),
            type: "session.text.ended",
            durable: { aggregateID: "session-contract", seq: sequence, version: 1 },
            data: {
              assistantMessageID: "no-work-message",
              sessionID: "session-contract",
              ordinal: 0,
              text: NO_WORK_TEXT,
            },
          },
        ],
      }),
    failsBeforeSession: () => create({ serverStartError: new Error("OpenCode server not ready") }),
    blocksUntilAborted: () => {
      const waiting = deferred();
      return { runtime: create({ blockUntilAborted: waiting.resolve }), waiting: waiting.promise };
    },
    toolCalls: (count) =>
      create({
        events: [
          assistantMessage("budget-message", 1),
          ...Array.from({ length: count }, (_, index): OpenCodeEvent[] => {
            const data = {
              sessionID: "session-contract",
              assistantMessageID: "budget-message",
              id: `budget-call-${index}`,
            };
            return [
              {
                ...envelope(),
                type: "session.tool.input.started",
                durable: { aggregateID: "session-contract", seq: sequence, version: 1 },
                data: { ...data, name: "bot-memory_task_update" },
              },
              {
                ...envelope(),
                type: "session.tool.called",
                durable: { aggregateID: "session-contract", seq: sequence, version: 1 },
                data: { ...data, input: TASK_UPDATE_INPUT, executed: true },
              },
              {
                ...envelope(2),
                type: "session.tool.success",
                durable: { aggregateID: "session-contract", seq: sequence, version: 2 },
                data: {
                  ...data,
                  content: [{ type: "text", text: TASK_UPDATE_RESULT }],
                  executed: true,
                },
              },
            ];
          }).flat(),
          assistantMessage("budget-next-turn", count + 1),
        ],
      }),
    completedWithCleanupFailure: () =>
      create({ deleteError: new Error("session delete rejected") }),
  };
}
