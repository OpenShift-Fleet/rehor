import { z } from "zod";
import type { PreflightExecutionResult } from "../../core/results.js";
import {
  appendFetchEvidence,
  FetchTracker,
  totalFetchFailureError,
} from "../../shared/failure-policy.js";
import type { GhMergedPr, GhPrData, GitHubClient } from "../../shared/github.js";
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
import { parseIso } from "../../shared/time.js";

/**
 * `hcc-merged-pr-violations` — the port of the hcc-framework-agent-dev
 * quality-monitor preflight `01-check-merged-prs.py` (merged PRs with
 * failed non-security checks).
 *
 * Scans the instance's GitHub-hosted repos for PRs merged within the
 * lookback window whose check rollup contains `FAILURE` conclusions, minus
 * security scans (`lib/security_scans.py` patterns, ported verbatim below).
 * `start` (with Markdown for the agent prompt) when violations exist,
 * `skip` otherwise.
 *
 * Behavior parity with the Python script, with the agreed adaptations:
 *
 * - The Python 24h cycle-sleep is replaced by a deterministic daily task
 *   gate: the scan runs at most once per UTC day, keyed by the
 *   `${task_prefix}-{date}` task the start content tells the agent to
 *   create. A task with that external_key — any status — means today was
 *   already scanned.
 * - The `test-config.yaml` whitelist (`scan_only_repos`) and the constants
 *   become flattened input parameters with the same defaults.
 * - The `gh` CLI subprocesses become the package's GitHub client on the
 *   auth-proxy route, under the shared failure policy: a repo-listing or
 *   PR-detail fetch failure skips that repo/PR and is tallied; when every
 *   attempted fetch of a class failed, the run escalates to an `error`
 *   naming the required route instead of a silent "no violations" skip.
 *   Tolerated failures are recorded as UNFETCHABLE evidence.
 */

export const HCC_MERGED_PR_VIOLATIONS_INPUT = z.strictObject({
  /**
   * Restrict the scan to these repo names (the Python `test-config.yaml`
   * `scan_only_repos` whitelist); omitted scans every repo in the
   * instance's project-repos map.
   */
  scan_only_repos: z
    .array(z.string().refine(nonBlank, { message: "repo name must not be blank" }))
    .optional(),
  /** Lookback window for merges, in hours (Python `SCAN_INTERVAL_HOURS`). */
  lookback_hours: z.number().int().positive().default(24),
  /**
   * Skip the scan while this many violation tasks are already active
   * (Python `MAX_CONCURRENT_VIOLATIONS`).
   */
  max_concurrent: z.number().int().positive().default(5),
  /** Merged PRs fetched per repo (Python `MAX_PRS_PER_REPO`). */
  max_prs_per_repo: z.number().int().positive().default(50),
  /**
   * Prefix of the deterministic daily task (and of the per-violation tasks
   * the agent creates; the Python external_key prefix, pluralized).
   */
  task_prefix: z.string().default("merge-violations"),
});

export type HccMergedPrViolationsParams = z.infer<typeof HCC_MERGED_PR_VIOLATIONS_INPUT>;

/**
 * Security-scan CI check names — the Python `lib/security_scans.py`
 * `SECURITY_SCAN_PATTERNS` tuple, verbatim. A failed check whose name
 * contains one of these (case-insensitive substring) is a security scan;
 * a PR whose only failures are security scans is not a violation.
 */
const SECURITY_SCAN_PATTERNS: readonly string[] = [
  "clair-scan",
  "sast-",
  "clamav-scan",
  "coverity",
  "rpms-signature-scan",
  "deprecated-image-check",
  "ecosystem-cert-preflight",
  "grype",
  "trivy",
  "snyk",
  "vulnerability",
  "security-scan",
  "cve-scan",
  "container-scan",
  "image-scan",
];

/** Python `is_security_scan`: case-insensitive substring match. */
export function isSecurityScan(checkName: string | null | undefined): boolean {
  if (!checkName) {
    return false;
  }
  const nameLower = checkName.toLowerCase();
  return SECURITY_SCAN_PATTERNS.some((pattern) => nameLower.includes(pattern));
}

/** One merge violation — a merged PR with non-security failed checks. */
export interface MergeViolation {
  /** Project-repos map key (the instance-facing repo name). */
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly author: string;
  readonly mergedDate: string;
  readonly failedChecks: readonly string[];
}

/** Dependencies of the ported `main()` flow, injectable for tests. */
export interface HccMergedPrViolationsDeps {
  readonly memory: MemoryServerClient;
  readonly github: GitHubClient;
  readonly repos: ProjectReposMap;
  /** Injectable clock so tests can fix the day and the lookback window. */
  readonly now?: () => Date;
}

/**
 * The ported `main()` flow: capacity gate, deterministic daily task gate,
 * concurrency gate, then per-repo merged-PR scanning.
 */
export async function runHccMergedPrViolations(
  deps: HccMergedPrViolationsDeps,
  params: HccMergedPrViolationsParams,
): Promise<PreflightExecutionResult> {
  const now = deps.now?.() ?? new Date();
  const sinceMs = now.getTime() - params.lookback_hours * 3_600_000;

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

  // Concurrency gate (Python MAX_CONCURRENT_VIOLATIONS).
  const activeViolations = countActiveTasksWithPrefix(tasks, params.task_prefix, dailyKey);
  if (activeViolations >= params.max_concurrent) {
    return {
      status: "skip",
      content: `Already processing ${activeViolations} violations`,
    };
  }

  // Repos: the instance map, optionally restricted to the whitelist.
  let repoNames = Object.keys(deps.repos);
  const scanOnly = params.scan_only_repos;
  if (scanOnly !== undefined) {
    repoNames = repoNames.filter((name) => scanOnly.includes(name));
    if (repoNames.length === 0) {
      return { status: "skip", content: "No repositories configured in scan_only_repos" };
    }
  }

  const repoTracker = new FetchTracker();
  const prTracker = new FetchTracker();
  const violations: MergeViolation[] = [];

  for (const repoName of repoNames) {
    const { upstreamPath, host } = upstreamRepo(repoName, deps.repos);
    if (upstreamPath === "" || host !== "github") {
      continue;
    }

    let prs: readonly GhMergedPr[];
    try {
      prs = await deps.github.listMergedPrs(upstreamPath, params.max_prs_per_repo);
    } catch (error) {
      // Isolated repo-listing failure: skip this repo, keep scanning.
      repoTracker.recordFailure(upstreamPath, error);
      continue;
    }
    repoTracker.recordSuccess();

    for (const pr of prs) {
      // Python parity: keep only merges strictly inside the lookback;
      // an unparseable mergedAt excludes the PR.
      const mergedAt = parseIso(pr.mergedAt);
      if (mergedAt === null || mergedAt.getTime() <= sinceMs) {
        continue;
      }

      const item = `${upstreamPath}#${pr.number}`;
      let data: GhPrData | null;
      try {
        data = await deps.github.getPr(upstreamPath, pr.number);
      } catch (error) {
        // Isolated PR-detail failure: skip this PR (the Python `gh pr view`
        // wrapper degraded to None).
        prTracker.recordFailure(item, error);
        continue;
      }
      prTracker.recordSuccess();
      if (data === null) {
        continue;
      }

      const failedChecks = (data.statusCheckRollup ?? [])
        .filter((check) => check?.conclusion === "FAILURE")
        .map((check) => check.name ?? "")
        .filter((name) => !isSecurityScan(name));
      if (failedChecks.length === 0) {
        continue;
      }
      violations.push({
        repo: repoName,
        number: pr.number,
        title: pr.title,
        author: pr.author ?? "unknown",
        mergedDate: pr.mergedAt?.slice(0, 10) ?? "unknown",
        failedChecks,
      });
    }
  }

  // The failure policy: a total inability to list the attempted repos — or
  // to fetch the attempted PR details — is an execution error naming the
  // required route, never a silent "no violations" skip. Isolated failures
  // are tolerated and recorded as evidence below.
  const repoOutage = totalFetchFailureError(repoTracker, {
    system: "GitHub",
    noun: "merged-PR list",
    route: deps.github.route,
  });
  if (repoOutage !== null) {
    throw repoOutage;
  }
  const prOutage = totalFetchFailureError(prTracker, {
    system: "GitHub",
    noun: "PR detail",
    route: deps.github.route,
  });
  if (prOutage !== null) {
    throw prOutage;
  }

  if (violations.length === 0) {
    return {
      status: "skip",
      content: appendFetchEvidence(
        `No merged PRs with failed checks since ${new Date(sinceMs).toISOString()}`,
        [
          [repoTracker, "repo"],
          [prTracker, "PR"],
        ],
      ),
    };
  }

  // Content mirrors the Python format exactly, plus the Task ID line that
  // tells the agent which deterministic daily task to create.
  const lines = [
    `# Merge Violations (${violations.length} total)`,
    "",
    `- **Task ID**: ${dailyKey}`,
    "",
    "high:",
  ];
  for (const violation of violations) {
    lines.push(
      `  - ${violation.repo} #${violation.number}: ${violation.title} ` +
        `(@${violation.author}, ${violation.mergedDate})`,
    );
    lines.push(`    failed: ${violation.failedChecks.join(", ")}`);
  }
  return {
    status: "start",
    content: appendFetchEvidence(`${lines.join("\n")}\n`, [
      [repoTracker, "repo"],
      [prTracker, "PR"],
    ]),
  };
}

/**
 * The registered preflight — the shared GitHub-preflight factory
 * (`defineGitHubPreflight`) wires the run context into the flow: the GitHub
 * client is built from the run's auth-proxy route and the repo map comes
 * from the instance config; any failure — including an unwired proxy route
 * — surfaces as an `error` result, never a silent skip.
 */
export const hccMergedPrViolations = defineGitHubPreflight({
  id: "hcc-merged-pr-violations",
  input: HCC_MERGED_PR_VIOLATIONS_INPUT,
  run: runHccMergedPrViolations,
});
