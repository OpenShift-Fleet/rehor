import assert from "node:assert/strict";
import test from "node:test";
import { literalValueSchema, objectEntrySchema, preflightEntrySchema } from "../dist/core/entry.js";

test("literal values accept strings, numbers, booleans, and nested lists of those", () => {
  for (const value of ["s", "", 0, 5, -1.5, true, false, [], [1, "a", true], [[["deep"]], 2]]) {
    assert.equal(
      literalValueSchema.safeParse(value).success,
      true,
      `expected literal: ${JSON.stringify(value)}`,
    );
  }
});

test("literal values reject objects, null, undefined, and NaN — no interpolation", () => {
  for (const value of [
    null,
    undefined,
    NaN,
    {},
    { a: 1 },
    [{}],
    [null],
    [{ nested: true }],
    [NaN],
  ]) {
    assert.equal(
      literalValueSchema.safeParse(value).success,
      false,
      `expected rejection: ${JSON.stringify(value)}`,
    );
  }
});

test("entry shape accepts a shorthand string, with or without parameters", () => {
  assert.equal(preflightEntrySchema.safeParse("gh-pr-status").success, true);
  assert.deepEqual(preflightEntrySchema.safeParse("gh-pr-status").data, "gh-pr-status");
  assert.equal(preflightEntrySchema.safeParse({ id: "jira-kanban" }).success, true);
  assert.equal(preflightEntrySchema.safeParse({ id: "jira-kanban", with: {} }).success, true);
  assert.equal(
    preflightEntrySchema.safeParse({
      id: "jira-kanban",
      with: { project: "REHOR", statuses: ["New"] },
    }).success,
    true,
  );
  assert.deepEqual(
    preflightEntrySchema.safeParse({ id: "jira-kanban", with: { n: 1, b: [true, "x"] } }).data,
    {
      id: "jira-kanban",
      with: { n: 1, b: [true, "x"] },
    },
  );
});

test("entry shape rejects malformed entries fail-closed", () => {
  const malformed = [
    "",
    42,
    null,
    true,
    [],
    ["gh-pr-status"],
    { with: { a: 1 } },
    { id: 5 },
    { id: "" },
    { id: "x", extra: 1 },
    { id: "x", with: 5 },
    { id: "x", with: [] },
    { id: "x", with: { param: { nested: true } } },
    { id: "x", with: { param: null } },
    { id: "x", with: { param: undefined } },
  ];
  for (const value of malformed) {
    assert.equal(
      preflightEntrySchema.safeParse(value).success,
      false,
      `expected rejection: ${JSON.stringify(value)}`,
    );
  }
});

test("reserved with keys are rejected fail-closed, including an own __proto__ key", () => {
  // JSON.parse produces a real own `__proto__` data property, the same shape
  // strict YAML parsers hand the dispatcher. Zod's record parsing silently
  // drops such keys (never validating their values), so the entry schema
  // itself must refuse them before that erasure.
  const cases = [
    JSON.parse('{"id":"x","with":{"__proto__":null}}'),
    JSON.parse('{"id":"x","with":{"__proto__":5}}'),
    JSON.parse('{"id":"x","with":{"__proto__":[]}}'),
    JSON.parse('{"id":"x","with":{"__proto__":{"a":1}}}'),
    JSON.parse('{"id":"x","with":{"constructor":"y"}}'),
    JSON.parse('{"id":"x","with":{"prototype":1}}'),
  ];
  for (const value of cases) {
    assert.equal(
      preflightEntrySchema.safeParse(value).success,
      false,
      `expected rejection: ${JSON.stringify(value)}`,
    );
    assert.equal(
      objectEntrySchema.safeParse(value).success,
      false,
      `expected rejection: ${JSON.stringify(value)}`,
    );
  }
});

test("non-reserved with keys that collide with inherited property names remain plain literal data", () => {
  const parsed = objectEntrySchema.safeParse(
    JSON.parse('{"id":"x","with":{"toString":"s","valueOf":1,"hasOwnProperty":true}}'),
  );
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data.with, { toString: "s", valueOf: 1, hasOwnProperty: true });
});
