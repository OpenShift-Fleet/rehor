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
import { ACTIVE_TASK_STATUSES } from "../../shared/memory-server.js";
import type { ProjectReposMap } from "../../shared/repos.js";
import { upstreamRepo } from "../../shared/repos.js";
import type { LocalScheduleWindow } from "../../shared/schedule.js";
import { isWithinLocalWindow } from "../../shared/schedule.js";
import { nonBlank } from "../../shared/strings.js";
import { isoDateUtc } from "../../shared/time.js";

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
 * - The Python 24h cycle-sleep became a deterministic per-repo/day gate:
 *   before a repo is listed, its tracking task — external_key
 *   `${task_prefix}:{repo}:{UTC date}`, any status, archived included —
 *   is looked up exactly (fail closed). A tracked repo was already
 *   handled today and is skipped without consuming a
 *   `max_repos_per_scan` slot, so one tracked repo never hides the other
 *   repos' findings. The start content tells the agent to create that
 *   tracking task only after finishing the repo's analysis — including
 *   when no ticket is needed — so an interrupted run re-emits the
 *   remaining work instead of a marker hiding it.
 * - The scan only acts inside the quality monitor's actual KEDA window,
 *   Monday–Friday 09:00–23:00 Europe/Prague, checked DST-aware via the
 *   shared schedule helper before any memory or GitHub call.
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
  /**
   * Prefix of the per-repo/day deterministic tracking tasks the start
   * content keys: `${prefix}:{repo}:{UTC date}` (the workflow's
   * external_key convention, source_type jira for ticketed tasks).
   */
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

/**
 * The quality monitor's actual KEDA schedule: Monday–Friday, 09:00–23:00
 * Europe/Prague. The scan must not act outside it — the window is checked
 * on the Prague wall clock via the shared schedule helper, so daylight
 * saving transitions need no offset arithmetic of our own.
 */
const QUALITY_SCAN_WINDOW: LocalScheduleWindow = {
  days: [0, 1, 2, 3, 4],
  startHour: 9,
  endHour: 23,
  timeZone: "Europe/Prague",
};

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
  /** Injectable clock so tests can fix the day and the schedule window. */
  readonly now?: () => Date;
}

/**
 * The per-repo/day deterministic tracking key — the workflow's
 * external_key for a repo's scan tracking task:
 * `${prefix}:{repo}:${UTC date}`, stable across every run of the same UTC
 * day.
 */
export function repoScanTaskKey(prefix: string, repoName: string, now: Date): string {
  return `${prefix}:${repoName}:${isoDateUtc(now)}`;
}

/**
 * Match the Python scanner's recognized test suffixes regardless of the
 * pattern's directory prefix. Other patterns use a literal suffix after
 * stripping double-star directory prefixes and leading stars.
 */
export function patternMatchesFile(pattern: string, file: string): boolean {
  let simple = pattern.replaceAll("**/", "");
  for (const extension of [".spec.ts", ".test.ts", ".spec.js", ".test.js"]) {
    if (simple.endsWith(`*${extension}`)) return file.endsWith(extension);
  }
  while (simple.startsWith("*")) {
    simple = simple.slice(1);
  }
  return simple !== "" && file.endsWith(simple);
}

/**
 * The ported `main()` flow: schedule gate, capacity gate, concurrency
 * gate, then per-repo/day gate and file-tree scanning.
 */
export async function runHccTestAntiPatternScan(
  deps: HccTestAntiPatternScanDeps,
  params: HccTestAntiPatternScanParams,
): Promise<PreflightExecutionResult> {
  const now = deps.now?.() ?? new Date();

  // Schedule gate: the quality monitor is KEDA-scheduled Mon–Fri
  // 09:00–23:00 Europe/Prague; outside that window the scan must not act
  // at all — checked before any memory or GitHub call.
  if (!isWithinLocalWindow(now, QUALITY_SCAN_WINDOW)) {
    return {
      status: "skip",
      content: "Outside the quality scan window (Mon–Fri 09:00–23:00 Europe/Prague)",
    };
  }

  // Capacity gate (Python get_capacity).
  const capacity = await deps.memory.getCapacity();
  if (capacity.active >= capacity.max) {
    return { status: "skip", content: `At capacity (${capacity.active}/${capacity.max})` };
  }

  // Concurrency gate (Python MAX_CONCURRENT_SCANS): active tasks whose
  // external key starts with `${task_prefix}:` — the per-repo tracking and
  // ticket tasks the workflow creates. The aggregate daily gate (and its
  // extra key) is gone, so the prefix count alone decides.
  const tasks = await deps.memory.getTasks();
  const activeScans = tasks.filter(
    (task) =>
      ACTIVE_TASK_STATUSES.includes(task?.status ?? "") &&
      task?.external_key?.startsWith(`${params.task_prefix}:`),
  ).length;
  if (activeScans >= MAX_CONCURRENT_SCANS) {
    return { status: "skip", content: `Already processing ${activeScans} test scans` };
  }

  // Repos: the whitelist filtered against the instance map (Python
  // `list(repos.keys())[:max_repos]`). The per-scan limit below counts
  // only repos actually attempted — a repo skipped as already tracked
  // never consumes a slot, so it cannot hide the other repos' findings.
  const scanOnly = params.scan_only_repos;
  const whitelisted = Object.keys(deps.repos).filter((name) => scanOnly.includes(name));
  if (whitelisted.length === 0) {
    return { status: "skip", content: "No repositories configured in scan_only_repos" };
  }

  const listTracker = new FetchTracker();
  const reposWithTests: RepoTestScan[] = [];
  let attempted = 0;
  let tracked = 0;

  for (const repoName of whitelisted) {
    if (attempted >= params.max_repos_per_scan) {
      break;
    }
    const { upstreamPath, host } = upstreamRepo(repoName, deps.repos);
    if (upstreamPath === "" || host !== "github") {
      attempted += 1;
      continue;
    }

    // Per-repo/day deterministic gate: a tracking task in any status —
    // archived included — means this repo was already handled today and
    // is skipped without consuming a scan slot. The exact-key lookup
    // fails closed: an unreachable answer never counts as "no task yet".
    const trackingKey = repoScanTaskKey(params.task_prefix, repoName, now);
    if ((await deps.memory.getTaskByKey(trackingKey)) !== undefined) {
      tracked += 1;
      continue;
    }

    attempted += 1;
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
    if (attempted === 0) {
      return { status: "skip", content: `All ${tracked} repos already scanned today` };
    }
    return {
      status: "skip",
      content: appendFetchEvidence(`Scanned ${attempted} repos, no test files found`, [
        [listTracker, "repo"],
      ]),
    };
  }

  const totalFiles = reposWithTests.reduce((sum, entry) => sum + entry.files.length, 0);
  // Content mirrors the Python format, with each repo's deterministic
  // tracking key and the completion-gating instruction: the tracking task
  // is created only after the repo's analysis finishes — including when
  // no ticket is needed — so an interrupted run re-emits the remaining
  // work instead of a marker hiding it.
  const lines = [
    `# Test Files for Anti-Pattern Analysis (${totalFiles} files)`,
    "",
    "Analyze each repo's test files for anti-patterns. After finishing a",
    "repo's analysis, create its scan-tracking task: external_key = the",
    "repo's Task ID below and instance_id from BOT_INSTANCE_ID. If a Jira",
    "ticket is filed, use source_type jira, status in_progress and",
    "metadata.jira_key so new feedback can resume it.",
    "Otherwise record the completed scan with status done. Create the tracking",
    "task even when no ticket is needed, and only after analysis is complete —",
    "that stops this repo being rescanned today, and creating it early",
    "would hide unfinished work from the next run.",
    "",
  ];
  for (const entry of reposWithTests) {
    lines.push(`${entry.repo} (${entry.files.length} files, ${entry.framework}):`);
    lines.push(`  ${entry.files.join(", ")}`);
    lines.push(`  Task ID: ${repoScanTaskKey(params.task_prefix, entry.repo, now)}`);
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
