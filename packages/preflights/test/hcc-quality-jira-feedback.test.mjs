import assert from "node:assert/strict";
import test from "node:test";
import { createPreflightRunContext } from "../dist/index.js";
import {
  HCC_QUALITY_JIRA_FEEDBACK_INPUT,
  runHccQualityJiraFeedback,
} from "../dist/preflights/hcc-quality-jira-feedback/index.js";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import { createJiraClient } from "../dist/shared/jira.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";
import { createRunState } from "../dist/shared/run-context.js";
import { createJiraFetch, jsonResponse } from "./jira-fixtures.mjs";

const NOW = "2026-11-16T10:00:00Z";
const TASK_ID = "merge-violation:my-repo:123";
const ISSUE = "RHCLOUD-999";
const LAST_ADDRESSED = "2026-11-14T12:00:00";
const REPOS = { "my-repo": { upstream: "https://github.com/org/my-repo.git" } };
const HUMAN = {
  created: "2026-11-16T09:00:00",
  body: "Please re-check the flaky login test",
  author: { displayName: "Jana Nováková" },
};
const task = (overrides = {}) => ({
  status: "in_progress",
  external_key: TASK_ID,
  repo: "my-repo",
  instance_id: "quality",
  last_addressed: LAST_ADDRESSED,
  metadata: { jira_key: ISSUE },
  ...overrides,
});
const legacy = (overrides = {}) => task({ instance_id: undefined, ...overrides });
const issue = (comments = [HUMAN]) => ({
  fields: { status: { name: "In Progress" }, labels: [], issuelinks: [] },
  comments,
});
const issuePaths = (key) => [
  `/jira/rest/api/2/issue/${key}`,
  `/jira/rest/api/2/issue/${key}/comment`,
];

function setup({
  tasks = [task()],
  issues = { [ISSUE]: issue() },
  memoryStatus,
  jiraStatus,
  repos = REPOS,
} = {}) {
  const calls = { memory: [], jira: [] };
  const memory = createMemoryServerClient({
    baseUrl: "http://memory.test",
    instanceId: "quality",
    fetch: async (url) => {
      calls.memory.push(url);
      if (memoryStatus) return jsonResponse({}, memoryStatus);
      const query = new URL(url).searchParams;
      const status = query.get("status");
      const bucket = status ? tasks.filter((item) => item.status === status) : tasks;
      const offset = Number(query.get("offset") ?? 0);
      const limit = Number(query.get("limit") ?? 20);
      return jsonResponse({ items: bucket.slice(offset, offset + limit), total: bucket.length });
    },
  });
  const jiraFetch = createJiraFetch({ issues });
  const jira = createJiraClient({
    baseUrl: "https://proxy.test",
    fetch: async (url, init) => {
      calls.jira.push(new URL(url).pathname);
      return jiraStatus ? jsonResponse({}, jiraStatus) : jiraFetch(url, init);
    },
  });
  const state = createRunState();
  return {
    calls,
    state,
    run: (now = NOW) =>
      runHccQualityJiraFeedback(
        { memory, jira, state, repos, now: () => new Date(now) },
        HCC_QUALITY_JIRA_FEEDBACK_INPUT.parse({}),
      ),
  };
}

test("registered feedback reports an error without Jira wiring", async () => {
  const preflight = createPopulatedRegistry().get("hcc-quality-jira-feedback");
  const ctx = createPreflightRunContext({
    instanceId: "quality",
    memory: { baseUrl: "http://memory.test", fetch: async () => jsonResponse({ items: [] }) },
  });
  assert.equal((await preflight.run(ctx, preflight.input.parse({}))).status, "error");
});

test("feedback only fetches during the Prague quality window", async () => {
  const { run, calls } = setup();
  for (const now of ["2026-11-21T10:00:00Z", "2026-11-16T07:30:00Z", "2026-11-16T22:00:00Z"]) {
    assert.equal((await run(now)).status, "skip", now);
  }
  assert.deepEqual(calls, { memory: [], jira: [] });
  assert.equal((await run("2026-07-20T07:30:00Z")).status, "start");
});

test("fresh Jira feedback resumes the same task; retry after addressing it skips", async () => {
  const addressed = task();
  const { run, calls, state } = setup({ tasks: [addressed] });
  const fresh = await run();
  assert.equal(fresh.status, "start");
  for (const field of [
    `Task ID: ${TASK_ID}`,
    `Jira key: ${ISSUE}`,
    HUMAN.body,
    "task_update",
    "last_addressed",
  ]) {
    assert.ok(fresh.content.includes(field), field);
  }
  assert.deepEqual(calls.jira, issuePaths(ISSUE));
  assert.equal(state.get("has_actionable"), true);

  const retry = setup({ tasks: [{ ...addressed, last_addressed: HUMAN.created }] });
  assert.equal((await retry.run()).status, "skip");
  assert.deepEqual(retry.calls.jira, issuePaths(ISSUE));
  assert.equal(retry.state.get("has_actionable"), false);
  retry.state.set("has_actionable", true);
  await retry.run();
  assert.equal(retry.state.get("has_actionable"), true);
});

test("old comments, automation markers, and obvious bot authors do not restart tasks", async () => {
  const comments = [
    { ...HUMAN, created: "2026-11-13T09:00:00" },
    { ...HUMAN, body: "### Cycle status" },
    { ...HUMAN, body: "PR: merged" },
    { ...HUMAN, body: "CI passed", author: { displayName: "ci-bot" } },
  ];
  const { run, calls } = setup({ issues: { [ISSUE]: issue(comments) } });
  assert.equal((await run()).status, "skip");
  assert.deepEqual(calls.jira, issuePaths(ISSUE));
  const neverAddressed = setup({ tasks: [task({ last_addressed: undefined })] });
  assert.equal((await neverAddressed.run()).status, "skip");
});

test("paged older active work still resumes; inactive and non-quality work is not fetched", async () => {
  const newer = Array.from({ length: 55 }, (_, i) => task({ external_key: `RHCLOUD-${i}` }));
  const tasks = [
    task({ status: "done", external_key: "merge-violation:my-repo:1" }),
    task({ status: "paused", external_key: "test-scan:my-repo:2026-11-15" }),
    task({ external_key: "merge-violation-2026-11-16" }),
    ...newer,
    task(),
  ];
  const { run, calls } = setup({ tasks });
  assert.equal((await run()).status, "start");
  assert.deepEqual(calls.jira, issuePaths(ISSUE));
});

test("missing, blank, or non-string Jira key is reported without a fabricated lookup", async () => {
  const tasks = [undefined, " ", 42].map((jira_key, i) =>
    task({
      external_key: `test-scan:my-repo:2026-11-1${i}`,
      metadata: { jira_key },
    }),
  );
  const { run, calls } = setup({ tasks });
  const result = await run();
  assert.equal(result.status, "skip");
  for (const item of tasks) assert.ok(result.content.includes(item.external_key));
  assert.match(result.content, /metadata\.jira_key/);
  assert.deepEqual(calls.jira, []);
});

test("owned tasks do not need a repo map; unattributed tasks do", async () => {
  for (const repos of [null, {}]) {
    const { run, calls } = setup({
      tasks: [legacy({ external_key: "merge-violation:my-repo:124" }), task()],
      repos,
    });
    assert.equal((await run()).status, "start");
    assert.deepEqual(calls.jira, issuePaths(ISSUE));
  }
});

test("only well-formed unattributed findings for configured repos may resume", async () => {
  const scanKey = "test-scan:my-repo:2026-11-16";
  const scanIssue = "RHCLOUD-998";
  const repos = { ...REPOS, _config: { jira_project: "RHCLOUD" }, "no-upstream": {} };
  const tasks = [
    legacy(),
    legacy({
      instance_id: null,
      external_key: scanKey,
      repo: undefined,
      metadata: { jira_key: scanIssue },
    }),
    task({ instance_id: "another-instance", external_key: "merge-violation:my-repo:5" }),
    task({ instance_id: "", external_key: "merge-violation:my-repo:6" }),
    legacy({ external_key: "merge-violation:unknown:9", repo: "unknown" }),
    legacy({ external_key: "merge-violation:my-repo:10", repo: "wrong-repo" }),
    legacy({ external_key: "merge-violation:my-repo:1:2" }),
    legacy({ external_key: "merge-violation:my-repo" }),
    legacy({ external_key: "merge-violation:_config:1", repo: "_config" }),
    legacy({ external_key: "merge-violation:no-upstream:1", repo: "no-upstream" }),
    legacy({ external_key: "RHCLOUD-123" }),
  ];
  const { run, calls } = setup({
    tasks,
    repos,
    issues: { [ISSUE]: issue(), [scanIssue]: issue() },
  });
  const result = await run();
  assert.equal(result.status, "start");
  assert.ok(result.content.includes(`Task ID: ${TASK_ID}`));
  assert.ok(result.content.includes(`Task ID: ${scanKey}`));
  assert.ok(result.content.includes(`Jira key: ${scanIssue}`));
  assert.deepEqual(calls.jira.sort(), [...issuePaths(ISSUE), ...issuePaths(scanIssue)].sort());
});

test("memory and Jira outages fail instead of silently skipping", async () => {
  for (const opts of [{ memoryStatus: 500 }, { jiraStatus: 500 }]) {
    await assert.rejects(setup(opts).run(), /HTTP 500/);
  }
});
