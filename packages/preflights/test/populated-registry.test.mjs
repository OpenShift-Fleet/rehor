import assert from "node:assert/strict";
import test from "node:test";
import { requiredInputNames, validateConfig } from "../dist/index.js";
import { createPopulatedRegistry } from "../dist/preflights/index.js";

const registry = createPopulatedRegistry();

test("populated registry registers every landed preflight", () => {
  assert.deepEqual(registry.ids(), [
    "gh-pr-status",
    "gl-mr-status",
    "hcc-merged-pr-violations",
    "hcc-test-anti-pattern-scan",
    "hcc-weekly-report",
    "jira-kanban",
    "jira-sprint",
    "jira-triage",
    "onboarding",
  ]);
});

test("required inputs match the spike doc's parameter mapping", () => {
  assert.deepEqual(requiredInputNames(registry.get("jira-sprint").input), ["label"]);
  assert.deepEqual(requiredInputNames(registry.get("jira-kanban").input), ["project", "label"]);
  assert.deepEqual(requiredInputNames(registry.get("jira-triage").input), []);
  assert.deepEqual(requiredInputNames(registry.get("onboarding").input), ["label"]);
  assert.deepEqual(requiredInputNames(registry.get("gl-mr-status").input), []);
  assert.deepEqual(requiredInputNames(registry.get("gh-pr-status").input), []);
  assert.deepEqual(requiredInputNames(registry.get("hcc-merged-pr-violations").input), []);
  assert.deepEqual(requiredInputNames(registry.get("hcc-test-anti-pattern-scan").input), [
    "scan_only_repos",
  ]);
  assert.deepEqual(requiredInputNames(registry.get("hcc-weekly-report").input), ["repo"]);
});

test("hcc preflights apply their documented defaults and fail closed on missing required inputs", () => {
  const weekly = validateConfig(
    [{ id: "hcc-weekly-report", with: { repo: "RedHatInsights/weekly-status" } }],
    registry,
  );
  assert.equal(weekly.ok, true);
  assert.deepEqual(weekly.entries, [
    {
      id: "hcc-weekly-report",
      params: {
        repo: "RedHatInsights/weekly-status",
        branch_pattern: "hcc-team-weekly-report",
        merge_hour_utc: 10,
      },
    },
  ]);

  const violations = validateConfig(["hcc-merged-pr-violations"], registry);
  assert.equal(violations.ok, true);
  assert.deepEqual(violations.entries, [
    {
      id: "hcc-merged-pr-violations",
      params: {
        lookback_hours: 24,
        max_concurrent: 5,
        max_prs_per_repo: 50,
        task_prefix: "merge-violations",
      },
    },
  ]);

  // The test scan requires its whitelist, so shorthand fails closed.
  const scan = validateConfig(["hcc-test-anti-pattern-scan"], registry);
  assert.equal(scan.ok, false);
  assert.deepEqual(scan.invalid, [
    {
      id: "hcc-test-anti-pattern-scan",
      messages: ['hcc-test-anti-pattern-scan: missing required parameter "scan_only_repos"'],
    },
  ]);

  const scanExplicit = validateConfig(
    [{ id: "hcc-test-anti-pattern-scan", with: { scan_only_repos: ["repo-a"] } }],
    registry,
  );
  assert.equal(scanExplicit.ok, true);
  assert.deepEqual(scanExplicit.entries[0].params.task_prefix, "test-scan");
  assert.deepEqual(scanExplicit.entries[0].params.patterns, ["**/*.spec.ts", "**/*.test.ts"]);
  assert.deepEqual(scanExplicit.entries[0].params.exclude_substrings, [
    "node_modules/",
    "dist/",
    "build/",
    ".playwright/",
    "playwright-report/",
    "test-results/",
  ]);
});

test("jira-triage shorthand entries validate; required-input preflights fail closed", () => {
  const shorthand = validateConfig(["jira-triage"], registry);
  assert.equal(shorthand.ok, true);
  assert.deepEqual(shorthand.entries, [
    { id: "jira-triage", params: { interrupted_retry_minutes: 30 } },
  ]);

  const missingLabel = validateConfig(["jira-sprint"], registry);
  assert.equal(missingLabel.ok, false);
  assert.deepEqual(missingLabel.invalid, [
    { id: "jira-sprint", messages: ['jira-sprint: missing required parameter "label"'] },
  ]);
});

test("gl-mr-status shorthand entries apply the documented default", () => {
  const result = validateConfig(["gl-mr-status"], registry);
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries, [
    { id: "gl-mr-status", params: { suppress_terminal_if_addressed: false } },
  ]);

  const explicit = validateConfig(
    [{ id: "gl-mr-status", with: { suppress_terminal_if_addressed: true } }],
    registry,
  );
  assert.equal(explicit.ok, true);
  assert.deepEqual(explicit.entries, [
    { id: "gl-mr-status", params: { suppress_terminal_if_addressed: true } },
  ]);
});

test("gh-pr-status shorthand entries apply the documented default", () => {
  const result = validateConfig(["gh-pr-status"], registry);
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries, [
    { id: "gh-pr-status", params: { suppress_terminal_if_addressed: false } },
  ]);

  const explicit = validateConfig(
    [{ id: "gh-pr-status", with: { suppress_terminal_if_addressed: true } }],
    registry,
  );
  assert.equal(explicit.ok, true);
  assert.deepEqual(explicit.entries, [
    { id: "gh-pr-status", params: { suppress_terminal_if_addressed: true } },
  ]);
});

test("the spike doc's invalid example reports every failing entry", () => {
  const result = validateConfig(
    ["jira-kanban", "gh-pr-statuss", { id: "onboarding", with: { labels: "rehor-pilot" } }],
    registry,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.invalid, [
    {
      id: "jira-kanban",
      messages: [
        'jira-kanban: missing required parameter "project"',
        'jira-kanban: missing required parameter "label"',
      ],
    },
    { id: "gh-pr-statuss", messages: ["gh-pr-statuss: unknown preflight id"] },
    {
      id: "onboarding",
      messages: [
        'onboarding: unknown parameter "labels"',
        'onboarding: missing required parameter "label"',
      ],
    },
  ]);
});

test("optional parameters apply their documented defaults", () => {
  const result = validateConfig(
    [{ id: "jira-kanban", with: { project: "REHOR", label: "rehor-pilot" } }],
    registry,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries, [
    {
      id: "jira-kanban",
      params: {
        project: "REHOR",
        label: "rehor-pilot",
        statuses: ["New", "Backlog", "To Do"],
        interrupted_retry_minutes: 30,
      },
    },
  ]);

  const sprint = validateConfig([{ id: "jira-sprint", with: { label: "rehor-pilot" } }], registry);
  assert.deepEqual(sprint.entries, [
    {
      id: "jira-sprint",
      params: { label: "rehor-pilot", include_backlog: false, interrupted_retry_minutes: 30 },
    },
  ]);

  const onboarding = validateConfig(
    [{ id: "onboarding", with: { label: "rehor-pilot" } }],
    registry,
  );
  assert.deepEqual(onboarding.entries, [
    { id: "onboarding", params: { label: "rehor-pilot", project: "REHOR" } },
  ]);
});

test("onboarding rejects labels outside the ported character set", () => {
  const result = validateConfig([{ id: "onboarding", with: { label: "bad label!" } }], registry);
  assert.equal(result.ok, false);
  assert.deepEqual(result.invalid, [
    { id: "onboarding", messages: ['onboarding: invalid parameter "label"'] },
  ]);
});
