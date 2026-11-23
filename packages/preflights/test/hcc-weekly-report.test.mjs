import assert from "node:assert/strict";
import test from "node:test";
import {
  HCC_WEEKLY_REPORT_INPUT,
  runHccWeeklyReport,
} from "../dist/preflights/hcc-weekly-report/index.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";

const MONDAY = "2026-07-20T09:00:00Z";
const TUESDAY = "2026-07-21T11:00:00Z";
const REPO = "org/status";
const TASK_ID = "weekly-report-2026-07-24";
const OPEN_PR = { state: "OPEN", mergeable: "MERGEABLE", reviews: [], statusCheckRollup: [] };
const COMMENT = { a: "reviewer", t: "2026-07-21T10:00:00Z", b: "please fix the summary" };
const task = (overrides = {}) => ({
  external_key: TASK_ID,
  status: "in_progress",
  source_type: "scheduled",
  repo: REPO,
  last_addressed: "2026-07-21T08:00:00Z",
  metadata: { prs: [{ repo: REPO, number: 7, host: "github" }] },
  ...overrides,
});

function run({
  tasks = [],
  now = MONDAY,
  params = {},
  pr = OPEN_PR,
  comments = [],
  memoryStatus = 200,
  calls = [],
} = {}) {
  const memory = createMemoryServerClient({
    baseUrl: "http://memory.test",
    fetch: async (url) => {
      if (memoryStatus !== 200) return Response.json({}, { status: memoryStatus });
      const query = new URL(url).searchParams;
      const visible = tasks.filter((item) => item.status !== query.get("exclude_status"));
      const offset = Number(query.get("offset") ?? 0);
      const limit = Number(query.get("limit") ?? 20);
      return Response.json({ items: visible.slice(offset, offset + limit), total: visible.length });
    },
  });
  const github = {
    getPr: async (repo, number) => {
      calls.push(["pr", repo, number]);
      return pr;
    },
    getPrComments: async (repo, number) => {
      calls.push(["comments", repo, number]);
      return comments;
    },
  };
  return runHccWeeklyReport(
    { memory, github, now: () => new Date(now) },
    HCC_WEEKLY_REPORT_INPUT.parse({ repo: REPO, ...params }),
  );
}

function assertPhase(result, phase) {
  assert.equal(result.status, "start");
  assert.ok(result.content.includes(`## TASK: weekly-report-${phase}`));
  assert.ok(result.content.includes(`**Task ID**: ${TASK_ID}`));
}

test("an untracked week generates on Monday, not Tuesday", async () => {
  const generate = await run({
    params: { repo: "alternate/status", branch_pattern: "team-report" },
  });
  assertPhase(generate, "generate");
  assert.match(generate.content, /alternate\/status/);
  assert.match(generate.content, /\{git_user\}\/team-report-2026-07-24/);
  assert.equal((await run({ now: TUESDAY })).status, "skip");
});

test("done, archived, and paused weeks never restart or fetch feedback", async () => {
  for (const status of ["done", "archived", "paused"]) {
    const calls = [];
    const tasks = [task({ status })];
    for (const now of [MONDAY, TUESDAY]) {
      assert.equal((await run({ tasks, now, calls, comments: [COMMENT] })).status, "skip", status);
    }
    assert.deepEqual(calls, [], status);
  }
});

test("an older legacy task gates generation; the canonical task takes precedence", async () => {
  const newer = Array.from({ length: 55 }, (_, i) => ({ external_key: `other-${i}` }));
  const legacy = task({ source_type: "jira" });
  const calls = [];
  const tasks = [...newer, legacy];
  assert.equal((await run({ tasks, now: TUESDAY, calls })).status, "start");
  assert.deepEqual(calls, [
    ["pr", REPO, 7],
    ["comments", REPO, 7],
  ]);
  calls.length = 0;
  tasks.push(task({ status: "done" }));
  assert.equal((await run({ tasks, now: TUESDAY, calls })).status, "skip");
  assert.deepEqual(calls, []);
});

test("an unavailable task lookup fails closed", async () => {
  await assert.rejects(run({ memoryStatus: 500 }), { name: "PreflightHttpError", status: 500 });
});

test("a closed, merged, or missing PR never dispatches feedback or merge", async () => {
  for (const pr of [null, { ...OPEN_PR, state: "MERGED" }, { ...OPEN_PR, state: "CLOSED" }]) {
    const result = await run({ tasks: [task()], pr, now: TUESDAY, comments: [COMMENT] });
    assert.equal(result.status, "skip", pr?.state ?? "missing PR");
  }
});

test("fresh feedback beats merge; addressed feedback permits merge only at the configured hour", async () => {
  const calls = [];
  const feedback = await run({ tasks: [task()], now: TUESDAY, comments: [COMMENT], calls });
  assertPhase(feedback, "feedback");
  assert.ok(feedback.content.includes(COMMENT.b));
  assert.deepEqual(calls, [
    ["pr", REPO, 7],
    ["comments", REPO, 7],
  ]);

  const stale = {
    tasks: [task({ last_addressed: "2026-07-21T10:30:00Z" })],
    now: TUESDAY,
    comments: [COMMENT],
  };
  assert.equal((await run({ ...stale, params: { merge_hour_utc: 12 } })).status, "skip");
  const merge = await run({ ...stale, params: { merge_hour_utc: 11 } });
  assertPhase(merge, "merge");
  assert.ok(merge.content.includes(`${REPO}#7`));
});
