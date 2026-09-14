import { describe, expect, it } from "vitest";

import {
  type AgentRuntime,
  type CoordinatorProjection,
  executeRun,
  type RehorEvent,
  type RehorRun,
  type RuntimeCapabilities,
} from "../src";
import { FakeAgentRuntime } from "../src/testing/fake-agent-runtime";

const run: RehorRun = {
  schemaVersion: "1",
  runId: "run-coordinator",
  attemptId: "attempt-coordinator",
  instanceId: "instance-01",
  label: "hcc-ai-framework",
  workflowId: "jira-sprint",
  prompt: "Run the cycle.",
  task: null,
  worktree: {
    path: "/work/rehor",
    repository: "https://github.com/OpenShift-Fleet/rehor.git",
    snapshot: { ref: "refs/heads/rehor-139", commitSha: "abc123", dirty: false },
  },
  instructionHash: { algorithm: "sha256", value: "1".repeat(64) },
  configHash: { algorithm: "sha256", value: "2".repeat(64) },
  policyHash: { algorithm: "sha256", value: "3".repeat(64) },
  provider: { id: "vertex", requestedModel: "claude-opus-4-6" },
  limits: { timeoutMs: 100, maxTurns: 20 },
  preflightPayloadRef: null,
};

const capabilities: RuntimeCapabilities = {
  runtimeId: "test-runtime",
  runtimeVersion: "test",
  configVersion: "test",
  streaming: true,
  interruption: true,
  childSessions: false,
  toolSupport: true,
  mcpSupport: true,
  structuredOutput: true,
  usageGuarantee: "partial-and-final",
};

function event(overrides: Partial<RehorEvent> = {}): RehorEvent {
  return {
    schemaVersion: "1",
    eventId: "event-01",
    runId: run.runId,
    attemptId: run.attemptId,
    sequence: 1,
    occurredAt: "2026-09-07T12:00:00.000Z",
    kind: "run",
    workspace: {
      worktreePath: run.worktree.path,
      repository: run.worktree.repository,
      snapshot: run.worktree.snapshot.commitSha,
    },
    provider: run.provider.id,
    model: run.provider.requestedModel,
    policyVersion: "policy-1",
    payload: { state: "started" },
    ...overrides,
  };
}

function terminal(sequence = 2): RehorEvent {
  return event({
    eventId: "terminal-01",
    sequence,
    kind: "terminal",
    payload: { state: "completed", resultText: "done", turns: 2 },
  });
}

class HangingRuntime implements AgentRuntime {
  startCalls = 0;
  runCalls = 0;
  stopCalls = 0;

  async start(signal: AbortSignal): Promise<RuntimeCapabilities> {
    this.startCalls += 1;
    if (signal.aborted) throw new Error("start aborted");
    return capabilities;
  }

  run(input: RehorRun, signal: AbortSignal): AsyncIterable<RehorEvent> {
    this.runCalls += 1;
    return this.stream(input, signal);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  private async *stream(input: RehorRun, signal: AbortSignal): AsyncGenerator<RehorEvent> {
    yield event({ runId: input.runId, attemptId: input.attemptId });
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("stream aborted"));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("stream aborted")), { once: true });
    });
  }
}

describe("coordinator execution", () => {
  it("starts, projects, and stops a successful runtime", async () => {
    const projection: CoordinatorProjection & { events: RehorEvent[]; terminals: RehorEvent[] } = {
      events: [],
      terminals: [],
      onEvent(current) {
        this.events.push(current);
      },
      onTerminal(current) {
        this.terminals.push(current);
      },
    };
    const runtime = new FakeAgentRuntime({ events: [event(), terminal()] });

    const result = await executeRun(runtime, run, { projection });

    expect(result.terminal.payload.state).toBe("completed");
    expect(result.events.map(({ eventId }) => eventId)).toEqual(["event-01", "terminal-01"]);
    expect(projection.events).toHaveLength(2);
    expect(projection.terminals).toHaveLength(1);
    expect(result.capabilities?.runtimeId).toBe("fake");
    expect(runtime.stopCalls).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it("completes normally when the runtime trails a usage event after the terminal", async () => {
    const projection: CoordinatorProjection & { events: RehorEvent[]; terminals: RehorEvent[] } = {
      events: [],
      terminals: [],
      onEvent(current) {
        this.events.push(current);
      },
      onTerminal(current) {
        this.terminals.push(current);
      },
    };
    const trailingUsage = event({
      eventId: "usage-late",
      sequence: 3,
      kind: "usage",
      payload: {
        requestedModel: run.provider.requestedModel,
        tokenCounts: { input: 5, output: 1 },
        partial: false,
        final: true,
        estimated: false,
        incomplete: false,
      },
    });
    const runtime = new FakeAgentRuntime({ events: [event(), terminal(), trailingUsage] });

    const result = await executeRun(runtime, run, { projection });

    // The trailing record is dropped, but the attempt it belongs to still succeeded.
    expect(result.terminal.payload.state).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(result.events.map(({ eventId }) => eventId)).toEqual(["event-01", "terminal-01"]);
    expect(projection.terminals).toHaveLength(1);
    expect(runtime.stopCalls).toBe(1);
  });

  it("preserves partial usage and returns a failed terminal after a stream error", async () => {
    const streamError = new Error("runtime stream failed");
    const usage = event({
      eventId: "usage-01",
      sequence: 2,
      kind: "usage",
      payload: {
        requestedModel: run.provider.requestedModel,
        tokenCounts: { input: 100, output: 20 },
        partial: true,
        final: false,
        estimated: false,
        incomplete: true,
      },
    });
    const runtime = new FakeAgentRuntime({ events: [event(), usage], error: streamError });

    const result = await executeRun(runtime, run);

    expect(result.terminal.payload.state).toBe("failed");
    expect(result.events.some(({ kind }) => kind === "usage")).toBe(true);
    expect(result.error).toBe(streamError);
    expect(runtime.stopCalls).toBe(1);
  });

  it("synthesizes a failed terminal when runtime ends without one", async () => {
    const runtime = new FakeAgentRuntime({ events: [event()] });

    const result = await executeRun(runtime, run);

    expect(result.terminal.payload.state).toBe("failed");
    expect(result.terminal.payload.reason).toBe("runtime ended without terminal event");
    expect(result.error).toBeInstanceOf(Error);
    expect(runtime.stopCalls).toBe(1);
  });

  it("turns timeout into an interrupted-safe terminal while retaining prior events", async () => {
    const runtime = new HangingRuntime();
    const result = await executeRun(runtime, { ...run, limits: { timeoutMs: 10, maxTurns: 20 } });

    expect(result.terminal.payload.state).toBe("timed_out");
    expect(result.events.map(({ kind }) => kind)).toEqual(["run", "terminal"]);
    expect(result.error).toBeUndefined();
    expect(runtime.startCalls).toBe(1);
    expect(runtime.runCalls).toBe(1);
    expect(runtime.stopCalls).toBe(1);
  });

  it("maps shutdown to interrupted and cancellation to cancelled", async () => {
    const shutdown = new AbortController();
    const shutdownRuntime = new HangingRuntime();
    const shutdownRun = executeRun(shutdownRuntime, run, { shutdownSignal: shutdown.signal });
    shutdown.abort("SIGTERM");
    const shutdownResult = await shutdownRun;

    const cancel = new AbortController();
    const cancelRuntime = new HangingRuntime();
    const cancelRun = executeRun(cancelRuntime, run, { signal: cancel.signal });
    cancel.abort("user cancelled");
    const cancelResult = await cancelRun;

    expect(shutdownResult.terminal.payload.state).toBe("interrupted");
    expect(cancelResult.terminal.payload.state).toBe("cancelled");
    expect(shutdownRuntime.stopCalls).toBe(1);
    expect(cancelRuntime.stopCalls).toBe(1);
  });

  it("does not start an already-cancelled runtime but still cleans it up", async () => {
    const controller = new AbortController();
    controller.abort("cancelled before start");
    const runtime = new HangingRuntime();

    const result = await executeRun(runtime, run, { signal: controller.signal });

    expect(result.terminal.payload.state).toBe("cancelled");
    expect(runtime.startCalls).toBe(0);
    expect(runtime.runCalls).toBe(0);
    expect(runtime.stopCalls).toBe(1);
  });

  it("returns startup failures as failed runs and always calls stop", async () => {
    const startupError = new Error("runtime unavailable");
    const runtime = new FakeAgentRuntime({ error: startupError });
    const originalStart = runtime.start.bind(runtime);
    runtime.start = async (signal) => {
      await originalStart(signal);
      throw startupError;
    };

    const result = await executeRun(runtime, run);

    expect(result.terminal.payload.state).toBe("failed");
    expect(result.terminal.payload.reason).toBe("runtime unavailable");
    expect(result.error).toBe(startupError);
    expect(runtime.stopCalls).toBe(1);
  });
});
