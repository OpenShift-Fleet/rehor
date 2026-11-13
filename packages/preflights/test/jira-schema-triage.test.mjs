import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig } from "../dist/index.js";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import { activeTask, createTestContext } from "./jira-fixtures.mjs";

/**
 * Focused schema and triage coverage from the PR #652 review: the Jira
 * preflights' input schemas fail closed on blank required values and empty
 * status lists (so validateConfig stops a run before any preflight
 * executes), the integer cooldown keeps accepting negative whole minutes
 * like the Python int() read, and onboarding's feedback classification
 * scans the full comment history while the rendered prompt stays bounded
 * with the triggering feedback visible.
 */

const registry = createPopulatedRegistry();
const jiraSprint = registry.get("jira-sprint");
const jiraKanban = registry.get("jira-kanban");
const onboarding = registry.get("onboarding");

// --- jira-sprint input schema ---

test("jira-sprint rejects blank label values", () => {
  assert.equal(jiraSprint.input.safeParse({ label: "" }).success, false);
  assert.equal(jiraSprint.input.safeParse({ label: "   " }).success, false);
  assert.equal(jiraSprint.input.safeParse({ label: "hcc-ai-test" }).success, true);
});

test("jira-sprint interrupted_retry_minutes accepts negative whole minutes", () => {
  // The Python read was int(BOT_INTERRUPTED_RETRY_MINUTES) — whole minutes, any sign.
  assert.equal(
    jiraSprint.input.safeParse({ label: "hcc-ai-test", interrupted_retry_minutes: -15 }).success,
    true,
  );
  assert.equal(
    jiraSprint.input.safeParse({ label: "hcc-ai-test", interrupted_retry_minutes: 7.5 }).success,
    false,
  );
});

// --- jira-kanban input schema ---

test("jira-kanban rejects blank project and label values", () => {
  assert.equal(jiraKanban.input.safeParse({ project: "", label: "hcc-ai-test" }).success, false);
  assert.equal(jiraKanban.input.safeParse({ project: "  ", label: "hcc-ai-test" }).success, false);
  assert.equal(jiraKanban.input.safeParse({ project: "LCORE", label: "" }).success, false);
  assert.equal(jiraKanban.input.safeParse({ project: "LCORE", label: "\t" }).success, false);
  assert.equal(
    jiraKanban.input.safeParse({ project: "LCORE", label: "hcc-ai-test" }).success,
    true,
  );
});

test("jira-kanban rejects empty status lists and blank status elements", () => {
  assert.equal(
    jiraKanban.input.safeParse({ project: "LCORE", label: "hcc-ai-test", statuses: [] }).success,
    false,
  );
  assert.equal(
    jiraKanban.input.safeParse({
      project: "LCORE",
      label: "hcc-ai-test",
      statuses: ["New", ""],
    }).success,
    false,
  );
  assert.equal(
    jiraKanban.input.safeParse({
      project: "LCORE",
      label: "hcc-ai-test",
      statuses: ["New", "  "],
    }).success,
    false,
  );
  assert.equal(
    jiraKanban.input.safeParse({
      project: "LCORE",
      label: "hcc-ai-test",
      statuses: ["Open", "In Review"],
    }).success,
    true,
  );
});

test("jira-kanban interrupted_retry_minutes accepts negative whole minutes", () => {
  assert.equal(
    jiraKanban.input.safeParse({
      project: "LCORE",
      label: "hcc-ai-test",
      interrupted_retry_minutes: -1,
    }).success,
    true,
  );
  assert.equal(
    jiraKanban.input.safeParse({
      project: "LCORE",
      label: "hcc-ai-test",
      interrupted_retry_minutes: 1.5,
    }).success,
    false,
  );
});

// --- onboarding input schema ---

test("onboarding rejects blank project values but keeps the REHOR default", () => {
  assert.equal(onboarding.input.safeParse({ label: "rehor-pilot", project: "" }).success, false);
  assert.equal(onboarding.input.safeParse({ label: "rehor-pilot", project: "  " }).success, false);
  assert.deepEqual(onboarding.input.parse({ label: "rehor-pilot" }), {
    label: "rehor-pilot",
    project: "REHOR",
  });
});

test("onboarding label regex rejects blank labels", () => {
  assert.equal(onboarding.input.safeParse({ label: "" }).success, false);
  assert.equal(onboarding.input.safeParse({ label: " " }).success, false);
  assert.equal(onboarding.input.safeParse({ label: "onboarding:intake" }).success, true);
});

// --- validateConfig: invalid values stop the run before it starts ---

test("blank and empty inputs fail config validation with stable messages", () => {
  const result = validateConfig(
    [
      { id: "jira-sprint", with: { label: "   " } },
      { id: "jira-kanban", with: { project: "LCORE", label: "hcc-ai-test", statuses: [] } },
      { id: "onboarding", with: { label: "rehor-pilot", project: "" } },
    ],
    registry,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.invalid, [
    { id: "jira-sprint", messages: ['jira-sprint: invalid parameter "label"'] },
    { id: "jira-kanban", messages: ['jira-kanban: invalid parameter "statuses"'] },
    { id: "onboarding", messages: ['onboarding: invalid parameter "project"'] },
  ]);
});

// --- onboarding triage: full-history classification, bounded rendering ---

test("onboarding feedback buried under many newer comments stays visible in the prompt", async () => {
  // Any unaddressed comment triggers onboarding feedback, so classification
  // is safe on any tail — but the rendered prompt must still show the
  // buried human comment, not just the newest bot noise, and must stay
  // bounded without relying on fmtComments' 30-newest cap (which would drop
  // the oldest unaddressed comment).
  const botStatusComment = (minutes) => ({
    created: `2026-07-01T10:${String(minutes).padStart(2, "0")}:00`,
    body: "### Cycle status\n| step | state |\n| --- | --- |\n| build | ok |",
    author: { displayName: "rehor-bot" },
  });
  const comments = [
    { created: "2026-06-29T09:00:00", body: "earlier note", author: { displayName: "Human" } },
    {
      created: "2026-07-01T09:00:00",
      body: "Please onboard me",
      author: { displayName: "Human" },
    },
    ...Array.from({ length: 35 }, (_unused, index) => botStatusComment(index)),
  ];
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "TEST-ONB",
        last_addressed: "2026-06-30T00:00:00",
        metadata: { step: "requirements" },
      }),
    ],
    issues: {
      "TEST-ONB": {
        fields: { status: { name: "In Progress" }, labels: ["onboarding:requirements"] },
        comments,
      },
    },
  });
  const result = await onboarding.run(ctx, onboarding.input.parse({ label: "rehor-pilot" }));
  assert.equal(result.status, "start");
  assert.match(result.content, /HAS NEW JIRA FEEDBACK/);
  assert.match(result.content, /Please onboard me/);
  // Bounded rendering: the 20 oldest unaddressed comments plus the 10
  // newest — 30 shown, never the 37-comment history, never truncated.
  assert.match(result.content, /jira_comments \(30, newest first\)/);
  assert.doesNotMatch(result.content, /truncated/);
});
