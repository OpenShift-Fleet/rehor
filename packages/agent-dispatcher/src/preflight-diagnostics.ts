import { z, type ZodIssue } from "zod";
import {
  objectEntrySchema,
  preflightEntrySchema,
  shorthandEntrySchema,
  type PreflightRegistry,
} from "@rehor/preflights";

/**
 * Structured configuration diagnostics for `preflights:` declarations.
 *
 * Every diagnostic carries the full validation detail the stable transcript
 * messages collapse: where the problem sits (a path into the raw YAML
 * value), a machine-readable failure code, the human-readable reason, and
 * the received value rendered from declaration literals only. Values are
 * never credentials: `instance.yaml` literals and workflow defaults are the
 * only inputs, env-derived values never pass through here, and raw caught
 * exceptions never become diagnostics.
 */
export type PreflightDiagnostic = { path: string; code: string; message: string; received: string };

/** Every nonprinting character, including lone surrogates, is escaped with a
 * global replacement; the validator is the separate non-global counterpart. */
const ESCAPE_CONTROLS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** Path of the single list-level diagnostic (`preflights:` is not a list);
 * its message already names the field, so formatted lines carry no separate
 * path segment. */
const LIST_PATH = "preflights";

/**
 * Discovery-time configuration failure for one instance profile: the profile
 * name plus the structured diagnostics of its `preflights:` declaration.
 * Thrown so the cycle can log the safe identity and the full issues while
 * the discovery result stays fail-closed (no partial profile list).
 */
export class PreflightConfigurationError extends Error {
  readonly profile: string;
  readonly diagnostics: readonly PreflightDiagnostic[];

  constructor(profile: string, diagnostics: readonly PreflightDiagnostic[], message: string) {
    super(message);
    this.profile = profile;
    this.diagnostics = diagnostics;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Escape every nonprinting character so declaration literals can never
 * smuggle control characters into diagnostics or log records. */
function escapeControls(value: string): string {
  return value.replace(ESCAPE_CONTROLS, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}

/**
 * Render a received value for a diagnostic. The values are declarative
 * `instance.yaml` literals (never credentials), so scalar strings are shown
 * in full; anything structural is described by type only, and env-derived
 * values are never passed through here.
 */
function describeReceived(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value === "symbol" || typeof value === "function") return typeof value;
  if (Array.isArray(value)) return `array (${value.length} items)`;
  return "object";
}

/** A union failure collapses its branches into a bare "Invalid input"; reopen
 * it and name what the branches expected, so the message stays actionable. */
function issueDetail(issue: ZodIssue): string {
  if (issue.code === "invalid_union" && Array.isArray(issue.errors)) {
    const expected = new Set<string>();
    for (const branch of issue.errors) {
      if (!Array.isArray(branch)) continue;
      for (const nested of branch) {
        if ("expected" in nested && typeof nested.expected === "string") expected.add(nested.expected);
      }
    }
    if (expected.size > 0) return `Invalid input: expected one of ${[...expected].join(", ")}`;
  }
  return issue.message;
}

/** The received value at an issue's path, read from the raw value with
 * own-property lookups only (a missing key is `undefined`, never an
 * inherited member). Zod does not reliably attach the input to every issue
 * shape, so the path is walked on the raw value instead. */
function receivedAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = raw;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    const record = current as Record<string, unknown>;
    current = Object.hasOwn(record, String(key)) ? record[String(key)] : undefined;
  }
  return current;
}

function diagnostic(path: string, code: string, message: string, received: unknown): PreflightDiagnostic {
  return {
    path: escapeControls(path),
    code,
    message: escapeControls(message),
    received: escapeControls(describeReceived(received)),
  };
}

/**
 * Entry-shape diagnostics for a raw `preflights:` value: the list shape plus
 * every malformed entry, each with the full Zod issue detail. Registry-level
 * checks (ids, parameter schemas) are not part of this pass — they run per
 * cycle in the engine, so discovery never depends on a registry.
 */
export function preflightEntryDiagnostics(entries: unknown): PreflightDiagnostic[] {
  if (!Array.isArray(entries)) {
    return [diagnostic(LIST_PATH, "invalid_type", "preflights must be a list of preflight entries", entries)];
  }
  const diagnostics: PreflightDiagnostic[] = [];
  entries.forEach((raw, index) => {
    const where = `preflights[${index}]`;
    const parsed = preflightEntrySchema.safeParse(raw);
    if (parsed.success) return;
    // The entry union's collapsed issue carries no path; re-run the failing
    // branch for the precise per-parameter detail (same schemas, same data).
    const branch = typeof raw === "string"
      ? shorthandEntrySchema.safeParse(raw)
      : objectEntrySchema.safeParse(raw);
    const issues = !branch.success ? branch.error.issues : parsed.error.issues;
    for (const issue of issues) {
      diagnostics.push(diagnostic(
        issue.path.length > 0 ? `${where}.${issue.path.map(String).join(".")}` : where,
        issue.code,
        issueDetail(issue),
        receivedAt(raw, issue.path),
      ));
    }
  });
  return diagnostics;
}

/**
 * Full configuration diagnostics for a `preflights:` value against a
 * registry: list shape, malformed entries, unknown preflight ids, and every
 * Zod issue from each known preflight's input schema. All failing entries
 * are reported, not just the first. This powers the engine's structured
 * error results; the stable transcript text stays with `validateConfig`.
 */
export function preflightConfigurationDiagnostics(entries: unknown, registry: PreflightRegistry): PreflightDiagnostic[] {
  const diagnostics = [...preflightEntryDiagnostics(entries)];
  if (!Array.isArray(entries)) return diagnostics;
  entries.forEach((raw, index) => {
    // Only entries whose shape parses are checked semantically; malformed
    // entries are already reported with full issue detail above.
    let id: string;
    let supplied: Record<string, unknown>;
    if (typeof raw === "string") {
      if (!shorthandEntrySchema.safeParse(raw).success) return;
      id = raw;
      supplied = {};
    } else if (isRecord(raw)) {
      const shape = objectEntrySchema.safeParse(raw);
      if (!shape.success) return;
      id = shape.data.id;
      supplied = shape.data.with ?? {};
    } else {
      return;
    }
    const preflight = registry.get(id);
    if (preflight === undefined) {
      diagnostics.push(diagnostic(`preflights[${index}].id`, "unknown_preflight", `${id}: unknown preflight id`, id));
      return;
    }
    const parsed = preflight.input.safeParse(supplied);
    // Strict schemas report unknown keys as parse issues; permissive object
    // schemas strip them silently, so every stripped key is reported here
    // too — the package validator rejects unknown keys either way.
    const reportedKeys = new Set<string>();
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        if (issue.code === "unrecognized_keys") {
          for (const key of issue.keys ?? []) reportedKeys.add(String(key));
        }
        diagnostics.push(diagnostic(
          issue.path.length > 0 ? `preflights[${index}].with.${issue.path.map(String).join(".")}` : `preflights[${index}].with`,
          issue.code,
          issueDetail(issue),
          receivedAt(supplied, issue.path),
        ));
      }
    }
    if (preflight.input instanceof z.ZodObject) {
      const declared = new Set(Object.keys(preflight.input.shape));
      for (const key of Object.keys(supplied)) {
        if (!declared.has(key) && !reportedKeys.has(key)) {
          diagnostics.push(diagnostic(`preflights[${index}].with.${key}`, "unrecognized_keys", `Unrecognized key: "${key}"`, supplied[key]));
        }
      }
    }
  });
  return diagnostics;
}

/** Runtime contract check for diagnostic objects crossing module boundaries
 * (the engine result is typed, but the value is still validated before it
 * reaches a log record): exactly the four fields, non-empty strings without
 * control characters. Field length and issue count are never limited —
 * every generated diagnostic must survive. */
export function isPreflightDiagnostic(value: unknown): value is PreflightDiagnostic {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 4 || !["path", "code", "message", "received"].every((field) => keys.includes(field))) return false;
  const text = (field: unknown): boolean =>
    typeof field === "string" && field !== "" && !CONTROL_CHARACTERS.test(field);
  return text(value.path) && text(value.code) && text(value.message) && text(value.received);
}

/** Stable one-line-per-issue text for a discovery failure:
 * `<profile>: <path>: <message> (got <received>)`. The list-level diagnostic
 * omits the path segment; its message already names the field. */
export function formatPreflightDiagnostics(profile: string, diagnostics: readonly PreflightDiagnostic[]): string {
  return diagnostics
    .map((item) => item.path === LIST_PATH
      ? `${profile}: ${item.message} (got ${item.received})`
      : `${profile}: ${item.path}: ${item.message} (got ${item.received})`)
    .join("\n");
}
