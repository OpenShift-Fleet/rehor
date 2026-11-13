import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflowDefaults } from "../dist/index.js";
import { createPopulatedRegistry } from "../dist/preflights/index.js";

test("populated registry registers the ported preflights", () => {
  const registry = createPopulatedRegistry();
  assert.deepEqual(registry.ids(), [
    "gh-pr-status",
    "gl-mr-status",
    "jira-kanban",
    "jira-sprint",
    "jira-triage",
    "onboarding",
  ]);
  assert.equal(registry.has("gh-pr-status"), true);
  assert.equal(registry.get("gh-pr-status")?.id, "gh-pr-status");
  assert.equal(registry.has("gl-mr-status"), true);
  assert.equal(registry.get("gl-mr-status")?.id, "gl-mr-status");
  assert.notEqual(registry.get("jira-sprint"), undefined);
});

test("gh-pr-status and gl-mr-status register with no required inputs", () => {
  const registry = createPopulatedRegistry();
  for (const id of ["gh-pr-status", "gl-mr-status"]) {
    const preflight = registry.get(id);
    assert.equal(preflight.input.safeParse({}).success, true);
    assert.equal(
      preflight.input.safeParse({ unexpected: 1 }).success,
      false,
      "inputs must fail closed on unknown parameter names",
    );
  }
});

test("workflow defaults validate once every referenced preflight is registered", () => {
  const result = validateWorkflowDefaults(createPopulatedRegistry());
  assert.deepEqual(result, { ok: true });
});
