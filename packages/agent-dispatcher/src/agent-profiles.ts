import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import type { ZodIssue } from "zod";
import {
  objectEntrySchema,
  preflightEntrySchema,
  shorthandEntrySchema,
  type PreflightEntry,
} from "@rehor/preflights";
import { isInstancePreflightVariable } from "./preflight-env.js";

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
   * Parsed `preflights:` entries for the preflight engine (REHOR-259):
   * shorthand strings or `{ id, with }` objects, already shape-validated
   * against the package's entry schema. Registry-level validation (ids,
   * parameters) happens per run in the engine.
   */
  preflights?: PreflightEntry[];
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

function preflightEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!object(value) || Object.keys(value).some((key) => key !== "env") || !object(value.env)) {
    throw new Error("Invalid preflight environment");
  }
  const env: Record<string, string> = {};
  for (const [name, setting] of Object.entries(value.env)) {
    if (!isInstancePreflightVariable(name) || typeof setting !== "string" || !setting) {
      throw new Error("Invalid preflight environment");
    }
    env[name] = setting;
  }
  return env;
}

/**
 * Render a received value for a validation message. The values here are
 * declarative `instance.yaml` literals (never credentials), so short strings,
 * numbers and booleans are shown; anything structural is described by type
 * only, and env-derived values are never passed through here.
 */
function describeReceived(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") {
    const text = value.length > 60 ? `${value.slice(0, 57)}...` : value;
    return JSON.stringify(text);
  }
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

/** One issue, one stable line: `<profile>: preflights[i].with.label: <detail> (got <received>)`. */
function formatIssue(name: string, where: string, issue: ZodIssue, raw: unknown): string {
  const path = issue.path.length > 0 ? `${where}.${issue.path.map(String).join(".")}` : where;
  return `${name}: ${path}: ${issueDetail(issue)} (got ${describeReceived(receivedAt(raw, issue.path))})`;
}

/** The received value at an issue's path, read from the raw entry with
 * own-property lookups only (a missing key is `undefined`, never an
 * inherited member). Zod does not reliably attach the input to every issue
 * shape, so the path is walked on the raw YAML value instead. */
function receivedAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = raw;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    const record = current as Record<string, unknown>;
    current = Object.hasOwn(record, String(key)) ? record[String(key)] : undefined;
  }
  return current;
}

/** Strict `preflights:` parsing (REHOR-259): undefined passes through (the
 * field is omitted and the workflow's default set applies later), but any
 * malformed entry fails profile discovery — entries are never silently
 * dropped, and every failure names the instance and the exact entry,
 * parameter, and reason. Only the entry shape is checked here; id and
 * parameter validation against a registry happens per run in the preflight
 * engine. */
function preflightsFrom(value: unknown, name: string): PreflightEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${name}: preflights must be a list of preflight entries (got ${describeReceived(value)})`);
  }
  const entries: PreflightEntry[] = [];
  const problems: string[] = [];
  value.forEach((raw, index) => {
    const where = `preflights[${index}]`;
    const parsed = preflightEntrySchema.safeParse(raw);
    if (parsed.success) {
      entries.push(parsed.data);
      return;
    }
    // The entry union's collapsed issue carries no path; re-run the failing
    // branch for the precise per-parameter detail (same schemas, same data).
    const branch = typeof raw === "string"
      ? shorthandEntrySchema.safeParse(raw)
      : objectEntrySchema.safeParse(raw);
    const issues = !branch.success ? branch.error.issues : parsed.error.issues;
    for (const issue of issues) problems.push(formatIssue(name, where, issue, raw));
  });
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return entries;
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
    const preflightEnv = preflightEnvironment(config.preflight);
    const preflights = preflightsFrom(config.preflights, name);
    const workflowBoundary = workflow.startsWith("./") ? instanceDir : botRoot;
    const workflowPath = workflow.startsWith("./")
      ? join(instanceDir, workflow.slice(2))
      : join(botRoot, "presets", "workflows", workflow);
    const workflowDir = await checkedPath(workflowPath, workflowBoundary, "directory");
    profiles.push({ name, configPath, botRoot, instanceDir, workflow, workflowDir, image, preflightEnv, ...(preflights === undefined ? {} : { preflights }) });
  }
  if (!profiles.length) throw new Error("No agent profiles found in checkout");
  return profiles;
}
