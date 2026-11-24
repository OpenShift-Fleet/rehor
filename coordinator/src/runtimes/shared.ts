import type { RuntimeTerminalState } from "../domain";
import { isAbortCause } from "../domain/abort-cause";

export type JsonRecord = Record<string, unknown>;

export function buildTerminalPayload(input: {
  state: RuntimeTerminalState;
  reason?: string;
  resultText?: string;
  turns: number;
  durationMs: number;
  resourceLeak?: boolean;
}): JsonRecord {
  return {
    state: input.state,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.resultText ? { resultText: input.resultText } : {}),
    turns: input.turns,
    durationMs: input.durationMs,
    ...(input.resourceLeak ? { resourceLeak: true } : {}),
  };
}

/** Stable JSON for hashes and deterministic diagnostics. Undefined object fields are omitted. */
export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const object = value as JsonRecord;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

const REDACTED = "[REDACTED]";

/** Removes common credential forms before runtime text enters the event stream. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /((?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b(bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/(https?:\/\/)([^/\s@]+)@/gi, `$1${REDACTED}@`)
    .replace(
      /([?&](?:api[-_]?key|access[-_]?token|authorization|password|secret|token)=)[^&#\s]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /((?:["']?(?:api[-_]?key|access[-_]?token|auth(?:orization)?|password|secret|token)["']?)\s*[:=]\s*["']?)[^"',\s}&]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, REDACTED);
}

/** Runs an operation until it settles, the caller aborts, or its deadline expires. */
export function boundedOperation<T>(
  operation: (signal: AbortSignal) => Promise<T> | T,
  signal: AbortSignal,
  deadline: number | undefined,
  name: string,
  deadlineError: Error = new Error(`${name} exceeded deadline`),
): Promise<T> {
  const deadlineController = new AbortController();
  const operationSignal = AbortSignal.any([signal, deadlineController.signal]);
  let timer: NodeJS.Timeout | undefined;
  if (deadline !== undefined) {
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      timer = setTimeout(() => deadlineController.abort(deadlineError), remaining);
    } else {
      deadlineController.abort(deadlineError);
    }
  }

  return new Promise<T>((resolve, reject) => {
    let pending: Promise<T> | undefined;
    let settled = false;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      operationSignal.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => settle(() => reject(abortReason(operationSignal)));

    if (operationSignal.aborted) {
      onAbort();
    } else {
      operationSignal.addEventListener("abort", onAbort, { once: true });
      pending = Promise.resolve().then(() => {
        if (operationSignal.aborted) throw abortReason(operationSignal);
        return operation(operationSignal);
      });
      void pending.catch(() => undefined);
      pending.then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    }
  });
}

export function assertPositiveInteger(value: number, name: string, prefix = "Runtime"): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${prefix} ${name} must be a positive safe integer`);
  }
}

export function abortReasonText(reason: unknown, fallback = "runtime aborted"): string {
  if (isAbortCause(reason)) return abortReasonText(reason.reason, fallback);
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  const object = asObject(reason);
  if (!object) return fallback;
  const kind = typeof object.kind === "string" ? object.kind : "";
  const detail = "reason" in object ? abortReasonText(object.reason, fallback) : "";
  return [kind, detail].filter(Boolean).join(": ") || fallback;
}

export function abortReason(signal: AbortSignal, fallback = "runtime aborted"): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(abortReasonText(signal.reason, fallback));
}

export function abortError(reason: unknown, fallback = "runtime aborted"): Error {
  const error = new Error(abortReasonText(reason, fallback));
  error.name = "AbortError";
  return error;
}

export function asObject(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function record(value: unknown): JsonRecord {
  return asObject(value) ?? {};
}

export function sortedEntries<T>(value: Readonly<Record<string, T>>): [string, T][] {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

export function stringValue(value: unknown): string | undefined;
export function stringValue(value: unknown, fallback: string): string;
export function stringValue(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== "string") return fallback;
  if (fallback === undefined && value.length === 0) return undefined;
  return value;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function errorMessage(
  value: unknown,
  options: { serializeUnknown?: boolean } = {},
): string | undefined {
  if (value instanceof Error) return redactSensitiveText(value.message);
  if (typeof value === "string") return redactSensitiveText(value);
  if (!options.serializeUnknown || value === undefined) return undefined;
  try {
    return redactSensitiveText(JSON.stringify(value) ?? String(value));
  } catch {
    return redactSensitiveText(String(value));
  }
}
