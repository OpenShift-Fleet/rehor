import { z } from "zod";
import type { PreflightExecutionResult } from "../../core/results.js";
import {
  appendFetchEvidence,
  FetchTracker,
  totalFetchFailureError,
} from "../../shared/failure-policy.js";
import type { GhOpenPr, GitHubClient } from "../../shared/github.js";
import { defineGitHubPreflight } from "../../shared/github.js";
import type { MemoryServerClient } from "../../shared/memory-server.js";
import { ACTIVE_TASK_STATUSES } from "../../shared/memory-server.js";
import type { ProjectReposMap } from "../../shared/repos.js";
import { upstreamRepo } from "../../shared/repos.js";

/**
 * `fabric-konflux-bot-prs` — the port of the Fabric Access konflux-pr-squash
 * workflow's preflight (`agent/workflows/konflux-pr-squash/preflight/
 * 02-check-bot-prs.py` in the instance repo): find repos with open
 * major-tier dependency PRs from the Konflux bot that need consolidating.
 *
 * Behavior parity with the Python script, with the agreed adaptations:
 *
 * - `BOT_AUTHOR` (default `red-hat-konflux[bot]`) becomes the `bot_author`
 *   input parameter; the `konflux-pr-squash:` task key prefix, the
 *   do-not-merge label and abandoned-title filters, the failed
 *   on-pull-request pipeline detection, the default-branch gating, and the
 *   tier classification (diff versions first, then title, then body) are
 *   ported verbatim as constants and helpers.
 * - The `gh` subprocesses become the package's GitHub client on the
 *   auth-proxy route. The Python swallowed listing, default-branch, and
 *   diff failures (returning `[]`, `""`, or `None`); the port keeps the
 *   hcc/obsint reading of that pattern instead: an isolated failure skips
 *   the repo/PR with recorded evidence, and a run where every attempted
 *   fetch of a class failed escalates to an `error` naming the required
 *   route. The consolidation-PR check keeps the Python's explicit
 *   fail-closed semantics (an unverifiable repo is treated as having an
 *   open consolidation PR and skipped) with the outage escalation on top.
 * - The Python printed per-repo/per-PR skips to stderr only; the port
 *   appends them to the result content so the cycle report shows them.
 * - One ported detail preserved exactly: the already-active gate matches
 *   task keys by `startsWith("konflux-pr-squash:<owner/repo>")` with no
 *   delimiter, so a task for `org/repo-2` also matches `org/repo` — the
 *   Python behavior. It can only over-skip (defense), never duplicate.
 */

/** Task key prefix — this workflow's per-repo consolidation tasks. */
const TASK_KEY_PREFIX = "konflux-pr-squash:";

export const FABRIC_KONFLUX_BOT_PRS_INPUT = z.strictObject({
  /**
   * GitHub login whose open PRs are consolidation candidates (the Python
   * `BOT_AUTHOR`).
   */
  bot_author: z.string().default("red-hat-konflux[bot]"),
});

export type FabricKonfluxBotPrsParams = z.infer<typeof FABRIC_KONFLUX_BOT_PRS_INPUT>;

/** Dependencies of the ported `main()` flow, injectable for tests. */
export interface FabricKonfluxBotPrsDeps {
  readonly memory: MemoryServerClient;
  readonly github: GitHubClient;
  readonly repos: ProjectReposMap;
}

/** One repo's eligible PRs, in the Python `repos_with_prs` entry shape. */
export interface KonfluxRepoEntry {
  readonly repo: string;
  readonly bot_url: string;
  readonly pr_count: number;
  readonly prs: readonly { number: number; title: string; branch: string }[];
  readonly groups: readonly { ecosystem: string; tier: string; pr_count: number }[];
  readonly task_key: string;
}

/** One consolidatable group — a solo major-tier PR (the Python shape). */
interface KonfluxPrGroup {
  readonly ecosystem: string;
  readonly tier: string;
  readonly prs: readonly GhOpenPr[];
}

// --- pure classification helpers (ported verbatim) ---

/** Manifest file names per ecosystem — the Python `_MANIFEST_FILES`. */
const MANIFEST_FILES: Readonly<Record<string, readonly string[]>> = {
  python: ["Pipfile"],
  npm: ["package.json"],
  go: ["go.mod"],
};

/**
 * A version token — `{1,3}` (not {1,2}) so 4-segment versions like the
 * date-suffixed stub packages match as one token instead of truncating at
 * the third segment (the Python comment: a truncated match makes old/new
 * compare equal when the build segment changed, silently dropping the
 * bump).
 */
const VERSION_TOKEN_SOURCE = "v?\\d+(?:\\.\\d+){1,3}(?:[-+][\\w.-]+)?";
const VERSION_TOKEN_RE = new RegExp(VERSION_TOKEN_SOURCE);

/** Parsed version — the Python `_version` tuple. */
export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly build: number;
}

/** Parse a version string, or null — the Python `_version`. */
export function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:[-+][\w.-]+)?$/.exec(value);
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    build: match[4] === undefined ? 0 : Number(match[4]),
  };
}

/**
 * The ecosystems of the dependency manifests a diff touches — the Python
 * `_changed_manifest_ecosystems`: every `diff --git` header's b-side path
 * matched against the manifest file names.
 */
export function changedManifestEcosystems(patch: string): Set<string> {
  const changed = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("diff --git ")) {
      continue;
    }
    // Python: line.split(" b/", 1)[-1] — everything after the FIRST " b/"
    // separator, so a path containing " b/" is not split again.
    const separator = line.indexOf(" b/");
    const path = separator === -1 ? line : line.slice(separator + " b/".length);
    for (const [ecosystem, names] of Object.entries(MANIFEST_FILES)) {
      if (names.some((name) => path.endsWith(name))) {
        changed.add(ecosystem);
      }
    }
  }
  return changed;
}

/**
 * Common named HTML entities — a scoped stand-in for Python's
 * `html.unescape` (which knows the whole HTML5 table). Renovate/Mintmaker
 * bodies only need these plus the numeric forms the decoder below handles;
 * an unknown entity is left untouched rather than guessed.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity] ?? whole;
  });
}

/**
 * The (old, new) version pair from a bot PR body, if present — the Python
 * `_body_versions`. Bodies are often raw HTML with entities (`<code>1.2.3
 * </code> -&gt; <code>1.4.0</code>`), so tags are stripped and entities
 * decoded before the patterns run.
 */
const BODY_VERSION_PATTERNS: readonly RegExp[] = [
  new RegExp(`\`(${VERSION_TOKEN_SOURCE})\`\\s*(?:->|→)\\s*\`(${VERSION_TOKEN_SOURCE})\``, "i"),
  new RegExp(`(${VERSION_TOKEN_SOURCE})\\s*(?:->|→)\\s*(${VERSION_TOKEN_SOURCE})`, "i"),
  new RegExp(`\\bfrom\\s+(${VERSION_TOKEN_SOURCE})\\s+to\\s+(${VERSION_TOKEN_SOURCE})\\b`, "i"),
];

export function bodyVersions(body: string | null): readonly [string, string] | null {
  if (!body) {
    return null;
  }
  const text = decodeHtmlEntities(body.replace(/<[^>]+>/g, " "));
  for (const pattern of BODY_VERSION_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) {
      return [match[1], match[2]];
    }
  }
  return null;
}

/**
 * The (old, new) versions from the PR's manifest diff — the Python
 * `_diff_versions_from_patch`: the first removed and first added version
 * token inside the ecosystem's manifest hunk.
 */
export function diffVersionsFromPatch(
  patch: string | null,
  ecosystem: string,
): readonly [string, string] | null {
  const manifestNames = MANIFEST_FILES[ecosystem];
  if (manifestNames === undefined || !patch) {
    return null;
  }
  let inManifest = false;
  let oldVersion: string | null = null;
  let newVersion: string | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      inManifest = manifestNames.some((name) => line.trimEnd().endsWith(name));
      continue;
    }
    if (!inManifest) {
      continue;
    }
    if (oldVersion === null && line.startsWith("-") && !line.startsWith("---")) {
      const match = VERSION_TOKEN_RE.exec(line);
      if (match !== null) {
        oldVersion = match[0];
      }
    } else if (newVersion === null && line.startsWith("+") && !line.startsWith("+++")) {
      const match = VERSION_TOKEN_RE.exec(line);
      if (match !== null) {
        newVersion = match[0];
      }
    }
    if (oldVersion !== null && newVersion !== null) {
      break;
    }
  }
  if (oldVersion !== null && newVersion !== null) {
    return [oldVersion, newVersion];
  }
  return null;
}

/** The (family, major) pair of a Go module path — `/vN` (N≥2) splits off. */
function goModulePathFamily(modulePath: string): readonly [string, number] {
  const match = /^(.+)\/v(\d+)$/.exec(modulePath);
  if (match !== null && Number(match[2]) >= 2) {
    return [match[1], Number(match[2])];
  }
  return [modulePath, 1];
}

/**
 * Detect replace directives moved from one major module path to another —
 * the Python `_go_replace_major_path_migration`: dropping a replace for
 * `example.org/module` does not apply to the distinct module
 * `example.org/module/v2` and can undo a pinned transitive fix.
 */
export function goReplaceMajorPathMigration(patch: string): boolean {
  const removed: [string, string][] = [];
  const added: [string, string][] = [];
  let goModPath: string | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const separator = line.indexOf(" b/");
      const candidatePath = separator === -1 ? line : line.slice(separator + " b/".length);
      goModPath = candidatePath.endsWith("go.mod") ? candidatePath : null;
      continue;
    }
    if (
      goModPath === null ||
      line.startsWith("---") ||
      line.startsWith("+++") ||
      (!line.startsWith("-") && !line.startsWith("+"))
    ) {
      continue;
    }
    let change = line.slice(1).trim();
    if (change.startsWith("replace ")) {
      change = change.slice("replace ".length);
    }
    const match = /^(\S+)\s*=>\s*(\S+)(?:\s+\S+)?$/.exec(change);
    if (match === null) {
      continue;
    }
    const [, modulePath, replacementPath] = match;
    if (modulePath !== replacementPath) {
      continue;
    }
    (line.startsWith("-") ? removed : added).push([goModPath, modulePath]);
  }
  for (const [oldFile, oldPath] of removed) {
    const [oldFamily, oldMajor] = goModulePathFamily(oldPath);
    for (const [newFile, newPath] of added) {
      if (oldFile !== newFile) {
        continue;
      }
      const [newFamily, newMajor] = goModulePathFamily(newPath);
      if (oldFamily === newFamily && newMajor > oldMajor) {
        return true;
      }
    }
  }
  return false;
}

/** The bump tier of an old/new version pair — the Python `_tier_from_versions`. */
export function tierFromVersions(old: string, newVersion: string): string | null {
  const oldParsed = parseVersion(old);
  const newParsed = parseVersion(newVersion);
  if (oldParsed === null || newParsed === null) {
    return null;
  }
  if (
    oldParsed.major !== newParsed.major ||
    (oldParsed.major === 0 && oldParsed.minor !== newParsed.minor)
  ) {
    return "major";
  }
  if (oldParsed.minor !== newParsed.minor) {
    return "minor";
  }
  if (oldParsed.patch !== newParsed.patch || oldParsed.build !== newParsed.build) {
    return "patch";
  }
  return null;
}

/**
 * Classify the bump tier, preferring the real diff versions over
 * title/body prose — the Python `_tier`. Every "major" branch is backed by
 * an explicit breaking-change signal, an explicit old/new pair, or an
 * explicit module-path change; a 0.x target with no known source version
 * returns "major_unconfirmed" instead (acted on solo only with more
 * confidence elsewhere).
 */
export function classifyTier(
  title: string,
  body: string,
  diffVersions: readonly [string, string] | null,
): string {
  const titleLower = title.toLowerCase();
  if (/(?:^|[\s(:])[^\s:]+!:/.test(titleLower) || titleLower.includes("breaking")) {
    return "major";
  }
  if (titleLower.includes("digest") || titleLower.includes("sha")) {
    return "patch";
  }
  const pathBump = /\/v(\d+)\b.*?\bto\s+v?(\d+)/.exec(titleLower);
  if (pathBump !== null && pathBump[1] !== pathBump[2]) {
    return "major";
  }
  if (diffVersions !== null) {
    const tier = tierFromVersions(diffVersions[0], diffVersions[1]);
    if (tier !== null) {
      return tier;
    }
  }
  const versions = titleLower.match(new RegExp(VERSION_TOKEN_SOURCE, "g")) ?? [];
  if (versions.length >= 2) {
    const tier = tierFromVersions(versions[versions.length - 2], versions[versions.length - 1]);
    if (tier !== null) {
      return tier;
    }
  }
  const fromBody = bodyVersions(body);
  if (fromBody !== null) {
    const tier = tierFromVersions(fromBody[0], fromBody[1]);
    if (tier !== null) {
      return tier;
    }
  }
  // 0.x target bumps are breaking by project policy, but with no source
  // version to confirm against this is a guess — "major_unconfirmed".
  const parsed = versions.map((value) => parseVersion(value));
  const last = parsed.at(-1);
  if (last !== undefined && last !== null && last.major === 0) {
    return "major_unconfirmed";
  }
  return "unknown";
}

/** Infer the ecosystem from changed manifests, then the PR title — the Python `_ecosystem`. */
export function ecosystemOf(title: string, patch: string | null): string {
  if (patch) {
    const manifestEcosystems = changedManifestEcosystems(patch);
    if (manifestEcosystems.size === 1) {
      return [...manifestEcosystems][0];
    }
  }
  const titleLower = title.toLowerCase();
  if (
    titleLower.includes("github.com/") ||
    titleLower.includes("golang.org/") ||
    titleLower.includes("module ")
  ) {
    return "go";
  }
  if (["npm", "node", "package.json", "yarn", "pnpm"].some((token) => titleLower.includes(token))) {
    return "npm";
  }
  return "python";
}

/**
 * Whether GitHub reports a failed on-pull-request pipeline — the Python
 * `_has_failed_pr_pipeline`: a rollup entry whose name (or context)
 * contains "on-pull-request" with conclusion/state FAILURE or ERROR.
 */
export function hasFailedOnPullRequestPipeline(pr: GhOpenPr): boolean {
  for (const check of pr.statusCheckRollup ?? []) {
    const name = (check.name || check.context || "").toLowerCase();
    const result = (check.conclusion || check.state || "").toUpperCase();
    if (name.includes("on-pull-request") && (result === "FAILURE" || result === "ERROR")) {
      return true;
    }
  }
  return false;
}

/** The Python `find_bot_prs` filter: do-not-merge labels and abandoned titles. */
export function isSkippableBotPr(pr: GhOpenPr): boolean {
  const labels = pr.labels.map((label) => label.toLowerCase());
  if (labels.some((label) => label.includes("do not merge") || label.includes("do-not-merge"))) {
    return true;
  }
  return (pr.title ?? "").toLowerCase().includes("abandoned");
}

/**
 * Whether an open consolidation PR already exists — the Python
 * `has_open_consolidation_pr` post-filter: the title search results are
 * kept only when the title starts with the consolidation prefix or the
 * head branch is a consolidation branch.
 */
export function isConsolidationPr(pr: GhOpenPr): boolean {
  return (
    (pr.title ?? "").startsWith("chore(deps): consolidate") ||
    (pr.headRefName ?? "").startsWith("chore/consolidate-")
  );
}

// --- the ported main() flow ---

/**
 * The Python `_consolidatable_groups`: one solo group per major-tier PR.
 * Minor and patch bumps are excluded entirely; majors are never combined.
 * The diff is fetched once per PR and shared by the version, manifest, and
 * Go replace checks.
 */
async function consolidatableGroups(
  github: GitHubClient,
  ownerRepo: string,
  prs: readonly GhOpenPr[],
  diffTracker: FetchTracker,
  skipReasons: string[],
): Promise<KonfluxPrGroup[]> {
  const groups: KonfluxPrGroup[] = [];
  for (const pr of prs) {
    const title = pr.title ?? "";
    let patch: string | null = null;
    try {
      patch = await github.getPrDiff(ownerRepo, pr.number);
      diffTracker.recordSuccess();
    } catch (error) {
      // Isolated diff failure: the Python `_fetch_pr_diff` degraded to
      // None (title/body-only classification); the port records the
      // failure as evidence and escalates only a total outage.
      diffTracker.recordFailure(`${ownerRepo}#${pr.number}`, error);
      patch = null;
    }
    const ecosystem = ecosystemOf(title, patch);
    if (patch !== null && changedManifestEcosystems(patch).size === 0) {
      skipReasons.push(`Skipping PR #${pr.number}: diff changes no supported dependency manifest`);
      continue;
    }
    if (ecosystem === "go" && patch && goReplaceMajorPathMigration(patch)) {
      skipReasons.push(
        `Skipping PR #${pr.number}: Go replace directive changes to a new major ` +
          "module path; transitive dependency review required",
      );
      continue;
    }
    const diffVersions = diffVersionsFromPatch(patch, ecosystem);
    const tier = classifyTier(title, pr.body ?? "", diffVersions);
    if (tier === "major") {
      groups.push({ ecosystem, tier: "major", prs: [pr] });
    }
  }
  return groups;
}

/**
 * The ported `main()` flow: capacity gate, per-repo bot-PR scan with
 * already-active and open-consolidation gating, non-default-branch and
 * failed-pipeline filtering, then the major-tier grouping.
 */
export async function runFabricKonfluxBotPrs(
  deps: FabricKonfluxBotPrsDeps,
  params: FabricKonfluxBotPrsParams,
): Promise<PreflightExecutionResult> {
  // Phase 1: task system — capacity from the shared count, the active list
  // for the per-repo already-in-progress gate.
  const tasks = await deps.memory.getTasks();
  const capacity = await deps.memory.getCapacity();
  const active = tasks.filter((task) => ACTIVE_TASK_STATUSES.includes(task?.status ?? ""));
  if (capacity.active >= capacity.max) {
    return { status: "skip", content: `At capacity (${capacity.active}/${capacity.max})` };
  }

  // Phase 2: repos from the instance map.
  const repoNames = Object.keys(deps.repos);
  if (repoNames.length === 0) {
    return { status: "skip", content: "No repos found in project-repos.json" };
  }

  const listTracker = new FetchTracker();
  const consolidationTracker = new FetchTracker();
  const defaultBranchTracker = new FetchTracker();
  const diffTracker = new FetchTracker();
  const reposWithPrs: KonfluxRepoEntry[] = [];
  const skipReasons: string[] = [];

  // Phase 3: check each repo for consolidatable bot PRs.
  for (const repoName of repoNames) {
    const { upstreamPath, host } = upstreamRepo(repoName, deps.repos);
    if (upstreamPath === "" || host !== "github") {
      continue;
    }

    const taskKey = `${TASK_KEY_PREFIX}${upstreamPath}`;
    // Python: external_key.startswith(task_key) — prefix match with no
    // delimiter, preserved exactly (see the module doc).
    const alreadyActive = active.some(
      (task) => typeof task.external_key === "string" && task.external_key.startsWith(taskKey),
    );
    if (alreadyActive) {
      skipReasons.push(`  Skipping ${upstreamPath}: consolidation already in progress`);
      continue;
    }

    // Defense-in-depth check independent of the task system: the
    // de-duping task is only recorded after the consolidated PR is pushed,
    // so a crash in between leaves no trace there. Unverifiable repos are
    // treated as having an open consolidation PR (the Python's explicit
    // fail-closed) and skipped.
    let consolidationOpen: boolean;
    try {
      const openPrs = await deps.github.listOpenPrs(upstreamPath, {
        search: "chore(deps): consolidate in:title",
      });
      consolidationTracker.recordSuccess();
      consolidationOpen = openPrs.some(isConsolidationPr);
    } catch (error) {
      consolidationTracker.recordFailure(upstreamPath, error);
      consolidationOpen = true;
    }
    if (consolidationOpen) {
      skipReasons.push(`  Skipping ${upstreamPath}: an open consolidation PR already exists`);
      continue;
    }

    let prs: readonly GhOpenPr[];
    try {
      const openPrs = await deps.github.listOpenPrs(upstreamPath, {
        author: params.bot_author,
      });
      listTracker.recordSuccess();
      prs = openPrs.filter((pr) => !isSkippableBotPr(pr));
    } catch (error) {
      // Isolated listing failure: skip this repo, keep scanning.
      listTracker.recordFailure(upstreamPath, error);
      continue;
    }

    if (prs.length > 0) {
      let defaultBranch: string;
      try {
        defaultBranch = await deps.github.getDefaultBranch(upstreamPath);
        defaultBranchTracker.recordSuccess();
      } catch (error) {
        defaultBranchTracker.recordFailure(upstreamPath, error);
        defaultBranch = "";
      }
      if (defaultBranch === "") {
        skipReasons.push(`Skipping ${upstreamPath}: unable to determine default branch`);
        continue;
      }

      const nonDefault = prs.filter((pr) => (pr.baseRefName ?? "") !== defaultBranch);
      if (nonDefault.length > 0) {
        const branches = [...new Set(nonDefault.map((pr) => pr.baseRefName || "(unknown)"))].sort();
        skipReasons.push(
          `Skipping ${nonDefault.length} bot PR(s) in ${upstreamPath} targeting ` +
            `non-default branch(es): ${branches.join(", ")} (default: ${defaultBranch})`,
        );
      }
      prs = prs.filter((pr) => (pr.baseRefName ?? "") === defaultBranch);

      const failedPipeline = prs.filter(hasFailedOnPullRequestPipeline);
      if (failedPipeline.length > 0) {
        const numbers = failedPipeline.map((pr) => String(pr.number)).join(", ");
        skipReasons.push(
          `Skipping bot PR(s) in ${upstreamPath} with failed on-pull-request checks: ${numbers}`,
        );
      }
      prs = prs.filter((pr) => !hasFailedOnPullRequestPipeline(pr));
    }

    const groups = await consolidatableGroups(
      deps.github,
      upstreamPath,
      prs,
      diffTracker,
      skipReasons,
    );
    if (groups.length > 0) {
      const eligiblePrs = groups.flatMap((group) => group.prs);
      const entry = deps.repos[repoName];
      const botUrl = typeof entry?.url === "string" ? entry.url : "";
      reposWithPrs.push({
        repo: upstreamPath,
        bot_url: botUrl,
        pr_count: eligiblePrs.length,
        prs: eligiblePrs.map((pr) => ({
          number: pr.number,
          title: pr.title ?? "",
          branch: pr.headRefName ?? "",
        })),
        groups: groups.map((group) => ({
          ecosystem: group.ecosystem,
          tier: group.tier,
          pr_count: group.prs.length,
        })),
        task_key: taskKey,
      });
    }
  }

  // The failure policy: a total inability of any fetch class is an
  // execution error naming the required route, never a silent skip.
  const trackers: readonly (readonly [FetchTracker, string])[] = [
    [listTracker, "bot-PR list"],
    [consolidationTracker, "consolidation-PR check"],
    [defaultBranchTracker, "default-branch lookup"],
    [diffTracker, "PR diff"],
  ];
  for (const [tracker, noun] of trackers) {
    const outage = totalFetchFailureError(tracker, {
      system: "GitHub",
      noun,
      route: deps.github.route,
    });
    if (outage !== null) {
      throw outage;
    }
  }

  if (reposWithPrs.length === 0) {
    let content = `No repos with open major-tier PRs from ${params.bot_author}`;
    if (skipReasons.length > 0) {
      content += `\n${skipReasons.join("\n")}`;
    }
    return { status: "skip", content: appendFetchEvidence(content, trackers) };
  }

  // The payload is the Python's json.dumps({bot_author, repos}) shape;
  // skip reasons follow the JSON so the payload stays extractable.
  let content = JSON.stringify({ bot_author: params.bot_author, repos: reposWithPrs });
  if (skipReasons.length > 0) {
    content += `\n\nSkipped:\n${skipReasons.join("\n")}`;
  }
  return { status: "start", content: appendFetchEvidence(content, trackers) };
}

/**
 * The registered preflight — the shared GitHub-preflight factory
 * (`defineGitHubPreflight`) wires the run context into the flow: the GitHub
 * client is built from the run's auth-proxy route and the repo map comes
 * from the instance config; any failure — including an unwired proxy route
 * — surfaces as an `error` result, never a silent skip.
 */
export const fabricKonfluxBotPrs = defineGitHubPreflight({
  id: "fabric-konflux-bot-prs",
  input: FABRIC_KONFLUX_BOT_PRS_INPUT,
  run: runFabricKonfluxBotPrs,
});
