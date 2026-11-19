import assert from "node:assert/strict";
import test from "node:test";
import { createPreflightRunContext } from "../dist/index.js";
import { createPopulatedRegistry } from "../dist/preflights/index.js";

/**
 * Package-level integration test for the quality workflow's feedback loop:
 * the actual registered preflights (`hcc-merged-pr-violations`, the scan
 * that discovers merge violations, and `hcc-quality-jira-feedback`, the
 * feedback channel for their tracked tasks) run for one profile on ONE
 * real shared run context (`createPreflightRunContext`), against
 * injectable fake fetches for memory, Jira, and GitHub.
 *
 * Limitation (deliberate): this does NOT exercise the dispatcher engine —
 * `runTsPreflight`'s bearer-injecting transport, per-entry timeouts, and
 * start/skip aggregation have their own coverage in
 * packages/agent-dispatcher/test. Here the per-entry outcomes of the
 * registered preflights are asserted directly.
 *
 * The registered `preflight.run(ctx, params)` path has no clock injection
 * and both preflights gate on Mon–Fri 09:00–23:00 Europe/Prague, so each
 * scenario pins globalThis.Date to a fixed in-window Monday and restores
 * it in a finally. Tests run sequentially (`concurrency: false`), the
 * fake fetches are synchronous, and the patch never overlaps another test.
 *
 * Upcoming change note: unattributed tasks (missing instance_id) matching
 * configured repos will become selectable. This test deliberately avoids
 * pinning the memory query inventory — it asserts decisions, prompts, and
 * per-run fetch deduplication, which survive that change. The existing
 * instance-scoped tests in hcc-quality-jira-feedback.test.mjs remain the
 * ones that pin the instance scoping itself.
 */

const SECRET = "quality-cycle-bearer-7d2f4c";
const FIXED_MS = Date.parse("2026-11-16T10:00:00.000Z"); // Monday 11:00 Europe/Prague
const PROFILE = ["hcc-merged-pr-violations", "hcc-quality-jira-feedback"];
const REPOS = { "my-repo": { upstream: "https://github.com/org/my-repo", host: "github" } };

// --- fixtures: one tracked in-progress finding, one done finding ---
const TRACKED = {
  external_key: "merge-violation:my-repo:123",
  status: "in_progress",
  repo: "my-repo",
  source_type: "jira",
  last_addressed: "2026-11-14T12:00:00",
  metadata: { jira_key: "RHCLOUD-999" },
};
const DONE = {
  external_key: "merge-violation:other-repo:77",
  status: "done",
  repo: "other-repo",
  source_type: "jira",
  metadata: { jira_key: "RHCLOUD-777" },
};
const BOT_OLD = {
  created: "2026-11-13T06:00:00",
  body: "### Cycle status\n| step | state |\n| --- | --- |",
  author: { displayName: "rehor-bot" },
};
const HUMAN_FRESH = {
  created: "2026-11-16T09:00:00",
  body: "Please re-check the flaky login test",
  author: { displayName: "Jana Nováková" },
};
const HUMAN_OLD = {
  created: "2026-11-13T08:00:00",
  body: "already addressed",
  author: { displayName: "Jana Nováková" },
};

/** Pin the wall clock for the duration of one async scenario. */
const RealDate = globalThis.Date;
async function withFixedClock(run) {
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [FIXED_MS] : args));
    }
    static now() {
      return FIXED_MS;
    }
  }
  globalThis.Date = FixedDate;
  try {
    return await run();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** Fake memory + Jira + GitHub on injectable fetches, with request recording. */
function fakeGateway(scenario) {
  const tasks = [TRACKED, DONE];
  const comments = scenario === "unchanged" ? [BOT_OLD, HUMAN_OLD] : [BOT_OLD, HUMAN_FRESH];
  const requests = [];
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const route = (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/tasks") {
      const params = parsed.searchParams;
      let bucket = tasks;
      if (params.get("status") !== null) {
        bucket = tasks.filter((task) => task.status === params.get("status"));
      } else if (params.has("exclude_status")) {
        bucket = tasks.filter((task) => task.status !== "archived");
      }
      const limit = Number(params.get("limit") ?? 20);
      const offset = Number(params.get("offset") ?? 0);
      return json({ items: bucket.slice(offset, offset + limit), total: bucket.length });
    }
    if (parsed.pathname === "/jira/rest/api/2/issue/RHCLOUD-999") {
      return json({
        key: "RHCLOUD-999",
        fields: {
          summary: "Flaky login test after merge",
          status: { name: "In Progress" },
          labels: [],
          issuelinks: [],
        },
      });
    }
    if (parsed.pathname === "/jira/rest/api/2/issue/RHCLOUD-999/comment") {
      return json({ comments, startAt: 0, total: comments.length });
    }
    if (parsed.pathname === "/github/graphql") {
      const variables = JSON.parse(String(init.body ?? "{}")).variables ?? {};
      if (typeof variables.search === "string") {
        // The merged-PR window search; its merged:>= bound is the pinned
        // clock feeding the default 24 h lookback.
        return json({
          data: {
            search: {
              nodes: [
                {
                  number: 123,
                  title: "Fix login flake",
                  url: "https://github.com/org/my-repo/pull/123",
                  mergedAt: "2026-11-16T08:30:00Z",
                  author: { login: "jana" },
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        });
      }
      // PR status: one failed non-security check plus one failed security
      // scan that must not count.
      return json({
        data: {
          repository: {
            pullRequest: {
              state: "MERGED",
              title: "Fix login flake",
              reviews: { nodes: [] },
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    { __typename: "CheckRun", name: "unit-tests", conclusion: "FAILURE" },
                    { __typename: "CheckRun", name: "trivy-image-scan", conclusion: "FAILURE" },
                  ],
                },
              },
            },
          },
        },
      });
    }
    return json({ error: "not found" }, 404);
  };

  // The proxy injects credentials upstream; simulate that here and record
  // every request so the no-leak assertions are non-vacuous.
  const gatewayFetch = async (url, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    headers.set("Authorization", `Bearer ${SECRET}`);
    requests.push({ url: String(url), body: String(init.body ?? "") });
    return route(url, { ...init, headers });
  };
  return { requests, gatewayFetch };
}

/** Run the profile's registered preflights on one shared run context. */
async function runProfile(scenario, entries = PROFILE) {
  const gateway = fakeGateway(scenario);
  return await withFixedClock(async () => {
    const ctx = createPreflightRunContext({
      instanceId: "quality",
      memory: { baseUrl: "http://memory.test/mcp", token: SECRET, fetch: gateway.gatewayFetch },
      jira: { baseUrl: "https://proxy.test", fetch: gateway.gatewayFetch },
      proxy: { baseUrl: "https://proxy.test", fetch: gateway.gatewayFetch },
      repos: REPOS,
    });
    const registry = createPopulatedRegistry();
    const scripts = [];
    for (const id of entries) {
      const preflight = registry.get(id);
      assert.ok(preflight, `registered preflight: ${id}`);
      scripts.push({ name: id, outcome: await preflight.run(ctx, preflight.input.parse({})) });
    }
    return { scripts, requests: gateway.requests, state: ctx.state };
  });
}

test("fresh Jira feedback on a tracked in-progress task starts while the scan skips the tracked finding", {
  concurrency: false,
}, async () => {
  const { scripts, requests } = await runProfile("fresh");
  const [scan, feedback] = scripts.map((entry) => entry.outcome);

  // The scan found the violation (failed non-security check on a PR merged
  // inside the lookback) but its exact task key is already tracked.
  assert.equal(scan.status, "skip");
  assert.match(scan.content, /All 1 violation\(s\) already tracked/);

  // The feedback channel starts on the same task's fresh human comment.
  assert.equal(feedback.status, "start");
  assert.match(feedback.content, /# Quality Task Jira Feedback \(1\)/);
  assert.match(feedback.content, /- Task ID: merge-violation:my-repo:123/);
  assert.match(feedback.content, /- Jira key: RHCLOUD-999/);
  assert.match(feedback.content, /jira_comments \(1, newest first\)/);
  assert.match(feedback.content, /Please re-check the flaky login test/);
  assert.doesNotMatch(feedback.content, /violation\(s\) already tracked/);
  assert.doesNotMatch(feedback.content, /Cycle status/); // the bot comment stays out

  // Only the tracked task's issue is fetched — never the done task's, and
  // never the external_key as a Jira key.
  const jiraPaths = requests
    .filter((request) => request.url.includes("/jira/"))
    .map((request) => new URL(request.url).pathname)
    .sort();
  assert.deepEqual(jiraPaths, [
    "/jira/rest/api/2/issue/RHCLOUD-999",
    "/jira/rest/api/2/issue/RHCLOUD-999/comment",
  ]);

  // Deterministic lookback: the window search bound is the pinned now
  // minus the default 24 h lookback.
  const search = requests.find((request) => request.body.includes("is:merged"));
  assert.ok(search.body.includes("merged:>=2026-11-15T10:00:00Z"));
});

test("unchanged Jira feedback plus the already-tracked finding skips both preflights", {
  concurrency: false,
}, async () => {
  const { scripts } = await runProfile("unchanged");
  const [scan, feedback] = scripts.map((entry) => entry.outcome);
  assert.equal(scan.status, "skip");
  assert.match(scan.content, /All 1 violation\(s\) already tracked/);
  assert.equal(feedback.status, "skip");
  assert.match(feedback.content, /No new human Jira feedback on 1 active quality task\(s\)/);
  assert.match(feedback.content, /clean: merge-violation:my-repo:123 → RHCLOUD-999/);
});

test("the per-cycle bearer flows through transport but never into preflight output; both entries share one context", {
  concurrency: false,
}, async () => {
  const { scripts, requests, state } = await runProfile("fresh", [
    "hcc-quality-jira-feedback",
    "hcc-quality-jira-feedback",
  ]);

  for (const script of scripts) {
    assert.equal(script.outcome.status, "start");
    assert.ok(!script.outcome.content.includes(SECRET));
  }
  assert.ok(requests.length > 0); // the secret was in transit — non-vacuous

  // Shared run context: whatever memory queries the first entry issued,
  // the second entry reused them (no URL fetched twice). Asserted on URL
  // identity, not the query inventory, so the upcoming unattributed-task
  // selection change does not break this.
  const memoryUrls = requests
    .filter((request) => request.url.includes("/api/tasks"))
    .map((request) => request.url);
  assert.ok(memoryUrls.some((url) => /[?&]status=in_progress/.test(url)));
  assert.equal(new Set(memoryUrls).size, memoryUrls.length);
  // Jira is fetched per entry by design (no cache): two issue fetches.
  assert.equal(requests.filter((request) => request.url.includes("/issue/RHCLOUD-999?")).length, 2);
  assert.equal(state.get("has_actionable"), true);
});
