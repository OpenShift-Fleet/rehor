import assert from "node:assert/strict";
import test from "node:test";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import { activeTask, createTestContext, doneTask, pausedTask } from "./jira-fixtures.mjs";

const registry = createPopulatedRegistry();
const jiraTriage = registry.get("jira-triage");

const runTriage = (ctx, withParams = {}) => jiraTriage.run(ctx, jiraTriage.input.parse(withParams));

const cleanJiraEntry = {
  fields: { status: { name: "Code Review" }, labels: [], issuelinks: [] },
  comments: [],
};

test("jira-triage has no required inputs — shorthand entries validate", async () => {
  const params = jiraTriage.input.parse({});
  assert.deepEqual(params, { interrupted_retry_minutes: 30 });
});

test("interrupted_retry_minutes must be a whole number of minutes", () => {
  // The Python read was int(BOT_INTERRUPTED_RETRY_MINUTES) — whole minutes.
  const parsed = jiraTriage.input.safeParse({ interrupted_retry_minutes: 7.5 });
  assert.equal(parsed.success, false);
  assert.equal(jiraTriage.input.safeParse({ interrupted_retry_minutes: 45 }).success, true);
});

test("no active tasks returns start with the priority-2 pointer", async () => {
  const ctx = createTestContext({
    tasks: [
      doneTask({ external_key: "TEST-D" }),
      pausedTask({ external_key: "TEST-P", paused_reason: "waiting" }),
    ],
  });
  const result = await runTriage(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /No active tasks → Priority 2 \(new Jira work\)/);
  assert.match(result.content, /done pending archival: TEST-D/);
  assert.match(result.content, /paused: TEST-P/);
});

test("active task with feedback returns start", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "TEST-1",
        last_addressed: "2026-06-30T10:00:00",
        metadata: { prs: [{ repo: "my-repo", number: 1, host: "github" }] },
      }),
    ],
    issues: {
      "TEST-1": {
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
  const result = await runTriage(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /### JIRA FEEDBACK \(1\)/);
});

test("active tasks all clean return skip", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "TEST-2",
        status: "pr_open",
        last_addressed: "2026-07-01T12:00:00",
        metadata: { prs: [{ repo: "my-repo", number: 1, host: "github" }] },
      }),
    ],
    issues: { "TEST-2": cleanJiraEntry },
  });
  const result = await runTriage(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /### CLEAN \(1\)/);
});

test("interrupted task returns start", async () => {
  const ctx = createTestContext({
    tasks: [activeTask({ external_key: "TEST-3", metadata: { last_step: "implemented" } })],
    issues: { "TEST-3": cleanJiraEntry },
  });
  const result = await runTriage(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /INTERRUPTED/);
});

test("jira-triage (unlike sprint/kanban) counts investigation_posted tasks as interrupted", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({ external_key: "TEST-4", metadata: { last_step: "investigation_posted" } }),
    ],
    issues: { "TEST-4": cleanJiraEntry },
  });
  const result = await runTriage(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /INTERRUPTED/);
});

test("paused and done tasks are listed with the triage formatting", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "TEST-2",
        status: "pr_open",
        last_addressed: "2026-07-01T12:00:00",
        metadata: { prs: [{ repo: "my-repo", number: 1, host: "github" }] },
      }),
      pausedTask({ external_key: "TEST-P", paused_reason: "waiting on humans" }),
      doneTask({ external_key: "TEST-D" }),
    ],
    issues: { "TEST-2": cleanJiraEntry },
  });
  const result = await runTriage(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /PAUSED: TEST-P:waiting on humans/);
  assert.match(result.content, /DONE \(archive\?\): TEST-D/);
});

// --- full-history classification with bounded prompt rendering (PR #652 review) ---

/** A structured bot status comment — marker-filtered, never feedback. */
const botStatusComment = (minutes) => ({
  created: `2026-07-01T10:${String(minutes).padStart(2, "0")}:00`,
  body: "### Cycle status\n| step | state |\n| --- | --- |\n| build | ok |",
  author: { displayName: "rehor-bot" },
});

/** Active task whose comments can bury feedback under bot noise. */
const noisyFeedbackTask = () =>
  activeTask({
    external_key: "TEST-F1",
    status: "pr_open",
    last_addressed: "2026-06-30T00:00:00",
    metadata: { prs: [{ repo: "my-repo", number: 1, host: "github" }] },
  });

test("human feedback buried under 35 newer bot comments still triggers feedback and stays visible", async () => {
  // Native REST pagination delivers the whole history, so classification
  // must not be limited to the newest comments (the old [-10:] tail would
  // hide the human comment under the bot noise). More than 30 newer bot
  // comments also proves the rendering selection — not fmtComments'
  // 30-newest cap — is what keeps the triggering feedback in the prompt.
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
    tasks: [noisyFeedbackTask()],
    issues: {
      "TEST-F1": {
        fields: { status: { name: "In Progress" }, labels: [], issuelinks: [] },
        comments,
      },
    },
  });
  const result = await runTriage(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /### JIRA FEEDBACK \(1\)/);
  // The triggering human feedback survives in the rendered prompt…
  assert.match(result.content, /Please fix the flaky test/);
  // …while the rendered set stays bounded: the 10 newest comments plus the
  // trigger, not the whole 37-comment history, and never a truncation cap.
  assert.match(result.content, /jira_comments \(11, newest first\)/);
  assert.doesNotMatch(result.content, /truncated/);
  assert.doesNotMatch(result.content, /### CLEAN/);
});

test("only structured bot comments newer than last_addressed stay clean", async () => {
  const comments = [
    { created: "2026-06-29T09:00:00", body: "earlier note", author: { displayName: "Human" } },
    ...Array.from({ length: 35 }, (_unused, index) => botStatusComment(index)),
  ];
  const ctx = createTestContext({
    tasks: [noisyFeedbackTask()],
    issues: {
      "TEST-F1": {
        fields: { status: { name: "In Progress" }, labels: [], issuelinks: [] },
        comments,
      },
    },
  });
  const result = await runTriage(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /### CLEAN \(1\)/);
  assert.doesNotMatch(result.content, /JIRA FEEDBACK/);
});

test("human feedback older than last_addressed never triggers, whatever follows", async () => {
  // Timestamps are respected: the human comment predates last_addressed,
  // so only the unaddressed bot tail renders, for context.
  const comments = [
    {
      created: "2026-06-29T09:00:00",
      body: "already addressed human feedback",
      author: { displayName: "Human" },
    },
    ...Array.from({ length: 12 }, (_unused, index) => botStatusComment(index)),
  ];
  const ctx = createTestContext({
    tasks: [noisyFeedbackTask()],
    issues: {
      "TEST-F1": {
        fields: { status: { name: "In Progress" }, labels: [], issuelinks: [] },
        comments,
      },
    },
  });
  const result = await runTriage(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /### CLEAN \(1\)/);
  assert.doesNotMatch(result.content, /JIRA FEEDBACK/);
});

test("has_actionable state accumulates across preflights in one run", async () => {
  const feedbackTasks = [
    activeTask({
      external_key: "TEST-1",
      last_addressed: "2026-06-30T10:00:00",
      metadata: { prs: [{ repo: "my-repo", number: 1, host: "github" }] },
    }),
  ];
  const feedbackIssues = {
    "TEST-1": {
      fields: { status: { name: "In Progress" }, labels: [], issuelinks: [] },
      comments: [
        {
          created: "2026-07-01T10:00:00",
          body: "Can you check this?",
          author: { displayName: "Human" },
        },
      ],
    },
  };
  const ctx = createTestContext({ tasks: feedbackTasks, issues: feedbackIssues });
  await runTriage(ctx);
  assert.equal(ctx.state.get("has_actionable"), true);

  // A later clean run in the same run context keeps the flag set.
  const cleanCtx = createTestContext({
    tasks: [
      activeTask({
        external_key: "TEST-2",
        status: "pr_open",
        last_addressed: "2026-07-01T12:00:00",
        metadata: { prs: [{ repo: "my-repo", number: 1, host: "github" }] },
      }),
    ],
    issues: { "TEST-2": cleanJiraEntry },
  });
  cleanCtx.state.set("has_actionable", true);
  await runTriage(cleanCtx);
  assert.equal(cleanCtx.state.get("has_actionable"), true);

  const freshCtx = createTestContext({
    tasks: [
      activeTask({
        external_key: "TEST-2",
        status: "pr_open",
        last_addressed: "2026-07-01T12:00:00",
        metadata: { prs: [{ repo: "my-repo", number: 1, host: "github" }] },
      }),
    ],
    issues: { "TEST-2": cleanJiraEntry },
  });
  await runTriage(freshCtx);
  assert.equal(freshCtx.state.get("has_actionable"), false);
});
