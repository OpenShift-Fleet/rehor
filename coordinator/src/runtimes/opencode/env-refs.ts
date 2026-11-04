import { asObject, sortedEntries } from "../shared";
import {
  OPENCODE_BLOCKED_PASSTHROUGH,
  OPENCODE_BLOCKED_PASSTHROUGH_PREFIXES,
  OPENCODE_MCP_URL_ENVIRONMENT,
  OPENCODE_PROVIDER_ENVIRONMENT_ALLOWLIST,
} from "./environment";
import { type JsonValue, OpenCodeConfigValidationError } from "./types";

const SECRET_KEY =
  /(?:api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)/i;
const ENV_REFERENCE = /\{env:([^}]*)\}/g;
const BRACED_ENV_REFERENCE = /\$\{([^}]*)\}/g;
const BLOCKED_PASSTHROUGH_ENVIRONMENTS: ReadonlySet<string> = new Set(OPENCODE_BLOCKED_PASSTHROUGH);
const PROVIDER_ENVIRONMENT_ALLOWLIST: ReadonlySet<string> = new Set(
  OPENCODE_PROVIDER_ENVIRONMENT_ALLOWLIST,
);

type EnvironmentReferenceValidator = (name: string, path: string) => void;

/** Normalize one JSON or string-record shape while validating all environment references. */
export function normalizeJsonObject(
  input: Readonly<Record<string, JsonValue>>,
  path: string,
  requiredEnvironment?: Set<string>,
  validateEnvironment: EnvironmentReferenceValidator = assertProviderEnvironment,
): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of sortedEntries(input)) {
    output[key] = normalizeJsonValue(
      value,
      `${path}.${key}`,
      requiredEnvironment,
      key,
      validateEnvironment,
    );
  }
  return output;
}

function normalizeJsonValue(
  value: JsonValue,
  path: string,
  requiredEnvironment: Set<string> | undefined,
  key: string,
  validateEnvironment: EnvironmentReferenceValidator,
): JsonValue {
  if (typeof value === "string") {
    const normalized = normalizeEnvString(value, path, validateEnvironment, requiredEnvironment);
    if (SECRET_KEY.test(key) && parseEnvironmentReferences(normalized, path).length === 0) {
      throw new OpenCodeConfigValidationError([
        `${path} must use an OpenCode environment reference`,
      ]);
    }
    return normalized;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeJsonValue(entry, `${path}[${index}]`, requiredEnvironment, key, validateEnvironment),
    );
  }
  const object = asObject(value);
  if (object) {
    return normalizeJsonObject(
      object as Record<string, JsonValue>,
      path,
      requiredEnvironment,
      validateEnvironment,
    );
  }
  return value;
}

export function normalizeEnvString(
  value: string,
  path: string,
  validateEnvironment?: EnvironmentReferenceValidator,
  requiredEnvironment?: Set<string>,
): string {
  const normalized = value.replace(BRACED_ENV_REFERENCE, "{env:$1}");
  for (const environment of parseEnvironmentReferences(normalized, path)) {
    validateEnvironment?.(environment, path);
    requiredEnvironment?.add(environment);
  }
  return normalized;
}

export function parseEnvironmentReferences(
  value: string,
  path = "environment reference",
): string[] {
  return [...value.matchAll(ENV_REFERENCE)].map((match) => {
    const name = match[1];
    assertEnvironmentVariableName(name, path);
    return name;
  });
}

function assertEnvironmentVariableName(name: string, path: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new OpenCodeConfigValidationError([
      `${path} contains invalid environment variable name '${name}'`,
    ]);
  }
}

export function isCoordinatorControlledEnvironment(name: string): boolean {
  return OPENCODE_BLOCKED_PASSTHROUGH_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function assertProviderEnvironment(
  name: string,
  path: string,
  enforceAllowlist = true,
): void {
  if (isCoordinatorControlledEnvironment(name)) {
    throw new OpenCodeConfigValidationError([
      `${path} cannot reference a coordinator-controlled environment variable`,
    ]);
  }
  if (BLOCKED_PASSTHROUGH_ENVIRONMENTS.has(name)) {
    throw new OpenCodeConfigValidationError([
      `${path} cannot reference a blocked OpenCode environment variable '${name}'`,
    ]);
  }
  if (enforceAllowlist && !PROVIDER_ENVIRONMENT_ALLOWLIST.has(name)) {
    throw new OpenCodeConfigValidationError([
      `${path} cannot reference an unapproved OpenCode environment variable '${name}'`,
    ]);
  }
}

export function assertMcpUrlEnvironment(name: string, path: string): void {
  if (name !== OPENCODE_MCP_URL_ENVIRONMENT) {
    throw new OpenCodeConfigValidationError([
      `${path} cannot reference an unapproved environment variable '${name}'`,
    ]);
  }
}

export function rejectMcpEnvironmentReference(name: string, path: string): void {
  throw new OpenCodeConfigValidationError([
    `${path} cannot reference an environment variable '${name}'`,
  ]);
}

export function assertHttpUrlTemplate(value: string, path: string): void {
  const environments = parseEnvironmentReferences(value, path);
  if (environments.length > 0) {
    if (value === `{env:${environments[0]}}` && environments.length === 1) return;
    value = value.replace(/\{env:[^}]+\}/g, "env-placeholder");
  }
  assertHttpUrl(value, path);
  const url = new URL(value);
  for (const [key, entry] of url.searchParams.entries()) {
    if (SECRET_KEY.test(key) && !entry.includes("env-placeholder")) {
      throw new OpenCodeConfigValidationError([
        `${path} contains a literal credential query parameter`,
      ]);
    }
  }
}

function assertHttpUrl(value: string, path: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenCodeConfigValidationError([`${path} must be an absolute HTTP(S) URL`]);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OpenCodeConfigValidationError([`${path} must use HTTP(S)`]);
  }
  if (url.username || url.password) {
    throw new OpenCodeConfigValidationError([`${path} must not contain credentials`]);
  }
}
