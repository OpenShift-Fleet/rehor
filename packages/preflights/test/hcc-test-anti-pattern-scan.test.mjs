import assert from "node:assert/strict";
import test from "node:test";
import {
  HCC_TEST_ANTI_PATTERN_SCAN_INPUT,
  patternMatchesFile,
  repoScanTaskKey,
  runHccTestAntiPatternScan,
} from "../dist/preflights/hcc-test-anti-pattern-scan/index.js";
import { PreflightHttpError } from "../dist/shared/http.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";

/**
 * Port of the hcc-framework-agent-dev quality-monitor preflight
 * `02-scan-test-anti-patterns.py` coverage, adapted to the TS module API:
 * the schedule window (quality KEDA Mon–Fri 09:00–23:00 Europe/Prague),
 * the capacity/concurrency gates, the per-repo/day deterministic tracking
 * gate, the simplified pattern and exclude matching, framework detection,
 * the per-run caps, and the content (per-repo tracking keys plus the
 * completion-gating instruction). Fixture-based only: the memory-server
 * client takes an injectable fetch and the GitHub client is a fake object,
 * so no test touches the network.
 */

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Memory-server fixture. `tasks` serves the listing/capacity calls (the
 * URLs carrying `exclude_status`); `keyTasks` serves the exact-key gate
 * lookups (which send no `exclude_status`), with `keyStatus` simulating a
 * failing lookup. `calls` counts both so tests can assert the schedule
 * gate fired before any memory call.
 */
const memoryFixture = ({ tasks = [], keyTasks = [], keyStatus = 200 } = {}) => {
  const calls = { listings: 0, lookups: 0 };
  const memory = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async (url) => {
      if (!String(url).includes("exclude_status")) {
        calls.lookups += 1;
        if (keyStatus !== 200) {
          return new Response("denied", { status: keyStatus });
        }
        return jsonResponse({ items: keyTasks });
      }
      calls.listings += 1;
      return jsonResponse({ items: tasks });
    },
  });
  return { memory, calls };
};

const httpError = (status = 500) =>
  new PreflightHttpError({
    status,
    method: "GET",
    url: "https://proxy.example/github/repos/org/repo-a/git/trees/main?recursive=1",
    route: "https://proxy.example/github",
    message: `GET failed with HTTP ${status}`,
  });

/** Fake GitHubClient: file trees keyed by upstream, call recording. */
const fakeGithub = ({ files = {} } = {}) => {
  const calls = { trees: [] };
  return {
    calls,
    route: "https://proxy.example/github",
    listRepoFiles: async (ownerRepo, branch) => {
      calls.trees.push({ ownerRepo, branch });
      const listed = files[ownerRepo];
      if (listed instanceof Error) throw listed;
      return listed ?? [];
    },
    getPr: async () => null,
    getPrComments: async () => [],
    listMergedPrs: async () => [],
  };
};

// Tuesday 2026-07-21, 12:00 UTC = 14:00 Prague (CEST) — inside the window.
const NOW = () => new Date("2026-07-21T12:00:00Z");
const KEY_A = "test-scan:repo-a:2026-07-21";
const KEY_B = "test-scan:repo-b:2026-07-21";
const OUTSIDE_WINDOW = "Outside the quality scan window (Mon–Fri 09:00–23:00 Europe/Prague)";

const REPOS = {
  "repo-a": { upstream: "https://github.com/org/repo-a" },
  "repo-b": { upstream: "https://github.com/org/repo-b" },
  "repo-c": { upstream: "https://github.com/org/repo-c" },
  "repo-gl": { upstream: "https://gitlab.com/org/repo-gl" },
};

const parseParams = (with_) =>
  HCC_TEST_ANTI_PATTERN_SCAN_INPUT.parse(with_ ?? { scan_only_repos: ["repo-a"] });

const run = (deps, with_) => runHccTestAntiPatternScan(deps, parseParams(with_));

// --- pattern matching (the Python simplified matcher) ---

test("patternMatchesFile: suffix match after stripping the double-star prefix and leading star", () => {
  assert.equal(patternMatchesFile("**/*.spec.ts", "src/deep/a.spec.ts"), true);
  assert.equal(patternMatchesFile("**/*.spec.ts", "a.spec.ts"), true);
  assert.equal(patternMatchesFile("**/*.test.ts", "src/a.spec.ts"), false);
  assert.equal(patternMatchesFile("e2e/**/*.test.ts", "tests/a.test.ts"), true);
  assert.equal(patternMatchesFile("tests/**/*.spec.ts", "src/a.spec.ts"), true);
  assert.equal(patternMatchesFile("*.spec.ts", "a.spec.ts"), true);
  assert.equal(patternMatchesFile("**/playwright.config.ts", "playwright.config.ts"), true);
  assert.equal(patternMatchesFile("**/playwright.config.ts", "config/playwright.config.ts"), true);
  assert.equal(patternMatchesFile("**/*.spec.ts", "src/a.spec.tsx"), false);
  assert.equal(patternMatchesFile("*", "anything"), false);
  // Mid-pattern stars stay literal: the Python simplified matcher only
  // recognized leading-star extension patterns, so `test_*.py` never
  // matched anything there either.
  assert.equal(patternMatchesFile("**/test_*.py", "tests/test_x.py"), false);
});

// --- tracking key ---

test("repoScanTaskKey: prefix, repo name, and the UTC calendar date", () => {
  // 23:30 UTC is still the same UTC day even where the local day differs.
  assert.equal(repoScanTaskKey("test-scan", "repo-a", new Date("2026-07-21T23:30:00Z")), KEY_A);
  assert.equal(repoScanTaskKey("p", "r", new Date("2026-01-01T00:00:00Z")), "p:r:2026-01-01");
});

// --- schedule gate (quality KEDA Mon–Fri 09:00–23:00 Europe/Prague) ---

test("weekends skip outside the quality window, before any memory or GitHub call", async () => {
  for (const iso of ["2026-07-18T10:00:00Z", "2026-07-19T10:00:00Z"]) {
    const { memory, calls } = memoryFixture();
    const github = fakeGithub({ files: { "org/repo-a": ["a.spec.ts"] } });
    const result = await run(
      { memory, github, repos: REPOS, now: () => new Date(iso) },
      { scan_only_repos: ["repo-a"] },
    );
    assert.deepEqual(result, { status: "skip", content: OUTSIDE_WINDOW });
    assert.deepEqual(calls, { listings: 0, lookups: 0 });
    assert.deepEqual(github.calls.trees, []);
  }
});

test("skips before the Prague open and at/after the close (summer CEST)", async () => {
  // Monday 2026-07-20, CEST (UTC+2): 06:30Z is 08:30 Prague (before the
  // 09:00 open); 21:00Z is exactly 23:00 (the exclusive close); 21:30Z is
  // 23:30.
  for (const iso of ["2026-07-20T06:30:00Z", "2026-07-20T21:00:00Z", "2026-07-20T21:30:00Z"]) {
    const result = await run(
      {
        memory: memoryFixture().memory,
        github: fakeGithub(),
        repos: REPOS,
        now: () => new Date(iso),
      },
      { scan_only_repos: ["repo-a"] },
    );
    assert.deepEqual(result, { status: "skip", content: OUTSIDE_WINDOW });
  }
});

test("the Prague open is inclusive: 07:00Z (09:00 CEST) proceeds past the window gate", async () => {
  const result = await run(
    { memory: memoryFixture().memory, github: fakeGithub(), repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a"] },
  );
  // Past the window gate the run scans repo-a (empty tree) and skips.
  assert.deepEqual(result, { status: "skip", content: "Scanned 1 repos, no test files found" });
});

test("DST boundary: the same UTC hour is inside the window in summer and outside in winter", async () => {
  const deps = () => ({ memory: memoryFixture().memory, github: fakeGithub(), repos: REPOS });
  // 07:30Z: 09:30 Prague in July (CEST) — inside; 08:30 in January (CET)
  // — outside. The Prague wall clock decides, not the UTC hour.
  const july = await run(
    { ...deps(), now: () => new Date("2026-07-20T07:30:00Z") },
    {
      scan_only_repos: ["repo-a"],
    },
  );
  assert.deepEqual(july, { status: "skip", content: "Scanned 1 repos, no test files found" });
  const january = await run(
    { ...deps(), now: () => new Date("2026-01-05T07:30:00Z") },
    {
      scan_only_repos: ["repo-a"],
    },
  );
  assert.deepEqual(january, { status: "skip", content: OUTSIDE_WINDOW });
  // The winter open is an hour earlier in UTC: 08:00Z is exactly 09:00
  // CET — the inclusive start.
  const winterOpen = await run(
    { ...deps(), now: () => new Date("2026-01-05T08:00:00Z") },
    {
      scan_only_repos: ["repo-a"],
    },
  );
  assert.deepEqual(winterOpen, { status: "skip", content: "Scanned 1 repos, no test files found" });
});

// --- capacity and concurrency gates ---

test("skips at capacity", async () => {
  const tasks = Array.from({ length: 10 }, (_, i) => ({
    external_key: `X-${i}`,
    status: "in_progress",
  }));
  const result = await run(
    { memory: memoryFixture({ tasks }).memory, github: fakeGithub(), repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a"] },
  );
  assert.deepEqual(result, { status: "skip", content: "At capacity (10/10)" });
});

test("skips while MAX_CONCURRENT_SCANS active scan tasks are running", async () => {
  const tasks = Array.from({ length: 5 }, (_, i) => ({
    external_key: `test-scan:repo-${i}`,
    status: "in_progress",
  }));
  const result = await run(
    { memory: memoryFixture({ tasks }).memory, github: fakeGithub(), repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a"] },
  );
  assert.deepEqual(result, { status: "skip", content: "Already processing 5 test scans" });
});

test("done tracking tasks do not count toward the concurrency gate", async () => {
  const tasks = Array.from({ length: 5 }, (_, i) => ({
    external_key: `test-scan:repo-${i}`,
    status: "done",
  }));
  const result = await run(
    { memory: memoryFixture({ tasks }).memory, github: fakeGithub(), repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a"] },
  );
  assert.deepEqual(result, { status: "skip", content: "Scanned 1 repos, no test files found" });
});

test("a whitelist that matches no instance repo skips", async () => {
  const result = await run(
    { memory: memoryFixture().memory, github: fakeGithub(), repos: REPOS, now: NOW },
    { scan_only_repos: ["nope"] },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: "No repositories configured in scan_only_repos",
  });
});

// --- per-repo/day deterministic gate ---

test("one repo tracked, the second still scanned and emitted", async () => {
  const { memory, calls } = memoryFixture({ keyTasks: [{ external_key: KEY_A, status: "done" }] });
  const github = fakeGithub({
    files: { "org/repo-a": ["a.spec.ts"], "org/repo-b": ["b.spec.ts"] },
  });
  const result = await run(
    { memory, github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a", "repo-b"] },
  );
  // Only repo-b is listed and emitted; both gate checks share one task page.
  assert.deepEqual(
    github.calls.trees.map((call) => call.ownerRepo),
    ["org/repo-b"],
  );
  assert.equal(calls.lookups, 1);
  assert.equal(result.status, "start");
  assert.match(result.content, /repo-b \(1 files, generic\):/);
  assert.doesNotMatch(result.content, /repo-a/);
  assert.match(result.content, new RegExp(`Task ID: ${KEY_B}`));
});

test("a repo tracked in any status — archived included — is skipped", async () => {
  for (const status of ["done", "in_progress", "archived"]) {
    const { memory } = memoryFixture({ keyTasks: [{ external_key: KEY_A, status }] });
    const github = fakeGithub({ files: { "org/repo-a": ["a.spec.ts"] } });
    const result = await run(
      { memory, github, repos: REPOS, now: NOW },
      { scan_only_repos: ["repo-a"] },
    );
    assert.deepEqual(github.calls.trees, []);
    assert.deepEqual(result, { status: "skip", content: "All 1 repos already scanned today" });
  }
});

test("all repos tracked: skip without any GitHub call", async () => {
  const { memory } = memoryFixture({
    keyTasks: [
      { external_key: KEY_A, status: "done" },
      { external_key: KEY_B, status: "done" },
    ],
  });
  const github = fakeGithub({
    files: { "org/repo-a": ["a.spec.ts"], "org/repo-b": ["b.spec.ts"] },
  });
  const result = await run(
    { memory, github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a", "repo-b"] },
  );
  assert.deepEqual(github.calls.trees, []);
  assert.deepEqual(result, { status: "skip", content: "All 2 repos already scanned today" });
});

test("tracked repos do not consume max_repos_per_scan slots", async () => {
  const { memory } = memoryFixture({ keyTasks: [{ external_key: KEY_A, status: "done" }] });
  const github = fakeGithub({
    files: { "org/repo-b": ["b.spec.ts"], "org/repo-c": ["c.spec.ts"] },
  });
  const result = await run(
    { memory, github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a", "repo-b", "repo-c"], max_repos_per_scan: 2 },
  );
  // repo-a is skipped as tracked without taking a slot, so the cap still
  // admits repo-b and repo-c.
  assert.deepEqual(
    github.calls.trees.map((call) => call.ownerRepo),
    ["org/repo-b", "org/repo-c"],
  );
  assert.equal(result.status, "start");
});

test("a gate-lookup auth failure fails closed, never treated as untracked", async () => {
  const { memory } = memoryFixture({ keyStatus: 401 });
  const github = fakeGithub({ files: { "org/repo-a": ["a.spec.ts"] } });
  await assert.rejects(
    () => run({ memory, github, repos: REPOS, now: NOW }, { scan_only_repos: ["repo-a"] }),
    (error) => {
      assert.equal(error.name, "MemoryAuthRejectedError");
      assert.match(error.message, /authenticated request rejected/);
      return true;
    },
  );
  assert.deepEqual(github.calls.trees, []);
});

test("a gate-lookup server failure also fails closed", async () => {
  const { memory } = memoryFixture({ keyStatus: 500 });
  const github = fakeGithub({ files: { "org/repo-a": ["a.spec.ts"] } });
  await assert.rejects(
    () => run({ memory, github, repos: REPOS, now: NOW }, { scan_only_repos: ["repo-a"] }),
    (error) => {
      assert.ok(error instanceof PreflightHttpError);
      assert.equal(error.status, 500);
      return true;
    },
  );
});

// --- scanning ---

test("matches test files by suffix, applies excludes, and detects the framework", async () => {
  const github = fakeGithub({
    files: {
      "org/repo-a": [
        "playwright.config.ts",
        "src/a.spec.ts",
        "src/deep/b.test.ts",
        "src/util.ts",
        "node_modules/x.spec.ts",
        "dist/y.spec.ts",
        "playwright-report/z.test.ts",
      ],
    },
  });
  const result = await run(
    { memory: memoryFixture().memory, github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a"] },
  );
  assert.deepEqual(github.calls.trees, [{ ownerRepo: "org/repo-a", branch: undefined }]);
  assert.equal(result.status, "start");
  assert.match(result.content, /# Test Files for Anti-Pattern Analysis \(2 files\)/);
  assert.match(result.content, /repo-a \(2 files, playwright\):/);
  assert.match(result.content, / {2}src\/a\.spec\.ts, src\/deep\/b\.test\.ts\n/);
  assert.match(result.content, new RegExp(` {2}Task ID: ${KEY_A}`));
});

test("a repo without framework indicators scans as generic", async () => {
  const github = fakeGithub({
    files: { "org/repo-a": ["jest.config.js", "src/a.test.ts"] },
  });
  const result = await run(
    { memory: memoryFixture().memory, github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a"] },
  );
  assert.equal(result.status, "start");
  assert.match(result.content, /repo-a \(1 files, generic\):/);
});

test("max_repos_per_scan caps the repo list to the first whitelisted matches", async () => {
  const github = fakeGithub({
    files: {
      "org/repo-a": ["a.spec.ts"],
      "org/repo-b": ["b.spec.ts"],
      "org/repo-c": ["c.spec.ts"],
    },
  });
  const result = await run(
    { memory: memoryFixture().memory, github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a", "repo-b", "repo-c"], max_repos_per_scan: 2 },
  );
  assert.deepEqual(
    github.calls.trees.map((call) => call.ownerRepo),
    ["org/repo-a", "org/repo-b"],
  );
  assert.equal(result.status, "start");
  assert.match(result.content, /# Test Files for Anti-Pattern Analysis \(2 files\)/);
});

test("max_files_per_repo caps the matched files per repo", async () => {
  const github = fakeGithub({
    files: { "org/repo-a": ["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts"] },
  });
  const result = await run(
    { memory: memoryFixture().memory, github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a"], max_files_per_repo: 2 },
  );
  assert.equal(result.status, "start");
  assert.match(result.content, /repo-a \(2 files, generic\):/);
  assert.match(result.content, / {2}a\.spec\.ts, b\.spec\.ts\n/);
});

test("custom patterns and excludes apply", async () => {
  const github = fakeGithub({
    files: { "org/repo-a": ["src/a.spec.ts", "generated/b.spec.ts", "src/a.test.ts"] },
  });
  const result = await run(
    { memory: memoryFixture().memory, github, repos: REPOS, now: NOW },
    {
      scan_only_repos: ["repo-a"],
      patterns: ["**/*.spec.ts"],
      exclude_substrings: ["generated/"],
    },
  );
  assert.equal(result.status, "start");
  assert.match(result.content, /repo-a \(1 files, generic\):/);
  assert.match(result.content, / {2}src\/a\.spec\.ts\n/);
});

test("no matched test files skips — the agent is not triggered for empty file lists", async () => {
  const github = fakeGithub({
    files: { "org/repo-a": ["src/util.ts", "package.json"] },
  });
  const result = await run(
    { memory: memoryFixture().memory, github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a", "repo-b"] },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: "Scanned 2 repos, no test files found",
  });
});

test("non-GitHub repos in the whitelist are never listed or gate-checked", async () => {
  const github = fakeGithub({ files: {} });
  const { memory, calls } = memoryFixture();
  const result = await run(
    { memory, github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-gl"] },
  );
  assert.deepEqual(github.calls.trees, []);
  assert.equal(calls.lookups, 0);
  // The gitlab repo counts as scanned for the skip summary.
  assert.deepEqual(result, { status: "skip", content: "Scanned 1 repos, no test files found" });
});

test("an isolated listing failure is reported as evidence", async () => {
  const github = fakeGithub({
    files: {
      "org/repo-a": httpError(500),
      "org/repo-b": ["b.spec.ts"],
    },
  });
  const result = await run(
    { memory: memoryFixture().memory, github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a", "repo-b"] },
  );
  assert.equal(result.status, "start");
  assert.match(result.content, /repo-b \(1 files/);
  assert.match(result.content, /### UNFETCHABLE \(1\)/);
  assert.match(result.content, / {2}repo org\/repo-a: HTTP 500/);
});

test("every attempted listing failing escalates to an execution error", async () => {
  const github = fakeGithub({
    files: {
      "org/repo-a": httpError(500),
      "org/repo-b": httpError(502),
    },
  });
  await assert.rejects(
    () =>
      run(
        { memory: memoryFixture().memory, github, repos: REPOS, now: NOW },
        { scan_only_repos: ["repo-a", "repo-b"] },
      ),
    (error) => {
      assert.match(error.message, /GitHub route https:\/\/proxy.example\/github is not usable/);
      assert.match(error.message, /repo file list fetches attempted, 0 succeeded/);
      return true;
    },
  );
});

// --- start content: per-repo keys and the completion-gating instruction ---

test("start content carries each repo's tracking key and the completion-gating instruction", async () => {
  const github = fakeGithub({
    files: { "org/repo-a": ["a.spec.ts"], "org/repo-b": ["b.spec.ts"] },
  });
  const result = await run(
    { memory: memoryFixture().memory, github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a", "repo-b"] },
  );
  assert.equal(result.status, "start");
  // One deterministic key per repo, in that repo's section.
  assert.match(result.content, new RegExp(`Task ID: ${KEY_A}`));
  assert.match(result.content, new RegExp(`Task ID: ${KEY_B}`));
  // The instruction: a completed tracking task, created only after the
  // analysis finishes — including when no ticket is needed.
  assert.match(result.content, /create its scan-tracking task/);
  assert.match(result.content, /status in_progress and\nmetadata\.jira_key/);
  assert.match(result.content, /completed scan with status done/);
  assert.match(result.content, /even when no ticket is needed/);
  assert.match(result.content, /only after analysis is complete/);
  assert.match(result.content, /would hide unfinished work from the next run/);
});
