import assert from "node:assert/strict";
import test from "node:test";
import { createPreflightRunContext } from "../dist/index.js";
import { createGitlabClient } from "../dist/preflights/gl-mr-status/gitlab.js";
import {
  bucketGlMrStatuses,
  ciFailureNeedsSession,
  classifyGl,
  glMrStatus,
  hasNewFeedback,
  runGlMrStatus,
} from "../dist/preflights/gl-mr-status/index.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";
import { createRunState } from "../dist/shared/run-context.js";

/**
 * Port of the Python gl_mr_status test coverage
 * (bot/tests/test_preflight_shared.py: classify_gl, has_new_feedback,
 * ci_failure_needs_session, and the CI-bucket classification helper),
 * adapted to the TS module API, plus run()-level behavior tests driven by
 * fixture fetches (zero network). The GitHub-specific sticky-review bucket
 * tests (changes_requested / review: issues) have no gl_mr_status
 * equivalent — classify_gl never emits those issues — and live with the
 * gh-pr-status port (REHOR-260).
 */

const PROXY_BASE = "https://proxy.example/devbot-proxy";
const REPOS = {
  "my-repo": { upstream: "https://gitlab.cee.redhat.com/team/my-repo.git" },
};

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function glTask(overrides = {}) {
  return {
    external_key: "TEST-1",
    status: "pr_open",
    repo: "my-repo",
    metadata: { prs: [{ repo: "team/my-repo", number: 42, host: "gitlab" }] },
    ...overrides,
  };
}

/** Fixture fetch serving MR and notes endpoints from maps keyed `project/num`. */
function createGitlabFetch({ mrs = {}, notes = {}, mrFailures = {}, noteFailures = {} } = {}) {
  return async (url) => {
    const target = String(url);
    const notesMatch = /\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)\/notes/.exec(target);
    if (notesMatch) {
      const key = `${decodeURIComponent(notesMatch[1])}/${notesMatch[2]}`;
      if (key in noteFailures) return noteFailures[key];
      return jsonResponse(notes[key] ?? []);
    }
    const mrMatch = /\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)$/.exec(target);
    if (mrMatch) {
      const key = `${decodeURIComponent(mrMatch[1])}/${mrMatch[2]}`;
      if (key in mrFailures) return mrFailures[key];
      const mr = mrs[key];
      if (mr === undefined) throw new Error(`unexpected MR fetch: ${target}`);
      return jsonResponse(mr);
    }
    throw new Error(`unexpected fetch: ${target}`);
  };
}

/** Build a run context with fixture memory and GitLab (proxy route) fetches. */
function runCtx(tasks, gitlabFetch, repos = REPOS) {
  return createPreflightRunContext({
    instanceId: "test-instance",
    memory: {
      baseUrl: "http://memory.test",
      fetch: async () => jsonResponse({ items: tasks }),
    },
    proxy: { baseUrl: PROXY_BASE, fetch: gitlabFetch },
    repos,
  });
}

/** Port of the Python `_make_ci_enriched` helper, with GL-shaped issues. */
function makeEnriched({ lastAddressed, issues = ["ci_fail"], notes = [] } = {}) {
  const task = {
    external_key: "TEST-1",
    status: "pr_open",
    repo: "test-repo",
    ...(lastAddressed === undefined ? {} : { last_addressed: lastAddressed }),
  };
  return {
    task,
    prs: [{ repo: "test-repo", num: 1, host: "gitlab", state: "OPENED", issues, data: {} }],
    mrNotes: notes,
    issues,
  };
}

// --- classifyGl ---

test("classifyGl reports merged MRs", () => {
  const { state, issues } = classifyGl({ state: "merged" });
  assert.equal(state, "MERGED");
  assert.deepEqual(issues, ["merged"]);
});

test("classifyGl reports clean opened MRs", () => {
  const { state, issues } = classifyGl({
    state: "opened",
    has_conflicts: false,
    blocking_discussions_resolved: true,
  });
  assert.equal(state, "OPENED");
  assert.deepEqual(issues, []);
});

test("classifyGl flags conflicts", () => {
  const { issues } = classifyGl({ state: "opened", has_conflicts: true });
  assert.equal(issues.includes("conflict"), true);
});

test("classifyGl flags failed pipelines", () => {
  const { issues } = classifyGl({ state: "opened", head_pipeline: { status: "failed" } });
  assert.equal(issues.includes("ci_fail"), true);
});

test("classifyGl flags unresolved threads", () => {
  const { issues } = classifyGl({ state: "opened", blocking_discussions_resolved: false });
  assert.equal(issues.includes("unresolved_threads"), true);
});

// --- hasNewFeedback ---

test("hasNewFeedback sees notes newer than last_addressed", () => {
  const enriched = {
    task: { last_addressed: "2026-06-30T10:00" },
    mrNotes: [{ a: "reviewer", t: "2026-07-01T10:00", b: "needs work" }],
  };
  assert.equal(hasNewFeedback(enriched), true);
});

test("hasNewFeedback ignores notes older than last_addressed", () => {
  const enriched = {
    task: { last_addressed: "2026-07-01T12:00" },
    mrNotes: [{ a: "reviewer", t: "2026-07-01T10:00", b: "needs work" }],
  };
  assert.equal(hasNewFeedback(enriched), false);
});

test("hasNewFeedback ignores bot notes", () => {
  const enriched = {
    task: { last_addressed: "2026-06-30T10:00" },
    mrNotes: [{ a: "my-app[bot]", t: "2026-07-01T10:00", b: "automated check" }],
  };
  assert.equal(hasNewFeedback(enriched), false);
});

// --- ciFailureNeedsSession ---

test("addressed CI failure does not need another session", () => {
  const enriched = {
    task: { last_addressed: "2026-09-02T10:09:00+00:00" },
    mrNotes: [],
  };
  assert.equal(ciFailureNeedsSession(enriched), false);
});

// --- bucket classification (ports of the Python `_classify_bucket` tests) ---

test("CI-only failure with last_addressed and no new feedback is clean", () => {
  const buckets = bucketGlMrStatuses([makeEnriched({ lastAddressed: "2026-07-14T17:49" })], false);
  assert.equal(buckets.clean.length, 1);
  assert.equal(buckets.ciFail.length, 0);
});

test("CI-only failure without last_addressed is actionable", () => {
  const buckets = bucketGlMrStatuses([makeEnriched({ lastAddressed: undefined })], false);
  assert.equal(buckets.ciFail.length, 1);
  assert.equal(buckets.clean.length, 0);
});

test("CI failure combined with conflict is actionable", () => {
  const buckets = bucketGlMrStatuses(
    [makeEnriched({ lastAddressed: "2026-07-14T17:49", issues: ["ci_fail", "conflict"] })],
    false,
  );
  assert.equal(buckets.ciFail.length, 1);
  assert.equal(buckets.clean.length, 0);
});

test("CI failure combined with unresolved discussions is actionable", () => {
  const buckets = bucketGlMrStatuses(
    [
      makeEnriched({
        lastAddressed: "2026-07-14T17:49",
        issues: ["ci_fail", "unresolved_threads"],
      }),
    ],
    false,
  );
  assert.equal(buckets.ciFail.length, 1);
  assert.equal(buckets.clean.length, 0);
});

test("CI-only failure with new human feedback is actionable", () => {
  const buckets = bucketGlMrStatuses(
    [
      makeEnriched({
        lastAddressed: "2026-07-14T10:00",
        notes: [{ a: "reviewer", t: "2026-07-14T18:00", b: "can you retry CI?" }],
      }),
    ],
    false,
  );
  assert.equal(buckets.ciFail.length, 1);
  assert.equal(buckets.clean.length, 0);
});

test("CI-only failure with only old feedback is clean", () => {
  const buckets = bucketGlMrStatuses(
    [
      makeEnriched({
        lastAddressed: "2026-07-14T18:00",
        notes: [{ a: "reviewer", t: "2026-07-14T10:00", b: "can you retry CI?" }],
      }),
    ],
    false,
  );
  assert.equal(buckets.clean.length, 1);
  assert.equal(buckets.ciFail.length, 0);
});

test("merged task stays actionable without the suppress flag", () => {
  const buckets = bucketGlMrStatuses(
    [makeEnriched({ lastAddressed: "2026-07-14T17:49", issues: ["merged"] })],
    false,
  );
  assert.equal(buckets.merged.length, 1);
  assert.equal(buckets.clean.length, 0);
});

test("merged task suppressed when addressed without new feedback", () => {
  const buckets = bucketGlMrStatuses(
    [makeEnriched({ lastAddressed: "2026-07-14T17:49", issues: ["merged"] })],
    true,
  );
  assert.equal(buckets.merged.length, 0);
  assert.equal(buckets.clean.length, 1);
});

test("closed task with new feedback stays actionable even when suppressed", () => {
  const buckets = bucketGlMrStatuses(
    [
      makeEnriched({
        lastAddressed: "2026-07-14T10:00",
        issues: ["closed"],
        notes: [{ a: "reviewer", t: "2026-07-14T18:00", b: "reopened?" }],
      }),
    ],
    true,
  );
  assert.equal(buckets.closed.length, 1);
  assert.equal(buckets.clean.length, 0);
});

// --- run() ---

test("run skips when there are no active tasks", async () => {
  const ctx = runCtx(
    [{ external_key: "T-1", status: "done", repo: "r" }],
    createGitlabFetch({ mrs: { "team/my-repo/42": { state: "merged" } } }),
  );

  const result = await glMrStatus.run(ctx, {});

  assert.deepEqual(result, {
    status: "skip",
    content: "GL MR status: no active tasks (capacity 0/10)",
  });
});

test("run skips when active tasks have no GitLab MRs", async () => {
  const ctx = runCtx(
    [
      glTask({ metadata: { prs: [{ repo: "org/gh-repo", number: 5, host: "github" }] } }),
      glTask({ external_key: "TEST-2", metadata: {} }),
    ],
    createGitlabFetch(),
  );

  const result = await glMrStatus.run(ctx, {});

  assert.deepEqual(result, {
    status: "skip",
    content: "GL MR status: no GL MRs to check (2 active tasks)",
  });
});

test("run starts on an actionable CI failure", async () => {
  const ctx = runCtx(
    [glTask()],
    createGitlabFetch({
      mrs: { "team/my-repo/42": { state: "opened", head_pipeline: { status: "failed" } } },
    }),
  );

  const result = await glMrStatus.run(ctx, {});

  assert.equal(result.status, "start");
  assert.match(result.content, /^## GL MR Status \(1 MRs checked\)$/m);
  assert.match(result.content, /^### CI FAILING \(1\)$/m);
  assert.match(result.content, /^TEST-1 \[pr_open\] my-repo$/m);
  assert.match(result.content, /^ {2}MR team\/my-repo!42 \(gitlab\) state=OPENED \[ci_fail\]$/m);
  assert.deepEqual(ctx.state.get("gl_mr"), {
    merged: 0,
    closed: 0,
    ci_fail: 1,
    conflicts: 0,
    feedback: 0,
    clean: 0,
  });
  assert.equal(ctx.state.get("has_actionable"), true);
});

test("run skips with a CLEAN section when MRs are healthy", async () => {
  const ctx = runCtx(
    [glTask({ last_addressed: "2026-07-01T12:00" })],
    createGitlabFetch({
      mrs: {
        "team/my-repo/42": {
          state: "opened",
          has_conflicts: false,
          blocking_discussions_resolved: true,
          head_pipeline: { status: "success" },
        },
      },
      notes: {
        "team/my-repo/42": [
          {
            author: { username: "my-app[bot]" },
            created_at: "2026-07-01T10:00:00Z",
            body: "auto",
            system: false,
          },
        ],
      },
    }),
  );

  const result = await glMrStatus.run(ctx, {});

  assert.equal(result.status, "skip");
  assert.match(result.content, /^### CLEAN \(1\)$/m);
  assert.match(result.content, /^ {2}TEST-1 \[pr_open\] my-repo$/m);
  assert.equal(result.content.includes("CI FAILING"), false);
  assert.deepEqual(ctx.state.get("gl_mr"), {
    merged: 0,
    closed: 0,
    ci_fail: 0,
    conflicts: 0,
    feedback: 0,
    clean: 1,
  });
  assert.equal(ctx.state.get("has_actionable"), false);
});

test("run buckets new human feedback with formatted notes", async () => {
  const ctx = runCtx(
    [glTask({ last_addressed: "2026-06-30T10:00" })],
    createGitlabFetch({
      mrs: { "team/my-repo/42": { state: "opened", blocking_discussions_resolved: true } },
      notes: {
        "team/my-repo/42": [
          {
            author: { username: "reviewer" },
            created_at: "2026-07-01T10:00:00Z",
            body: "please fix",
            system: false,
          },
        ],
      },
    }),
  );

  const result = await glMrStatus.run(ctx, {});

  assert.equal(result.status, "start");
  assert.match(result.content, /^### FEEDBACK \(1\)$/m);
  assert.match(result.content, /^ {2}mr_notes \(1, newest first\):$/m);
  assert.match(result.content, /^ {4}\[2026-07-01T10:00\] reviewer:$/m);
  assert.match(result.content, /^ {6}please fix$/m);
});

test("run reports merged MRs as actionable by default", async () => {
  const ctx = runCtx(
    [glTask()],
    createGitlabFetch({ mrs: { "team/my-repo/42": { state: "merged" } } }),
  );

  const result = await glMrStatus.run(ctx, {});

  assert.equal(result.status, "start");
  assert.match(result.content, /^### MERGED \(1\)$/m);
});

test("run suppresses addressed merged MRs when asked", async () => {
  const ctx = runCtx(
    [glTask({ last_addressed: "2026-07-01T12:00" })],
    createGitlabFetch({ mrs: { "team/my-repo/42": { state: "merged" } } }),
  );

  const result = await glMrStatus.run(ctx, { suppress_terminal_if_addressed: true });

  assert.equal(result.status, "skip");
  assert.match(result.content, /^### CLEAN \(1\)$/m);
  assert.equal(result.content.includes("### MERGED"), false);
});

test("run accepts a bare proxy base URL string", async () => {
  // A task with no GitLab MRs skips before any GitLab request, so the
  // string wiring is exercised without touching the network.
  const ctx = createPreflightRunContext({
    instanceId: "test-instance",
    memory: {
      baseUrl: "http://memory.test",
      fetch: async () =>
        jsonResponse({
          items: [
            glTask({ metadata: { prs: [{ repo: "org/gh-repo", number: 5, host: "github" }] } }),
          ],
        }),
    },
    proxy: PROXY_BASE,
    repos: REPOS,
  });

  const result = await glMrStatus.run(ctx, {});

  assert.deepEqual(result, {
    status: "skip",
    content: "GL MR status: no GL MRs to check (1 active tasks)",
  });
});

test("run errors when the proxy route is not wired", async () => {
  const ctx = createPreflightRunContext({
    instanceId: "test-instance",
    memory: {
      baseUrl: "http://memory.test",
      fetch: async () => jsonResponse({ items: [glTask()] }),
    },
  });

  const result = await glMrStatus.run(ctx, {});

  assert.equal(result.status, "error");
  assert.match(result.content, /gl-mr-status: /);
  assert.match(result.content, /proxy/);
});

test("run skips an unfetchable MR but keeps healthy ones", async () => {
  const ctx = runCtx(
    [
      glTask({
        external_key: "TEST-GONE",
        metadata: { prs: [{ repo: "team/gone-repo", number: 7, host: "gitlab" }] },
      }),
      glTask({
        external_key: "TEST-OK",
        metadata: { prs: [{ repo: "team/ok-repo", number: 8, host: "gitlab" }] },
      }),
    ],
    createGitlabFetch({
      mrs: { "team/ok-repo/8": { state: "merged" } },
      mrFailures: { "team/gone-repo/7": new Response("not found", { status: 404 }) },
    }),
  );

  const result = await glMrStatus.run(ctx, {});

  assert.equal(result.status, "start");
  assert.match(result.content, /^### MERGED \(1\)$/m);
  assert.equal(result.content.includes("TEST-GONE"), false);
  // The isolated 404 is recorded as evidence, not silently dropped.
  assert.match(result.content, /^### UNFETCHABLE \(1\)$/m);
  assert.match(result.content, /MR team\/gone-repo!7: HTTP 404/);
});

test("run errors when no MR could be fetched and the route answered 404", async () => {
  const ctx = runCtx(
    [glTask()],
    createGitlabFetch({
      mrFailures: { "team/my-repo/42": new Response("no such route", { status: 404 }) },
    }),
  );

  const result = await glMrStatus.run(ctx, {});

  assert.equal(result.status, "error");
  assert.equal(result.content.includes("https://proxy.example/devbot-proxy/gitlab"), true);
});

test("run errors when the memory server rejects authorization", async () => {
  const ctx = createPreflightRunContext({
    instanceId: "test-instance",
    memory: {
      baseUrl: "http://memory.test",
      fetch: async () => new Response("denied", { status: 401 }),
    },
    proxy: { baseUrl: PROXY_BASE, fetch: createGitlabFetch() },
  });

  const result = await glMrStatus.run(ctx, {});

  assert.equal(result.status, "error");
  assert.equal(result.content.includes("authenticated request rejected (401)"), true);
});

test("run keeps has_actionable sticky across runs in one context", async () => {
  const memory = createMemoryServerClient({
    baseUrl: "http://memory.test",
    fetch: async () => jsonResponse({ items: [glTask()] }),
  });
  const state = createRunState();
  const actionable = createGitlabClient({
    baseUrl: PROXY_BASE,
    fetch: createGitlabFetch({
      mrs: { "team/my-repo/42": { state: "opened", head_pipeline: { status: "failed" } } },
    }),
  });
  const settled = createGitlabClient({
    baseUrl: PROXY_BASE,
    fetch: createGitlabFetch({
      mrs: { "team/my-repo/42": { state: "opened", blocking_discussions_resolved: true } },
    }),
  });

  const first = await runGlMrStatus(
    { memory, state, gitlab: actionable, repos: REPOS },
    { suppress_terminal_if_addressed: false },
  );
  assert.equal(first.status, "start");
  assert.equal(state.get("has_actionable"), true);

  const second = await runGlMrStatus(
    { memory, state, gitlab: settled, repos: REPOS },
    { suppress_terminal_if_addressed: false },
  );
  assert.equal(second.status, "skip");
  assert.equal(state.get("has_actionable"), true);
});

test("run resolves bare repo names through the run-context repos map", async () => {
  const ctx = runCtx(
    [glTask({ metadata: {}, pr_number: 7, title: "do the thing" })],
    createGitlabFetch({ mrs: { "team/my-repo/7": { state: "merged" } } }),
  );

  const result = await glMrStatus.run(ctx, {});

  assert.equal(result.status, "start");
  assert.match(result.content, /^ {2}MR my-repo!7 \(gitlab\) state=MERGED \[merged\]$/m);
  assert.match(result.content, /^ {2}title: do the thing$/m);
});

// --- the shared failure policy (shared/failure-policy.ts) ---
// Every attempted fetch of a class failing is an execution error naming
// the required route — auth, rate limit, upstream 5xx, network/timeout,
// and the all-404 route outage alike. Isolated failures keep the run
// going with recorded evidence.

const goneGlTask = (key, repo, number) => ({
  external_key: key,
  status: "pr_open",
  repo,
  metadata: { prs: [{ repo, number, host: "gitlab" }] },
});

const outageResponses = [
  ["401 (auth)", () => new Response("denied", { status: 401 }), "HTTP 401"],
  ["403 (auth)", () => new Response("forbidden", { status: 403 }), "HTTP 403"],
  ["429 (rate limit)", () => new Response("slow down", { status: 429 }), "HTTP 429"],
  ["502 (bad gateway)", () => new Response("bad gateway", { status: 502 }), "HTTP 502"],
  ["503 (unavailable)", () => new Response("unavailable", { status: 503 }), "HTTP 503"],
  [
    "a network failure",
    () => {
      throw new TypeError("fetch failed");
    },
    "network or timeout failure",
  ],
  [
    "a timeout",
    () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    },
    "network or timeout failure",
  ],
];

for (const [label, respond, reason] of outageResponses) {
  test(`run errors when the only MR fetch fails with ${label}`, async () => {
    const ctx = runCtx([glTask()], async () => {
      return respond();
    });

    const result = await glMrStatus.run(ctx, {});

    assert.equal(result.status, "error");
    assert.equal(
      result.content,
      "gl-mr-status: GitLab route https://proxy.example/devbot-proxy/gitlab is not usable: " +
        `1 MR fetch attempted, 0 succeeded (team/my-repo!42: ${reason})`,
    );
  });
}

test("run errors when every MR fetch fails with an outage, not just the first", async () => {
  const ctx = runCtx(
    [goneGlTask("TEST-A", "team/a-repo", 5), goneGlTask("TEST-B", "team/b-repo", 6)],
    createGitlabFetch({
      mrFailures: {
        "team/a-repo/5": new Response("unavailable", { status: 503 }),
        "team/b-repo/6": new Response("unavailable", { status: 503 }),
      },
    }),
  );

  const result = await glMrStatus.run(ctx, {});

  assert.equal(result.status, "error");
  assert.match(result.content, /2 MR fetches attempted, 0 succeeded/);
  assert.match(result.content, /team\/a-repo!5: HTTP 503/);
  assert.match(result.content, /team\/b-repo!6: HTTP 503/);
});

test("run keeps actionable work when an isolated MR fetch fails with a 5xx", async () => {
  const ctx = runCtx(
    [goneGlTask("TEST-GONE", "team/gone-repo", 7), goneGlTask("TEST-OK", "team/ok-repo", 8)],
    createGitlabFetch({
      mrs: { "team/ok-repo/8": { state: "merged" } },
      mrFailures: { "team/gone-repo/7": new Response("unavailable", { status: 503 }) },
    }),
  );

  const result = await glMrStatus.run(ctx, {});

  assert.equal(result.status, "start");
  assert.match(result.content, /^### MERGED \(1\)$/m);
  assert.match(result.content, /^### UNFETCHABLE \(1\)$/m);
  assert.match(result.content, /MR team\/gone-repo!7: HTTP 503/);
  assert.equal(result.content.includes("TEST-GONE"), false);
});

test("run tolerates an isolated MR-notes failure and records it", async () => {
  const ctx = runCtx(
    [goneGlTask("TEST-GONE", "team/gone-repo", 7), goneGlTask("TEST-OK", "team/ok-repo", 8)],
    createGitlabFetch({
      mrs: { "team/gone-repo/7": { state: "merged" }, "team/ok-repo/8": { state: "merged" } },
      noteFailures: { "team/gone-repo/7": new Response("denied", { status: 403 }) },
    }),
  );

  const result = await glMrStatus.run(ctx, {});

  assert.equal(result.status, "start");
  assert.match(result.content, /^### MERGED \(2\)$/m);
  assert.match(result.content, /^### UNFETCHABLE \(1\)$/m);
  assert.match(result.content, /MR notes team\/gone-repo!7: HTTP 403/);
});

test("run errors when every fetched MR's notes fail (feedback would be erased)", async () => {
  const ctx = runCtx(
    [glTask({ last_addressed: "2026-07-01T12:00" })],
    createGitlabFetch({
      mrs: { "team/my-repo/42": { state: "opened", blocking_discussions_resolved: true } },
      noteFailures: { "team/my-repo/42": new Response("unavailable", { status: 503 }) },
    }),
  );

  const result = await glMrStatus.run(ctx, {});

  assert.equal(result.status, "error");
  assert.equal(
    result.content,
    "gl-mr-status: GitLab route https://proxy.example/devbot-proxy/gitlab is not usable: " +
      "1 MR note fetch attempted, 0 succeeded (team/my-repo!42: HTTP 503)",
  );
});
