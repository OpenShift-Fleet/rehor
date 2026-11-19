import assert from "node:assert/strict";
import test from "node:test";
import {
  HCC_WEEKLY_REPORT_INPUT,
  runHccWeeklyReport,
} from "../dist/preflights/hcc-weekly-report/index.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";
import { isWithinLocalWindow } from "../dist/shared/schedule.js";

/**
 * Coverage for the weekly-report time gate and the shared DST-aware
 * schedule helper it is built on. The manager is KEDA-scheduled
 * 07:00–21:00 Europe/Prague (effective timezone; the GitOps UTC comment
 * is stale) on Mon–Wed/Fri, and the weekly-report dispatch only acts
 * Monday/Tuesday, so the gate is Mon/Tue 07:00–21:00 Europe/Prague —
 * start inclusive, end exclusive, checked on the Prague wall clock.
 * Fixture-based only: injectable clock, fake memory-server fetch, fake
 * GitHub client; no network.
 */

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fixtureMemoryClient = (tasks) =>
  createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async () => jsonResponse({ items: tasks }),
  });

const fakeGithub = ({ pr = null, comments = [] } = {}) => ({
  route: "https://proxy.example/github",
  getPr: async () => pr,
  getPrComments: async () => comments,
  listMergedPrs: async () => [],
  listRepoFiles: async () => [],
});

const parseParams = (with_) => HCC_WEEKLY_REPORT_INPUT.parse(with_);

const run = (deps, with_) =>
  runHccWeeklyReport(deps, parseParams(with_ ?? { repo: "RedHatInsights/weekly-status" }));

// The weekly-report gate: Monday/Tuesday, 07:00–21:00 Europe/Prague.
const WEEKLY_WINDOW = { days: [0, 1], startHour: 7, endHour: 21, timeZone: "Europe/Prague" };
// A permissive Mon/Tue window to expose the local-day mapping alone.
const ALL_DAY_MON_TUE = { days: [0, 1], startHour: 0, endHour: 23, timeZone: "Europe/Prague" };
// The full KEDA manager window (Mon–Wed/Fri), for helper reuse.
const KEDA_WINDOW = { days: [0, 1, 2, 4], startHour: 7, endHour: 21, timeZone: "Europe/Prague" };

const inWindow = (iso, window = WEEKLY_WINDOW) => isWithinLocalWindow(new Date(iso), window);

// --- helper: DST winter/summer, boundary semantics ---

// January = CET (UTC+1); July = CEST (UTC+2). Same UTC hour, different
// Prague wall clock: 05:00Z is 06:00 in winter (before the window) but
// 07:00 in summer (the inclusive start).
test("the same UTC hour lands outside the window in winter and inside it in summer", () => {
  assert.equal(inWindow("2026-01-05T05:00:00Z"), false); // Monday 06:00 CET
  assert.equal(inWindow("2026-07-06T05:00:00Z"), true); // Monday 07:00 CEST
});

test("the window start is inclusive, the end exclusive — winter (CET)", () => {
  assert.equal(inWindow("2026-01-05T06:00:00.000Z"), true); // 07:00:00.000 exactly
  assert.equal(inWindow("2026-01-05T05:59:59.999Z"), false); // 06:59:59.999
  assert.equal(inWindow("2026-01-05T20:00:00.000Z"), false); // 21:00:00.000 exactly
  assert.equal(inWindow("2026-01-05T19:59:59.999Z"), true); // 20:59:59.999
});

test("the window start is inclusive, the end exclusive — summer (CEST)", () => {
  assert.equal(inWindow("2026-07-06T05:00:00.000Z"), true); // 07:00:00.000 exactly
  assert.equal(inWindow("2026-07-06T04:59:59.999Z"), false); // 06:59:59.999
  assert.equal(inWindow("2026-07-06T19:00:00.000Z"), false); // 21:00:00.000 exactly
  assert.equal(inWindow("2026-07-06T18:59:59.999Z"), true); // 20:59:59.999
});

test("days outside the Monday/Tuesday window are false even in the middle of the day", () => {
  assert.equal(inWindow("2026-07-22T09:00:00Z"), false); // Wednesday 11:00 CEST
  assert.equal(inWindow("2026-07-24T09:00:00Z"), false); // Friday 11:00 CEST
  assert.equal(inWindow("2026-07-19T09:00:00Z"), false); // Sunday 11:00 CEST
});

test("the helper is reusable: the KEDA Mon–Wed/Fri window admits Friday, not Thursday", () => {
  assert.equal(inWindow("2026-07-24T09:00:00Z", KEDA_WINDOW), true); // Friday 11:00
  assert.equal(inWindow("2026-07-23T09:00:00Z", KEDA_WINDOW), false); // Thursday 11:00
});

// --- helper: UTC day vs local day ---

test("the local weekday decides, even when it differs from the UTC weekday", () => {
  // 23:30Z Sunday is Monday 01:30 in Prague: inside an all-day Mon/Tue
  // window on the local day, not the UTC day.
  assert.equal(isWithinLocalWindow(new Date("2026-07-19T23:30:00Z"), ALL_DAY_MON_TUE), true);
  // 22:30Z Tuesday is Wednesday 00:30 in Prague: outside a Mon/Tue window
  // on the local day even though the UTC day is Tuesday.
  assert.equal(isWithinLocalWindow(new Date("2026-07-21T22:30:00Z"), ALL_DAY_MON_TUE), false);
});

// --- helper: validation ---

test("invalid windows are rejected", () => {
  assert.throws(() => inWindow("2026-07-20T09:00:00Z", { ...WEEKLY_WINDOW, timeZone: "Prague" }));
  assert.throws(() => inWindow("2026-07-20T09:00:00Z", { ...WEEKLY_WINDOW, timeZone: "" }));
  assert.throws(() =>
    inWindow("2026-07-20T09:00:00Z", { ...WEEKLY_WINDOW, startHour: 21, endHour: 7 }),
  );
  assert.throws(() =>
    inWindow("2026-07-20T09:00:00Z", { ...WEEKLY_WINDOW, startHour: 7, endHour: 7 }),
  );
  assert.throws(() => inWindow("2026-07-20T09:00:00Z", { ...WEEKLY_WINDOW, startHour: 24 }));
  assert.throws(() => inWindow("2026-07-20T09:00:00Z", { ...WEEKLY_WINDOW, endHour: -1 }));
  assert.throws(() => inWindow("2026-07-20T09:00:00Z", { ...WEEKLY_WINDOW, startHour: 7.5 }));
  assert.throws(() => inWindow("2026-07-20T09:00:00Z", { ...WEEKLY_WINDOW, days: [7] }));
  assert.throws(() => inWindow("2026-07-20T09:00:00Z", { ...WEEKLY_WINDOW, days: [] }));
});

// --- preflight integration ---

// 2026-07-20 Monday, 2026-07-21 Tuesday; that week's Friday is 2026-07-24.
// Winter week: 2026-01-05 Monday, Friday 2026-01-09.
const OPEN_PR = { state: "OPEN", mergeable: "MERGEABLE", reviews: [], statusCheckRollup: [] };

const weeklyTask = (overrides = {}) => ({
  external_key: "weekly-report-2026-07-24",
  status: "in_progress",
  repo: "org/repo",
  metadata: { prs: [{ repo: "org/repo", number: 7, host: "github" }] },
  ...overrides,
});

test("Monday 00:05 UTC skips: 02:05 Prague is before the window", async () => {
  const result = await run({
    memory: fixtureMemoryClient([]),
    github: fakeGithub(),
    now: () => new Date("2026-07-20T00:05:00Z"),
  });
  assert.deepEqual(result, {
    status: "skip",
    content: "Outside the manager active window (Mon/Tue 07:00–21:00 Europe/Prague)",
  });
});

test("a Monday inside the window starts the generate phase", async () => {
  const result = await run({
    memory: fixtureMemoryClient([]),
    github: fakeGithub(),
    now: () => new Date("2026-07-20T09:00:00Z"),
  });
  assert.equal(result.status, "start");
  assert.match(result.content, /## TASK: weekly-report-generate/);
  assert.match(result.content, /- \*\*Task ID\*\*: weekly-report-2026-07-24/);
});

test("a winter Monday at the inclusive start still generates; an hour earlier skips", async () => {
  const deps = () => ({ memory: fixtureMemoryClient([]), github: fakeGithub() });
  // 06:00Z is 07:00 Prague in winter (CET): the inclusive window start.
  const at = await run({ ...deps(), now: () => new Date("2026-01-05T06:00:00Z") });
  assert.equal(at.status, "start");
  assert.match(at.content, /## TASK: weekly-report-generate/);
  assert.match(at.content, /- \*\*Task ID\*\*: weekly-report-2026-01-09/);
  // 05:00Z is only 06:00 Prague in winter: outside the window.
  const before = await run({ ...deps(), now: () => new Date("2026-01-05T05:00:00Z") });
  assert.deepEqual(before, {
    status: "skip",
    content: "Outside the manager active window (Mon/Tue 07:00–21:00 Europe/Prague)",
  });
});

test("a Monday evening past the Prague end of window skips", async () => {
  // 19:00Z is 21:00 Prague in summer (CEST): the exclusive end.
  const result = await run({
    memory: fixtureMemoryClient([]),
    github: fakeGithub(),
    now: () => new Date("2026-07-20T19:00:00Z"),
  });
  assert.deepEqual(result, {
    status: "skip",
    content: "Outside the manager active window (Mon/Tue 07:00–21:00 Europe/Prague)",
  });
});

test("Tuesday inside the window starts the feedback phase on new review feedback", async () => {
  const github = fakeGithub({
    pr: OPEN_PR,
    comments: [{ a: "reviewer", t: "2026-07-21T10:00:00Z", b: "please fix the summary" }],
  });
  const result = await run({
    memory: fixtureMemoryClient([weeklyTask({ last_addressed: "2026-07-21T08:00:00Z" })]),
    github,
    now: () => new Date("2026-07-21T11:00:00Z"),
  });
  assert.equal(result.status, "start");
  assert.match(result.content, /## TASK: weekly-report-feedback/);
});

test("Tuesday inside the window at/after the merge hour starts the merge phase", async () => {
  const github = fakeGithub({
    pr: OPEN_PR,
    comments: [{ a: "reviewer", t: "2026-07-21T10:00:00Z", b: "already handled" }],
  });
  const result = await run({
    memory: fixtureMemoryClient([weeklyTask({ last_addressed: "2026-07-21T12:00:00Z" })]),
    github,
    now: () => new Date("2026-07-21T11:00:00Z"),
  });
  assert.equal(result.status, "start");
  assert.match(result.content, /## TASK: weekly-report-merge/);
});

test("Wednesday inside the hours still skips: not a scheduled day", async () => {
  const result = await run({
    memory: fixtureMemoryClient([weeklyTask()]),
    github: fakeGithub(),
    now: () => new Date("2026-07-22T09:00:00Z"),
  });
  assert.deepEqual(result, { status: "skip", content: "Not a scheduled day" });
});

test("the UTC weekday gate fires even when the Prague day differs", async () => {
  // 23:30Z Sunday is Monday 01:30 Prague: the UTC weekday gate skips it.
  const sundayUtc = await run({
    memory: fixtureMemoryClient([]),
    github: fakeGithub(),
    now: () => new Date("2026-07-19T23:30:00Z"),
  });
  assert.deepEqual(sundayUtc, { status: "skip", content: "Not a scheduled day" });
  // 22:30Z Monday is Tuesday 00:30 Prague: the UTC gate passes, the Prague
  // wall clock does not.
  const mondayUtcLate = await run({
    memory: fixtureMemoryClient([]),
    github: fakeGithub(),
    now: () => new Date("2026-07-20T22:30:00Z"),
  });
  assert.deepEqual(mondayUtcLate, {
    status: "skip",
    content: "Outside the manager active window (Mon/Tue 07:00–21:00 Europe/Prague)",
  });
});
