import { describe, expect, it } from "vitest";

import { executeRun } from "../../src/coordinator";
import type { RehorEvent } from "../../src/domain";
import { createLoopSignals } from "../../src/loop";
import type { AgentRuntime } from "../../src/ports/agent-runtime";
import {
  claudeHarness,
  fakeHarness,
  metricsProjection,
  openCodeHarness,
  type RuntimeContractHarness,
} from "./runtime-harnesses";

/**
 * The AgentRuntime contract, run against the production adapters with their
 * SDK or server boundary scripted. `agent-runtime.test.ts` pins the fake
 * runtime's semantics; these cases pin what the coordinator relies on from
 * every real adapter.
 */
const harnesses: RuntimeContractHarness[] = [fakeHarness(), claudeHarness(), openCodeHarness()];

function kinds(events: readonly RehorEvent[]): string[] {
  return events.map(({ kind }) => kind);
}

function expectLifecycle(events: readonly RehorEvent[]): void {
  expect(events[0]).toMatchObject({ kind: "run", payload: { state: "started" } });
  expect(events.filter(({ kind }) => kind === "terminal")).toHaveLength(1);
  expect(events.at(-1)?.kind).toBe("terminal");
}

async function collect(events: AsyncIterable<RehorEvent>): Promise<RehorEvent[]> {
  const collected: RehorEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe.each(harnesses)("AgentRuntime contract: $name adapter", (harness) => {
  const abortAfterStart = async (reason: unknown): Promise<RehorEvent[]> => {
    const { runtime, waiting } = harness.blocksUntilAborted();
    const cancel = new AbortController();
    await runtime.start(new AbortController().signal);
    const pending = collect(runtime.run(harness.run, cancel.signal));
    await waiting;
    cancel.abort(reason);
    return pending;
  };

  it("streams a started event, then exactly one completed terminal and no error", async () => {
    const result = await executeRun(harness.completed(), harness.run);

    expectLifecycle(result.events);
    expect(result.terminal.payload.state).toBe("completed");
    expect(kinds(result.events)).not.toContain("error");
    expect(result.error).toBeUndefined();
  });

  it("reports an aborted provider run as failed; coordinator owns abort states", async () => {
    const events = await abortAfterStart({ kind: "timed_out", reason: "contract timeout" });

    expectLifecycle(events);
    expect(events.at(-1)?.payload).toMatchObject({ state: "failed" });
  });

  it("emits a started event even when setup fails before a session exists", async () => {
    const result = await executeRun(harness.failsBeforeSession(), harness.run);

    expectLifecycle(result.events);
    expect(result.terminal.payload.state).toBe("failed");
  });

  it("records a process shutdown as interrupted", async () => {
    const { runtime, waiting } = harness.blocksUntilAborted();
    const shutdown = new AbortController();
    const pending = executeRun(runtime, harness.run, { shutdownSignal: shutdown.signal });
    await waiting;
    shutdown.abort("SIGTERM");
    const result = await pending;

    expectLifecycle(result.events);
    expect(result.terminal.payload.state).toBe("interrupted");
    expect(result.error).toBeUndefined();
  });

  it("records a shutdown delivered through the coordinator loop signal as interrupted", async () => {
    const { runtime, waiting } = harness.blocksUntilAborted();
    const processShutdown = new AbortController();
    const loopSignals = createLoopSignals({ shutdownSignal: processShutdown.signal });
    const pending = executeRun(runtime, harness.run, { signal: loopSignals.signal });
    await waiting;
    processShutdown.abort("process signal");
    const result = await pending;
    loopSignals.dispose();

    expectLifecycle(result.events);
    expect(result.terminal.payload.state).toBe("interrupted");
  });

  it("records a caller cancellation as cancelled", async () => {
    const { runtime, waiting } = harness.blocksUntilAborted();
    const cancel = new AbortController();
    const pending = executeRun(runtime, harness.run, { signal: cancel.signal });
    await waiting;
    cancel.abort("user cancelled");
    const result = await pending;

    expectLifecycle(result.events);
    expect(result.terminal.payload.state).toBe("cancelled");
  });

  it("classifies aborts from typed causes, not reason text", async () => {
    const { runtime: textRuntime, waiting: textWaiting } = harness.blocksUntilAborted();
    const textCancel = new AbortController();
    const textPending = executeRun(textRuntime, harness.run, { signal: textCancel.signal });
    await textWaiting;
    textCancel.abort("timeout");
    const textResult = await textPending;

    const { runtime: typedRuntime, waiting: typedWaiting } = harness.blocksUntilAborted();
    const typedCancel = new AbortController();
    const typedPending = executeRun(typedRuntime, harness.run, { signal: typedCancel.signal });
    await typedWaiting;
    typedCancel.abort({ kind: "timed_out", reason: "ordinary prose" });
    const typedResult = await typedPending;

    expect(textResult.terminal.payload.state).toBe("cancelled");
    expect(typedResult.terminal.payload).toMatchObject({
      state: "timed_out",
      reason: "ordinary prose",
    });
  });

  it("enforces max turns from successful normalized tool events", async () => {
    const maxTurns = 8;
    const metrics: Array<Record<string, unknown>> = [];
    const projection = metricsProjection(metrics);
    const result = await executeRun(
      harness.toolCalls(maxTurns),
      { ...harness.run, limits: { ...harness.run.limits, maxTurns } },
      { projection },
    );
    const policies = result.events.filter(({ kind }) => kind === "policy");

    expect(policies.map(({ payload }) => payload.state)).toEqual(["warning", "critical"]);
    expect(policies.map(({ payload }) => payload.usedTurns)).toEqual([6, 7]);
    expect(result.terminal.payload).toMatchObject({
      state: "failed",
      reason: harness.enforcesTurnLimit ? "error_max_turns" : "max_turns",
    });
    expect(result.error).toBeUndefined();
    const sequences = result.events.map(({ sequence }) => sequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(new Set(sequences).size).toBe(sequences.length);
    for (const level of ["warning", "critical"] as const) {
      expect(metrics).toContainEqual({
        type: "counter",
        name: "devbot_turn_budget_event_total",
        value: 1,
        labels: { label: harness.run.label, level },
      });
    }
  });

  it("tracks task context from normalized tool events", async () => {
    const result = await executeRun(harness.toolCalls(1), harness.run);

    expect(result.terminal.payload).toMatchObject({
      state: "completed",
      context: {
        taskId: 42,
        externalKey: "REHOR-146",
        repository: "rehor",
        workType: "new_ticket",
        summary: "Follow-up A",
      },
    });
  });

  it("marks no-work from normalized terminal text", async () => {
    const result = await executeRun(harness.noWork(), harness.run);

    expect(result.terminal.payload).toMatchObject({ state: "completed", noWork: true });
  });

  it("records the run timeout as timed_out", async () => {
    const { runtime } = harness.blocksUntilAborted();
    const result = await executeRun(runtime, {
      ...harness.run,
      limits: { ...harness.run.limits, timeoutMs: 30 },
    });

    expectLifecycle(result.events);
    expect(result.terminal.payload.state).toBe("timed_out");
  });

  it.each(["cancel", "stop"] as const)(
    "reports an in-flight run as failed when the runtime is %s",
    async (trigger) => {
      if (trigger === "stop" && harness.name === "fake") return;
      const { runtime, waiting } = harness.blocksUntilAborted();
      const cancel = new AbortController();
      await runtime.start(new AbortController().signal);
      const pending = collect(runtime.run(harness.run, cancel.signal));
      await waiting;
      if (trigger === "cancel") cancel.abort("cancelled");
      else await runtime.stop();
      const events = await pending;

      expectLifecycle(events);
      expect(events.at(-1)?.eventId).not.toMatch(/^coordinator-terminal-/);
      expect(events.at(-1)?.payload).toMatchObject({ state: "failed" });
    },
  );

  it("rejects startup on an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort("timeout");

    await expect(harness.completed().start(controller.signal)).rejects.toThrow();
  });

  it("makes stop idempotent and refuses restart or streaming after stop", async () => {
    const runtime: AgentRuntime = harness.completed();
    await runtime.start(new AbortController().signal);
    await runtime.stop();
    await runtime.stop();

    await expect(runtime.start(new AbortController().signal)).rejects.toThrow(
      "stopped runtime must not be restarted",
    );
    await expect(collect(runtime.run(harness.run, new AbortController().signal))).rejects.toThrow(
      "stopped runtime must not stream events",
    );
  });

  it.runIf(harness.completedWithCleanupFailure !== undefined)(
    "never pairs a completed terminal with an error event when cleanup fails",
    async () => {
      const runtime = harness.completedWithCleanupFailure?.();
      if (!runtime) throw new Error("harness has no cleanup-failure script");
      const result = await executeRun(runtime, harness.run);

      expectLifecycle(result.events);
      expect(result.terminal.payload.state).toBe("completed");
      expect(kinds(result.events)).not.toContain("error");
      expect(kinds(result.events)).toContain("cleanup");
    },
  );
});
