import assert from "node:assert/strict";
import test from "node:test";
import { interruptedRetryDue, isNewer, parseIso } from "../dist/shared/time.js";

// --- parse_iso (ported from bot/tests/test_preflight_shared.py) ---

test("parseIso accepts Jira, GitHub, and task-DB timestamp formats", () => {
  assert.notEqual(parseIso("2026-11-10T08:59:41Z"), null);
  assert.notEqual(parseIso("2026-11-10T08:59:41.053+0000"), null);
  assert.notEqual(parseIso("2026-11-10T08:59:41.053+00:00"), null);
  assert.notEqual(parseIso("2026-11-10T08:59:41"), null);
  assert.notEqual(parseIso("2026-11-10"), null);
  assert.equal(parseIso(""), null);
  assert.equal(parseIso(null), null);
  assert.equal(parseIso(undefined), null);
  assert.equal(parseIso("not a timestamp"), null);
});

test("parseIso assumes UTC for naive values", () => {
  const naive = parseIso("2026-11-10T08:59:41");
  const aware = parseIso("2026-11-10T08:59:41+00:00");
  assert.equal(naive?.getTime(), aware?.getTime());
});

test("parseIso keeps six-digit fractional seconds", () => {
  const parsed = parseIso("2026-11-10T08:59:05.470894+00:00");
  assert.notEqual(parsed, null);
  assert.equal(parsed?.toISOString(), "2026-11-10T08:59:05.470Z");
});

// --- is_newer (ported) ---

test("isNewer counts same-minute differences at full resolution", () => {
  // Regression RHCLOUD-53177: comment 08:59:41 vs last_addressed 08:59:05.
  assert.equal(isNewer("2026-11-10T08:59:41.053+0000", "2026-11-10T08:59:05.470894+00:00"), true);
  assert.equal(isNewer("2026-11-10T08:59:05.470894+00:00", "2026-11-10T08:59:41.053+0000"), false);
});

test("isNewer interoperates across Jira, GitHub, and DB formats", () => {
  assert.equal(isNewer("2026-11-09T14:59:56Z", "2026-11-09T14:59:05+00:00"), true);
  assert.equal(isNewer("2026-11-09T14:59:56Z", "2026-11-09T15:00:05+0000"), false);
});

test("isNewer is false for equal timestamps", () => {
  assert.equal(isNewer("2026-11-10T08:59:41Z", "2026-11-10T08:59:41+00:00"), false);
});

test("isNewer falls back to the legacy minute-prefix comparison when unparseable", () => {
  assert.equal(isNewer("w-2026-11-10T09:00", "w-2026-11-10T08:59"), true);
  assert.equal(isNewer("w-2026-11-10T08:59", "w-2026-11-10T09:00"), false);
  assert.equal(isNewer("w-2026-11-10T09:00", ""), false);
  assert.equal(isNewer("", "w-2026-11-10T09:00"), false);
});

// --- interrupted_retry_due (ported) ---

test("interruptedRetryDue is immediately actionable when never addressed", () => {
  assert.equal(interruptedRetryDue({}), true);
  assert.equal(interruptedRetryDue({ last_addressed: null }), true);
  assert.equal(interruptedRetryDue({ last_addressed: "" }), true);
});

test("interruptedRetryDue waits while the last address is fresh", () => {
  const recent = new Date(Date.now() - 60_000).toISOString();
  assert.equal(interruptedRetryDue({ last_addressed: recent }), false);
});

test("interruptedRetryDue retries after the cooldown elapses", () => {
  const stale = new Date(Date.now() - 45 * 60_000).toISOString();
  assert.equal(interruptedRetryDue({ last_addressed: stale }), true);
});

test("interruptedRetryDue treats the exact 30-minute boundary as due", () => {
  const boundary = new Date(Date.now() - (30 * 60_000 + 5_000)).toISOString();
  assert.equal(interruptedRetryDue({ last_addressed: boundary }), true);
});

test("interruptedRetryDue honors a configured cooldown with an injected clock", () => {
  const now = new Date("2026-11-10T10:00:00Z");
  const task = { last_addressed: "2026-11-10T09:45:00Z" };
  assert.equal(interruptedRetryDue(task, { retryMinutes: 10, now }), true);
  assert.equal(interruptedRetryDue(task, { retryMinutes: 30, now }), false);
  assert.equal(
    interruptedRetryDue(task, { retryMinutes: 60, now: () => new Date("2026-11-10T11:00:00Z") }),
    true,
  );
});
