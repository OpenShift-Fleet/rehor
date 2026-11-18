import assert from "node:assert/strict";
import test from "node:test";
import {
  HCC_MERGED_PR_VIOLATIONS_INPUT,
  isSecurityScan,
  runHccMergedPrViolations,
} from "../dist/preflights/hcc-merged-pr-violations/index.js";
import { PreflightHttpError } from "../dist/shared/http.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";

/**
 * Port of the hcc-framework-agent-dev quality-monitor preflight
 * `01-check-merged-prs.py` coverage, adapted to the TS module API: the
 * capacity/daily-task/concurrency gates, the lookback filter, the
 * security-scan exclusion, and the violation content. Fixture-based only:
 * the memory-server client takes an injectable fetch and the GitHub client
 * is a fake object, so no test touches the network.
 */

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fixtureMemoryClient = (tasks) =>
  createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async () => jsonResponse({ items: tasks }),
  });

const httpError = (status = 500) =>
  new PreflightHttpError({
    status,
    method: "GET",
    url: "https://proxy.example/github/repos/org/repo-a/pulls",
    route: "https://proxy.example/github",
    message: `GET https://proxy.example/github/repos/org/repo-a/pulls failed with HTTP ${status}`,
  });

/**
 * Fake GitHubClient: merged-PR lists keyed by upstream, PR details keyed by
 * `upstream#number` (an Error instance makes that fetch fail), call
 * recording. Values may also be Error instances to fail the listing.
 */
const fakeGithub = ({ mergedPrs = {}, prs = {} } = {}) => {
  const calls = { lists: [], prs: [] };
  return {
    calls,
    route: "https://proxy.example/github",
    listMergedPrs: async (ownerRepo, limit) => {
      calls.lists.push({ ownerRepo, limit });
      const listed = mergedPrs[ownerRepo];
      if (listed instanceof Error) throw listed;
      return listed ?? [];
    },
    getPr: async (ownerRepo, number) => {
      calls.prs.push(`${ownerRepo}#${number}`);
      const pr = prs[`${ownerRepo}#${number}`];
      if (pr instanceof Error) throw pr;
      return pr ?? null;
    },
    getPrComments: async () => [],
    listRepoFiles: async () => [],
  };
};

const NOW = () => new Date("2026-07-21T12:00:00Z");
const DAILY_KEY = "merge-violations-2026-07-21";

const REPOS = {
  "repo-a": { upstream: "https://github.com/org/repo-a" },
  "repo-b": { upstream: "https://github.com/org/repo-b" },
  "repo-gl": { upstream: "https://gitlab.com/org/repo-gl" },
};

const mergedPr = (number, mergedAt, author = "alice") => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/org/repo-a/pull/${number}`,
  author,
  mergedAt,
});

const parseParams = (with_) => HCC_MERGED_PR_VIOLATIONS_INPUT.parse(with_ ?? {});

const run = (deps, with_) => runHccMergedPrViolations(deps, parseParams(with_));

// --- isSecurityScan (Python lib/security_scans.py) ---

test("is_security_scan: case-insensitive substring match on the ported patterns", () => {
  assert.equal(isSecurityScan("clair-scan-pr"), true);
  assert.equal(isSecurityScan("Clair-Scan"), true);
  assert.equal(isSecurityScan(" konflux-ci/trivy-security-scan "), true);
  assert.equal(isSecurityScan("SAST-Scan"), true);
  assert.equal(isSecurityScan("build"), false);
  assert.equal(isSecurityScan(""), false);
  assert.equal(isSecurityScan(null), false);
  assert.equal(isSecurityScan(undefined), false);
});

// --- gates ---

test("skips when the deterministic daily task already exists (any status)", async () => {
  for (const status of ["done", "in_progress"]) {
    const result = await run(
      {
        memory: fixtureMemoryClient([{ external_key: DAILY_KEY, status }]),
        github: fakeGithub(),
        repos: REPOS,
        now: NOW,
      },
      {},
    );
    assert.deepEqual(result, { status: "skip", content: `Already scanned today (${DAILY_KEY})` });
  }
});

test("skips at capacity", async () => {
  const tasks = Array.from({ length: 10 }, (_, i) => ({
    external_key: `X-${i}`,
    status: "in_progress",
  }));
  const result = await run(
    { memory: fixtureMemoryClient(tasks), github: fakeGithub(), repos: REPOS, now: NOW },
    {},
  );
  assert.deepEqual(result, { status: "skip", content: "At capacity (10/10)" });
});

test("skips while max_concurrent active violation tasks are running", async () => {
  const tasks = Array.from({ length: 5 }, (_, i) => ({
    external_key: `merge-violations:repo-${i}#1`,
    status: "pr_open",
  }));
  const result = await run(
    { memory: fixtureMemoryClient(tasks), github: fakeGithub(), repos: REPOS, now: NOW },
    {},
  );
  assert.deepEqual(result, { status: "skip", content: "Already processing 5 violations" });
});

test("an empty scan_only_repos match skips", async () => {
  const result = await run(
    { memory: fixtureMemoryClient([]), github: fakeGithub(), repos: REPOS, now: NOW },
    { scan_only_repos: ["nope"] },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: "No repositories configured in scan_only_repos",
  });
});

// --- scanning ---

test("scan_only_repos filters the repo map; non-GitHub repos are never listed", async () => {
  const github = fakeGithub({
    mergedPrs: { "org/repo-b": [mergedPr(3, "2026-07-21T10:00:00Z")] },
  });
  const result = await run(
    { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-b", "repo-gl", "not-in-map"] },
  );
  assert.deepEqual(github.calls.lists, [{ ownerRepo: "org/repo-b", limit: 50 }]);
  assert.equal(result.status, "skip");
});

test("lookback filtering keeps only merges inside the window with parseable timestamps", async () => {
  const github = fakeGithub({
    mergedPrs: {
      "org/repo-a": [
        mergedPr(10, "2026-07-21T10:00:00Z"), // 2h old — inside
        mergedPr(9, "2026-07-19T10:00:00Z"), // outside the 24h window
        mergedPr(8, "not-a-date"), // unparseable — excluded like the Python
      ],
    },
    prs: {
      "org/repo-a#10": {
        state: "MERGED",
        statusCheckRollup: [{ name: "lint", conclusion: "FAILURE" }],
      },
    },
  });
  const result = await run(
    {
      memory: fixtureMemoryClient([]),
      github,
      repos: REPOS,
      now: NOW,
    },
    { scan_only_repos: ["repo-a"] },
  );
  // Only the in-window PR was detail-fetched.
  assert.deepEqual(github.calls.prs, ["org/repo-a#10"]);
  assert.equal(result.status, "start");
  assert.match(result.content, /# Merge Violations \(1 total\)/);
});

test("a PR whose only failures are security scans is not a violation", async () => {
  const github = fakeGithub({
    mergedPrs: { "org/repo-a": [mergedPr(10, "2026-07-21T10:00:00Z")] },
    prs: {
      "org/repo-a#10": {
        state: "MERGED",
        statusCheckRollup: [
          { name: "clair-scan-pr", conclusion: "FAILURE" },
          { name: "konflux-ci/trivy-security-scan", conclusion: "FAILURE" },
        ],
      },
    },
  });
  const result = await run(
    { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a"] },
  );
  assert.equal(result.status, "skip");
  assert.match(result.content, /No merged PRs with failed checks since /);
});

test("violations start with the Python content plus the daily Task ID line", async () => {
  const github = fakeGithub({
    mergedPrs: {
      "org/repo-a": [mergedPr(12, "2026-07-21T10:00:00Z", "alice")],
    },
    prs: {
      "org/repo-a#12": {
        state: "MERGED",
        statusCheckRollup: [
          { name: "lint", conclusion: "FAILURE" },
          { name: "test", conclusion: "FAILURE" },
          { name: "e2e", conclusion: "SUCCESS" },
          { name: "sast-scan", conclusion: "FAILURE" },
        ],
      },
    },
  });
  const result = await run(
    { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a"] },
  );
  assert.deepEqual(result, {
    status: "start",
    content:
      "# Merge Violations (1 total)\n\n" +
      `- **Task ID**: ${DAILY_KEY}\n\n` +
      "high:\n" +
      "  - repo-a #12: PR 12 (@alice, 2026-07-21)\n" +
      "    failed: lint, test\n",
  });
});

test("an isolated repo-listing failure skips that repo and is reported as evidence", async () => {
  const github = fakeGithub({
    mergedPrs: {
      "org/repo-a": httpError(500),
      "org/repo-b": [mergedPr(5, "2026-07-21T10:00:00Z", "bob")],
    },
    prs: {
      "org/repo-b#5": {
        state: "MERGED",
        statusCheckRollup: [{ name: "lint", conclusion: "FAILURE" }],
      },
    },
  });
  const result = await run({ memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW }, {});
  assert.equal(result.status, "start");
  assert.match(result.content, /repo-b #5/);
  assert.match(result.content, /### UNFETCHABLE \(1\)/);
  assert.match(result.content, / {2}repo org\/repo-a: HTTP 500/);
});

test("an isolated PR-detail failure skips that PR and is reported as evidence", async () => {
  const github = fakeGithub({
    mergedPrs: {
      "org/repo-a": [mergedPr(10, "2026-07-21T10:00:00Z"), mergedPr(11, "2026-07-21T10:30:00Z")],
    },
    prs: {
      "org/repo-a#10": httpError(500),
      "org/repo-a#11": {
        state: "MERGED",
        statusCheckRollup: [{ name: "lint", conclusion: "FAILURE" }],
      },
    },
  });
  const result = await run(
    { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a"] },
  );
  assert.equal(result.status, "start");
  assert.match(result.content, /#11/);
  assert.match(result.content, /### UNFETCHABLE \(1\)/);
  assert.match(result.content, / {2}PR org\/repo-a#10: HTTP 500/);
});

test("every attempted repo listing failing escalates to an execution error", async () => {
  const github = fakeGithub({
    mergedPrs: {
      "org/repo-a": httpError(500),
      "org/repo-b": httpError(502),
    },
  });
  await assert.rejects(
    () =>
      run(
        { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
        { scan_only_repos: ["repo-a", "repo-b"] },
      ),
    (error) => {
      assert.match(error.message, /GitHub route https:\/\/proxy.example\/github is not usable/);
      assert.match(error.message, /merged-PR list fetches attempted, 0 succeeded/);
      assert.match(error.message, /org\/repo-a: HTTP 500/);
      assert.match(error.message, /org\/repo-b: HTTP 502/);
      return true;
    },
  );
});

test("every attempted PR-detail fetch failing escalates to an execution error", async () => {
  const github = fakeGithub({
    mergedPrs: { "org/repo-a": [mergedPr(10, "2026-07-21T10:00:00Z")] },
    prs: { "org/repo-a#10": httpError(500) },
  });
  await assert.rejects(
    () =>
      run(
        { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
        { scan_only_repos: ["repo-a"] },
      ),
    (error) => {
      assert.match(error.message, /GitHub route https:\/\/proxy.example\/github is not usable/);
      assert.match(error.message, /PR detail fetch attempted, 0 succeeded/);
      return true;
    },
  );
});
