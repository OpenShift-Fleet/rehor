import { z } from "zod";
import { type LiteralValue, objectEntrySchema, shorthandEntrySchema } from "./entry.js";
import type { Preflight, PreflightRegistry } from "./registry.js";
import type { InvalidPreflightEntry } from "./results.js";

/** Zod issue fields the stable message mapping relies on. */
interface IssueLike {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly keys?: readonly string[];
}

const issuesOf = (error: z.ZodError): readonly IssueLike[] =>
  error.issues as unknown as readonly IssueLike[];

const missingRequiredParameter = (id: string, name: string) =>
  `${id}: missing required parameter "${name}"`;
const unknownParameter = (id: string, name: string) => `${id}: unknown parameter "${name}"`;
const invalidParameter = (id: string, name: string) => `${id}: invalid parameter "${name}"`;
const unknownPreflightId = (id: string) => `${id}: unknown preflight id`;
const malformedEntry = (id: string | null, position: number) =>
  id === null ? `entry ${position}: malformed preflight entry` : `${id}: malformed preflight entry`;
/**
 * A whole-`with:`-map constraint failed (for example a root `.refine()`
 * across several fields): there is no single parameter to name, so the
 * entry fails closed with this stable message instead of raw Zod error text.
 */
const invalidParameters = (id: string) => `${id}: invalid parameters`;

/**
 * Parameter names a `with:` map may never carry — mirrors the reserved-name
 * set of `core/entry.ts`. `__proto__` is erased by Zod's record parsing, so
 * it is rejected on the raw own key map below; the other built-in property
 * names are rejected with it (see `core/entry.ts` for the rationale).
 */
const RESERVED_PARAMETER_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** A validated entry with its params parsed against the preflight's schema. */
export interface ResolvedPreflightEntry {
  readonly id: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** Result of re-validating one entry's fully rendered parameter map: parsed
 * params with defaults applied, or the per-parameter validation failures. */
export type ResolvedParamsValidation =
  | { readonly ok: true; readonly params: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly messages: readonly string[] };

/**
 * Options for {@link validateConfig}.
 */
export type ValidateConfigOptions = {
  /**
   * Identifies `with:` values that are render placeholders: a renderer will
   * replace them before execution (for example a tier-2 secret reference).
   * An entry carrying ANY deferred value never has its input schema invoked
   * on the declaration — the schema runs exactly once, on the fully rendered
   * map, via {@link validateResolvedParams}, so schema callbacks (transforms,
   * refinements, preprocessors) never observe declaration literals or
   * placeholder strings. Phase one still fails closed on everything knowable
   * without rendering: entry shape, preflight ids, unknown and reserved
   * parameter names, missing required parameters (optionality read
   * structurally from the schema, see {@link deferredParameterIssues}), and
   * placeholders in fields that can provably never accept a rendered string.
   */
  deferValue?: (value: LiteralValue) => boolean;
};

/**
 * Structural issue on a deferred (placeholder-bearing) parameter map:
 * `missing` names a required parameter that was not supplied, and
 * `incompatible` names a supplied placeholder parameter whose field can
 * never accept a rendered string. Produced by {@link deferredParameterIssues}
 * without invoking the preflight's input schema.
 */
export type DeferredParameterIssue = {
  readonly parameter: string;
  readonly kind: "missing" | "incompatible";
};

/**
 * Result of validating a whole `preflights:` list: either every entry resolved
 * (id + parsed params, defaults applied), or the per-entry validation failures.
 * All failing entries are reported, not just the first; no entry executes
 * unless every entry validates (fail closed).
 */
export type ConfigValidationResult =
  | { readonly ok: true; readonly entries: readonly ResolvedPreflightEntry[] }
  | { readonly ok: false; readonly invalid: readonly InvalidPreflightEntry[] };

type EntryValidation =
  | {
      readonly valid: true;
      readonly id: string;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | { readonly valid: false; readonly id: string | null; readonly messages: readonly string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Extract the id of an object entry, when it is a usable string. */
const entryIdOf = (raw: unknown): string | null => {
  if (!isRecord(raw)) return null;
  return typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null;
};

/** Own enumerable keys of a raw `with:` value, or null when it is not a record. */
const ownWithKeys = (withValue: unknown): readonly string[] | null =>
  isRecord(withValue) ? Object.keys(withValue) : null;

// --- Zod structural introspection -----------------------------------------
//
// These helpers walk Zod's own schema-definition tree (Zod 4: `._zod.def`)
// and NEVER invoke schema callbacks: no transforms, no refinements, no
// preprocess functions, no lazy getters. Anything they cannot see through
// (lazy schemas, preprocess pipes, custom checks) is inconclusive and
// deferred to the post-render parse, which validates the rendered values in
// full — the fail-closed gate moves later for those fields, it never
// disappears.

const INTROSPECTION_DEPTH = 32;

/** The slice of a Zod 4 definition these helpers read; field names match
 * `zod` 4.x (`innerType`, `in`, `options`, `entries`, `values`, `left`,
 * `right`). Unknown shapes read as absent and defer. */
type ZodDefView = {
  readonly type?: string;
  readonly coerce?: boolean;
  readonly innerType?: unknown;
  readonly in?: unknown;
  readonly options?: readonly unknown[];
  readonly entries?: Record<string, unknown>;
  readonly values?: readonly unknown[];
  readonly left?: unknown;
  readonly right?: unknown;
};

const definitionOf = (schema: unknown): ZodDefView | undefined =>
  (schema as { _zod?: { def?: ZodDefView } } | undefined)?._zod?.def;

/** Wrapper types that just carry another schema on `innerType`. */
const INNER_WRAPPERS = new Set(["nullable", "readonly"]);
/** Wrapper types that accept whatever their `innerType` accepts. */
const UNWRAP_TO_INPUT = new Set(["optional", "default", "catch", "nullable", "readonly"]);
/** Node types that cannot be assessed without running user code. */
const OPAQUE_TYPES = new Set(["lazy", "transform", "custom"]);
/** Value types that definitely require a supplied field: an absent key can
 * never satisfy them. This mirrors Zod's own object-level strictness, where
 * only `optional`, `default`, and `catch` make a key omittable — unions,
 * intersections, nullable, and even `any` stay required, and Zod evaluates
 * preprocessors and lazy schemas to decide. Unknown definition types are NOT
 * in this set — they defer to the post-render parse. */
const REQUIRED_VALUE_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "nan",
  "date",
  "null",
  "array",
  "tuple",
  "record",
  "map",
  "set",
  "enum",
  "literal",
  "template_literal",
  "union",
  "any",
  "unknown",
  "undefined",
]);
/** Value types that definitely never accept a string: a rendered string can
 * never satisfy them (absent coercion). Unknown definition types are NOT in
 * this set — they defer to the post-render parse. */
const NON_STRING_VALUE_TYPES = new Set([
  "number",
  "boolean",
  "bigint",
  "symbol",
  "nan",
  "date",
  "null",
  "array",
  "tuple",
  "record",
  "map",
  "set",
]);

/** Whether a field value may be absent: `optional`, `default`, and `catch`
 * make a key omittable (Zod's own object-level rule); opaque and coercing
 * nodes defer (Zod evaluates them by running schema code, which this walk
 * never does); an intersection accepts an absent input only when every side
 * does; every other known shape is required; unknown definition types defer
 * conservatively. Where this walk is more permissive than Zod's object
 * level, the single post-render parse still fails closed. */
function acceptsAbsentInput(schema: unknown, depth = 0): boolean {
  if (depth > INTROSPECTION_DEPTH) return true;
  const def = definitionOf(schema);
  if (def === undefined || def.type === undefined) return true;
  if (OPAQUE_TYPES.has(def.type) || def.coerce === true) return true;
  switch (def.type) {
    case "optional":
    case "default":
    case "catch":
      return true;
    case "pipe":
      return acceptsAbsentInput(def.in, depth + 1);
    case "intersection":
      return acceptsAbsentInput(def.left, depth + 1) && acceptsAbsentInput(def.right, depth + 1);
    default:
      if (INNER_WRAPPERS.has(def.type)) return acceptsAbsentInput(def.innerType, depth + 1);
      // Conservatively defer unknown definition types.
      return !REQUIRED_VALUE_TYPES.has(def.type);
  }
}

/** Whether a supplied string value could ever satisfy the field's input:
 * string-shaped types accept one; known plain non-string types provably never
 * do (a rendered string is never coerced by the dispatcher — but a schema
 * that asks for coercion itself may legitimately accept one, so coercing and
 * opaque nodes defer); unknown definition types defer conservatively. */
function acceptsStringInput(schema: unknown, depth = 0): boolean {
  if (depth > INTROSPECTION_DEPTH) return true;
  const def = definitionOf(schema);
  if (
    def === undefined ||
    def.type === undefined ||
    OPAQUE_TYPES.has(def.type) ||
    def.coerce === true
  )
    return true;
  switch (def.type) {
    case "string":
    case "template_literal":
    case "any":
    case "unknown":
      return true;
    case "enum":
      return Object.values(def.entries ?? {}).some((value) => typeof value === "string");
    case "literal":
      return (def.values ?? []).some((value) => typeof value === "string");
    case "union":
      return (def.options ?? []).some((option) => acceptsStringInput(option, depth + 1));
    case "intersection":
      return acceptsStringInput(def.left, depth + 1) && acceptsStringInput(def.right, depth + 1);
    case "pipe":
      return acceptsStringInput(def.in, depth + 1);
    default:
      if (UNWRAP_TO_INPUT.has(def.type)) return acceptsStringInput(def.innerType, depth + 1);
      // Conservatively defer unknown definition types.
      return !NON_STRING_VALUE_TYPES.has(def.type);
  }
}

const isLiteralValue = (value: unknown): value is LiteralValue =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  Array.isArray(value);

/** Whether an entry's `with:` map carries any deferred placeholder value. */
function carriesDeferredValue(
  supplied: Readonly<Record<string, unknown>>,
  deferValue: (value: LiteralValue) => boolean,
): boolean {
  return Object.values(supplied).some((value) => isLiteralValue(value) && deferValue(value));
}

/**
 * Structural checks for a deferred (placeholder-bearing) parameter map,
 * performed without invoking the preflight's input schema: required
 * parameters must be present (optionality is read structurally), and a
 * placeholder may sit only in a field that can accept a rendered string.
 * Everything else — value constraints, transforms, whole-map refinements —
 * is applied by the single post-render parse of the rendered map.
 */
export function deferredParameterIssues(
  preflight: Preflight,
  supplied: Readonly<Record<string, unknown>>,
  deferValue: (value: LiteralValue) => boolean,
): readonly DeferredParameterIssue[] {
  const issues: DeferredParameterIssue[] = [];
  if (!(preflight.input instanceof z.ZodObject)) return issues;
  for (const [parameter, field] of Object.entries(preflight.input.shape)) {
    if (!Object.hasOwn(supplied, parameter) && !acceptsAbsentInput(field)) {
      issues.push({ parameter, kind: "missing" });
    }
  }
  for (const [parameter, value] of Object.entries(supplied)) {
    const field = preflight.input.shape[parameter];
    // Only a placeholder supplied AS the whole value can be provably
    // incompatible: placeholders inside a list value are string elements,
    // and the post-render parse validates each rendered element against the
    // field's element schema.
    if (
      field !== undefined &&
      typeof value === "string" &&
      deferValue(value) &&
      !acceptsStringInput(field)
    ) {
      issues.push({ parameter, kind: "incompatible" });
    }
  }
  return issues;
}

function validateEntry(
  raw: unknown,
  position: number,
  registry: PreflightRegistry,
  deferValue?: (value: LiteralValue) => boolean,
): EntryValidation {
  // Entry shape: shorthand string or { id, with } object.
  let id: string;
  let supplied: Readonly<Record<string, unknown>>;
  // Raw own keys of the entry's `with:` map, before any Zod normalization.
  let rawWithKeys: readonly string[] | null = null;
  const messages = new Set<string>();
  if (typeof raw === "string") {
    if (!shorthandEntrySchema.safeParse(raw).success) {
      return { valid: false, id: null, messages: [malformedEntry(null, position)] };
    }
    id = raw;
    supplied = {};
  } else if (isRecord(raw)) {
    const entryId = entryIdOf(raw);
    // Inspect the raw `with:` own keys BEFORE parsing: Zod's record parsing
    // erases an own `__proto__` key (and never validates its value), so the
    // raw key map — not the parsed one — is the evidence for the reserved-
    // name and unknown-key checks.
    rawWithKeys = ownWithKeys(raw.with);
    if (rawWithKeys !== null && entryId !== null) {
      for (const key of rawWithKeys) {
        if (RESERVED_PARAMETER_KEYS.has(key)) messages.add(invalidParameter(entryId, key));
      }
    }
    const shape = objectEntrySchema.safeParse(raw);
    if (!shape.success) {
      // Map issue paths to stable messages; never surface raw Zod error text.
      let structural = false;
      for (const issue of issuesOf(shape.error)) {
        const [head, key] = issue.path;
        if (head === "with" && typeof key === "string") {
          // A `with:` value that is not a plain literal (or a bad record value).
          if (entryId !== null) messages.add(invalidParameter(entryId, key));
        } else if (head === "with" && isRecord(raw.with)) {
          // The whole `with:` map failed at its root while being a plain
          // record: that can only be the reserved-name guard in
          // `core/entry.ts` firing (record parsing itself accepts every
          // record), and the raw scan above already reported those keys —
          // not a structural malformed entry.
        } else {
          structural = true;
        }
      }
      if (structural || messages.size === 0) {
        messages.add(malformedEntry(entryId, position));
      }
      return { valid: false, id: entryId, messages: [...messages] };
    }
    id = shape.data.id;
    supplied = shape.data.with ?? {};
  } else {
    return { valid: false, id: null, messages: [malformedEntry(null, position)] };
  }

  // Registry lookup: unknown ids fail closed.
  const preflight = registry.get(id);
  if (preflight === undefined) {
    return { valid: false, id, messages: [unknownPreflightId(id)] };
  }

  // Params: parse the supplied map against the preflight's input schema and
  // map every issue to a stable per-parameter message.
  if (preflight.input instanceof z.ZodObject) {
    const declared = new Set(Object.keys(preflight.input.shape));
    for (const key of rawWithKeys ?? Object.keys(supplied)) {
      // Reserved keys were already reported as invalid parameters above.
      if (!declared.has(key) && !RESERVED_PARAMETER_KEYS.has(key)) {
        messages.add(unknownParameter(id, key));
      }
    }
  }
  // Deferred (placeholder-bearing) entries never invoke the input schema on
  // the declaration: the schema runs exactly once, on the fully rendered
  // map, in post-render validation. Phase one keeps every structural check
  // that needs no rendering — the unknown-key scan above plus the required
  // and placeholder-compatibility checks below.
  if (deferValue !== undefined && carriesDeferredValue(supplied, deferValue)) {
    for (const issue of deferredParameterIssues(preflight, supplied, deferValue)) {
      messages.add(
        issue.kind === "missing"
          ? missingRequiredParameter(id, issue.parameter)
          : invalidParameter(id, issue.parameter),
      );
    }
    if (messages.size > 0) {
      return { valid: false, id, messages: [...messages] };
    }
    // Raw literals pass through; defaults and transforms are applied by the
    // single post-render parse of the rendered map.
    return { valid: true, id, params: supplied };
  }
  const parsed = preflight.input.safeParse(supplied);
  if (!parsed.success) {
    for (const issue of issuesOf(parsed.error)) {
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys ?? []) messages.add(unknownParameter(id, key));
        continue;
      }
      if (issue.path.length === 0) {
        // A whole-`with:`-map constraint (for example a root `.refine()`
        // across several fields): no single parameter to name.
        messages.add(invalidParameters(id));
        continue;
      }
      const [head] = issue.path;
      if (typeof head !== "string") continue;
      // A param that was not supplied at all is missing; one that was supplied
      // but failed its schema is invalid.
      messages.add(
        Object.hasOwn(supplied, head)
          ? invalidParameter(id, head)
          : missingRequiredParameter(id, head),
      );
    }
    // Fail closed on any unsuccessful parse, even one whose issues mapped to
    // no message above — a valid entry must never carry failed params.
    if (messages.size === 0) messages.add(invalidParameters(id));
  }
  if (messages.size > 0) {
    return { valid: false, id, messages: [...messages] };
  }
  return {
    valid: true,
    id,
    params: parsed.data as Readonly<Record<string, unknown>>,
  };
}

/**
 * Validate a whole `preflights:` list from an agent's `instance.yaml` against
 * a registry, before any preflight executes. `entries` is the raw YAML value:
 * a list of shorthand strings or `{ id, with }` objects. Returns every entry
 * resolved with parsed params, or every failing entry with its stable
 * validation messages — raw Zod error text is never surfaced. When
 * `options.deferValue` marks placeholder values, their value-level schema
 * checks are deferred (see {@link ValidateConfigOptions}); the caller must
 * re-validate rendered parameter maps with {@link validateResolvedParams}.
 */
export function validateConfig(
  entries: unknown,
  registry: PreflightRegistry,
  options: ValidateConfigOptions = {},
): ConfigValidationResult {
  if (!Array.isArray(entries)) {
    return {
      ok: false,
      invalid: [{ id: null, messages: ["preflights: expected a list of preflight entries"] }],
    };
  }
  const resolved: ResolvedPreflightEntry[] = [];
  const invalid: InvalidPreflightEntry[] = [];
  entries.forEach((raw, index) => {
    const result = validateEntry(raw, index + 1, registry, options.deferValue);
    if (result.valid) {
      resolved.push({ id: result.id, params: result.params });
    } else {
      invalid.push({ id: result.id, messages: result.messages });
    }
  });
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, entries: resolved };
}

/**
 * Validate one entry's fully rendered parameter map against the preflight's
 * input schema — the post-render half of deferred validation. Produces the
 * same stable per-parameter messages as {@link validateConfig}; the rendered
 * values themselves never appear in them. A failing result must prevent the
 * entry (and the dispatch) from executing.
 */
export function validateResolvedParams(
  preflight: Preflight,
  params: Readonly<Record<string, unknown>>,
): ResolvedParamsValidation {
  const id = preflight.id;
  const messages = new Set<string>();
  if (preflight.input instanceof z.ZodObject) {
    const declared = new Set(Object.keys(preflight.input.shape));
    for (const key of Object.keys(params)) {
      // Reserved keys were rejected at declaration validation; defense only.
      if (!declared.has(key) && !RESERVED_PARAMETER_KEYS.has(key)) {
        messages.add(unknownParameter(id, key));
      }
    }
  }
  const parsed = preflight.input.safeParse(params);
  if (parsed.success) {
    return { ok: true, params: parsed.data as Readonly<Record<string, unknown>> };
  }
  for (const issue of issuesOf(parsed.error)) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys ?? []) messages.add(unknownParameter(id, key));
      continue;
    }
    if (issue.path.length === 0) {
      messages.add(invalidParameters(id));
      continue;
    }
    const [head] = issue.path;
    if (typeof head !== "string") continue;
    // Rendered maps carry every supplied key; a path issue is an invalid value.
    messages.add(invalidParameter(id, head));
  }
  if (messages.size === 0) messages.add(invalidParameters(id));
  return { ok: false, messages: [...messages] };
}
