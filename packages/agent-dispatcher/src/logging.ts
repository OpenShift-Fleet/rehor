import { performance } from "node:perf_hooks";
import { fstatSync, writeSync } from "node:fs";
import { pino } from "pino";
import type { PreflightDiagnostic } from "./preflight-diagnostics.js";
import type { PreflightWiringField } from "./preflight-engine-ts.js";

const EVENTS = [
  "startup",
  "configuration",
  "kubernetes.token_request",
  "memory.missing_token",
  "memory.invalid_token",
  "memory.token",
  "gateway.authentication",
  "gateway.oidc",
  "preflight.cycle",
  "preflight.error",
  "preflight.run",
  "sandbox.session",
  "sandbox.cleanup",
  "sandbox.retention",
  "sandbox.lock",
  "sandbox.registry",
  "sandbox.reconcile",
  "ready",
  "shutdown",
] as const;

/**
 * Stages long enough that a hang must be diagnosable from a start record.
 * Every other timed event collapses to a single completion record.
 */
const ANNOUNCED_STAGES = ["startup", "shutdown", "sandbox.session"] as const;

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
const RECONCILE_REASONS = ["never-provisioned", "workspace-gone", "sandbox-gone", "reconciled-terminal", "adopted", "adopt-timeout", "record-failure", "startup-timeout"] as const;
const PREFLIGHT_REASONS = ["configuration", "execution"] as const;
/** Fixed explanation for a busy cycle record; never derived from transcripts. */
const CYCLE_REASONS = ["session in progress"] as const;
/**
 * Outcome of a preflight entry or a dispatcher-cycle profile, plus the
 * cycle-level failure modes that precede any profile processing.
 */
const DECISIONS = [
  "start",
  "skip",
  "busy",
  "error",
  "no-scripts",
  "throttled",
  "shutdown",
  "sync-error",
  "discovery-error",
  "invalid-config",
] as const;
const PREFLIGHT_WIRING_FIELDS = ["BOT_INSTANCE_ID", "BOT_MEMORY_URL", "memory credential"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Opaque cycle agent id: sha256 hex. */
const AGENT_ID = /^[a-f0-9]{64}$/;
/** Registered preflight id (a central-registry identifier, never content). */
const PREFLIGHT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Nonprinting characters never appear in a well-formed diagnostic field. */
const DIAGNOSTIC_CONTROLS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export type LifecycleEvent = (typeof EVENTS)[number];
export type LifecycleStatus = (typeof STATUSES)[number];
export type ErrorCategory = (typeof CATEGORIES)[number];
export type SessionStage = (typeof SESSION_STAGES)[number];
export type SessionErrorCode = (typeof SESSION_ERROR_CODES)[number];
export type ReconcileReason = (typeof RECONCILE_REASONS)[number];
export type PreflightReason = (typeof PREFLIGHT_REASONS)[number];
export type CycleReason = (typeof CYCLE_REASONS)[number];
export type LifecycleDecision = (typeof DECISIONS)[number];
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
  /** Session registry (REHOR-218): registration and final-update failures. */
  register?: boolean;
  update?: boolean;
  /** Startup reconciliation (REHOR-218): run ID, outcome reason, adoption. */
  runId?: string;
  reason?: ReconcileReason | PreflightReason | CycleReason;
  adopted?: boolean;
  /**
   * Instance identity for preflight error reporting: the agent
   * profile name and its config-repository URL, plus the cycle's opaque
   * agentId for correlation with cycle results. Fixed identifiers only.
   */
  profile?: string;
  repository?: string;
  agentId?: string;
  configurationField?: PreflightWiringField;
  /**
   * Structured configuration diagnostics for a preflight failure: full
   * Zod issue detail (path, code, message, received) sourced from
   * declaration literals. Validated against the diagnostic contract before
   * anything is logged — every issue is kept, malformed input is rejected
   * whole.
   */
  diagnostics?: readonly PreflightDiagnostic[];
  /** Registered preflight id naming the failed entry in per-entry records. */
  preflightId?: string;
  /** Outcome of a preflight entry run or a dispatcher-cycle profile. */
  decision?: LifecycleDecision;
}

export interface LifecycleLogger {
  log(event: LifecycleEvent, status: LifecycleStatus, options?: LogOptions): void;
  start(event: LifecycleEvent, options?: LogOptions): {
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
    start(event, options) {
      let operation: ReturnType<LifecycleLogger["start"]> | undefined;
      try { operation = logger?.start(event, options); ignoreRejection(operation); } catch { /* Logging is best effort. */ }
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

const stdout = pino({ base: undefined, timestamp: pino.stdTimeFunctions.isoTime }, { write: writeStdoutLine });

/** Preserve the scaffold greeting on the same sink as lifecycle records. */
export function writeStartupGreeting(): void {
  try { stdout.info("Hello from @rehor/agent-dispatcher"); } catch { /* Best effort. */ }
}

function isMember<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && list.some((item) => item === value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One diagnostic field: a non-empty string without control characters;
 * length is never limited, so no issue is dropped. */
function diagnosticField(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !DIAGNOSTIC_CONTROLS.test(value);
}

/** Validate a diagnostics array against the PreflightDiagnostic contract
 * (exactly the four fields, non-empty, control-free); anything malformed
 * rejects the whole record, never partially logged. */
function diagnosticsLogValue(value: unknown): PreflightDiagnostic[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const diagnostics: PreflightDiagnostic[] = [];
  for (const item of value) {
    if (!isPlainRecord(item)) return undefined;
    const keys = Object.keys(item);
    if (keys.length !== 4 || !["path", "code", "message", "received"].every((field) => keys.includes(field))) return undefined;
    if (!diagnosticField(item.path) || !diagnosticField(item.code)
      || !diagnosticField(item.message) || !diagnosticField(item.received)) return undefined;
    diagnostics.push({ path: item.path, code: item.code, message: item.message, received: item.received });
  }
  return diagnostics;
}

/** Escape nonprinting characters in instance directory names. */
export function profileLogValue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2048 || value === "." || value === ".." || value.includes("/")) return undefined;
  const safe = value.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
  return safe.length <= 2048 ? safe : undefined;
}

/** Config repository URL with SSH userinfo removed. */
export function repositoryLogValue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\s\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (!(["https:", "ssh:"].includes(parsed.protocol)) || !parsed.hostname || parsed.password || parsed.search || parsed.hash
      || (parsed.protocol === "https:" && parsed.username)) return undefined;
  parsed.username = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.href.length <= 2048 ? parsed.href : undefined;
}

/** Emits only fixed lifecycle identifiers and categories; never accepts message text. */
export function createLifecycleLogger(deps: {
  write?: (line: string) => void;
  now?: () => number;
} = {}): LifecycleLogger {
  const custom = deps.write;
  const logger = custom
    ? pino({ base: undefined, timestamp: pino.stdTimeFunctions.isoTime }, {
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
      const register = options?.register;
      const update = options?.update;
      const runId = options?.runId;
      const reason = options?.reason;
      const adopted = options?.adopted;
      const profile = options?.profile === undefined ? undefined : profileLogValue(options.profile);
      const repository = options?.repository === undefined ? undefined : repositoryLogValue(options.repository);
      const agentId = options?.agentId;
      const configurationField = options?.configurationField;
      const diagnostics = options?.diagnostics === undefined ? undefined : diagnosticsLogValue(options.diagnostics);
      const preflightId = options?.preflightId;
      const decision = options?.decision;
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
      if (register !== undefined && typeof register !== "boolean") return;
      if (update !== undefined && typeof update !== "boolean") return;
      // Run IDs are opaque generated UUIDs; anything else is rejected.
      if (runId !== undefined && (typeof runId !== "string" || !UUID_PATTERN.test(runId))) return;
      if (reason !== undefined && !isMember(RECONCILE_REASONS, reason) && !isMember(PREFLIGHT_REASONS, reason) && !isMember(CYCLE_REASONS, reason)) return;
      if (adopted !== undefined && typeof adopted !== "boolean") return;
      if (options?.profile !== undefined && profile === undefined) return;
      if (options?.repository !== undefined && repository === undefined) return;
      if (agentId !== undefined && (typeof agentId !== "string" || !AGENT_ID.test(agentId))) return;
      if (configurationField !== undefined && !isMember(PREFLIGHT_WIRING_FIELDS, configurationField)) return;
      if (options?.diagnostics !== undefined && diagnostics === undefined) return;
      if (preflightId !== undefined && (typeof preflightId !== "string" || !PREFLIGHT_ID.test(preflightId))) return;
      if (decision !== undefined && !isMember(DECISIONS, decision)) return;

      const record: { event: LifecycleEvent; status: LifecycleStatus; durationMs?: number; category?: ErrorCategory; stage?: SessionStage; errorCode?: SessionErrorCode; workspaceName?: string; sandboxName?: string; retentionMs?: number; contended?: boolean; holder?: string; renew?: boolean; release?: boolean; register?: boolean; update?: boolean; runId?: string; reason?: ReconcileReason | PreflightReason | CycleReason; adopted?: boolean; profile?: string; repository?: string; agentId?: string; configurationField?: PreflightWiringField; diagnostics?: PreflightDiagnostic[]; preflightId?: string; decision?: LifecycleDecision } = { event, status };
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
      if (register !== undefined) record.register = register;
      if (update !== undefined) record.update = update;
      if (runId !== undefined) record.runId = runId;
      if (reason !== undefined) record.reason = reason;
      if (adopted !== undefined) record.adopted = adopted;
      if (profile !== undefined) record.profile = profile;
      if (repository !== undefined) record.repository = repository;
      if (agentId !== undefined) record.agentId = agentId;
      if (configurationField !== undefined) record.configurationField = configurationField;
      if (diagnostics !== undefined) record.diagnostics = diagnostics;
      if (preflightId !== undefined) record.preflightId = preflightId;
      if (decision !== undefined) record.decision = decision;
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

  function start(event: LifecycleEvent, options?: LogOptions) {
    const valid = isMember(EVENTS, event);
    const started = valid ? clock() : undefined;
    // Only long-running stages announce a start record; cheap events collapse
    // to a single completion record so the stream stays one line per step.
    if (valid && isMember(ANNOUNCED_STAGES, event)) log(event, "start", options);
    const finish = (status: "success" | "failure", category?: ErrorCategory, details?: LifecycleDetails) => {
      if (!valid) return;
      const ended = clock();
      const durationMs = started !== undefined && ended !== undefined ? ended - started : undefined;
      log(event, status, { ...options, ...details, durationMs: Number.isFinite(durationMs) ? durationMs : undefined, category });
    };
    return {
      success: (category?: ErrorCategory, details?: LifecycleDetails) => finish("success", category, details),
      failure: (category?: ErrorCategory, details?: LifecycleDetails) => finish("failure", category, details),
    };
  }

  return { log, start };
}
