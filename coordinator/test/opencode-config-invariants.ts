import {
  OPENCODE_BLOCKED_PASSTHROUGH,
  OPENCODE_BLOCKED_PASSTHROUGH_PREFIXES,
} from "../src/runtimes/opencode-v1/environment";

const SECRET_KEY =
  /(?:api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)/i;
const ENV_REFERENCE = /\{env:([^}]*)\}/g;
const BLOCKED_ENVIRONMENT = new Set<string>(OPENCODE_BLOCKED_PASSTHROUGH);

export function assertOpenCodeConfigInvariants(value: unknown): void {
  const issues: string[] = [];
  scan(value, "config", issues);
  if (issues.length > 0) {
    throw new Error(`Rendered OpenCode config contains unsafe values: ${issues.join("; ")}`);
  }
}

function scan(value: unknown, path: string, issues: string[]): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) scan(entry, `${path}[${index}]`, issues);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (typeof entry === "string") {
      const environments = [...entry.matchAll(ENV_REFERENCE)].map((match) => match[1]);
      if (environments.some(isCoordinatorControlledEnvironment)) {
        issues.push(`${entryPath} references a coordinator-controlled environment variable`);
      } else if (environments.some((name) => BLOCKED_ENVIRONMENT.has(name))) {
        issues.push(`${entryPath} references a blocked environment variable`);
      }
      if (SECRET_KEY.test(key) && environments.length === 0) {
        issues.push(`${entryPath} contains a literal secret`);
      }
    }
    scan(entry, entryPath, issues);
  }
}

function isCoordinatorControlledEnvironment(name: string): boolean {
  return OPENCODE_BLOCKED_PASSTHROUGH_PREFIXES.some((prefix) => name.startsWith(prefix));
}
