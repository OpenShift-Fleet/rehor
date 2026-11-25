import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { objectEntrySchema, type PreflightEntry } from "@rehor/preflights";
import { isInstancePreflightVariable, isSandboxEnvironmentVariable } from "./preflight-env.js";
import {
  formatPreflightDiagnostics,
  preflightEntryDiagnostics,
  PreflightConfigurationError,
  type PreflightDiagnostic,
} from "./preflight-diagnostics.js";
import { parseSandboxEgress, type SandboxEgressRequest } from "./profile-egress.js";
import { scheduleDiagnostics, type ScheduleConfig, type ScheduleTrigger } from "./schedule.js";

export type AgentImage = { repository: string; tag: string; reference: string };

/** Paths are absolute and resolved within the checkout. Pass botRoot and
 * instanceDir for instance data (project-repos.json); the preflight engine
 * consumes the declarative `preflights:` field, never workflow scripts. */
export type AgentProfile = {
  name: string;
  configPath: string;
  botRoot: string;
  instanceDir: string;
  workflow: string;
  workflowDir: string;
  image: AgentImage;
  preflightEnv: Record<string, string>;
  /**
   * Parsed `sandbox.env` entries: sandbox runner environment values applied
   * per dispatch. Values containing `${{ secret('name','key') }}` placeholders
   * are rendered from tier-2 Kubernetes Secrets before sandbox creation.
   */
  sandboxEnv: Record<string, string>;
  /**
   * Parsed `sandbox.egress` destinations: exact public HTTPS requests
   * (mandatory `host` and `port` keys only, never raw policy fields),
   * strictly validated at discovery. Omitted when the profile declares
   * none, so discovery output keeps its former shape.
   */
  sandboxEgress?: SandboxEgressRequest[];
  /**
   * Parsed `preflights:` entries for the preflight engine:
   * shorthand strings or `{ id, with }` objects, already shape-validated
   * against the package's entry schema. Registry-level validation (ids,
   * parameters) happens per run in the engine.
   */
  preflights?: PreflightEntry[];
  /**
   * Parsed `schedule:` declaration: KEDA-style cron windows, shape- and
   * expression-validated here. The dispatcher evaluates it per cycle
   * against the wall clock; while no window is active the profile is
   * skipped before any preflight runs. Absent means always eligible.
   */
  schedule?: ScheduleConfig;
};

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function checkedPath(path: string, root: string, kind: "directory" | "file"): Promise<string> {
  const actual = await realpath(path);
  if (!contained(root, actual)) throw new Error(`Path escapes checkout boundary: ${path}`);
  const info = await stat(actual);
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`Expected ${kind}: ${path}`);
  }
  return actual;
}

async function optionalDirectory(path: string, root: string): Promise<string | undefined> {
  try {
    // lstat distinguishes a missing directory from a dangling symlink.
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return checkedPath(path, root, "directory");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function imageFrom(value: unknown): AgentImage {
  if (!object(value) || Object.keys(value).some((key) => key !== "repository" && key !== "tag")) {
    throw new Error("image must contain repository and optional tag");
  }
  const { repository } = value;
  const tag = value.tag === undefined ? "latest" : value.tag;
  // Docker/OCI repository path components and an optional registry port. No
  // schemes, digest, tag in repository, whitespace, or shell metacharacters.
  const component = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
  if (typeof repository !== "string" || repository.length > 255) throw new Error("Invalid image repository");
  const parts = repository.split("/");
  const registry = parts[0].split(":");
  const registryName = registry[0];
  if (registry.length > 2 || (registry.length === 2 && (parts.length < 2 || !/^[0-9]{1,5}$/.test(registry[1]) || Number(registry[1]) < 1 || Number(registry[1]) > 65535))
    || !component.test(registryName) || !parts.slice(1).every((part) => component.test(part))) {
    throw new Error("Invalid image repository");
  }
  if (typeof tag !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new Error("Invalid image tag");
  return { repository, tag, reference: `${repository}:${tag}` };
}

function workflowFrom(value: unknown): string {
  if (typeof value !== "string") throw new Error("workflow must be a string");
  const relativeWorkflow = value.startsWith("./");
  const components = (relativeWorkflow ? value.slice(2) : value).split("/");
  if ((!relativeWorkflow && components.length !== 1)
    || !components.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== "." && part !== "..")) {
    throw new Error("Invalid workflow");
  }
  return value;
}

function profileEnvironment(value: unknown, legacy: unknown): Record<string, string> {
  if (value !== undefined && legacy !== undefined) {
    throw new Error("Use either env or preflight.env, not both");
  }
  if (legacy !== undefined) {
    if (!object(legacy) || Object.keys(legacy).some((key) => key !== "env") || !object(legacy.env)) {
      throw new Error("Invalid preflight environment");
    }
    value = legacy.env;
  }
  if (value === undefined) return {};
  if (!object(value)) throw new Error("Invalid profile environment");
  const env: Record<string, string> = {};
  for (const [name, setting] of Object.entries(value)) {
    if (!isInstancePreflightVariable(name) || typeof setting !== "string" || !setting) {
      throw new Error("Invalid profile environment");
    }
    env[name] = setting;
  }
  return env;
}

/** Mirrors the `preflight` category shape: the `sandbox` object accepts only
 * the `env` and `egress` keys, and either may be the sole key. Every `env`
 * entry must be an allowed sandbox environment name with a non-empty string
 * value; placeholder syntax is validated at dispatch time by the renderer.
 * `egress` destinations are exact host/port requests validated strictly by
 * `parseSandboxEgress`. Discovery fails closed on shape only: a `null`,
 * array, empty `{}`, or unknown-key `sandbox` stays invalid exactly as
 * before, and raw policy fields are never accepted. */
function sandboxConfiguration(value: unknown): { env: Record<string, string>; egress: SandboxEgressRequest[] | undefined } {
  if (value === undefined) return { env: {}, egress: undefined };
  if (!object(value) || Object.keys(value).length === 0
    || Object.keys(value).some((key) => key !== "env" && key !== "egress")) {
    throw new Error("Invalid sandbox configuration");
  }
  const env: Record<string, string> = {};
  if (value.env !== undefined) {
    if (!object(value.env)) throw new Error("Invalid sandbox environment");
    for (const [name, setting] of Object.entries(value.env)) {
      if (!isSandboxEnvironmentVariable(name) || typeof setting !== "string" || !setting) {
        throw new Error("Invalid sandbox environment");
      }
      env[name] = setting;
    }
  }
  // An absent or empty list omits `sandboxEgress`, so profiles without
  // destinations keep their exact former discovery output.
  const requests = parseSandboxEgress(value.egress);
  return { env, egress: requests.length > 0 ? requests : undefined };
}

/** Strict `preflights:` parsing: undefined passes through (the
 * field is omitted and the workflow's default set applies later), but any
 * malformed entry fails profile discovery — entries are never silently
 * dropped, and every failure names the instance and the exact entry,
 * parameter, and reason. Only the entry shape is checked here; id and
 * parameter validation against a registry happens per run in the preflight
 * engine. The failure is typed: it carries the profile name and the full
 * structured diagnostics, so the cycle can log the issues while the
 * discovery result stays fail-closed.
 */
function preflightsFrom(value: unknown, name: string): PreflightEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw configurationError(name, preflightEntryDiagnostics(value));
  }
  const diagnostics = preflightEntryDiagnostics(value);
  if (diagnostics.length > 0) throw configurationError(name, diagnostics);
  // Every entry parsed cleanly; re-run the object branch for typed values.
  return value.map((raw) => (typeof raw === "string" ? raw : objectEntrySchema.parse(raw)));
}

function configurationError(name: string, diagnostics: readonly PreflightDiagnostic[]): PreflightConfigurationError {
  return new PreflightConfigurationError(name, diagnostics, formatPreflightDiagnostics(name, diagnostics));
}

/** Strict `schedule:` parsing: undefined passes through (the field is
 * omitted and the profile is always eligible), but any malformed
 * declaration fails profile discovery with the full structured
 * diagnostics, exactly like `preflights:`. */
function scheduleFrom(value: unknown, name: string): ScheduleConfig | undefined {
  if (value === undefined) return undefined;
  const diagnostics = scheduleDiagnostics(value);
  if (diagnostics.length > 0) throw configurationError(name, diagnostics);
  const { triggers } = value as { triggers: ScheduleTrigger[] };
  return { triggers: triggers.map((trigger) => ({ timezone: trigger.timezone, start: trigger.start, end: trigger.end })) };
}

/** Discover every agent profile in one fixed checkout. Any invalid profile or
 * missing shared dependency rejects the entire result; no partial list escapes.
 * The checkout must remain unchanged until the caller finishes using paths. */
export async function discoverAgentProfiles(checkout: string): Promise<AgentProfile[]> {
  const root = await realpath(resolve(checkout));
  const instances = await checkedPath(join(root, "instance"), root, "directory");
  const botRoot = await checkedPath(join(root, "dev-bot"), root, "directory");
  const profiles: AgentProfile[] = [];
  for (const name of (await readdir(instances)).sort()) {
    const instancePath = join(instances, name);
    const info = await lstat(instancePath);
    if (!info.isDirectory() && !info.isSymbolicLink()) continue;
    const instanceRoot = await checkedPath(instancePath, instances, "directory");
    const instanceDir = await optionalDirectory(join(instanceRoot, "agent"), instanceRoot);
    if (!instanceDir) continue;
    const configPath = await checkedPath(join(instanceDir, "instance.yaml"), instanceDir, "file");
    let config: unknown;
    try {
      config = parse(await readFile(configPath, "utf8"), { uniqueKeys: true, maxAliasCount: 100 });
    } catch (error) {
      throw new Error(`Invalid YAML in ${configPath}`, { cause: error });
    }
    if (!object(config)) throw new Error(`Invalid profile in ${configPath}`);
    const workflow = workflowFrom(config.workflow);
    const image = imageFrom(config.image);
    const preflightEnv = profileEnvironment(config.env, config.preflight);
    const { env: sandboxEnv, egress: sandboxEgress } = sandboxConfiguration(config.sandbox);
    const preflights = preflightsFrom(config.preflights, name);
    const schedule = scheduleFrom(config.schedule, name);
    const workflowBoundary = workflow.startsWith("./") ? instanceDir : botRoot;
    const workflowPath = workflow.startsWith("./")
      ? join(instanceDir, workflow.slice(2))
      : join(botRoot, "presets", "workflows", workflow);
    const workflowDir = await checkedPath(workflowPath, workflowBoundary, "directory");
    profiles.push({ name, configPath, botRoot, instanceDir, workflow, workflowDir, image, preflightEnv, sandboxEnv, ...(sandboxEgress === undefined ? {} : { sandboxEgress }), ...(preflights === undefined ? {} : { preflights }), ...(schedule === undefined ? {} : { schedule }) });
  }
  if (!profiles.length) throw new Error("No agent profiles found in checkout");
  return profiles;
}
