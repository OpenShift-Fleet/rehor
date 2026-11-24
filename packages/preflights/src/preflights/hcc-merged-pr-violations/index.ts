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
import { countActiveTasksWithPrefix } from "../../shared/memory-server.js";
import type { ProjectReposMap } from "../../shared/repos.js";
import { upstreamRepo } from "../../shared/repos.js";
import type { LocalScheduleWindow } from "../../shared/schedule.js";
import { isWithinLocalWindow } from "../../shared/schedule.js";
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
 * `start` (with Markdown for the agent prompt) when untracked violations
 * exist, `skip` otherwise.
 *
 * Behavior parity with the Python script, with the agreed adaptations:
 *
 * - The Python 24h cycle-sleep and the port's former daily aggregate task
 *   are gone: gating is per finding. Each violation's task is keyed
 *   `${task_prefix}:{repo}:{pr_number}` with `source_type: "jira"` (the
 *   quality workflow convention); a task with that external key — any
 *   status, archived included — means the finding is already tracked and
 *   is skipped, while every other finding is still reported. No aggregate
 *   marker is created or consulted, and one tracked finding never hides an
 *   independent one. The exact-key lookups fail closed: any memory-server
 *   fetch, auth, or protocol error fails the run instead of being mistaken
 *   for "not tracked yet".
 * - The `test-config.yaml` whitelist (`scan_only_repos`) and the constants
 *   become flattened input parameters with the same defaults.
 * - The `gh` CLI subprocesses become the package's GitHub client on the
 *   auth-proxy route, under the shared failure policy: a repo-listing or
 *   PR-detail fetch failure skips that repo/PR and is tallied; when every
 *   attempted fetch of a class failed, the run escalates to an `error`
 *   naming the required route instead of a silent "no violations" skip.
 *   Tolerated failures are recorded as UNFETCHABLE evidence.
 * - The port adds a time gate: the manager is only active on weekdays
 *   09:00–23:00 Europe/Prague, so cycles outside that local window skip
 *   before any state is read. The window is DST-aware through the shared
 *   schedule helper (the zone's wall clock at the injected instant decides,
 *   not a fixed UTC offset).
 */

/**
 * The manager's active window for this preflight: weekdays (Monday=0 …
 * Friday=4) 09:00–23:00 Europe/Prague. Start inclusive, end exclusive,
 * DST-aware through the shared schedule helper.
 */
const ACTIVE_WINDOW: LocalScheduleWindow = {
  days: [0, 1, 2, 3, 4],
  startHour: 9,
  endHour: 23,
  timeZone: "Europe/Prague",
};

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
   * Prefix of the per-violation tasks the agent creates (the Python
   * external_key prefix); each task's key is
   * `${task_prefix}:{repo}:{pr_number}`.
   */
  task_prefix: z.string().default("merge-violation"),
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

/**
 * The per-finding task key — the quality workflow convention:
 * `${task_prefix}:{repo}:{pr_number}`, `source_type: "jira"`.
 */
function violationTaskKey(params: HccMergedPrViolationsParams, violation: MergeViolation): string {
  return `${params.task_prefix}:${violation.repo}:${violation.number}`;
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
 * The ported `main()` flow: active-window gate, capacity gate, concurrency
 * gate, per-repo merged-PR scanning, then per-finding dedup against the
 * memory server (tracked findings — any status, archived included — are
 * skipped; the rest are started with their exact task keys).
 */
export async function runHccMergedPrViolations(
  deps: HccMergedPrViolationsDeps,
  params: HccMergedPrViolationsParams,
): Promise<PreflightExecutionResult> {
  const now = deps.now?.() ?? new Date();
  const sinceMs = now.getTime() - params.lookback_hours * 3_600_000;

  // Active-window gate: weekdays 09:00–23:00 Europe/Prague, local wall
  // clock at this instant (DST-aware). Outside it, skip before any state
  // is read or any upstream system is touched.
  if (!isWithinLocalWindow(now, ACTIVE_WINDOW)) {
    return {
      status: "skip",
      content: "Outside the manager active window (Mon–Fri 09:00–23:00 Europe/Prague)",
    };
  }

  // Capacity gate (Python get_capacity).
  const capacity = await deps.memory.getCapacity();
  if (capacity.active >= capacity.max) {
    return { status: "skip", content: `At capacity (${capacity.active}/${capacity.max})` };
  }

  // Concurrency gate (Python MAX_CONCURRENT_VIOLATIONS).
  const tasks = await deps.memory.getTasks();
  const activeViolations = countActiveTasksWithPrefix(
    tasks,
    params.task_prefix,
    params.task_prefix,
  );
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
      prs = await deps.github.listMergedPrs(
        upstreamPath,
        params.max_prs_per_repo,
        new Date(sinceMs),
      );
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

  // Per-finding dedup: each violation is gated by its own exact task key,
  // looked up across every status (archived included) with the quality
  // workflow's source type. A tracked finding is skipped; every untracked
  // one is still reported — one tracked finding never hides an independent
  // one, and no aggregate marker is consulted or fabricated. The lookup
  // fails closed: a fetch, auth, or protocol error propagates and errors
  // the run rather than being mistaken for "not tracked yet".
  const untracked: MergeViolation[] = [];
  for (const violation of violations) {
    const tracked = await deps.memory.getTaskByKey(violationTaskKey(params, violation), {
      sourceType: "jira",
    });
    if (tracked === undefined) {
      untracked.push(violation);
    }
  }

  const evidence: ReadonlyArray<readonly [FetchTracker, string]> = [
    [repoTracker, "repo"],
    [prTracker, "PR"],
  ];

  if (untracked.length === 0) {
    return {
      status: "skip",
      content: appendFetchEvidence(
        `All ${violations.length} violation(s) already tracked`,
        evidence,
      ),
    };
  }

  // Content mirrors the Python format, plus the per-finding Task ID line
  // that tells the agent the exact external_key (and source type) to
  // create the task with.
  const lines = [
    `# Merge Violations (${untracked.length} total)`,
    "",
    "Track each Jira ticket using its Task ID as external_key, source_type jira,",
    "instance_id from BOT_INSTANCE_ID, and metadata.jira_key set to the ticket key.",
    "Keep the task active while awaiting feedback.",
    "",
    "high:",
  ];
  for (const violation of untracked) {
    lines.push(
      `  - ${violation.repo} #${violation.number}: ${violation.title} ` +
        `(@${violation.author}, ${violation.mergedDate})`,
    );
    lines.push(`    failed: ${violation.failedChecks.join(", ")}`);
    lines.push(`    Task ID: ${violationTaskKey(params, violation)}`);
  }
  return {
    status: "start",
    content: appendFetchEvidence(`${lines.join("\n")}\n`, evidence),
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
