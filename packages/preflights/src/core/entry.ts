import { z } from "zod";

/**
 * Plain literal values allowed in a `with:` parameter map: strings, numbers,
 * booleans, and lists of those. No objects, no null, no interpolation —
 * anything dynamic belongs in the preflight implementation, not the
 * configuration.
 */
export type LiteralValue = string | number | boolean | LiteralValue[];

/** Schema for {@link LiteralValue}. */
export const literalValueSchema: z.ZodType<LiteralValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.array(literalValueSchema)]),
);

/**
 * Parameter names a `with:` map may never carry. Zod's record parsing
 * silently drops an own `__proto__` key (it never becomes an output key and
 * its value is never validated), so a strict YAML/JSON parser handing us
 * `__proto__:` as an own key would smuggle an unknown — and prototype
 * pollution shaped — parameter past every later check. `constructor` and
 * `prototype` are rejected with it so no `with:` key can collide with a
 * built-in property name.
 */
const RESERVED_PARAMETER_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Stand-in value returned by the `with:` guard below. A symbol can never be
 * a {@link LiteralValue}, so a record carrying it always fails parsing.
 */
const RESERVED_PARAMETER_SENTINEL = Symbol("reserved with: parameter name");

/**
 * `with:` parameter map schema. The raw own keys are inspected before record
 * parsing: Zod erases own `__proto__` keys there, so reserved names are
 * rejected up front by replacing the whole map with a non-record sentinel
 * that fails the record schema (the entry-level validation in
 * `core/validate.ts` reports the precise parameter names from the raw key
 * map). Maps without reserved keys pass through untouched.
 */
const withParameterMapSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
    for (const key of Object.keys(raw)) {
      if (RESERVED_PARAMETER_KEYS.has(key)) return RESERVED_PARAMETER_SENTINEL;
    }
    return raw;
  },
  z.record(z.string(), literalValueSchema),
);

/** Shorthand entry: the plain `"- <id>"` form, a bare non-empty string. */
export const shorthandEntrySchema = z.string().min(1);

/** Parameterized entry: `{ id: string, with: Record<string, LiteralValue> }`. */
export const objectEntrySchema = z.strictObject({
  id: z.string().min(1),
  with: withParameterMapSchema.optional(),
});

/**
 * One `preflights:` entry in an agent's `instance.yaml`: either a shorthand
 * string (`- jira-triage`) or an object (`- id: jira-kanban` with a `with:`
 * map). Shorthand and `with:`-less object entries mean "all inputs use their
 * declared defaults" and are valid only for preflights with no required
 * inputs.
 */
export const preflightEntrySchema = z.union([shorthandEntrySchema, objectEntrySchema]);

/** Parsed shape of one `preflights:` entry. */
export type PreflightEntry = z.infer<typeof preflightEntrySchema>;
