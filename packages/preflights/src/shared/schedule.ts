/**
 * Local-time schedule windows — DST-aware "is this instant inside the
 * window" checks for preflights that must only act during a manager's
 * active hours.
 *
 * The wall-clock weekday and time-of-day of an instant are read through
 * `Intl.DateTimeFormat` with an explicit IANA time zone, so daylight
 * saving transitions are handled by the formatter itself: the instant is
 * mapped to the zone's local wall time, whatever the offset happens to be
 * on that date. The window is then a plain wall-clock interval — start
 * inclusive, end exclusive — on the configured weekdays, with no offset
 * arithmetic of our own to drift across DST boundaries.
 */

/** Local weekday, Monday=0 … Sunday=6 (the Python `weekday()` convention). */
export type LocalWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** A wall-clock window: weekdays plus an intraday hour interval, in one zone. */
export interface LocalScheduleWindow {
  /** Local weekdays the window is active on (Monday=0 … Sunday=6). */
  readonly days: readonly LocalWeekday[];
  /** Local hour the window opens, inclusive (0–23). */
  readonly startHour: number;
  /** Local hour the window closes, exclusive (0–23); must be after `startHour`. */
  readonly endHour: number;
  /** IANA time zone the wall clock is read in (e.g. `Europe/Prague`). */
  readonly timeZone: string;
}

const HOUR_MS = 3_600_000;

/** One formatter per time zone; formatters are stateless for `formatToParts`. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** The numeric date-time parts of `now` as wall clock in `timeZone`. */
function zoneParts(
  now: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const record: Record<string, number> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(now)) {
    if (part.type !== "literal") {
      record[part.type] = Number(part.value);
    }
  }
  return {
    year: record.year,
    month: record.month,
    day: record.day,
    hour: record.hour,
    minute: record.minute,
    second: record.second,
  };
}

/** Fail fast on a window a caller could never have meant. */
function validateWindow(window: LocalScheduleWindow): void {
  if (!Array.isArray(window.days) || window.days.length === 0) {
    throw new TypeError("schedule window needs at least one weekday");
  }
  for (const day of window.days) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new RangeError(`weekday must be 0–6 (Monday=0), got: ${day}`);
    }
  }
  const hours: ReadonlyArray<readonly [string, number]> = [
    ["startHour", window.startHour],
    ["endHour", window.endHour],
  ];
  for (const [name, hour] of hours) {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new RangeError(`${name} must be an integer 0–23, got: ${hour}`);
    }
  }
  if (window.startHour >= window.endHour) {
    throw new RangeError(
      `window must not span midnight: startHour ${window.startHour} must be before endHour ${window.endHour}`,
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: window.timeZone });
  } catch {
    throw new RangeError(`invalid IANA time zone: ${JSON.stringify(window.timeZone)}`);
  }
}

/**
 * True when `now` falls inside the window: a configured weekday, at or
 * after `startHour` local, and strictly before `endHour` local. `now` is
 * an explicit parameter (not read from the system clock) so callers and
 * tests inject the instant; the zone's wall clock — including any DST
 * offset in force at that instant — decides day and time.
 */
export function isWithinLocalWindow(now: Date, window: LocalScheduleWindow): boolean {
  validateWindow(window);
  const { year, month, day, hour, minute, second } = zoneParts(now, window.timeZone);
  // Weekday from the local calendar date, not the UTC one — the local day
  // and the UTC day differ around midnight.
  const weekday = ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) as LocalWeekday;
  if (!window.days.includes(weekday)) {
    return false;
  }
  const msOfDay = ((hour * 60 + minute) * 60 + second) * 1000 + now.getMilliseconds();
  return msOfDay >= window.startHour * HOUR_MS && msOfDay < window.endHour * HOUR_MS;
}
