import { z } from "zod";
import type { PreflightExecutionResult } from "../../core/results.js";
import {
  appendFetchEvidence,
  FetchTracker,
  totalFetchFailureError,
} from "../../shared/failure-policy.js";
import type { GitHubClient } from "../../shared/github.js";
import { defineGitHubPreflight } from "../../shared/github.js";
import type { MemoryServerClient } from "../../shared/memory-server.js";
import {
  countActiveTasksWithPrefix,
  dailyTaskKey,
  findTaskByKey,
} from "../../shared/memory-server.js";
import type { ProjectReposMap } from "../../shared/repos.js";
import { upstreamRepo } from "../../shared/repos.js";
import { nonBlank } from "../../shared/strings.js";

/**
 * `hcc-test-anti-pattern-scan` — the port of the hcc-framework-agent-dev
 * quality-monitor preflight `02-scan-test-anti-patterns.py` (test file
 * discovery for anti-pattern analysis).
 *
 * Lists the file tree of the first `max_repos_per_scan` whitelisted
 * GitHub-hosted repos, matches test files by suffix patterns (excluding
 * configured substrings, capped at `max_files_per_repo`), detects the
 * test framework from indicator files, and emits the compact per-repo file
 * list the agent analyzes. `start` when any test files were found, `skip`
 * otherwise.
 *
 * Behavior parity with the Python script, with the agreed adaptations:
 *
 * - The Python 24h cycle-sleep is replaced by the same deterministic daily
 *   task gate as `hcc-merged-pr-violations`: one scan per UTC day, keyed
 *   by the `${task_prefix}-{date}` task the start content tells the agent
 *   to create. A task with that external_key — any status — means today
 *   was already scanned.
 * - The `test-config.yaml` shape (whitelist, limits, patterns, framework
 *   indicators, excludes) becomes flattened input parameters with the same
 *   defaults; the Python's repo-specific config overrides and brace
 *   expansion are not ported (no instance used them).
 * - The Python's glob machinery collapses to its effective simplified
 *   matcher: a pattern matches a file when the pattern stripped of its
 *   double-star directory prefix and a leading `*` is a suffix of the file
 *   path — the default `.spec.ts` pattern matches any path ending
 *   `.spec.ts`, wherever it sits in the tree.
 * - The `gh api` tree listing becomes the package's GitHub client on the
 *   auth-proxy route, under the shared failure policy: a listing failure
 *   skips that repo and is tallied; when every attempted listing failed,
 *   the run escalates to an `error` naming the required route. Tolerated
 *   failures are recorded as UNFETCHABLE evidence.
 */

export const HCC_TEST_ANTI_PATTERN_SCAN_INPUT = z.strictObject({
  /**
   * Restrict the scan to these repo names (the Python `test-config.yaml`
   * `scan_only_repos` whitelist). Required: this scan is intentionally
   * scoped, never fleet-wide.
   */
  scan_only_repos: z
    .array(z.string().refine(nonBlank, { message: "repo name must not be blank" }))
    .min(1),
  /** Repos scanned per run (Python `DEFAULT_MAX_REPOS_PER_SCAN`). */
  max_repos_per_scan: z.number().int().positive().default(3),
  /** Test files analyzed per repo (Python `MAX_TEST_FILES_PER_REPO`). */
  max_files_per_repo: z.number().int().positive().default(20),
  /** Prefix of the deterministic daily task (Python external_key prefix). */
  task_prefix: z.string().default("test-scan"),
  /** Test file patterns, simplified-suffix matched (see the module doc). */
  patterns: z
    .array(z.string().refine(nonBlank, { message: "pattern must not be blank" }))
    .default(["**/*.spec.ts", "**/*.test.ts"]),
  /** File-path substrings that mark a repo as using that framework. */
  framework_indicators: z
    .array(z.string().refine(nonBlank, { message: "indicator must not be blank" }))
    .default(["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]),
  /** Path substrings that exclude a file from the match. */
  exclude_substrings: z
    .array(z.string().refine(nonBlank, { message: "exclude must not be blank" }))
    .default([
      "node_modules/",
      "dist/",
      "build/",
      ".playwright/",
      "playwright-report/",
      "test-results/",
    ]),
});

export type HccTestAntiPatternScanParams = z.infer<typeof HCC_TEST_ANTI_PATTERN_SCAN_INPUT>;

/** Python `MAX_CONCURRENT_SCANS` — kept a constant, like the source. */
const MAX_CONCURRENT_SCANS = 5;

/** One repo's scan result: the matched test files and the detected framework. */
export interface RepoTestScan {
  /** Project-repos map key (the instance-facing repo name). */
  readonly repo: string;
  readonly files: readonly string[];
  readonly framework: string;
}

/** Dependencies of the ported `main()` flow, injectable for tests. */
export interface HccTestAntiPatternScanDeps {
  readonly memory: MemoryServerClient;
  readonly github: GitHubClient;
  readonly repos: ProjectReposMap;
  /** Injectable clock so tests can fix the day. */
  readonly now?: () => Date;
}

/**
 * The Python matcher's simplified glob: strip every double-star directory
 * prefix (and then any leading `*`) from the pattern, and match the
 * remainder as a path suffix — the default `.spec.ts` pattern matches any
 * path ending `.spec.ts`.
 */
export function patternMatchesFile(pattern: string, file: string): boolean {
  let simple = pattern.replaceAll("**/", "");
  while (simple.startsWith("*")) {
    simple = simple.slice(1);
  }
  return simple !== "" && file.endsWith(simple);
}

/**
 * The ported `main()` flow: capacity gate, deterministic daily task gate,
 * concurrency gate, then per-repo file-tree scanning.
 */
export async function runHccTestAntiPatternScan(
  deps: HccTestAntiPatternScanDeps,
  params: HccTestAntiPatternScanParams,
): Promise<PreflightExecutionResult> {
  const now = deps.now?.() ?? new Date();

  // Capacity gate (Python get_capacity).
  const capacity = await deps.memory.getCapacity();
  if (capacity.active >= capacity.max) {
    return { status: "skip", content: `At capacity (${capacity.active}/${capacity.max})` };
  }

  // Deterministic daily task gate — the agreed replacement for the Python
  // 24h cycle-sleep: one scan per UTC day, keyed by the task the start
  // content tells the agent to create.
  const dailyKey = dailyTaskKey(params.task_prefix, now);
  const tasks = await deps.memory.getTasks();
  if (findTaskByKey(tasks, dailyKey) !== undefined) {
    return { status: "skip", content: `Already scanned today (${dailyKey})` };
  }

  // Concurrency gate (Python MAX_CONCURRENT_SCANS).
  const activeScans = countActiveTasksWithPrefix(tasks, params.task_prefix, dailyKey);
  if (activeScans >= MAX_CONCURRENT_SCANS) {
    return { status: "skip", content: `Already processing ${activeScans} test scans` };
  }

  // Repos: the whitelist filtered against the instance map, capped at the
  // per-scan limit (Python `list(repos.keys())[:max_repos]`).
  const scanOnly = params.scan_only_repos;
  const repoNames = Object.keys(deps.repos)
    .filter((name) => scanOnly.includes(name))
    .slice(0, params.max_repos_per_scan);
  if (repoNames.length === 0) {
    return { status: "skip", content: "No repositories configured in scan_only_repos" };
  }

  const listTracker = new FetchTracker();
  const reposWithTests: RepoTestScan[] = [];

  for (const repoName of repoNames) {
    const { upstreamPath, host } = upstreamRepo(repoName, deps.repos);
    if (upstreamPath === "" || host !== "github") {
      continue;
    }

    let files: readonly string[];
    try {
      files = await deps.github.listRepoFiles(upstreamPath);
    } catch (error) {
      // Isolated listing failure: skip this repo, keep scanning.
      listTracker.recordFailure(upstreamPath, error);
      continue;
    }
    listTracker.recordSuccess();

    // Framework detection: any indicator file present in the tree.
    const framework = params.framework_indicators.some((indicator) =>
      files.some((file) => file.includes(indicator)),
    )
      ? "playwright"
      : "generic";

    const testFiles: string[] = [];
    for (const file of files) {
      if (testFiles.length >= params.max_files_per_repo) {
        break;
      }
      if (params.exclude_substrings.some((exclude) => file.includes(exclude))) {
        continue;
      }
      if (params.patterns.some((pattern) => patternMatchesFile(pattern, file))) {
        testFiles.push(file);
      }
    }

    if (testFiles.length > 0) {
      reposWithTests.push({ repo: repoName, files: testFiles, framework });
    }
  }

  // The failure policy: a total inability to list the attempted repos is
  // an execution error naming the required route, never a silent "no test
  // files found" skip. Isolated failures are tolerated with evidence.
  const listOutage = totalFetchFailureError(listTracker, {
    system: "GitHub",
    noun: "repo file list",
    route: deps.github.route,
  });
  if (listOutage !== null) {
    throw listOutage;
  }

  if (reposWithTests.length === 0) {
    return {
      status: "skip",
      content: appendFetchEvidence(`Scanned ${repoNames.length} repos, no test files found`, [
        [listTracker, "repo"],
      ]),
    };
  }

  const totalFiles = reposWithTests.reduce((sum, entry) => sum + entry.files.length, 0);
  // Content mirrors the Python format exactly, plus the Task ID line that
  // tells the agent which deterministic daily task to create.
  const lines = [
    `# Test Files for Anti-Pattern Analysis (${totalFiles} files)`,
    "",
    `- **Task ID**: ${dailyKey}`,
    "",
  ];
  for (const entry of reposWithTests) {
    lines.push(`${entry.repo} (${entry.files.length} files, ${entry.framework}):`);
    lines.push(`  ${entry.files.join(", ")}`);
    lines.push("");
    lines.push("");
  }
  return {
    status: "start",
    content: appendFetchEvidence(lines.join("\n"), [[listTracker, "repo"]]),
  };
}

/**
 * The registered preflight — the shared GitHub-preflight factory
 * (`defineGitHubPreflight`) wires the run context into the flow: the GitHub
 * client is built from the run's auth-proxy route and the repo map comes
 * from the instance config; any failure — including an unwired proxy route
 * — surfaces as an `error` result, never a silent skip.
 */
export const hccTestAntiPatternScan = defineGitHubPreflight({
  id: "hcc-test-anti-pattern-scan",
  input: HCC_TEST_ANTI_PATTERN_SCAN_INPUT,
  run: runHccTestAntiPatternScan,
});
