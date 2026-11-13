import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { classifyGh } from "../dist/preflights/gh-pr-status/classify.js";
import {
  ciFailureNeedsSession,
  classifyBuckets,
  ghPrStatus,
  hasNewFeedback,
  runGhPrStatus,
} from "../dist/preflights/gh-pr-status/index.js";
import { createGitHubClient } from "../dist/shared/github.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";
import { createPreflightRunContext, createRunState } from "../dist/shared/run-context.js";

/**
 * Port of the Python test coverage for `gh_pr_status.py`
 * (`bot/tests/test_gh_pr_status.py` and the gh half of
 * `bot/tests/test_preflight_shared.py`), adapted to the TS module API.
 * Fixture-based only: the memory-server and GitHub clients take an
 * injectable fetch, so no test touches the network.
 */

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const readFixture = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

// --- classifyGh (Python classify_gh) ---

const makePr = ({
  state = "OPEN",
  mergeable = "MERGEABLE",
  reviews = [],
  checks = [],
  reviewDecision,
} = {}) => ({
  state,
  mergeable,
  reviews,
  statusCheckRollup: checks,
  ...(reviewDecision ? { reviewDecision } : {}),
});

test("merged PR reports the merged issue", () => {
  const { state, issues } = classifyGh(makePr({ state: "MERGED" }));
  assert.equal(state, "MERGED");
  assert.deepEqual(issues, ["merged"]);
});

test("closed PR reports the closed issue", () => {
  const { state, issues } = classifyGh(makePr({ state: "CLOSED" }));
  assert.equal(state, "CLOSED");
  assert.deepEqual(issues, ["closed"]);
});

test("conflicting PR reports a conflict", () => {
  const { issues } = classifyGh(makePr({ mergeable: "CONFLICTING" }));
  assert.ok(issues.includes("conflict"));
});

test("failing check reports ci_fail with the check name", () => {
  const checks = [{ name: "lint", conclusion: "FAILURE" }];
  const { issues } = classifyGh(makePr({ checks }));
  assert.ok(issues.includes("ci_fail:lint"));
});

test("ci failure lists every failed check and keeps passing checks out", () => {
  const checks = [
    { name: "lint", conclusion: "SUCCESS" },
    { name: "test", conclusion: "FAILURE" },
  ];
  const { issues } = classifyGh(makePr({ checks }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0], "ci_fail:test");
});

test("changes-requested review reports review:<author>", () => {
  const reviews = [
    { state: "CHANGES_REQUESTED", author: { login: "alice" }, submittedAt: "2026-07-03T10:00:00Z" },
  ];
  const { issues } = classifyGh(makePr({ reviews }));
  assert.ok(issues.includes("review:alice"));
});

test("commented review with a long body reports review_comment:<author>", () => {
  const reviews = [
    {
      state: "COMMENTED",
      author: { login: "bob" },
      body: "This needs a much longer explanation of the approach",
      submittedAt: "2026-07-03T10:00:00Z",
    },
  ];
  const { issues } = classifyGh(makePr({ reviews }));
  assert.ok(issues.includes("review_comment:bob"));
});

test("commented review with a short body is ignored", () => {
  const reviews = [
    {
      state: "COMMENTED",
      author: { login: "bob" },
      body: "LGTM",
      submittedAt: "2026-07-03T10:00:00Z",
    },
  ];
  const { issues } = classifyGh(makePr({ reviews }));
  assert.equal(
    issues.some((issue) => issue.startsWith("review")),
    false,
  );
});

test("clean open PR reports no issues", () => {
  const { state, issues } = classifyGh(makePr());
  assert.equal(state, "OPEN");
  assert.deepEqual(issues, []);
});

// --- last_addressed filtering ---

test("review before last_addressed is ignored", () => {
  const reviews = [
    {
      state: "CHANGES_REQUESTED",
      author: { login: "coderabbitai" },
      submittedAt: "2026-06-30T10:00:00Z",
    },
  ];
  const { issues } = classifyGh(makePr({ reviews }), "2026-07-03T07:37:00+00:00");
  assert.equal(issues.includes("review:coderabbitai"), false);
  assert.deepEqual(issues, []);
});

test("review after last_addressed is kept", () => {
  const reviews = [
    { state: "CHANGES_REQUESTED", author: { login: "alice" }, submittedAt: "2026-07-03T09:00:00Z" },
  ];
  const { issues } = classifyGh(makePr({ reviews }), "2026-07-03T07:37:00+00:00");
  assert.ok(issues.includes("review:alice"));
});

test("without last_addressed all reviews are considered", () => {
  const reviews = [
    { state: "CHANGES_REQUESTED", author: { login: "alice" }, submittedAt: "2026-06-20T10:00:00Z" },
  ];
  const { issues } = classifyGh(makePr({ reviews }), "");
  assert.ok(issues.includes("review:alice"));
});

test("only new reviews trigger; old ones are filtered out", () => {
  const reviews = [
    {
      state: "CHANGES_REQUESTED",
      author: { login: "coderabbitai" },
      submittedAt: "2026-06-28T10:00:00Z",
    },
    { state: "CHANGES_REQUESTED", author: { login: "alice" }, submittedAt: "2026-07-03T09:00:00Z" },
  ];
  const { issues } = classifyGh(makePr({ reviews }), "2026-07-03T07:37:00+00:00");
  assert.equal(issues.includes("review:coderabbitai"), false);
  assert.ok(issues.includes("review:alice"));
});

test("review at exactly last_addressed is ignored — already seen", () => {
  const reviews = [
    { state: "CHANGES_REQUESTED", author: { login: "alice" }, submittedAt: "2026-07-03T07:37:00Z" },
  ];
  const { issues } = classifyGh(makePr({ reviews }), "2026-07-03T07:37:00+00:00");
  assert.equal(issues.includes("review:alice"), false);
});

test("review seconds after last_addressed in the same minute is kept", () => {
  // Regression (RHCLOUD-53177): minute-truncated comparison dropped
  // same-minute reviews — full-resolution timestamps must be compared.
  const reviews = [
    { state: "CHANGES_REQUESTED", author: { login: "alice" }, submittedAt: "2026-07-03T07:37:41Z" },
  ];
  const { issues } = classifyGh(makePr({ reviews }), "2026-07-03T07:37:05+00:00");
  assert.ok(issues.includes("review:alice"));
});

test("review seconds before last_addressed in the same minute stays filtered", () => {
  const reviews = [
    { state: "CHANGES_REQUESTED", author: { login: "alice" }, submittedAt: "2026-07-03T07:37:05Z" },
  ];
  const { issues } = classifyGh(makePr({ reviews }), "2026-07-03T07:37:41+00:00");
  assert.equal(issues.includes("review:alice"), false);
});

test("conflicts and CI failures are current state — last_addressed does not filter them", () => {
  const checks = [{ name: "lint", conclusion: "FAILURE" }];
  const { issues } = classifyGh(
    makePr({ mergeable: "CONFLICTING", checks }),
    "2026-07-03T07:37:00+00:00",
  );
  assert.ok(issues.includes("conflict"));
  assert.ok(issues.includes("ci_fail:lint"));
});

test("changes-requested reviewDecision alone adds no issues", () => {
  const { issues } = classifyGh(makePr({ reviewDecision: "CHANGES_REQUESTED" }));
  assert.equal(issues.includes("changes_requested"), false);
  assert.equal(
    issues.some((issue) => issue.startsWith("review:")),
    false,
  );
});

test("commented review without submittedAt still counts when last_addressed is empty", () => {
  const reviews = [
    {
      state: "COMMENTED",
      author: { login: "reviewer" },
      body: "This is a substantive review comment that is long enough",
    },
  ];
  const { issues } = classifyGh(makePr({ reviews }));
  assert.ok(issues.some((issue) => issue.includes("review_comment")));
});

// --- feedback detection (Python has_new_feedback) ---

const makeEnriched = ({ lastAddressed, issues = [], prComments = [] } = {}) => ({
  task: {
    external_key: "TEST-1",
    status: "pr_open",
    repo: "test-repo",
    ...(lastAddressed ? { last_addressed: lastAddressed } : {}),
  },
  prs: [{ repo: "test-repo", num: 1, host: "github", state: "OPEN", issues }],
  prComments,
  issues,
});

test("has_new_feedback: new human comment is feedback", () => {
  const enriched = makeEnriched({
    lastAddressed: "2026-06-30T10:00",
    prComments: [{ a: "reviewer", t: "2026-07-01T10:00", b: "please fix this" }],
  });
  assert.equal(hasNewFeedback(enriched), true);
});

test("has_new_feedback: old human comment is not feedback", () => {
  const enriched = makeEnriched({
    lastAddressed: "2026-07-01T12:00",
    prComments: [{ a: "reviewer", t: "2026-07-01T10:00", b: "needs work" }],
  });
  assert.equal(hasNewFeedback(enriched), false);
});

test("has_new_feedback: bot comments are ignored", () => {
  const enriched = makeEnriched({
    lastAddressed: "2026-06-30T10:00",
    prComments: [{ a: "my-app[bot]", t: "2026-07-01T10:00", b: "automated check" }],
  });
  assert.equal(hasNewFeedback(enriched), false);
});

test("has_new_feedback: no last_addressed means every human comment counts", () => {
  const enriched = makeEnriched({
    prComments: [{ a: "reviewer", t: "2020-01-01T10:00", b: "old but unseen" }],
  });
  assert.equal(hasNewFeedback(enriched), true);
});

test("ci failure needs a session when never addressed or new feedback arrived", () => {
  assert.equal(ciFailureNeedsSession(makeEnriched({})), true);
  assert.equal(
    ciFailureNeedsSession(
      makeEnriched({
        lastAddressed: "2026-07-01T10:00",
        prComments: [{ a: "reviewer", t: "2026-07-02T10:00", b: "retry?" }],
      }),
    ),
    true,
  );
  assert.equal(ciFailureNeedsSession(makeEnriched({ lastAddressed: "2026-07-02T10:00" })), false);
});

// --- bucket classification (Python main()) ---

const bucketOf = (enriched, options) => {
  const buckets = classifyBuckets([enriched], options);
  for (const [name, entries] of Object.entries(buckets)) {
    if (entries.length === 1) return name;
  }
  return "(none)";
};

test("review_comment never triggers the unconditional feedback branch", () => {
  // A bot review_comment with no new feedback lands in clean, not feedback.
  const enriched = makeEnriched({
    lastAddressed: "2026-07-01T10:00",
    issues: ["review_comment:coderabbitai[bot]"],
    prComments: [{ a: "coderabbitai[bot]", t: "2026-07-01T08:00", b: "auto review" }],
  });
  assert.equal(bucketOf(enriched), "clean");
});

test("new human review_comment is feedback via has_new_feedback", () => {
  const enriched = makeEnriched({
    lastAddressed: "2026-06-30T10:00",
    issues: ["review_comment:reviewer"],
    prComments: [{ a: "reviewer", t: "2026-07-01T10:00", b: "please fix this" }],
  });
  assert.equal(bucketOf(enriched), "feedback");
});

test("changes_requested and review:<author> reach the feedback branch", () => {
  // Without last_addressed these must be feedback even with no comments.
  assert.equal(bucketOf(makeEnriched({ issues: ["changes_requested"] })), "feedback");
  assert.equal(bucketOf(makeEnriched({ issues: ["review:someuser"] })), "feedback");
});

test("old addressed review issue with last_addressed lands in clean", () => {
  const enriched = makeEnriched({
    lastAddressed: "2026-07-01T10:00",
    issues: ["review:reviewer"],
  });
  assert.equal(bucketOf(enriched), "clean");
});

const makeCiEnriched = ({ lastAddressed, extraIssues = [], prComments = [] } = {}) =>
  makeEnriched({
    lastAddressed,
    issues: ["ci_fail:lint,test", ...extraIssues],
    prComments,
  });

test("ci-only failure with last_addressed and no new feedback is clean", () => {
  assert.equal(bucketOf(makeCiEnriched({ lastAddressed: "2026-07-14T17:49" })), "clean");
});

test("ci-only failure without last_addressed is actionable", () => {
  assert.equal(bucketOf(makeCiEnriched({})), "ciFail");
});

test("ci failure combined with conflict is actionable even when addressed", () => {
  assert.equal(
    bucketOf(makeCiEnriched({ lastAddressed: "2026-07-14T17:49", extraIssues: ["conflict"] })),
    "ciFail",
  );
});

test("ci failure combined with unresolved threads stays actionable", () => {
  assert.equal(
    bucketOf(
      makeCiEnriched({ lastAddressed: "2026-07-14T17:49", extraIssues: ["unresolved_threads"] }),
    ),
    "ciFail",
  );
});

test("ci-only failure with new human feedback is actionable", () => {
  assert.equal(
    bucketOf(
      makeCiEnriched({
        lastAddressed: "2026-07-14T10:00",
        prComments: [{ a: "reviewer", t: "2026-07-14T18:00", b: "can you retry CI?" }],
      }),
    ),
    "ciFail",
  );
});

test("ci-only failure with last_addressed after the last comment is clean", () => {
  assert.equal(
    bucketOf(
      makeCiEnriched({
        lastAddressed: "2026-07-14T18:00",
        prComments: [{ a: "reviewer", t: "2026-07-14T10:00", b: "can you retry CI?" }],
      }),
    ),
    "clean",
  );
});

test("ci failure with only an already-addressed review is clean", () => {
  // The main bug fix: a sticky old reviewDecision no longer causes false
  // positives — classifyGh filtered the old review, so the issues list is
  // ci-only and the task is clean.
  assert.equal(bucketOf(makeCiEnriched({ lastAddressed: "2026-07-14T18:00" })), "clean");
});

test("ci failure plus a new changes-requested review is actionable", () => {
  assert.equal(
    bucketOf(
      makeCiEnriched({ lastAddressed: "2026-07-14T10:00", extraIssues: ["review:reviewer"] }),
    ),
    "ciFail",
  );
});

test("terminal states can be suppressed when already addressed (onboarding mode)", () => {
  const enriched = makeEnriched({ lastAddressed: "2026-07-01T10:00", issues: ["merged"] });
  assert.equal(bucketOf(enriched), "merged");
  assert.equal(bucketOf(enriched, { suppressTerminalIfAddressed: true }), "clean");
  const closed = makeEnriched({ lastAddressed: "2026-07-01T10:00", issues: ["closed"] });
  assert.equal(bucketOf(closed, { suppressTerminalIfAddressed: true }), "clean");
  // New feedback still surfaces the terminal state.
  const withFeedback = makeEnriched({
    lastAddressed: "2026-07-01T10:00",
    issues: ["merged"],
    prComments: [{ a: "reviewer", t: "2026-07-02T10:00", b: "one more thing" }],
  });
  assert.equal(bucketOf(withFeedback, { suppressTerminalIfAddressed: true }), "merged");
});

// --- run flow (Python main()) ---

/**
 * Fixture GitHub client: answers the GraphQL PR query from a gh-view-shaped
 * `pr` fixture and the two comment endpoints from a mapped `comments` list.
 */
const fixtureGitHubClient = (pr, comments = []) =>
  createGitHubClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: async (url, init) => {
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(init.body);
        assert.equal(body.variables.number !== undefined, true);
        return jsonResponse({
          data: {
            repository: {
              pullRequest:
                pr === null
                  ? null
                  : {
                      state: pr.state,
                      mergeable: pr.mergeable,
                      reviewDecision: pr.reviewDecision ?? null,
                      url: pr.url ?? null,
                      title: pr.title ?? null,
                      isDraft: pr.isDraft ?? false,
                      reviews: { nodes: pr.reviews ?? [] },
                      statusCheckRollup: {
                        contexts: {
                          nodes: (pr.statusCheckRollup ?? []).map((entry) => ({
                            __typename: "CheckRun",
                            name: entry.name,
                            conclusion: entry.conclusion,
                            detailsUrl: entry.detailsUrl ?? null,
                          })),
                        },
                      },
                    },
            },
          },
        });
      }
      // REST comment endpoints (fixture comments are already {a, t, b}).
      if (url.includes("/pulls/") && url.endsWith("/comments")) {
        return jsonResponse(
          comments.slice(0, 1).map((c) => ({ user: { login: c.a }, created_at: c.t, body: c.b })),
        );
      }
      return jsonResponse(
        comments.slice(1).map((c) => ({ user: { login: c.a }, created_at: c.t, body: c.b })),
      );
    },
  });

const fixtureMemoryClient = (tasks) =>
  createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async () => jsonResponse({ items: tasks }),
  });

test("no active tasks skips with the capacity summary", async () => {
  const state = createRunState();
  const result = await runGhPrStatus({
    memory: fixtureMemoryClient([{ external_key: "X-1", status: "done" }]),
    state,
    github: fixtureGitHubClient(null),
  });
  assert.deepEqual(result, {
    status: "skip",
    content: "GH PR status: no active tasks (capacity 0/10)",
  });
});

test("active tasks without GitHub PRs skip with the active count", async () => {
  const state = createRunState();
  const result = await runGhPrStatus({
    memory: fixtureMemoryClient([
      {
        external_key: "X-1",
        status: "in_progress",
        repo: "repo",
        metadata: { prs: [{ repo: "repo", number: 5, host: "gitlab" }] },
      },
    ]),
    state,
    github: fixtureGitHubClient(null),
  });
  assert.deepEqual(result, {
    status: "skip",
    content: "GH PR status: no GH PRs to check (1 active tasks)",
  });
});

test("production cycle 39824: addressed sticky review and CI failure stay clean", async () => {
  const fixture = await readFixture("cycle-39824-gh.json");
  const state = createRunState();
  const result = await runGhPrStatus({
    memory: fixtureMemoryClient([fixture.task]),
    state,
    github: fixtureGitHubClient(fixture.pr, fixture.comments),
    repos: {
      "notifications-frontend": {
        upstream: "https://github.com/RedHatInsights/notifications-frontend",
      },
    },
  });
  assert.equal(result.status, "skip");
  assert.equal(result.content.includes("CI FAILING"), false);
  assert.equal(result.content.includes("CLEAN"), true);
  assert.deepEqual(state.get("gh_pr"), {
    merged: 0,
    closed: 0,
    ci_fail: 0,
    conflicts: 0,
    feedback: 0,
    clean: 1,
  });
  assert.equal(state.get("has_actionable"), false);
});

test("production cycle 39746: automated CI robot comments are not feedback", async () => {
  const fixture = await readFixture("cycle-39746-gh.json");
  const state = createRunState();
  const result = await runGhPrStatus({
    memory: fixtureMemoryClient([fixture.task]),
    state,
    github: fixtureGitHubClient(fixture.pr, fixture.comments),
    repos: { console: { upstream: "https://github.com/openshift/console" } },
  });
  assert.equal(result.status, "skip");
  assert.equal(result.content.includes("FEEDBACK"), false);
  assert.equal(result.content.includes("CLEAN"), true);
});

test("merged PR starts with the merged bucket and PR line", async () => {
  const task = {
    external_key: "X-1",
    status: "pr_open",
    repo: "demo",
    metadata: { prs: [{ repo: "demo", number: 9, host: "github" }] },
  };
  const state = createRunState();
  const result = await runGhPrStatus({
    memory: fixtureMemoryClient([task]),
    state,
    github: fixtureGitHubClient({ state: "MERGED", mergeable: "MERGEABLE" }),
    repos: { demo: { upstream: "https://github.com/org/demo" } },
  });
  assert.equal(result.status, "start");
  assert.ok(result.content.includes("## GH PR Status (1 PRs checked)"));
  assert.ok(result.content.includes("### MERGED (1)"));
  assert.ok(result.content.includes("PR demo#9 (github) state=MERGED [merged]"));
  assert.equal(state.get("has_actionable"), true);
});

test("ci-failing PR starts and renders Konflux details URLs", async () => {
  const task = {
    external_key: "X-1",
    status: "pr_open",
    repo: "demo",
    last_addressed: "",
    metadata: { prs: [{ repo: "demo", number: 9, host: "github" }] },
  };
  const state = createRunState();
  const result = await runGhPrStatus({
    memory: fixtureMemoryClient([task]),
    state,
    github: fixtureGitHubClient({
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [
        {
          name: "Red Hat Konflux / demo-on-pull-request",
          conclusion: "FAILURE",
          detailsUrl: "https://konflux.example/pipelinerun/9",
        },
      ],
    }),
    repos: { demo: { upstream: "https://github.com/org/demo" } },
  });
  assert.equal(result.status, "start");
  assert.ok(result.content.includes("### CI FAILING (1)"));
  assert.ok(
    result.content.includes(
      "state=OPEN [ci_fail:Red Hat Konflux / demo-on-pull-request,konflux_urls:https://konflux.example/pipelinerun/9]",
    ),
  );
  assert.ok(result.content.includes("    konflux_details: https://konflux.example/pipelinerun/9"));
  assert.deepEqual(state.get("gh_pr"), {
    merged: 0,
    closed: 0,
    ci_fail: 1,
    conflicts: 0,
    feedback: 0,
    clean: 0,
  });
});

test("feedback PR starts and renders filtered pr_comments", async () => {
  const task = {
    external_key: "X-1",
    status: "pr_changes",
    repo: "demo",
    last_addressed: "2026-07-01T10:00",
    metadata: { prs: [{ repo: "demo", number: 9, host: "github" }] },
  };
  const state = createRunState();
  const result = await runGhPrStatus({
    memory: fixtureMemoryClient([task]),
    state,
    github: fixtureGitHubClient(
      {
        state: "OPEN",
        mergeable: "MERGEABLE",
        reviews: [
          {
            state: "CHANGES_REQUESTED",
            author: { login: "alice" },
            submittedAt: "2026-07-02T10:00:00Z",
            body: "Please rework the parsing.",
          },
        ],
      },
      [
        { a: "bob", t: "2026-06-30T10:00", b: "old comment" },
        { a: "carol", t: "2026-07-02T11:00", b: "new comment" },
      ],
    ),
    repos: { demo: { upstream: "https://github.com/org/demo" } },
  });
  assert.equal(result.status, "start");
  assert.ok(result.content.includes("### FEEDBACK (1)"));
  assert.ok(result.content.includes("review:alice"));
  // Comments are rendered newest first, filtered to those after last_addressed.
  assert.ok(result.content.includes("carol"));
  assert.equal(result.content.includes("bob"), false);
  // Review bodies are carried as [REVIEW ...] comment records.
  assert.ok(result.content.includes("[REVIEW CHANGES_REQUESTED] Please rework the parsing."));
});

test("run() errors when the proxy route is not wired", async () => {
  const ctx = createPreflightRunContext({
    instanceId: "bot-1",
    memory: {
      baseUrl: "http://memory:8080",
      fetch: async () => jsonResponse({ items: [] }),
    },
  });
  const result = await ghPrStatus.run(ctx, {});
  assert.equal(result.status, "error");
  assert.match(result.content, /gh-pr-status: /);
  assert.match(result.content, /proxy/);
});

test("run() flows through the wired proxy route, repos map, and run context", async () => {
  const ctx = createPreflightRunContext({
    instanceId: "bot-1",
    memory: {
      baseUrl: "http://memory:8080",
      fetch: async () =>
        jsonResponse({
          items: [
            {
              external_key: "X-1",
              status: "pr_open",
              repo: "demo",
              metadata: { prs: [{ repo: "demo", number: 9, host: "github" }] },
            },
          ],
        }),
    },
    proxy: {
      baseUrl: "https://proxy.example/devbot-proxy",
      fetch: async (url) => {
        assert.ok(
          url.startsWith("https://proxy.example/devbot-proxy/github"),
          `unexpected url ${url}`,
        );
        if (url.endsWith("/graphql")) {
          return jsonResponse({
            data: {
              repository: {
                pullRequest: {
                  state: "OPEN",
                  mergeable: "CONFLICTING",
                  reviewDecision: null,
                  url: null,
                  title: null,
                  isDraft: false,
                  reviews: { nodes: [] },
                  statusCheckRollup: { contexts: { nodes: [] } },
                },
              },
            },
          });
        }
        return jsonResponse([]);
      },
    },
    repos: { demo: { upstream: "https://github.com/org/demo" } },
  });
  const result = await ghPrStatus.run(ctx, {});
  assert.equal(result.status, "start");
  assert.ok(result.content.includes("### CONFLICTS (1)"));
  // Tasks were fetched once through the shared run-context cache.
  assert.deepEqual(ctx.state.get("tasks").length, 1);
});

test("run() threads suppress_terminal_if_addressed into the buckets", async () => {
  const graphqlFetch = async (url) => {
    if (url.endsWith("/graphql")) {
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              state: "MERGED",
              mergeable: "MERGEABLE",
              reviewDecision: null,
              url: null,
              title: null,
              isDraft: false,
              reviews: { nodes: [] },
              statusCheckRollup: { contexts: { nodes: [] } },
            },
          },
        },
      });
    }
    return jsonResponse([]);
  };
  const makeCtx = () =>
    createPreflightRunContext({
      instanceId: "bot-1",
      memory: {
        baseUrl: "http://memory:8080",
        fetch: async () =>
          jsonResponse({
            items: [
              {
                external_key: "X-1",
                status: "pr_open",
                repo: "demo",
                last_addressed: "2026-07-01T12:00",
                metadata: { prs: [{ repo: "demo", number: 9, host: "github" }] },
              },
            ],
          }),
      },
      proxy: { baseUrl: "https://proxy.example/devbot-proxy", fetch: graphqlFetch },
      repos: { demo: { upstream: "https://github.com/org/demo" } },
    });

  const suppressed = await ghPrStatus.run(makeCtx(), { suppress_terminal_if_addressed: true });
  assert.equal(suppressed.status, "skip");
  assert.ok(suppressed.content.includes("### CLEAN (1)"));
  assert.equal(suppressed.content.includes("### MERGED"), false);

  const byDefault = await ghPrStatus.run(makeCtx(), {});
  assert.equal(byDefault.status, "start");
  assert.ok(byDefault.content.includes("### MERGED (1)"));
});

test("run() skips an unfetchable PR but keeps healthy ones", async () => {
  const ctx = createPreflightRunContext({
    instanceId: "bot-1",
    memory: {
      baseUrl: "http://memory:8080",
      fetch: async () =>
        jsonResponse({
          items: [
            {
              external_key: "X-GONE",
              status: "pr_open",
              repo: "gone",
              metadata: { prs: [{ repo: "gone", number: 7, host: "github" }] },
            },
            {
              external_key: "X-OK",
              status: "pr_open",
              repo: "demo",
              metadata: { prs: [{ repo: "demo", number: 9, host: "github" }] },
            },
          ],
        }),
    },
    proxy: {
      baseUrl: "https://proxy.example/devbot-proxy",
      fetch: async (url, init) => {
        if (url.endsWith("/graphql")) {
          const body = JSON.parse(init.body);
          if (body.variables.number === 7) {
            return jsonResponse({ message: "Not Found" }, 404);
          }
          return jsonResponse({
            data: {
              repository: {
                pullRequest: {
                  state: "MERGED",
                  mergeable: "MERGEABLE",
                  reviewDecision: null,
                  url: null,
                  title: null,
                  isDraft: false,
                  reviews: { nodes: [] },
                  statusCheckRollup: { contexts: { nodes: [] } },
                },
              },
            },
          });
        }
        return jsonResponse([]);
      },
    },
    repos: {
      gone: { upstream: "https://github.com/org/gone" },
      demo: { upstream: "https://github.com/org/demo" },
    },
  });
  const result = await ghPrStatus.run(ctx, {});
  assert.equal(result.status, "start");
  assert.ok(result.content.includes("### MERGED (1)"));
  assert.equal(result.content.includes("X-GONE"), false);
  // The isolated 404 is recorded as evidence, not silently dropped.
  assert.ok(result.content.includes("### UNFETCHABLE (1)"));
  assert.ok(result.content.includes("PR org/gone#7: HTTP 404"));
});

test("run() errors when no PR could be fetched and the route answered 404", async () => {
  const ctx = createPreflightRunContext({
    instanceId: "bot-1",
    memory: {
      baseUrl: "http://memory:8080",
      fetch: async () =>
        jsonResponse({
          items: [
            {
              external_key: "X-1",
              status: "pr_open",
              repo: "demo",
              metadata: { prs: [{ repo: "demo", number: 9, host: "github" }] },
            },
          ],
        }),
    },
    proxy: {
      baseUrl: "https://proxy.example/devbot-proxy",
      fetch: async () => jsonResponse({ message: "Not Found" }, 404),
    },
    repos: { demo: { upstream: "https://github.com/org/demo" } },
  });
  const result = await ghPrStatus.run(ctx, {});
  assert.equal(result.status, "error");
  assert.equal(result.content.includes("https://proxy.example/devbot-proxy/github"), true);
});

// --- the shared failure policy (shared/failure-policy.ts) ---
// Every attempted fetch of a class failing is an execution error naming
// the required route — auth, rate limit, upstream 5xx, network/timeout,
// and the all-404 route outage alike. Isolated failures keep the run
// going with recorded evidence.

const PROXY_BASE = "https://proxy.example/devbot-proxy";
const FAILURE_REPOS = {
  demo: { upstream: "https://github.com/org/demo" },
  gone: { upstream: "https://github.com/org/gone" },
};

const activeGhTask = (key, repo, number) => ({
  external_key: key,
  status: "pr_open",
  repo,
  metadata: { prs: [{ repo, number, host: "github" }] },
});

const graphqlPrResponse = (pr) =>
  jsonResponse({
    data: {
      repository: {
        pullRequest: {
          state: pr.state,
          mergeable: pr.mergeable ?? "MERGEABLE",
          reviewDecision: pr.reviewDecision ?? null,
          url: null,
          title: null,
          isDraft: false,
          reviews: { nodes: pr.reviews ?? [] },
          statusCheckRollup: { contexts: { nodes: pr.statusCheckRollup ?? [] } },
        },
      },
    },
  });

const ghCtx = (proxyFetch, tasks) =>
  createPreflightRunContext({
    instanceId: "bot-1",
    memory: {
      baseUrl: "http://memory:8080",
      fetch: async () => jsonResponse({ items: tasks }),
    },
    proxy: { baseUrl: PROXY_BASE, fetch: proxyFetch },
    repos: FAILURE_REPOS,
  });

const outageFetches = [
  ["401 (auth)", () => jsonResponse({ message: "Bad credentials" }, 401), "HTTP 401"],
  ["403 (auth)", () => jsonResponse({ message: "Forbidden" }, 403), "HTTP 403"],
  ["429 (rate limit)", () => jsonResponse({ message: "rate limited" }, 429), "HTTP 429"],
  ["502 (bad gateway)", () => jsonResponse({ message: "bad gateway" }, 502), "HTTP 502"],
  ["503 (unavailable)", () => jsonResponse({ message: "unavailable" }, 503), "HTTP 503"],
  [
    "a network failure",
    () => {
      throw new TypeError("fetch failed");
    },
    null,
  ],
  [
    "a timeout",
    () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    },
    null,
  ],
];

for (const [label, respond, reason] of outageFetches) {
  test(`run() errors when the only PR fetch fails with ${label}`, async () => {
    const ctx = ghCtx(async () => {
      return respond();
    }, [activeGhTask("X-1", "demo", 9)]);
    const result = await ghPrStatus.run(ctx, {});
    assert.equal(result.status, "error");
    // Transport failures may arrive wrapped by the SDK. Escalation must
    // hold regardless of their representation; the null case accepts the
    // safe classification emitted by the transport.
    const expectedTail = reason === null ? "\\(org/demo#9: .+\\)" : `\\(org\\/demo#9: ${reason}\\)`;
    assert.match(
      result.content,
      new RegExp(
        `gh-pr-status: GitHub route ${PROXY_BASE}/github is not usable: ` +
          `1 PR fetch attempted, 0 succeeded ${expectedTail}`,
      ),
    );
    // Evidence discipline: no upstream body text in the message.
    assert.equal(result.content.includes("Bad credentials"), false);
    assert.equal(result.content.includes("fetch failed"), false);
  });
}

test("run() errors when every PR fetch fails with an outage, not just the first", async () => {
  const ctx = ghCtx(
    async (url, init) => {
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(init.body);
        return body.variables.number === 7
          ? jsonResponse({ message: "unavailable" }, 503)
          : jsonResponse({ message: "unavailable" }, 503);
      }
      return jsonResponse([]);
    },
    [activeGhTask("X-A", "gone", 7), activeGhTask("X-B", "demo", 9)],
  );
  const result = await ghPrStatus.run(ctx, {});
  assert.equal(result.status, "error");
  assert.match(result.content, /2 PR fetches attempted, 0 succeeded/);
  assert.match(result.content, /org\/gone#7: HTTP 503/);
  assert.match(result.content, /org\/demo#9: HTTP 503/);
});

test("run() keeps actionable work when an isolated PR fetch fails with a 5xx", async () => {
  const ctx = ghCtx(
    async (url, init) => {
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(init.body);
        return body.variables.number === 7
          ? jsonResponse({ message: "unavailable" }, 503)
          : graphqlPrResponse({ state: "MERGED" });
      }
      return jsonResponse([]);
    },
    [activeGhTask("X-GONE", "gone", 7), activeGhTask("X-OK", "demo", 9)],
  );
  const result = await ghPrStatus.run(ctx, {});
  assert.equal(result.status, "start");
  assert.ok(result.content.includes("### MERGED (1)"));
  assert.ok(result.content.includes("### UNFETCHABLE (1)"));
  assert.ok(result.content.includes("PR org/gone#7: HTTP 503"));
  assert.equal(result.content.includes("X-GONE"), false);
});

test("run() tolerates an isolated comment-fetch failure and records it", async () => {
  // PR 7's comments fail on both endpoints (the GitHub client throws only
  // when both fail), PR 9's succeed: an isolated, item-specific failure —
  // the Python gh_pr_comments degrade-to-[] parity, with evidence.
  const ctx = ghCtx(
    async (url, init) => {
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(init.body);
        return body.variables.number === 7
          ? graphqlPrResponse({ state: "OPEN" })
          : graphqlPrResponse({ state: "MERGED" });
      }
      if (url.includes("/repos/org/gone/") && url.endsWith("/comments")) {
        return jsonResponse({ message: "Bad credentials" }, 401);
      }
      return jsonResponse([]);
    },
    [activeGhTask("X-GONE", "gone", 7), activeGhTask("X-OK", "demo", 9)],
  );
  const result = await ghPrStatus.run(ctx, {});
  assert.equal(result.status, "start");
  assert.ok(result.content.includes("### MERGED (1)"));
  assert.ok(result.content.includes("### UNFETCHABLE (1)"));
  assert.ok(result.content.includes("PR comments org/gone#7: HTTP 401"));
});

test("run() errors when every fetched PR's comments fail (feedback would be erased)", async () => {
  const ctx = ghCtx(
    async (url) => {
      if (url.endsWith("/graphql")) {
        return graphqlPrResponse({ state: "OPEN" });
      }
      return jsonResponse({ message: "Bad credentials" }, 401);
    },
    [activeGhTask("X-1", "demo", 9)],
  );
  const result = await ghPrStatus.run(ctx, {});
  assert.equal(result.status, "error");
  assert.equal(
    result.content,
    "gh-pr-status: GitHub route https://proxy.example/devbot-proxy/github is not usable: " +
      "1 PR comment fetch attempted, 0 succeeded (org/demo#9: HTTP 401)",
  );
});

test("run() keeps isolated-failure evidence when the other PRs were only confirmed missing", async () => {
  // Regression: PR 9 answers pullRequest: null (confirmed missing — a
  // healthy route, the fetch counts as a success) while PR 7 fails with
  // 503. Nothing could be classified, but the route is not in outage, so
  // the run skips with the failure kept as evidence — the early
  // empty-enriched return must not drop it.
  const ctx = ghCtx(
    async (url, init) => {
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(init.body);
        return body.variables.number === 9
          ? jsonResponse({ data: { repository: { pullRequest: null } } })
          : jsonResponse({ message: "unavailable" }, 503);
      }
      return jsonResponse([]);
    },
    [activeGhTask("X-NULL", "demo", 9), activeGhTask("X-GONE", "gone", 7)],
  );
  const result = await ghPrStatus.run(ctx, {});
  assert.equal(result.status, "skip");
  assert.equal(
    result.content,
    "GH PR status: no GH PRs to check (2 active tasks)\n" +
      "\n" +
      "### UNFETCHABLE (1)\n" +
      "  PR org/gone#7: HTTP 503\n",
  );
});

test("run() keeps isolated-failure evidence for confirmed-missing and failed PRs on one task", async () => {
  const ctx = ghCtx(
    async (url, init) => {
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(init.body);
        return body.variables.number === 9
          ? jsonResponse({ data: { repository: { pullRequest: null } } })
          : jsonResponse({ message: "unavailable" }, 503);
      }
      return jsonResponse([]);
    },
    [
      {
        external_key: "X-BOTH",
        status: "pr_open",
        repo: "demo",
        metadata: {
          prs: [
            { repo: "demo", number: 9, host: "github" },
            { repo: "gone", number: 7, host: "github" },
          ],
        },
      },
    ],
  );
  const result = await ghPrStatus.run(ctx, {});
  assert.equal(result.status, "skip");
  assert.match(result.content, /no GH PRs to check \(1 active tasks\)/);
  assert.match(result.content, /### UNFETCHABLE \(1\)/);
  assert.match(result.content, /PR org\/gone#7: HTTP 503/);
});

test("run() keeps the exact no-PR skip message when every PR was confirmed missing", async () => {
  const ctx = ghCtx(
    async (url) => {
      if (url.endsWith("/graphql")) {
        return jsonResponse({ data: { repository: { pullRequest: null } } });
      }
      return jsonResponse([]);
    },
    [activeGhTask("X-NULL", "demo", 9)],
  );
  const result = await ghPrStatus.run(ctx, {});
  assert.deepEqual(result, {
    status: "skip",
    content: "GH PR status: no GH PRs to check (1 active tasks)",
  });
});
