import assert from "node:assert/strict";
import test from "node:test";
import {
  HCC_WEEKLY_REPORT_INPUT,
  runHccWeeklyReport,
} from "../dist/preflights/hcc-weekly-report/index.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";

/**
 * Port of the hcc-framework-agent-dev manager-tasks preflight
 * `01-task-dispatch.py` coverage, adapted to the TS module API: the day
 * schedule, the per-week task lookup (exact key, archived-visible,
 * pagination-independent), and the generate / feedback / merge phases, all
 * driven through an injected clock. Fixture-based only: the memory-server
 * client takes an injectable fetch (backed by a server-simulating double
 * that pages and filters like the live API) and the GitHub client is a
 * fake object, so no test touches the network.
 */

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Realistic memory-server double for `GET /api/tasks`: applies the first
 * `exclude_status` value (the server's behavior), pages by
 * `limit`/`offset`, and reports `total` — so tests exercise the same
 * request flow the live exact-key lookup uses. Records every request URL
 * for paging and query assertions; `status` forces a failing server.
 */
const memoryServer = (tasks, { status = 200 } = {}) => {
  const requests = [];
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async (url) => {
      requests.push(url);
      if (status !== 200) {
        return jsonResponse({ error: "memory server unavailable" }, status);
      }
      const parsed = new URL(url);
      const exclude = parsed.searchParams.get("exclude_status");
      const limit = Number(parsed.searchParams.get("limit") ?? 20);
      const offset = Number(parsed.searchParams.get("offset") ?? 0);
      const visible = exclude === null ? tasks : tasks.filter((task) => task.status !== exclude);
      const items = visible.slice(offset, offset + limit);
      return jsonResponse({ items, total: visible.length, limit, offset });
    },
  });
  return { client, requests };
};

/** Plain server double for tests that don't assert on the requests. */
const fixtureMemoryClient = (tasks) => memoryServer(tasks).client;

/** Fake GitHubClient: one PR shape, one comment list, call recording. */
const fakeGithub = ({ pr = null, comments = [] } = {}) => {
  const calls = { prs: [], comments: [] };
  return {
    calls,
    route: "https://proxy.example/github",
    getPr: async (ownerRepo, number) => {
      calls.prs.push(`${ownerRepo}#${number}`);
      return pr;
    },
    getPrComments: async (ownerRepo, number) => {
      calls.comments.push(`${ownerRepo}#${number}`);
      return comments;
    },
    listMergedPrs: async () => [],
    listRepoFiles: async () => [],
  };
};

const parseParams = (with_) => HCC_WEEKLY_REPORT_INPUT.parse(with_);

// 2026-07-20 is a Monday, 2026-07-21 a Tuesday; that week's Friday is
// 2026-07-24. Wednesday 2026-07-22 and Sunday 2026-07-26 are off-schedule.
const MONDAY = () => new Date("2026-07-20T09:00:00Z");
const TUESDAY = () => new Date("2026-07-21T11:00:00Z");
const FRIDAY_STR = "2026-07-24";
const TASK_ID = `weekly-report-${FRIDAY_STR}`;

const weeklyTask = (overrides = {}) => ({
  external_key: TASK_ID,
  status: "in_progress",
  repo: "org/repo",
  source_type: "scheduled",
  metadata: { prs: [{ repo: "org/repo", number: 7, host: "github" }] },
  ...overrides,
});

const OPEN_PR = {
  state: "OPEN",
  mergeable: "MERGEABLE",
  reviews: [],
  statusCheckRollup: [],
};

const run = (deps, with_) =>
  runHccWeeklyReport(deps, parseParams(with_ ?? { repo: "RedHatInsights/weekly-status" }));

// --- day schedule ---

test("skips on days other than Monday and Tuesday", async () => {
  for (const now of [
    () => new Date("2026-07-22T09:00:00Z"),
    () => new Date("2026-07-26T09:00:00Z"),
  ]) {
    const github = fakeGithub();
    const result = await run(
      { memory: fixtureMemoryClient([weeklyTask()]), github, now },
      { repo: "RedHatInsights/weekly-status" },
    );
    assert.deepEqual(result, { status: "skip", content: "Not a scheduled day" });
    assert.deepEqual(github.calls.prs, []);
  }
});

// --- generate phase (Monday, no task) ---

test("Monday without a task starts the generate phase with the Python content", async () => {
  const result = await run(
    { memory: fixtureMemoryClient([]), github: fakeGithub(), now: MONDAY },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.deepEqual(result, {
    status: "start",
    content:
      "## TASK: weekly-report-generate\n\n" +
      `Generate HCC weekly status reports for week ending ${FRIDAY_STR}.\n\n` +
      "- **Task ID**: weekly-report-2026-07-24\n" +
      "- **Task status**: new\n" +
      "- **Scope**: hcc-team all (all HCC sub-teams)\n" +
      "- **Repo**: RedHatInsights/weekly-status\n" +
      "- **Branch**: {git_user}/hcc-team-weekly-report-2026-07-24\n" +
      "- **Friday date**: 2026-07-24\n",
  });
});

test("the generate content carries the configured repo and branch pattern", async () => {
  const result = await run(
    { memory: fixtureMemoryClient([]), github: fakeGithub(), now: MONDAY },
    { repo: "MyOrg/status", branch_pattern: "team-report" },
  );
  assert.equal(result.status, "start");
  assert.match(result.content, /- \*\*Repo\*\*: MyOrg\/status\n/);
  assert.match(result.content, /- \*\*Branch\*\*: \{git_user\}\/team-report-2026-07-24\n/);
});

test("Tuesday without a task skips", async () => {
  const result = await run(
    { memory: fixtureMemoryClient([]), github: fakeGithub(), now: TUESDAY },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: `Tuesday but no task found for ${FRIDAY_STR}`,
  });
});

// --- existing task states ---

test("a done task skips", async () => {
  const result = await run(
    {
      memory: fixtureMemoryClient([weeklyTask({ status: "done" })]),
      github: fakeGithub(),
      now: MONDAY,
    },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: `Task ${TASK_ID} already done`,
  });
});

// --- exact-key lookup: archived, pagination, sources, fail-closed ---

test("an archived weekly task is found and never restarts generation", async () => {
  // The listing lookup the Python script used excludes archived tasks;
  // an archived week task must still gate the week (the exact-key
  // lookup sees it) instead of re-entering the generate phase.
  const { client, requests } = memoryServer([weeklyTask({ status: "archived" })]);
  const github = fakeGithub();
  const result = await run(
    { memory: client, github, now: MONDAY },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: `Task ${TASK_ID} already archived`,
  });
  assert.deepEqual(github.calls.prs, []);
  // The lookup must not ask the server to hide archived tasks.
  assert.ok(requests.length > 0);
  assert.ok(requests.every((url) => !url.includes("exclude_status")));
});

test("a weekly task beyond the newest 50 is found through offset paging", async () => {
  // 60 tasks with the week's task at index 55 — past the newest-50
  // window a plain listing caps at. The old lookup would have missed it
  // and re-started the generate phase on Monday.
  const tasks = Array.from({ length: 60 }, (_, i) => ({
    external_key: `other-task-${i}`,
    status: "in_progress",
  }));
  tasks[55] = weeklyTask({ metadata: {} });
  const { client, requests } = memoryServer(tasks);
  const github = fakeGithub();
  const result = await run(
    { memory: client, github, now: MONDAY },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: `Task ${TASK_ID} [in_progress], no action needed`,
  });
  assert.deepEqual(github.calls.prs, []);
  const offsets = requests.map((url) => new URL(url).searchParams.get("offset"));
  assert.ok(offsets.includes("50"), `expected a second page request, got: ${requests.join(" ")}`);
});

test("the canonical scheduled-source task wins over a same-key legacy task", async () => {
  const tasks = [
    weeklyTask({ source_type: "jira", metadata: {} }),
    weeklyTask({ source_type: "scheduled", status: "done", metadata: {} }),
  ];
  const result = await run(
    { memory: fixtureMemoryClient(tasks), github: fakeGithub(), now: MONDAY },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: `Task ${TASK_ID} already done`,
  });
});

test("a legacy task created with the task_add default source still gates the week", async () => {
  const github = fakeGithub();
  const result = await run(
    {
      memory: fixtureMemoryClient([weeklyTask({ source_type: "jira", metadata: {} })]),
      github,
      now: MONDAY,
    },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: `Task ${TASK_ID} [in_progress], no action needed`,
  });
  assert.deepEqual(github.calls.prs, []);
});

test("a task-lookup failure errors the cycle instead of reading as no task", async () => {
  // Fail closed: an unreachable answer must never become a Monday
  // generate start for a week whose task may already exist.
  const github = fakeGithub();
  await assert.rejects(
    run(
      { memory: memoryServer([weeklyTask()], { status: 500 }).client, github, now: MONDAY },
      { repo: "RedHatInsights/weekly-status" },
    ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "PreflightHttpError");
      return true;
    },
  );
  assert.deepEqual(github.calls.prs, []);
});

test("a paused task does not trigger feedback or merge without an explicit unpause", async () => {
  // Tuesday past the merge hour with fresh PR feedback — the exact
  // situation that would otherwise start a phase — but the task is
  // parked; only an unpause reopens dispatch.
  const github = fakeGithub({
    pr: OPEN_PR,
    comments: [{ a: "reviewer", t: "2026-07-21T10:00:00Z", b: "please fix the summary" }],
  });
  const result = await run(
    {
      memory: fixtureMemoryClient([
        weeklyTask({ status: "paused", last_addressed: "2026-07-21T08:00:00Z" }),
      ]),
      github,
      now: TUESDAY,
    },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: `Task ${TASK_ID} is paused — explicit unpause required before further dispatch`,
  });
  assert.deepEqual(github.calls.prs, []);
  assert.deepEqual(github.calls.comments, []);
});

test("a merged PR skips", async () => {
  const github = fakeGithub({ pr: { ...OPEN_PR, state: "MERGED" } });
  const result = await run(
    { memory: fixtureMemoryClient([weeklyTask()]), github, now: MONDAY },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: `PR already merged for ${TASK_ID}`,
  });
  assert.deepEqual(github.calls.prs, ["org/repo#7"]);
});

test("a closed PR skips", async () => {
  const github = fakeGithub({ pr: { ...OPEN_PR, state: "CLOSED" } });
  const result = await run(
    { memory: fixtureMemoryClient([weeklyTask()]), github, now: MONDAY },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: `PR closed for ${TASK_ID}`,
  });
});

test("a task without fetchable PRs skips with the no-action reason", async () => {
  const result = await run(
    {
      memory: fixtureMemoryClient([weeklyTask({ metadata: {} })]),
      github: fakeGithub(),
      now: TUESDAY,
    },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: `Task ${TASK_ID} [in_progress], no action needed`,
  });
});

// --- feedback phase ---

test("new review feedback after last_addressed starts the feedback phase", async () => {
  const github = fakeGithub({
    pr: OPEN_PR,
    comments: [{ a: "reviewer", t: "2026-07-21T10:00:00Z", b: "please fix the summary" }],
  });
  const result = await run(
    {
      memory: fixtureMemoryClient([weeklyTask({ last_addressed: "2026-07-21T08:00:00Z" })]),
      github,
      now: TUESDAY,
    },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.deepEqual(result, {
    status: "start",
    content:
      "## TASK: weekly-report-feedback\n\n" +
      "Address review feedback on the weekly report PR.\n\n" +
      "- **Task ID**: weekly-report-2026-07-24\n" +
      "- **Task status**: in_progress\n" +
      "- **Friday date**: 2026-07-24\n\n" +
      "### PR Details\n\n" +
      "weekly-report-2026-07-24 [in_progress] org/repo\n" +
      "  last_addressed: 2026-07-21T08:00:00Z\n" +
      "  PR org/repo#7 [clean]\n" +
      "  review_comments (1, newest first):\n" +
      "    [2026-07-21T10:00] reviewer:\n" +
      "      please fix the summary\n",
  });
  assert.deepEqual(github.calls.prs, ["org/repo#7"]);
  assert.deepEqual(github.calls.comments, ["org/repo#7"]);
});

test("feedback beats the merge window", async () => {
  // Tuesday past the merge hour, but new feedback wins (Python order).
  const github = fakeGithub({
    pr: OPEN_PR,
    comments: [{ a: "reviewer", t: "2026-07-21T10:30:00Z", b: "one more thing" }],
  });
  const result = await run(
    {
      memory: fixtureMemoryClient([weeklyTask({ last_addressed: "2026-07-21T10:00:00Z" })]),
      github,
      now: TUESDAY,
    },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.equal(result.status, "start");
  assert.match(result.content, /## TASK: weekly-report-feedback/);
});

// --- merge phase ---

test("Tuesday at or after the merge hour starts the merge phase", async () => {
  const github = fakeGithub({
    pr: OPEN_PR,
    comments: [{ a: "reviewer", t: "2026-07-21T10:00:00Z", b: "already handled" }],
  });
  const result = await run(
    {
      memory: fixtureMemoryClient([weeklyTask({ last_addressed: "2026-07-21T12:00:00Z" })]),
      github,
      now: () => new Date("2026-07-21T11:00:00Z"),
    },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.deepEqual(result, {
    status: "start",
    content:
      "## TASK: weekly-report-merge\n\n" +
      "Merge the weekly report PR — no blocking reviews.\n\n" +
      "- **Task ID**: weekly-report-2026-07-24\n" +
      "- **Task status**: in_progress\n" +
      "- **PR**: org/repo#7\n" +
      "- **Friday date**: 2026-07-24\n",
  });
});

test("Tuesday before the merge hour skips with the no-action reason", async () => {
  const github = fakeGithub({ pr: OPEN_PR, comments: [] });
  const result = await run(
    {
      memory: fixtureMemoryClient([weeklyTask({ last_addressed: "2026-07-21T08:00:00Z" })]),
      github,
      now: () => new Date("2026-07-21T09:00:00Z"),
    },
    { repo: "RedHatInsights/weekly-status" },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: `Task ${TASK_ID} [in_progress], no action needed`,
  });
});

test("a custom merge_hour_utc moves the merge window", async () => {
  const github = fakeGithub({ pr: OPEN_PR, comments: [] });
  const deps = {
    memory: fixtureMemoryClient([weeklyTask({ last_addressed: "2026-07-21T08:00:00Z" })]),
    github,
    now: () => new Date("2026-07-21T09:00:00Z"),
  };
  const before = await run(deps, { repo: "RedHatInsights/weekly-status", merge_hour_utc: 10 });
  assert.equal(before.status, "skip");
  const at = await run(deps, { repo: "RedHatInsights/weekly-status", merge_hour_utc: 9 });
  assert.equal(at.status, "start");
  assert.match(at.content, /## TASK: weekly-report-merge/);
});
