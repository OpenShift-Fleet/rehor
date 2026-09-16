import { isTerminalState, type TerminalEventPayload } from "./terminal-state";
import { TOKEN_CLASSES, type Usage } from "./usage";

export const REHOR_EVENT_KINDS = [
  "run",
  "agent",
  "model",
  "tool",
  "policy",
  "checkpoint",
  "cancellation",
  "usage",
  "persistence",
  "runtime-exit",
  "terminal",
] as const;

export type KnownRehorEventKind = (typeof REHOR_EVENT_KINDS)[number];

/**
 * Event kinds stay open for forward compatibility. Known kinds remain available
 * as `KnownRehorEventKind` when a consumer needs a closed set.
 */
export type RehorEventKind = string;

export interface RawEventReference {
  reference: string;
  redacted: true;
}

export interface RehorEvent {
  schemaVersion: "1";
  eventId: string;
  runId: string;
  attemptId: string;
  sequence: number;
  occurredAt: string;
  kind: RehorEventKind;
  /** Opaque Rehor reference; provider SDK session IDs stay inside adapters. */
  runtimeSessionRef?: string;
  parentEventId?: string;
  workspace: {
    worktreePath: string;
    repository: string;
    snapshot: string;
  };
  provider: string;
  model: string;
  policyVersion: string;
  payload: Readonly<Record<string, unknown>>;
  rawEventRef?: RawEventReference;
}

export interface RehorTerminalEvent extends RehorEvent {
  kind: "terminal";
  payload: TerminalEventPayload;
}

export function assertTerminalPayload(
  payload: Readonly<Record<string, unknown>>,
): asserts payload is TerminalEventPayload {
  if (!isTerminalState(payload.state)) {
    throw new RuntimeContractError("event.payload.state must be a terminal state");
  }
  for (const key of ["reason", "resultText"] as const) {
    if (payload[key] !== undefined && typeof payload[key] !== "string") {
      throw new RuntimeContractError(`event.payload.${key} must be a string`);
    }
  }
  if (payload.noWork !== undefined && typeof payload.noWork !== "boolean") {
    throw new RuntimeContractError("event.payload.noWork must be a boolean");
  }
  for (const key of ["turns", "durationMs"] as const) {
    if (
      payload[key] !== undefined &&
      (!Number.isSafeInteger(payload[key]) || (payload[key] as number) < 0)
    ) {
      throw new RuntimeContractError(`event.payload.${key} must be a non-negative safe integer`);
    }
  }
  if (
    payload.context !== undefined &&
    (typeof payload.context !== "object" || payload.context === null)
  ) {
    throw new RuntimeContractError("event.payload.context must be an object");
  }
}

export function assertUsagePayload(
  payload: Readonly<Record<string, unknown>>,
): asserts payload is Usage {
  if (typeof payload.requestedModel !== "string" || payload.requestedModel.length === 0) {
    throw new RuntimeContractError("event.payload.requestedModel must be a non-empty string");
  }
  for (const key of ["partial", "final", "estimated", "incomplete"] as const) {
    if (typeof payload[key] !== "boolean") {
      throw new RuntimeContractError(`event.payload.${key} must be a boolean`);
    }
  }
  if (
    payload.returnedModel !== undefined &&
    (typeof payload.returnedModel !== "string" || payload.returnedModel.length === 0)
  ) {
    throw new RuntimeContractError("event.payload.returnedModel must be a non-empty string");
  }
  if (
    typeof payload.tokenCounts !== "object" ||
    payload.tokenCounts === null ||
    Array.isArray(payload.tokenCounts)
  ) {
    throw new RuntimeContractError("event.payload.tokenCounts must be an object");
  }
  const tokenCounts = payload.tokenCounts as Record<string, unknown>;
  for (const [tokenClass, count] of Object.entries(tokenCounts)) {
    if (!(TOKEN_CLASSES as readonly string[]).includes(tokenClass)) {
      throw new RuntimeContractError(`event.payload.tokenCounts.${tokenClass} is not supported`);
    }
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new RuntimeContractError(
        `event.payload.tokenCounts.${tokenClass} must be a non-negative safe integer`,
      );
    }
  }
  if (payload.cost !== undefined) {
    if (typeof payload.cost !== "object" || payload.cost === null || Array.isArray(payload.cost)) {
      throw new RuntimeContractError("event.payload.cost must be an object");
    }
    const cost = payload.cost as Record<string, unknown>;
    if (typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount < 0) {
      throw new RuntimeContractError("event.payload.cost.amount must be a non-negative number");
    }
    if (typeof cost.currency !== "string" || cost.currency.length === 0) {
      throw new RuntimeContractError("event.payload.cost.currency must be a non-empty string");
    }
    if (!(cost.source === "provider" || cost.source === "estimated" || cost.source === "unknown")) {
      throw new RuntimeContractError("event.payload.cost.source is not supported");
    }
  }
}

export function assertTerminalEvent(event: RehorEvent): asserts event is RehorTerminalEvent {
  if (event.kind !== "terminal") throw new RuntimeContractError("event.kind must be terminal");
  assertTerminalPayload(event.payload);
}

export class RuntimeContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeContractError";
  }
}
