import { performance } from "node:perf_hooks";
import { pino } from "pino";

const EVENTS = [
  "startup",
  "configuration",
  "kubernetes.token_request",
  "memory.missing_token",
  "memory.invalid_token",
  "memory.token",
  "gateway.authentication",
  "gateway.oidc",
  "ready",
  "shutdown",
] as const;

const STATUSES = ["start", "success", "failure"] as const;
const CATEGORIES = [
  "configuration",
  "credentials",
  "network",
  "authentication",
  "authorization",
  "response",
  "internal",
] as const;

export type LifecycleEvent = (typeof EVENTS)[number];
export type LifecycleStatus = (typeof STATUSES)[number];
export type ErrorCategory = (typeof CATEGORIES)[number];

export interface LogOptions {
  durationMs?: number;
  category?: ErrorCategory;
}

export interface LifecycleLogger {
  log(event: LifecycleEvent, status: LifecycleStatus, options?: LogOptions): void;
  start(event: LifecycleEvent): {
    success(category?: ErrorCategory): void;
    failure(category?: ErrorCategory): void;
  };
}

function ignoreRejection(value: unknown): void {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    void Promise.resolve(value).catch(() => {});
  }
}

/** Isolate callers from failures in an injected logger as well as its writer. */
export function isolateLifecycleLogger(logger?: LifecycleLogger): LifecycleLogger {
  return {
    log(event, status, options) {
      try { ignoreRejection(logger?.log(event, status, options)); } catch { /* Logging is best effort. */ }
    },
    start(event) {
      let operation: ReturnType<LifecycleLogger["start"]> | undefined;
      try { operation = logger?.start(event); ignoreRejection(operation); } catch { /* Logging is best effort. */ }
      return {
        success(category) { try { ignoreRejection(operation?.success(category)); } catch { /* Ignore logger failures. */ } },
        failure(category) { try { ignoreRejection(operation?.failure(category)); } catch { /* Ignore logger failures. */ } },
      };
    },
  };
}

const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

// pino writes JSON lines to stdout through a synchronous (sonic-boom
// `sync: true`), EPIPE-safe destination. Synchronous writes are what is wanted
// before the `process.exit(1)` at the shutdown deadline: no record is lost.
// Base fields and timestamps are disabled so a record carries
// only the lifecycle fields plus pino's level.
const stdout = pino({ base: undefined, timestamp: false });

/** Preserve the scaffold greeting on the same sink as lifecycle records. */
export function writeStartupGreeting(): void {
  try { stdout.info("Hello from @rehor/agent-dispatcher"); } catch { /* Best effort. */ }
}

function isMember<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && list.some((item) => item === value);
}

/** Emits only fixed lifecycle identifiers and categories; never accepts message text. */
export function createLifecycleLogger(deps: {
  write?: (line: string) => void;
  now?: () => number;
} = {}): LifecycleLogger {
  const custom = deps.write;
  const logger = custom
    ? pino({ base: undefined, timestamp: false }, {
        write: (line: string) => {
          try { ignoreRejection(custom(line)); } catch { /* Logging is best effort. */ }
        },
      })
    : stdout;
  const now = deps.now ?? (() => performance.now());

  function log(event: LifecycleEvent, status: LifecycleStatus, options?: LogOptions): void {
    try {
      if (!isMember(EVENTS, event) || !isMember(STATUSES, status)) return;
      if (options !== undefined && (options === null || typeof options !== "object")) return;
      const duration = options?.durationMs;
      const category = options?.category;
      if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration))) return;
      if (category !== undefined && !isMember(CATEGORIES, category)) return;

      const record: { event: LifecycleEvent; status: LifecycleStatus; durationMs?: number; category?: ErrorCategory } = { event, status };
      if (duration !== undefined) record.durationMs = Math.round(Math.min(MAX_DURATION_MS, Math.max(0, duration)));
      if (category !== undefined) record.category = category;
      logger[status === "failure" ? "error" : "info"](record);
    } catch {
      // Logging must never expose writer/input errors or replace application errors.
    }
  }

  function clock(): number | undefined {
    try {
      const value = now();
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  function start(event: LifecycleEvent) {
    const valid = isMember(EVENTS, event);
    const started = valid ? clock() : undefined;
    if (valid) log(event, "start");
    const finish = (status: "success" | "failure", category?: ErrorCategory) => {
      if (!valid) return;
      const ended = clock();
      const durationMs = started !== undefined && ended !== undefined ? ended - started : undefined;
      log(event, status, { durationMs: Number.isFinite(durationMs) ? durationMs : undefined, category });
    };
    return {
      success: (category?: ErrorCategory) => finish("success", category),
      failure: (category?: ErrorCategory) => finish("failure", category),
    };
  }

  return { log, start };
}
