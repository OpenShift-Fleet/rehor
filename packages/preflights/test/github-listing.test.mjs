import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubClient } from "../dist/shared/github.js";
import { isPreflightHttpError } from "../dist/shared/http.js";

/**
 * Coverage for the GitHub client's listing calls (the hcc quality-monitor
 * ports): `listMergedPrs` (the `gh pr list --state merged` replacement) and
 * `listRepoFiles` (the `gh api git/trees` replacement). Fixture-based: the
 * client takes an injectable fetch, so no test touches the network.
 */

const jsonResponse = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const mergedPr = (number, mergedAt = "2026-07-21T10:00:00Z") => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/org/repo/pull/${number}`,
  user: { login: "alice" },
  merged_at: mergedAt,
  state: "closed",
});

// --- listMergedPrs ---

test("github client lists merged PRs from the REST pulls endpoint, dropping unmerged closed PRs", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: async (url) => {
      calls.push(url);
      return jsonResponse([
        mergedPr(7),
        { ...mergedPr(6), merged_at: null }, // closed but never merged
        { ...mergedPr(5), user: null, merged_at: "2026-07-20T10:00:00Z" },
      ]);
    },
  });
  const prs = await client.listMergedPrs("org/repo", 50);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(url.pathname, "/devbot-proxy/github/repos/org/repo/pulls");
  assert.equal(url.searchParams.get("state"), "closed");
  assert.equal(url.searchParams.get("sort"), "updated");
  assert.equal(url.searchParams.get("direction"), "desc");
  assert.equal(url.searchParams.get("per_page"), "50");
  assert.deepEqual(prs, [
    {
      number: 7,
      title: "PR 7",
      url: "https://github.com/org/repo/pull/7",
      author: "alice",
      mergedAt: "2026-07-21T10:00:00Z",
    },
    {
      number: 5,
      title: "PR 5",
      url: "https://github.com/org/repo/pull/5",
      author: null,
      mergedAt: "2026-07-20T10:00:00Z",
    },
  ]);
});

test("github client paginates merged PRs and stops at the limit — the --limit behavior", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) => {
      calls.push(url);
      const page = new URL(url).searchParams.get("page") ?? "1";
      if (page === "1") {
        return jsonResponse([mergedPr(4), mergedPr(3)], 200, {
          link: '<https://proxy.example/github/repos/org/repo/pulls?page=2>; rel="next"',
        });
      }
      if (page === "2") {
        return jsonResponse([mergedPr(2), mergedPr(1)], 200, {
          link: '<https://proxy.example/github/repos/org/repo/pulls?page=3>; rel="next"',
        });
      }
      return jsonResponse([mergedPr(0)]);
    },
  });
  const prs = await client.listMergedPrs("org/repo", 3);
  assert.deepEqual(
    prs.map((pr) => pr.number),
    [4, 3, 2],
  );
  // Page 3 is never requested: the limit was reached on page 2.
  assert.deepEqual(
    calls.map((url) => new URL(url).searchParams.get("page") ?? "1"),
    ["1", "2"],
  );
});

test("github client paginates every page when the limit is not reached earlier", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) => {
      calls.push(url);
      const page = new URL(url).searchParams.get("page") ?? "1";
      if (page === "1") {
        return jsonResponse([mergedPr(4), mergedPr(3)], 200, {
          link: '<https://proxy.example/github/repos/org/repo/pulls?page=2>; rel="next"',
        });
      }
      return jsonResponse([mergedPr(2)]);
    },
  });
  const prs = await client.listMergedPrs("org/repo", 50);
  assert.deepEqual(
    prs.map((pr) => pr.number),
    [4, 3, 2],
  );
  assert.equal(calls.length, 2);
});

test("github client maps merged-PR list failures to PreflightHttpError with the route", async () => {
  const client = createGitHubClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: async () => jsonResponse({ message: "boom" }, 500),
  });
  await assert.rejects(
    () => client.listMergedPrs("org/repo", 50),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 500);
      assert.equal(error.route, "https://proxy.example/devbot-proxy/github");
      return true;
    },
  );
});

test("github client treats a non-positive merged-PR limit as no fetch", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) => {
      calls.push(url);
      return jsonResponse([]);
    },
  });
  assert.deepEqual(await client.listMergedPrs("org/repo", 0), []);
  assert.deepEqual(await client.listMergedPrs("org/repo", -3), []);
  assert.equal(calls.length, 0);
});

// --- listMergedPrs with a merge-date window (mergedSince) ---

const searchResponse = (nodes, { hasNextPage = false, endCursor = null } = {}) => ({
  data: {
    search: { nodes, pageInfo: { hasNextPage, endCursor } },
  },
});

const searchNode = (number, mergedAt) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/org/repo/pull/${number}`,
  mergedAt,
  author: { login: "alice" },
});

test("github client finds window merges via GraphQL search when old merged PRs were updated more recently", async () => {
  // Regression for the review finding: the REST walk sorts the pulls
  // endpoint by updated and stops at the limit, so old merged PRs that
  // were recently updated crowd out the lookback window's merges — a
  // recent merge is missed entirely. With mergedSince the window is
  // filtered server-side and the recent merge is found.
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse(searchResponse([searchNode(9, "2026-11-18T08:00:00Z")]));
    },
  });
  const prs = await client.listMergedPrs("org/repo", 50, "2026-11-17T12:00:00Z");
  // The search replaces the REST pulls walk: only the GraphQL endpoint
  // is requested.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://proxy.example/devbot-proxy/github/graphql");
  assert.equal(
    calls[0].body.variables.search,
    'repo:"org/repo" is:pr is:merged merged:>=2026-11-17T12:00:00Z',
  );
  assert.deepEqual(prs, [
    {
      number: 9,
      title: "PR 9",
      url: "https://github.com/org/repo/pull/9",
      author: "alice",
      mergedAt: "2026-11-18T08:00:00Z",
    },
  ]);
});

test("github client paginates the merged-PR search by cursor and stops at the limit", async () => {
  const bodies = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.variables.cursor === null) {
        return jsonResponse(
          searchResponse(
            [searchNode(4, "2026-11-18T09:00:00Z"), searchNode(3, "2026-11-18T08:00:00Z")],
            { hasNextPage: true, endCursor: "cursor-1" },
          ),
        );
      }
      return jsonResponse(
        searchResponse([
          searchNode(2, "2026-11-18T07:00:00Z"),
          searchNode(1, "2026-11-18T06:00:00Z"),
        ]),
      );
    },
  });
  const prs = await client.listMergedPrs("org/repo", 3, new Date("2026-11-17T12:00:00Z"));
  // The limit is reached mid-page-2, so page 3 is never requested.
  assert.deepEqual(
    prs.map((pr) => pr.number),
    [4, 3, 2],
  );
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].variables.cursor, "cursor-1");
});

test("github client drops merged-PR search nodes without a mergedAt", async () => {
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async () =>
      jsonResponse(
        searchResponse([
          searchNode(9, "2026-11-18T08:00:00Z"),
          { ...searchNode(8), mergedAt: null },
        ]),
      ),
  });
  const prs = await client.listMergedPrs("org/repo", 50, "2026-11-17T12:00:00Z");
  assert.deepEqual(
    prs.map((pr) => pr.number),
    [9],
  );
});

test("github client returns an empty list when the merge window is empty", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) => {
      calls.push(url);
      return jsonResponse(searchResponse([]));
    },
  });
  const prs = await client.listMergedPrs("org/repo", 50, "2026-11-17T12:00:00Z");
  assert.deepEqual(prs, []);
  assert.deepEqual(calls, ["https://proxy.example/github/graphql"]);
});

test("github client maps merged-PR search failures to PreflightHttpError with the route", async () => {
  const client = createGitHubClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: async () => jsonResponse({ message: "boom" }, 500),
  });
  await assert.rejects(
    () => client.listMergedPrs("org/repo", 50, "2026-11-17T12:00:00Z"),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 500);
      assert.equal(error.route, "https://proxy.example/devbot-proxy/github");
      return true;
    },
  );
});

test("github client treats a non-positive limit as no fetch with a window bound too", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) => {
      calls.push(url);
      return jsonResponse(searchResponse([]));
    },
  });
  assert.deepEqual(await client.listMergedPrs("org/repo", 0, "2026-11-17T12:00:00Z"), []);
  assert.deepEqual(
    await client.listMergedPrs("org/repo", -3, new Date("2026-11-17T12:00:00Z")),
    [],
  );
  assert.equal(calls.length, 0);
});

test("github client rejects an unparseable mergedSince bound without fetching", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) => {
      calls.push(url);
      return jsonResponse(searchResponse([]));
    },
  });
  await assert.rejects(
    () => client.listMergedPrs("org/repo", 50, "yesterday"),
    (error) => {
      assert.ok(!isPreflightHttpError(error));
      assert.match(error.message, /mergedSince/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

// --- listRepoFiles ---

test("github client lists repo files from the recursive git tree, blobs only", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: async (url) => {
      calls.push(url);
      return jsonResponse({
        tree: [
          { path: "src", type: "tree" },
          { path: "src/a.spec.ts", type: "blob" },
          { path: "package.json", type: "blob" },
          { path: "docs", type: "tree" },
          { path: "docs/readme.md", type: "blob" },
        ],
        truncated: false,
      });
    },
  });
  const files = await client.listRepoFiles("org/repo");
  assert.deepEqual(calls, [
    "https://proxy.example/devbot-proxy/github/repos/org/repo/git/trees/main?recursive=1",
  ]);
  assert.deepEqual(files, ["src/a.spec.ts", "package.json", "docs/readme.md"]);
});

test("github client retries the tree listing with master when main answers 404", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) => {
      calls.push(url);
      if (url.includes("/git/trees/main")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      return jsonResponse({ tree: [{ path: "readme.md", type: "blob" }] });
    },
  });
  const files = await client.listRepoFiles("org/repo");
  assert.deepEqual(calls, [
    "https://proxy.example/github/repos/org/repo/git/trees/main?recursive=1",
    "https://proxy.example/github/repos/org/repo/git/trees/master?recursive=1",
  ]);
  assert.deepEqual(files, ["readme.md"]);
});

test("github client surfaces the master fallback's 404 when both branches miss", async () => {
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async () => jsonResponse({ message: "Not Found" }, 404),
  });
  await assert.rejects(
    () => client.listRepoFiles("org/repo"),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 404);
      assert.match(error.url, /git\/trees\/master/);
      assert.equal(error.routeUnavailable, true);
      return true;
    },
  );
});

test("github client does not retry non-404 tree failures", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) => {
      calls.push(url);
      return jsonResponse({ message: "boom" }, 500);
    },
  });
  await assert.rejects(
    () => client.listRepoFiles("org/repo"),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 500);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("github client does not fall back to master for an explicit branch 404", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) => {
      calls.push(url);
      return jsonResponse({ message: "Not Found" }, 404);
    },
  });
  await assert.rejects(
    () => client.listRepoFiles("org/repo", "develop"),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 404);
      assert.match(error.url, /git\/trees\/develop/);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("github client rejects a non-JSON tree body", async () => {
  const client = createGitHubClient({
    baseUrl: "https://proxy.example",
    fetch: async () =>
      new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }),
  });
  await assert.rejects(
    () => client.listRepoFiles("org/repo"),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.match(error.message, /non-JSON body/);
      return true;
    },
  );
});
