import assert from "node:assert/strict";
import test from "node:test";
import { createPreflightRunContext } from "../dist/index.js";
import {
  HCC_QUALITY_JIRA_FEEDBACK_INPUT,
  isHumanFeedbackTrigger,
  runHccQualityJiraFeedback,
} from "../dist/preflights/hcc-quality-jira-feedback/index.js";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import { createJiraClient } from "../dist/shared/jira.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";
import { createRunState } from "../dist/shared/run-context.js";
import { createJiraFetch, jsonResponse } from "./jira-fixtures.mjs";

/**
 * Coverage for `hcc-quality-jira-feedback`: the schedule window, the
 * active-task selection (status-filtered, paginated past the
 * newest-50 listing cap; instance-attributed rows plus the
 * user-approved unattributed legacy pickup constrained to configured
 * repos), the per-finding task identity (external_key prefix +
 * metadata.jira_key), the feedback start/skip decision, bot-author
 * handling, and the fail policy. All flows run through the exported
 * flow function with an injected clock — the registered wrapper's
 * window gate reads the real clock, so only the clock-independent
 * no-client error goes through the registry.
 */

// 2026-11-16 is a Monday (November: Prague is CET, UTC+1); 2026-11-21 is a
// Saturday. 2026-07-20 is a Monday in July (Prague is CEST, UTC+2).
const IN_WINDOW = () => new Date("2026-11-16T10:00:00Z"); // Mon 11:00 Prague
const SATURDAY = () => new Date("2026-11-21T10:00:00Z"); // Sat 11:00 Prague
const EARLY_MONDAY = () => new Date("2026-11-16T07:30:00Z"); // Mon 08:30 Prague
const LATE_MONDAY = () => new Date("2026-11-16T22:30:00Z"); // Mon 23:30 Prague

const parseParams = (with_) => HCC_QUALITY_JIRA_FEEDBACK_INPUT.parse(with_ ?? {});

/**
 * A tracked per-finding task of the run's instance ("quality");
 * metadata merges over the default jira_key. Pass
 * `{ instance_id: undefined }` for the unattributed legacy rows the
 * user-approved pickup admits.
 */
const qualityTask = ({ metadata, ...overrides } = {}) => ({
  status: "in_progress",
  external_key: "merge-violation:my-repo:123",
  repo: "my-repo",
  instance_id: "quality",
  last_addressed: "2026-11-14T12:00:00",
  ...overrides,
  metadata: { jira_key: "RHCLOUD-999", ...metadata },
});

/** The instance's project-repos map: `my-repo` configured and resolvable. */
const REPOS = {
  "my-repo": {
    url: "https://github.com/bot/my-repo.git",
    upstream: "https://github.com/org/my-repo.git",
  },
};

const HUMAN_COMMENT = {
  created: "2026-11-16T09:00:00",
  body: "Please re-check the flaky login test",
  author: { displayName: "Jana Nováková" },
};

const feedbackIssue = (comments = [HUMAN_COMMENT]) => ({
  fields: { status: { name: "In Progress" }, labels: [], issuelinks: [] },
  comments,
});

const cleanIssueEntry = {
  fields: { status: { name: "In Progress" }, labels: [], issuelinks: [] },
  comments: [
    {
      created: "2026-11-13T08:00:00",
      body: "already addressed",
      author: { displayName: "Jana Nováková" },
    },
  ],
};

/**
 * Memory-server double for the active-task fetch: buckets tasks by
 * status, applies the status/limit/offset query window, and records
 * every request URL. The client's includeUnattributed fetch reads the
 * global per-status listing (no instance_id parameter) and filters
 * attribution client-side, so this double returns every row of the
 * bucket and lets the real client do the own-instance/unassigned
 * split. A request without `status` (the plain `getTasks` listing)
 * sees every task newest-first, done tasks included — exactly the
 * listing whose newest-50 cap can hide older active tasks.
 */
const recordingMemory = (tasks = []) => {
  const calls = [];
  const client = createMemoryServerClient({
    baseUrl: "http://memory.test",
    instanceId: "quality",
    fetch: async (url) => {
      calls.push(url);
      const params = new URL(url).searchParams;
      const status = params.get("status");
      const limit = Number(params.get("limit") ?? 20);
      const offset = Number(params.get("offset") ?? 0);
      const bucket = status === null ? tasks : tasks.filter((task) => task.status === status);
      return jsonResponse({ items: bucket.slice(offset, offset + limit), total: bucket.length });
    },
  });
  return { client, calls };
};

/** Jira client on the shared fixture router, with recorded request paths. */
const recordingJira = (issues = {}) => {
  const calls = [];
  const inner = createJiraFetch({ issues });
  const client = createJiraClient({
    baseUrl: "https://proxy.test",
    fetch: async (url, init) => {
      calls.push(new URL(url).pathname);
      return inner(url, init);
    },
  });
  return { client, calls };
};

const setup = ({ tasks = [], issues = {}, repos = REPOS } = {}) => {
  const memory = recordingMemory(tasks);
  const jira = recordingJira(issues);
  const state = createRunState();
  const run = (now = IN_WINDOW, with_ = undefined) =>
    runHccQualityJiraFeedback(
      { memory: memory.client, jira: jira.client, state, now, repos },
      parseParams(with_),
    );
  return { memory, jira, state, run };
};

// --- input schema and registration ---

test("input applies the documented defaults and fails closed", () => {
  assert.deepEqual(parseParams(), { task_prefixes: ["merge-violation", "test-scan"] });
  assert.deepEqual(parseParams({ task_prefixes: ["q"] }), { task_prefixes: ["q"] });
  assert.equal(HCC_QUALITY_JIRA_FEEDBACK_INPUT.safeParse({ task_prefixes: [] }).success, false);
  assert.equal(HCC_QUALITY_JIRA_FEEDBACK_INPUT.safeParse({ task_prefixes: [" "] }).success, false);
  assert.equal(HCC_QUALITY_JIRA_FEEDBACK_INPUT.safeParse({ unexpected: 1 }).success, false);
});

test("registered preflight errors without a wired jira client", async () => {
  const registry = createPopulatedRegistry();
  const preflight = registry.get("hcc-quality-jira-feedback");
  const ctx = createPreflightRunContext({
    instanceId: "quality",
    memory: {
      baseUrl: "http://memory.test",
      fetch: async () => jsonResponse({ items: [] }),
    },
  });
  const result = await preflight.run(ctx, preflight.input.parse({}));
  assert.equal(result.status, "error");
  assert.equal(result.content, "jira client not wired in the run context");
});

// --- schedule window (the instance's historical KEDA restriction) ---

test("skips outside Mon-Fri 09:00-23:00 Europe/Prague without fetching", async () => {
  for (const now of [SATURDAY, EARLY_MONDAY, LATE_MONDAY]) {
    const { memory, jira, run } = setup({
      tasks: [qualityTask()],
      issues: { "RHCLOUD-999": feedbackIssue() },
    });
    const result = await run(now);
    assert.equal(result.status, "skip");
    assert.match(result.content, /Outside the quality instance active window/);
    assert.deepEqual(memory.calls, []);
    assert.deepEqual(jira.calls, []);
  }
});

test("the window reads the Prague wall clock across DST", async () => {
  const { run } = setup({
    tasks: [qualityTask()],
    issues: { "RHCLOUD-999": feedbackIssue() },
  });
  // The same UTC instant, opposite seasons: 07:30Z is 09:30 CEST in July
  // (inside the window) but 08:30 CET in November (before it opens).
  assert.equal((await run(() => new Date("2026-07-20T07:30:00Z"))).status, "start");
  assert.equal((await run(() => new Date("2026-11-16T07:30:00Z"))).status, "skip");
});

// --- feedback gating ---

test("feedback on an ongoing task starts even when the scans would skip", async () => {
  // Both scan gates say skip: the daily marker task exists (any status
  // closes the day for hcc-merged-pr-violations) and five active violation
  // tasks hit the max_concurrent backpressure. Feedback is independent of
  // the scan pacing — that is the point of this preflight.
  const tasks = [
    { status: "in_progress", external_key: "merge-violation-2026-11-16", repo: "my-repo" },
    ...Array.from({ length: 5 }, (_unused, index) =>
      qualityTask({
        external_key: `merge-violation:my-repo:${200 + index}`,
        metadata: { jira_key: `RHCLOUD-2${index}0` },
      }),
    ),
    qualityTask(),
  ];
  const issues = {
    "RHCLOUD-999": feedbackIssue(),
    ...Object.fromEntries(
      Array.from({ length: 5 }, (_unused, index) => [`RHCLOUD-2${index}0`, cleanIssueEntry]),
    ),
  };
  const { jira, run } = setup({ tasks, issues });
  const result = await run();
  assert.equal(result.status, "start");
  assert.match(result.content, /# Quality Task Jira Feedback \(1\)/);
  assert.match(result.content, /high:\n {2}- merge-violation:my-repo:123 → Jira RHCLOUD-999/);
  assert.match(result.content, /- Task ID: merge-violation:my-repo:123/);
  assert.match(result.content, /- Jira key: RHCLOUD-999/);
  assert.match(result.content, /Do not create a new\s+task for this feedback/);
  assert.match(result.content, /before starting new scans/);
  assert.match(result.content, /Please re-check the flaky login test/);
  assert.match(result.content, /jira_comments \(1, newest first\)/);
  // The daily marker is not a tracked per-finding task — never fetched.
  assert.deepEqual(
    jira.calls.filter((path) => path.includes("merge-violation")),
    [],
  );
});

test("tracked tasks without new feedback skip", async () => {
  const { run } = setup({
    tasks: [qualityTask()],
    issues: { "RHCLOUD-999": cleanIssueEntry },
  });
  const result = await run();
  assert.equal(result.status, "skip");
  assert.match(result.content, /No new human Jira feedback on 1 active quality task\(s\)/);
  assert.match(result.content, /clean: merge-violation:my-repo:123 → RHCLOUD-999/);
});

test("only structured bot markers or comments older than last_addressed never trigger", async () => {
  const comments = [
    {
      created: "2026-11-15T09:00:00",
      body: "### Cycle status\n| step | state |\n| --- | --- |",
      author: { displayName: "rehor-bot" },
    },
    { created: "2026-11-15T10:00:00", body: "PR: merged", author: { displayName: "rehor-bot" } },
    {
      created: "2026-11-13T09:00:00",
      body: "old human note",
      author: { displayName: "Jana Nováková" },
    },
  ];
  const { run } = setup({
    tasks: [qualityTask()],
    issues: { "RHCLOUD-999": { fields: cleanIssueEntry.fields, comments } },
  });
  const result = await run();
  assert.equal(result.status, "skip");
  assert.match(result.content, /clean: merge-violation:my-repo:123 → RHCLOUD-999/);
});

test("done and paused tracked tasks are respected even with fresh feedback", async () => {
  // The status-scoped active-task fetch never returns done or paused
  // tasks, so both are respected by construction: their issues are never
  // fetched, and the preflight never falls back to the all-status
  // listing that would surface them.
  const tasks = [
    qualityTask({
      status: "done",
      external_key: "merge-violation:done-repo:9",
      metadata: { jira_key: "RHCLOUD-DONE" },
    }),
    qualityTask({
      status: "paused",
      external_key: "test-scan:paused-repo:2026-11-15",
      metadata: { jira_key: "RHCLOUD-PAUSED" },
      paused_reason: "waiting on humans",
    }),
  ];
  const { memory, jira, run } = setup({
    tasks,
    issues: { "RHCLOUD-DONE": feedbackIssue(), "RHCLOUD-PAUSED": feedbackIssue() },
  });
  const result = await run();
  assert.equal(result.status, "skip");
  assert.match(result.content, /No active quality tasks/);
  // Respected means not checked: their issues are never fetched.
  assert.deepEqual(jira.calls, []);
  // Every request was a status-scoped global active-task query — the
  // attribution split (own instance or truly unassigned) is the real
  // client's client-side filter, so no instance_id parameter rides the
  // URL, and no unscoped all-status listing is ever fetched.
  assert.ok(memory.calls.length > 0);
  for (const url of memory.calls) {
    assert.match(url, /status=(in_progress|pr_open|pr_changes)/);
    assert.equal(new URL(url).searchParams.get("instance_id"), null);
  }
});

test("feedback starts on an active task older than the newest 50 tasks of the listing", async () => {
  // The integration gap this preflight closes: getTasks() caps at the
  // newest 50 tasks of all statuses, so 55 newer done tasks hide an
  // older active quality task from the plain listing (pinned below by
  // calling getTasks on the same double). The instance-scoped
  // status-filtered fetch selects it anyway, paging past the 50-task
  // page cap of its own in_progress bucket.
  const done = Array.from({ length: 55 }, (_unused, index) =>
    qualityTask({
      status: "done",
      external_key: `merge-violation:done-repo:${index}`,
      metadata: { jira_key: `RHCLOUD-D${index}` },
    }),
  );
  const active = [
    // 59 untracked in-progress tasks (ordinary jira-triage keys) push
    // the tracked task onto the second in_progress page.
    ...Array.from({ length: 59 }, (_unused, index) => ({
      status: "in_progress",
      external_key: `REHOR-${500 + index}`,
    })),
    qualityTask(),
  ];
  const { memory, jira, run } = setup({
    tasks: [...done, ...active],
    issues: { "RHCLOUD-999": feedbackIssue() },
  });
  const result = await run();
  assert.equal(result.status, "start");
  assert.match(result.content, /# Quality Task Jira Feedback \(1\)/);
  assert.match(result.content, /- Task ID: merge-violation:my-repo:123/);
  // Only the tracked task's issue is fetched — the untracked fillers
  // never reach Jira.
  assert.deepEqual(
    jira.calls.filter((path) => path.includes("/issue/")),
    ["/jira/rest/api/2/issue/RHCLOUD-999", "/jira/rest/api/2/issue/RHCLOUD-999/comment"],
  );
  // The preflight's own requests were all instance-scoped status
  // queries, and the in_progress bucket was paginated past offset 50.
  assert.ok(memory.calls.some((url) => /status=in_progress/.test(url) && /offset=50/.test(url)));
  for (const url of memory.calls) {
    assert.match(url, /status=(in_progress|pr_open|pr_changes)/);
  }
  // The plain newest-50 listing the flow used to inherit misses the
  // task entirely — that is the gap, demonstrated on the same server.
  const listed = await memory.client.getTasks();
  assert.equal(
    listed.some((task) => task.external_key === "merge-violation:my-repo:123"),
    false,
  );
});

test("multiple feedback tasks are all listed with their identities", async () => {
  const tasks = [
    qualityTask(),
    qualityTask({
      external_key: "test-scan:my-repo:2026-11-16",
      metadata: { jira_key: "RHCLOUD-998" },
    }),
  ];
  const issues = {
    "RHCLOUD-999": feedbackIssue(),
    "RHCLOUD-998": feedbackIssue([
      {
        created: "2026-11-16T10:00:00",
        body: "Second finding needs a re-scan",
        author: { displayName: "Petr Novák" },
      },
    ]),
  };
  const { run } = setup({ tasks, issues });
  const result = await run();
  assert.equal(result.status, "start");
  assert.match(result.content, /# Quality Task Jira Feedback \(2\)/);
  assert.match(result.content, /### JIRA FEEDBACK \(2\)/);
  assert.match(result.content, /merge-violation:my-repo:123 → Jira RHCLOUD-999/);
  assert.match(result.content, /test-scan:my-repo:2026-11-16 → Jira RHCLOUD-998/);
  assert.match(result.content, /Second finding needs a re-scan/);
});

// --- task identity: external_key vs the Jira key in metadata ---

test("fetches the Jira issue named by metadata.jira_key, never the external_key", async () => {
  const { jira, run } = setup({
    tasks: [qualityTask()],
    issues: { "RHCLOUD-999": feedbackIssue() },
  });
  const result = await run();
  assert.equal(result.status, "start");
  assert.deepEqual(
    jira.calls.filter((path) => path.includes("/issue/")),
    ["/jira/rest/api/2/issue/RHCLOUD-999", "/jira/rest/api/2/issue/RHCLOUD-999/comment"],
  );
  // The start content carries both identities so the agent resumes the
  // existing task instead of creating a new one.
  assert.match(result.content, /- Task ID: merge-violation:my-repo:123/);
  assert.match(result.content, /- Jira key: RHCLOUD-999/);
});

test("missing or invalid metadata.jira_key is a named skip reason, never a fabricated link", async () => {
  const tasks = [
    qualityTask({ metadata: { jira_key: undefined } }),
    qualityTask({
      external_key: "test-scan:other:2026-11-16",
      metadata: { jira_key: "   " },
    }),
    qualityTask({
      external_key: "test-scan:bad:2026-11-16",
      metadata: { jira_key: 42 },
    }),
  ];
  const { jira, run } = setup({ tasks, issues: {} });
  const result = await run();
  assert.equal(result.status, "skip");
  assert.match(result.content, /no jira_key: merge-violation:my-repo:123 \(metadata\.jira_key/);
  assert.match(result.content, /no jira_key: test-scan:other:2026-11-16 \(metadata\.jira_key/);
  assert.match(result.content, /no jira_key: test-scan:bad:2026-11-16 \(metadata\.jira_key/);
  assert.match(
    result.content,
    /Jira link not fabricated, store metadata\.jira_key via task_update/,
  );
  // No Jira link exists — nothing is fetched, and the external_key is
  // never tried as a Jira key.
  assert.deepEqual(jira.calls, []);
});

test("Jira-keyed tasks outside the quality prefixes are not this preflight's business", async () => {
  // An ordinary jira-triage task: external_key is a real Jira key with
  // fresh feedback. This preflight must leave it alone.
  const tasks = [
    qualityTask({ external_key: "RHCLOUD-123", metadata: { jira_key: "RHCLOUD-123" } }),
  ];
  const { jira, run } = setup({ tasks, issues: { "RHCLOUD-123": feedbackIssue() } });
  const result = await run();
  assert.equal(result.status, "skip");
  assert.match(result.content, /No active quality tasks/);
  assert.deepEqual(jira.calls, []);
});

// --- unattributed legacy tasks (the user-approved pickup) ---

test("an unattributed legacy task in a configured repo starts on feedback", async () => {
  // The original quality workflow's tasks carry no instance_id; the
  // client's includeUnattributed fetch admits them and the configured
  // repo in the deterministic key vouches for them.
  const tasks = [
    qualityTask({ instance_id: undefined }),
    qualityTask({
      instance_id: null,
      external_key: "test-scan:my-repo:2026-11-16",
      metadata: { jira_key: "RHCLOUD-998" },
    }),
  ];
  const issues = {
    "RHCLOUD-999": feedbackIssue(),
    "RHCLOUD-998": feedbackIssue([
      {
        created: "2026-11-16T10:00:00",
        body: "Re-scan after the fix landed",
        author: { displayName: "Petr Novák" },
      },
    ]),
  };
  const { jira, run } = setup({ tasks, issues });
  const result = await run();
  assert.equal(result.status, "start");
  assert.match(result.content, /# Quality Task Jira Feedback \(2\)/);
  assert.match(result.content, /- Task ID: merge-violation:my-repo:123/);
  assert.match(result.content, /- Task ID: test-scan:my-repo:2026-11-16/);
  // Only the two legacy tasks' issues are fetched.
  assert.deepEqual(jira.calls.filter((path) => path.includes("/issue/")).sort(), [
    "/jira/rest/api/2/issue/RHCLOUD-998",
    "/jira/rest/api/2/issue/RHCLOUD-998/comment",
    "/jira/rest/api/2/issue/RHCLOUD-999",
    "/jira/rest/api/2/issue/RHCLOUD-999/comment",
  ]);
});

test("an unattributed task of an unconfigured repo is never selected", async () => {
  const tasks = [
    qualityTask({
      instance_id: undefined,
      external_key: "merge-violation:other-repo:9",
      repo: "other-repo",
      metadata: { jira_key: "RHCLOUD-OTHER" },
    }),
  ];
  const { jira, run } = setup({
    tasks,
    issues: { "RHCLOUD-OTHER": feedbackIssue() },
  });
  const result = await run();
  assert.equal(result.status, "skip");
  assert.match(result.content, /No active quality tasks/);
  assert.deepEqual(jira.calls, []);
});

test("an empty or missing repo map selects no unattributed task (no broadening)", async () => {
  // Empty map.
  const empty = setup({
    tasks: [qualityTask({ instance_id: undefined })],
    issues: { "RHCLOUD-999": feedbackIssue() },
    repos: {},
  });
  const emptyResult = await empty.run();
  assert.equal(emptyResult.status, "skip");
  assert.match(emptyResult.content, /No active quality tasks/);
  assert.deepEqual(empty.jira.calls, []);

  // Missing map: the flow deps carry no repos entry at all.
  const memory = recordingMemory([qualityTask({ instance_id: undefined })]);
  const jira = recordingJira({ "RHCLOUD-999": feedbackIssue() });
  const missingResult = await runHccQualityJiraFeedback(
    { memory: memory.client, jira: jira.client, state: createRunState(), now: IN_WINDOW },
    parseParams(),
  );
  assert.equal(missingResult.status, "skip");
  assert.match(missingResult.content, /No active quality tasks/);
  assert.deepEqual(jira.calls, []);
});

test("other instances' rows are never selected, even for a configured repo", async () => {
  // The client's attribution filter drops rows naming another instance
  // and rows whose instance_id is an empty string (not "unassigned"),
  // however well their key matches this instance's configuration.
  const tasks = [
    qualityTask({ instance_id: "somewhere-else", external_key: "merge-violation:my-repo:5" }),
    qualityTask({ instance_id: "", external_key: "merge-violation:my-repo:6" }),
  ];
  const { jira, run } = setup({
    tasks,
    issues: { "RHCLOUD-999": feedbackIssue() },
  });
  const result = await run();
  assert.equal(result.status, "skip");
  assert.match(result.content, /No active quality tasks/);
  assert.deepEqual(jira.calls, []);
});

test("a malformed external key on an unattributed task is never selected", async () => {
  const tasks = [
    // Two segments — no repo/suffix split.
    qualityTask({ instance_id: undefined, external_key: "merge-violation:my-repo" }),
    // Empty repo segment.
    qualityTask({ instance_id: undefined, external_key: "merge-violation::123" }),
    // Four segments — not the deterministic ${prefix}:${repo}:${suffix}.
    qualityTask({ instance_id: undefined, external_key: "merge-violation:my-repo:1:2" }),
  ];
  const { jira, run } = setup({ tasks, issues: { "RHCLOUD-999": feedbackIssue() } });
  const result = await run();
  assert.equal(result.status, "skip");
  assert.match(result.content, /No active quality tasks/);
  assert.deepEqual(jira.calls, []);
});

test("a populated task.repo must agree with the key's repo", async () => {
  const tasks = [
    // Key names my-repo, row claims different-repo: disagreement means
    // the task is not vouched for and its Jira issue is never fetched.
    qualityTask({
      instance_id: undefined,
      repo: "different-repo",
      metadata: { jira_key: "RHCLOUD-MISMATCH" },
    }),
    qualityTask({
      instance_id: undefined,
      external_key: "test-scan:my-repo:2026-11-16",
      metadata: { jira_key: "RHCLOUD-998" },
    }),
  ];
  const issues = {
    "RHCLOUD-MISMATCH": feedbackIssue(),
    "RHCLOUD-998": cleanIssueEntry,
  };
  const { jira, run } = setup({ tasks, issues });
  const result = await run();
  assert.equal(result.status, "skip");
  // Only the agreeing task was checked; the mismatched one never
  // reached Jira.
  assert.deepEqual(
    jira.calls.filter((path) => path.includes("/issue/")),
    ["/jira/rest/api/2/issue/RHCLOUD-998", "/jira/rest/api/2/issue/RHCLOUD-998/comment"],
  );
  assert.match(result.content, /clean: test-scan:my-repo:2026-11-16 → RHCLOUD-998/);
});

test("map metadata keys like _config are not configured repositories", async () => {
  // The real project-repos.json carries a `_config` metadata key (and
  // can carry entries without a resolvable upstream); neither counts
  // as a configured repository for the unattributed pickup.
  const repos = {
    "my-repo": REPOS["my-repo"],
    _config: { jira_project: "RHCLOUD" },
    "no-upstream": {},
  };
  const tasks = [
    qualityTask({
      instance_id: undefined,
      external_key: "merge-violation:_config:1",
      repo: "_config",
      metadata: { jira_key: "RHCLOUD-CFG" },
    }),
    qualityTask({
      instance_id: undefined,
      external_key: "merge-violation:no-upstream:2",
      repo: "no-upstream",
      metadata: { jira_key: "RHCLOUD-NOUP" },
    }),
    qualityTask({
      instance_id: undefined,
      external_key: "merge-violation:my-repo:3",
      metadata: { jira_key: "RHCLOUD-OK" },
    }),
  ];
  const issues = {
    "RHCLOUD-CFG": feedbackIssue(),
    "RHCLOUD-NOUP": feedbackIssue(),
    "RHCLOUD-OK": cleanIssueEntry,
  };
  const { jira, run } = setup({ tasks, issues, repos });
  const result = await run();
  assert.equal(result.status, "skip");
  // Only the resolvable repo's task was checked.
  assert.deepEqual(
    jira.calls.filter((path) => path.includes("/issue/")),
    ["/jira/rest/api/2/issue/RHCLOUD-OK", "/jira/rest/api/2/issue/RHCLOUD-OK/comment"],
  );
  assert.match(result.content, /clean: merge-violation:my-repo:3 → RHCLOUD-OK/);
});

test("an unattributed non-quality task is not this preflight's business", async () => {
  const tasks = [
    qualityTask({
      instance_id: undefined,
      external_key: "RHCLOUD-123",
      metadata: { jira_key: "RHCLOUD-123" },
    }),
  ];
  const { jira, run } = setup({ tasks, issues: { "RHCLOUD-123": feedbackIssue() } });
  const result = await run();
  assert.equal(result.status, "skip");
  assert.match(result.content, /No active quality tasks/);
  assert.deepEqual(jira.calls, []);
});

test("instance-attributed quality tasks still start without a repo map", async () => {
  // The original selection: an attributed quality task needs only its
  // prefix — the repo map constrains unattributed rows alone.
  const { run } = setup({
    tasks: [qualityTask()],
    issues: { "RHCLOUD-999": feedbackIssue() },
    repos: {},
  });
  const result = await run();
  assert.equal(result.status, "start");
  assert.match(result.content, /- Task ID: merge-violation:my-repo:123/);
});

// --- bot-author handling (heuristic, honestly bounded) ---

test("isHumanFeedbackTrigger: time, markers, and author heuristics", () => {
  const LAST = "2026-11-14T12:00:00";
  const comment = (created, body, author) => ({ created, body, author });
  const human = { displayName: "Jana Nováková" };

  // New human comment without markers.
  assert.equal(
    isHumanFeedbackTrigger(comment("2026-11-16T09:00:00", "please recheck", human), LAST),
    true,
  );
  // Older or same-instant comments never trigger.
  assert.equal(
    isHumanFeedbackTrigger(comment("2026-11-13T09:00:00", "please recheck", human), LAST),
    false,
  );
  assert.equal(
    isHumanFeedbackTrigger(comment("2026-11-14T12:00:00", "please recheck", human), LAST),
    false,
  );
  // Structured bot markers (the jira-common semantics) filter any author.
  for (const body of ["### Cycle status", "| step | state |", "PR: merged"]) {
    assert.equal(isHumanFeedbackTrigger(comment("2026-11-16T09:00:00", body, human), LAST), false);
  }
  // Obvious bot accounts are filtered even without markers.
  for (const displayName of [
    "github-actions",
    "rehor-bot",
    "ci[bot]",
    "merge-robot",
    "dependabot",
    "renovate",
  ]) {
    assert.equal(
      isHumanFeedbackTrigger(
        comment("2026-11-16T09:00:00", "automation note", { displayName }),
        LAST,
      ),
      false,
    );
  }
  assert.equal(
    isHumanFeedbackTrigger(comment("2026-11-16T09:00:00", "automation note", "rehor-bot"), LAST),
    false,
  );
  // A missing author stays a candidate — conservative, like the marker
  // filter, which never looked at authors at all.
  assert.equal(
    isHumanFeedbackTrigger(comment("2026-11-16T09:00:00", "please recheck", undefined), LAST),
    true,
  );
  assert.equal(
    isHumanFeedbackTrigger(comment("2026-11-16T09:00:00", "please recheck", {}), LAST),
    true,
  );
  // Persona-named bot accounts are indistinguishable from humans by these
  // signals — pinned as the known residual, not claimed as robust human
  // filtering.
  assert.equal(
    isHumanFeedbackTrigger(
      comment("2026-11-16T09:00:00", "status update", { displayName: "Řehoř Hrubý z Jelení" }),
      LAST,
    ),
    true,
  );
  // Without last_addressed nothing can be new (the jira triage semantics).
  assert.equal(
    isHumanFeedbackTrigger(comment("2026-11-16T09:00:00", "please recheck", human), ""),
    false,
  );
});

test("a marker-less comment from an obvious bot account does not start", async () => {
  const { run } = setup({
    tasks: [qualityTask()],
    issues: {
      "RHCLOUD-999": feedbackIssue([
        {
          created: "2026-11-16T09:00:00",
          body: "CI re-ran and passed",
          author: { displayName: "ci-bot" },
        },
      ]),
    },
  });
  const result = await run();
  assert.equal(result.status, "skip");
  assert.match(result.content, /clean: merge-violation:my-repo:123 → RHCLOUD-999/);
});

test("a marker-less comment from a persona-named account still starts (known residual)", async () => {
  const { run } = setup({
    tasks: [qualityTask()],
    issues: {
      "RHCLOUD-999": feedbackIssue([
        {
          created: "2026-11-16T09:00:00",
          body: "cycle status update, all steps green",
          author: { displayName: "Řehoř Hrubý z Jelení" },
        },
      ]),
    },
  });
  const result = await run();
  assert.equal(result.status, "start");
});

// --- fail policy ---

test("a Jira fetch outage is an error, never a silent skip", async () => {
  const failingJira = createJiraClient({
    baseUrl: "https://proxy.test",
    fetch: async () => jsonResponse({ error: "boom" }, 500),
  });
  await assert.rejects(
    runHccQualityJiraFeedback(
      { memory: recordingMemory([qualityTask()]).client, jira: failingJira, now: IN_WINDOW },
      parseParams(),
    ),
    /HTTP 500/,
  );
});

test("a memory fetch outage is an error", async () => {
  const failingMemory = createMemoryServerClient({
    baseUrl: "http://memory.test",
    instanceId: "quality",
    fetch: async () => jsonResponse({ error: "boom" }, 500),
  });
  await assert.rejects(
    runHccQualityJiraFeedback(
      { memory: failingMemory, jira: recordingJira({}).client, now: IN_WINDOW },
      parseParams(),
    ),
    /HTTP 500/,
  );
});

// --- shared per-run state ---

test("has_actionable accumulates like the jira triage family", async () => {
  const feedbackSetup = setup({
    tasks: [qualityTask()],
    issues: { "RHCLOUD-999": feedbackIssue() },
  });
  await feedbackSetup.run();
  assert.equal(feedbackSetup.state.get("has_actionable"), true);

  const cleanSetup = setup({
    tasks: [qualityTask()],
    issues: { "RHCLOUD-999": cleanIssueEntry },
  });
  await cleanSetup.run();
  assert.equal(cleanSetup.state.get("has_actionable"), false);

  // A previous preflight's actionable finding is never reset by a clean run.
  cleanSetup.state.set("has_actionable", true);
  await cleanSetup.run();
  assert.equal(cleanSetup.state.get("has_actionable"), true);
});
