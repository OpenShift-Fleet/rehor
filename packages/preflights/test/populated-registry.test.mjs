import assert from "node:assert/strict";
import test from "node:test";
import { requiredInputNames, validateConfig } from "../dist/index.js";
import { createPopulatedRegistry } from "../dist/preflights/index.js";

const registry = createPopulatedRegistry();

test("populated registry registers every landed preflight", () => {
  assert.deepEqual(registry.ids(), [
    "fabric-konflux-bot-prs",
    "fabric-pr-label",
    "fabric-project-state",
    "fabric-review-queue",
    "gh-pr-status",
    "gl-mr-status",
    "hcc-merged-pr-violations",
    "hcc-quality-jira-feedback",
    "hcc-test-anti-pattern-scan",
    "hcc-weekly-report",
    "jira-kanban",
    "jira-sprint",
    "jira-triage",
    "obsint-backlog-scan",
    "obsint-cve-ci-review",
    "obsint-cve-scan",
    "obsint-jenkins-status",
    "obsint-mintmaker-prs",
    "obsint-weekly-status-update",
    "onboarding",
    "renovate-discover",
    "renovate-pr-status",
  ]);
});

test("required inputs match the spike doc's parameter mapping", () => {
  assert.deepEqual(requiredInputNames(registry.get("jira-sprint").input), ["label"]);
  assert.deepEqual(requiredInputNames(registry.get("jira-kanban").input), ["project", "label"]);
  assert.deepEqual(requiredInputNames(registry.get("jira-triage").input), []);
  assert.deepEqual(requiredInputNames(registry.get("onboarding").input), ["label"]);
  assert.deepEqual(requiredInputNames(registry.get("gl-mr-status").input), []);
  assert.deepEqual(requiredInputNames(registry.get("gh-pr-status").input), []);
  assert.deepEqual(requiredInputNames(registry.get("renovate-discover").input), []);
  assert.deepEqual(requiredInputNames(registry.get("renovate-pr-status").input), []);
});

test("fabric-project-state validates the flattened coordinator inputs", () => {
  const id = "fabric-project-state";
  const params = {
    controlLabel: "dev-bot-coordinator",
    teamFieldId: "customfield_10001",
    implementationLabel: "hcc-ai-platform-accessmanagement",
    project: "RHCLOUD",
    includeBacklog: true,
  };
  const result = validateConfig([{ id, with: params }], registry);
  assert.equal(result.ok, true);
  assert.deepEqual(result.entries, [{ id, params }]);
  assert.equal(validateConfig([id], registry).ok, false);
});

test("HCC registry validates shorthand only for preflights without required inputs", () => {
  const shorthand = validateConfig(
    ["hcc-merged-pr-violations", "hcc-quality-jira-feedback"],
    registry,
  );
  assert.equal(shorthand.ok, true);
  const explicit = [
    { id: "hcc-test-anti-pattern-scan", with: { scan_only_repos: ["repo-a"] } },
    { id: "hcc-weekly-report", with: { repo: "RedHatInsights/weekly-status" } },
  ];
  const missing = validateConfig(
    explicit.map(({ id }) => id),
    registry,
  );
  assert.equal(missing.ok, false);
  assert.deepEqual(
    missing.invalid.map(({ id }) => id),
    explicit.map(({ id }) => id),
  );
  assert.equal(validateConfig(explicit, registry).ok, true);
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
