import assert from "node:assert/strict";
import test from "node:test";
import { classifyGh } from "../dist/preflights/gh-pr-status/classify.js";
import { runGhPrStatus } from "../dist/preflights/gh-pr-status/index.js";
import { createGitHubClient, GITHUB_PATH_PREFIX } from "../dist/shared/github.js";
import { isPreflightHttpError } from "../dist/shared/http.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";
import { createRunState } from "../dist/shared/run-context.js";

const jsonResponse = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** GraphQL response body: @octokit/graphql returns the inner `data` field. */
const graphqlResponse = (pullRequest) => ({ data: { repository: { pullRequest } } });

const checkRun = (name, conclusion, detailsUrl) => ({
  __typename: "CheckRun",
  name,
  conclusion,
  detailsUrl,
});

const statusContext = (context, state, targetUrl) => ({
  __typename: "StatusContext",
  context,
  state,
  targetUrl,
});

test("github client declares the /github route prefix on the proxy", () => {
  assert.equal(GITHUB_PATH_PREFIX, "/github");
});

test("github client fetches PR data via GraphQL on the proxy route", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse(
        graphqlResponse({
          state: "OPEN",
          mergeable: "CONFLICTING",
          reviewDecision: "CHANGES_REQUESTED",
          url: "https://github.com/org/repo/pull/7",
          title: "A change",
          isDraft: false,
          reviews: { nodes: [] },
          statusCheckRollup: { contexts: { nodes: [] } },
        }),
      );
    },
  });
  const pr = await client.getPr("org/repo", 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://proxy.example/devbot-proxy/github/graphql");
  assert.deepEqual(calls[0].body.variables, { owner: "org", repo: "repo", number: 7 });
  // The query must carry the fields the Python `gh pr view --json` call had.
  for (const field of ["state", "mergeable", "reviewDecision", "statusCheckRollup", "reviews"]) {
    assert.ok(calls[0].body.query.includes(field), `query missing ${field}`);
  }
  assert.equal(pr.state, "OPEN");
  assert.equal(pr.mergeable, "CONFLICTING");
  assert.equal(pr.reviewDecision, "CHANGES_REQUESTED");
  assert.deepEqual(pr.reviews, []);
  assert.deepEqual(pr.statusCheckRollup, []);
});

test("github client sends no Authorization header — the proxy injects credentials", async () => {
  let seen;
  const client = createGitHubClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: async (_url, init) => {
      seen = init;
      return jsonResponse(graphqlResponse(null));
    },
  });
  await client.getPr("org/repo", 7);
  assert.equal(seen.headers.Authorization, undefined);
  assert.equal(seen.headers.authorization, undefined);
});

test("github client passes CheckRun rollup nodes through unchanged", async () => {
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async () =>
      jsonResponse(
        graphqlResponse({
          statusCheckRollup: {
            contexts: {
              nodes: [
                checkRun("lint", "SUCCESS", "https://ci/1"),
                checkRun("test", "FAILURE", null),
              ],
            },
          },
        }),
      ),
  });
  const pr = await client.getPr("org/repo", 7);
  assert.deepEqual(pr.statusCheckRollup, [
    { __typename: "CheckRun", name: "lint", conclusion: "SUCCESS", detailsUrl: "https://ci/1" },
    { __typename: "CheckRun", name: "test", conclusion: "FAILURE", detailsUrl: null },
  ]);
});

test("github client preserves StatusContext nodes in the gh CLI shape", async () => {
  // `gh pr view --json statusCheckRollup` does NOT flatten commit statuses
  // into the check-run shape: StatusContext nodes keep {context, state,
  // targetUrl} and never gain name/conclusion/detailsUrl. The ported Python
  // classifier reads `conclusion`, so legacy commit-status failures stay
  // invisible to it — preserving that here keeps the parity.
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async () =>
      jsonResponse(
        graphqlResponse({
          statusCheckRollup: {
            contexts: { nodes: [statusContext("ci/jenkins", "FAILURE", "https://jenkins/42")] },
          },
        }),
      ),
  });
  const pr = await client.getPr("org/repo", 7);
  assert.deepEqual(pr.statusCheckRollup, [
    {
      __typename: "StatusContext",
      context: "ci/jenkins",
      state: "FAILURE",
      targetUrl: "https://jenkins/42",
    },
  ]);
});

test("StatusContext failures stay invisible to the ported classifier (Python parity)", async () => {
  // Python classify_gh read c.get("conclusion") and c.get("detailsUrl"):
  // a StatusContext carries state/targetUrl instead, so its FAILURE never
  // produced a ci_fail issue and its targetUrl never surfaced as a Konflux
  // URL. CheckRun nodes keep both behaviors.
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async () =>
      jsonResponse(
        graphqlResponse({
          state: "OPEN",
          mergeable: "MERGEABLE",
          statusCheckRollup: {
            contexts: {
              nodes: [
                statusContext("ci/legacy", "FAILURE", "https://jenkins/pipelinerun/1"),
                checkRun("lint", "FAILURE", "https://konflux/pipelinerun/2"),
              ],
            },
          },
        }),
      ),
  });
  const pr = await client.getPr("org/repo", 7);
  const { issues } = classifyGh(pr, "");
  assert.deepEqual(issues, ["ci_fail:lint", "konflux_urls:https://konflux/pipelinerun/2"]);
});

test("github client passes reviews through with author, state, body, and submittedAt", async () => {
  const review = {
    state: "CHANGES_REQUESTED",
    body: "please rework",
    submittedAt: "2026-07-03T10:00:00Z",
    author: { login: "alice" },
  };
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async () => jsonResponse(graphqlResponse({ reviews: { nodes: [review] } })),
  });
  const pr = await client.getPr("org/repo", 7);
  assert.deepEqual(pr.reviews, [review]);
});

test("github client returns null when the pull request is absent", async () => {
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async () => jsonResponse(graphqlResponse(null)),
  });
  assert.equal(await client.getPr("org/repo", 404), null);
});

test("github client fetches comments from both endpoints, review comments first", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: async (url) => {
      calls.push(url);
      if (url.includes("/pulls/7/comments")) {
        return jsonResponse([
          { user: { login: "alice" }, created_at: "2026-07-01T10:00:00Z", body: "inline note" },
        ]);
      }
      return jsonResponse([
        { user: { login: "bob" }, created_at: "2026-07-02T10:00:00Z", body: "general note" },
      ]);
    },
  });
  const comments = await client.getPrComments("org/repo", 7);
  assert.deepEqual(calls, [
    "https://proxy.example/devbot-proxy/github/repos/org/repo/pulls/7/comments",
    "https://proxy.example/devbot-proxy/github/repos/org/repo/issues/7/comments",
  ]);
  assert.deepEqual(comments, [
    { a: "alice", t: "2026-07-01T10:00:00Z", b: "inline note" },
    { a: "bob", t: "2026-07-02T10:00:00Z", b: "general note" },
  ]);
});

test("github client keeps the other endpoint's comments when one fails (Python gh_pr_comments parity)", async () => {
  // The Python wrapper tried each endpoint in its own try/except, so one
  // failing subprocess never discarded the other endpoint's comments.
  const reviewEndpointFails = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) =>
      url.includes("/pulls/7/comments")
        ? jsonResponse({ message: "boom" }, 500)
        : jsonResponse([
            { user: { login: "bob" }, created_at: "2026-07-02T10:00:00Z", body: "general note" },
          ]),
  });
  assert.deepEqual(await reviewEndpointFails.getPrComments("org/repo", 7), [
    { a: "bob", t: "2026-07-02T10:00:00Z", b: "general note" },
  ]);

  const issueEndpointFails = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) =>
      url.includes("/issues/7/comments")
        ? jsonResponse({ message: "boom" }, 500)
        : jsonResponse([
            { user: { login: "alice" }, created_at: "2026-07-01T10:00:00Z", body: "inline note" },
          ]),
  });
  assert.deepEqual(await issueEndpointFails.getPrComments("org/repo", 7), [
    { a: "alice", t: "2026-07-01T10:00:00Z", b: "inline note" },
  ]);
});

test("github client still tries the second comment endpoint after the first fails", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) => {
      calls.push(url);
      if (url.includes("/pulls/7/comments")) {
        return jsonResponse({ message: "boom" }, 500);
      }
      return jsonResponse([{ user: { login: "bob" }, created_at: "t2", body: "general note" }]);
    },
  });
  const comments = await client.getPrComments("org/repo", 7);
  assert.deepEqual(calls, [
    "https://proxy.example/github/repos/org/repo/pulls/7/comments",
    "https://proxy.example/github/repos/org/repo/issues/7/comments",
  ]);
  assert.deepEqual(comments, [{ a: "bob", t: "t2", b: "general note" }]);
});

test("github client throws a meaningful HTTP error when both comment endpoints fail", async () => {
  const client = createGitHubClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: async (url) =>
      jsonResponse({ message: url.includes("/pulls/") ? "pulls boom" : "issues boom" }, 500),
  });
  await assert.rejects(
    () => client.getPrComments("org/repo", 7),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 500);
      assert.equal(error.route, "https://proxy.example/devbot-proxy/github");
      assert.match(error.message, /all GitHub comment endpoints failed/);
      assert.match(error.message, /pulls\/7\/comments/);
      assert.match(error.message, /issues\/7\/comments/);
      return true;
    },
  );
});

test("github client keeps route-unavailable semantics when both comment endpoints answer 404", async () => {
  const client = createGitHubClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: async () => jsonResponse({ message: "Not Found" }, 404),
  });
  await assert.rejects(
    () => client.getPrComments("org/repo", 7),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 404);
      assert.equal(error.routeUnavailable, true);
      assert.match(error.message, /not available on the proxy/);
      return true;
    },
  );
});

test("github client paginates each comments endpoint — the --paginate behavior", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: async (url) => {
      calls.push(url);
      const page = new URL(url).searchParams.get("page") ?? "1";
      if (url.includes("/pulls/7/comments")) {
        if (page === "1") {
          return jsonResponse([{ user: { login: "a" }, created_at: "t1", body: "one" }], 200, {
            link: '<https://proxy.example/devbot-proxy/github/repos/org/repo/pulls/7/comments?page=2>; rel="next"',
          });
        }
        return jsonResponse([{ user: { login: "b" }, created_at: "t2", body: "two" }]);
      }
      return jsonResponse([]);
    },
  });
  const comments = await client.getPrComments("org/repo", 7);
  assert.deepEqual(
    calls.filter((url) => url.includes("/pulls/7/comments")),
    [
      "https://proxy.example/devbot-proxy/github/repos/org/repo/pulls/7/comments",
      "https://proxy.example/devbot-proxy/github/repos/org/repo/pulls/7/comments?page=2",
    ],
  );
  assert.deepEqual(comments, [
    { a: "a", t: "t1", b: "one" },
    { a: "b", t: "t2", b: "two" },
  ]);
});

test("github client maps HTTP failures to PreflightHttpError with the route", async () => {
  const client = createGitHubClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: async (url) =>
      url.endsWith("/graphql")
        ? jsonResponse({ message: "Not Found" }, 404)
        : jsonResponse("nope", 500),
  });
  await assert.rejects(
    () => client.getPr("org/repo", 7),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 404);
      assert.equal(error.route, "https://proxy.example/devbot-proxy/github");
      assert.equal(error.routeUnavailable, true);
      assert.match(error.message, /not available on the proxy/);
      return true;
    },
  );
  await assert.rejects(
    () => client.getPrComments("org/repo", 7),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 500);
      assert.equal(error.route, "https://proxy.example/devbot-proxy/github");
      return true;
    },
  );
});

test("github client maps GraphQL response errors to PreflightHttpError", async () => {
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async () => jsonResponse({ data: null, errors: [{ message: "bad thing" }] }),
  });
  await assert.rejects(
    () => client.getPr("org/repo", 7),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, null);
      assert.match(error.message, /bad thing/);
      return true;
    },
  );
});

test("new human feedback is retained when one comment endpoint fails", async () => {
  // Regression for the review finding: one endpoint failing used to discard
  // the other endpoint's successfully collected comments, hiding new human
  // feedback from the run flow.
  const memory = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async () =>
      jsonResponse({
        items: [
          {
            external_key: "X-1",
            status: "in_progress",
            repo: "repo",
            metadata: { prs: [{ repo: "repo", number: 7, host: "github" }] },
          },
        ],
      }),
  });
  const github = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) => {
      if (url.endsWith("/graphql")) {
        return jsonResponse(
          graphqlResponse({
            state: "OPEN",
            mergeable: "MERGEABLE",
            reviewDecision: null,
            url: null,
            title: null,
            isDraft: false,
            reviews: { nodes: [] },
            statusCheckRollup: { contexts: { nodes: [] } },
          }),
        );
      }
      // The inline review comments endpoint is down; the general issue
      // comments endpoint still answers with new human feedback.
      if (url.includes("/pulls/7/comments")) {
        return jsonResponse({ message: "boom" }, 500);
      }
      return jsonResponse([
        {
          user: { login: "reviewer" },
          created_at: "2026-07-03T10:00:00Z",
          body: "please look again",
        },
      ]);
    },
  });
  const result = await runGhPrStatus({
    memory,
    state: createRunState(),
    github,
    repos: { repo: { upstream: "https://github.com/org/repo" } },
  });
  assert.equal(result.status, "start");
  assert.ok(result.content.includes("### FEEDBACK (1)"));
  assert.ok(result.content.includes("please look again"));
});
