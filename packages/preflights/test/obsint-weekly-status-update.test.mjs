import assert from "node:assert/strict";
import test from "node:test";
import { createPreflightRunContext } from "../dist/index.js";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import {
  OBSINT_WEEKLY_STATUS_INPUT,
  WEEKLY_STATUS_STATE_KEY,
  runObsintWeeklyStatusUpdate,
} from "../dist/preflights/obsint-weekly-status-update/index.js";
import { fakeGithub, fakeMemory, fakePersistentState, fakeSlack, obsintContext } from "./obsint-fixtures.mjs";

/**
 * Port of the watchduty `03-weekly-status-update.py` coverage, adapted to
 * the TS module API: the Friday poll window, the Monday AI-fallback
 * window, the combined Slack announcement, and the posted/closed state
 * gating — through the exported run flow with an injected clock, plus the
 * registered preflight's wiring-failure paths.
 */

const registry = createPopulatedRegistry();
const weeklyStatus = registry.get("obsint-weekly-status-update");

// 2026-10-30 is a Friday; 2026-11-02 the following Monday; 2026-10-31 a
// Saturday outside both windows. Europe/Prague is CET (UTC+1) on all three
// dates, so 09:00 UTC is 10:00 local — inside both working-hour windows.
const FRIDAY = () => new Date("2026-10-30T09:00:00Z");
const SATURDAY = () => new Date("2026-10-31T09:00:00Z");
const MONDAY = () => new Date("2026-11-02T09:00:00Z");
const MONDAY_LATE = () => new Date("2026-11-02T12:00:00Z");

const TARGET_DATE = "2026-10-30";
const STATE_KEY = "2026-W44:combined:advisor+mpex";
const ADVISOR_PATH = "reports/2026/2026-10-30/mpex/lightspeed-advisor.md";
const MPEX_PATH = "reports/2026/2026-10-30/mpex.md";
const ADVISOR_URL = `https://github.com/openshift-eng/hp-weekly-status/blob/main/${ADVISOR_PATH}`;
const MPEX_URL = `https://github.com/openshift-eng/hp-weekly-status/blob/main/${MPEX_PATH}`;

const parseParams = (with_) => OBSINT_WEEKLY_STATUS_INPUT.parse(with_ ?? {});

const run = (deps, with_) => runObsintWeeklyStatusUpdate(deps, parseParams(with_));

const fullFiles = () =>
  new Map([
    [ADVISOR_PATH, "# Advisor status\n\nall good\n"],
    [MPEX_PATH, "## MPEX rollup\n\nfine\n"],
  ]);

const baseDeps = (overrides = {}) => ({
  github: fakeGithub({ files: fullFiles() }),
  persistentState: fakePersistentState(),
  now: FRIDAY,
  ...overrides,
});

// --- window gating ---

test("cycles outside the Friday/Monday windows skip before any state or GitHub read", async () => {
  const deps = baseDeps({ now: SATURDAY });
  const result = await run(deps);
  assert.deepEqual(result, {
    status: "skip",
    content: "Weekly status watcher outside Friday/Monday publication windows",
  });
  assert.deepEqual(deps.github.calls.files, []);
  assert.deepEqual(deps.persistentState.calls.reads, []);
});

test("Monday afternoon is outside the AI-fallback window", async () => {
  const result = await run(baseDeps({ now: MONDAY_LATE }));
  assert.deepEqual(result, {
    status: "skip",
    content: "Weekly status watcher outside Friday/Monday publication windows",
  });
});

// --- Friday polling ---

test("missing reports on Friday skip and keep polling without writing state", async () => {
  const deps = baseDeps({
    github: fakeGithub({ files: new Map([[MPEX_PATH, "## MPEX rollup\n\nfine\n"]]) }),
  });
  const result = await run(deps);
  assert.deepEqual(result, {
    status: "skip",
    content: `Waiting for all weekly status reports for ${TARGET_DATE}: ${ADVISOR_PATH}`,
  });
  assert.deepEqual(deps.persistentState.calls.writes, []);
});

test("all reports present announce via Slack, persist the marker, and skip", async () => {
  const slack = fakeSlack();
  const deps = baseDeps({ slack });
  const result = await run(deps);
  assert.deepEqual(result, {
    status: "skip",
    content: `Announced combined weekly status for ${TARGET_DATE}`,
  });
  assert.deepEqual(slack.calls.sentTo, [
    {
      channel: "weeklyStatus",
      text:
        `🗓️ *Advisor and MPEX weekly status updates are available* — ${TARGET_DATE}\n` +
        "\n" +
        `*Advisor / Lightspeed Advisor*\n` +
        `<${ADVISOR_URL}|${ADVISOR_PATH}>\n` +
        "\n" +
        "*Advisor status*\n" +
        "\n" +
        "all good\n" +
        "\n" +
        "*MPEX rollup*\n" +
        `<${MPEX_URL}|${MPEX_PATH}>\n` +
        "\n" +
        // The excerpt bolds the report's own headings too (mrkdwn).
        "*MPEX rollup*\n" +
        "\n" +
        "fine",
    },
  ]);
  assert.deepEqual(deps.persistentState.calls.writes, [
    {
      key: WEEKLY_STATUS_STATE_KEY,
      value: {
        [STATE_KEY]: {
          posted: true,
          closed: true,
          posted_at: "2026-10-30T09:00:00.000Z",
          repo: "openshift-eng/hp-weekly-status",
          ref: "main",
          report_ids: ["advisor", "mpex"],
          reports: [
            { id: "advisor", path: ADVISOR_PATH, sha: "", url: ADVISOR_URL },
            { id: "mpex", path: MPEX_PATH, sha: "", url: MPEX_URL },
          ],
          target_date: TARGET_DATE,
        },
      },
    },
  ]);
});

test("an unwired Slack client degrades to the announcement-failed skip without marking the week", async () => {
  const deps = baseDeps();
  const result = await run(deps);
  assert.deepEqual(result, {
    status: "skip",
    content: `All weekly status reports found for ${TARGET_DATE}, but Slack announcement failed`,
  });
  assert.deepEqual(deps.persistentState.calls.writes, []);
});

test("a failed Slack send degrades the same way, so the next cycle retries", async () => {
  const deps = baseDeps({ slack: fakeSlack({ ok: false }) });
  const result = await run(deps);
  assert.deepEqual(result, {
    status: "skip",
    content: `All weekly status reports found for ${TARGET_DATE}, but Slack announcement failed`,
  });
  assert.deepEqual(deps.persistentState.calls.writes, []);
});

test("long report content is clipped and headings bolded in the excerpt", async () => {
  const longBody = `# Advisor status\n\n${"x".repeat(2000)}\n`;
  const slack = fakeSlack();
  const deps = baseDeps({
    github: fakeGithub({
      files: new Map([
        [ADVISOR_PATH, longBody],
        [MPEX_PATH, "## MPEX rollup\n\nfine\n"],
      ]),
    }),
    slack,
  });
  const result = await run(deps);
  assert.equal(result.status, "skip");
  assert.match(result.content, /Announced combined weekly status/);
  const message = slack.calls.sentTo[0].text;
  // The report's own heading is bolded and the body clipped with an
  // ellipsis at the 1200-character excerpt limit.
  const advisorPart = message.split("*Advisor status*")[1].split("\n\n*MPEX rollup*")[0];
  assert.match(advisorPart, /^\n\nx+\n…$/);
  assert.ok(advisorPart.length <= 1210, `excerpt too long: ${advisorPart.length}`);
});

// --- state gating ---

test("a posted week skips as already announced", async () => {
  const deps = baseDeps({
    persistentState: fakePersistentState({
      [WEEKLY_STATUS_STATE_KEY]: {
        [STATE_KEY]: { posted: true, closed: true, target_date: TARGET_DATE },
      },
    }),
  });
  const result = await run(deps);
  assert.deepEqual(result, {
    status: "skip",
    content: `Combined weekly status already announced for ${TARGET_DATE}`,
  });
  assert.deepEqual(deps.github.calls.files, []);
});

test("a closed-but-unposted week skips as already closed", async () => {
  const deps = baseDeps({
    now: MONDAY,
    persistentState: fakePersistentState({
      [WEEKLY_STATUS_STATE_KEY]: {
        [STATE_KEY]: { posted: false, closed: true, target_date: TARGET_DATE },
      },
    }),
  });
  const result = await run(deps);
  assert.deepEqual(result, {
    status: "skip",
    content: `Combined weekly status check already closed for ${TARGET_DATE}`,
  });
});

// --- Monday AI fallback ---

test("missing reports during the Monday fallback start the path-check session and close the watcher", async () => {
  const deps = baseDeps({
    now: MONDAY,
    github: fakeGithub({ files: new Map([[MPEX_PATH, "## MPEX rollup\n\nfine\n"]]) }),
  });
  const result = await run(deps);
  assert.equal(result.status, "start");
  const content = result.content;
  assert.match(content, /^## Weekly status combined-message path check/);
  assert.match(content, /One or more expected weekly status files were not found during the Monday fallback window\./);
  assert.match(content, /The preflight has already marked the combined weekly watcher complete/);
  assert.match(content, /- Current time: 2026-11-02T09:00:00\.000Z/);
  assert.match(content, /- Repo: `openshift-eng\/hp-weekly-status`/);
  assert.match(content, /- Ref: `main`/);
  assert.match(content, /- Expected Friday folder date: `2026-10-30`/);
  assert.match(content, /- Dedup state key: `2026-W44:combined:advisor\+mpex`/);
  assert.match(content, /Reports found at the expected paths:/);
  assert.match(content, /- MPEX rollup: https:\/\/github\.com\/openshift-eng\/hp-weekly-status\/blob\/main\/reports\/2026\/2026-10-30\/mpex\.md/);
  assert.match(content, /Missing expected reports:/);
  assert.match(content, /- Advisor \/ Lightspeed Advisor \(`advisor`\)/);
  assert.match(content, /  - Expected path: `reports\/2026\/2026-10-30\/mpex\/lightspeed-advisor\.md`/);
  assert.match(content, /  - Expected URL: https:\/\/github\.com\/openshift-eng\/hp-weekly-status\/blob\/main\/reports\/2026\/2026-10-30\/mpex\/lightspeed-advisor\.md/);
  assert.match(
    content,
    /gh api repos\/openshift-eng\/hp-weekly-status\/contents\/reports\/2026\/2026-10-30\?ref=main --jq '\.\[\]\.path'/,
  );
  assert.match(content, /gh api repos\/openshift-eng\/hp-weekly-status\/git\/trees\/main\?recursive=1 \\/);
  assert.match(content, /grep -Ei '\(2026-10-30\|advisor\|lightspeed\|mpex\)'/);
  assert.match(content, /message-composer/);
  assert.match(content, /It is acceptable for this weekly check to end without success\./);
  // The watcher was closed before the session started.
  assert.deepEqual(deps.persistentState.calls.writes, [
    {
      key: WEEKLY_STATUS_STATE_KEY,
      value: {
        [STATE_KEY]: {
          posted: false,
          closed: true,
          path_check_requested: true,
          path_check_requested_at: "2026-11-02T09:00:00.000Z",
          repo: "openshift-eng/hp-weekly-status",
          ref: "main",
          report_ids: ["advisor", "mpex"],
          present: [{ id: "mpex", path: MPEX_PATH, sha: "", url: MPEX_URL }],
          missing: [{ id: "advisor", path: ADVISOR_PATH }],
          target_date: TARGET_DATE,
          reason: "one or more expected reports missing at Monday AI fallback window",
        },
      },
    },
  ]);
});

test("a non-404 report fetch failure errors the run instead of reading as missing", async () => {
  const github = fakeGithub({ files: fullFiles() });
  github.getFileContents = async () => {
    throw new Error("GET https://proxy/github/... failed with HTTP 500");
  };
  await assert.rejects(run(baseDeps({ github })), /HTTP 500/);
});

// --- wiring failures (through the registered preflight) ---

test("an unwired proxy route returns an error result", async () => {
  const ctx = createPreflightRunContext({
    instanceId: "obsint-test",
    memory: fakeMemory(),
    persistentState: fakePersistentState(),
  });
  const result = await weeklyStatus.run(ctx, weeklyStatus.input.parse({}));
  assert.equal(result.status, "error");
  assert.match(result.content, /obsint-weekly-status-update: auth proxy route is not wired/);
});

test("an unwired persistent state store returns an error result", async () => {
  const ctx = obsintContext({ proxy: "https://proxy.example/devbot-proxy" });
  const result = await weeklyStatus.run(ctx, weeklyStatus.input.parse({}));
  assert.equal(result.status, "error");
  assert.match(result.content, /obsint-weekly-status-update requires a wired persistent state store/);
});
