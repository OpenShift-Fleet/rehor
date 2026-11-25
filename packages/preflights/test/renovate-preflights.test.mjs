import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig } from "../dist/index.js";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import { renovateDiscover } from "../dist/preflights/renovate-discover/index.js";
import { renovatePrStatus } from "../dist/preflights/renovate-pr-status/index.js";
import { createPreflightRunContext } from "../dist/shared/run-context.js";

/**
 * Fixture coverage for the Renovate workflow port. The Python workflow's
 * two scripts (01-renovate-discover.py and 02-gh-pr-status.py plus
 * lib/renovate_discover.py and lib/fix_pr_feedback.py) are exercised through
 * the registered preflights with an injectable memory/GitHub transport — no
 * network.
 */

const PROXY = "https://proxy.example/devbot-proxy";
const REPOS = { demo: { upstream: "https://github.com/org/demo" } };
const PREFIX = "renovate-fix:";

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const openPr = (number, overrides = {}) => ({
  number,
  title: `chore(deps): bump dependency ${number}`,
  url: `https://github.com/org/demo/pull/${number}`,
  headRefName: `renovate/dep-${number}`,
  baseRefName: "main",
  isCrossRepository: false,
  maintainerCanModify: true,
  body: "",
  author: { login: "renovate[bot]" },
  labels: { nodes: [] },
  statusCheckRollup: { contexts: { nodes: [] } },
  ...overrides,
});

const prData = (overrides = {}) => ({
  state: "OPEN",
  mergeable: "MERGEABLE",
  reviewDecision: null,
  url: null,
  title: null,
  isDraft: false,
  headRepositoryOwner: { login: "org" },
  headRepository: { name: "demo" },
  reviews: [],
  statusCheckRollup: [],
  ...overrides,
});

const check = (name, conclusion = "FAILURE") => ({ name, conclusion });
const comment = (body, t = "2026-07-03T10:00:00Z", a = "human") => ({ a, t, b: body });

const task = (number, status, extra = {}) => ({
  external_key: `${PREFIX}demo#${number}`,
  status,
  repo: "demo",
  metadata: { prs: [{ repo: "demo", number, host: "github" }] },
  ...extra,
});

/**
 * One run context with fixture-backed memory and GitHub. `listings` maps
 * `owner/repo` to open-PR search nodes; `details` maps PR number to detail
 * data (or a numeric HTTP status to fail); `comments` maps PR number to
 * comment records. Numeric listing values are HTTP failures.
 */
function makeContext({
  tasks = [],
  repos = REPOS,
  listings = { "org/demo": [] },
  details = {},
  comments = {},
  memoryStatus = 200,
} = {}) {
  const calls = { graphql: 0, listings: [], details: [], comments: [] };
  const ctx = createPreflightRunContext({
    instanceId: "renovate-bot",
    repos,
    memory: {
      baseUrl: "http://memory:8080",
      fetch: async () => json({ items: tasks }, memoryStatus),
    },
    proxy: {
      baseUrl: PROXY,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/graphql")) {
          calls.graphql += 1;
          const body = JSON.parse(init.body);
          if (body.variables.search !== undefined) {
            const repo = /^repo:"([^"]+)"/.exec(body.variables.search)?.[1];
            calls.listings.push(repo);
            const nodes = listings[repo] ?? [];
            if (typeof nodes === "number") return new Response(null, { status: nodes });
            return json({
              data: { search: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
            });
          }
          const number = body.variables.number;
          calls.details.push(number);
          const data = details[number];
          if (typeof data === "number") return new Response(null, { status: data });
          if (data === null) {
            return json({ data: { repository: { pullRequest: null } } });
          }
          const value = data ?? prData();
          return json({
            data: {
              repository: {
                pullRequest: {
                  ...value,
                  reviews: { nodes: value.reviews ?? [] },
                  statusCheckRollup: {
                    contexts: { nodes: value.statusCheckRollup ?? [] },
                  },
                },
              },
            },
          });
        }
        if (path.includes("/pulls/") && path.endsWith("/comments")) {
          const number = Number(path.split("/pulls/")[1].split("/")[0]);
          calls.comments.push(number);
          return json(
            (comments[number] ?? []).map((c) => ({
              user: { login: c.a },
              created_at: c.t,
              body: c.b,
            })),
          );
        }
        // The issue-comments endpoint answers empty; the pull-comments
        // endpoint already supplied the fixture records.
        if (path.includes("/issues/") && path.endsWith("/comments")) {
          return json([]);
        }
        return json([]);
      },
    },
  });
  return { ctx, calls };
}

async function runDiscover(contextOptions = {}, params = {}) {
  const { ctx, calls } = makeContext(contextOptions);
  const result = await renovateDiscover.run(ctx, renovateDiscover.input.parse(params));
  return { ...result, calls, state: ctx.state };
}

async function runStatus(contextOptions = {}, params = {}) {
  const { ctx, calls } = makeContext(contextOptions);
  const result = await renovatePrStatus.run(ctx, renovatePrStatus.input.parse(params));
  return { ...result, calls, state: ctx.state };
}

// --- registry / configuration ---

test("both Renovate preflights are registered with shorthand-safe defaults", () => {
  const registry = createPopulatedRegistry();
  for (const id of ["renovate-discover", "renovate-pr-status"]) {
    assert.ok(registry.has(id), `${id} is registered`);
  }
  const config = validateConfig(["renovate-discover", "renovate-pr-status"], registry);
  assert.equal(config.ok, true);
  assert.deepEqual(config.entries, [
    {
      id: "renovate-discover",
      params: {
        task_key_prefix: PREFIX,
        bot_logins: ["renovate[bot]", "renovate", "app/renovate"],
        max_active: 10,
      },
    },
    { id: "renovate-pr-status", params: { task_key_prefix: PREFIX } },
  ]);
});

test("unknown Renovate parameters fail closed", () => {
  const registry = createPopulatedRegistry();
  const result = validateConfig(
    [{ id: "renovate-discover", with: { repo_key: ["demo"] } }],
    registry,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.invalid, [
    {
      id: "renovate-discover",
      messages: ['renovate-discover: unknown parameter "repo_key"'],
    },
  ]);
});

// --- discovery ---

test("discovery starts on a failing non-draft Renovate PR and records head metadata", async () => {
  const result = await runDiscover({
    listings: { "org/demo": [openPr(7)] },
    details: { 7: prData({ statusCheckRollup: [check("lint"), check("test")] }) },
  });
  assert.equal(result.status, "start");
  assert.match(result.content, /## Renovate Discovery \(1 failing PRs\)/);
  assert.match(result.content, /### AUTO-FIX \(1\)/);
  assert.match(result.content, /PR org\/demo#7 \[ci_fail:lint,test\] new/);
  assert.match(result.content, /head_owner: org/);
  assert.match(result.content, /head_repo: demo/);
  assert.match(result.content, /task_key: renovate-fix:demo#7/);
  assert.match(result.content, /is_cross_repository: false/);
});

test("discovery skips drafts, clean PRs, non-Renovate authors, and conflicted PRs", async () => {
  const result = await runDiscover({
    listings: {
      "org/demo": [
        openPr(1),
        openPr(2),
        openPr(3, { author: { login: "alice" } }),
        openPr(4),
        openPr(5),
        openPr(6),
      ],
    },
    details: {
      1: prData({ isDraft: true, statusCheckRollup: [check("lint")] }),
      2: prData(),
      4: prData({ mergeable: "CONFLICTING" }),
      5: prData({ mergeable: "CONFLICTING", statusCheckRollup: [check("lint")] }),
      6: prData({ statusCheckRollup: [check("build")] }),
    },
  });
  assert.equal(result.status, "start");
  assert.match(result.content, /\(1 failing PRs\)/);
  assert.match(result.content, /PR org\/demo#6/);
  assert.doesNotMatch(result.content, /PR org\/demo#1/);
  assert.deepEqual(
    result.calls.details.sort((a, b) => a - b),
    [1, 2, 4, 5, 6],
  );
});

test("tracked active and blocked-paused tasks stay out of AUTO-FIX", async () => {
  const result = await runDiscover({
    tasks: [
      task(7, "pr_open"),
      task(8, "paused", { paused_reason: "blocked: peer conflict" }),
      task(9, "paused", { paused_reason: "Paused via dashboard" }),
    ],
    listings: { "org/demo": [openPr(7), openPr(8), openPr(9)] },
    details: {
      7: prData({ statusCheckRollup: [check("lint")] }),
      8: prData({ statusCheckRollup: [check("lint")] }),
      9: prData({ statusCheckRollup: [check("lint")] }),
    },
  });
  assert.equal(result.status, "skip");
  assert.match(result.content, /3 failing PR\(s\) already tracked/);
});

test("paused transient failures and done tasks re-enter AUTO-FIX with resume status", async () => {
  const result = await runDiscover({
    tasks: [
      task(7, "paused", { paused_reason: "transient: npm registry timeout" }),
      task(8, "done"),
    ],
    listings: { "org/demo": [openPr(7), openPr(8)] },
    details: {
      7: prData({ statusCheckRollup: [check("lint")] }),
      8: prData({ statusCheckRollup: [check("lint")] }),
    },
  });
  assert.equal(result.status, "start");
  assert.match(
    result.content,
    /PR org\/demo#7 \[ci_fail:lint\] resume:paused \(transient: npm registry timeout\)/,
  );
  assert.match(result.content, /PR org\/demo#8 \[ci_fail:lint\] resume:done/);
});

test("new work is withheld at capacity but paused retries proceed", async () => {
  const full = Array.from({ length: 10 }, (_, i) => task(100 + i, "pr_open"));
  const blocked = await runDiscover({
    tasks: full,
    listings: { "org/demo": [openPr(7)] },
    details: { 7: prData({ statusCheckRollup: [check("lint")] }) },
  });
  assert.equal(blocked.status, "skip");
  assert.match(blocked.content, /at capacity \(10\/10\)/);

  const withRetry = await runDiscover({
    tasks: [...full, task(8, "paused", { paused_reason: "transient: registry" })],
    listings: { "org/demo": [openPr(7), openPr(8)] },
    details: {
      7: prData({ statusCheckRollup: [check("lint")] }),
      8: prData({ statusCheckRollup: [check("lint")] }),
    },
  });
  assert.equal(withRetry.status, "start");
  assert.match(withRetry.content, /#8 .*resume:paused/);
});

test("no repos and no failing PRs skip without a session", async () => {
  const noRepos = await runDiscover({ repos: {} });
  assert.equal(noRepos.status, "skip");
  assert.match(noRepos.content, /no repos in project-repos.json/);

  const noWork = await runDiscover({ listings: { "org/demo": [] } });
  assert.equal(noWork.status, "skip");
  assert.match(noWork.content, /no failing Renovate PRs/);
});

test("task API outages skip, authorization failures error, and listing outages error", async () => {
  const unavailable = await runDiscover({ memoryStatus: 503 });
  assert.equal(unavailable.status, "skip");
  assert.match(unavailable.content, /task API unavailable/);

  const rejected = await runDiscover({ memoryStatus: 403 });
  assert.equal(rejected.status, "error");

  const listingOutage = await runDiscover({ listings: { "org/demo": 503 } });
  assert.equal(listingOutage.status, "error");
  assert.ok(listingOutage.content.includes(`${PROXY}/github`));
});

// --- status ---

test("status always retries addressed CI failures", async () => {
  const result = await runStatus({
    tasks: [task(7, "pr_open", { last_addressed: "2026-07-01T10:00:00Z" })],
    details: { 7: prData({ statusCheckRollup: [check("lint")] }) },
  });
  assert.equal(result.status, "start");
  assert.match(result.content, /### CI FAILING \(1\)/);
});

test("Renovate-only conflicts are suppressed until a fix PR exists", async () => {
  const suppressed = await runStatus({
    tasks: [task(7, "pr_open")],
    details: { 7: prData({ mergeable: "CONFLICTING" }) },
  });
  assert.equal(suppressed.status, "skip");
  assert.match(suppressed.content, /no GH PRs to check/);

  const withFixPr = await runStatus({
    tasks: [
      task(7, "pr_open", {
        metadata: {
          prs: [{ repo: "demo", number: 7, host: "github" }],
          fix_pr: { url: "https://github.com/org/demo/pull/99" },
        },
      }),
    ],
    details: {
      7: prData({ mergeable: "CONFLICTING" }),
      99: prData({ mergeable: "CONFLICTING" }),
    },
  });
  assert.equal(withFixPr.status, "start");
  assert.match(withFixPr.content, /### CONFLICTS \(1\)/);
  assert.match(withFixPr.content, /PR org\/demo#99 \(github\) state=OPEN \[conflict\]/);
});

test("a Renovate-only conflict with new human feedback stays P1", async () => {
  const result = await runStatus({
    tasks: [task(7, "pr_open", { last_addressed: "2026-07-01T10:00:00Z" })],
    details: { 7: prData({ mergeable: "CONFLICTING" }) },
    comments: { 7: [comment("please rebase and fix this")] },
  });
  assert.equal(result.status, "start");
  assert.match(result.content, /### FEEDBACK \(1\)/);
  assert.doesNotMatch(result.content, /### CONFLICTS/);
});

test("fix-PR handoff ignores Renovate CI and surfaces fix-PR CI and comments only", async () => {
  const baseTask = {
    metadata: {
      prs: [{ repo: "demo", number: 7, host: "github" }],
      fix_pr: { url: "https://github.com/org/demo/pull/99" },
    },
  };
  const fixed = await runStatus({
    tasks: [task(7, "pr_open", { ...baseTask, last_addressed: "2026-07-04T00:00:00Z" })],
    details: {
      7: prData({ statusCheckRollup: [check("renovate-ci")] }),
      99: prData(),
    },
    comments: {
      7: [comment("Renovate comment")],
      99: [comment("Fix PR comment")],
    },
  });
  assert.equal(fixed.status, "skip");
  assert.doesNotMatch(fixed.content, /renovate-ci/);
  assert.doesNotMatch(fixed.content, /Fix PR comment/);

  const failing = await runStatus({
    tasks: [task(7, "pr_open", { ...baseTask, last_addressed: "2026-07-01T10:00:00Z" })],
    details: {
      7: prData({ statusCheckRollup: [check("renovate-ci")] }),
      99: prData({ statusCheckRollup: [check("fix-lint")] }),
    },
    comments: {
      7: [comment("Renovate comment")],
      99: [comment("Fix PR comment")],
    },
  });
  assert.equal(failing.status, "start");
  assert.match(failing.content, /### CI FAILING \(1\)/);
  assert.match(failing.content, /PR org\/demo#99 \(github\) state=OPEN \[ci_fail:fix-lint\]/);
  assert.match(failing.content, /\[fix PR #99\] Fix PR comment/);
  assert.doesNotMatch(failing.content, /Renovate comment/);
});

test("an unreachable fix PR forces another cycle instead of trusting green Renovate CI", async () => {
  const result = await runStatus({
    tasks: [
      task(7, "pr_open", {
        metadata: {
          prs: [{ repo: "demo", number: 7, host: "github" }],
          fix_pr: { url: "https://github.com/org/demo/pull/99" },
        },
      }),
    ],
    details: {
      7: prData(),
      99: 500,
    },
  });
  assert.equal(result.status, "start");
  assert.match(result.content, /### CI FAILING \(1\)/);
});

test("Renovate MERGED wins for lifecycle even after fix-PR handoff", async () => {
  const result = await runStatus({
    tasks: [
      task(7, "pr_open", {
        metadata: {
          prs: [{ repo: "demo", number: 7, host: "github" }],
          fix_pr: { url: "https://github.com/org/demo/pull/99" },
        },
      }),
    ],
    details: {
      7: prData({ state: "MERGED" }),
      99: prData({ state: "OPEN" }),
    },
  });
  assert.equal(result.status, "start");
  assert.match(result.content, /### MERGED \(1\)/);
  assert.match(result.content, /state=MERGED/);
});

test("paused tasks with new feedback are promoted; quiet and terminal pauses are not", async () => {
  const promoted = await runStatus({
    tasks: [
      task(7, "paused", {
        paused_reason: "blocked: human decision",
        last_addressed: "2026-07-01T10:00:00Z",
      }),
    ],
    details: { 7: prData() },
    comments: { 7: [comment("The blocker is resolved, please retry")] },
  });
  assert.equal(promoted.status, "start");
  assert.match(promoted.content, /### BLOCKED FEEDBACK \(1\)/);
  assert.match(promoted.content, /renovate-fix:demo#7 \[paused\]/);

  const quiet = await runStatus({
    tasks: [
      task(8, "paused", {
        paused_reason: "blocked: waiting",
        last_addressed: "2026-07-01T10:00:00Z",
      }),
    ],
    details: { 8: prData() },
    comments: { 8: [comment("old note", "2026-06-01T10:00:00Z")] },
  });
  assert.equal(quiet.status, "skip");

  const terminal = await runStatus({
    tasks: [
      task(9, "paused", {
        paused_reason: "blocked: waiting",
        last_addressed: "2026-07-01T10:00:00Z",
      }),
    ],
    details: { 9: prData({ state: "MERGED" }) },
    comments: { 9: [comment("new note")] },
  });
  assert.equal(terminal.status, "skip");
});

test("a quiet cycle produces no start from either preflight and shares the task fetch", async () => {
  const { ctx } = makeContext({ tasks: [] });
  const discovered = await renovateDiscover.run(ctx, renovateDiscover.input.parse({}));
  const status = await renovatePrStatus.run(ctx, renovatePrStatus.input.parse({}));
  assert.equal(discovered.status, "skip");
  assert.equal(status.status, "skip");
  assert.notEqual(discovered.status, "start");
  assert.notEqual(status.status, "start");
  assert.deepEqual(ctx.state.get("tasks"), []);
});
