import { performance } from "node:perf_hooks";
import { fstatSync, writeSync } from "node:fs";
import { pino } from "pino";
import type { DispatcherCycleResult } from "./dispatcher-cycle.js";

const EVENTS = [
  "startup",
  "configuration",
  "kubernetes.token_request",
  "memory.missing_token",
  "memory.invalid_token",
  "memory.token",
  "gateway.authentication",
  "gateway.oidc",
  "sandbox.session",
  "sandbox.cleanup",
  "sandbox.retention",
  "sandbox.lock",
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
const SESSION_STAGES = ["input", "policy", "workspace", "provider", "sandbox", "readiness", "write", "runner", "complete"] as const;
const SESSION_ERROR_CODES = ["invalid_argument", "not_found", "permission_denied", "unauthenticated", "deadline_exceeded", "unavailable", "cancelled", "readiness_timeout", "other"] as const;

export type LifecycleEvent = (typeof EVENTS)[number];
export type LifecycleStatus = (typeof STATUSES)[number];
export type ErrorCategory = (typeof CATEGORIES)[number];
export type SessionStage = (typeof SESSION_STAGES)[number];
export type SessionErrorCode = (typeof SESSION_ERROR_CODES)[number];
export type LifecycleDetails = { stage?: SessionStage; errorCode?: SessionErrorCode };

export interface LogOptions {
  durationMs?: number;
  category?: ErrorCategory;
  stage?: SessionStage;
  errorCode?: SessionErrorCode;
  /** Opaque generated gateway resource names for retention debugging (REHOR-245). */
  workspaceName?: string;
  sandboxName?: string;
  retentionMs?: number;
  /** Session mutex (REHOR-218): contention, holder identity, and failures. */
  contended?: boolean;
  holder?: string;
  renew?: boolean;
  release?: boolean;
}

export interface LifecycleLogger {
  log(event: LifecycleEvent, status: LifecycleStatus, options?: LogOptions): void;
  start(event: LifecycleEvent): {
    success(category?: ErrorCategory, details?: LifecycleDetails): void;
    failure(category?: ErrorCategory, details?: LifecycleDetails): void;
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

// Never leave an asynchronous stdout write or Pino exit flush waiting on a
// full pipe. Nonblocking writes are best effort: a saturated or broken sink
// drops records rather than preventing shutdown.
let stdoutAvailable = false;
try {
  const handle = (process.stdout as typeof process.stdout & {
    _handle?: { setBlocking?: (blocking: boolean) => unknown };
  })._handle;
  if (typeof handle?.setBlocking === "function") {
    // Node's internal libuv handle returns zero on success. Unknown return
    // values must not be assumed to mean the descriptor is nonblocking.
    stdoutAvailable = handle.setBlocking(false) === 0;
  }
} catch { /* Fall back only if stdout is a regular file. */ }
if (!stdoutAvailable) {
  // Regular file writes cannot wait for a pipe reader, but may block on slow
  // storage. Unknown descriptors remain disabled unless made nonblocking.
  try { stdoutAvailable = fstatSync(1).isFile(); } catch { /* Drop logs. */ }
}

function writeStdoutLine(line: string): void {
  if (!stdoutAvailable) return;
  let offset = 0;
  try {
    const data = Buffer.from(line);
    while (offset < data.length) {
      const written = writeSync(1, data, offset);
      if (written === 0) throw new Error("stdout write made no progress");
      offset += written;
    }
  } catch {
    // Do not append later records to a partially written JSON line.
    if (offset > 0) stdoutAvailable = false;
  }
}

const stdout = pino({ base: undefined, timestamp: false }, { write: writeStdoutLine });

/** Cycle results contain only statuses and opaque IDs; never emit preflight output. */
export function writePreflightCycle(result: DispatcherCycleResult): void {
  try { writeStdoutLine(`${JSON.stringify({ event: "preflight.cycle", result })}\n`); } catch { /* Best effort. */ }
}

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
      const stage = options?.stage;
      const errorCode = options?.errorCode;
      const workspaceName = options?.workspaceName;
      const sandboxName = options?.sandboxName;
      const retentionMs = options?.retentionMs;
      const contended = options?.contended;
      const holder = options?.holder;
      const renew = options?.renew;
      const release = options?.release;
      if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration))) return;
      if (category !== undefined && !isMember(CATEGORIES, category)) return;
      if (stage !== undefined && !isMember(SESSION_STAGES, stage)) return;
      if (errorCode !== undefined && !isMember(SESSION_ERROR_CODES, errorCode)) return;
      // Gateway resource names are opaque generated identifiers: one letter
      // plus 18 base36 characters. Anything else is rejected, never logged.
      if (workspaceName !== undefined && (typeof workspaceName !== "string" || !/^[a-z0-9]{19}$/.test(workspaceName))) return;
      if (sandboxName !== undefined && (typeof sandboxName !== "string" || !/^[a-z0-9]{19}$/.test(sandboxName))) return;
      if (retentionMs !== undefined && (typeof retentionMs !== "number" || !Number.isFinite(retentionMs))) return;
      if (contended !== undefined && typeof contended !== "boolean") return;
      // Holders are pod names: one DNS label, never session content.
      if (holder !== undefined && (typeof holder !== "string" || holder.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(holder))) return;
      if (renew !== undefined && typeof renew !== "boolean") return;
      if (release !== undefined && typeof release !== "boolean") return;

      const record: { event: LifecycleEvent; status: LifecycleStatus; durationMs?: number; category?: ErrorCategory; stage?: SessionStage; errorCode?: SessionErrorCode; workspaceName?: string; sandboxName?: string; retentionMs?: number; contended?: boolean; holder?: string; renew?: boolean; release?: boolean } = { event, status };
      if (duration !== undefined) record.durationMs = Math.round(Math.min(MAX_DURATION_MS, Math.max(0, duration)));
      if (category !== undefined) record.category = category;
      if (stage !== undefined) record.stage = stage;
      if (errorCode !== undefined) record.errorCode = errorCode;
      if (workspaceName !== undefined) record.workspaceName = workspaceName;
      if (sandboxName !== undefined) record.sandboxName = sandboxName;
      if (retentionMs !== undefined) record.retentionMs = Math.round(Math.min(MAX_DURATION_MS, Math.max(0, retentionMs)));
      if (contended !== undefined) record.contended = contended;
      if (holder !== undefined) record.holder = holder;
      if (renew !== undefined) record.renew = renew;
      if (release !== undefined) record.release = release;
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
    const finish = (status: "success" | "failure", category?: ErrorCategory, details?: LifecycleDetails) => {
      if (!valid) return;
      const ended = clock();
      const durationMs = started !== undefined && ended !== undefined ? ended - started : undefined;
      log(event, status, { ...details, durationMs: Number.isFinite(durationMs) ? durationMs : undefined, category });
    };
    return {
      success: (category?: ErrorCategory, details?: LifecycleDetails) => finish("success", category, details),
      failure: (category?: ErrorCategory, details?: LifecycleDetails) => finish("failure", category, details),
    };
  }

  return { log, start };
}
