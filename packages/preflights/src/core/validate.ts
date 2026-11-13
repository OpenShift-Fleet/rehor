import { z } from "zod";
import { objectEntrySchema, shorthandEntrySchema } from "./entry.js";
import type { PreflightRegistry } from "./registry.js";
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

function validateEntry(
  raw: unknown,
  position: number,
  registry: PreflightRegistry,
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
  return { valid: true, id, params: parsed.data as Readonly<Record<string, unknown>> };
}

/**
 * Validate a whole `preflights:` list from an agent's `instance.yaml` against
 * a registry, before any preflight executes. `entries` is the raw YAML value:
 * a list of shorthand strings or `{ id, with }` objects. Returns every entry
 * resolved with parsed params, or every failing entry with its stable
 * validation messages — raw Zod error text is never surfaced.
 */
export function validateConfig(
  entries: unknown,
  registry: PreflightRegistry,
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
    const result = validateEntry(raw, index + 1, registry);
    if (result.valid) {
      resolved.push({ id: result.id, params: result.params });
    } else {
      invalid.push({ id: result.id, messages: result.messages });
    }
  });
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, entries: resolved };
}
