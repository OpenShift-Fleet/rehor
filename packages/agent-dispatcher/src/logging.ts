import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

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

// A dedicated unreferenced worker isolates even synchronous OS writes (including
// regular files and terminals). Only one record is in flight; bounded queued
// records are dropped when the sink stalls or fails. A short ref deadline lets
// ordinary exit flush records without allowing a blocked sink to keep it alive.
const SINK_QUEUE_LIMIT = 64;
const SINK_DEADLINE_MS = 1000;
let stdoutWriter: ((line: string) => void) | undefined;

function createStdoutWriter(): (line: string) => void {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const { writeSync } = require('node:fs');
    parentPort.on('message', (line) => {
      try {
        const bytes = Buffer.from(line + '\\n');
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(1, bytes, offset, bytes.length - offset);
          if (written <= 0) throw new Error();
          offset += written;
        }
        parentPort.postMessage(true);
      } catch { parentPort.postMessage(false); }
    });
  `, { eval: true, execArgv: [], env: {} });
  const queue: string[] = [];
  let active = true;
  let pending = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    active = false;
    queue.length = 0;
    if (deadline) clearTimeout(deadline);
    deadline = undefined;
    worker.unref();
  };
  const send = () => {
    if (!active || pending) return;
    const line = queue.shift();
    if (line === undefined) {
      if (deadline) clearTimeout(deadline);
      deadline = undefined;
      worker.unref();
      return;
    }
    pending = true;
    worker.postMessage(line);
  };
  worker.on("message", (ok: unknown) => {
    if (!active) return;
    pending = false;
    if (ok !== true) { stop(); return; }
    if (deadline) clearTimeout(deadline);
    deadline = setTimeout(stop, SINK_DEADLINE_MS);
    try { send(); } catch { stop(); }
  });
  worker.on("error", stop);
  worker.on("exit", stop);
  worker.unref();
  return (line) => {
    if (!active || queue.length + Number(pending) >= SINK_QUEUE_LIMIT) return;
    queue.push(line);
    if (!deadline) {
      worker.ref();
      deadline = setTimeout(stop, SINK_DEADLINE_MS);
    }
    try { send(); } catch { stop(); }
  };
}

function writeStdout(line: string): void {
  stdoutWriter ??= createStdoutWriter();
  stdoutWriter(line);
}

/** Preserve the scaffold greeting without bypassing the bounded stdout sink. */
export function writeStartupGreeting(): void {
  try { writeStdout("Hello from @rehor/agent-dispatcher"); } catch { /* Best effort. */ }
}

/** Names fit the Gateway's 19-character limit and are deterministic per run. */
export function probeResourceNames(runId: string) {
  if (typeof runId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId)) throw new Error("Invalid probe run ID");
  const suffix = (BigInt(`0x${runId.replaceAll("-", "")}`) % (36n ** 18n)).toString(36).padStart(18, "0");
  return { workspace: `w${suffix}`, profile: `p${suffix}`, provider: `v${suffix}`, sandbox: `s${suffix}` };
}

const PROBE_LOG_CODES = ["invalid_argument", "permission_denied", "unauthenticated", "deadline_exceeded", "cancelled", "unavailable", "other", "ambiguous", "deletion_pending", "diagnostic_node_not_running", "diagnostic_nonzero_exit", "diagnostic_invalid_exit", "diagnostic_missing_exit", "diagnostic_unsupported_event", "diagnostic_output_limit", "diagnostic_event_limit", "diagnostic_rpc_failure", "diagnostic_invalid_output", "diagnostic_probe_file_missing", "diagnostic_probe_file_unreadable", "diagnostic_health_url_invalid", "diagnostic_token_placeholder_invalid", "probe_missing_token", "probe_invalid_config", "probe_redirect", "probe_http_error", "probe_http_unauthorized", "probe_http_forbidden", "probe_tls_error", "probe_timeout", "probe_request_error", "probe_dns_error", "probe_connection_error", "probe_unexpected", "probe_node_eacces", "probe_node_eperm", "probe_node_err_module_not_found", "probe_node_module_not_found", "probe_node_require_esm", "probe_node_syntax_error", "probe_node_module_load_error", "probe_node_option_error", "probe_missing_exit", "probe_nonzero_exit", "probe_invalid_exit", "probe_unsupported_event", "probe_output_limit", "probe_event_limit", "probe_rpc_failure", "probe_wrapper_start_missing"] as const;
export type ProbeLogCode = (typeof PROBE_LOG_CODES)[number];
export type GatewayDeleteOutcome = "accepted" | "completed";

export type ProbeExecMarker = "probe-started" | "probe-config-ok" | "probe-request-started" | "probe-success";

export interface ProbeExecMetrics {
  phase: "diagnostic" | "probe";
  eventCount: number;
  stdoutBytes: number;
  stderrBytes: number;
  exitCode?: number;
  markers?: ProbeExecMarker[];
  markersTruncated?: boolean;
}

export interface StartupDiagnostic {
  nodeRuns: boolean;
  probeFileExists: boolean;
  probeFileReadable: boolean;
  healthUrlShape: boolean;
  tokenPlaceholderShape: boolean;
}

const MAX_EXEC_EVENTS = 1024;
const MAX_EXEC_BYTES = 65536;

function validExecMetrics(metrics: ProbeExecMetrics | undefined, stage: string): metrics is ProbeExecMetrics {
  if (metrics === undefined) return true;
  if (!metrics || typeof metrics !== "object"
      || Object.keys(metrics).some((key) => !["phase", "eventCount", "stdoutBytes", "stderrBytes", "exitCode", "markers", "markersTruncated"].includes(key))
      || !["diagnostic", "probe"].includes(metrics.phase)
      || (metrics.phase === "diagnostic" ? stage !== "diagnostic" : stage !== "connectivity")
      || !Number.isInteger(metrics.eventCount) || metrics.eventCount < 0 || metrics.eventCount > MAX_EXEC_EVENTS
      || !Number.isInteger(metrics.stdoutBytes) || metrics.stdoutBytes < 0 || metrics.stdoutBytes > MAX_EXEC_BYTES
      || !Number.isInteger(metrics.stderrBytes) || metrics.stderrBytes < 0 || metrics.stderrBytes > MAX_EXEC_BYTES
      || metrics.stdoutBytes + metrics.stderrBytes > MAX_EXEC_BYTES
      || (metrics.exitCode !== undefined && (!Number.isInteger(metrics.exitCode) || metrics.exitCode < 0 || metrics.exitCode > 255))) return false;
  if (metrics.phase === "diagnostic") return metrics.markers === undefined && metrics.markersTruncated === undefined;
  return (metrics.markers === undefined || (Array.isArray(metrics.markers) && metrics.markers.length <= 8
      && metrics.markers.every((marker) => ["probe-started", "probe-config-ok", "probe-request-started", "probe-success"].includes(marker))))
    && (metrics.markersTruncated === undefined || typeof metrics.markersTruncated === "boolean");
}

function validStartupDiagnostic(diagnostic: StartupDiagnostic | undefined, stage: string): diagnostic is StartupDiagnostic {
  return diagnostic === undefined || (stage === "diagnostic" && diagnostic !== null && typeof diagnostic === "object"
    && Object.keys(diagnostic).length === 5
    && Object.keys(diagnostic).every((key) => ["nodeRuns", "probeFileExists", "probeFileReadable", "healthUrlShape", "tokenPlaceholderShape"].includes(key))
    && typeof diagnostic.nodeRuns === "boolean"
    && typeof diagnostic.probeFileExists === "boolean"
    && typeof diagnostic.probeFileReadable === "boolean"
    && typeof diagnostic.healthUrlShape === "boolean"
    && typeof diagnostic.tokenPlaceholderShape === "boolean");
}

/** Only generated, validated run names and fixed identifiers reach the sink. */
export function writeProbeLog(runId: string, stage: "configuration" | "workspace" | "provider" | "sandbox" | "diagnostic" | "connectivity" | "cleanup", status: "start" | "success" | "failure" | "incomplete", resource?: "workspace" | "profile" | "provider" | "sandbox", code?: ProbeLogCode, exitCode?: number, exec?: ProbeExecMetrics, diagnostic?: StartupDiagnostic, gatewayDeleteOutcome?: GatewayDeleteOutcome): void {
  if (!["configuration", "workspace", "provider", "sandbox", "diagnostic", "connectivity", "cleanup"].includes(stage) || !["start", "success", "failure", "incomplete"].includes(status) || (resource !== undefined && !["workspace", "profile", "provider", "sandbox"].includes(resource)) || (code !== undefined && !PROBE_LOG_CODES.includes(code)) || (code === "deletion_pending" && (stage !== "cleanup" || status !== "incomplete" || resource !== "sandbox" || gatewayDeleteOutcome !== "accepted")) || (exitCode !== undefined && (stage !== "connectivity" || status !== "failure" || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) || (gatewayDeleteOutcome !== undefined && (stage !== "cleanup" || status !== "incomplete" || resource !== "sandbox" || code !== "deletion_pending" || gatewayDeleteOutcome !== "accepted")) || !validExecMetrics(exec, stage) || !validStartupDiagnostic(diagnostic, stage)) return;
  try {
    const names = probeResourceNames(runId);
    writeStdout(JSON.stringify({ stage, status, runId, ...(status === "start" || status === "incomplete" ? names : {}), ...(resource ? { resource } : {}), ...(code ? { code } : {}), ...(gatewayDeleteOutcome ? { gatewayDeleteOutcome } : {}), ...(exitCode !== undefined ? { exitCode } : {}), ...(exec ? { exec } : {}), ...(diagnostic ? { diagnostic } : {}) }));
  } catch { /* Best effort. */ }
}

function isMember<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && list.some((item) => item === value);
}

/** Emits only fixed lifecycle identifiers and categories; never accepts message text. */
export function createLifecycleLogger(deps: {
  write?: (line: string) => void;
  now?: () => number;
} = {}): LifecycleLogger {
  const write = deps.write ?? writeStdout;
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
      const result: unknown = write(JSON.stringify(record));
      // JavaScript callers may supply an async writer despite the synchronous type.
      ignoreRejection(result);
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
