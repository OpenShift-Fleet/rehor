/**
 * ISO-8601 timestamp handling — the port of the Python `parse_iso`,
 * `is_newer`, and `interrupted_retry_due` helpers.
 *
 * Accepts `Z` suffixes, compact `+0000` offsets, and naive values (assumed
 * UTC, like the Python helper's `replace(tzinfo=UTC)`), from Jira, GitHub,
 * GitLab, and the task DB. Returns null when empty or unparseable.
 */

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;
const TIMEZONE_SUFFIX = /(?:Z|[+-]\d{2}:\d{2}|[+-]\d{4})$/;
const COMPACT_OFFSET = /^(.*\d{2}:\d{2}:\d{2})([+-]\d{4})$/;

export function parseIso(ts: unknown): Date | null {
  if (!ts) return null;
  const text = String(ts).trim();
  if (text === "") return null;
  const primary = text.endsWith("Z") ? `${text.slice(0, -1)}+00:00` : text;
  let parsed = parseIsoCandidate(primary);
  if (parsed === null) {
    const match = COMPACT_OFFSET.exec(text);
    if (match === null) return null;
    parsed = parseIsoCandidate(`${match[1]}${match[2].slice(0, 3)}:${match[2].slice(3)}`);
    if (parsed === null) return null;
  }
  return parsed;
}

function parseIsoCandidate(text: string): Date | null {
  if (!DATE_PREFIX.test(text)) return null;
  const withZone = TIMEZONE_SUFFIX.test(text)
    ? text
    : text.length === 10
      ? `${text}T00:00:00Z`
      : `${text}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * True when `ts` is strictly newer than `reference`, at full resolution.
 * Falls back to the legacy minute-prefix string comparison when either value
 * cannot be parsed, so unknown formats behave as before.
 */
export function isNewer(ts: unknown, reference: unknown): boolean {
  const a = parseIso(ts);
  const b = parseIso(reference);
  if (a === null || b === null) {
    return (
      Boolean(ts) && Boolean(reference) && String(ts).slice(0, 16) > String(reference).slice(0, 16)
    );
  }
  return a.getTime() > b.getTime();
}

export interface InterruptedRetryOptions {
  /** Cooldown in minutes; defaults to 30 (the Python default). */
  readonly retryMinutes?: number;
  /** Injected clock for deterministic tests. */
  readonly now?: Date | (() => Date);
}

/**
 * True when a blocked interrupted task may be (re)tried. Cycles that end
 * cleanly stamp `last_addressed`; when the agent also declared blockers, the
 * task waits on external input and re-triggers only after the cooldown.
 * Never-addressed tasks and crashed cycles stay immediately actionable.
 */
export function interruptedRetryDue(
  task: { readonly last_addressed?: unknown },
  options: InterruptedRetryOptions = {},
): boolean {
  const retryMinutes = options.retryMinutes ?? 30;
  const lastAddressed = parseIso(task?.last_addressed);
  if (lastAddressed === null) return true;
  const now = typeof options.now === "function" ? options.now() : (options.now ?? new Date());
  return now.getTime() - lastAddressed.getTime() >= retryMinutes * 60_000;
}
