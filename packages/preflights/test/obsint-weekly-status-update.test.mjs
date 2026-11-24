import assert from "node:assert/strict";
import test from "node:test";
import {
  OBSINT_WEEKLY_STATUS_INPUT,
  runObsintWeeklyStatusUpdate,
  WEEKLY_STATUS_STATE_KEY,
} from "../dist/preflights/obsint-weekly-status-update/index.js";
import { fakeGithub, fakePersistentState, fakeSlack } from "./obsint-fixtures.mjs";

// 09:00 UTC is 10:00 in Prague on these dates; Monday's target is the prior Friday.
const friday = () => new Date("2026-10-30T09:00:00Z");
const monday = () => new Date("2026-11-02T09:00:00Z");
const targetDate = "2026-10-30";
const stateKey = "2026-W44:combined:advisor+mpex";
const advisorPath = `reports/2026/${targetDate}/mpex/lightspeed-advisor.md`;
const mpexPath = `reports/2026/${targetDate}/mpex.md`;
const reportUrl = (path) => `https://github.com/openshift-eng/hp-weekly-status/blob/main/${path}`;
const files = () =>
  new Map([
    [advisorPath, "# Advisor status\n\nall good\n"],
    [mpexPath, "## MPEX rollup\n\nfine\n"],
  ]);
const deps = (overrides = {}) => ({
  github: fakeGithub({ files: files() }),
  persistentState: fakePersistentState(),
  slack: fakeSlack(),
  now: friday,
  ...overrides,
});
const run = (clients) => runObsintWeeklyStatusUpdate(clients, OBSINT_WEEKLY_STATUS_INPUT.parse({}));

test("weekends and late Monday skip before state or GitHub access", async () => {
  for (const timestamp of ["2026-10-31T09:00:00Z", "2026-11-02T12:00:00Z"]) {
    const clients = deps({ now: () => new Date(timestamp) });
    assert.equal((await run(clients)).status, "skip", timestamp);
    assert.deepEqual(clients.github.calls.files, []);
    assert.deepEqual(clients.persistentState.calls.reads, []);
  }
});

test("Friday keeps polling without announcing or closing on partial reports", async () => {
  const partial = files();
  partial.delete(advisorPath);
  const clients = deps({ github: fakeGithub({ files: partial }) });
  assert.equal((await run(clients)).status, "skip");
  assert.deepEqual(clients.persistentState.calls.writes, []);
  assert.deepEqual(clients.slack.calls.sentTo, []);
  partial.set(advisorPath, "Advisor report arrived");
  assert.equal((await run(clients)).status, "skip");
  assert.equal(clients.slack.calls.sentTo.length, 1);
});

test("Friday sends one combined report and prevents Monday from reposting it", async () => {
  const clients = deps();
  assert.equal((await run(clients)).status, "skip");
  assert.equal(clients.slack.calls.sentTo.length, 1);
  const [{ channel, text }] = clients.slack.calls.sentTo;
  assert.equal(channel, "weeklyStatus");
  for (const value of [
    targetDate,
    reportUrl(advisorPath),
    reportUrl(mpexPath),
    "all good",
    "fine",
  ]) {
    assert.ok(text.includes(value));
  }
  const state = await clients.persistentState.get(WEEKLY_STATUS_STATE_KEY);
  assert.equal(state?.[stateKey]?.posted, true);
  assert.equal(state?.[stateKey]?.closed, true);
  assert.deepEqual(
    state[stateKey].reports.map(({ path }) => path),
    [advisorPath, mpexPath],
  );

  const reads = clients.github.calls.files.length;
  assert.equal((await run({ ...clients, now: monday })).status, "skip");
  assert.equal(clients.slack.calls.sentTo.length, 1);
  assert.equal(clients.github.calls.files.length, reads);
});

test("a failed Slack announcement leaves the week open for a retry", async () => {
  const clients = deps({ slack: fakeSlack({ ok: false }) });
  assert.equal((await run(clients)).status, "skip");
  assert.equal(clients.slack.calls.sentTo.length, 1);
  assert.deepEqual(clients.persistentState.calls.writes, []);
  const slack = fakeSlack();
  assert.equal((await run({ ...clients, slack })).status, "skip");
  assert.equal(slack.calls.sentTo.length, 1);
  const state = await clients.persistentState.get(WEEKLY_STATUS_STATE_KEY);
  assert.equal(state?.[stateKey]?.posted, true);
});

test("Monday starts one path check for missing Friday reports and closes the watcher", async () => {
  const partial = files();
  partial.delete(advisorPath);
  const clients = deps({ now: monday, github: fakeGithub({ files: partial }) });
  const first = await run(clients);
  assert.equal(first.status, "start");
  for (const value of [advisorPath, reportUrl(mpexPath), stateKey])
    assert.ok(first.content.includes(value));

  const state = await clients.persistentState.get(WEEKLY_STATUS_STATE_KEY);
  const entry = state?.[stateKey];
  assert.equal(entry?.posted, false);
  assert.equal(entry.closed, true);
  assert.equal(entry.path_check_requested, true);
  assert.equal(entry.target_date, targetDate);
  assert.deepEqual(entry.missing, [{ id: "advisor", path: advisorPath }]);

  const reads = clients.github.calls.files.length;
  assert.equal((await run(clients)).status, "skip");
  assert.equal(clients.github.calls.files.length, reads);
  assert.deepEqual(clients.slack.calls.sentTo, []);
});

test("non-404 GitHub failures propagate instead of starting a missing-report fallback", async () => {
  const clients = deps({ now: monday });
  clients.github.getFileContents = async () => {
    throw new Error("GitHub request failed with HTTP 500");
  };
  await assert.rejects(run(clients), /HTTP 500/);
  assert.deepEqual(clients.persistentState.calls.writes, []);
  assert.deepEqual(clients.slack.calls.sentTo, []);
});
