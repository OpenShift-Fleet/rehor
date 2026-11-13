import { readFile } from "node:fs/promises";

/**
 * `project-repos.json` helpers — the port of the repo-matching half of the
 * Python `common.py`. The map is instance-specific configuration the
 * dispatcher materializes per run; loading degrades to an empty map on any
 * error, exactly like the Python `load_project_repos`.
 */

export interface ProjectRepoEntry {
  readonly url?: string;
  readonly upstream?: string;
  readonly host?: string;
  readonly [field: string]: unknown;
}

export type ProjectReposMap = Readonly<Record<string, ProjectRepoEntry>>;

/** Result of resolving a repo name to its upstream path and git host. */
export interface RepoResolution {
  readonly upstreamPath: string;
  readonly host: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Define an own data property. Unlike assignment this is immune to the
 * `__proto__` setter trap: a key named `__proto__` becomes plain own data
 * (exactly like a Python dict key) instead of replacing the prototype.
 */
const defineOwn = <V>(target: Record<string, V>, key: string, value: V): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

/**
 * Parse `project-repos.json` content. Returns an empty map when the content
 * is unreadable, invalid JSON, or not an object — never throws. An own
 * `__proto__` key in the JSON is preserved as ordinary data.
 */
export function parseProjectRepos(text: string): ProjectReposMap {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(data)) return {};
  const repos: Record<string, ProjectRepoEntry> = {};
  for (const [key, value] of Object.entries(data)) {
    defineOwn(repos, key, isRecord(value) ? (value as ProjectRepoEntry) : {});
  }
  return repos;
}

/** Load the instance `project-repos.json`; degrades to `{}` on any error. */
export async function loadProjectRepos(path: string | URL): Promise<ProjectReposMap> {
  try {
    return parseProjectRepos(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Build the repo name lookup: bare names and `org/repo` paths (derived from
 * each entry's upstream) both resolve to the canonical map key. Keys are
 * defined as own data properties, so a repo literally named `__proto__`
 * survives as data instead of polluting the map's prototype.
 */
export function buildRepoLookup(repos: ProjectReposMap): Record<string, string> {
  const lookup: Record<string, string> = {};
  for (const [key, entry] of Object.entries(repos)) {
    defineOwn(lookup, key, key);
    const upstream = entry?.upstream ?? "";
    const parts = upstream
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .split("/");
    if (parts.length >= 2) {
      defineOwn(lookup, `${parts[parts.length - 2]}/${parts[parts.length - 1]}`, key);
    }
  }
  return lookup;
}

/**
 * Canonical repo keys for every `repo:` label, or `[]` when any label is
 * unmatched or no `repo:` label is present — the Python fail-closed match.
 * Lookups are own-property only, so a label naming an inherited object
 * property (`repo:toString` and friends) is simply unmatched, exactly like
 * a key absent from a Python dict.
 */
export function matchRepoLabels(
  labels: readonly string[],
  repoLookup: Record<string, string>,
): string[] {
  const repoLabels = labels
    .filter((label) => label.startsWith("repo:"))
    .map((label) => label.replaceAll("repo:", ""));
  if (repoLabels.length === 0) return [];
  const matched = repoLabels
    .filter((repo) => Object.hasOwn(repoLookup, repo))
    .map((repo) => repoLookup[repo]);
  return matched.length === repoLabels.length ? matched : [];
}

/** Extract `org/repo` from an https or scp-like git URL. */
export function parseRepoPath(url: string): string {
  if (url.includes(":") && url.includes("@")) {
    return url.split(":").at(-1)?.replaceAll(".git", "") ?? "";
  }
  return url.split("/").slice(-2).join("/").replaceAll(".git", "");
}

/**
 * Resolve a repo name to `(upstreamPath, host)`. A qualified `org/repo`
 * (or host-qualified) name passes through with the host inferred from the
 * name; a bare name resolves through the project-repos map, including
 * basename suffix matches against keys and upstreams.
 */
export function upstreamRepo(repoName: string, repos: ProjectReposMap): RepoResolution {
  if (repoName.includes("/")) {
    return {
      upstreamPath: repoName,
      host: repoName.toLowerCase().includes("gitlab") ? "gitlab" : "github",
    };
  }
  // Own-property lookup only: a plain-object map passed by a caller must not
  // resolve inherited members (`toString` and friends) to functions.
  let entry: ProjectRepoEntry | undefined = Object.hasOwn(repos, repoName)
    ? repos[repoName]
    : undefined;
  if (entry === undefined || Object.keys(entry).length === 0) {
    const suffix = `/${repoName}`;
    for (const [key, candidate] of Object.entries(repos)) {
      if (key.endsWith(suffix)) {
        entry = candidate;
        break;
      }
      const upstream = candidate.upstream ?? "";
      if (upstream !== "" && parseRepoPath(upstream).endsWith(suffix)) {
        entry = candidate;
        break;
      }
    }
  }
  const resolved = entry ?? {};
  const upstream = resolved.upstream ?? "";
  if (upstream === "") {
    return { upstreamPath: "", host: resolved.host ?? "github" };
  }
  const hostname = hostnameOf(upstream.includes("://") ? upstream : `ssh://${upstream}`);
  if (hostname === "github.com") {
    return { upstreamPath: parseRepoPath(upstream), host: "github" };
  }
  if (hostname === "gitlab.com" || hostname === "gitlab.cee.redhat.com") {
    return { upstreamPath: parseRepoPath(upstream), host: "gitlab" };
  }
  return { upstreamPath: parseRepoPath(upstream), host: resolved.host ?? "github" };
}

/**
 * Hostname of a git remote URL. `new URL` handles https and ssh with numeric
 * ports; scp-like remotes (`git@host:path`) become `ssh://git@host:path`
 * after the scheme is prepended, whose non-numeric "port" WHATWG URL rejects
 * — those take the manual authority parse (matching Python's urlparse, which
 * tolerates them).
 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // fall through to the manual parse
  }
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(url);
  if (match === null) return "";
  let authority = match[1];
  const userInfo = authority.lastIndexOf("@");
  if (userInfo >= 0) authority = authority.slice(userInfo + 1);
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return (end === -1 ? authority : authority.slice(1, end)).toLowerCase();
  }
  const port = authority.indexOf(":");
  if (port >= 0) authority = authority.slice(0, port);
  return authority.toLowerCase();
}
