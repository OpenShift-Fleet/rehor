export const ABORT_CAUSE_KINDS = ["shutdown", "cancelled", "timed_out", "failed"] as const;

export type AbortCauseKind = (typeof ABORT_CAUSE_KINDS)[number];

export interface AbortCause {
  kind: AbortCauseKind;
  reason: unknown;
}

export function isAbortCause(value: unknown): value is AbortCause {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    ABORT_CAUSE_KINDS.includes((value as { kind: unknown }).kind as AbortCauseKind) &&
    "reason" in value
  );
}

export function abortCauseFrom(reason: unknown, kind: AbortCauseKind): AbortCause {
  return isAbortCause(reason) ? reason : { kind, reason };
}
