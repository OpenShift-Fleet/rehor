import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CycleScheduler,
  consumeSleepSignal,
  type IdleCycleState,
  PreflightAction,
  type PreflightResult,
  parseSleepSignal,
  recordActiveCycle,
  recordIdleCycle,
  recordReminderSent,
  sleep,
} from "../src";

function preflight(action: PreflightResult["action"]): PreflightResult {
  return { action, prompt: "", transcript: "", scripts: [] };
}

describe("cycle scheduler", () => {
  it("backs off preflight errors exponentially and caps the delay", () => {
    const scheduler = new CycleScheduler({
      intervalMs: 1_000,
      idleIntervalMs: 700,
      maxPreflightBackoffMs: 5_000,
    });

    expect(scheduler.planForPreflight(preflight(PreflightAction.Error))).toEqual({
      decision: "error",
      sleep: { delayMs: 2_000, reason: "preflight_error" },
      consecutivePreflightErrors: 1,
    });
    expect(scheduler.planForPreflight(preflight(PreflightAction.Error)).sleep?.delayMs).toBe(4_000);
    expect(scheduler.planForPreflight(preflight(PreflightAction.Error)).sleep?.delayMs).toBe(5_000);
    expect(scheduler.consecutivePreflightErrors).toBe(3);

    expect(scheduler.planForPreflight(preflight(PreflightAction.Skip))).toEqual({
      decision: "idle",
      sleep: { delayMs: 700, reason: "preflight_skip" },
      consecutivePreflightErrors: 0,
    });
    expect(scheduler.planForPreflight(preflight(PreflightAction.Error)).sleep?.delayMs).toBe(2_000);
  });

  it("runs when preflight is absent or starts", () => {
    const scheduler = new CycleScheduler({ intervalMs: 1_000, idleIntervalMs: 2_000 });

    expect(scheduler.planForPreflight(null)).toEqual({
      decision: "run",
      sleep: null,
      consecutivePreflightErrors: 0,
    });
    expect(scheduler.planForPreflight(preflight(PreflightAction.Start)).decision).toBe("run");
  });

  it("uses valid skill sleep signals and falls back to the normal interval", () => {
    const scheduler = new CycleScheduler({ intervalMs: 10_000, idleIntervalMs: 2_000 });

    expect(scheduler.planAfterRun()).toEqual({ delayMs: 10_000, reason: "cycle_complete" });
    expect(scheduler.planAfterRun({ recommendedSleepSeconds: 2.5, reason: "rate_limit" })).toEqual({
      delayMs: 2_500,
      reason: "rate_limit",
    });
    expect(parseSleepSignal({ recommended_sleep: 0, reason: "immediate" })).toEqual({
      recommendedSleepSeconds: 0,
      reason: "immediate",
    });
    expect(parseSleepSignal({ recommended_sleep: -1 })).toBeNull();
  });

  it("consumes and removes a Python-compatible sleep signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehor-sleep-"));
    const path = join(root, "cycle-sleep.json");
    await writeFile(path, '{"recommended_sleep": 42, "reason": "preflight_skip"}');

    await expect(consumeSleepSignal(path)).resolves.toEqual({
      recommendedSleepSeconds: 42,
      reason: "preflight_skip",
    });
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns null and removes malformed sleep signals", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehor-sleep-"));
    const path = join(root, "cycle-sleep.json");
    await writeFile(path, "not-json");

    await expect(consumeSleepSignal(path)).resolves.toBeNull();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("interrupts sleep when its signal aborts", async () => {
    const controller = new AbortController();
    const pending = sleep(100, controller.signal);
    controller.abort("shutdown");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("idle cycle tracking", () => {
  it("reminds at the threshold and respects cooldown", () => {
    let state: IdleCycleState = { consecutiveCycles: 9, lastReminderAtMs: null };
    const policy = { limit: 10, cooldownMs: 1_000 };

    let decision = recordIdleCycle(state, policy, 10_000);
    expect(decision.shouldSendReminder).toBe(true);
    state = recordReminderSent(decision.state, 10_000);

    decision = recordIdleCycle(state, policy, 10_999);
    expect(decision.shouldSendReminder).toBe(false);
    decision = recordIdleCycle(state, policy, 11_000);
    expect(decision.shouldSendReminder).toBe(true);
  });

  it("disables reminders for non-positive limits and resets on active work", () => {
    const decision = recordIdleCycle(
      { consecutiveCycles: 99, lastReminderAtMs: null },
      { limit: 0, cooldownMs: 0 },
      0,
    );
    expect(decision.shouldSendReminder).toBe(false);
    expect(recordActiveCycle()).toEqual({ consecutiveCycles: 0, lastReminderAtMs: null });
  });
});
