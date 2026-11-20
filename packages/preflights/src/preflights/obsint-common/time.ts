/**
 * UTC time helpers shared by the obsint preflights — the ports of the Python
 * scripts' `datetime.utcnow()` derivations (`weekday()`, `strftime("%G-W%V")`,
 * quarter arithmetic). The Python gates and markers were all computed from
 * UTC, so the ports keep UTC: every helper reads the UTC calendar of the
 * injected `now`, never the local zone.
 */

/** Python `weekday()`: Monday=0 … Sunday=6, on the UTC calendar day. */
export function pythonWeekdayUtc(now: Date): number {
  return (now.getUTCDay() + 6) % 7;
}

/**
 * The ISO year-week key of the UTC calendar date — Python
 * `datetime.utcnow().strftime("%G-W%V")` (e.g. `2026-W47`): ISO year `%G` and
 * zero-padded ISO week `%V`. The Thursday of the date's ISO week decides the
 * ISO year; the week number is that year's ordinal week containing it.
 */
export function isoWeekKeyUtc(now: Date): string {
  const isoDay = now.getUTCDay() || 7; // Monday=1 … Sunday=7
  const thursday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 4 - isoDay),
  );
  const year = thursday.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * The current UTC quarter as `YYYYQn` — the quarterly fixVersion the CVE
 * groomer assigns (Python `(month - 1) // 3 + 1` on the 1-based month).
 */
export function utcQuarter(now: Date): string {
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  return `${now.getUTCFullYear()}Q${quarter}`;
}

const WEEKDAY_NAMES: readonly string[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/** English weekday name for a Monday=0 … Sunday=6 weekday. */
export function weekdayName(day: number): string {
  return WEEKDAY_NAMES[day] ?? "unknown";
}
