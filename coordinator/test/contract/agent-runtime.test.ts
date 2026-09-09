import { describe, expect, it } from "vitest";

import type { RehorEvent, RehorRun } from "../../src/domain";
import {
  createEventFactory,
  EventLedger,
  parseRehorEvent,
  parseRehorRun,
  RuntimeContractError,
} from "../../src/domain";
import { FakeAgentRuntime } from "../../src/testing/fake-agent-runtime";

const run: RehorRun = {
  schemaVersion: "1",
  runId: "run-01",
  attemptId: "attempt-01",
  instanceId: "instance-01",
  label: "hcc-ai-framework",
  workflowId: "jira-sprint",
  prompt: "Follow the instructions and handle the preflight data.",
  task: { id: "task-01", key: "REHOR-138" },
  worktree: {
    path: "/work/rehor",
    repository: "https://github.com/OpenShift-Fleet/rehor.git",
    snapshot: { ref: "refs/heads/rehor-138", commitSha: "abc123", dirty: false },
  },
  instructionHash: { algorithm: "sha256", value: "1".repeat(64) },
  configHash: { algorithm: "sha256", value: "2".repeat(64) },
  policyHash: { algorithm: "sha256", value: "3".repeat(64) },
  provider: { id: "vertex", requestedModel: "claude-opus-4-6" },
  limits: { timeoutMs: 60_000, maxTurns: 20 },
  preflightPayloadRef: "memory://preflight/run-01",
};

const event = (overrides: Partial<RehorEvent> = {}): RehorEvent => ({
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
});

async function collect(events: AsyncIterable<RehorEvent>): Promise<RehorEvent[]> {
  const collected: RehorEvent[] = [];
  for await (const current of events) collected.push(current);
  return collected;
}

const activeSignal = (): AbortSignal => new AbortController().signal;

describe("AgentRuntime contract", () => {
  it("starts and streams Rehor-owned events without SDK objects", async () => {
    const runtime = new FakeAgentRuntime({
      events: [event(), event({ eventId: "event-02", sequence: 2, kind: "model" })],
    });

    const capabilities = await runtime.start(activeSignal());
    const events = await collect(runtime.run(run, new AbortController().signal));

    expect(capabilities.runtimeId).toBe("fake");
    expect(capabilities.streaming).toBe(true);
    expect(events.map(({ eventId }) => eventId)).toEqual(["event-01", "event-02"]);
    expect(events[0]).not.toHaveProperty("sdk");
  });

  it("propagates runtime errors after preserving emitted events", async () => {
    const runtime = new FakeAgentRuntime({ events: [event()], error: new Error("runtime failed") });
    await runtime.start(activeSignal());
    const promise = collect(runtime.run(run, new AbortController().signal));

    await expect(promise).rejects.toThrow("runtime failed");
    expect(runtime.emittedEventCount).toBe(1);
  });

  it("honors timeout cancellation through AbortSignal", async () => {
    const runtime = new FakeAgentRuntime({ events: [event()], delayMs: 50 });
    await runtime.start(activeSignal());
    const controller = new AbortController();
    const promise = collect(runtime.run(run, controller.signal));

    setTimeout(() => controller.abort("timeout"), 5);

    await expect(promise).rejects.toThrow("aborted");
    expect(runtime.abortReason).toBe("timeout");
  });

  it("handles cancellation racing with stop", async () => {
    const runtime = new FakeAgentRuntime({ events: [event()], delayMs: 50 });
    await runtime.start(activeSignal());
    const controller = new AbortController();
    const promise = collect(runtime.run(run, controller.signal));

    controller.abort("shutdown");
    await runtime.stop();

    await expect(promise).rejects.toThrow("aborted");
    expect(runtime.stopCalls).toBe(1);
  });

  it("cancels runtime startup before resources are created", async () => {
    const runtime = new FakeAgentRuntime();
    const controller = new AbortController();
    controller.abort("timeout");

    await expect(runtime.start(controller.signal)).rejects.toThrow("runtime aborted");
    expect(runtime.abortReason).toBe("timeout");
  });

  it("ends an in-flight stream when the runtime is stopped", async () => {
    const runtime = new FakeAgentRuntime({
      events: [event(), event({ eventId: "event-02", sequence: 2 })],
      delayMs: 20,
    });
    await runtime.start(activeSignal());
    const promise = collect(runtime.run(run, activeSignal()));

    await runtime.stop();

    expect(await promise).toEqual([]);
    expect(runtime.emittedEventCount).toBe(0);
  });

  it("refuses to restart or stream after stop", async () => {
    const runtime = new FakeAgentRuntime({ events: [event()] });
    await runtime.start(activeSignal());
    await runtime.stop();

    await expect(runtime.start(activeSignal())).rejects.toThrow(
      "stopped runtime must not be restarted",
    );
    await expect(collect(runtime.run(run, activeSignal()))).rejects.toThrow(
      "stopped runtime must not stream events",
    );
  });

  it("makes stop idempotent", async () => {
    const runtime = new FakeAgentRuntime();

    await runtime.stop();
    await runtime.stop();

    expect(runtime.stopCalls).toBe(1);
  });
});

describe("RehorEvent contract", () => {
  it("stamps self-describing events while hiding envelope boilerplate from adapters", () => {
    const createEvent = createEventFactory(run, "policy-2");
    const modelEvent = createEvent(
      "model",
      { text: "hello" },
      { eventId: "event-01", occurredAt: "2026-09-07T12:00:00.000Z" },
    );
    const usageEvent = createEvent(
      "usage",
      {
        requestedModel: run.provider.requestedModel,
        tokenCounts: { input: 10, output: 2 },
        partial: true,
        final: false,
        estimated: true,
        incomplete: true,
      },
      { eventId: "event-02", model: "fallback-model", parentEventId: "event-01" },
    );

    expect(modelEvent).toMatchObject({
      runId: run.runId,
      attemptId: run.attemptId,
      sequence: 1,
      provider: run.provider.id,
      model: run.provider.requestedModel,
      policyVersion: "policy-2",
    });
    expect(usageEvent).toMatchObject({
      sequence: 2,
      model: "fallback-model",
      parentEventId: "event-01",
      workspace: {
        worktreePath: run.worktree.path,
        repository: run.worktree.repository,
        snapshot: run.worktree.snapshot.commitSha,
      },
    });
    expect(new EventLedger(run).ingest(usageEvent).accepted).toBe(true);
  });

  it("ignores duplicate event IDs while retaining one event", () => {
    const ledger = new EventLedger(run);
    const first = event();

    expect(ledger.ingest(first).duplicate).toBe(false);
    expect(ledger.ingest({ ...first }).duplicate).toBe(true);
    expect(ledger.events).toHaveLength(1);
  });

  it("rejects a conflicting duplicate event ID", () => {
    const ledger = new EventLedger(run);
    ledger.ingest(event());

    expect(() => ledger.ingest(event({ payload: { state: "changed" } }))).toThrow(
      RuntimeContractError,
    );
  });

  it("treats reordered JSON object keys as the same duplicate event", () => {
    const ledger = new EventLedger(run);
    ledger.ingest(event({ payload: { first: 1, second: 2 } }));

    expect(ledger.ingest(event({ payload: { second: 2, first: 1 } }))).toEqual({
      accepted: false,
      duplicate: true,
      outOfOrder: false,
    });
  });

  it("rejects two event IDs claiming the same sequence", () => {
    const ledger = new EventLedger(run);
    ledger.ingest(event());

    expect(() => ledger.ingest(event({ eventId: "event-02" }))).toThrow(
      "event sequence already accepted",
    );
  });

  it("detects missing and out-of-order sequence values", () => {
    const ledger = new EventLedger(run);

    ledger.ingest(event({ eventId: "event-01", sequence: 1 }));
    ledger.ingest(event({ eventId: "event-03", sequence: 3 }));
    const result = ledger.ingest(event({ eventId: "event-02", sequence: 2 }));

    expect(result.outOfOrder).toBe(true);
    expect(ledger.missingSequenceRanges).toEqual([]);

    ledger.ingest(event({ eventId: "event-05", sequence: 5 }));
    expect(ledger.missingSequenceRanges).toEqual([{ start: 4, end: 4 }]);
  });

  it("reports large sequence gaps without expanding every missing value", () => {
    const ledger = new EventLedger(run);
    ledger.ingest(event());
    ledger.ingest(event({ eventId: "event-last", sequence: Number.MAX_SAFE_INTEGER }));

    expect(ledger.missingSequenceRanges).toEqual([{ start: 2, end: Number.MAX_SAFE_INTEGER - 1 }]);
  });

  it("detects a missing terminal event", () => {
    const ledger = new EventLedger(run);
    ledger.ingest(event());

    expect(ledger.terminalEvent).toBeUndefined();
    expect(() => ledger.requireTerminal()).toThrow("terminal event missing");
  });

  it("accepts one terminal event and rejects every later event", () => {
    const ledger = new EventLedger(run);
    ledger.ingest(event());
    const terminal = event({
      eventId: "terminal-01",
      sequence: 2,
      kind: "terminal",
      payload: { state: "completed" },
    });
    ledger.ingest(terminal);

    expect(ledger.requireTerminal().eventId).toBe("terminal-01");
    expect(ledger.ingest({ ...terminal }).duplicate).toBe(true);
    expect(() => ledger.ingest(event({ eventId: "event-03", sequence: 3, kind: "model" }))).toThrow(
      "event received after terminal event",
    );
  });

  it("accepts in-flight events below the terminal sequence", () => {
    const ledger = new EventLedger(run);
    ledger.ingest(event());
    ledger.ingest(
      event({
        eventId: "terminal-01",
        sequence: 3,
        kind: "terminal",
        payload: { state: "completed" },
      }),
    );

    const late = ledger.ingest(
      event({
        eventId: "usage-01",
        sequence: 2,
        kind: "usage",
        payload: {
          requestedModel: run.provider.requestedModel,
          tokenCounts: { input: 10, output: 2 },
          partial: true,
          final: false,
          estimated: false,
          incomplete: true,
        },
      }),
    );

    expect(late).toEqual({ accepted: true, duplicate: false, outOfOrder: true });
    expect(ledger.missingSequenceRanges).toEqual([]);
    expect(() => ledger.ingest(event({ eventId: "event-04", sequence: 4, kind: "model" }))).toThrow(
      "event received after terminal event",
    );
  });

  it("detaches ingested payloads from adapter-owned buffers", () => {
    const ledger = new EventLedger(run);
    const buffer: Record<string, unknown> = { state: "started", nested: { turn: 1 } };
    const first = event({ payload: buffer });
    ledger.ingest(first);

    buffer.state = "reused";
    (buffer.nested as Record<string, unknown>).turn = 2;

    expect(ledger.events[0]?.payload).toEqual({ state: "started", nested: { turn: 1 } });
    expect(
      ledger.ingest(event({ payload: { state: "started", nested: { turn: 1 } } })).duplicate,
    ).toBe(true);
  });

  it("resumes event sequences from a prior attempt segment", () => {
    const createEvent = createEventFactory(run, "policy-2", { startSequence: 7 });

    expect(createEvent("model", { text: "hello" }).sequence).toBe(8);
    expect(createEvent("model", { text: "world" }).sequence).toBe(9);
    expect(() => createEventFactory(run, "policy-2", { startSequence: -1 })).toThrow(
      RuntimeContractError,
    );
  });

  it("normalizes content hash case so equal hashes compare equal", () => {
    const parsed = parseRehorRun({
      ...run,
      instructionHash: { algorithm: "sha256", value: "A".repeat(64) },
    });

    expect(parsed.instructionHash.value).toBe("a".repeat(64));
  });

  it("rejects malformed terminal payloads", () => {
    expect(() => parseRehorEvent(event({ kind: "terminal", payload: {} }))).toThrow(
      "event.payload.state must be a terminal state",
    );
    expect(() =>
      parseRehorEvent(event({ kind: "terminal", payload: { state: "unknown" } })),
    ).toThrow("event.payload.state must be a terminal state");

    const ledger = new EventLedger(run);
    expect(() => ledger.ingest(event({ kind: "terminal", payload: {} }))).toThrow(
      "event.payload.state must be a terminal state",
    );
  });

  it("preserves result and CycleContext data in terminal events", () => {
    const terminal = parseRehorEvent(
      event({
        kind: "terminal",
        payload: {
          state: "completed",
          resultText: "Work finished",
          noWork: false,
          turns: 7,
          durationMs: 12_000,
          context: {
            taskId: 42,
            externalKey: "ticket-42",
            repository: "rehor",
            workType: "new_ticket",
            summary: "Opened pull request",
          },
        },
      }),
    );

    expect(terminal.payload).toEqual({
      state: "completed",
      resultText: "Work finished",
      noWork: false,
      turns: 7,
      durationMs: 12_000,
      context: {
        taskId: 42,
        externalKey: "ticket-42",
        repository: "rehor",
        workType: "new_ticket",
        summary: "Opened pull request",
      },
    });
  });

  it("rejects events attributed to another workspace", () => {
    const ledger = new EventLedger(run);

    expect(() =>
      ledger.ingest(
        event({
          workspace: { ...event().workspace, snapshot: "different-commit" },
        }),
      ),
    ).toThrow("event workspace does not match run workspace");
  });

  it("enforces the wire schema at ledger ingestion", () => {
    const ledger = new EventLedger(run);

    expect(() => ledger.ingest({ ...event(), sdk: { leaked: true } })).toThrow(
      "event does not match schema",
    );
  });

  it("validates usage needed by existing cost projections", () => {
    const usage = event({
      kind: "usage",
      payload: {
        requestedModel: run.provider.requestedModel,
        returnedModel: "claude-opus-4-6-20260901",
        tokenCounts: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10 },
        partial: false,
        final: true,
        estimated: false,
        incomplete: false,
        cost: { amount: 0.42, currency: "USD", source: "provider" },
      },
    });

    expect(parseRehorEvent(usage).payload).toEqual(usage.payload);
    expect(new EventLedger(run).ingest(usage).accepted).toBe(true);
    expect(
      new EventLedger(run).ingest({
        ...usage,
        model: "child-model",
        payload: { ...usage.payload, requestedModel: "child-model" },
      }).accepted,
    ).toBe(true);
    expect(() =>
      parseRehorEvent({
        ...usage,
        payload: { ...usage.payload, tokenCounts: { input: -1 } },
      }),
    ).toThrow("event.payload.tokenCounts.input must be a non-negative safe integer");
    expect(() =>
      parseRehorEvent({
        ...usage,
        payload: { ...usage.payload, attemptId: run.attemptId, provider: run.provider.id },
      }),
    ).toThrow("event does not match schema");
  });

  it("preserves unknown event kinds and redacted references", () => {
    const unknown = parseRehorEvent(
      event({
        eventId: "future-01",
        kind: "runtime.future.v2",
        rawEventRef: { reference: "sha256:deadbeef", redacted: true },
        payload: { opaque: { value: 1 } },
      }),
    );

    expect(unknown.kind).toBe("runtime.future.v2");
    expect(unknown.rawEventRef).toEqual({ reference: "sha256:deadbeef", redacted: true });
    expect(unknown.payload).toEqual({ opaque: { value: 1 } });
  });
});
