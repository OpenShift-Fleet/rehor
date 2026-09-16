export const TERMINAL_STATES = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "timed_out",
] as const;

export type TerminalState = (typeof TERMINAL_STATES)[number];

/** Provider-neutral context needed by existing cost, transcript, and status projections. */
export interface TerminalWorkContext {
  taskId?: number;
  externalKey?: string;
  repository?: string;
  workType?: string;
  summary?: string;
}

export interface TerminalEventPayload extends Readonly<Record<string, unknown>> {
  state: TerminalState;
  reason?: string;
  resultText?: string;
  noWork?: boolean;
  turns?: number;
  durationMs?: number;
  context?: TerminalWorkContext;
}

export function isTerminalState(value: unknown): value is TerminalState {
  return typeof value === "string" && TERMINAL_STATES.includes(value as TerminalState);
}
