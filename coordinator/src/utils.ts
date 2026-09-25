export function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

export function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function abortError(reason: unknown, fallbackMessage: string): Error {
  const error = new Error(reason === undefined ? fallbackMessage : describeAbortReason(reason));
  error.name = "AbortError";
  return error;
}

/**
 * Abort reason for a process shutdown (SIGTERM/SIGINT). The `kind` survives
 * signal chaining, so the coordinator and runtime adapters classify the attempt
 * as interrupted rather than cancelled whatever the human-readable reason says.
 */
export interface ShutdownAbortReason {
  kind: "shutdown";
  reason?: unknown;
}

export function shutdownAbortReason(reason?: unknown): ShutdownAbortReason {
  return reason === undefined ? { kind: "shutdown" } : { kind: "shutdown", reason };
}

/** Kind of a structured abort reason (`{ kind }`, possibly nested), or a string reason itself. */
export function abortReasonKind(reason: unknown): string | undefined {
  if (typeof reason === "string") return reason;
  if (!isRecord(reason)) return undefined;
  if (typeof reason.kind === "string") return reason.kind;
  return "reason" in reason ? abortReasonKind(reason.reason) : undefined;
}

function describeAbortReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (!isRecord(reason)) return String(reason);
  const kind = typeof reason.kind === "string" ? reason.kind : "";
  const detail = reason.reason === undefined ? "" : describeAbortReason(reason.reason);
  return [kind, detail].filter(Boolean).join(": ") || "aborted";
}
