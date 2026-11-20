import assert from "node:assert/strict";
import test from "node:test";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import {
  BACKLOG_GROOMED_WEEKS_KEY,
  OBSINT_BACKLOG_SCAN_INPUT,
  runObsintBacklogScan,
} from "../dist/preflights/obsint-backlog-scan/index.js";
import { fakeJira, fakePersistentState, obsintContext } from "./obsint-fixtures.mjs";

/**
 * Port of the backlog-groomer `01-backlog-scan.py` coverage, adapted to the
 * TS module API: the UTC weekday gate, the once-per-ISO-week marker, the
 * exact JQL, and the ticket formatting — through the exported run flow
 * with an injected clock and plain-object Jira/state fakes, plus the
 * registered preflight's wiring-failure paths.
 */

const registry = createPopulatedRegistry();
const backlogScan = registry.get("obsint-backlog-scan");

// 2026-11-04 is a Wednesday (UTC); 2026-11-05 a Thursday. Its ISO week is
// 2026-W45.
const WEDNESDAY = () => new Date("2026-11-04T10:00:00Z");
const THURSDAY = () => new Date("2026-11-05T10:00:00Z");
const WEEK_KEY = "2026-W45";

const parseParams = (with_) => OBSINT_BACKLOG_SCAN_INPUT.parse(with_ ?? { label: "obsint-processing" });

const run = (deps, with_) => runObsintBacklogScan(deps, parseParams(with_));

const EXPECTED_JQL =
  'labels = obsint-processing AND status IN ("New", "Backlog", "Refinement", "To Do") ' +
  "AND labels != ai-groomed AND assignee is EMPTY AND sprint is EMPTY " +
  "AND type NOT IN (Epic) ORDER BY created ASC";

const EXPECTED_FIELDS = [
  "summary",
  "status",
  "labels",
  "priority",
  "description",
  "comment",
  "issuetype",
  "created",
  "updated",
  "parent",
  "customfield_12311140",
  "fixVersions",
];

const backlogIssue = (key, fields = {}) => ({
  key,
  fields: {
    summary: `Summary of ${key}`,
    status: { name: "New" },
    priority: { name: "High" },
    issuetype: { name: "Bug" },
    labels: ["obsint-processing", "repo:my-repo", "extra"],
    description: "Some description\nsecond line",
    created: "2026-10-01T12:34:56Z",
    updated: "2026-11-01T08:00:00Z",
    parent: { key: "EPIC-1", fields: { status: { name: "In Progress" }, summary: "Epic summary" } },
    fixVersions: [{ name: "2026Q4" }],
    customfield_12311140: "2026Q4",
    comment: {
      comments: [
        {
          author: { displayName: "Human" },
          created: "2026-11-01T10:00:00Z",
          body: "please fix",
        },
      ],
    },
    ...fields,
  },
});

// --- gating ---

test("non-Wednesdays skip before any Jira or state access", async () => {
  const jira = fakeJira();
  const persistentState = fakePersistentState();
  const result = await run({ jira, persistentState, now: THURSDAY });
  assert.deepEqual(result, { status: "skip", content: "Backlog grooming only runs on Wednesdays" });
  assert.deepEqual(jira.calls.jqls, []);
  assert.deepEqual(persistentState.calls.reads, []);
});

test("a custom grooming_day names its weekday in the skip", async () => {
  const result = await run(
    { jira: fakeJira(), persistentState: fakePersistentState(), now: WEDNESDAY },
    { label: "obsint-processing", grooming_day: 4 },
  );
  assert.deepEqual(result, { status: "skip", content: "Backlog grooming only runs on Fridays" });
});

test("an already-groomed ISO week skips", async () => {
  const jira = fakeJira();
  const result = await run({
    jira,
    persistentState: fakePersistentState({ [BACKLOG_GROOMED_WEEKS_KEY]: { [WEEK_KEY]: true } }),
    now: WEDNESDAY,
  });
  assert.deepEqual(result, { status: "skip", content: "Already groomed this week" });
  assert.deepEqual(jira.calls.jqls, []);
});

// --- search + formatting ---

test("ungroomed tickets start with the exact JQL, fields, and report format", async () => {
  const jira = fakeJira({ issues: [backlogIssue("TEST-1"), backlogIssue("TEST-2")] });
  const persistentState = fakePersistentState();
  const result = await run({ jira, persistentState, now: WEDNESDAY });
  assert.equal(result.status, "start");
  assert.deepEqual(jira.calls.jqls, [EXPECTED_JQL]);
  assert.deepEqual(jira.calls.fields, [EXPECTED_FIELDS]);
  assert.deepEqual(persistentState.calls.writes, [
    { key: BACKLOG_GROOMED_WEEKS_KEY, value: { [WEEK_KEY]: true } },
  ]);
  assert.equal(
    result.content,
    "## Backlog Grooming — 2 ticket(s) to assess\n" +
      "\n" +
      "TEST-1 [New] priority=High type=Bug\n" +
      "  title: Summary of TEST-1\n" +
      "  created: 2026-10-01 | updated: 2026-11-01\n" +
      "  epic: EPIC-1 [In Progress] — Epic summary\n" +
      "  fixVersions: 2026Q4\n" +
      "  targetQuarter: 2026Q4\n" +
      "  repos: repo:my-repo\n" +
      "  labels: extra\n" +
      "  description:\n" +
      "    Some description\n" +
      "    second line\n" +
      "  recent_comments (1):\n" +
      "    [2026-11-01T10:00] Human: please fix\n" +
      "\n" +
      "TEST-2 [New] priority=High type=Bug\n" +
      "  title: Summary of TEST-2\n" +
      "  created: 2026-10-01 | updated: 2026-11-01\n" +
      "  epic: EPIC-1 [In Progress] — Epic summary\n" +
      "  fixVersions: 2026Q4\n" +
      "  targetQuarter: 2026Q4\n" +
      "  repos: repo:my-repo\n" +
      "  labels: extra\n" +
      "  description:\n" +
      "    Some description\n" +
      "    second line\n" +
      "  recent_comments (1):\n" +
      "    [2026-11-01T10:00] Human: please fix\n",
  );
});

test("a groomed week is not re-groomed on the second run", async () => {
  const jira = fakeJira({ issues: [backlogIssue("TEST-1")] });
  const persistentState = fakePersistentState();
  const first = await run({ jira, persistentState, now: WEDNESDAY });
  assert.equal(first.status, "start");
  const second = await run({ jira, persistentState, now: WEDNESDAY });
  assert.deepEqual(second, { status: "skip", content: "Already groomed this week" });
});

test("an empty backlog skips without marking the week", async () => {
  const persistentState = fakePersistentState();
  const result = await run({ jira: fakeJira({ issues: [] }), persistentState, now: WEDNESDAY });
  assert.deepEqual(result, { status: "skip", content: "No ungroomed backlog tickets" });
  assert.deepEqual(persistentState.calls.writes, []);
});

test("empty and placeholder descriptions render as (empty)", async () => {
  const issues = [
    backlogIssue("TEST-1", { description: "" }),
    backlogIssue("TEST-2", { description: "None" }),
    backlogIssue("TEST-3", { description: "real" }),
  ];
  const result = await run({
    jira: fakeJira({ issues }),
    persistentState: fakePersistentState(),
    now: WEDNESDAY,
  });
  assert.equal(result.status, "start");
  assert.match(result.content, /TEST-1[\s\S]*?description: \(empty\)/);
  assert.match(result.content, /TEST-2[\s\S]*?description: \(empty\)/);
  assert.match(result.content, /TEST-3[\s\S]*?description:\n    real/);
});

test("long descriptions and comments are clipped like the Python", async () => {
  const issues = [
    backlogIssue("TEST-1", {
      description: `${"d".repeat(600)}\n${"e".repeat(10)}`,
      comment: { comments: [{ author: { displayName: "H" }, created: "2026-11-01T10:00:00Z", body: "y".repeat(300) }] },
    }),
  ];
  const result = await run({
    jira: fakeJira({ issues }),
    persistentState: fakePersistentState(),
    now: WEDNESDAY,
  });
  assert.equal(result.status, "start");
  assert.match(result.content, new RegExp(`d{500}\\.\\.\\.`));
  assert.match(result.content, /y{200}\.\.\./);
});

// --- wiring failures (through the registered preflight) ---

test("an unwired jira client returns an error result", async () => {
  const ctx = obsintContext({ persistentState: fakePersistentState() });
  const result = await backlogScan.run(ctx, backlogScan.input.parse({ label: "obsint-processing" }));
  assert.equal(result.status, "error");
  assert.match(result.content, /jira client not wired/);
});

test("an unwired persistent state store returns an error result", async () => {
  const ctx = obsintContext({ jira: fakeJira() });
  const result = await backlogScan.run(ctx, backlogScan.input.parse({ label: "obsint-processing" }));
  assert.equal(result.status, "error");
  assert.match(result.content, /obsint-backlog-scan requires a wired persistent state store/);
});

test("a Jira search failure errors the run instead of reading as no tickets", async () => {
  const jira = fakeJira();
  jira.searchIssues = async () => {
    throw new Error("jira search failed with HTTP 500");
  };
  await assert.rejects(
    run({ jira, persistentState: fakePersistentState(), now: WEDNESDAY }),
    /jira search failed with HTTP 500/,
  );
});
