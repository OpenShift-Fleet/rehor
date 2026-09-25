import { describe, expect, it } from "vitest";
import { PreflightAction } from "../src/ports/python-bridge";
import { CycleDecision, CycleScheduler } from "../src/scheduler";

describe("CycleScheduler.updateIntervals", () => {
  it("uses config supplied by the prepared cycle", () => {
    const scheduler = new CycleScheduler({ intervalMs: 10, idleIntervalMs: 20 });

    scheduler.updateIntervals({ intervalMs: 300, idleIntervalMs: 500 });

    expect(scheduler.planForPreflight(null)).toEqual({
      decision: CycleDecision.Run,
      sleep: null,
      consecutivePreflightErrors: 0,
    });
    expect(scheduler.planAfterRun()).toEqual({ delayMs: 300, reason: "cycle_complete" });
    expect(
      scheduler.planForPreflight({
        action: PreflightAction.Skip,
        prompt: "",
        transcript: "",
        scripts: [],
      }),
    ).toEqual({
      decision: CycleDecision.Idle,
      sleep: { delayMs: 500, reason: "preflight_skip" },
      consecutivePreflightErrors: 0,
    });
  });
});
