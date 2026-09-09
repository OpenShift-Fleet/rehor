import { readFile, unlink } from "node:fs/promises";

import type { PreflightResult } from "./ports/python-bridge";

const DEFAULT_MAX_PREFLIGHT_BACKOFF_MS = 300_000;

export type CycleDecision = "run" | "idle" | "error";

export interface CycleSchedulerConfig {
  /** Normal post-cycle delay. */
  intervalMs: number;
  /** Delay after a preflight skip. */
  idleIntervalMs: number;
  /** Upper bound for exponential preflight-error backoff. */
  maxPreflightBackoffMs?: number;
}

export interface SleepPlan {
  delayMs: number;
  reason: string;
}

export interface CyclePlan {
  decision: CycleDecision;
  sleep: SleepPlan | null;
  consecutivePreflightErrors: number;
}

export interface SleepSignal {
  recommendedSleepSeconds: number;
  reason?: string;
}

/** Stateful, side-effect-free scheduler for preflight and post-cycle decisions. */
export class CycleScheduler {
  private readonly config: Required<CycleSchedulerConfig>;
  private consecutiveErrors = 0;

  constructor(config: CycleSchedulerConfig) {
    assertNonNegative(config.intervalMs, "intervalMs");
    assertNonNegative(config.idleIntervalMs, "idleIntervalMs");
    const maxPreflightBackoffMs = config.maxPreflightBackoffMs ?? DEFAULT_MAX_PREFLIGHT_BACKOFF_MS;
    assertNonNegative(maxPreflightBackoffMs, "maxPreflightBackoffMs");
    this.config = { ...config, maxPreflightBackoffMs };
  }

  get consecutivePreflightErrors(): number {
    return this.consecutiveErrors;
  }

  planForPreflight(preflight: PreflightResult | null): CyclePlan {
    if (preflight?.action === "error") {
      this.consecutiveErrors += 1;
      const exponent = Math.min(this.consecutiveErrors, 30);
      const delayMs = Math.min(
        this.config.intervalMs * 2 ** exponent,
        this.config.maxPreflightBackoffMs,
      );
      return {
        decision: "error",
        sleep: { delayMs, reason: "preflight_error" },
        consecutivePreflightErrors: this.consecutiveErrors,
      };
    }

    this.consecutiveErrors = 0;
    if (preflight?.action === "skip") {
      return {
        decision: "idle",
        sleep: { delayMs: this.config.idleIntervalMs, reason: "preflight_skip" },
        consecutivePreflightErrors: 0,
      };
    }

    return { decision: "run", sleep: null, consecutivePreflightErrors: 0 };
  }

  planAfterRun(signal?: SleepSignal | null): SleepPlan {
    if (signal) {
      assertNonNegative(signal.recommendedSleepSeconds, "recommendedSleepSeconds");
      return {
        delayMs: signal.recommendedSleepSeconds * 1000,
        reason: signal.reason || "cycle_complete",
      };
    }
    return { delayMs: this.config.intervalMs, reason: "cycle_complete" };
  }
}

/** Consume Python-compatible cycle-sleep.json and remove it regardless of validity. */
export async function consumeSleepSignal(path: string): Promise<SleepSignal | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  } finally {
    await unlink(path).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }

  try {
    return parseSleepSignal(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseSleepSignal(value: unknown): SleepSignal | null {
  if (!isRecord(value)) return null;
  const seconds = value.recommended_sleep;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const reason = typeof value.reason === "string" ? value.reason : undefined;
  return { recommendedSleepSeconds: seconds, ...(reason ? { reason } : {}) };
}

/** Delay until the next cycle, while allowing shutdown/cancellation to interrupt it. */
export function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  assertNonNegative(delayMs, "delayMs");
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  if (delayMs === 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(resolve), delayMs);
    const onAbort = (): void => finish(() => reject(abortError(signal?.reason)));

    signal?.addEventListener("abort", onAbort, { once: true });

    function finish(callback: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    }
  });
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function abortError(reason: unknown): Error {
  const error = new Error(reason === undefined ? "sleep aborted" : String(reason));
  error.name = "AbortError";
  return error;
}
