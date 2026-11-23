import assert from "node:assert/strict";
import test from "node:test";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import {
  MINTMAKER_LAST_RUN_KEY,
  OBSINT_MINTMAKER_INPUT,
  runObsintMintmakerPrs,
} from "../dist/preflights/obsint-mintmaker-prs/index.js";
import { fakeGithub, fakeMemory, fakePersistentState, obsintContext } from "./obsint-fixtures.mjs";

const now = () => new Date("2026-11-04T10:00:00Z");
const hoursLater = (hours) => () => new Date(now().getTime() + hours * 3_600_000);
const run = (deps, overrides = {}) =>
  runObsintMintmakerPrs(
    { memory: fakeMemory(), now, ...deps },
    OBSINT_MINTMAKER_INPUT.parse(overrides),
  );
const reportPath = "open_mr_pr/github/open-prs.csv";
const header = "repo,pr_id,title,url,date_created,ci_status,author";
const human = "repo-b,13,Human PR,https://example.invalid/13,2026-11-03,failed,human";
const csv = [
  header,
  'repo-a,11,"Fix deps, bump version",https://example.invalid/11,2026-11-03,failed,app/red-hat-konflux',
  "repo-a,12,Add feature,https://example.invalid/12,2026-11-03,passed,app/dependabot",
  human,
].join("\n");
const entry = (pr) => ({
  id: pr,
  content: "tracked",
  tags: ["mintmaker", `mintmaker:repo-a#${pr}`],
});

test("merged and closed PRs are cleaned before throttle; open and missing PRs stay tracked", async () => {
  const memory = fakeMemory({ memories: ["11", "12", "13", "14"].map(entry) });
  const github = fakeGithub({
    prs: new Map([
      ["RedHatInsights/repo-a#11", { state: "MERGED" }],
      ["RedHatInsights/repo-a#12", { state: "CLOSED" }],
      ["RedHatInsights/repo-a#13", { state: "OPEN" }],
    ]),
  });
  const persistentState = fakePersistentState({ [MINTMAKER_LAST_RUN_KEY]: now().getTime() });
  assert.equal((await run({ github, memory, persistentState })).status, "skip");
  assert.deepEqual(memory.calls.archivedTasks, ["mintmaker:repo-a#11", "mintmaker:repo-a#12"]);
  assert.deepEqual(memory.calls.deletedMemories, ["11", "12"]);
  assert.deepEqual(
    github.calls.prs,
    ["11", "12", "13", "14"].map((pr) => `RedHatInsights/repo-a#${pr}`),
  );
  assert.deepEqual(github.calls.files, []);
});

test("PR lookup and archive failures warn without stopping cleanup", async () => {
  const memory = fakeMemory({ memories: ["11", "12", "13"].map(entry) });
  const archiveTask = memory.archiveTask;
  memory.archiveTask = async (key) => {
    if (key.endsWith("#12")) throw new Error("memory down");
    await archiveTask(key);
  };
  const github = fakeGithub({
    prFailures: new Set(["RedHatInsights/repo-a#11"]),
    prs: new Map([12, 13].map((pr) => [`RedHatInsights/repo-a#${pr}`, { state: "MERGED" }])),
  });
  const result = await run({ github, memory, persistentState: fakePersistentState() });
  assert.equal(result.status, "skip");
  assert.match(result.content, /WARN:[\s\S]*?#11.*github unreachable/);
  assert.match(result.content, /WARN:[\s\S]*?#12.*memory down/);
  assert.deepEqual(memory.calls.archivedTasks, ["mintmaker:repo-a#13"]);
  assert.deepEqual(memory.calls.deletedMemories, ["12", "13"]);
});

test("bot PRs reach triage and another scan waits until the eight-hour boundary", async () => {
  const github = fakeGithub({ files: new Map([[reportPath, csv]]) });
  const persistentState = fakePersistentState();
  const deps = { github, persistentState };
  const first = await run(deps);
  assert.equal(first.status, "start");
  assert.ok(first.content.includes("Fix deps, bump version"));
  assert.match(first.content, /Failing CI[\s\S]*repo-a#11[\s\S]*Passing CI[\s\S]*repo-a#12/);
  assert.ok(!first.content.includes("repo-b#13"));
  assert.deepEqual(persistentState.calls.writes, [
    { key: MINTMAKER_LAST_RUN_KEY, value: now().getTime() },
  ]);
  assert.equal((await run({ ...deps, now: hoursLater(7) })).status, "skip");
  assert.equal(github.calls.files.length, 1);
  assert.equal((await run({ ...deps, now: hoursLater(8) })).status, "start");
  assert.equal(github.calls.files.length, 2);
});

test("missing and human-only reports skip but still record the scan time", async () => {
  for (const files of [new Map(), new Map([[reportPath, `${header}\n${human}`]])]) {
    const persistentState = fakePersistentState();
    assert.equal((await run({ github: fakeGithub({ files }), persistentState })).status, "skip");
    assert.deepEqual(persistentState.calls.writes, [
      { key: MINTMAKER_LAST_RUN_KEY, value: now().getTime() },
    ]);
  }
});

test("custom report source, bot authors and throttle apply", async () => {
  const github = fakeGithub({
    files: new Map([["reports/prs.csv", `${header}\na,11,Custom bot PR,c,d,passed,app/my-bot`]]),
  });
  const persistentState = fakePersistentState({
    [MINTMAKER_LAST_RUN_KEY]: hoursLater(-2)().getTime(),
  });
  const result = await run(
    { github, persistentState },
    {
      throttle_hours: 1,
      report_repo: "MyOrg/tools",
      report_path: "reports/prs.csv",
      bot_authors: ["app/my-bot"],
    },
  );
  assert.equal(result.status, "start");
  assert.ok(result.content.includes("Custom bot PR"));
  assert.deepEqual(
    github.calls.files.map(({ ownerRepo, path }) => [ownerRepo, path]),
    [["MyOrg/tools", "reports/prs.csv"]],
  );
});

test("tracking lookup failure aborts before fetching the report or marking the scan", async () => {
  const memory = fakeMemory();
  memory.listMemories = async () => {
    throw new Error("memory server unavailable");
  };
  const github = fakeGithub();
  const persistentState = fakePersistentState();
  await assert.rejects(run({ memory, github, persistentState }), /memory server unavailable/);
  assert.deepEqual(github.calls.files, []);
  assert.deepEqual(persistentState.calls.writes, []);
});

test("the registered GitHub preflight reports missing proxy wiring", async () => {
  const preflight = createPopulatedRegistry().get("obsint-mintmaker-prs");
  const result = await preflight.run(
    obsintContext({ persistentState: fakePersistentState() }),
    preflight.input.parse({}),
  );
  assert.equal(result.status, "error");
  assert.match(result.content, /auth proxy route is not wired/);
});
