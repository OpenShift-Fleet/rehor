import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  createPreflightRegistry,
  definePreflight,
  deferredParameterIssues,
  validateConfig,
  validateResolvedParams,
} from "../dist/index.js";
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

// --- deferred placeholder validation and post-render re-validation ---

// Assembled so the literal never looks like a JavaScript template placeholder
// to formatters and linters.
const placeholder = "$" + "{{ secret('team-settings', 'field') }}";
const isPlaceholder = (value) => typeof value === "string" && value.includes("${{");
const fielded = definePreflight({
  id: "fielded",
  input: z.strictObject({
    teamFieldId: z.string().regex(/^customfield_\d+$/),
    limit: z.number().optional(),
  }),
});

test("deferValue defers only value-level checks on marked placeholder strings", () => {
  const result = validateConfig(
    [{ id: "fielded", with: { teamFieldId: placeholder } }],
    createPreflightRegistry([fielded]),
    { deferValue: isPlaceholder },
  );
  assert.deepEqual(result, {
    ok: true,
    entries: [{ id: "fielded", params: { teamFieldId: placeholder } }],
  });
});

test("the same placeholder fails closed without a deferValue predicate", () => {
  const result = validateConfig(
    [{ id: "fielded", with: { teamFieldId: placeholder } }],
    createPreflightRegistry([fielded]),
  );
  assert.deepEqual(result, {
    ok: false,
    invalid: [{ id: "fielded", messages: ['fielded: invalid parameter "teamFieldId"'] }],
  });
});

test("type mismatches are never deferred: a placeholder string in a number parameter fails closed", () => {
  const numeric = definePreflight({ id: "numeric", input: z.strictObject({ limit: z.number() }) });
  const result = validateConfig(
    [{ id: "numeric", with: { limit: placeholder } }],
    createPreflightRegistry([numeric]),
    { deferValue: isPlaceholder },
  );
  assert.deepEqual(result, {
    ok: false,
    invalid: [{ id: "numeric", messages: ['numeric: invalid parameter "limit"'] }],
  });
});

test("structural checks never defer: unknown parameters, missing parameters, unknown ids", () => {
  const registry = createPreflightRegistry([fielded]);
  for (const [entry, message] of [
    [
      { id: "fielded", with: { teamFieldId: placeholder, extra: "x" } },
      'fielded: unknown parameter "extra"',
    ],
    [{ id: "fielded" }, 'fielded: missing required parameter "teamFieldId"'],
    [{ id: "nope", with: { teamFieldId: placeholder } }, "nope: unknown preflight id"],
  ]) {
    const result = validateConfig([entry], registry, { deferValue: isPlaceholder });
    assert.equal(result.ok, false, JSON.stringify(entry));
    assert.ok(result.invalid[0].messages.includes(message), JSON.stringify(result.invalid));
  }
});

test("validateResolvedParams accepts a rendered map, applies defaults, and reports invalid values", () => {
  const defaulted = definePreflight({
    id: "defaulted",
    input: z.strictObject({
      teamFieldId: z.string().regex(/^customfield_\d+$/),
      flag: z.boolean().default(false),
    }),
  });
  const ok = validateResolvedParams(defaulted, { teamFieldId: "customfield_123" });
  assert.deepEqual(ok, { ok: true, params: { teamFieldId: "customfield_123", flag: false } });
  const invalid = validateResolvedParams(defaulted, { teamFieldId: "not-a-field", flag: true });
  assert.deepEqual(invalid, {
    ok: false,
    messages: ['defaulted: invalid parameter "teamFieldId"'],
  });
});

// --- invocation-count contract for deferred (placeholder-bearing) entries ---

test("deferred entries never invoke schema callbacks on declarations; the single parse runs post-render", () => {
  let transforms = 0;
  let refines = 0;
  const refineInputs = [];
  const counted = definePreflight({
    id: "counted",
    input: z.strictObject({
      teamFieldId: z.string().regex(/^customfield_\d+$/),
      label: z.string().transform((value) => {
        transforms += 1;
        return `[${value}]`;
      }),
    }).refine((value) => {
      refines += 1;
      refineInputs.push(value);
      return true;
    }),
  });
  const registry = createPreflightRegistry([counted]);
  const result = validateConfig(
    [{ id: "counted", with: { teamFieldId: placeholder, label: "plain" } }],
    registry,
    { deferValue: isPlaceholder },
  );
  assert.deepEqual(result, {
    ok: true,
    entries: [{ id: "counted", params: { teamFieldId: placeholder, label: "plain" } }],
  });
  assert.equal(transforms, 0, "transform ran on the declaration");
  assert.equal(refines, 0, "refinement ran on the declaration");
  // The single invocation happens post-render, on the rendered map; the
  // refinement observes rendered values only, never the placeholder.
  const resolved = validateResolvedParams(counted, { teamFieldId: "customfield_5", label: "plain" });
  assert.deepEqual(resolved, { ok: true, params: { teamFieldId: "customfield_5", label: "[plain]" } });
  assert.equal(transforms, 1);
  assert.equal(refines, 1);
  assert.deepEqual(refineInputs, [{ teamFieldId: "customfield_5", label: "[plain]" }]);
});

test("literal-only entries still parse exactly once, in validateConfig", () => {
  let parses = 0;
  const counted = definePreflight({
    id: "counted",
    input: z.strictObject({ label: z.string().transform((value) => { parses += 1; return value; }) }),
  });
  const result = validateConfig([{ id: "counted", with: { label: "x" } }], createPreflightRegistry([counted]));
  assert.deepEqual(result, { ok: true, entries: [{ id: "counted", params: { label: "x" } }] });
  assert.equal(parses, 1);
});

test("whole-map refinements apply to rendered values, not declarations", () => {
  const seen = [];
  const refined = definePreflight({
    id: "refined",
    input: z.strictObject({ teamFieldId: z.string() }).refine((value) => {
      seen.push(value.teamFieldId);
      return /^customfield_\d+$/.test(value.teamFieldId);
    }, { message: "team field must be a customfield id" }),
  });
  const registry = createPreflightRegistry([refined]);
  const deferred = validateConfig([{ id: "refined", with: { teamFieldId: placeholder } }], registry, { deferValue: isPlaceholder });
  assert.deepEqual(deferred, { ok: true, entries: [{ id: "refined", params: { teamFieldId: placeholder } }] });
  assert.deepEqual(seen, [], "refinement observed the declaration");
  const good = validateResolvedParams(refined, { teamFieldId: "customfield_9" });
  assert.deepEqual(good, { ok: true, params: { teamFieldId: "customfield_9" } });
  assert.deepEqual(seen, ["customfield_9"]);
  const bad = validateResolvedParams(refined, { teamFieldId: "not-a-field" });
  assert.deepEqual(bad, { ok: false, messages: ["refined: invalid parameters"] });
  assert.deepEqual(seen, ["customfield_9", "not-a-field"]);
});

test("structurally optional parameters may be absent from deferred entries; defaults apply post-render", () => {
  const defaulted = definePreflight({
    id: "defaulted",
    input: z.strictObject({
      teamFieldId: z.string().regex(/^customfield_\d+$/),
      flag: z.boolean().default(false),
      maybe: z.string().optional(),
    }),
  });
  const registry = createPreflightRegistry([defaulted]);
  const result = validateConfig([{ id: "defaulted", with: { teamFieldId: placeholder } }], registry, { deferValue: isPlaceholder });
  assert.deepEqual(result, { ok: true, entries: [{ id: "defaulted", params: { teamFieldId: placeholder } }] });
  const resolved = validateResolvedParams(defaulted, { teamFieldId: "customfield_1" });
  assert.equal(resolved.ok, true);
  assert.deepEqual(
    { ...resolved.params, maybe: "maybe" in resolved.params ? resolved.params.maybe : "absent" },
    { teamFieldId: "customfield_1", flag: false, maybe: "absent" },
  );
});

test("placeholders defer in fields that can accept strings, including unions and enums", () => {
  const unioned = definePreflight({ id: "unioned", input: z.strictObject({ value: z.union([z.string(), z.number()]) }) });
  const enumerated = definePreflight({ id: "enumerated", input: z.strictObject({ mode: z.enum(["a", "b"]) }) });
  const registry = createPreflightRegistry([unioned, enumerated]);
  assert.deepEqual(
    validateConfig([{ id: "unioned", with: { value: placeholder } }], registry, { deferValue: isPlaceholder }),
    { ok: true, entries: [{ id: "unioned", params: { value: placeholder } }] },
  );
  assert.deepEqual(
    validateConfig([{ id: "enumerated", with: { mode: placeholder } }], registry, { deferValue: isPlaceholder }),
    { ok: true, entries: [{ id: "enumerated", params: { mode: placeholder } }] },
  );
  assert.deepEqual(validateResolvedParams(unioned, { value: "rendered" }), { ok: true, params: { value: "rendered" } });
  assert.deepEqual(validateResolvedParams(enumerated, { mode: "a" }), { ok: true, params: { mode: "a" } });
  assert.equal(validateResolvedParams(enumerated, { mode: "z" }).ok, false);
});

test("opaque wrappers (preprocess, lazy) defer to the single post-render parse", () => {
  let preprocessed = 0;
  const opaque = definePreflight({
    id: "opaque",
    input: z.strictObject({
      value: z.preprocess((input) => {
        preprocessed += 1;
        return typeof input === "string" ? input.trim() : input;
      }, z.string().min(1)),
    }),
  });
  const lazy = definePreflight({
    id: "lazy",
    input: z.strictObject({ value: z.lazy(() => z.string()) }),
  });
  const registry = createPreflightRegistry([opaque, lazy]);
  assert.equal(
    validateConfig([{ id: "opaque", with: { value: placeholder } }], registry, { deferValue: isPlaceholder }).ok,
    true,
  );
  assert.equal(preprocessed, 0, "preprocessor ran on the declaration");
  assert.equal(
    validateConfig([{ id: "lazy", with: { value: placeholder } }], registry, { deferValue: isPlaceholder }).ok,
    true,
  );
  const resolved = validateResolvedParams(opaque, { value: "  rendered  " });
  assert.deepEqual(resolved, { ok: true, params: { value: "rendered" } });
  assert.equal(preprocessed, 1);
  assert.deepEqual(validateResolvedParams(lazy, { value: "rendered" }), { ok: true, params: { value: "rendered" } });
});

// --- coercing, intersection, and unknown-definition deferral ---

test("coercing schemas defer: a rendered string may coerce, and absent coercion is decided post-render", () => {
  const coercing = definePreflight({
    id: "coercing",
    input: z.strictObject({ limit: z.coerce.number(), name: z.coerce.string() }),
  });
  const registry = createPreflightRegistry([coercing]);
  // A placeholder in a coercing field defers instead of failing closed...
  assert.deepEqual(
    validateConfig([{ id: "coercing", with: { limit: placeholder, name: "x" } }], registry, { deferValue: isPlaceholder }),
    { ok: true, entries: [{ id: "coercing", params: { limit: placeholder, name: "x" } }] },
  );
  // ...and the single post-render parse performs the actual Zod coercion.
  assert.deepEqual(
    validateResolvedParams(coercing, { limit: "5", name: "x" }),
    { ok: true, params: { limit: 5, name: "x" } },
  );
  assert.equal(validateResolvedParams(coercing, { limit: "not-a-number", name: "x" }).ok, false);
  // An absent coercing field defers when the entry carries a placeholder and
  // fails in the single post-render parse (coerced undefined is NaN).
  const absent = validateConfig([{ id: "coercing", with: { name: placeholder } }], registry, { deferValue: isPlaceholder });
  assert.equal(absent.ok, true);
  assert.equal(validateResolvedParams(coercing, { name: "x" }).ok, false);
});

test("intersection optionality requires every side to accept absence", () => {
  // One optional side and one required side: the key stays required.
  const mixed = definePreflight({
    id: "mixed",
    input: z.strictObject({ value: z.intersection(z.string().optional(), z.number()) }),
  });
  const mixedRegistry = createPreflightRegistry([mixed]);
  const required = validateConfig([{ id: "mixed" }], mixedRegistry, { deferValue: isPlaceholder });
  assert.deepEqual(required, {
    ok: false,
    invalid: [{ id: "mixed", messages: ['mixed: missing required parameter "value"'] }],
  });

  // An all-optional intersection that accepts strings: the walk treats the
  // key as omittable (every side accepts absence), while Zod's object level
  // still requires it — the divergence fails closed in the post-render parse.
  const both = definePreflight({
    id: "both",
    input: z.strictObject({ value: z.intersection(z.string().optional(), z.string().optional()) }),
  });
  const bothRegistry = createPreflightRegistry([both]);
  const deferred = validateConfig([{ id: "both", with: { value: placeholder } }], bothRegistry, { deferValue: isPlaceholder });
  assert.deepEqual(deferred, { ok: true, entries: [{ id: "both", params: { value: placeholder } }] });
  assert.equal(validateResolvedParams(both, { value: "rendered" }).ok, true);
  assert.equal(validateResolvedParams(both, {}).ok, false);

  // A string placeholder in a never-string intersection fails closed.
  const never = definePreflight({
    id: "never",
    input: z.strictObject({ value: z.intersection(z.string(), z.number()) }),
  });
  assert.deepEqual(
    validateConfig([{ id: "never", with: { value: placeholder } }], createPreflightRegistry([never]), { deferValue: isPlaceholder }),
    { ok: false, invalid: [{ id: "never", messages: ['never: invalid parameter "value"'] }] },
  );
});

test("unknown definition types defer conservatively in both directions", () => {
  const exotic = definePreflight({
    id: "exotic",
    input: z.strictObject({ value: z.string().nullable() }),
  });
  // Simulate a definition type this version does not know: neither required
  // nor string-compatibility may be asserted without running schema code.
  exotic.input.shape.value._zod.def.type = "mystery";
  const issues = deferredParameterIssues(exotic, {}, isPlaceholder);
  assert.deepEqual(issues, []);
  assert.deepEqual(
    deferredParameterIssues(exotic, { value: placeholder }, isPlaceholder),
    [],
  );
});
