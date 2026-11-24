import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  createPreflightRegistry,
  definePreflight,
  requiredInputNames,
  validateWorkflowDefaults,
  workflowDefaults,
} from "../dist/index.js";
import { fixtureRegistry, ghPrStatus, glMrStatus, jiraKanban, onboarding } from "./fixtures.mjs";

test("workflowDefaults carries the proposed central mapping as ids only", () => {
  assert.deepEqual(workflowDefaults, { "jira-sprint": ["gh-pr-status", "gl-mr-status"] });
});

test("requiredInputNames lists required keys and omits optional and defaulted keys", () => {
  assert.deepEqual(requiredInputNames(jiraKanban.input), ["project", "label"]);
  assert.deepEqual(requiredInputNames(onboarding.input), ["label"]);
  assert.deepEqual(requiredInputNames(ghPrStatus.input), []);
  assert.deepEqual(
    requiredInputNames(
      z.strictObject({
        required: z.string(),
        optional: z.string().optional(),
        defaulted: z.array(z.string()).default([]),
      }),
    ),
    ["required"],
  );
});

test("requiredInputNames rejects non-object schemas", () => {
  assert.throws(() => requiredInputNames(z.string()), /Zod object schema/);
});

test("the central defaults validate against a registry that registers them", () => {
  assert.deepEqual(validateWorkflowDefaults(fixtureRegistry), { ok: true });
});

test("a default set referencing an unregistered id fails", () => {
  const partial = createPreflightRegistry([ghPrStatus, onboarding]);
  assert.deepEqual(validateWorkflowDefaults(partial), {
    ok: false,
    errors: ['jira-sprint: default set references unknown preflight id "gl-mr-status"'],
  });
});

test("a default set referencing a required-input preflight fails", () => {
  const result = validateWorkflowDefaults(fixtureRegistry, { custom: ["jira-kanban"] });
  assert.deepEqual(result, {
    ok: false,
    errors: [
      'custom: default set includes "jira-kanban" with required input "project", "label"; ' +
        "defaults may only include preflights with no required inputs",
    ],
  });
});

test("every failing workflow and id is reported", () => {
  const result = validateWorkflowDefaults(fixtureRegistry, {
    "workflow-a": ["missing-id", "jira-kanban"],
    "workflow-b": ["onboarding"],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    'workflow-a: default set references unknown preflight id "missing-id"',
    'workflow-a: default set includes "jira-kanban" with required input "project", "label"; ' +
      "defaults may only include preflights with no required inputs",
    'workflow-b: default set includes "onboarding" with required input "label"; ' +
      "defaults may only include preflights with no required inputs",
  ]);
});

test("an empty defaults mapping is valid", () => {
  assert.deepEqual(validateWorkflowDefaults(fixtureRegistry, {}), { ok: true });
  assert.deepEqual(validateWorkflowDefaults(createPreflightRegistry([glMrStatus]), {}), {
    ok: true,
  });
});

// --- root refinements on the input schema ---

/** Every field optional, but the schema as a whole rejects `{}`. */
const eitherOr = definePreflight({
  id: "either-or",
  input: z
    .strictObject({ a: z.string().optional(), b: z.string().optional() })
    .refine((params) => params.a !== undefined || params.b !== undefined),
  run: async () => ({ status: "skip", content: "fixture" }),
});

test("requiredInputNames lists no fields for an all-optional root-refined schema", () => {
  // Per-field requiredness is unchanged: a, b are each individually optional
  // — the constraint only exists at the whole-map level.
  assert.deepEqual(requiredInputNames(eitherOr.input), []);
});

test("a default set referencing a preflight whose schema rejects empty parameters fails", () => {
  // An inherited default is applied with an empty `with:` map; a schema whose
  // root refinement rejects {} can never resolve that, so it must be
  // rejected up front with a stable diagnostic.
  const registry = createPreflightRegistry([eitherOr]);
  assert.deepEqual(validateWorkflowDefaults(registry, { custom: ["either-or"] }), {
    ok: false,
    errors: [
      'custom: default set includes "either-or" whose input schema rejects an empty parameter map; ' +
        "defaults may only include preflights with no required inputs",
    ],
  });
});

test("a default set referencing a preflight that accepts an empty parameter map stays valid", () => {
  const allOptional = definePreflight({
    id: "all-optional",
    input: z
      .strictObject({ a: z.string().optional() })
      .refine((params) => params.a === undefined || params.a.length <= 3),
    run: async () => ({ status: "skip", content: "fixture" }),
  });
  const registry = createPreflightRegistry([allOptional]);
  assert.deepEqual(validateWorkflowDefaults(registry, { custom: ["all-optional"] }), {
    ok: true,
  });
});
