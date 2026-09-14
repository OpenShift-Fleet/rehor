import { describe, expect, it } from "vitest";

import {
  type CycleAdmission,
  createLoopSignals,
  InstructionStrategy,
  installProcessSignalHandlers,
  PreflightAction,
  type PreparedCycleInput,
  runCoordinatorLoop,
} from "../src";
import { CycleScheduler } from "../src/scheduler";

function prepared(action: PreflightAction): PreparedCycleInput {
  return {
    config: {
      model: "test-model",
      maxTurns: 10,
      intervalSeconds: 1,
      idleIntervalSeconds: 2,
      cycleTimeoutSeconds: 30,
      idleReminderCooldownSeconds: 60,
      workflow: "test-workflow",
      source: "test",
      envs: null,
      activeEnvs: [],
      claudeMdStrategy: InstructionStrategy.Ignore,
      idleCycleLimit: 0,
      remoteAgentDir: null,
      sharedAgentDir: null,
      claudeMdPath: "/tmp/CLAUDE.md",
    },
    instructions: {
      content: "instructions",
      hash: { algorithm: "sha256", value: "1".repeat(64) },
      layers: [],
    },
    preflight:
      action === PreflightAction.Error
        ? { action, prompt: "", transcript: "error", scripts: [] }
        : action === PreflightAction.Skip
          ? { action, prompt: "", transcript: "idle", scripts: [] }
          : { action, prompt: "work", transcript: "", scripts: [] },
    ...(action === PreflightAction.Start ? { prompt: "run" } : {}),
    instructionHash: { algorithm: "sha256", value: "1".repeat(64) },
    configHash: { algorithm: "sha256", value: "2".repeat(64) },
    preflightPayloadRef: action === PreflightAction.Start ? "preflight://sha256/test" : null,
  };
}

function admission(released: { value: number }): CycleAdmission {
  return {
    async acquire() {
      return {
        release() {
          released.value += 1;
        },
      };
    },
  };
}

describe("coordinator loop", () => {
  it("never invokes runtime for preflight skip/error and releases admission", async () => {
    const released = { value: 0 };
    const decisions: string[] = [];
    const sleeps: number[] = [];
    const preparedInputs = [prepared(PreflightAction.Skip), prepared(PreflightAction.Error)];
    let prepareCalls = 0;
    let runCalls = 0;

    const result = await runCoordinatorLoop({
      admission: admission(released),
      scheduler: new CycleScheduler({
        intervalMs: 10,
        idleIntervalMs: 20,
        maxPreflightBackoffMs: 100,
      }),
      prepare: async () => {
        const input = preparedInputs[prepareCalls++];
        if (!input) throw new Error("test input exhausted");
        return input;
      },
      run: async () => {
        runCalls += 1;
        return "unexpected";
      },
      maxCycles: 2,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
      onDecision: (plan) => {
        decisions.push(plan.decision);
      },
    });

    expect(result.stopReason).toBe("max_cycles");
    expect(result.cycles).toBe(2);
    expect(decisions).toEqual(["idle", "error"]);
    expect(sleeps).toEqual([20, 20]);
    expect(runCalls).toBe(0);
    expect(released.value).toBe(1);
  });

  it("runs only actionable cycles and applies normal post-run delay", async () => {
    const sleeps: number[] = [];
    let runCalls = 0;
    const result = await runCoordinatorLoop({
      admission: admission({ value: 0 }),
      scheduler: new CycleScheduler({ intervalMs: 10, idleIntervalMs: 20 }),
      prepare: async () => prepared(PreflightAction.Start),
      run: async () => {
        runCalls += 1;
        return "completed";
      },
      maxCycles: 1,
      sleepSignal: async () => ({ recommendedSleepSeconds: 0.003, reason: "test" }),
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });

    expect(result.stopReason).toBe("max_cycles");
    expect(result.results).toEqual(["completed"]);
    expect(runCalls).toBe(1);
    expect(sleeps).toEqual([3]);
  });

  it("denies admission without preparing a cycle", async () => {
    let prepareCalls = 0;
    const result = await runCoordinatorLoop({
      admission: { acquire: async () => null },
      scheduler: new CycleScheduler({ intervalMs: 10, idleIntervalMs: 20 }),
      prepare: async () => {
        prepareCalls += 1;
        return prepared(PreflightAction.Start);
      },
      run: async () => "unexpected",
    });

    expect(result.stopReason).toBe("admission_denied");
    expect(prepareCalls).toBe(0);
  });
});

describe("loop signals", () => {
  it("maps cancellation and shutdown to distinct abort reasons", () => {
    const cancel = new AbortController();
    const signals = createLoopSignals({ signal: cancel.signal });
    cancel.abort("cancel");
    expect(signals.signal.aborted).toBe(true);
    expect(signals.stopReason).toBe("cancelled");
    signals.dispose();

    const shutdown = new AbortController();
    const shutdownSignals = createLoopSignals({ shutdownSignal: shutdown.signal });
    shutdown.abort("SIGTERM");
    expect(shutdownSignals.stopReason).toBe("shutdown");
    shutdownSignals.dispose();
  });

  it("installs and removes SIGINT/SIGTERM handlers", () => {
    const handlers = new Map<string, () => void>();
    const removed: string[] = [];
    const source = {
      on(event: "SIGINT" | "SIGTERM", listener: () => void) {
        handlers.set(event, listener);
      },
      off(event: "SIGINT" | "SIGTERM") {
        removed.push(event);
      },
    };
    const signals = createLoopSignals();
    const cleanup = installProcessSignalHandlers(signals, source);
    handlers.get("SIGTERM")?.();

    expect(signals.stopReason).toBe("shutdown");
    cleanup();
    expect(removed).toEqual(["SIGINT", "SIGTERM"]);
    signals.dispose();
  });
});
