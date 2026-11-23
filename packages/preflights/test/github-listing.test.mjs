import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubClient } from "../dist/shared/github.js";
import { PreflightHttpError } from "../dist/shared/http.js";

const REPO = "org/repo";
const SINCE = "2026-11-17T12:00:00Z";
const MERGED_AT = "2026-11-18T08:00:00Z";
const PROXY = "https://proxy.example/devbot-proxy";
const PULLS_PATH = `/devbot-proxy/github/repos/${REPO}/pulls`;
const clientOn = (fetch) => createGitHubClient({ baseUrl: PROXY, fetch });
const pr = (number, author = "alice") => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/${REPO}/pull/${number}`,
  author,
  mergedAt: MERGED_AT,
});
const restPr = (number, merged_at = MERGED_AT, user = { login: "alice" }) => ({
  number,
  title: pr(number).title,
  html_url: pr(number).url,
  merged_at,
  user,
});

const restClient = (secondPage) => {
  const pages = [];
  const client = clientOn(async (url) => {
    const { pathname, searchParams } = new URL(url);
    assert.equal(pathname, PULLS_PATH);
    const page = searchParams.get("page") ?? "1";
    pages.push(page);
    if (page === "1") {
      assert.equal(searchParams.get("state"), "closed");
      assert.equal(searchParams.get("sort"), "updated");
      assert.equal(searchParams.get("direction"), "desc");
      return Response.json([restPr(4), restPr(3, null)], {
        headers: { link: `<https://proxy.example${PULLS_PATH}?page=2>; rel="next"` },
      });
    }
    assert.equal(page, "2");
    return secondPage();
  });
  return { client, pages };
};

test("REST listing walks closed pulls, counts only merges and stops at the limit", async () => {
  const { client, pages } = restClient(() =>
    Response.json([restPr(2, MERGED_AT, null), restPr(1)], {
      headers: { link: `<https://proxy.example${PULLS_PATH}?page=3>; rel="next"` },
    }),
  );
  assert.deepEqual(await client.listMergedPrs(REPO, 2), [pr(4), pr(2, null)]);
  assert.deepEqual(pages, ["1", "2"]);
});

test("REST listing returns all available merges if the link chain ends below the limit", async () => {
  const { client, pages } = restClient(() => Response.json([restPr(2)]));
  assert.deepEqual(await client.listMergedPrs(REPO, 50), [pr(4), pr(2)]);
  assert.deepEqual(pages, ["1", "2"]);
});

test("REST listing rejects a late-page failure instead of returning partial results", async () => {
  const { client, pages } = restClient(() => new Response(null, { status: 500 }));
  await assert.rejects(() => client.listMergedPrs(REPO, 50), { status: 500 });
  assert.deepEqual(pages, ["1", "2"]);
});

const searchNode = (number, mergedAt = MERGED_AT) => ({
  ...pr(number),
  mergedAt,
  author: { login: "alice" },
});
const searchPage = (nodes, endCursor = null) =>
  Response.json({
    data: { search: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } },
  });

test("windowed listing filters by merge time on GitHub and pages by cursor", async () => {
  // Filtering after the REST update-sorted limit can hide merges inside the window.
  const cursors = [];
  const client = clientOn(async (url, init) => {
    assert.equal(new URL(url).pathname, "/devbot-proxy/github/graphql");
    const { search, cursor } = JSON.parse(init.body).variables;
    assert.deepEqual(search.split(/\s+/).sort(), [
      "is:merged",
      "is:pr",
      `merged:>=${SINCE}`,
      `repo:"${REPO}"`,
    ]);
    cursors.push(cursor);
    if (cursor === null) return searchPage([searchNode(4), searchNode(3, null)], "next");
    assert.equal(cursor, "next");
    return searchPage([searchNode(2), searchNode(1)], "unused");
  });

  const since = new Date("2026-11-17T13:00:00+01:00");
  assert.deepEqual(await client.listMergedPrs(REPO, 2, since), [pr(4), pr(2)]);
  assert.deepEqual(cursors, [null, "next"]);
});

test("windowed listing stops when the search is exhausted, even below the limit", async () => {
  const client = clientOn(async (_url, init) => {
    const { cursor } = JSON.parse(init.body).variables;
    if (cursor === null) return searchPage([searchNode(4)], "last");
    assert.equal(cursor, "last");
    return searchPage([]);
  });
  assert.deepEqual(await client.listMergedPrs(REPO, 50, SINCE), [pr(4)]);
});

test("windowed listing rejects a late-page failure instead of returning partial results", async () => {
  const client = clientOn(async (_url, init) => {
    const { cursor } = JSON.parse(init.body).variables;
    return cursor === null
      ? searchPage([searchNode(4)], "next")
      : new Response(null, { status: 500 });
  });
  await assert.rejects(() => client.listMergedPrs(REPO, 50, SINCE), { status: 500 });
});

test("invalid merge windows and zero limits do not fetch", async () => {
  const client = clientOn(async () => assert.fail("unexpected fetch"));
  await assert.rejects(() => client.listMergedPrs(REPO, 50, "yesterday"), /mergedSince/);
  assert.deepEqual(await client.listMergedPrs(REPO, 0, SINCE), []);
  assert.deepEqual(await client.listMergedPrs(REPO, 0), []);
});

const treeClient = (reply) => {
  const branches = [];
  const client = clientOn(async (url) => {
    const { pathname, searchParams } = new URL(url);
    const branch = pathname.split("/").at(-1);
    assert.equal(pathname, `/devbot-proxy/github/repos/${REPO}/git/trees/${branch}`);
    assert.equal(searchParams.get("recursive"), "1");
    branches.push(branch);
    return reply(branch);
  });
  return { branches, client };
};

test("repo listing falls back from main to master on 404 and returns only blobs", async () => {
  const { branches, client } = treeClient((branch) => {
    if (branch === "main") return new Response(null, { status: 404 });
    return Response.json({
      tree: [
        { type: "tree", path: "src" },
        { type: "blob", path: "src/a.spec.ts" },
        { type: "commit", path: "vendor/submodule" },
      ],
    });
  });
  assert.deepEqual(await client.listRepoFiles(REPO), ["src/a.spec.ts"]);
  assert.deepEqual(branches, ["main", "master"]);
});

for (const { branch, status, expected } of [
  { status: 404, expected: ["main", "master"] },
  { status: 500, expected: ["main"] },
  { branch: "develop", status: 404, expected: ["develop"] },
]) {
  test(`repo listing surfaces ${status} after trying ${expected.join(" then ")}`, async () => {
    const { branches, client } = treeClient(() => new Response(null, { status }));
    await assert.rejects(
      () => client.listRepoFiles(REPO, branch),
      (error) => {
        assert.ok(error instanceof PreflightHttpError);
        assert.equal(error.status, status);
        assert.equal(new URL(error.url).pathname.split("/").at(-1), expected.at(-1));
        if (status === 404) assert.equal(error.routeUnavailable, true);
        return true;
      },
    );
    assert.deepEqual(branches, expected);
  });
}
