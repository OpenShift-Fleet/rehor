import assert from "node:assert/strict";
import test from "node:test";
import {
  HCC_MERGED_PR_VIOLATIONS_INPUT,
  runHccMergedPrViolations,
} from "../dist/preflights/hcc-merged-pr-violations/index.js";
import { PreflightHttpError } from "../dist/shared/http.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";

const A = "org/repo-a";
const B = "org/repo-b";
const NOW = "2026-07-21T12:00:00Z";
const REPOS = {
  "repo-a": { upstream: `https://github.com/${A}` },
  "repo-b": { upstream: `https://github.com/${B}` },
  "repo-gl": { upstream: "https://gitlab.com/org/repo-gl" },
};
const key = (number) => `merge-violation:repo-a:${number}`;
const tracked = (number, status, source_type = "jira") => ({
  external_key: key(number),
  status,
  source_type,
});
const merged = (number, mergedAt = "2026-07-21T10:00:00Z") => ({
  number,
  mergedAt,
  title: `PR ${number}`,
  author: "alice",
  url: `https://github.com/${A}/pull/${number}`,
});
const detail = (...checks) => ({
  state: "MERGED",
  statusCheckRollup: checks.map(([name, conclusion = "FAILURE"]) => ({ name, conclusion })),
});
const LINT = detail(["lint"]);
const ROUTE = "https://proxy.example/github";
const unavailable = new PreflightHttpError({
  status: 503,
  method: "GET",
  url: `${ROUTE}/repos/${A}/pulls`,
  route: ROUTE,
  message: "HTTP 503",
});

function run({
  tasks = [],
  now = NOW,
  params = { scan_only_repos: ["repo-a"] },
  lookupFailure,
  lists = { [A]: [merged(10)] },
  prs = { [`${A}#10`]: LINT },
  calls = [],
} = {}) {
  const memory = createMemoryServerClient({
    baseUrl: "http://memory.test",
    fetch: async (url) => {
      calls.push("memory");
      if (lookupFailure && new URL(url).searchParams.has("offset")) return lookupFailure();
      return Response.json({ items: tasks });
    },
  });
  const github = {
    route: ROUTE,
    listMergedPrs: async (repo, _limit, since) => {
      calls.push(["list", repo, since]);
      if (lists[repo] instanceof Error) throw lists[repo];
      return lists[repo] ?? [];
    },
    getPr: async (repo, number) => {
      const ref = `${repo}#${number}`;
      calls.push(["pr", ref]);
      if (prs[ref] instanceof Error) throw prs[ref];
      return prs[ref] ?? null;
    },
  };
  return runHccMergedPrViolations(
    { memory, github, repos: REPOS, now: () => new Date(now) },
    HCC_MERGED_PR_VIOLATIONS_INPUT.parse(params),
  );
}

test("outside the quality window skips before upstream work", async () => {
  for (const now of ["2026-07-21T21:00:00Z", "2026-07-25T12:00:00Z", "2026-11-18T07:30:00Z"]) {
    const calls = [];
    assert.equal((await run({ now, calls })).status, "skip", now);
    assert.deepEqual(calls, [], now);
  }
});

test("global capacity and active violation limits independently stop scans", async () => {
  const scenarios = {
    capacity: Array.from({ length: 10 }, (_, i) => ({
      external_key: `other-${i}`,
      status: "in_progress",
    })),
    concurrency: Array.from({ length: 5 }, (_, i) => tracked(i + 100, "pr_open")),
  };
  for (const [name, tasks] of Object.entries(scenarios)) {
    const calls = [];
    assert.equal((await run({ tasks, calls })).status, "skip", name);
    assert.ok(!calls.some((call) => Array.isArray(call)), name);
  }
});

test("honors repo and lookback filters and emits only non-security failed checks", async () => {
  const calls = [];
  const result = await run({
    params: { scan_only_repos: ["repo-a", "repo-gl", "unknown"] },
    lists: {
      [A]: [merged(10), merged(11), merged(9, "2026-07-19T10:00:00Z"), merged(8, "bad-date")],
    },
    prs: {
      [`${A}#10`]: detail(["lint"], ["e2e", "SUCCESS"], ["sast-scan"]),
      [`${A}#11`]: detail(["Clair-Scan"], ["konflux-ci/trivy-security-scan"]),
    },
    calls,
  });
  assert.deepEqual(calls.filter(Array.isArray), [
    ["list", A, new Date("2026-07-20T12:00:00Z")],
    ["pr", `${A}#10`],
    ["pr", `${A}#11`],
  ]);
  assert.equal(result.status, "start");
  assert.match(result.content, /Task ID: merge-violation:repo-a:10/);
  assert.match(result.content, /failed: lint/);
  assert.doesNotMatch(result.content, /e2e|sast-scan|Clair-Scan|trivy-security-scan|repo-a #11/);
  for (const field of ["external_key", "source_type jira", "instance_id", "metadata.jira_key"]) {
    assert.ok(result.content.includes(field), field);
  }
});

test("per-finding gates include archived rows but distinguish different sources", async () => {
  const scenario = {
    lists: { [A]: [merged(10), merged(11)] },
    prs: { [`${A}#10`]: LINT, [`${A}#11`]: LINT },
  };
  for (const status of ["archived", "done", "in_progress"]) {
    const tasks = [tracked(10, status), tracked(11, "done", "github")];
    const result = await run({ ...scenario, tasks });
    assert.equal(result.status, "start", status);
    assert.match(result.content, /Task ID: merge-violation:repo-a:11/);
    assert.ok(!result.content.includes(key(10)), status);
    assert.equal(
      (await run({ ...scenario, tasks: [...tasks, tracked(11, "done")] })).status,
      "skip",
    );
  }
});

test("an auth failure or malformed finding lookup fails closed", async () => {
  await assert.rejects(run({ lookupFailure: () => Response.json({}, { status: 401 }) }), {
    name: "MemoryAuthRejectedError",
    status: 401,
  });
  await assert.rejects(
    run({ lookupFailure: () => Response.json({}) }),
    /merge-violation:repo-a:10/,
  );
});

test("partial GitHub failures are evidence; total listing or detail failure is an error", async () => {
  const partial = await run({
    params: {},
    lists: { [A]: [merged(10), merged(11)], [B]: unavailable },
    prs: { [`${A}#10`]: unavailable, [`${A}#11`]: LINT },
  });
  assert.equal(partial.status, "start");
  assert.match(partial.content, /Task ID: merge-violation:repo-a:11/);
  assert.match(partial.content, /UNFETCHABLE/);
  assert.match(partial.content, /org\/repo-a#10: HTTP 503/);
  assert.match(partial.content, /org\/repo-b: HTTP 503/);
  await assert.rejects(
    run({ params: {}, lists: { [A]: unavailable, [B]: unavailable } }),
    /0 succeeded/,
  );
  await assert.rejects(run({ prs: { [`${A}#10`]: unavailable } }), /0 succeeded/);
});
