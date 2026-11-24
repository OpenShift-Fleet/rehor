import type { TerminalEventPayload } from "./terminal-state";

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

/** Narrows kind only; payload shape is enforced by parseRehorEvent's schema. */
export function assertTerminalEvent(event: RehorEvent): asserts event is RehorTerminalEvent {
  if (event.kind !== "terminal") throw new RuntimeContractError("event.kind must be terminal");
}

export class RuntimeContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeContractError";
  }
}
