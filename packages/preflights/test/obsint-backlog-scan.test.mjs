import assert from "node:assert/strict";
import test from "node:test";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import {
  BACKLOG_GROOMED_WEEKS_KEY,
  OBSINT_BACKLOG_SCAN_INPUT,
  runObsintBacklogScan,
} from "../dist/preflights/obsint-backlog-scan/index.js";
import { fakeJira, fakePersistentState, obsintContext } from "./obsint-fixtures.mjs";

const wednesday = () => new Date("2026-11-04T10:00:00Z");
const thursday = () => new Date("2026-11-05T10:00:00Z");
const issue = {
  key: "TEST-1",
  fields: { summary: "Backlog candidate", description: "Customer context" },
};
const run = (deps, overrides = {}) =>
  runObsintBacklogScan(
    { now: wednesday, ...deps },
    OBSINT_BACKLOG_SCAN_INPUT.parse({ label: "obsint-processing", ...overrides }),
  );

test("the UTC weekday gate skips before Jira or state access", async () => {
  const jira = fakeJira();
  const persistentState = fakePersistentState();
  assert.equal((await run({ jira, persistentState, now: thursday })).status, "skip");
  assert.deepEqual(jira.calls.jqls, []);
  assert.deepEqual(persistentState.calls.reads, []);
});

test("the grooming day override allows a different UTC weekday", async () => {
  const jira = fakeJira({ issues: [issue] });
  const result = await run(
    { jira, persistentState: fakePersistentState(), now: thursday },
    { grooming_day: 3 },
  );
  assert.equal(result.status, "start");
});

test("Jira selects ungroomed, unassigned work that is not in a sprint", async () => {
  const jira = fakeJira({ issues: [issue] });
  const result = await run({ jira, persistentState: fakePersistentState() });
  assert.equal(result.status, "start");
  const [jql] = jira.calls.jqls;
  for (const filter of [
    /\blabels\s*=\s*obsint-processing\b/i,
    /\blabels\s*!=\s*ai-groomed\b/i,
    /\bassignee\s+is\s+empty\b/i,
    /\bsprint\s+is\s+empty\b/i,
    /\btype\s+not\s+in\s*\(\s*Epic\s*\)/i,
  ])
    assert.match(jql, filter);
  const statuses = jql.match(/\bstatus\s+in\s*\(([^)]+)\)/i)?.[1];
  assert.deepEqual(
    statuses
      ?.split(",")
      .map((entry) => entry.trim().replaceAll('"', ""))
      .sort(),
    ["Backlog", "New", "Refinement", "To Do"],
  );
  for (const value of [issue.key, issue.fields.summary, issue.fields.description]) {
    assert.ok(result.content.includes(value));
  }
});

test("a successful scan skips the next cycle in the same ISO week before Jira access", async () => {
  const jira = fakeJira({ issues: [issue] });
  const persistentState = fakePersistentState();
  const deps = { jira, persistentState };
  assert.equal((await run(deps)).status, "start");
  assert.deepEqual(persistentState.calls.writes, [
    { key: BACKLOG_GROOMED_WEEKS_KEY, value: { "2026-W45": true } },
  ]);
  assert.equal((await run(deps)).status, "skip");
  assert.equal(jira.calls.jqls.length, 1);
});

test("an empty backlog leaves the week eligible for retry", async () => {
  const persistentState = fakePersistentState();
  assert.equal((await run({ jira: fakeJira(), persistentState })).status, "skip");
  assert.deepEqual(persistentState.calls.writes, []);
});

test("a Jira search failure propagates and does not mark the week", async () => {
  const jira = fakeJira();
  jira.searchIssues = async () => {
    throw new Error("jira search failed with HTTP 500");
  };
  const persistentState = fakePersistentState();
  await assert.rejects(run({ jira, persistentState }), /HTTP 500/);
  assert.deepEqual(persistentState.calls.writes, []);
});

test("the registered Jira preflight reports missing client wiring", async () => {
  const preflight = createPopulatedRegistry().get("obsint-backlog-scan");
  const result = await preflight.run(
    obsintContext({ persistentState: fakePersistentState() }),
    preflight.input.parse({ label: "obsint-processing" }),
  );
  assert.equal(result.status, "error");
  assert.match(result.content, /jira client not wired/);
});
