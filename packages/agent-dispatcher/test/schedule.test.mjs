import test from "node:test";
import assert from "node:assert/strict";
import { isScheduleActive, scheduleDiagnostics } from "../dist/schedule.js";

const weekday = { timezone: "Europe/Prague", start: "0 8 * * 1-5", end: "0 18 * * 1-5" };
const overnight = { timezone: "Europe/Prague", start: "0 22 * * *", end: "0 6 * * *" };
// 2026-11-23 is a Monday, 2026-11-29 a Sunday; Europe/Prague is UTC+1 in November.
const active = (triggers, iso) => isScheduleActive(triggers, new Date(iso));

test("weekday window is active inside working hours only", () => {
  assert.equal(active([weekday], "2026-11-23T06:59:59.999Z"), false); // 07:59:59.999 Monday, before start
  assert.equal(active([weekday], "2026-11-23T09:00:00Z"), true); // 10:00 Monday
  assert.equal(active([weekday], "2026-11-23T16:59:59.999Z"), true); // 17:59:59.999 Monday
  assert.equal(active([weekday], "2026-11-23T17:00:00Z"), false); // 18:00 Monday, at end
  assert.equal(active([weekday], "2026-11-27T16:59:00Z"), true); // Friday 17:59
  assert.equal(active([weekday], "2026-11-27T17:00:00Z"), false); // Friday 18:00, at end
  assert.equal(active([weekday], "2026-11-28T09:00:00Z"), false); // Saturday
  assert.equal(active([weekday], "2026-11-29T09:00:00Z"), false); // Sunday
});

test("overnight window wraps midnight", () => {
  assert.equal(active([overnight], "2026-11-23T20:59:59.999Z"), false); // 21:59:59.999, before start
  assert.equal(active([overnight], "2026-11-23T21:00:00Z"), true); // 22:00, at start
  assert.equal(active([overnight], "2026-11-23T22:00:00Z"), true); // 23:00
  assert.equal(active([overnight], "2026-11-24T04:00:00Z"), true); // 05:00, still inside
  assert.equal(active([overnight], "2026-11-24T05:00:00Z"), false); // 06:00, at end
  assert.equal(active([overnight], "2026-11-23T11:00:00Z"), false); // 12:00, midday
});

test("start is inclusive and end is exclusive", () => {
  assert.equal(active([weekday], "2026-11-23T07:00:00.000Z"), true); // exactly 08:00 start
  assert.equal(active([weekday], "2026-11-23T17:00:00.000Z"), false); // exactly 18:00 end
});

test("multiple triggers OR together", () => {
  const weekend = { timezone: "Europe/Prague", start: "0 8 * * 6-7", end: "0 18 * * 6-7" };
  assert.equal(active([weekday, weekend], "2026-11-29T09:00:00Z"), true); // Sunday via the weekend window
  assert.equal(active([weekday, weekend], "2026-11-29T17:00:00Z"), false); // Sunday 18:00, neither window
  assert.equal(active([weekend, weekday], "2026-11-23T09:00:00Z"), true); // Monday via the weekday window
});

test("windows evaluate across the daylight-saving transition", () => {
  // Europe/Prague falls back from CEST to CET at 2026-10-25 03:00 local
  // (01:00 UTC); the repeated 02:00–03:00 wall hour must not break windows.
  const allDay = { timezone: "Europe/Prague", start: "0 0 * * *", end: "0 23 * * *" };
  assert.equal(active([allDay], "2026-10-25T01:00:00.000Z"), true); // the transition instant itself
  assert.equal(active([allDay], "2026-10-24T22:30:00Z"), true); // 00:30 CEST, at start
  assert.equal(active([allDay], "2026-10-25T22:00:00.000Z"), false); // 23:00 CET, at end
  // An overnight window opened Saturday evening closes at 06:00 CET.
  assert.equal(active([overnight], "2026-10-25T01:00:00.000Z"), true); // 02:00 CET after the fallback
  assert.equal(active([overnight], "2026-10-25T04:59:59.999Z"), true); // 05:59:59.999 CET
  assert.equal(active([overnight], "2026-10-25T05:00:00.000Z"), false); // 06:00 CET, at end
});

test("schedule diagnostics accept a well-formed declaration", () => {
  assert.deepEqual(scheduleDiagnostics({ triggers: [weekday, overnight] }), []);
});

test("schedule diagnostics reject malformed declarations with every issue", () => {
  const cases = [
    [7, [{ path: "schedule", code: "invalid_type", message: "Invalid input: expected object with a triggers list", received: "7" }]],
    [null, [{ path: "schedule", code: "invalid_type", message: "Invalid input: expected object with a triggers list", received: "null" }]],
    [{}, [{ path: "schedule.triggers", code: "invalid_type", message: "Invalid input: expected a non-empty list of triggers", received: "undefined" }]],
    [{ triggers: [] }, [{ path: "schedule.triggers", code: "too_small", message: "Too small: expected array to have >=1 items", received: "array (0 items)" }]],
    [{ triggers: 7 }, [{ path: "schedule.triggers", code: "invalid_type", message: "Invalid input: expected a non-empty list of triggers", received: "7" }]],
    [{ triggers: [42] }, [{ path: "schedule.triggers[0]", code: "invalid_type", message: "Invalid input: expected object with timezone, start, and end", received: "42" }]],
    [{ desiredReplicas: 1, triggers: [weekday] }, [{ path: "schedule", code: "unrecognized_keys", message: 'Unrecognized key: "desiredReplicas"', received: "1" }]],
    [{ triggers: [{ ...weekday, desiredReplicas: 1 }] }, [{ path: "schedule.triggers[0]", code: "unrecognized_keys", message: 'Unrecognized key: "desiredReplicas"', received: "1" }]],
    [{ triggers: [{ timezone: 5, start: "0 8 * * *", end: "0 18 * * *" }] }, [{ path: "schedule.triggers[0].timezone", code: "invalid_type", message: "Invalid input: expected string, received number", received: "5" }]],
    [{ triggers: [{ timezone: "Europe/Prague", start: "0 8 * * *", end: "0 8 * * *" }] }, [{ path: "schedule.triggers[0]", code: "custom", message: "Invalid input: start and end must differ", received: '"0 8 * * *"' }]],
    [{ triggers: [{ timezone: "Not/AZone", start: "0 8 * * *", end: "0 18 * * *" }] }, [{ path: "schedule.triggers[0].timezone", code: "custom", message: "Invalid timezone", received: '"Not/AZone"' }]],
    [{ triggers: [{ timezone: "Europe/Prague", start: "61 8 * * *", end: "0 18 * * *" }] }, [{ path: "schedule.triggers[0].start", code: "custom", message: "Invalid cron expression: Constraint error, got value 61 expected range 0-59", received: '"61 8 * * *"' }]],
    [{ triggers: [{ timezone: "Europe/Prague", start: "* * * * * *", end: "0 18 * * *" }] }, [{ path: "schedule.triggers[0].start", code: "custom", message: "Invalid cron expression: expected five fields", received: '"* * * * * *"' }]],
    [{ triggers: [{ timezone: "Europe/Prague", start: "0 8 * *", end: "0 18 * * *" }] }, [{ path: "schedule.triggers[0].start", code: "custom", message: "Invalid cron expression: expected five fields", received: '"0 8 * *"' }]],
    [{ triggers: [{ timezone: "Europe/Prague", start: "", end: "0 18 * * *" }] }, [{ path: "schedule.triggers[0].start", code: "custom", message: "Invalid cron expression: expected five fields", received: '""' }]],
    [{ triggers: [{ timezone: "Europe/Prague", start: "0 0 31 2 *", end: "0 18 * * *" }] }, [{ path: "schedule.triggers[0].start", code: "custom", message: "Invalid cron expression: Invalid explicit day of month definition", received: '"0 0 31 2 *"' }]],
    [{ triggers: [{}] }, [
      { path: "schedule.triggers[0].timezone", code: "invalid_type", message: "Invalid input: expected string, received undefined", received: "undefined" },
      { path: "schedule.triggers[0].start", code: "invalid_type", message: "Invalid input: expected string, received undefined", received: "undefined" },
      { path: "schedule.triggers[0].end", code: "invalid_type", message: "Invalid input: expected string, received undefined", received: "undefined" },
    ]],
  ];
  for (const [value, diagnostics] of cases) {
    assert.deepEqual(scheduleDiagnostics(value), diagnostics, JSON.stringify(value));
  }
});

test("a rejected timezone still reports an invalid cron expression on the same trigger", () => {
  assert.deepEqual(scheduleDiagnostics({ triggers: [{ timezone: "Not/AZone", start: "61 8 * * *", end: "0 18 * * *" }] }), [
    { path: "schedule.triggers[0].timezone", code: "custom", message: "Invalid timezone", received: '"Not/AZone"' },
    { path: "schedule.triggers[0].start", code: "custom", message: "Invalid cron expression: Constraint error, got value 61 expected range 0-59", received: '"61 8 * * *"' },
  ]);
});
