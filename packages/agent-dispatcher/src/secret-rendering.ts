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
 * references; `transport` covers Kubernetes API access failures. */
export type SecretFailure =
  | "invalid-reference"
  | "missing-secret"
  | "missing-key"
  | "invalid-value"
  | "tier"
  | "transport";

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

/** Render one template with a synchronous lookup over prefetched values.
 * Nunjucks wraps errors thrown inside globals, so the original
 * `SecretRenderError` is tracked out-of-band and rethrown rather than parsed
 * out of the wrapper message. */
function renderTemplate(template: string, lookup: (name: string, key: string) => string): string {
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
    throw new SecretRenderError("Sandbox environment value is not a valid template", "configuration", "invalid-reference");
  }
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
): Promise<Record<string, string>> {
  const rendered: Record<string, string> = {};
  const templates = new Map<string, string>();
  for (const [name, value] of Object.entries(values)) {
    if (value.includes("${{")) templates.set(name, value);
    else rendered[name] = value;
  }
  if (!templates.size) return rendered;
  const references = [...templates.values()].flatMap((template) => scanSecretReferences(template));
  for (const reference of references) {
    if (!isSecretReferenceName(reference.name) || !isSecretReferenceKey(reference.key)) {
      throw new SecretRenderError("Sandbox environment value contains an invalid secret reference", "configuration", "invalid-reference");
    }
  }
  const secrets = await prefetchReferences(references, read);
  const lookup = (name: string, key: string): string => {
    const secret = secrets.get(name);
    if (secret === undefined) {
      throw new SecretRenderError(`Secret '${name}' was not prefetched`, "configuration", "invalid-reference");
    }
    return secretValue(secret, name, key);
  };
  for (const [name, template] of templates) rendered[name] = renderTemplate(template, lookup);
  return rendered;
}
