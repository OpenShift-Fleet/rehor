import { describe, expect, it } from "vitest";

import { executeRun } from "../../src/coordinator";
import type { RehorEvent } from "../../src/domain";
import { createLoopSignals } from "../../src/loop";
import type { AgentRuntime } from "../../src/ports/agent-runtime";
import { claudeHarness, openCodeHarness, type RuntimeContractHarness } from "./runtime-harnesses";

/**
 * The AgentRuntime contract, run against the production adapters with their
 * SDK or server boundary scripted. `agent-runtime.test.ts` pins the fake
 * runtime's semantics; these cases pin what the coordinator relies on from
 * every real adapter.
 */
const harnesses: RuntimeContractHarness[] = [claudeHarness(), openCodeHarness()];

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
  it("streams a started event, then exactly one completed terminal and no error", async () => {
    const result = await executeRun(harness.completed(), harness.run);

    expectLifecycle(result.events);
    expect(result.terminal.payload.state).toBe("completed");
    expect(kinds(result.events)).not.toContain("error");
    expect(result.error).toBeUndefined();
  });

  it("emits a started event even when setup fails before a session exists", async () => {
    const result = await executeRun(harness.failsBeforeSession(), harness.run);

    expectLifecycle(result.events);
    expect(result.terminal.payload.state).toBe("failed");
    // The adapter reports its own failure; the coordinator must not synthesize it.
    expect(result.terminal.eventId).not.toMatch(/^coordinator-terminal-/);
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

  it("records the run timeout as timed_out", async () => {
    const { runtime } = harness.blocksUntilAborted();
    const result = await executeRun(runtime, {
      ...harness.run,
      limits: { ...harness.run.limits, timeoutMs: 30 },
    });

    expectLifecycle(result.events);
    expect(result.terminal.payload.state).toBe("timed_out");
  });

  it("ends an in-flight run with an interrupted terminal when the runtime is stopped", async () => {
    const { runtime, waiting } = harness.blocksUntilAborted();
    await runtime.start(new AbortController().signal);
    const pending = collect(runtime.run(harness.run, new AbortController().signal));
    await waiting;
    await runtime.stop();
    const events = await pending;

    expectLifecycle(events);
    expect(events.at(-1)?.payload).toMatchObject({ state: "interrupted" });
  });

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
