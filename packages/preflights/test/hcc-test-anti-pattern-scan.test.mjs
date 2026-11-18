import assert from "node:assert/strict";
import test from "node:test";
import {
  HCC_TEST_ANTI_PATTERN_SCAN_INPUT,
  patternMatchesFile,
  runHccTestAntiPatternScan,
} from "../dist/preflights/hcc-test-anti-pattern-scan/index.js";
import { PreflightHttpError } from "../dist/shared/http.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";

/**
 * Port of the hcc-framework-agent-dev quality-monitor preflight
 * `02-scan-test-anti-patterns.py` coverage, adapted to the TS module API:
 * the capacity/daily-task/concurrency gates, the simplified pattern and
 * exclude matching, framework detection, the per-run caps, and the content.
 * Fixture-based only: the memory-server client takes an injectable fetch
 * and the GitHub client is a fake object, so no test touches the network.
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

const NOW = () => new Date("2026-07-21T12:00:00Z");
const DAILY_KEY = "test-scan-2026-07-21";

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
      { scan_only_repos: ["repo-a"] },
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
    { memory: fixtureMemoryClient(tasks), github: fakeGithub(), repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a"] },
  );
  assert.deepEqual(result, { status: "skip", content: "Already processing 5 test scans" });
});

test("a whitelist that matches no instance repo skips", async () => {
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
    { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a"] },
  );
  assert.deepEqual(github.calls.trees, [{ ownerRepo: "org/repo-a", branch: undefined }]);
  assert.deepEqual(result, {
    status: "start",
    content:
      "# Test Files for Anti-Pattern Analysis (2 files)\n\n" +
      `- **Task ID**: ${DAILY_KEY}\n\n` +
      "repo-a (2 files, playwright):\n" +
      "  src/a.spec.ts, src/deep/b.test.ts\n\n",
  });
});

test("a repo without framework indicators scans as generic", async () => {
  const github = fakeGithub({
    files: { "org/repo-a": ["jest.config.js", "src/a.test.ts"] },
  });
  const result = await run(
    { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
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
    { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
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
    { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
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
    { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
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

test("no matched test files skips with the scanned-repo count", async () => {
  const github = fakeGithub({
    files: { "org/repo-a": ["src/util.ts", "package.json"] },
  });
  const result = await run(
    { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
    { scan_only_repos: ["repo-a", "repo-b"] },
  );
  assert.deepEqual(result, {
    status: "skip",
    content: "Scanned 2 repos, no test files found",
  });
});

test("non-GitHub repos in the whitelist are never listed", async () => {
  const github = fakeGithub({ files: {} });
  const result = await run(
    { memory: fixtureMemoryClient([]), github, repos: { ...REPOS }, now: NOW },
    { scan_only_repos: ["repo-gl"] },
  );
  assert.deepEqual(github.calls.trees, []);
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
    { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
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
        { memory: fixtureMemoryClient([]), github, repos: REPOS, now: NOW },
        { scan_only_repos: ["repo-a", "repo-b"] },
      ),
    (error) => {
      assert.match(error.message, /GitHub route https:\/\/proxy.example\/github is not usable/);
      assert.match(error.message, /repo file list fetches attempted, 0 succeeded/);
      return true;
    },
  );
});
