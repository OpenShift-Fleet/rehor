import assert from "node:assert/strict";
import test from "node:test";
import { createPreflightRunContext } from "../dist/index.js";
import {
  OBSINT_MINTMAKER_INPUT,
  MINTMAKER_LAST_RUN_KEY,
  runObsintMintmakerPrs,
} from "../dist/preflights/obsint-mintmaker-prs/index.js";
import { parseCsvRecords } from "../dist/preflights/obsint-mintmaker-prs/csv.js";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import { fakeGithub, fakeMemory, fakePersistentState, obsintContext } from "./obsint-fixtures.mjs";

/**
 * Port of the watchduty `02-mintmaker-prs.py` coverage, adapted to the TS
 * module API: the cleanup-before-throttle ordering, the 8-hour CSV
 * throttle, CSV parsing and bot filtering, and the merged/closed cleanup —
 * through the exported run flow with plain-object client fakes, plus the
 * registered preflight's wiring-failure paths.
 */

const registry = createPopulatedRegistry();
const mintmaker = registry.get("obsint-mintmaker-prs");

const NOW = () => new Date("2026-11-04T10:00:00Z");
const HOUR_MS = 3_600_000;

const parseParams = (with_) => OBSINT_MINTMAKER_INPUT.parse(with_ ?? {});

const run = (deps, with_) =>
  runObsintMintmakerPrs(deps, parseParams(with_));

const CSV = [
  "repo,pr_id,title,url,date_created,ci_status,author",
  "repo-a,11,\"Fix deps, bump version\",https://github.com/RedHatInsights/repo-a/pull/11,2026-11-03T04:00:00Z,failed,app/red-hat-konflux",
  "repo-a,12,Add feature,https://github.com/RedHatInsights/repo-a/pull/12,2026-11-03T04:00:00Z,passed,app/dependabot",
  "repo-b,13,Human PR,https://github.com/RedHatInsights/repo-b/pull/13,2026-11-03T04:00:00Z,failed,human",
  "",
].join("\n");

// --- CSV parser ---

test("parseCsvRecords handles quoted commas and blank lines", () => {
  const records = parseCsvRecords(CSV);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], {
    repo: "repo-a",
    pr_id: "11",
    title: "Fix deps, bump version",
    url: "https://github.com/RedHatInsights/repo-a/pull/11",
    date_created: "2026-11-03T04:00:00Z",
    ci_status: "failed",
    author: "app/red-hat-konflux",
  });
});

// --- cleanup + throttle ordering ---

test("cleanup of merged PRs runs before the throttle gate", async () => {
  const memory = fakeMemory({
    memories: [
      { id: "m1", content: "tracked", tags: ["mintmaker", "mintmaker:repo-a#11"] },
      { id: "m2", content: "tracked", tags: ["mintmaker", "mintmaker:repo-b#13"] },
    ],
  });
  const github = fakeGithub({ prs: new Map([["RedHatInsights/repo-a#11", { state: "MERGED" }]]) });
  const persistentState = fakePersistentState({
    [MINTMAKER_LAST_RUN_KEY]: NOW().getTime() - 1 * HOUR_MS,
  });
  const result = await run({ memory, github, persistentState, now: NOW });
  assert.deepEqual(result, {
    status: "skip",
    content: "Mintmaker scan throttled (last run < 8h ago)\nCleaned up 1 merged/closed PR(s)",
  });
  // The merged PR was cleaned up even though the scan was throttled.
  assert.deepEqual(memory.calls.archivedTasks, ["mintmaker:repo-a#11"]);
  assert.deepEqual(memory.calls.deletedMemories, ["m1"]);
  assert.deepEqual(github.calls.prs, ["RedHatInsights/repo-a#11", "RedHatInsights/repo-b#13"]);
  // The open PR (repo-b#13) was left tracked.
  assert.equal(memory.calls.archivedTasks.includes("mintmaker:repo-b#13"), false);
});

test("closed PRs are cleaned up like merged ones; missing PRs are skipped silently", async () => {
  const memory = fakeMemory({
    memories: [
      { id: "m1", content: "tracked", tags: ["mintmaker", "mintmaker:repo-a#11"] },
      { id: "m2", content: "tracked", tags: ["mintmaker", "mintmaker:repo-gone#99"] },
      { id: "m3", content: "tracked", tags: ["mintmaker", "mintmaker:repo-c#not-a-number"] },
    ],
  });
  const github = fakeGithub({ prs: new Map([["RedHatInsights/repo-a#11", { state: "CLOSED" }]]) });
  const persistentState = fakePersistentState();
  const result = await run({ memory, github, persistentState, now: NOW });
  assert.equal(result.status, "skip");
  assert.match(result.content, /Could not fetch PR CSV report/);
  assert.deepEqual(memory.calls.archivedTasks, ["mintmaker:repo-a#11"]);
  assert.deepEqual(github.calls.prs, ["RedHatInsights/repo-a#11", "RedHatInsights/repo-gone#99"]);
  // The unparseable tag never reached the PR check.
  assert.equal(
    github.calls.prs.some((call) => call.includes("not-a-number")),
    false,
  );
});

test("a PR-state fetch failure warns and continues the cleanup", async () => {
  const memory = fakeMemory({
    memories: [{ id: "m1", content: "tracked", tags: ["mintmaker", "mintmaker:repo-a#11"] }],
  });
  const github = fakeGithub({ prFailures: new Set(["RedHatInsights/repo-a#11"]) });
  const persistentState = fakePersistentState();
  const result = await run({ memory, github, persistentState, now: NOW });
  assert.equal(result.status, "skip");
  assert.match(result.content, /Could not fetch PR CSV report/);
  assert.match(result.content, /WARN: could not check PR state for RedHatInsights\/repo-a#11: github unreachable/);
  assert.deepEqual(memory.calls.archivedTasks, []);
});

test("a cleanup archive failure warns but still counts and continues", async () => {
  const memory = fakeMemory({
    memories: [{ id: "m1", content: "tracked", tags: ["mintmaker", "mintmaker:repo-a#11"] }],
  });
  memory.archiveTask = async () => {
    throw new Error("memory down");
  };
  const github = fakeGithub({ prs: new Map([["RedHatInsights/repo-a#11", { state: "MERGED" }]]) });
  const persistentState = fakePersistentState();
  const result = await run({ memory, github, persistentState, now: NOW });
  assert.equal(result.status, "skip");
  assert.match(result.content, /WARN: could not archive task mintmaker:repo-a#11: memory down/);
  assert.match(result.content, /Cleaned up 1 merged\/closed PR\(s\)/);
  assert.deepEqual(memory.calls.deletedMemories, ["m1"]);
});

// --- CSV fetch + triage ---

test("the throttle expires after exactly throttle_hours and fetches the CSV", async () => {
  const github = fakeGithub({ files: new Map([["open_mr_pr/github/open-prs.csv", CSV]]) });
  const persistentState = fakePersistentState({
    [MINTMAKER_LAST_RUN_KEY]: NOW().getTime() - 8 * HOUR_MS,
  });
  const result = await run({ memory: fakeMemory(), github, persistentState, now: NOW });
  assert.equal(result.status, "start");
  assert.deepEqual(github.calls.files, [
    { ownerRepo: "RedHatInsights/processing-tools", path: "open_mr_pr/github/open-prs.csv", ref: undefined },
  ]);
  assert.deepEqual(persistentState.calls.writes, [
    { key: MINTMAKER_LAST_RUN_KEY, value: NOW().getTime() },
  ]);
});

test("bot PRs in the daily report start the triage with the Python content", async () => {
  const github = fakeGithub({ files: new Map([["open_mr_pr/github/open-prs.csv", CSV]]) });
  const persistentState = fakePersistentState();
  const result = await run({ memory: fakeMemory(), github, persistentState, now: NOW });
  assert.equal(result.status, "start");
  assert.equal(
    result.content,
    "## MintMaker PR Triage — 2 open PR(s) (1 failing, 1 passing)\n" +
      "\n" +
      "Source: processing-tools daily CSV report (generated 4AM UTC)\n" +
      "\n" +
      "### Failing CI\n" +
      "repo-a#11 by app/red-hat-konflux\n" +
      "  title: Fix deps, bump version\n" +
      "  url: https://github.com/RedHatInsights/repo-a/pull/11\n" +
      "  created: 2026-11-03\n" +
      "  ci_status: failed\n" +
      "\n" +
      "### Passing CI (may need review or already merged)\n" +
      "repo-a#12 by app/dependabot\n" +
      "  title: Add feature\n" +
      "  url: https://github.com/RedHatInsights/repo-a/pull/12\n" +
      "  created: 2026-11-03\n" +
      "  ci_status: passed\n",
  );
});

test("a report without bot PRs skips and still records the run time", async () => {
  const csv = "repo,pr_id,title,url,date_created,ci_status,author\nrepo-b,13,Human,https://x,2026-11-03,failed,human\n";
  const github = fakeGithub({ files: new Map([["open_mr_pr/github/open-prs.csv", csv]]) });
  const persistentState = fakePersistentState();
  const result = await run({ memory: fakeMemory(), github, persistentState, now: NOW });
  assert.deepEqual(result, { status: "skip", content: "No open MintMaker/Konflux PRs in daily report" });
  assert.deepEqual(persistentState.calls.writes, [
    { key: MINTMAKER_LAST_RUN_KEY, value: NOW().getTime() },
  ]);
});

test("a missing CSV report skips and records the run time like the Python", async () => {
  const github = fakeGithub();
  const persistentState = fakePersistentState();
  const result = await run({ memory: fakeMemory(), github, persistentState, now: NOW });
  assert.deepEqual(result, { status: "skip", content: "Could not fetch PR CSV report" });
  assert.deepEqual(persistentState.calls.writes, [
    { key: MINTMAKER_LAST_RUN_KEY, value: NOW().getTime() },
  ]);
});

test("custom report_repo, path, authors, and throttle apply", async () => {
  const csv = "repo,pr_id,title,url,date_created,ci_status,author\na,x,b,c,d,passed,app/my-bot\n";
  const github = fakeGithub({ files: new Map([["reports/prs.csv", csv]]) });
  const persistentState = fakePersistentState({
    [MINTMAKER_LAST_RUN_KEY]: NOW().getTime() - 2 * HOUR_MS,
  });
  const result = await run(
    { memory: fakeMemory(), github, persistentState, now: NOW },
    {
      throttle_hours: 1,
      report_repo: "MyOrg/tools",
      report_path: "reports/prs.csv",
      bot_authors: ["app/my-bot"],
    },
  );
  assert.equal(result.status, "start");
  assert.match(result.content, /## MintMaker PR Triage — 1 open PR\(s\) \(0 failing, 1 passing\)/);
  assert.match(result.content, /Source: tools daily CSV report/);
  assert.match(result.content, /a#x by app\/my-bot/);
  assert.deepEqual(github.calls.files, [{ ownerRepo: "MyOrg/tools", path: "reports/prs.csv", ref: undefined }]);
});

// --- wiring failures (through the registered preflight) ---

test("an unwired proxy route returns an error result", async () => {
  const ctx = createPreflightRunContext({
    instanceId: "obsint-test",
    memory: fakeMemory(),
    persistentState: fakePersistentState(),
  });
  const result = await mintmaker.run(ctx, mintmaker.input.parse({}));
  assert.equal(result.status, "error");
  assert.match(result.content, /obsint-mintmaker-prs: auth proxy route is not wired/);
});

test("an unwired persistent state store returns an error result", async () => {
  const ctx = obsintContext({ memory: fakeMemory(), proxy: "https://proxy.example/devbot-proxy" });
  const result = await mintmaker.run(ctx, mintmaker.input.parse({}));
  assert.equal(result.status, "error");
  assert.match(result.content, /obsint-mintmaker-prs requires a wired persistent state store/);
});

test("a memory listing failure escalates to an error result", async () => {
  const memory = fakeMemory();
  memory.listMemories = async () => {
    throw new Error("memory server unavailable");
  };
  await assert.rejects(
    run({ memory, github: fakeGithub(), persistentState: fakePersistentState(), now: NOW }),
    /memory server unavailable/,
  );
});
