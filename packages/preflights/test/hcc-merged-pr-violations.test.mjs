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
 * active-window/capacity/concurrency gates, the lookback filter, the
 * security-scan exclusion, the per-finding dedup against the memory
 * server, and the violation content. Fixture-based only: the memory-server
 * client takes an injectable fetch and the GitHub client is a fake object,
 * so no test touches the network.
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

/**
 * Memory client whose exact-key lookups (the `offset`-paginated
 * `/api/tasks` requests `getTaskByKey` makes) fail while the listing and
 * capacity fetches succeed — for the fail-closed dedup tests.
 */
const lookupFailingMemoryClient = (tasks, failure) =>
  createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async (url) => {
      if (new URL(url).searchParams.has("offset")) {
        return failure();
      }
      return jsonResponse({ items: tasks });
    },
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
    listMergedPrs: async (ownerRepo, limit, since) => {
      calls.lists.push({ ownerRepo, limit, since });
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

// Tuesday 14:00 Europe/Prague (CEST) — inside the Mon–Fri 09:00–23:00
// active window; every scanning test fixes the clock here.
const NOW = () => new Date("2026-07-21T12:00:00Z");
const SINCE = new Date("2026-07-20T12:00:00Z");

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

const failingRollup = (names) => ({
  state: "MERGED",
  statusCheckRollup: names.map((name) => ({ name, conclusion: "FAILURE" })),
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

test("skips outside the manager active window (Mon–Fri 09:00–23:00 Europe/Prague)", async () => {
  const outside = [
    ["2026-07-21T06:30:00Z", "before 09:00 local (CEST)"],
    ["2026-07-21T21:00:00Z", "at 23:00 local — end is exclusive"],
    ["2026-07-25T12:00:00Z", "Saturday"],
    ["2026-11-18T07:30:00Z", "08:30 local in winter (CET) — DST-aware"],
  ];
  for (const [iso, why] of outside) {
    const github = fakeGithub();
    const result = await run(
      { memory: fixtureMemoryClient([]), github, repos: REPOS, now: () => new Date(iso) },
      {},
    );
    assert.deepEqual(
      result,
      {
        status: "skip",
        content: "Outside the manager active window (Mon–Fri 09:00–23:00 Europe/Prague)",
      },
      `${iso} (${why})`,
    );
    // The window gate fires before any upstream work.
    assert.deepEqual(github.calls.lists, [], `${iso} (${why})`);
  }
});

test("runs inside the active window across DST offsets", async () => {
  const inside = [
    ["2026-07-21T07:00:00Z", "09:00 local in summer (CEST) — start inclusive"],
    ["2026-11-18T08:30:00Z", "09:30 local in winter (CET)"],
  ];
  for (const [iso, why] of inside) {
    // Merged one hour before the injected clock — inside the lookback.
    const mergedAt = new Date(new Date(iso).getTime() - 3_600_000).toISOString();
    const github = fakeGithub({
      mergedPrs: { "org/repo-a": [mergedPr(12, mergedAt)] },
      prs: { "org/repo-a#12": failingRollup(["lint"]) },
    });
    const result = await run(
      { memory: fixtureMemoryClient([]), github, repos: REPOS, now: () => new Date(iso) },
      { scan_only_repos: ["repo-a"], lookback_hours: 48 },
    );
    assert.equal(result.status, "start", `${iso} (${why})`);
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
    external_key: `merge-violation:repo-${i}:${i + 1}`,
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

test("scan_only_repos filters the repo map; non-GitHub repos are never listed; mergedSince is passed", async () => {
  const github = fakeGithub({
    mergedPrs: { "org/repo-b": [mergedPr(3, "2026-07-21T10:00:00Z")] },
  });
  const result = await run(
    { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-b", "repo-gl", "not-in-map"] },
  );
  assert.deepEqual(github.calls.lists, [{ ownerRepo: "org/repo-b", limit: 50, since: SINCE }]);
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
      "org/repo-a#10": failingRollup(["lint"]),
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

// --- per-finding dedup ---

test("a tracked finding (any status, archived included) is skipped; an untracked one is started with its exact key", async () => {
  for (const status of ["archived", "done", "in_progress", "pr_open"]) {
    const github = fakeGithub({
      mergedPrs: {
        "org/repo-a": [
          mergedPr(10, "2026-07-21T10:00:00Z", "alice"),
          mergedPr(11, "2026-07-21T10:30:00Z", "bob"),
        ],
      },
      prs: {
        "org/repo-a#10": failingRollup(["lint"]),
        "org/repo-a#11": failingRollup(["test"]),
      },
    });
    const result = await run(
      {
        memory: fixtureMemoryClient([
          { external_key: "merge-violation:repo-a:10", status, source_type: "jira" },
        ]),
        github,
        repos: REPOS,
        now: NOW,
      },
      { scan_only_repos: ["repo-a"] },
    );
    assert.equal(result.status, "start", `tracked status ${status}`);
    assert.doesNotMatch(result.content, /repo-a #10/, `tracked status ${status}`);
    assert.match(result.content, /repo-a #11: PR 11 \(@bob, 2026-07-21\)/);
    assert.match(result.content, /failed: test/);
    assert.match(result.content, /Task ID: merge-violation:repo-a:11/);
  }
});

test("a key tracked under a different source_type is a different task — the finding is started", async () => {
  const github = fakeGithub({
    mergedPrs: { "org/repo-a": [mergedPr(10, "2026-07-21T10:00:00Z")] },
    prs: { "org/repo-a#10": failingRollup(["lint"]) },
  });
  const result = await run(
    {
      memory: fixtureMemoryClient([
        { external_key: "merge-violation:repo-a:10", status: "in_progress", source_type: "github" },
      ]),
      github,
      repos: REPOS,
      now: NOW,
    },
    { scan_only_repos: ["repo-a"] },
  );
  assert.equal(result.status, "start");
  assert.match(result.content, /Task ID: merge-violation:repo-a:10/);
});

test("all findings tracked skips", async () => {
  const github = fakeGithub({
    mergedPrs: {
      "org/repo-a": [mergedPr(10, "2026-07-21T10:00:00Z"), mergedPr(11, "2026-07-21T10:30:00Z")],
    },
    prs: {
      "org/repo-a#10": failingRollup(["lint"]),
      "org/repo-a#11": failingRollup(["test"]),
    },
  });
  const result = await run(
    {
      memory: fixtureMemoryClient([
        { external_key: "merge-violation:repo-a:10", status: "in_progress", source_type: "jira" },
        { external_key: "merge-violation:repo-a:11", status: "archived", source_type: "jira" },
      ]),
      github,
      repos: REPOS,
      now: NOW,
    },
    { scan_only_repos: ["repo-a"] },
  );
  assert.deepEqual(result, { status: "skip", content: "All 2 violation(s) already tracked" });
});

test("memory-server lookup auth rejection fails the run — never a start", async () => {
  const github = fakeGithub({
    mergedPrs: { "org/repo-a": [mergedPr(10, "2026-07-21T10:00:00Z")] },
    prs: { "org/repo-a#10": failingRollup(["lint"]) },
  });
  await assert.rejects(
    () =>
      run(
        {
          memory: lookupFailingMemoryClient(
            [],
            () => new Response("unauthorized", { status: 401 }),
          ),
          github,
          repos: REPOS,
          now: NOW,
        },
        { scan_only_repos: ["repo-a"] },
      ),
    (error) => {
      assert.equal(error.name, "MemoryAuthRejectedError");
      assert.equal(error.status, 401);
      return true;
    },
  );
});

test("a malformed lookup page fails the run — never mistaken for untracked", async () => {
  const github = fakeGithub({
    mergedPrs: { "org/repo-a": [mergedPr(10, "2026-07-21T10:00:00Z")] },
    prs: { "org/repo-a#10": failingRollup(["lint"]) },
  });
  await assert.rejects(
    () =>
      run(
        {
          memory: lookupFailingMemoryClient([], () => jsonResponse({})),
          github,
          repos: REPOS,
          now: NOW,
        },
        { scan_only_repos: ["repo-a"] },
      ),
    (error) => {
      assert.match(error.message, /merge-violation:repo-a:10/);
      assert.match(error.message, /returned no items array/);
      return true;
    },
  );
});

// --- content ---

test("untracked violations start with the Python content plus per-finding Task ID lines", async () => {
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
      "Track each Jira ticket using its Task ID as external_key, source_type jira,\n" +
      "instance_id from BOT_INSTANCE_ID, and metadata.jira_key set to the ticket key.\n" +
      "Keep the task active while awaiting feedback.\n\n" +
      "high:\n" +
      "  - repo-a #12: PR 12 (@alice, 2026-07-21)\n" +
      "    failed: lint, test\n" +
      "    Task ID: merge-violation:repo-a:12\n",
  });
});

// --- failure policy ---

test("an isolated repo-listing failure skips that repo and is reported as evidence", async () => {
  const github = fakeGithub({
    mergedPrs: {
      "org/repo-a": httpError(500),
      "org/repo-b": [mergedPr(5, "2026-07-21T10:00:00Z", "bob")],
    },
    prs: {
      "org/repo-b#5": failingRollup(["lint"]),
    },
  });
  const result = await run({ memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW }, {});
  assert.equal(result.status, "start");
  assert.match(result.content, /repo-b #5/);
  assert.match(result.content, /Task ID: merge-violation:repo-b:5/);
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
      "org/repo-a#11": failingRollup(["lint"]),
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
