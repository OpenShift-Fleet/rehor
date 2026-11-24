import assert from "node:assert/strict";
import test from "node:test";
import {
  HCC_TEST_ANTI_PATTERN_SCAN_INPUT,
  runHccTestAntiPatternScan,
} from "../dist/preflights/hcc-test-anti-pattern-scan/index.js";
import { PreflightHttpError } from "../dist/shared/http.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";

const A = "org/repo-a";
const B = "org/repo-b";
const C = "org/repo-c";
const REPOS = {
  "repo-a": { upstream: `https://github.com/${A}` },
  "repo-b": { upstream: `https://github.com/${B}` },
  "repo-c": { upstream: `https://github.com/${C}` },
  "repo-gl": { upstream: "https://gitlab.com/org/repo-gl" },
};
const NOW = "2026-07-21T12:00:00Z";
const KEY_A = "test-scan:repo-a:2026-07-21";
const KEY_B = "test-scan:repo-b:2026-07-21";
const ROUTE = "https://proxy.example/github";
const unavailable = new PreflightHttpError({
  status: 503,
  method: "GET",
  url: `${ROUTE}/repos/${A}/git/trees/main`,
  route: ROUTE,
  message: "HTTP 503",
});

function run({
  now = NOW,
  tasks = [],
  lookupStatus = 200,
  params = {},
  files = { [A]: ["a.spec.ts"], [B]: ["b.spec.ts"], [C]: ["c.spec.ts"] },
  calls = [],
} = {}) {
  const memory = createMemoryServerClient({
    baseUrl: "http://memory.test",
    fetch: async (url) => {
      calls.push("memory");
      const query = new URL(url).searchParams;
      if (lookupStatus !== 200 && query.has("offset"))
        return Response.json({}, { status: lookupStatus });
      return Response.json({
        items: tasks.filter((task) => task.status !== query.get("exclude_status")),
      });
    },
  });
  const github = {
    route: ROUTE,
    listRepoFiles: async (repo) => {
      calls.push(repo);
      if (files[repo] instanceof Error) throw files[repo];
      return files[repo] ?? [];
    },
  };
  return runHccTestAntiPatternScan(
    { memory, github, repos: REPOS, now: () => new Date(now) },
    HCC_TEST_ANTI_PATTERN_SCAN_INPUT.parse({ scan_only_repos: ["repo-a"], ...params }),
  );
}

const trees = (calls) => calls.filter((call) => call !== "memory");

test("quality scan observes the Prague window before fetching", async () => {
  for (const now of ["2026-01-05T07:00:00Z", "2026-07-20T21:00:00Z", "2026-07-25T12:00:00Z"]) {
    const calls = [];
    assert.equal((await run({ now, calls })).status, "skip", now);
    assert.deepEqual(calls, [], now);
  }
  assert.equal((await run({ now: "2026-07-20T07:00:00Z" })).status, "start");
});

test("capacity and active scan limits stop work; completed scans do not count", async () => {
  const activeScans = Array.from({ length: 5 }, (_, i) => ({
    external_key: `test-scan:other-${i}:2026-07-21`,
    status: "in_progress",
  }));
  const atCapacity = Array.from({ length: 10 }, (_, i) => ({
    external_key: `other-${i}`,
    status: "in_progress",
  }));
  for (const tasks of [activeScans, atCapacity]) {
    const calls = [];
    assert.equal((await run({ tasks, calls })).status, "skip");
    assert.deepEqual(trees(calls), []);
  }
  const completed = activeScans.map((task) => ({ ...task, status: "done" }));
  assert.equal((await run({ tasks: completed })).status, "start");
});

test("per-repo gates include archived rows without consuming scan slots", async () => {
  const calls = [];
  const params = { scan_only_repos: ["repo-a", "repo-b", "repo-c"], max_repos_per_scan: 1 };
  const tasks = [{ external_key: KEY_A, status: "archived" }];
  const result = await run({ tasks, params, calls });
  assert.equal(result.status, "start");
  assert.deepEqual(trees(calls), [B]);
  assert.match(result.content, /Task ID: test-scan:repo-b:2026-07-21/);
  assert.ok(!result.content.includes(KEY_A));

  const allTracked = [...tasks, { external_key: KEY_B, status: "done" }];
  calls.length = 0;
  assert.equal(
    (await run({ tasks: allTracked, params: { scan_only_repos: ["repo-a", "repo-b"] }, calls }))
      .status,
    "skip",
  );
  assert.deepEqual(trees(calls), []);
});

test("a tracking lookup failure never falls through to a scan", async () => {
  for (const [status, name] of [
    [401, "MemoryAuthRejectedError"],
    [500, "PreflightHttpError"],
  ]) {
    const calls = [];
    await assert.rejects(run({ lookupStatus: status, calls }), { name, status });
    assert.deepEqual(trees(calls), []);
  }
});

test("scan honors repo and file filters, detects framework, and caps results", async () => {
  const calls = [];
  const result = await run({
    calls,
    params: {
      scan_only_repos: ["repo-a", "repo-gl", "unknown"],
      patterns: ["**/*.spec.ts"],
      exclude_substrings: ["generated/"],
      max_files_per_repo: 1,
    },
    files: {
      [A]: [
        "playwright.config.ts",
        "generated/b.spec.ts",
        "src/a.test.ts",
        "src/deep/a.spec.ts",
        "z.spec.ts",
      ],
    },
  });
  assert.deepEqual(trees(calls), [A]);
  assert.equal(result.status, "start");
  assert.match(result.content, /playwright/);
  assert.match(result.content, /src\/deep\/a\.spec\.ts/);
  assert.doesNotMatch(result.content, /generated\/b\.spec\.ts|a\.test\.ts|z\.spec\.ts/);
  assert.ok(result.content.includes(`Task ID: ${KEY_A}`));
  for (const field of [
    "source_type jira",
    "status in_progress",
    "metadata.jira_key",
    "status done",
  ]) {
    assert.ok(result.content.includes(field), field);
  }
});

test("default matching excludes generated dependencies; no test files means no start", async () => {
  const calls = [];
  const result = await run({
    files: { [A]: ["src/util.ts", "node_modules/a.spec.ts", "dist/b.test.ts"] },
    calls,
  });
  assert.deepEqual(trees(calls), [A]);
  assert.equal(result.status, "skip");
});

test("partial tree failure is evidence; total failure is an error", async () => {
  const params = { scan_only_repos: ["repo-a", "repo-b"] };
  const result = await run({ params, files: { [A]: unavailable, [B]: ["b.test.ts"] } });
  assert.equal(result.status, "start");
  assert.ok(result.content.includes(KEY_B));
  assert.match(result.content, /generic/);
  assert.match(result.content, /org\/repo-a: HTTP 503/);
  await assert.rejects(
    run({ params, files: { [A]: unavailable, [B]: unavailable } }),
    /0 succeeded/,
  );
});
