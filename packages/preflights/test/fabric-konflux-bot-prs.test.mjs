import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTier,
  fabricKonfluxBotPrs,
} from "../dist/preflights/fabric-konflux-bot-prs/index.js";
import { createPreflightRunContext } from "../dist/shared/run-context.js";

const PROXY = "https://proxy.example/devbot-proxy";
const BOT = "red-hat-konflux[bot]";
const REPOS = {
  demo: { upstream: "https://github.com/org/repo", url: "https://github.com/bot/repo.git" },
};
const TWO_REPOS = { ...REPOS, other: { upstream: "https://github.com/org/other" } };
const pr = (number, overrides = {}) => ({
  number,
  title: "Update dependency to v2.0.0",
  headRefName: `renovate/dep-${number}`,
  baseRefName: "main",
  author: { login: BOT },
  ...overrides,
});
const patch = (file, removed, added) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    `-${removed}`,
    `+${added}`,
  ].join("\n");
const GO_MAJOR = patch("go.mod", " github.com/org/dep v1.0.0", " github.com/org/dep v2.0.0");
const goReplace = (path) =>
  patch(
    "go.mod",
    "replace example.org/mod => example.org/mod v1.0.0",
    `replace ${path} => ${path} v2.0.0`,
  );
const replaceWithMajorPath = goReplace("example.org/mod/v2");
const replaceWithSamePath = goReplace("example.org/mod");

// Each repo can override a fetch phase with an HTTP status or fixture data.
async function run(configs = {}, { tasks = [], repos = REPOS, params = {} } = {}) {
  const requests = [];
  const searches = [];
  const ctx = createPreflightRunContext({
    instanceId: "bot-1",
    repos,
    memory: {
      baseUrl: "http://memory:8080",
      fetch: async () => Response.json({ items: tasks }),
    },
    proxy: {
      baseUrl: PROXY,
      fetch: async (url, init) => {
        if (url.endsWith("/graphql")) {
          const { search } = JSON.parse(init.body).variables;
          searches.push(search);
          const repo = /^repo:"([^"]+)"/.exec(search)?.[1];
          const kind = search.includes("chore(deps): consolidate") ? "consolidation" : "botPrs";
          requests.push(`${repo}:${kind}`);
          const nodes = configs[repo]?.[kind] ?? [];
          if (typeof nodes === "number") return Response.json({}, { status: nodes });
          return Response.json({ data: { search: { nodes, pageInfo: { hasNextPage: false } } } });
        }
        const match = /\/repos\/([^/]+\/[^/]+)(?:\/pulls\/(\d+))?$/.exec(url);
        assert.ok(match, `unexpected url ${url}`);
        const [, repo, number] = match;
        requests.push(`${repo}:${number ? `diff#${number}` : "defaultBranch"}`);
        const data = number
          ? configs[repo]?.diffs?.[number]
          : (configs[repo]?.defaultBranch ?? "main");
        if (typeof data === "number") return Response.json({}, { status: data });
        return number ? new Response(data ?? GO_MAJOR) : Response.json({ default_branch: data });
      },
    },
  });
  const result = await fabricKonfluxBotPrs.run(ctx, fabricKonfluxBotPrs.input.parse(params));
  return { ...result, requests, searches };
}

const payloadOf = (result) => JSON.parse(result.content.split("\n")[0]);
const numbersOf = (result) =>
  payloadOf(result).repos.flatMap(({ prs }) => prs.map(({ number }) => number));

test("emits the legacy per-repo task payload with a separate group for each major PR", async () => {
  const result = await run({ "org/repo": { botPrs: [pr(5), pr(6)] } });
  assert.equal(result.status, "start");
  assert.ok(result.searches.includes(`repo:"org/repo" is:pr is:open author:"${BOT}"`));
  assert.deepEqual(payloadOf(result), {
    bot_author: BOT,
    repos: [
      {
        repo: "org/repo",
        bot_url: "https://github.com/bot/repo.git",
        pr_count: 2,
        prs: [5, 6].map((number) => ({
          number,
          title: "Update dependency to v2.0.0",
          branch: `renovate/dep-${number}`,
        })),
        groups: Array.from({ length: 2 }, () => ({ ecosystem: "go", tier: "major", pr_count: 1 })),
        task_key: "konflux-pr-squash:org/repo",
      },
    ],
  });
});

test("classifies breaking signals, version precedence, and ambiguous targets", () => {
  for (const [title, body, diff, expected] of [
    ["feat!: rewrite API", "", null, "major"],
    ["Update module example.org/mod /v1 to v2", "", null, "major"],
    ["Update dependency from 1.0.0 to 2.0.0", "", ["1.0.0", "1.1.0"], "minor"],
    ["Update dependency from 0.1.0 to 0.2.0", "", null, "major"],
    ["Update dependency", "<code>1.0.0</code> -&gt; <code>2.0.0</code>", null, "major"],
    ["Update dependency", "", ["6.0.12.20260901", "6.0.12.20260906"], "patch"],
    ["Update dependency to v0.9.0", "", null, "major_unconfirmed"],
    ["Update dependency to v3.0.0", "", null, "unknown"],
  ]) {
    assert.equal(classifyTier(title, body, diff), expected, JSON.stringify({ title, body, diff }));
  }
});

test("shared capacity includes other workflows and stops scanning", async () => {
  const tasks = Array.from({ length: 10 }, (_, i) => ({
    external_key: `RHCLOUD-${i}`,
    status: "in_progress",
  }));
  const result = await run({ "org/repo": { botPrs: [pr(5)] } }, { tasks });
  assert.equal(result.status, "skip");
  assert.deepEqual(result.requests, []);
});

test("a legacy active consolidation task prefix prevents scanning its repo", async () => {
  for (const external_key of ["konflux-pr-squash:org/repo", "konflux-pr-squash:org/repo-2"]) {
    const result = await run(
      { "org/repo": { botPrs: [pr(5)] } },
      { tasks: [{ external_key, status: "in_progress" }] },
    );
    assert.equal(result.status, "skip", external_key);
    assert.deepEqual(result.requests, [], external_key);
  }
});

test("an open consolidation PR blocks work even when no task exists", async () => {
  const result = await run({
    "org/repo": {
      consolidation: [pr(9, { title: "chore(deps): consolidate updates" })],
      botPrs: [pr(5)],
    },
  });
  assert.equal(result.status, "skip");
  assert.deepEqual(result.requests, ["org/repo:consolidation"]);
});

test("a healthy scan without bot PRs skips", async () => {
  const result = await run();
  assert.equal(result.status, "skip");
  assert.deepEqual(result.requests, ["org/repo:consolidation", "org/repo:botPrs"]);
});

const withCheck = (check) => ({ statusCheckRollup: { contexts: { nodes: [check] } } });
test("filters non-default targets, opt-outs, abandoned PRs, and failed Konflux checks", async () => {
  const result = await run({
    "org/repo": {
      defaultBranch: "trunk",
      botPrs: [
        pr(1),
        pr(2, { baseRefName: "trunk", labels: { nodes: [{ name: "please do-not-merge" }] } }),
        pr(3, { baseRefName: "trunk", title: "Update dependency (abandoned)" }),
        pr(4, {
          baseRefName: "trunk",
          ...withCheck({
            __typename: "CheckRun",
            name: "repo-on-pull-request",
            conclusion: "FAILURE",
          }),
        }),
        pr(5, {
          baseRefName: "trunk",
          ...withCheck({
            __typename: "StatusContext",
            context: "repo-on-pull-request",
            state: "ERROR",
          }),
        }),
        pr(6, {
          baseRefName: "trunk",
          ...withCheck({ __typename: "CheckRun", name: "lint", conclusion: "FAILURE" }),
        }),
      ],
    },
  });
  assert.equal(result.status, "start");
  assert.deepEqual(numbersOf(result), [6]);
});

test("requires a supported manifest and a confirmed major tier", async () => {
  const result = await run({
    "org/repo": {
      botPrs: [
        pr(1, { title: "feat!: dependency update" }),
        pr(2),
        pr(3),
        pr(4, { title: "Update dependency to v0.9.0" }),
        pr(5),
      ],
      diffs: {
        1: patch("README.md", "1.0.0", "2.0.0"),
        2: patch("package.json", '"dep": "1.0.0"', '"dep": "1.1.0"'),
        3: patch("go.mod", " example.org/dep v1.0.0", " example.org/dep v1.0.1"),
        4: patch("go.mod", "require (", "require ( // updated"),
      },
    },
  });
  assert.equal(result.status, "start");
  assert.deepEqual(numbersOf(result), [5]);
});

test("rejects Go self-replace directives moved to a major module path but allows same-path bumps", async () => {
  const result = await run({
    "org/repo": {
      botPrs: [pr(5), pr(6)],
      diffs: { 5: replaceWithMajorPath, 6: replaceWithSamePath },
    },
  });
  assert.equal(result.status, "start");
  assert.deepEqual(numbersOf(result), [6]);
  assert.equal(payloadOf(result).repos[0].groups[0].ecosystem, "go");
});

for (const [phase, failure] of [
  ["consolidation", { consolidation: 503 }],
  ["bot listing", { botPrs: 503 }],
  ["default branch", { defaultBranch: 503 }],
]) {
  test(`a partial ${phase} outage skips only the unverifiable repo`, async () => {
    const result = await run(
      { "org/repo": { botPrs: [pr(5)], ...failure }, "org/other": { botPrs: [pr(6)] } },
      { repos: TWO_REPOS },
    );
    assert.equal(result.status, "start");
    assert.deepEqual(
      payloadOf(result).repos.map(({ repo }) => repo),
      ["org/other"],
    );
    assert.match(result.content, /org\/repo\b.*HTTP 503/);
    assert.ok(!result.requests.includes("org/repo:diff#5"));
  });
}

test("a partial diff outage allows title fallback without blocking a healthy PR", async () => {
  const result = await run({
    "org/repo": {
      botPrs: [
        pr(5, { title: "Update module example.org/dep from v1.0.0 to v2.0.0" }),
        pr(6),
        pr(7),
      ],
      diffs: { 5: 503, 6: 503 },
    },
  });
  assert.equal(result.status, "start");
  assert.deepEqual(numbersOf(result), [5, 7]);
  assert.match(result.content, /org\/repo#5\b.*HTTP 503/);
});

for (const [phase, failure] of [
  ["consolidation", { consolidation: 503 }],
  ["bot listing", { botPrs: 503 }],
  ["default branch", { defaultBranch: 503 }],
  ["diff", { diffs: { 5: 503 } }],
]) {
  test(`a total ${phase} outage errors and identifies the required route`, async () => {
    const result = await run({
      "org/repo": { botPrs: [pr(5, { title: "feat!: dependency update" })], ...failure },
    });
    assert.equal(result.status, "error");
    assert.ok(result.content.includes(`${PROXY}/github`));
    assert.match(result.content, /org\/repo\b.*HTTP 503/);
  });
}
