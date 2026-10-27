import { type AbortCause, abortCauseFrom, isAbortCause } from "./domain/abort-cause";

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

export function shutdownAbortReason(reason?: unknown): AbortCause {
  return { kind: "shutdown", reason };
}

export interface CombinedAbortSignals {
  readonly signal: AbortSignal;
  readonly cause: AbortCause | undefined;
  readonly aborted: Promise<AbortCause>;
  abort(cause: AbortCause): void;
  dispose(): void;
}

/** Combines cancellation and shutdown inputs while keeping every abort typed. */
export function combineAbortSignals(
  options: { signal?: AbortSignal; shutdownSignal?: AbortSignal } = {},
): CombinedAbortSignals {
  const controller = new AbortController();
  let causeValue: AbortCause | undefined;
  let resolveAborted!: (cause: AbortCause) => void;
  const aborted = new Promise<AbortCause>((resolve) => {
    resolveAborted = resolve;
  });
  const listeners: Array<() => void> = [];

  const abort = (cause: AbortCause): void => {
    if (controller.signal.aborted) return;
    causeValue = cause;
    controller.abort(cause);
    resolveAborted(cause);
  };
  const watch = (
    signal: AbortSignal | undefined,
    toCause: (reason: unknown) => AbortCause,
  ): void => {
    if (!signal) return;
    const onAbort = (): void => abort(toCause(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    listeners.push(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
  };

  watch(options.shutdownSignal, (reason) =>
    isAbortCause(reason) && reason.kind === "shutdown" ? reason : shutdownAbortReason(reason),
  );
  watch(options.signal, (reason) =>
    reason instanceof DOMException && reason.name === "TimeoutError"
      ? { kind: "timed_out", reason }
      : abortCauseFrom(reason, "cancelled"),
  );

  return {
    signal: controller.signal,
    aborted,
    get cause() {
      return causeValue;
    },
    abort,
    dispose() {
      for (const remove of listeners) remove();
      listeners.length = 0;
    },
  };
}

function describeAbortReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (!isRecord(reason)) return String(reason);
  const kind = typeof reason.kind === "string" ? reason.kind : "";
  const detail = reason.reason === undefined ? "" : describeAbortReason(reason.reason);
  return [kind, detail].filter(Boolean).join(": ") || "aborted";
}
