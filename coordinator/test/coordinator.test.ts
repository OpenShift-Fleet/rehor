import { describe, expect, it } from "vitest";

import {
  type AgentRuntime,
  type CoordinatorProjection,
  createLoopSignals,
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
  enforcesTurnLimit: false,
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

function tool(
  sequence: number,
  state: "started" | "completed",
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
): RehorEvent {
  return event({
    eventId: `${id}-${state}`,
    sequence,
    kind: "tool",
    payload: { state, toolUseId: id, name, ...extra } as RehorEvent["payload"],
  });
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

  it("does not relabel a completed runtime terminal when abort races ingestion", async () => {
    const cancel = new AbortController();
    const runtime = new FakeAgentRuntime();
    runtime.run = (input) =>
      (async function* (): AsyncGenerator<RehorEvent> {
        yield event({ runId: input.runId, attemptId: input.attemptId });
        cancel.abort({ kind: "cancelled", reason: "late cancellation" });
        yield terminal();
      })();

    const result = await executeRun(runtime, run, { signal: cancel.signal });

    expect(result.terminal.payload.state).toBe("completed");
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

  it.each([
    [new DOMException("x", "TimeoutError"), "timed_out"],
    [Object.assign(new Error("x"), { name: "TimeoutError" }), "cancelled"],
  ])("classifies %s as %s", async (reason, state) => {
    const cancel = new AbortController();
    const runtime = new HangingRuntime();
    const pending = executeRun(runtime, run, { signal: cancel.signal });
    cancel.abort(reason);
    const result = await pending;

    expect(result.terminal.payload.state).toBe(state);
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

  it("keeps a loop shutdown recognisable as interrupted through the combined loop signal", async () => {
    // The production loop hands runtimes one combined signal. A SIGTERM with a
    // free-text reason must still classify as a shutdown, not a cancellation.
    const processShutdown = new AbortController();
    const loopSignals = createLoopSignals({ shutdownSignal: processShutdown.signal });
    const runtime = new HangingRuntime();
    const pending = executeRun(runtime, run, { signal: loopSignals.signal });
    processShutdown.abort("process signal");
    const result = await pending;
    loopSignals.dispose();

    expect(loopSignals.stopReason).toBe("shutdown");
    expect(result.terminal.payload).toMatchObject({
      state: "interrupted",
      reason: "process signal",
    });
    expect(result.error).toBeUndefined();
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

  it("sequences coordinator policy events without colliding with out-of-order runtime events", async () => {
    const toolEvents = ["one", "two", "three"].flatMap((id, index) => {
      const startedSequence = 2 + index * 2;
      return [
        event({
          eventId: `tool-${id}-started`,
          sequence: startedSequence,
          kind: "tool",
          payload: { state: "started", toolUseId: id, name: "read" },
        }),
        event({
          eventId: `tool-${id}-completed`,
          sequence: startedSequence + 1,
          kind: "tool",
          payload: { state: "completed", toolUseId: id, name: "read" },
        }),
      ];
    });
    const outOfOrder = event({
      eventId: "late-turn-marker",
      sequence: 6,
      kind: "run",
      payload: { state: "turn_started" },
    });
    const runtime = new FakeAgentRuntime({
      events: [event(), ...toolEvents, outOfOrder, terminal(9)],
    });

    const result = await executeRun(runtime, {
      ...run,
      limits: { ...run.limits, maxTurns: 4 },
    });

    const sequences = result.events.map((current) => current.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(result.events.filter((current) => current.kind === "policy")).toHaveLength(1);
    expect(result.events.some((current) => current.eventId === "late-turn-marker")).toBe(true);
    expect(result.terminal.payload.state).toBe("completed");
  });

  it("keeps tool context from tool-start order when completion events arrive later", async () => {
    const started = tool(2, "started", "task-update-1", "mcp__bot-memory__task_update", {
      input: { jira_key: "REHOR-1", repo: "start-repo", status: "pr_changes", summary: "start" },
    });
    const completed = tool(3, "completed", "task-update-1", "mcp__bot-memory__task_update", {
      input: {
        jira_key: "REHOR-2",
        repo: "completion-repo",
        status: "pr_open",
        summary: "finish",
      },
      content: JSON.stringify({ id: 42, external_key: "REHOR-1" }),
    });
    const runtime = new FakeAgentRuntime({ events: [event(), started, completed, terminal(4)] });

    const result = await executeRun(runtime, run);

    expect(result.terminal.payload).toMatchObject({
      context: {
        taskId: 42,
        externalKey: "REHOR-1",
        repository: "start-repo",
        workType: "pr_review",
        summary: "start",
      },
    });
  });

  it("captures completion input when no tool-start event was observed", async () => {
    const completed = tool(2, "completed", "orphan-tool", "mcp__bot-memory__task_update", {
      input: { jira_key: "REHOR-3", status: "pr_changes", summary: "completion only" },
    });
    const runtime = new FakeAgentRuntime({ events: [event(), completed, terminal(3)] });

    const result = await executeRun(runtime, run);

    expect(result.terminal.payload).toMatchObject({
      context: { externalKey: "REHOR-3", workType: "pr_review", summary: "completion only" },
    });
  });

  it("extracts task IDs from errored tool results", async () => {
    const completed = tool(2, "completed", "task-result-error", "mcp__bot-memory__task_get", {
      isError: true,
      content: JSON.stringify({ id: 43, external_key: "REHOR-43" }),
    });
    const runtime = new FakeAgentRuntime({ events: [event(), completed, terminal(3)] });

    const result = await executeRun(runtime, run);

    expect(result.terminal.payload).toMatchObject({ context: { taskId: 43 } });
  });

  it("preserves Python task_update ordering when parallel completions arrive in reverse", async () => {
    const firstStart = tool(2, "started", "parallel-1", "mcp__bot-memory__task_update", {
      input: { status: "pr_open", summary: "first start" },
    });
    const secondStart = tool(3, "started", "parallel-2", "mcp__bot-memory__task_update", {
      input: { status: "pr_changes", summary: "second start" },
    });
    const secondComplete = tool(4, "completed", "parallel-2", "mcp__bot-memory__task_update", {
      input: { status: "pr_changes", summary: "second complete" },
    });
    const firstComplete = tool(5, "completed", "parallel-1", "mcp__bot-memory__task_update", {
      input: { status: "pr_open", summary: "first complete" },
    });
    const runtime = new FakeAgentRuntime({
      events: [event(), firstStart, secondStart, secondComplete, firstComplete, terminal(6)],
    });

    const result = await executeRun(runtime, run);

    expect(result.terminal.payload).toMatchObject({
      context: { workType: "pr_review", summary: "second start" },
    });
  });

  it("seeds run.task only for OpenCode and includes tracked context on coordinator terminals", async () => {
    const taskRun = {
      ...run,
      task: { id: "44", key: "REHOR-44" },
      runtimeId: "claude",
    };
    const claudeResult = await executeRun(
      new FakeAgentRuntime({ events: [event(), terminal()] }),
      taskRun,
    );
    const openCodeResult = await executeRun(
      new FakeAgentRuntime({ events: [event(), terminal()] }),
      { ...taskRun, runtimeId: "opencode-v1" },
    );

    expect(claudeResult.terminal.payload.context).not.toHaveProperty("taskId");
    expect(claudeResult.terminal.payload.context).not.toHaveProperty("externalKey");
    expect(openCodeResult.terminal.payload).toMatchObject({
      context: { taskId: 44, externalKey: "REHOR-44" },
    });

    const cancel = new AbortController();
    const toolStarted = tool(2, "started", "tracked-tool", "mcp__bot-memory__task_add", {
      input: { jira_key: "REHOR-45", summary: "tracked before abort" },
    });
    const toolCompleted = tool(3, "completed", "tracked-tool", "mcp__bot-memory__task_add", {
      content: JSON.stringify({ id: 45, external_key: "REHOR-45" }),
    });
    const runtime = new FakeAgentRuntime({ events: [event(), toolStarted, toolCompleted] });
    const result = await executeRun(runtime, run, {
      signal: cancel.signal,
      projection: {
        onEvent(current) {
          if (current.eventId === toolCompleted.eventId) {
            cancel.abort({ kind: "cancelled", reason: "after tool completion" });
          }
        },
      },
    });

    expect(result.terminal.payload).toMatchObject({
      state: "cancelled",
      context: {
        taskId: 45,
        externalKey: "REHOR-45",
        workType: "new_ticket",
        summary: "tracked before abort",
      },
    });
  });
});
