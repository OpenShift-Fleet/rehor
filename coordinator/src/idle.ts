import { assertFinite, assertNonNegative } from "./utils";

export interface IdleCycleState {
  consecutiveCycles: number;
  lastReminderAtMs: number | null;
}

export interface IdleReminderPolicy {
  /** Zero or negative disables reminders. */
  limit: number;
  cooldownMs: number;
}

export interface IdleCycleDecision {
  state: IdleCycleState;
  shouldSendReminder: boolean;
}

/** Apply one preflight skip using the same threshold/cooldown semantics as Python. */
export function recordIdleCycle(
  state: IdleCycleState,
  policy: IdleReminderPolicy,
  nowMs: number,
): IdleCycleDecision {
  assertFinite(nowMs, "nowMs");
  assertNonNegative(policy.cooldownMs, "cooldownMs");

  const consecutiveCycles = Math.max(0, Math.floor(state.consecutiveCycles)) + 1;
  const thresholdReached = policy.limit > 0 && consecutiveCycles >= policy.limit;
  const cooldownExpired =
    state.lastReminderAtMs === null || nowMs - state.lastReminderAtMs >= policy.cooldownMs;

  return {
    state: { consecutiveCycles, lastReminderAtMs: state.lastReminderAtMs },
    shouldSendReminder: thresholdReached && cooldownExpired,
  };
}

/** Reset idle tracking after preflight finds work. */
export function recordActiveCycle(): IdleCycleState {
  return { consecutiveCycles: 0, lastReminderAtMs: null };
}

/** Store the send time only after the reminder transport confirms success. */
export function recordReminderSent(state: IdleCycleState, sentAtMs: number): IdleCycleState {
  assertFinite(sentAtMs, "sentAtMs");
  return { ...state, lastReminderAtMs: sentAtMs };
}
