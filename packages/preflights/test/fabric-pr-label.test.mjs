import assert from "node:assert/strict";
import test from "node:test";
import { fabricPrLabel } from "../dist/preflights/fabric-pr-label/index.js";
import { createPreflightRunContext } from "../dist/shared/run-context.js";

const PROXY = "https://proxy.example/devbot-proxy";
const REPOS = { demo: { upstream: "https://github.com/org/demo" } };

const pr = (number, overrides = {}) => ({
  number,
  title: "Add feature [RHCLOUD-7]",
  url: `https://github.com/org/demo/pull/${number}`,
  headRefName: "alice/feature",
  isCrossRepository: false,
  maintainerCanModify: false,
  author: { login: "alice" },
  ...overrides,
});

async function run({
  tasks = [],
  repos = REPOS,
  listings = {},
  params = {},
  memoryStatus = 200,
} = {}) {
  const searches = [];
  const ctx = createPreflightRunContext({
    instanceId: "bot-1",
    repos,
    memory: {
      baseUrl: "http://memory:8080",
      fetch: async () => Response.json({ items: tasks }, { status: memoryStatus }),
    },
    proxy: {
      baseUrl: PROXY,
      fetch: async (url, init) => {
        assert.ok(url.endsWith("/graphql"));
        const { search } = JSON.parse(init.body).variables;
        searches.push(search);
        const repo = /^repo:"([^"]+)"/.exec(search)?.[1];
        const nodes = listings[repo] ?? [];
        if (typeof nodes === "number") return Response.json({}, { status: nodes });
        return Response.json({ data: { search: { nodes, pageInfo: { hasNextPage: false } } } });
      },
    },
  });
  const result = await fabricPrLabel.run(ctx, fabricPrLabel.input.parse(params));
  return { ...result, searches, candidateCount: ctx.state.get("labeled_prs") };
}

const payloadOf = (result) => JSON.parse(result.content.split("\n\n")[0]);

test("uses the configured label and emits the legacy candidate payload and cycle count", async () => {
  const result = await run({
    listings: { "org/demo": [pr(7, { isCrossRepository: true })] },
    params: { pr_label: "fabric-access-review", gh_user_name: "" },
  });
  assert.equal(result.status, "start");
  assert.deepEqual(result.searches, ['repo:"org/demo" is:pr is:open label:"fabric-access-review"']);
  assert.deepEqual(payloadOf(result), {
    label: "fabric-access-review",
    prs: [
      {
        repo: "org/demo",
        number: 7,
        title: "Add feature [RHCLOUD-7]",
        url: "https://github.com/org/demo/pull/7",
        branch: "alice/feature",
        author: "alice",
        jira_key: "RHCLOUD-7",
        is_fork: true,
        can_push: false,
        task_key: "pr-label:org/demo#7",
      },
    ],
  });
  assert.equal(result.candidateCount, 1);
});

test("ten active label tasks stop scanning at capacity", async () => {
  const tasks = Array.from({ length: 10 }, (_, i) => ({
    external_key: `pr-label:org/demo#${i + 10}`,
    status: "pr_open",
  }));
  const result = await run({ tasks, listings: { "org/demo": [pr(7)] } });
  assert.equal(result.status, "skip");
  assert.deepEqual(result.searches, []);
});

test("a full queue from other workflows does not block labeled PRs", async () => {
  const tasks = Array.from({ length: 10 }, (_, i) => ({
    external_key: `RHCLOUD-${i}`,
    status: "in_progress",
  }));
  assert.equal((await run({ tasks, listings: { "org/demo": [pr(7)] } })).status, "start");
});

test("only scans GitHub repos and skips a healthy empty listing", async () => {
  const result = await run({
    repos: { ...REPOS, other: { upstream: "https://gitlab.com/org/other" } },
  });
  assert.equal(result.status, "skip");
  assert.deepEqual(result.searches, ['repo:"org/demo" is:pr is:open label:"dev-bot"']);
});

test("excludes tracked PRs by legacy external key, not by repo alone", async () => {
  const result = await run({
    tasks: [
      { external_key: "pr-label:org/demo#7", status: "pr_open" },
      { external_key: "konflux-pr-squash:org/demo", status: "pr_open" },
    ],
    listings: { "org/demo": [pr(7), pr(8, { title: "Add feature RHCLOUD-7" })] },
  });
  assert.equal(result.status, "start");
  const candidates = payloadOf(result).prs;
  assert.deepEqual(
    candidates.map(({ task_key }) => task_key),
    ["pr-label:org/demo#8"],
  );
  assert.equal(candidates[0].jira_key, null);
  assert.equal(candidates[0].can_push, true);
});

test("excludes other workflows' PRs by branch or author", async () => {
  const result = await run({
    params: { gh_user_name: "fleet-jira-bot" },
    listings: {
      "org/demo": [
        pr(1, { headRefName: "BOT/RHCLOUD-7" }),
        pr(2, { headRefName: "chore/consolidate-go" }),
        pr(3, { author: { login: "red-hat-konflux[bot]" } }),
        pr(4, { author: { login: "Fleet-Jira-Bot" } }),
        pr(7),
      ],
    },
  });
  assert.equal(result.status, "start");
  assert.deepEqual(
    payloadOf(result).prs.map(({ number }) => number),
    [7],
  );
});

test("a partial listing outage preserves healthy candidates and records failure evidence", async () => {
  const result = await run({
    repos: { gone: { upstream: "https://github.com/org/gone" }, ...REPOS },
    listings: { "org/gone": 503, "org/demo": [pr(7)] },
  });
  assert.equal(result.status, "start");
  assert.deepEqual(
    payloadOf(result).prs.map(({ repo }) => repo),
    ["org/demo"],
  );
  assert.match(result.content, /org\/gone\b.*HTTP 503/);
});

test("a total listing outage errors and identifies the required route", async () => {
  const result = await run({ listings: { "org/demo": 503 } });
  assert.equal(result.status, "error");
  assert.ok(result.content.includes(`${PROXY}/github`));
  assert.match(result.content, /org\/demo\b.*HTTP 503/);
});

test("a memory authorization failure stops before scanning GitHub", async () => {
  const result = await run({ memoryStatus: 403, listings: { "org/demo": [pr(7)] } });
  assert.equal(result.status, "error");
  assert.deepEqual(result.searches, []);
});
