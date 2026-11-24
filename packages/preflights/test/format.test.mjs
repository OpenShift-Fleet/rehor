import assert from "node:assert/strict";
import test from "node:test";
import { fmtComments, fmtTaskHeader, getTaskPrs, isBotAuthor } from "../dist/shared/format.js";

// --- is_bot_author (ported from bot/tests/test_preflight_shared.py) ---

test("isBotAuthor detects known bot authors", () => {
  assert.equal(isBotAuthor("dependabot"), true);
  assert.equal(isBotAuthor("renovate"), true);
  assert.equal(isBotAuthor("github-actions"), true);
  assert.equal(isBotAuthor("my-app[bot]"), true);
  assert.equal(isBotAuthor("coderabbit-bot"), true);
  assert.equal(isBotAuthor("openshift-ci-robot"), true);
});

test("isBotAuthor passes humans through", () => {
  assert.equal(isBotAuthor("florkbr"), false);
  assert.equal(isBotAuthor("martin"), false);
  assert.equal(isBotAuthor(""), false);
  assert.equal(isBotAuthor("?"), false);
  assert.equal(isBotAuthor(null), false);
  assert.equal(isBotAuthor(undefined), false);
});

// --- fmt_comments (ported) ---

test("fmtComments renders empty input as none", () => {
  assert.equal(fmtComments([], "test"), "  test: (none)");
  assert.equal(fmtComments(undefined, "test"), "  test: (none)");
});

test("fmtComments filters by since and keeps newer comments", () => {
  const comments = [
    { a: "alice", t: "2026-06-30T10:00", b: "old" },
    { a: "bob", t: "2026-07-01T10:00", b: "new" },
  ];
  const result = fmtComments(comments, "test", "2026-06-30T12:00");
  assert.match(result, /bob/);
  assert.doesNotMatch(result, /old/);
});

test("fmtComments reports when everything was filtered", () => {
  const comments = [{ a: "alice", t: "2026-06-30T10:00", b: "old" }];
  const result = fmtComments(comments, "test", "2026-07-01T00:00");
  assert.match(result, /none since last_addressed/);
});

test("fmtComments truncates to the newest maxComments with a footer", () => {
  const comments = Array.from({ length: 40 }, (_unused, i) => ({
    a: `user${i}`,
    t: `2026-07-01T${String(i).padStart(2, "0")}:00`,
    b: `msg ${i}`,
  }));
  const result = fmtComments(comments, "test", undefined, 10);
  assert.match(result, /truncated/);
  assert.match(result, /showing 10/);
  assert.match(result, /\(10, newest first\)/);
});

test("fmtComments does not truncate small lists", () => {
  const result = fmtComments(
    [{ a: "alice", t: "2026-07-01T10:00", b: "hi" }],
    "test",
    undefined,
    30,
  );
  assert.doesNotMatch(result, /truncated/);
});

test("fmtComments shows same-minute comments posted after last_addressed", () => {
  // Regression RHCLOUD-53177: 08:59:41 vs last_addressed 08:59:05.
  const comments = [{ a: "karelhala", t: "2026-11-10T08:59:41.053+0000", b: "please respond" }];
  const result = fmtComments(comments, "test", "2026-11-10T08:59:05.470894+00:00");
  assert.match(result, /karelhala/);
  assert.doesNotMatch(result, /none since last_addressed/);
});

test("fmtComments renders newest first with indented bodies", () => {
  const comments = [
    { a: "alice", t: "2026-07-01T10:00:00Z", b: "first line\nsecond line" },
    { a: "bob", t: "2026-07-02T10:00:00Z", b: "later" },
  ];
  const result = fmtComments(comments, "pr_comments");
  const lines = result.split("\n");
  assert.equal(lines[0], "  pr_comments (2, newest first):");
  assert.equal(lines[1], "    [2026-07-02T10:00] bob:");
  assert.equal(lines[2], "      later");
  assert.equal(lines[3], "    [2026-07-01T10:00] alice:");
  assert.equal(lines[4], "      first line");
  assert.equal(lines[5], "      second line");
});

test("fmtComments reads author/body from a/author, t/created, b/body keys", () => {
  const result = fmtComments(
    [
      { author: { displayName: "Carol" }, created: "2026-07-01T10:00:00Z", body: "jira style" },
      { author: "dave", created: "2026-07-02T10:00:00Z", body: "scalar author" },
      { created: "2026-07-03T10:00:00Z", body: "missing author" },
    ],
    "c",
  );
  assert.match(result, /Carol:$/m);
  assert.match(result, /dave:$/m);
  assert.match(result, /\?:$/m);
  assert.match(result, /jira style/);
});

// --- fmt_task_header ---

test("fmtTaskHeader renders the common task fields", () => {
  const lines = fmtTaskHeader({
    external_key: "REHOR-1",
    status: "in_progress",
    repo: "my-repo",
    title: "Do the thing",
    summary: "x".repeat(200),
    metadata: { last_step: "implementation" },
    last_addressed: "2026-11-10T08:59:41Z",
  });
  assert.deepEqual(lines, [
    "REHOR-1 [in_progress] my-repo",
    "  title: Do the thing",
    `  summary: ${"x".repeat(150)}`,
    "  last_step: implementation",
    "  last_addressed: 2026-11-10T08:59:41Z",
  ]);
});

test("fmtTaskHeader degrades to placeholders for missing fields", () => {
  assert.deepEqual(fmtTaskHeader({}), ["? [?] ?"]);
  assert.deepEqual(fmtTaskHeader({ metadata: {} }), ["? [?] ?"]);
});

// --- get_task_prs ---

test("getTaskPrs merges metadata prs and mrs", () => {
  const task = {
    metadata: {
      prs: [{ repo: "org/repo", number: 1, host: "github" }],
      mrs: [{ repo: "team/repo", number: 2, host: "gitlab" }],
    },
  };
  assert.deepEqual(getTaskPrs(task, {}), [
    { repo: "org/repo", number: 1, host: "github" },
    { repo: "team/repo", number: 2, host: "gitlab" },
  ]);
});

test("getTaskPrs extracts PRs from pull_request artifact URLs", () => {
  const task = {
    artifacts: [
      { type: "pull_request", url: "https://github.com/org/repo/pull/42" },
      {
        type: "pull_request",
        url: "https://gitlab.cee.redhat.com/group/sub/project/-/merge_requests/7",
      },
      { type: "pull_request", url: "https://example.com/not-a-pr" },
      { type: "commit", url: "https://github.com/org/repo/pull/99" },
    ],
  };
  assert.deepEqual(getTaskPrs(task, {}), [
    { repo: "org/repo", number: 42, host: "github" },
    { repo: "group/sub/project", number: 7, host: "gitlab" },
  ]);
});

test("getTaskPrs falls back to pr_number with the repo's host", () => {
  const repos = {
    "app-interface": {
      upstream: "https://gitlab.cee.redhat.com/service/app-interface.git",
      host: "gitlab",
    },
    "my-repo": { upstream: "https://github.com/org/my-repo.git" },
  };
  assert.deepEqual(getTaskPrs({ repo: "app-interface", pr_number: 5 }, repos), [
    { repo: "app-interface", number: 5, host: "gitlab" },
  ]);
  assert.deepEqual(getTaskPrs({ repo: "my-repo", pr_number: 7 }, repos), [
    { repo: "my-repo", number: 7, host: "github" },
  ]);
});

test("getTaskPrs returns nothing for tasks without PR information", () => {
  assert.deepEqual(getTaskPrs({}, {}), []);
  assert.deepEqual(getTaskPrs({ repo: "unknown-repo", pr_number: 0 }, {}), []);
  assert.deepEqual(getTaskPrs({ artifacts: [{ type: "pull_request" }] }, {}), []);
});
