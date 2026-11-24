import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createPreflightRegistry, definePreflight, validateConfig } from "../dist/index.js";
import { fixtureRegistry } from "./fixtures.mjs";

test("a valid mixed list resolves every entry with parsed params and defaults applied", () => {
  const result = validateConfig(
    [
      "gh-pr-status",
      {
        id: "jira-kanban",
        with: { project: "REHOR", label: "rehor-pilot" },
      },
      { id: "onboarding", with: { label: "rehor-pilot" } },
      { id: "gh-pr-status" },
    ],
    fixtureRegistry,
  );
  assert.deepEqual(result, {
    ok: true,
    entries: [
      { id: "gh-pr-status", params: {} },
      {
        id: "jira-kanban",
        params: {
          project: "REHOR",
          label: "rehor-pilot",
          statuses: ["New", "Backlog", "To Do"],
          interrupted_retry_minutes: 30,
        },
      },
      { id: "onboarding", params: { label: "rehor-pilot" } },
      { id: "gh-pr-status", params: {} },
    ],
  });
});

test("an empty list is valid and means no preflights", () => {
  assert.deepEqual(validateConfig([], fixtureRegistry), { ok: true, entries: [] });
});

test("a non-list preflights value is invalid", () => {
  for (const value of ["jira-kanban", { 0: "jira-kanban" }, null, 42]) {
    assert.deepEqual(validateConfig(value, fixtureRegistry), {
      ok: false,
      invalid: [{ id: null, messages: ["preflights: expected a list of preflight entries"] }],
    });
  }
});

test("unknown preflight ids fail closed, in shorthand and object form", () => {
  for (const entry of [
    "gh-pr-statuss",
    { id: "gh-pr-statuss" },
    { id: "gh-pr-statuss", with: {} },
  ]) {
    assert.deepEqual(validateConfig([entry], fixtureRegistry), {
      ok: false,
      invalid: [{ id: "gh-pr-statuss", messages: ["gh-pr-statuss: unknown preflight id"] }],
    });
  }
});

test("shorthand for a preflight with required inputs reports every missing parameter", () => {
  assert.deepEqual(validateConfig(["jira-kanban"], fixtureRegistry), {
    ok: false,
    invalid: [
      {
        id: "jira-kanban",
        messages: [
          'jira-kanban: missing required parameter "project"',
          'jira-kanban: missing required parameter "label"',
        ],
      },
    ],
  });
});

test("a parameterized entry missing required inputs reports only what is missing", () => {
  assert.deepEqual(
    validateConfig([{ id: "jira-kanban", with: { project: "REHOR" } }], fixtureRegistry),
    {
      ok: false,
      invalid: [
        {
          id: "jira-kanban",
          messages: ['jira-kanban: missing required parameter "label"'],
        },
      ],
    },
  );
});

test("unknown parameter names fail closed", () => {
  // The entry also misses the required `label` it should have used — every
  // issue in the entry is reported.
  assert.deepEqual(
    validateConfig([{ id: "onboarding", with: { labels: "rehor-pilot" } }], fixtureRegistry),
    {
      ok: false,
      invalid: [
        {
          id: "onboarding",
          messages: [
            'onboarding: unknown parameter "labels"',
            'onboarding: missing required parameter "label"',
          ],
        },
      ],
    },
  );
});

test("unknown and missing parameters in one entry are all reported", () => {
  assert.deepEqual(
    validateConfig([{ id: "jira-kanban", with: { labels: "x" } }], fixtureRegistry),
    {
      ok: false,
      invalid: [
        {
          id: "jira-kanban",
          messages: [
            'jira-kanban: unknown parameter "labels"',
            'jira-kanban: missing required parameter "project"',
            'jira-kanban: missing required parameter "label"',
          ],
        },
      ],
    },
  );
});

test("values that fail the input schema are invalid parameters", () => {
  assert.deepEqual(
    validateConfig(
      [{ id: "jira-kanban", with: { project: "REHOR", label: "x", statuses: 5 } }],
      fixtureRegistry,
    ),
    {
      ok: false,
      invalid: [{ id: "jira-kanban", messages: ['jira-kanban: invalid parameter "statuses"'] }],
    },
  );
  // A bad element inside a list value reports the parameter once.
  assert.deepEqual(
    validateConfig(
      [{ id: "jira-kanban", with: { project: "REHOR", label: "x", statuses: ["New", 5] } }],
      fixtureRegistry,
    ),
    {
      ok: false,
      invalid: [{ id: "jira-kanban", messages: ['jira-kanban: invalid parameter "statuses"'] }],
    },
  );
});

test("non-literal with values are invalid parameters, never interpolated", () => {
  assert.deepEqual(
    validateConfig([{ id: "onboarding", with: { label: { deep: true } } }], fixtureRegistry),
    {
      ok: false,
      invalid: [{ id: "onboarding", messages: ['onboarding: invalid parameter "label"'] }],
    },
  );
  assert.deepEqual(validateConfig([{ id: "onboarding", with: { label: null } }], fixtureRegistry), {
    ok: false,
    invalid: [{ id: "onboarding", messages: ['onboarding: invalid parameter "label"'] }],
  });
});

test("malformed entries fail closed with a positional message when no id is recoverable", () => {
  assert.deepEqual(validateConfig([42], fixtureRegistry), {
    ok: false,
    invalid: [{ id: null, messages: ["entry 1: malformed preflight entry"] }],
  });
  assert.deepEqual(validateConfig(["gh-pr-status", null], fixtureRegistry), {
    ok: false,
    invalid: [{ id: null, messages: ["entry 2: malformed preflight entry"] }],
  });
  assert.deepEqual(validateConfig([[]], fixtureRegistry), {
    ok: false,
    invalid: [{ id: null, messages: ["entry 1: malformed preflight entry"] }],
  });
  assert.deepEqual(validateConfig([""], fixtureRegistry), {
    ok: false,
    invalid: [{ id: null, messages: ["entry 1: malformed preflight entry"] }],
  });
  assert.deepEqual(validateConfig([{ with: { a: 1 } }], fixtureRegistry), {
    ok: false,
    invalid: [{ id: null, messages: ["entry 1: malformed preflight entry"] }],
  });
});

test("malformed object entries with a recoverable id report that id", () => {
  assert.deepEqual(validateConfig([{ id: "gh-pr-status", extra: 1 }], fixtureRegistry), {
    ok: false,
    invalid: [{ id: "gh-pr-status", messages: ["gh-pr-status: malformed preflight entry"] }],
  });
  assert.deepEqual(validateConfig([{ id: "gh-pr-status", with: 5 }], fixtureRegistry), {
    ok: false,
    invalid: [{ id: "gh-pr-status", messages: ["gh-pr-status: malformed preflight entry"] }],
  });
});

test("the spike doc's invalid example reports every failing entry with stable messages", () => {
  const result = validateConfig(
    ["jira-kanban", "gh-pr-statuss", { id: "onboarding", with: { labels: "rehor-pilot" } }],
    fixtureRegistry,
  );
  assert.deepEqual(result, {
    ok: false,
    invalid: [
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
    ],
  });
  // Raw Zod error text never reaches the message surface.
  const text = JSON.stringify(result.invalid);
  assert.equal(text.includes("Invalid input"), false);
  assert.equal(text.includes("expected string"), false);
  assert.equal(text.includes("Unrecognized key"), false);
});

test("one invalid entry fails the whole list — no partial execution", () => {
  const result = validateConfig(
    ["gh-pr-status", { id: "onboarding", with: { labels: "x" } }],
    fixtureRegistry,
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.invalid, [
    {
      id: "onboarding",
      messages: [
        'onboarding: unknown parameter "labels"',
        'onboarding: missing required parameter "label"',
      ],
    },
  ]);
});

// --- root refinements (whole-`with:`-map constraints) ---

/** All-optional fields plus a root refinement across them. */
const eitherOr = definePreflight({
  id: "either-or",
  input: z
    .strictObject({ a: z.string().optional(), b: z.string().optional() })
    .refine((params) => params.a !== undefined || params.b !== undefined),
  run: async () => ({ status: "skip", content: "fixture" }),
});
const eitherOrRegistry = createPreflightRegistry([eitherOr]);

test("a root refinement that passes resolves the entry normally", () => {
  const result = validateConfig([{ id: "either-or", with: { a: "x" } }], eitherOrRegistry);
  assert.deepEqual(result, { ok: true, entries: [{ id: "either-or", params: { a: "x" } }] });
});

test("a failing root refinement fails closed with a stable entry-level message", () => {
  const result = validateConfig([{ id: "either-or", with: {} }], eitherOrRegistry);
  assert.deepEqual(result, {
    ok: false,
    invalid: [{ id: "either-or", messages: ["either-or: invalid parameters"] }],
  });
});

test("a failing root refinement never resolves entries — no ok:true with undefined params", () => {
  for (const entry of ["either-or", { id: "either-or" }, { id: "either-or", with: {} }]) {
    const result = validateConfig([entry], eitherOrRegistry);
    assert.equal(result.ok, false, `entry ${JSON.stringify(entry)} must fail closed`);
    assert.equal("entries" in result, false);
    assert.deepEqual(result.invalid, [
      { id: "either-or", messages: ["either-or: invalid parameters"] },
    ]);
  }
});

test("a root refinement failure is reported alongside unknown-parameter messages", () => {
  // A non-strict object schema strips unknown keys instead of failing on
  // them, so the base parse succeeds and the root refinement is the Zod
  // failure — the raw unknown key is still reported from the pre-parse scan.
  const stripUnknown = definePreflight({
    id: "strip-unknown",
    input: z.object({ a: z.string().optional() }).refine((params) => params.a !== undefined),
    run: async () => ({ status: "skip", content: "fixture" }),
  });
  const registry = createPreflightRegistry([stripUnknown]);
  const result = validateConfig([{ id: "strip-unknown", with: { extra: 1 } }], registry);
  assert.deepEqual(result, {
    ok: false,
    invalid: [
      {
        id: "strip-unknown",
        messages: ['strip-unknown: unknown parameter "extra"', "strip-unknown: invalid parameters"],
      },
    ],
  });
});

// --- reserved `with:` keys (own `__proto__` from strict YAML/JSON parsers) ---

test("own reserved with keys from strict YAML/JSON parsers fail closed as invalid parameters", () => {
  // JSON.parse keeps `__proto__` as an own key; Zod's record parsing drops
  // that key silently, so it must be caught on the raw key map before the
  // record schema erases the evidence.
  const cases = [
    [
      '{"id":"gh-pr-status","with":{"__proto__":null}}',
      'gh-pr-status: invalid parameter "__proto__"',
    ],
    ['{"id":"gh-pr-status","with":{"__proto__":5}}', 'gh-pr-status: invalid parameter "__proto__"'],
    [
      '{"id":"gh-pr-status","with":{"__proto__":["x"]}}',
      'gh-pr-status: invalid parameter "__proto__"',
    ],
    [
      '{"id":"gh-pr-status","with":{"constructor":"y"}}',
      'gh-pr-status: invalid parameter "constructor"',
    ],
    ['{"id":"gh-pr-status","with":{"prototype":1}}', 'gh-pr-status: invalid parameter "prototype"'],
  ];
  for (const [json, message] of cases) {
    const result = validateConfig([JSON.parse(json)], fixtureRegistry);
    assert.deepEqual(
      result,
      { ok: false, invalid: [{ id: "gh-pr-status", messages: [message] }] },
      json,
    );
  }
});

test("a reserved with key fails the whole entry even alongside otherwise-valid parameters", () => {
  const result = validateConfig(
    [JSON.parse('{"id":"onboarding","with":{"label":"x","__proto__":null}}')],
    fixtureRegistry,
  );
  assert.equal(result.ok, false);
  assert.equal("entries" in result, false);
  assert.deepEqual(result.invalid, [
    { id: "onboarding", messages: ['onboarding: invalid parameter "__proto__"'] },
  ]);
});

test("non-reserved keys colliding with inherited property names stay ordinary unknown parameters", () => {
  const result = validateConfig([{ id: "gh-pr-status", with: { toString: "s" } }], fixtureRegistry);
  assert.deepEqual(result, {
    ok: false,
    invalid: [{ id: "gh-pr-status", messages: ['gh-pr-status: unknown parameter "toString"'] }],
  });
});
