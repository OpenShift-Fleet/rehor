import { FetchTracker } from "../../shared/failure-policy.js";
import type { CommentRecord } from "../../shared/format.js";
import type { GhPrData, GitHubClient } from "../../shared/github.js";
import { ACTIVE_TASK_STATUSES, type MemoryTask } from "../../shared/memory-server.js";
import type { ProjectReposMap } from "../../shared/repos.js";
import { upstreamRepo } from "../../shared/repos.js";
import { classifyGh } from "../gh-pr-status/classify.js";
import type { EnrichedGhTask, GhFetchTrackers, GhPrTaskEntry } from "../gh-pr-status/index.js";
import { enrichGh, hasNewFeedback } from "../gh-pr-status/index.js";

/**
 * Shared helpers for the Renovate workflow preflights — the port of the
 * instance workflow's `lib/renovate_discover.py` and
 * `lib/fix_pr_feedback.py`.
 *
 * The workflow tracks each Renovate PR as a task keyed
 * `renovate-fix:<repo-key>#<number>` (the prefix is configurable on both
 * registered preflights). Discovery owns new/paused-retry work; the status
 * preflight owns active work plus paused tasks that received new human
 * feedback. Once a task records `metadata.fix_pr`, CI, conflicts, and
 * comments move to that fix PR while the Renovate PR remains the
 * MERGED/CLOSED lifecycle signal.
 */

/** Default task-key prefix of the Renovate workflow. */
export const RENOVATE_TASK_KEY_PREFIX = "renovate-fix:";

/** Default GitHub logins treated as Renovate authors. */
export const RENOVATE_AUTHOR_LOGINS: readonly string[] = [
  "renovate[bot]",
  "renovate",
  "app/renovate",
];

/** One discovered failing Renovate PR. */
export interface RenovateDiscoveryEntry {
  readonly repo_key: string;
  readonly upstream: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly head_ref: string;
  readonly head_owner: string;
  readonly head_repo: string;
  readonly is_cross_repository: boolean;
  readonly issues: readonly string[];
  readonly issue_str: string;
  readonly task_key: string;
  /** Existing terminal/paused status the agent should resume instead of re-add. */
  readonly existing_status?: string;
  /** The paused reason carried for `resume:paused` entries. */
  readonly existing_paused_reason?: string;
}

/** Discovery result plus the per-class fetch bookkeeping. */
export interface RenovateDiscoveryResult {
  readonly autoFix: readonly RenovateDiscoveryEntry[];
  readonly tracked: readonly RenovateDiscoveryEntry[];
  /** Open-PR listing fetches, one per scanned repository. */
  readonly listings: FetchTracker;
  /** PR detail fetches, one per Renovate PR candidate. */
  readonly details: FetchTracker;
}

/** Inputs for {@link discoverFailingRenovatePrs}. */
export interface RenovateDiscoveryOptions {
  readonly repos: ProjectReposMap;
  readonly tasks: readonly MemoryTask[];
  readonly taskKeyPrefix: string;
  readonly botLogins: readonly string[];
  /** Restrict the scan to these project-repos keys; unset scans every repo. */
  readonly repoKeys?: readonly string[];
}

/** The deterministic task key of one Renovate PR. */
export function renovateTaskKey(taskKeyPrefix: string, repoKey: string, prNumber: number): string {
  return `${taskKeyPrefix}${repoKey}#${prNumber}`;
}

/** True when the GitHub login belongs to Renovate (case-insensitive). */
export function isRenovateAuthor(
  login: string | null | undefined,
  botLogins: readonly string[] = RENOVATE_AUTHOR_LOGINS,
): boolean {
  if (typeof login !== "string" || login === "") return false;
  const lowered = login.toLowerCase();
  return botLogins.some((candidate) => candidate.toLowerCase() === lowered);
}

/**
 * True when a Renovate PR has CI failures and no outstanding merge conflict.
 * Conflict-only PRs wait for Renovate to rebase; conflicted branches cannot
 * be fixed reliably (conflict markers look like TypeScript errors and the
 * lockfile may be corrupt).
 */
export function hasActionableIssues(issues: readonly string[]): boolean {
  if (issues.length === 0) return false;
  if (issues.includes("conflict")) return false;
  return issues.some((issue) => issue.startsWith("ci_fail"));
}

/**
 * Whether a paused task may re-enter AUTO-FIX automatically. Only
 * `transient:*` failures (and a missing reason, for backwards
 * compatibility) are retryable; `blocked:*` and every other recorded reason
 * — including the dashboard's `Paused via dashboard` — wait for a human.
 */
export function isAutoRetryable(task: MemoryTask): boolean {
  const reason = task.paused_reason ?? "";
  if (reason === "") return true;
  return reason.startsWith("transient:");
}

/**
 * Per-task state of the workflow's own tasks, keyed by external key.
 * `tracked` means the status preflight already covers the task: it is
 * active, or paused waiting for human action. Paused tasks eligible for
 * automatic retry stay untracked, so they re-enter AUTO-FIX.
 */
export interface RenovateTaskState {
  readonly status: string;
  readonly pausedReason: string;
  readonly tracked: boolean;
}

/** Index the workflow's tasks by external key in one pass. */
export function renovateTaskStates(
  tasks: readonly MemoryTask[],
  taskKeyPrefix: string,
): Map<string, RenovateTaskState> {
  const states = new Map<string, RenovateTaskState>();
  for (const task of tasks) {
    const key = task.external_key ?? "";
    if (!key.startsWith(taskKeyPrefix)) continue;
    const status = task.status;
    if (typeof status !== "string" || status === "") continue;
    const tracked =
      ACTIVE_TASK_STATUSES.includes(status) || (status === "paused" && !isAutoRetryable(task));
    states.set(key, { status, pausedReason: task.paused_reason ?? "", tracked });
  }
  return states;
}

/** Format one AUTO-FIX entry — the Python `format_pr_line` output. */
export function formatPrLine(entry: RenovateDiscoveryEntry): string {
  const existingStatus = entry.existing_status;
  let statusNote = " new";
  if (existingStatus !== undefined) {
    statusNote = ` resume:${existingStatus}`;
    if (entry.existing_paused_reason) {
      statusNote += ` (${entry.existing_paused_reason})`;
    }
  }
  return [
    `  PR ${entry.upstream}#${entry.number} [${entry.issue_str}]${statusNote}`,
    `  title: ${entry.title}`,
    `  head_ref: ${entry.head_ref}`,
    `  head_owner: ${entry.head_owner || "(resolve via gh pr view)"}`,
    `  head_repo: ${entry.head_repo || "(resolve via gh pr view)"}`,
    `  is_cross_repository: ${entry.is_cross_repository}`,
    `  task_key: ${entry.task_key}`,
    `  url: ${entry.url}`,
  ].join("\n");
}

function headOwner(pr: GhPrData): string {
  const login = pr.headRepositoryOwner?.login;
  return typeof login === "string" ? login : "";
}

function headRepoName(pr: GhPrData): string {
  const name = pr.headRepository?.name;
  return typeof name === "string" ? name : "";
}

/**
 * Discover failing Renovate PRs on the configured repositories. Mirrors
 * `discover_failing_renovate_prs`: only open, non-draft, Renovate-authored
 * PRs with CI failures and no conflict are candidates; tracked vs auto-fix
 * is decided by the task key, and existing statuses are carried so the agent
 * resumes instead of creating a duplicate task.
 */
export async function discoverFailingRenovatePrs(
  github: GitHubClient,
  options: RenovateDiscoveryOptions,
): Promise<RenovateDiscoveryResult> {
  const listings = new FetchTracker();
  const details = new FetchTracker();
  const states = renovateTaskStates(options.tasks, options.taskKeyPrefix);
  const autoFix: RenovateDiscoveryEntry[] = [];
  const alreadyTracked: RenovateDiscoveryEntry[] = [];

  const repoKeys = options.repoKeys ?? Object.keys(options.repos);
  for (const repoKey of repoKeys) {
    const { upstreamPath, host } = upstreamRepo(repoKey, options.repos);
    if (upstreamPath === "" || host !== "github") continue;

    let openPrs: Awaited<ReturnType<GitHubClient["listOpenPrs"]>>;
    try {
      openPrs = await github.listOpenPrs(upstreamPath, { limit: 100 });
      listings.recordSuccess();
    } catch (error) {
      listings.recordFailure(upstreamPath, error);
      continue;
    }

    for (const pr of openPrs) {
      if (!isRenovateAuthor(pr.author, options.botLogins)) continue;
      if (!pr.number) continue;
      const item = `${upstreamPath}#${pr.number}`;
      let data: GhPrData | null;
      try {
        data = await github.getPr(upstreamPath, pr.number);
        details.recordSuccess();
      } catch (error) {
        details.recordFailure(item, error);
        continue;
      }
      if (data === null || data.isDraft === true) continue;
      const { issues } = classifyGh(data);
      if (!hasActionableIssues(issues)) continue;

      const taskKey = renovateTaskKey(options.taskKeyPrefix, repoKey, pr.number);
      const entry: RenovateDiscoveryEntry = {
        repo_key: repoKey,
        upstream: upstreamPath,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        head_ref: pr.headRefName,
        head_owner: headOwner(data),
        head_repo: headRepoName(data),
        is_cross_repository: pr.isCrossRepository,
        issues,
        issue_str: issues.length > 0 ? issues.join(",") : "clean",
        task_key: taskKey,
      };
      const state = states.get(taskKey);
      if (state?.tracked === true) {
        alreadyTracked.push(entry);
        continue;
      }
      if (state !== undefined) {
        const resumed: RenovateDiscoveryEntry = {
          ...entry,
          existing_status: state.status,
          ...(state.pausedReason !== "" ? { existing_paused_reason: state.pausedReason } : {}),
        };
        autoFix.push(resumed);
      } else {
        autoFix.push(entry);
      }
    }
  }

  return { autoFix, tracked: alreadyTracked, listings, details };
}

/** `(owner/repo, number)` of a task's handoff PR, or null. */
export function resolveFixPr(
  fixPr: unknown,
  repos: ProjectReposMap,
): { ownerRepo: string; number: number } | null {
  if (typeof fixPr !== "object" || fixPr === null || Array.isArray(fixPr)) return null;
  const record = fixPr as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url : "";
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(url);
  if (match !== null) {
    return { ownerRepo: match[1], number: Number(match[2]) };
  }
  const repoValue = record.repo;
  const numberValue = record.number;
  if (typeof repoValue !== "string" || repoValue === "" || numberValue === undefined) {
    return null;
  }
  const number = Number(numberValue);
  if (!Number.isInteger(number) || number <= 0) return null;
  if (repoValue.includes("/")) {
    return { ownerRepo: repoValue, number };
  }
  const { upstreamPath } = upstreamRepo(repoValue, repos);
  if (upstreamPath === "") return null;
  return { ownerRepo: upstreamPath, number };
}

/** True when `ownerRepo#number` already appears in the enriched task's PRs. */
function alreadyTracked(enriched: EnrichedGhTask, ownerRepo: string, number: number): boolean {
  return enriched.prs.some(
    (pr) =>
      pr.num === number &&
      (pr.repo === ownerRepo ||
        pr.repo.endsWith(`/${ownerRepo}`) ||
        ownerRepo.endsWith(`/${pr.repo}`)),
  );
}

/** Timestamp key for the chronological fix-PR comment sort. */
function commentTime(comment: CommentRecord): string {
  const timestamp = comment.t ?? comment.created;
  return typeof timestamp === "string" ? timestamp.slice(0, 16) : "";
}

/**
 * Fetch the handoff PR's comments, tagged for the agent. Comments and review
 * summaries are both prefixed with the fix PR number; unreadable comments
 * degrade to none (the fix-PR status marker keeps the cycle retrying).
 */
export async function collectFixPrComments(
  fixPr: unknown,
  github: GitHubClient,
  repos: ProjectReposMap,
  data: GhPrData | null,
): Promise<CommentRecord[]> {
  const resolved = resolveFixPr(fixPr, repos);
  if (resolved === null) return [];
  const { ownerRepo, number } = resolved;
  let comments: CommentRecord[] = [];
  try {
    const fetched = await github.getPrComments(ownerRepo, number);
    comments = fetched.map((comment) => ({
      ...comment,
      b: `[fix PR #${number}] ${typeof comment.b === "string" ? comment.b : ""}`,
    }));
  } catch {
    comments = [];
  }
  if (data === null) return comments.sort((a, b) => commentTime(a).localeCompare(commentTime(b)));

  for (const review of data.reviews ?? []) {
    const body = (review.body ?? "").trim();
    if (body === "" && review.state !== "CHANGES_REQUESTED") continue;
    comments.push({
      a: review.author?.login ?? "?",
      t: (review.submittedAt ?? "").slice(0, 16),
      b: `[fix PR #${number}] [REVIEW ${review.state ?? "?"}] ${body === "" ? "(no review summary)" : body}`,
    });
  }
  return comments.sort((a, b) => commentTime(a).localeCompare(commentTime(b)));
}

/** Issue prefixes that belong to the live Renovate PR, not its fix PR. */
const RENOVATE_LIVE_ISSUE_PREFIXES: readonly string[] = [
  "ci_fail",
  "konflux_urls",
  "review:",
  "review_comment:",
];

function isRenovateLiveIssue(issue: string): boolean {
  return issue === "conflict" || RENOVATE_LIVE_ISSUE_PREFIXES.some((p) => issue.startsWith(p));
}

/** Keep fix-PR CI/conflict/review signals; never adopt its MERGED/CLOSED. */
function fixLiveIssues(issues: readonly string[]): string[] {
  const kept: string[] = [];
  for (const issue of issues) {
    if (issue === "merged" || issue === "closed") continue;
    if (issue.startsWith("konflux_urls:")) {
      kept.push(issue);
      continue;
    }
    if (
      issue.startsWith("ci_fail") ||
      issue === "conflict" ||
      issue.startsWith("review:") ||
      issue.startsWith("review_comment:")
    ) {
      kept.push(issue);
    }
  }
  return kept;
}

/**
 * Hand CI, conflicts, reviews, and comments to `metadata.fix_pr` once it
 * exists. Renovate MERGED/CLOSED always win for lifecycle; an unreachable
 * fix PR forces another cycle through a synthetic CI failure instead of
 * falling through to green Renovate CI.
 */
export async function applyFixPrHandoff(
  enriched: EnrichedGhTask | null,
  github: GitHubClient,
  repos: ProjectReposMap,
): Promise<EnrichedGhTask | null> {
  if (enriched === null) return null;
  const fixPr = metadataRecord(enriched.task).fix_pr;
  const resolved = resolveFixPr(fixPr, repos);
  if (resolved === null) return enriched;
  const { ownerRepo, number } = resolved;
  if (alreadyTracked(enriched, ownerRepo, number)) return enriched;

  const issues = [...enriched.issues];
  const renovateTerminal = issues.includes("merged") || issues.includes("closed");

  let data: GhPrData | null = null;
  try {
    data = await github.getPr(ownerRepo, number);
  } catch {
    data = null;
  }
  const fixComments = await collectFixPrComments(fixPr, github, repos, data);

  const merged: EnrichedGhTask = {
    ...enriched,
    prComments: fixComments,
    fixPr: { repo: ownerRepo, num: number, host: "github" },
  };
  if (renovateTerminal) return merged;

  const kept = issues.filter((issue) => !isRenovateLiveIssue(issue));
  if (data === null) {
    kept.push("ci_fail:fix_pr_status_unavailable");
    return { ...merged, issues: kept };
  }

  const lastAddressed = enriched.task.last_addressed ?? "";
  const { state, issues: fixIssues } = classifyGh(data, lastAddressed);
  const live = fixLiveIssues(fixIssues);
  kept.push(...live);
  const fixPrEntry: GhPrTaskEntry = {
    repo: ownerRepo,
    num: number,
    host: "github",
    state,
    issues: live,
    role: "fix_pr",
  };
  return {
    ...merged,
    issues: kept,
    prs: [...merged.prs, fixPrEntry],
  };
}

/**
 * Drop a conflict issue that only belongs to the Renovate PR — Renovate
 * rebases on its own. A conflict on the fix PR is the bot's problem and
 * stays visible; a Renovate-only conflict with new human feedback keeps the
 * task for Priority 1.
 */
export function suppressRenovateOnlyConflict(
  enriched: EnrichedGhTask | null,
  task: MemoryTask,
): EnrichedGhTask | null {
  if (enriched === null) return null;
  if (!enriched.issues.includes("conflict")) return enriched;
  if (metadataRecord(task).fix_pr) return enriched;
  if (hasNewFeedback(enriched)) {
    return {
      ...enriched,
      issues: enriched.issues.filter((issue) => issue !== "conflict"),
    };
  }
  return null;
}

/**
 * The status preflight's per-task enrichment: the base Renovate PR data,
 * then fix-PR handoff, then Renovate-only conflict suppression.
 */
export async function enrichRenovateTask(
  task: MemoryTask,
  github: GitHubClient,
  repos: ProjectReposMap,
  trackers: GhFetchTrackers,
): Promise<EnrichedGhTask | null> {
  const enriched = await enrichGh(task, github, repos, trackers);
  const handedOff = await applyFixPrHandoff(enriched, github, repos);
  return suppressRenovateOnlyConflict(handedOff, task);
}

/** A task's metadata object, or `{}` when absent/malformed. */
export function metadataRecord(task: MemoryTask): Record<string, unknown> {
  const metadata = task.metadata;
  return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

/**
 * Paused Renovate tasks with human feedback newer than `last_addressed` —
 * the Python wrapper's `### BLOCKED FEEDBACK` selection. Terminal Renovate
 * PRs are excluded (the close/archive priority owns them). Fix-PR handoff is
 * applied so the feedback surfaced is the one the agent can act on.
 */
export async function collectPausedRenovateFeedback(
  tasks: readonly MemoryTask[],
  github: GitHubClient,
  repos: ProjectReposMap,
  taskKeyPrefix: string,
): Promise<EnrichedGhTask[]> {
  const selected: EnrichedGhTask[] = [];
  for (const task of tasks) {
    if (task.status !== "paused") continue;
    const key = task.external_key ?? "";
    if (!key.startsWith(taskKeyPrefix)) continue;
    const trackers: GhFetchTrackers = {
      items: new FetchTracker(),
      comments: new FetchTracker(),
    };
    const enriched = await enrichGh(task, github, repos, trackers);
    const handedOff = await applyFixPrHandoff(enriched, github, repos);
    if (handedOff === null || !hasNewFeedback(handedOff)) continue;
    if (handedOff.issues.includes("merged") || handedOff.issues.includes("closed")) {
      continue;
    }
    selected.push(handedOff);
  }
  return selected;
}
