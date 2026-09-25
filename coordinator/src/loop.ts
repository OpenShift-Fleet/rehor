import type { PreparedCycleInput } from "./cycle-input";
import type { CycleAdmission, CycleAdmissionLease, LoopWriteResult } from "./ports/loop";
import { PreflightAction } from "./ports/python-bridge";
import {
  CycleDecision,
  type CyclePlan,
  type CycleScheduler,
  type SleepSignal,
  sleep,
} from "./scheduler";
import { shutdownAbortReason } from "./utils";

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
  Decision = "decision",
  Run = "run",
  Cleanup = "cleanup",
  Sleep = "sleep",
}

export interface CoordinatorLoopOptions<TResult> {
  admission: CycleAdmission;
  scheduler: CycleScheduler;
  prepare(signal: AbortSignal): Promise<PreparedCycleInput>;
  run(prepared: PreparedCycleInput, signal: AbortSignal): Promise<TResult>;
  /**
   * Post-run housekeeping. It runs after the sleep signal is read, because
   * cleanup may delete that signal, and it runs even when shutdown interrupted
   * the attempt. A failure is reported but does not fail the completed run.
   */
  afterRun?(): Promise<void>;
  sleepSignal?: () => Promise<SleepSignal | null>;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  shutdownSignal?: AbortSignal;
  signal?: AbortSignal;
  maxCycles?: number;
  onDecision?(
    plan: CyclePlan,
    prepared?: PreparedCycleInput,
    signal?: AbortSignal,
  ): LoopWriteResult;
  onError?(error: unknown, phase: LoopErrorPhase): LoopWriteResult;
}

export interface CoordinatorLoopResult<TResult> {
  stopReason: LoopStopReason;
  cycles: number;
  results: readonly TResult[];
  failures: number;
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
    // Runtime attempts receive this combined signal, so a shutdown must stay
    // recognisable as one: "process signal" alone would classify as cancelled.
    controller.abort(kind === LoopStopReason.Shutdown ? shutdownAbortReason(reason) : reason);
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
  let failures = 0;
  let lease: CycleAdmissionLease | null = null;
  // Reporting hooks write to external sinks; their failures must never stop the loop.
  const reportError = (error: unknown, phase: LoopErrorPhase): Promise<void> =>
    safely(() => options.onError?.(error, phase));
  const decide = async (plan: CyclePlan, prepared?: PreparedCycleInput): Promise<void> => {
    try {
      await options.onDecision?.(plan, prepared, signals.signal);
    } catch (error) {
      await reportError(error, LoopErrorPhase.Decision);
    }
  };

  try {
    try {
      lease = await options.admission.acquire(signals.signal);
    } catch (error) {
      if (signals.signal.aborted) return stopped(signals, cycles, results, failures);
      await reportError(error, LoopErrorPhase.Admission);
      return { stopReason: LoopStopReason.Failed, cycles, results, failures: 1, error };
    }
    if (!lease) return { stopReason: LoopStopReason.AdmissionDenied, cycles, results, failures };

    while (!signals.signal.aborted) {
      if (options.maxCycles !== undefined && cycles >= options.maxCycles) {
        return { stopReason: LoopStopReason.MaxCycles, cycles, results, failures };
      }

      let prepared: PreparedCycleInput;
      try {
        prepared = await options.prepare(signals.signal);
      } catch (error) {
        if (signals.signal.aborted) break;
        cycles += 1;
        failures += 1;
        await reportError(error, LoopErrorPhase.Prepare);
        const plan = options.scheduler.planForPreflight(errorPreflight(error));
        await decide(plan);
        if (!(await waitForPlan(plan, options, signals.signal, reportError))) break;
        continue;
      }

      const plan = options.scheduler.planForPreflight(prepared.preflight);
      cycles += 1;
      if (plan.decision === CycleDecision.Error) failures += 1;
      await decide(plan, prepared);
      if (plan.decision !== CycleDecision.Run) {
        if (!(await waitForPlan(plan, options, signals.signal, reportError))) break;
        continue;
      }

      try {
        results.push(await options.run(prepared, signals.signal));
      } catch (error) {
        if (!signals.signal.aborted) {
          failures += 1;
          await reportError(error, LoopErrorPhase.Run);
        }
      }

      // Read the sleep signal before cleanup: cleanup deletes it.
      let signal: SleepSignal | null = null;
      if (options.sleepSignal && !signals.signal.aborted) {
        try {
          signal = await options.sleepSignal();
        } catch (error) {
          failures += 1;
          await reportError(error, LoopErrorPhase.Sleep);
        }
      }
      if (options.afterRun) {
        try {
          await options.afterRun();
        } catch (error) {
          await reportError(error, LoopErrorPhase.Cleanup);
        }
      }

      if (signals.signal.aborted) break;
      const sleepPlan = options.scheduler.planAfterRun(signal);
      if (
        !(await waitForPlan(
          { decision: CycleDecision.Run, sleep: sleepPlan, consecutivePreflightErrors: 0 },
          options,
          signals.signal,
          reportError,
        ))
      ) {
        break;
      }
    }

    return stopped(signals, cycles, results, failures);
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
  reportError: (error: unknown, phase: LoopErrorPhase) => Promise<void>,
): Promise<boolean> {
  if (!plan.sleep) return !signal.aborted;
  try {
    await (options.sleep ?? sleep)(plan.sleep.delayMs, signal);
    return !signal.aborted;
  } catch (error) {
    if (signal.aborted) return false;
    await reportError(error, LoopErrorPhase.Sleep);
    return false;
  }
}

async function safely(hook: () => LoopWriteResult): Promise<void> {
  try {
    await hook();
  } catch (error) {
    console.warn(
      `coordinator loop reporting hook failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function stopped<TResult>(
  signals: LoopSignalController,
  cycles: number,
  results: readonly TResult[],
  failures: number,
): CoordinatorLoopResult<TResult> {
  return {
    stopReason: signals.stopReason ?? LoopStopReason.Failed,
    cycles,
    results,
    failures,
  };
}

function errorPreflight(error: unknown): PreparedCycleInput["preflight"] {
  return {
    action: PreflightAction.Error,
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
