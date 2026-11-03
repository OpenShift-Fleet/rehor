import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

export interface ConfigRepository {
  name: string;
  url: string;
}

export interface ConfigRepositoryCheckout {
  name: string;
  revision: string;
  path: string;
}

const execFileAsync = promisify(execFile);
const pending = new Map<string, Promise<unknown>>();

// Never expose Git's stdout/stderr or its argument list in an error: Git may
// include private repository URLs or credentials supplied by helpers.
async function git(args: string[], cwd?: string, signal?: AbortSignal): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return result.stdout;
  } catch {
    throw new Error("Git repository synchronization failed");
  }
}

function repository(url: unknown): ConfigRepository {
  if (typeof url !== "string" || !url || /\s/.test(url)) {
    throw new Error("Invalid configuration repository URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid configuration repository URL");
  }
  if (!["https:", "ssh:"].includes(parsed.protocol) || !parsed.hostname ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Invalid configuration repository URL");
  }
  const name = basename(parsed.pathname.replace(/\/+$/, "")).replace(/\.git$/, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error("Invalid configuration repository name");
  }
  return { name, url };
}

/** Parse the configured JSON array. Repository names come from URL basenames. */
export function parseConfigRepositories(json: string): ConfigRepository[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Invalid configuration repository list");
  }
  if (!Array.isArray(value)) throw new Error("Invalid configuration repository list");
  const repositories = value.map(repository);
  if (new Set(repositories.map((item) => item.name)).size !== repositories.length) {
    throw new Error("Duplicate configuration repository name");
  }
  return repositories;
}

async function intact(path: string, revision: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const head = (await git(["rev-parse", "--verify", "HEAD"], path, signal)).trim();
    if (head !== revision) return false;
    const status = await git(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], path, signal);
    if (status) return false;
    const submodules = await git(["submodule", "status", "--recursive"], path, signal);
    return submodules.split("\n").every((line) => !line || line.startsWith(" "));
  } catch {
    return false;
  }
}

async function syncOne(root: string, item: ConfigRepository, signal?: AbortSignal): Promise<ConfigRepositoryCheckout> {
  const key = createHash("sha256").update(item.url).digest("hex");
  const directory = join(root, `${item.name}-${key}`);
  await mkdir(directory, { recursive: true });
  const remote = await git(["ls-remote", "--", item.url, "HEAD"], undefined, signal);
  const matches = remote.trim().match(/^([0-9a-f]{40}|[0-9a-f]{64})\s+HEAD$/);
  if (!matches) throw new Error("Unable to determine configuration repository HEAD");
  const revision = matches[1];
  const statePath = join(directory, "current.json");
  try {
    const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (typeof state === "object" && state !== null && "revision" in state && "snapshot" in state &&
        state.revision === revision && typeof state.snapshot === "string" && /^snapshot-[a-zA-Z0-9]+$/.test(state.snapshot)) {
      const path = join(directory, state.snapshot);
      if (await intact(path, revision, signal)) return { name: item.name, revision, path };
    }
  } catch {
    // Missing or invalid state is repaired by creating a new snapshot.
  }

  const path = await mkdtemp(join(directory, "snapshot-"));
  let published = false;
  let temporaryState: string | undefined;
  try {
    await git(["clone", "--no-checkout", "--", item.url, path], undefined, signal);
    await git(["checkout", "--detach", revision], path, signal);
    await git(["submodule", "update", "--init", "--recursive"], path, signal);
    if (!await intact(path, revision, signal)) throw new Error("Configuration repository checkout is incomplete");
    temporaryState = join(directory, `current-${randomUUID()}.tmp`);
    await writeFile(temporaryState, JSON.stringify({ revision, snapshot: basename(path) }), { flag: "wx" });
    await rename(temporaryState, statePath);
    published = true;
    return { name: item.name, revision, path };
  } finally {
    if (temporaryState) await rm(temporaryState, { force: true });
    if (!published) await rm(path, { recursive: true, force: true });
  }
}

/** Return immutable checkout paths. Published snapshots are never removed or updated here. */
export async function syncConfigRepositories(root: string, repositories: ConfigRepository[], signal?: AbortSignal): Promise<ConfigRepositoryCheckout[]> {
  // Revalidate caller-provided objects and reject aliases before any Git operation.
  const checked = parseConfigRepositories(JSON.stringify(repositories.map((item) => item.url)));
  if (checked.some((item, index) => item.name !== repositories[index].name)) {
    throw new Error("Invalid configuration repository name");
  }
  const absoluteRoot = resolve(root);
  return Promise.all(checked.map((item) => {
    const key = `${absoluteRoot}\0${item.url}`;
    const previous = pending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => syncOne(absoluteRoot, item, signal));
    pending.set(key, next);
    void next.finally(() => { if (pending.get(key) === next) pending.delete(key); }).catch(() => {});
    return next;
  }));
}
