import assert from "node:assert/strict";
import test from "node:test";
import { createPreflightRunContext } from "../dist/index.js";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import { hasNewJiraFeedback } from "../dist/preflights/jira-common/triage.js";
import {
  activeTask,
  candidateIssue,
  cleanIssueEntries,
  createTestContext,
  jsonResponse,
  tenCleanActiveTasks,
} from "./jira-fixtures.mjs";

const registry = createPopulatedRegistry();
const jiraSprint = registry.get("jira-sprint");

const runSprint = (ctx, withParams = {}) =>
  jiraSprint.run(ctx, jiraSprint.input.parse({ label: "hcc-ai-test", ...withParams }));

const cleanJiraEntry = {
  fields: { status: { name: "Code Review" }, labels: [], issuelinks: [] },
  comments: [],
};

// --- hasNewJiraFeedback (ported from test_jira_sprint_preflight.py) ---

test("new feedback detected", () => {
  const comments = [{ created: "2026-07-01T10:00:00", body: "Hey can you check this?" }];
  assert.equal(hasNewJiraFeedback(comments, "2026-06-30T10:00:00"), true);
});

test("old feedback ignored", () => {
  const comments = [{ created: "2026-06-30T08:00:00", body: "Hey can you check this?" }];
  assert.equal(hasNewJiraFeedback(comments, "2026-06-30T10:00:00"), false);
});

test("bot structured comment not feedback", () => {
  const comments = [
    {
      created: "2026-07-01T10:00:00",
      body: "### Analysis\n\n| col1 | col2 |\n|---|---|\n| a | b |",
    },
  ];
  assert.equal(hasNewJiraFeedback(comments, "2026-06-30T10:00:00"), false);
});

test("pr link not feedback", () => {
  const comments = [
    { created: "2026-07-01T10:00:00", body: "PR: https://github.com/org/repo/pull/42" },
  ];
  assert.equal(hasNewJiraFeedback(comments, "2026-06-30T10:00:00"), false);
});

test("empty comments", () => {
  assert.equal(hasNewJiraFeedback([], "2026-06-30T10:00:00"), false);
});

test("same-minute-after last_addressed detected", () => {
  // Regression for RHCLOUD-53177: full-resolution comparison must catch a
  // comment posted seconds after last_addressed within the same minute.
  const comments = [
    { created: "2026-11-10T08:59:41.053+0000", body: "can you read it and implement it?" },
  ];
  assert.equal(hasNewJiraFeedback(comments, "2026-11-10T08:59:05.470894+00:00"), true);
});

test("same-minute-before last_addressed ignored", () => {
  const comments = [
    { created: "2026-11-10T08:59:05.053+0000", body: "can you read it and implement it?" },
  ];
  assert.equal(hasNewJiraFeedback(comments, "2026-11-10T08:59:41.470894+00:00"), false);
});

// --- run() decision logic (ported, params instead of env) ---

test("no active tasks and no candidates returns skip", async () => {
  const ctx = createTestContext({ tasks: [], search: async () => [] });
  const result = await runSprint(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /No eligible work/);
});

test("no active tasks with candidates returns start", async () => {
  const ctx = createTestContext({
    tasks: [],
    repos: { "my-repo": { upstream: "https://github.com/org/my-repo" } },
    search: async () => [
      candidateIssue("TEST-1", {
        summary: "Fix bug",
        labels: ["hcc-ai-test", "repo:my-repo"],
        description: "Fix it",
      }),
    ],
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /TEST-1/);
  assert.match(result.content, /### New Work Candidates \(1\)/);
  assert.match(result.content, /-> Top pick: TEST-1 repos=my-repo/);
});

test("active task with feedback returns start", async () => {
  // Comments arrive through the paginated comment endpoint and are merged
  // into fields.comment.comments by the client (the Python legacy
  // top-level/fields.comment.comments paths are the same merge now).
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "TEST-2",
        status: "pr_open",
        last_addressed: "2026-06-30T10:00:00",
        metadata: { prs: [{ repo: "my-repo", number: 1, host: "github" }] },
      }),
    ],
    issues: {
      "TEST-2": {
        fields: { status: { name: "In Progress" }, labels: [], issuelinks: [] },
        comments: [
          {
            created: "2026-07-01T10:00:00",
            body: "Can you check this?",
            author: { displayName: "Human" },
          },
        ],
      },
    },
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /JIRA FEEDBACK/);
  assert.match(result.content, /jira_comments \(1, newest first\)/);
  assert.match(result.content, /Can you check this\?/);
});

test("active task with feedback records jira state on the run context", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "TEST-2",
        status: "pr_open",
        last_addressed: "2026-06-30T10:00:00",
        metadata: { prs: [{ repo: "my-repo", number: 1, host: "github" }] },
      }),
    ],
    issues: {
      "TEST-2": {
        fields: { status: { name: "In Progress" }, labels: [], issuelinks: [] },
        comments: [
          {
            created: "2026-07-01T10:00:00",
            body: "Can you check this?",
            author: { displayName: "Human" },
          },
        ],
      },
    },
  });
  await runSprint(ctx);
  assert.deepEqual(ctx.state.get("jira"), { feedback: 1, interrupted: 0 });
});

test("active tasks all clean, no candidates returns skip", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "TEST-3",
        status: "pr_open",
        last_addressed: "2026-07-01T12:00:00",
        metadata: { prs: [{ repo: "my-repo", number: 1, host: "github" }] },
      }),
    ],
    issues: { "TEST-3": cleanJiraEntry },
    search: async () => [],
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /No eligible work/);
  assert.match(result.content, /### CLEAN \(1\)/);
});

test("active tasks all clean with candidates returns start", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "TEST-3",
        status: "pr_open",
        last_addressed: "2026-07-01T12:00:00",
        metadata: { prs: [{ repo: "my-repo", number: 1, host: "github" }] },
      }),
    ],
    issues: { "TEST-3": cleanJiraEntry },
    repos: { "my-repo": { upstream: "https://github.com/org/my-repo" } },
    search: async () => [
      candidateIssue("TEST-99", {
        summary: "New feature",
        labels: ["hcc-ai-test", "repo:my-repo"],
        description: "Build it",
      }),
    ],
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /TEST-99/);
});

test("at capacity with investigation tickets returns start", async () => {
  const ctx = createTestContext({
    tasks: tenCleanActiveTasks(),
    issues: cleanIssueEntries(),
    search: async (jql) =>
      jql.includes("needs-investigation")
        ? [
            candidateIssue("TEST-4", {
              summary: "Investigate outage",
              labels: ["hcc-ai-test", "needs-investigation"],
              description: "Look into it",
            }),
          ]
        : [],
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /Investigation/);
  assert.match(result.content, /### Investigation Candidates \(at capacity 10\/10\)/);
});

test("at capacity without investigation tickets returns skip", async () => {
  const ctx = createTestContext({
    tasks: tenCleanActiveTasks(),
    issues: cleanIssueEntries(),
    search: async () => [],
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /capacity/i);
  assert.match(result.content, /At capacity \(10\/10\), no investigation tickets/);
});

test("candidates without repo labels return skip", async () => {
  // The RHCLOUD-48805 fix: candidates exist but none have repo: labels.
  const ctx = createTestContext({
    tasks: [],
    search: async () => [
      candidateIssue("RHCLOUD-48805", {
        summary: "No repo label ticket",
        labels: ["hcc-ai-framework"],
        description: "Missing repo label",
      }),
    ],
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /lack repo: labels/);
});

test("mixed candidates only start with repos", async () => {
  const ctx = createTestContext({
    tasks: [],
    repos: { "my-repo": { upstream: "https://github.com/org/my-repo" } },
    search: async () => [
      candidateIssue("TEST-10", {
        summary: "Has repo",
        labels: ["hcc-ai-test", "repo:my-repo"],
        description: "Fix it",
      }),
      candidateIssue("TEST-11", {
        summary: "No repo",
        labels: ["hcc-ai-test"],
        description: "Missing label",
      }),
    ],
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /TEST-10/);
  assert.doesNotMatch(result.content, /### New Work Candidates[\s\S]*TEST-11/);
  assert.match(result.content, /-> 1 with matching repos, 1 without/);
});

test("interrupted task returns start", async () => {
  const ctx = createTestContext({
    tasks: [activeTask({ external_key: "TEST-5", metadata: { last_step: "implemented" } })],
    issues: { "TEST-5": cleanJiraEntry },
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /INTERRUPTED/);
});

// --- interrupted blocked-task cooldown (CCXDEV-17030 regression) ---

test("interrupted blocked task recently addressed waits", async () => {
  const recently = new Date(Date.now() - 60_000).toISOString();
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "TEST-5",
        last_addressed: recently,
        metadata: { last_step: "assessment_blocked", blockers: ["prod SBOM copy Forbidden"] },
      }),
    ],
    issues: { "TEST-5": cleanJiraEntry },
    search: async () => [],
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "skip");
  assert.doesNotMatch(result.content, /INTERRUPTED/);
  assert.match(result.content, /CLEAN/);
});

test("interrupted blocked task with stale last_addressed retries", async () => {
  const stale = new Date(Date.now() - 45 * 60_000).toISOString();
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "TEST-5",
        last_addressed: stale,
        metadata: { last_step: "assessment_blocked", blockers: ["prod SBOM copy Forbidden"] },
      }),
    ],
    issues: { "TEST-5": cleanJiraEntry },
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /INTERRUPTED/);
});

test("interrupted unblocked task recently addressed resumes immediately", async () => {
  const recently = new Date(Date.now() - 60_000).toISOString();
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "TEST-5",
        last_addressed: recently,
        metadata: { last_step: "implemented" },
      }),
    ],
    issues: { "TEST-5": cleanJiraEntry },
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /INTERRUPTED/);
});

test("interrupted_retry_minutes parameter overrides the cooldown", async () => {
  const stale = new Date(Date.now() - 45 * 60_000).toISOString();
  const tasks = [
    activeTask({
      external_key: "TEST-5",
      last_addressed: stale,
      metadata: { last_step: "assessment_blocked", blockers: ["prod SBOM copy Forbidden"] },
    }),
  ];
  const longCooldown = createTestContext({
    tasks,
    issues: { "TEST-5": cleanJiraEntry },
    search: async () => [],
  });
  const stillWaiting = await runSprint(longCooldown, { interrupted_retry_minutes: 60 });
  assert.equal(stillWaiting.status, "skip");

  const defaultCooldown = createTestContext({ tasks, issues: { "TEST-5": cleanJiraEntry } });
  const dueNow = await runSprint(defaultCooldown, { interrupted_retry_minutes: 30 });
  assert.equal(dueNow.status, "start");
  assert.match(dueNow.content, /INTERRUPTED/);
});

// --- candidate query construction ---

test("sprint candidate queries run unassigned, bot-assigned, then backlog", async () => {
  const jqls = [];
  const ctx = createTestContext({
    tasks: [],
    search: async (jql) => {
      jqls.push(jql);
      return [];
    },
  });
  const result = await runSprint(ctx, { email: "bot@test.com", include_backlog: true });
  assert.equal(result.status, "skip");
  const statusList = '"New", "Backlog", "Refinement", "To Do"';
  assert.deepEqual(jqls, [
    `labels = hcc-ai-test AND sprint in openSprints() AND assignee is EMPTY AND status IN (${statusList}) ORDER BY priority DESC, created ASC`,
    `labels = hcc-ai-test AND sprint in openSprints() AND assignee = "bot@test.com" AND status IN (${statusList}) ORDER BY priority DESC, created ASC`,
    `labels = hcc-ai-test AND (assignee is EMPTY OR assignee = "bot@test.com") AND status IN (${statusList}) AND (sprint is EMPTY OR sprint not in openSprints()) ORDER BY priority DESC, created ASC`,
  ]);
});

test("sprint skips bot-assigned and backlog queries without email or backlog flag", async () => {
  const jqls = [];
  const ctx = createTestContext({
    tasks: [],
    search: async (jql) => {
      jqls.push(jql);
      return [];
    },
  });
  await runSprint(ctx);
  assert.equal(jqls.length, 1);
  assert.match(jqls[0], /sprint in openSprints\(\) AND assignee is EMPTY/);
});

test("feedback buried under many newer bot comments starts with the feedback visible", async () => {
  // Classification reads the full paginated comment history, so a human
  // comment followed by 35 structured bot comments (more than the 30-newest
  // rendering cap) still classifies as feedback, and the bounded prompt
  // selection keeps that triggering feedback visible in the start prompt.
  const botStatusComment = (minutes) => ({
    created: `2026-07-01T10:${String(minutes).padStart(2, "0")}:00`,
    body: "### Cycle status\n| step | state |\n| --- | --- |\n| build | ok |",
    author: { displayName: "rehor-bot" },
  });
  const comments = [
    { created: "2026-06-29T09:00:00", body: "earlier note", author: { displayName: "Human" } },
    {
      created: "2026-07-01T09:00:00",
      body: "Please fix the flaky test",
      author: { displayName: "Human" },
    },
    ...Array.from({ length: 35 }, (_unused, index) => botStatusComment(index)),
  ];
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "TEST-2",
        status: "pr_open",
        last_addressed: "2026-06-30T00:00:00",
        metadata: { prs: [{ repo: "my-repo", number: 1, host: "github" }] },
      }),
    ],
    issues: {
      "TEST-2": {
        fields: { status: { name: "In Progress" }, labels: [], issuelinks: [] },
        comments,
      },
    },
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /### JIRA FEEDBACK \(1\)/);
  assert.match(result.content, /Please fix the flaky test/);
  assert.match(result.content, /jira_comments \(11, newest first\)/);
  assert.doesNotMatch(result.content, /truncated/);
});

// --- execution-error mapping (adapted from the missing-instance/unavailable paths) ---

test("jira failures map to an error result, never a silent skip", async () => {
  const ctx = createPreflightRunContext({
    instanceId: "test-instance",
    memory: { baseUrl: "http://memory.test", fetch: async () => jsonResponse({ items: [] }) },
    jira: {
      baseUrl: "https://proxy.test",
      fetch: async () => jsonResponse({ error: "boom" }, 500),
    },
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "error");
  assert.match(result.content, /500/);
});

test("jira preflight without a wired jira client returns an error result", async () => {
  const ctx = createPreflightRunContext({
    instanceId: "test-instance",
    memory: { baseUrl: "http://memory.test", fetch: async () => jsonResponse({ items: [] }) },
  });
  const result = await runSprint(ctx);
  assert.equal(result.status, "error");
  assert.match(result.content, /jira client not wired/);
});
