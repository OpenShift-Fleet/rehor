import nunjucks from "nunjucks";
import type { ErrorCategory } from "./logging.js";

/** Decoded Kubernetes Secret payload: key to raw bytes. The reader (see
 * `kubernetes-secrets.ts`) owns transport and tier enforcement; this module
 * owns reference validation and placeholder rendering. */
export type SecretData = ReadonlyMap<string, Buffer>;

/** Reads one Kubernetes Secret by name; implementations must enforce the
 * tier-2 label contract before returning data. */
export type SecretReader = (name: string) => Promise<SecretData>;

/** Semantic failure kinds for secret rendering. `invalid-reference` covers
 * malformed placeholders (arity, argument types, syntax, unknown variables,
 * references that were not prefetched); `missing-secret` and `missing-key`
 * cover absent cluster objects and keys; `invalid-value` covers decoded
 * values that fail hygiene checks; `tier` covers tier-1 or unlabeled
 * references; `transport` covers Kubernetes API access failures; `rotated`
 * covers a launch-time value that no longer matches the value the same
 * dispatch already read and acted on. */
export type SecretFailure =
  | "invalid-reference"
  | "missing-secret"
  | "missing-key"
  | "invalid-value"
  | "tier"
  | "transport"
  | "rotated";

/** Fail-closed secret rendering error. Messages carry reference names and
 * keys only — resolved values never appear here, in logs, or in diagnostics. */
export class SecretRenderError extends Error {
  constructor(
    message: string,
    readonly category: ErrorCategory,
    readonly failure: SecretFailure,
  ) {
    super(message);
  }
}

// Kubernetes Secret names are RFC 1123 DNS subdomains: dot-separated DNS
// labels, at most 253 characters. Validated before any URL is built.
const secretNamePattern = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;
// Kubernetes Secret keys: alphanumeric plus '-', '.', '_', at most 253 chars.
const secretKeyPattern = /^[-._a-zA-Z0-9]+$/;

export function isSecretReferenceName(name: string): boolean {
  return name.length <= 253 && secretNamePattern.test(name);
}

export function isSecretReferenceKey(key: string): boolean {
  return key.length <= 253 && secretKeyPattern.test(key);
}

export type SecretReference = { readonly name: string; readonly key: string };

/** Placeholder spans use the fixed `${{ … }}` nunjucks tags. */
const PLACEHOLDER = /\$\{\{([\s\S]*?)\}\}/g;
/** A `secret(…)` call inside one placeholder span: exactly two literal string
 * arguments, either quote style, any surrounding whitespace. References that
 * use anything else (dynamic arguments, escaped quotes) are not prefetched
 * and fail closed at render time in the `secret()` wrapper. The leading
 * boundary rejects member calls and identifiers ending in "secret". */
const SECRET_CALL = /(?:^|[^\w.])secret\s*\(\s*(["'])([^"']*)\1\s*,\s*(["'])([^"']*)\3\s*\)/g;

/** Every literal `secret('name','key')` reference inside a placeholder span. */
export function scanSecretReferences(template: string): SecretReference[] {
  const references: SecretReference[] = [];
  for (const span of template.matchAll(PLACEHOLDER)) {
    for (const call of span[1].matchAll(SECRET_CALL)) {
      references.push({ name: call[2], key: call[4] });
    }
  }
  return references;
}

/** Hygiene limits for one resolved value: environment delivery stays small
 * and control characters stay out of the runner environment. */
export const MAX_SECRET_VALUE_BYTES = 32_768;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

function secretValue(secret: SecretData, name: string, key: string): string {
  const raw = secret.get(key);
  if (raw === undefined) {
    throw new SecretRenderError(`Secret '${name}' is missing key '${key}'`, "configuration", "missing-key");
  }
  const value = raw.toString("utf8");
  if (
    raw.byteLength === 0
    || raw.byteLength > MAX_SECRET_VALUE_BYTES
    || !raw.equals(Buffer.from(value, "utf8"))
    || CONTROL_CHARACTERS.test(value)
  ) {
    throw new SecretRenderError(`Secret '${name}' has an invalid value for key '${key}'`, "response", "invalid-value");
  }
  return value;
}

/** Batch-read every referenced Secret once, keyed by name. */
async function prefetchReferences(
  references: readonly SecretReference[],
  read: SecretReader,
): Promise<Map<string, SecretData>> {
  const names = [...new Set(references.map((reference) => reference.name))];
  const secrets = await Promise.all(names.map((name) => read(name)));
  return new Map(names.map((name, index) => [name, secrets[index]] as const));
}

/** Observes each successful reference resolution. Called with the reference
 * and its validated value; may throw a `SecretRenderError` to fail rendering
 * (the launch-time rotation guard does exactly that). Values observed here
 * stay in dispatcher memory and are never logged or serialized. */
export type SecretRenderHooks = {
  onResolved?: (reference: SecretReference, value: string) => void;
};

/** Render one template with a synchronous lookup over prefetched values.
 * Nunjucks wraps errors thrown inside globals, so the original
 * `SecretRenderError` is tracked out-of-band and rethrown rather than parsed
 * out of the wrapper message. */
function renderTemplate(template: string, lookup: (name: string, key: string) => string, subject: string): string {
  let failure: SecretRenderError | undefined;
  const environment = new nunjucks.Environment(null, {
    autoescape: false,
    throwOnUndefined: true,
    tags: { variableStart: "${{", variableEnd: "}}" },
  });
  environment.addGlobal(
    "secret",
    (...args: unknown[]): string => {
      const invalid = (message: string): never => {
        const error = new SecretRenderError(message, "configuration", "invalid-reference");
        failure ??= error;
        throw error;
      };
      // Nunjucks does not validate arity: a missing argument arrives as
      // undefined and would otherwise render the string "undefined".
      if (args.length !== 2) {
        throw invalid("secret() requires exactly 2 arguments");
      }
      const [name, key] = args;
      if (typeof name !== "string" || typeof key !== "string" || !name || !key) {
        throw invalid("secret() requires 2 non-empty string arguments");
      }
      try {
        return lookup(name, key);
      } catch (error) {
        if (error instanceof SecretRenderError) failure ??= error;
        throw error;
      }
    },
  );
  try {
    return environment.renderString(template, {});
  } catch (error) {
    if (failure) throw failure;
    // Nunjucks parse or render failure (unknown variable, syntax). Template
    // text is public repository content, but the failure stays fixed-message.
    throw new SecretRenderError(`${subject} is not a valid template`, "configuration", "invalid-reference");
  }
}

/** Validate every reference, prefetch each distinct Secret once, then render
 * each template with a synchronous lookup. All-or-nothing within the batch:
 * one bad reference or value rejects the whole set. */
async function renderTemplates(
  templates: readonly string[],
  read: SecretReader,
  subject: string,
  hooks?: SecretRenderHooks,
): Promise<string[]> {
  const references = templates.flatMap((template) => scanSecretReferences(template));
  for (const reference of references) {
    if (!isSecretReferenceName(reference.name) || !isSecretReferenceKey(reference.key)) {
      throw new SecretRenderError(`${subject} contains an invalid secret reference`, "configuration", "invalid-reference");
    }
  }
  const secrets = await prefetchReferences(references, read);
  const lookup = (name: string, key: string): string => {
    const secret = secrets.get(name);
    if (secret === undefined) {
      throw new SecretRenderError(`Secret '${name}' was not prefetched`, "configuration", "invalid-reference");
    }
    const value = secretValue(secret, name, key);
    hooks?.onResolved?.({ name, key }, value);
    return value;
  };
  return templates.map((template) => renderTemplate(template, lookup, subject));
}

/** Whether a literal value tree carries at least one `${{ … }}` placeholder:
 * strings anywhere — scalar values, list elements, or map entries. */
export function containsSecretTemplate(value: unknown): boolean {
  const templates: string[] = [];
  collectTemplates(value, templates);
  return templates.length > 0;
}

/** Collect placeholder-carrying strings from a literal value tree, in
 * deterministic traversal order (object insertion order, then array order). */
function collectTemplates(value: unknown, templates: string[]): void {
  if (typeof value === "string") {
    if (value.includes("${{")) templates.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectTemplates(item, templates);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectTemplates(item, templates);
  }
}

/** Rewrite a literal value tree with rendered strings, consuming the rendered
 * list in the same deterministic order `collectTemplates` produced. */
function rewriteTemplates(value: unknown, rendered: string[]): unknown {
  if (typeof value === "string") {
    return value.includes("${{") ? rendered.shift() : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteTemplates(item, rendered));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // Own data property, immune to the `__proto__` setter trap.
      Object.defineProperty(out, key, {
        value: rewriteTemplates(item, rendered),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/**
 * Render every `${{ secret('name','key') }}` placeholder inside a literal
 * value tree — scalar strings, list elements, and map values. Used for
 * `preflights[].with` parameter maps: each call is one entry's rendering, so
 * the per-call prefetch deduplicates Secret reads within that entry only.
 * A tree without placeholders returns unchanged and reads nothing. Rendering
 * is all-or-nothing per call, and no resolved value ever appears in an error,
 * log, or diagnostic.
 */
export async function renderSecretTemplates(
  value: unknown,
  read: SecretReader,
  hooks?: SecretRenderHooks,
): Promise<unknown> {
  const templates: string[] = [];
  collectTemplates(value, templates);
  if (!templates.length) return value;
  const rendered = await renderTemplates(templates, read, "Preflight parameter value", hooks);
  return rewriteTemplates(value, rendered);
}

/**
 * Private in-memory record of the secret values one dispatch decision
 * observed, used to detect rotation at sandbox launch. The values never
 * leave dispatcher memory: no hashing, no serialization, no logs — a digest
 * would add nothing inside the same process and would risk exposure if ever
 * emitted, so the comparison stays on the raw values held only here.
 *
 * Every entry's observation is kept separately — nothing is overwritten, so
 * a run that saw different values for one reference stays visible. Only
 * start-outcome entries bind: their content is the only preflight output
 * that reaches the sandbox (the input envelope carries start content plus
 * script names and statuses, nothing else), so only their observations
 * constrain the launch. `bindStartEntries` resolves one value per reference
 * from the start entries and throws a fixed-message `SecretRenderError`
 * (never a value) when two start entries observed different values for the
 * same reference — a mixed prompt must not dispatch. `verify` then fails a
 * launch whose rendered value differs from the bound value.
 */
export type SecretValueLedger = {
  observe(entry: number, reference: SecretReference, value: string): void;
  bindStartEntries(entries: readonly number[]): void;
  verify(reference: SecretReference, value: string): void;
};

export function createSecretValueLedger(): SecretValueLedger {
  // Reference key → entry index → observed value; then the start-bound view.
  const observations = new Map<string, Map<number, string>>();
  const bound = new Map<string, string>();
  const key = (reference: SecretReference): string => JSON.stringify([reference.name, reference.key]);
  return {
    observe: (entry, reference, value) => {
      let perEntry = observations.get(key(reference));
      if (perEntry === undefined) {
        perEntry = new Map<number, string>();
        observations.set(key(reference), perEntry);
      }
      // One entry's prefetch resolves a reference to a single value; the
      // same entry re-observing it is idempotent by construction.
      perEntry.set(entry, value);
    },
    bindStartEntries: (entries) => {
      // Resolve into a scratch map and commit only when every start
      // observation agreed — a conflicting run binds nothing.
      const resolved = new Map<string, string>();
      for (const [referenceKey, perEntry] of observations) {
        for (const entry of entries) {
          const value = perEntry.get(entry);
          if (value === undefined) continue;
          const existing = resolved.get(referenceKey);
          if (existing !== undefined && existing !== value) {
            throw new SecretRenderError(
              "Preflight entries observed different values for one secret during this run",
              "configuration",
              "rotated",
            );
          }
          resolved.set(referenceKey, value);
        }
      }
      for (const [referenceKey, value] of resolved) bound.set(referenceKey, value);
    },
    verify: (reference, value) => {
      const expected = bound.get(key(reference));
      if (expected !== undefined && expected !== value) {
        throw new SecretRenderError(
          `Secret '${reference.name}' changed since it was last read for this dispatch`,
          "configuration",
          "rotated",
        );
      }
    },
  };
}

/** Render instance `sandbox.env` values for one dispatch. Plain values pass
 * through unrendered; values containing `${{ secret('name','key') }}`
 * placeholders render from prefetched tier-2 Kubernetes Secrets. Rendering is
 * synchronous, so literal references are scanned and batch-read first; a
 * render-time reference that was not prefetched fails closed. All-or-nothing:
 * one bad value rejects the whole set, and no resolved value ever appears in
 * an error, log, or diagnostic. */
export async function renderSandboxEnvironment(
  values: Readonly<Record<string, string>>,
  read: SecretReader,
  hooks?: SecretRenderHooks,
): Promise<Record<string, string>> {
  const rendered: Record<string, string> = {};
  const templates = new Map<string, string>();
  for (const [name, value] of Object.entries(values)) {
    if (value.includes("${{")) templates.set(name, value);
    else rendered[name] = value;
  }
  if (!templates.size) return rendered;
  const results = await renderTemplates([...templates.values()], read, "Sandbox environment value", hooks);
  for (const name of templates.keys()) rendered[name] = results.shift()!;
  return rendered;
}
