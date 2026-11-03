import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { isForwardedPreflightVariable } from "./preflight-env.js";

export type AgentImage = { repository: string; tag: string; reference: string };

/** Paths are absolute and resolved within the checkout. Pass botRoot, workflow and
 * instanceDir to the work-preflight runner; preflight directories may be absent. */
export type AgentProfile = {
  name: string;
  configPath: string;
  botRoot: string;
  instanceDir: string;
  workflow: string;
  workflowDir: string;
  workflowPreflightDir?: string;
  instancePreflightDir?: string;
  image: AgentImage;
  preflightEnv: Record<string, string>;
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

async function preflightDirectory(path: string, root: string): Promise<string | undefined> {
  const dir = await optionalDirectory(path, root);
  if (dir) {
    // The runner follows symlinks when selecting scripts; verify their targets too.
    for (const name of await readdir(dir)) {
      if (name.endsWith(".py")) await checkedPath(join(dir, name), root, "file");
    }
  }
  return dir;
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
    if (!isForwardedPreflightVariable(name) || typeof setting !== "string" || !setting) {
      throw new Error("Invalid preflight environment");
    }
    env[name] = setting;
  }
  return env;
}

/** Discover every agent profile in one fixed checkout. Any invalid profile or
 * missing shared dependency rejects the entire result; no partial list escapes.
 * The checkout must remain unchanged until the caller finishes using paths. */
export async function discoverAgentProfiles(checkout: string): Promise<AgentProfile[]> {
  const root = await realpath(resolve(checkout));
  const instances = await checkedPath(join(root, "instance"), root, "directory");
  const botRoot = await checkedPath(join(root, "dev-bot"), root, "directory");
  await checkedPath(join(botRoot, "presets", "shared", "preflight"), botRoot, "directory");
  await checkedPath(join(botRoot, ".claude", "skills"), botRoot, "directory");
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
    const workflowBoundary = workflow.startsWith("./") ? instanceDir : botRoot;
    const workflowPath = workflow.startsWith("./")
      ? join(instanceDir, workflow.slice(2))
      : join(botRoot, "presets", "workflows", workflow);
    const workflowDir = await checkedPath(workflowPath, workflowBoundary, "directory");
    const workflowPreflightDir = await preflightDirectory(join(workflowDir, "preflight"), workflowBoundary);
    const instancePreflightDir = await preflightDirectory(join(instanceDir, "preflight"), instanceDir);
    profiles.push({ name, configPath, botRoot, instanceDir, workflow, workflowDir, workflowPreflightDir, instancePreflightDir, image, preflightEnv });
  }
  if (!profiles.length) throw new Error("No agent profiles found in checkout");
  return profiles;
}
