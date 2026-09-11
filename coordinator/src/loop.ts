import type { PreparedCycleInput } from "./cycle-input";
import type { CycleAdmission, CycleAdmissionLease, LoopWriteResult } from "./ports/loop";
import { type CyclePlan, type CycleScheduler, type SleepSignal, sleep } from "./scheduler";

export enum LoopStopReason {
  Shutdown = "shutdown",
  Cancelled = "cancelled",
  AdmissionDenied = "admission_denied",
  MaxCycles = "max_cycles",
  Failed = "failed",
}

export enum LoopErrorPhase {
  Admission = "admission",
  Prepare = "prepare",
  Run = "run",
  Sleep = "sleep",
}

export interface CoordinatorLoopOptions<TResult> {
  admission: CycleAdmission;
  scheduler: CycleScheduler;
  prepare(signal: AbortSignal): Promise<PreparedCycleInput>;
  run(prepared: PreparedCycleInput, signal: AbortSignal): Promise<TResult>;
  sleepSignal?: () => Promise<SleepSignal | null>;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  shutdownSignal?: AbortSignal;
  signal?: AbortSignal;
  maxCycles?: number;
  onDecision?(plan: CyclePlan, prepared?: PreparedCycleInput): LoopWriteResult;
  onError?(error: unknown, phase: LoopErrorPhase): LoopWriteResult;
}

export interface CoordinatorLoopResult<TResult> {
  stopReason: LoopStopReason;
  cycles: number;
  results: readonly TResult[];
  error?: unknown;
}

export interface LoopSignalController {
  readonly signal: AbortSignal;
  readonly stopReason: LoopStopReason.Shutdown | LoopStopReason.Cancelled | undefined;
  requestShutdown(reason?: unknown): void;
  requestCancel(reason?: unknown): void;
  dispose(): void;
}

/** Combines external cancellation and shutdown signals into one loop signal. */
export function createLoopSignals(
  options: { shutdownSignal?: AbortSignal; signal?: AbortSignal } = {},
): LoopSignalController {
  const controller = new AbortController();
  let stopReason: LoopStopReason.Shutdown | LoopStopReason.Cancelled | undefined;
  const listeners: Array<() => void> = [];

  const trigger = (
    kind: LoopStopReason.Shutdown | LoopStopReason.Cancelled,
    reason?: unknown,
  ): void => {
    if (controller.signal.aborted) return;
    stopReason = kind;
    controller.abort(reason);
  };
  const watch = (
    signal: AbortSignal | undefined,
    kind: LoopStopReason.Shutdown | LoopStopReason.Cancelled,
  ): void => {
    if (!signal) return;
    const onAbort = (): void => trigger(kind, signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    listeners.push(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
  };

  watch(options.shutdownSignal, LoopStopReason.Shutdown);
  watch(options.signal, LoopStopReason.Cancelled);

  return {
    signal: controller.signal,
    get stopReason() {
      return stopReason;
    },
    requestShutdown: (reason) => trigger(LoopStopReason.Shutdown, reason),
    requestCancel: (reason) => trigger(LoopStopReason.Cancelled, reason),
    dispose: () => {
      for (const remove of listeners) remove();
      listeners.length = 0;
    },
  };
}

export interface ProcessSignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off?(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener?(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** Attach OS shutdown signals without making the loop depend directly on process. */
export function installProcessSignalHandlers(
  signals: Pick<LoopSignalController, "requestShutdown">,
  source: ProcessSignalSource,
): () => void {
  const onSignal = (): void => signals.requestShutdown("process signal");
  source.on("SIGINT", onSignal);
  source.on("SIGTERM", onSignal);
  return () => {
    if (source.off) {
      source.off("SIGINT", onSignal);
      source.off("SIGTERM", onSignal);
    } else if (source.removeListener) {
      source.removeListener("SIGINT", onSignal);
      source.removeListener("SIGTERM", onSignal);
    }
  };
}

/** Run preparation, admission, scheduling, and runtime attempts until stopped. */
export async function runCoordinatorLoop<TResult>(
  options: CoordinatorLoopOptions<TResult>,
): Promise<CoordinatorLoopResult<TResult>> {
  assertMaxCycles(options.maxCycles);
  const signals = createLoopSignals({
    shutdownSignal: options.shutdownSignal,
    signal: options.signal,
  });
  const results: TResult[] = [];
  let cycles = 0;
  let lease: CycleAdmissionLease | null = null;

  try {
    try {
      lease = await options.admission.acquire(signals.signal);
    } catch (error) {
      if (signals.signal.aborted) return stopped(signals, cycles, results);
      await options.onError?.(error, LoopErrorPhase.Admission);
      return { stopReason: LoopStopReason.Failed, cycles, results, error };
    }
    if (!lease) return { stopReason: LoopStopReason.AdmissionDenied, cycles, results };

    while (!signals.signal.aborted) {
      if (options.maxCycles !== undefined && cycles >= options.maxCycles) {
        return { stopReason: LoopStopReason.MaxCycles, cycles, results };
      }

      let prepared: PreparedCycleInput;
      try {
        prepared = await options.prepare(signals.signal);
      } catch (error) {
        if (signals.signal.aborted) break;
        cycles += 1;
        await options.onError?.(error, LoopErrorPhase.Prepare);
        const plan = options.scheduler.planForPreflight(errorPreflight(error));
        await options.onDecision?.(plan);
        if (!(await waitForPlan(plan, options, signals.signal))) break;
        continue;
      }

      const plan = options.scheduler.planForPreflight(prepared.preflight);
      cycles += 1;
      await options.onDecision?.(plan, prepared);
      if (plan.decision !== "run") {
        if (!(await waitForPlan(plan, options, signals.signal))) break;
        continue;
      }

      try {
        results.push(await options.run(prepared, signals.signal));
      } catch (error) {
        if (signals.signal.aborted) break;
        await options.onError?.(error, LoopErrorPhase.Run);
      }

      if (signals.signal.aborted) break;
      let signal: SleepSignal | null = null;
      if (options.sleepSignal) {
        try {
          signal = await options.sleepSignal();
        } catch (error) {
          await options.onError?.(error, LoopErrorPhase.Sleep);
        }
      }
      const sleepPlan = options.scheduler.planAfterRun(signal);
      if (
        !(await waitForPlan(
          { decision: "run", sleep: sleepPlan, consecutivePreflightErrors: 0 },
          options,
          signals.signal,
        ))
      ) {
        break;
      }
    }

    return stopped(signals, cycles, results);
  } finally {
    try {
      await lease?.release();
    } finally {
      signals.dispose();
    }
  }
}

async function waitForPlan<TResult>(
  plan: CyclePlan,
  options: CoordinatorLoopOptions<TResult>,
  signal: AbortSignal,
): Promise<boolean> {
  if (!plan.sleep) return !signal.aborted;
  try {
    await (options.sleep ?? sleep)(plan.sleep.delayMs, signal);
    return !signal.aborted;
  } catch (error) {
    if (signal.aborted) return false;
    await options.onError?.(error, LoopErrorPhase.Sleep);
    return false;
  }
}

function stopped<TResult>(
  signals: LoopSignalController,
  cycles: number,
  results: readonly TResult[],
): CoordinatorLoopResult<TResult> {
  return {
    stopReason: signals.stopReason ?? LoopStopReason.Failed,
    cycles,
    results,
  };
}

function errorPreflight(error: unknown): PreparedCycleInput["preflight"] {
  return {
    action: "error",
    prompt: "",
    transcript: error instanceof Error ? error.message : String(error),
    scripts: [],
  };
}

function assertMaxCycles(maxCycles: number | undefined): void {
  if (maxCycles !== undefined && (!Number.isSafeInteger(maxCycles) || maxCycles <= 0)) {
    throw new RangeError("maxCycles must be a positive safe integer");
  }
}
