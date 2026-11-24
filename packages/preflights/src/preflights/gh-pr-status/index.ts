import { z } from "zod";
import { definePreflight } from "../../core/registry.js";
import type { PreflightExecutionResult } from "../../core/results.js";
import {
  FetchTracker,
  failureEvidenceLines,
  totalFetchFailureError,
} from "../../shared/failure-policy.js";
import type { CommentRecord } from "../../shared/format.js";
import { fmtComments, fmtTaskHeader, getTaskPrs, isBotAuthor } from "../../shared/format.js";
import type { GhPrData, GitHubClient } from "../../shared/github.js";
import { createGitHubClient } from "../../shared/github.js";
import type { MemoryServerClient, MemoryTask } from "../../shared/memory-server.js";
import { ACTIVE_TASK_STATUSES } from "../../shared/memory-server.js";
import type { ProjectReposMap } from "../../shared/repos.js";
import { upstreamRepo } from "../../shared/repos.js";
import type { PreflightRunContext, PreflightRunState } from "../../shared/run-context.js";
import { isNewer } from "../../shared/time.js";
import { classifyGh } from "./classify.js";

/**
 * `gh-pr-status` — the port of the Python `gh_pr_status.py` preflight.
 *
 * Active tasks' GitHub PRs: state, mergeability/conflicts, CI check rollup
 * (including Konflux `detailsUrl` extraction), review decisions, and
 * comments — classified into the buckets merged / closed / ci_fail /
 * conflict / feedback / clean. `start` (with Markdown content for the agent
 * prompt) when any bucket is actionable, `skip` otherwise. The task/PR
 * correlation runs through the shared memory-server client and the per-run
 * context cache; GitHub is reached through the auth proxy route wired on
 * the run context.
 *
 * Behavior parity with the Python script, with two deliberate adaptations
 * (the same ones gl-mr-status made):
 *
 * - The Python `main(suppress_terminal_if_addressed=...)` flag (set by the
 *   onboarding workflow) is an input parameter with a `false` default, so
 *   the preflight keeps no required inputs and stays valid in workflow
 *   default sets.
 * - Per-PR fetch failures skip that PR (the Python `gh_pr` wrapper degraded
 *   to `None`), and per-PR comment failures degrade to no comments (the
 *   `gh_pr_comments` wrapper) — but only as *isolated* failures, per the
 *   shared failure policy (`shared/failure-policy.ts`): when every
 *   attempted fetch of a class failed (PR details or comments), the run
 *   escalates to an `error` result naming the required route — an
 *   unavailable route, an auth/rate-limit/5xx outage, or a network failure
 *   is never a silent skip. Tolerated failures are recorded as evidence in
 *   the result content.
 * - The pr-label workflow's `01-gh-pr-status.py` wrapper becomes
 *   optional inputs with the same defaults-off behavior: `task_key_prefix`
 *   (its `own_tasks` scoping to `pr-label:*` keys) and
 *   `review_bot_author` / `review_bot_markers` (its `has_new_feedback`
 *   override counting marked review-bot comments as new feedback; see
 *   {@link hasNewReviewBotFeedback} for the timestamp-comparison
 *   deviation). Without them the preflight behaves exactly as before.
 */

export const GH_PR_STATUS_INPUT = z
  .strictObject({
    /**
     * Suppress merged/closed buckets for tasks already addressed without new
     * feedback (the onboarding workflow's `main(suppress_terminal_if_addressed=True)`).
     */
    suppress_terminal_if_addressed: z.boolean().default(false),
    /**
     * Scope the task scan to external keys starting with this prefix (the
     * pr-label workflow's `01-gh-pr-status.py` wrapper: `own_tasks` kept
     * only `pr-label:*` keys so a shared instance id cannot mix other
     * workflows' tasks into this check). Unset keeps every task.
     */
    task_key_prefix: z.string().optional(),
    /** Review-bot login compared case-insensitively; requires `review_bot_markers`. */
    review_bot_author: z.string().trim().min(1).optional(),
    /** Case-insensitive body markers that flag a review finding; requires `review_bot_author`. */
    review_bot_markers: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine(
    ({ review_bot_author, review_bot_markers }) =>
      (review_bot_author === undefined) === (review_bot_markers === undefined),
    { message: "review_bot_author and review_bot_markers must be supplied together" },
  );

export type GhPrStatusParams = z.infer<typeof GH_PR_STATUS_INPUT>;

/** One PR of a task, enriched with its classification. */
export interface GhPrTaskEntry {
  readonly repo: string;
  readonly num: number;
  readonly host: "github";
  readonly state: string;
  readonly issues: readonly string[];
}

/** A task enriched with its GitHub PR data — the Python `enrich_gh` result. */
export interface EnrichedGhTask {
  readonly task: MemoryTask;
  readonly prs: readonly GhPrTaskEntry[];
  readonly prComments: readonly CommentRecord[];
  readonly issues: readonly string[];
}

/** The six action buckets, in output order. */
export interface GhStatusBuckets {
  readonly merged: readonly EnrichedGhTask[];
  readonly closed: readonly EnrichedGhTask[];
  readonly ciFail: readonly EnrichedGhTask[];
  readonly conflict: readonly EnrichedGhTask[];
  readonly feedback: readonly EnrichedGhTask[];
  readonly clean: readonly EnrichedGhTask[];
}

/** Dependencies of the ported `main()` flow, injectable for tests. */
export interface GhPrStatusDeps {
  readonly memory: MemoryServerClient;
  readonly state: PreflightRunState;
  readonly github: GitHubClient;
  /** Instance repo map for bare repo-name resolution; defaults to empty. */
  readonly repos?: ProjectReposMap;
}

export interface GhPrStatusOptions {
  /**
   * The onboarding mode of the Python `main(suppress_terminal_if_addressed
   * = True)`: merged/closed tasks whose feedback was already addressed land
   * in clean instead of the terminal buckets. Defaults to false.
   */
  readonly suppressTerminalIfAddressed?: boolean;
  /**
   * Scope the task scan to external keys with this prefix (the pr-label
   * wrapper's `own_tasks` scoping). Unset keeps every task.
   */
  readonly taskKeyPrefix?: string;
  /**
   * Count marked comments by this review-bot author as new feedback (the
   * pr-label wrapper's `has_new_feedback` override). Unset keeps the base
   * bot-comment exclusion.
   */
  readonly reviewBotFeedback?: ReviewBotFeedback;
}

/**
 * The review-bot feedback rule of the pr-label wrapper's
 * `01-gh-pr-status.py`: comments by `author` whose body contains any of
 * `markers` count as new feedback, on top of the base rule.
 */
export interface ReviewBotFeedback {
  readonly author: string;
  readonly markers: readonly string[];
}

const BUCKET_SECTIONS: readonly (readonly [keyof GhStatusBuckets, string])[] = [
  ["merged", "MERGED"],
  ["closed", "CLOSED"],
  ["ciFail", "CI FAILING"],
  ["conflict", "CONFLICTS"],
  ["feedback", "FEEDBACK"],
];

/** Per-run GitHub fetch bookkeeping for the failure policy. */
export interface GhFetchTrackers {
  /** PR detail fetches (one per existing, resolvable PR of the active tasks). */
  readonly items: FetchTracker;
  /** Comment fetches (one per successfully fetched PR). */
  readonly comments: FetchTracker;
}

/**
 * Enrich a task with its GitHub PR data; null when it has no (fetchable)
 * GitHub PRs. Per the shared failure policy: a PR fetch failure skips that
 * PR and is tallied — tolerated while other PRs still fetch (isolated,
 * item-specific), escalated by the run flow when nothing could be fetched.
 * A missing PR confirmed by the API (`pullRequest: null`) counts as a
 * successful fetch, not a failure. A comments fetch failure skips that
 * PR's comments and is tallied the same way — the Python `gh_pr_comments`
 * wrapper degraded to `[]`, but a run where every fetched PR's comments
 * failed is a systematic outage the run flow escalates instead of silently
 * erasing all feedback.
 */
export async function enrichGh(
  task: MemoryTask,
  github: GitHubClient,
  repos: ProjectReposMap,
  trackers: GhFetchTrackers,
): Promise<EnrichedGhTask | null> {
  const prsInfo = getTaskPrs(task, repos);
  const ghPrs = prsInfo.filter((pr) => (pr.host ?? "github") === "github");
  if (ghPrs.length === 0) {
    return null;
  }

  const prResults: GhPrTaskEntry[] = [];
  const prComments: CommentRecord[] = [];
  const allIssues: string[] = [];
  const taskRepo = typeof task.repo === "string" ? task.repo : "";

  for (const prInfo of ghPrs) {
    const prRepo = typeof prInfo.repo === "string" && prInfo.repo !== "" ? prInfo.repo : taskRepo;
    const prNum = prInfo.number;
    if (!prNum) {
      continue;
    }
    const { upstreamPath } = upstreamRepo(prRepo, repos);
    if (upstreamPath === "") {
      continue;
    }
    const item = `${upstreamPath}#${prNum}`;
    let data: GhPrData | null;
    try {
      data = await github.getPr(upstreamPath, prNum);
    } catch (error) {
      trackers.items.recordFailure(item, error);
      continue;
    }
    trackers.items.recordSuccess();
    if (data === null) {
      continue;
    }
    const lastAddressed = typeof task.last_addressed === "string" ? task.last_addressed : "";
    const { state, issues } = classifyGh(data, lastAddressed);
    prResults.push({ repo: prRepo, num: prNum, host: "github", state, issues });
    allIssues.push(...issues);
    try {
      prComments.push(...(await github.getPrComments(upstreamPath, prNum)));
      trackers.comments.recordSuccess();
    } catch (error) {
      // Isolated comment failure: degrade to no comments for this PR (the
      // Python gh_pr_comments wrapper parity). A run where every fetched
      // PR's comments failed is escalated by the run flow — never a silent
      // erasure of all feedback.
      trackers.comments.recordFailure(item, error);
    }
    for (const review of data.reviews ?? []) {
      const body = (review.body ?? "").trim();
      if (body !== "") {
        prComments.push({
          a: review.author?.login ?? "?",
          t: review.submittedAt ?? "",
          b: `[REVIEW ${review.state ?? "?"}] ${body}`,
        });
      }
    }
  }

  if (prResults.length === 0) {
    return null;
  }
  return { task, prs: prResults, prComments, issues: allIssues };
}

/**
 * True when a marked review-bot comment postdates the task's
 * last_addressed — the pr-label wrapper's `has_new_feedback` override.
 *
 * One deliberate deviation from the wrapper, documented here: the Python
 * wrapper compared minute-truncated strings (`created_at[:16] >
 * last_addressed[:16]`), dropping same-minute findings — the exact bug the
 * base port fixed for human comments (RHCLOUD-53177). This port uses the
 * shared `isNewer` full-resolution comparison, so a marked bot comment
 * posted seconds after `last_addressed` counts, exactly like a human one.
 * The Python wrapper's `casefold()` comparisons become `toLowerCase()`
 * (equivalent for these ASCII logins and markers).
 */
function hasNewReviewBotFeedback(enriched: EnrichedGhTask, reviewBot: ReviewBotFeedback): boolean {
  const author = reviewBot.author.toLowerCase();
  const markers = reviewBot.markers.map((marker) => marker.toLowerCase());
  const lastAddressed = enriched.task.last_addressed;
  for (const comment of enriched.prComments) {
    const commentAuthorLogin = commentAuthor(comment);
    const body = comment.b;
    const isReviewBotFinding =
      commentAuthorLogin !== null &&
      commentAuthorLogin.toLowerCase() === author &&
      typeof body === "string" &&
      markers.some((marker) => body.toLowerCase().includes(marker));
    if (!isReviewBotFinding) {
      continue;
    }
    if (!lastAddressed || isNewer(commentTimestamp(comment), lastAddressed)) {
      return true;
    }
  }
  return false;
}

/** True when a non-bot PR comment is newer than the task's last_addressed. */
export function hasNewFeedback(enriched: EnrichedGhTask, reviewBot?: ReviewBotFeedback): boolean {
  if (reviewBot !== undefined && hasNewReviewBotFeedback(enriched, reviewBot)) {
    return true;
  }
  const lastAddressed = enriched.task.last_addressed;
  for (const comment of enriched.prComments) {
    if (isBotAuthor(commentAuthor(comment))) {
      continue;
    }
    if (!lastAddressed || isNewer(commentTimestamp(comment), lastAddressed)) {
      return true;
    }
  }
  return false;
}

/** Whether an addressed CI failure needs another agent session. */
export function ciFailureNeedsSession(
  enriched: EnrichedGhTask,
  reviewBot?: ReviewBotFeedback,
): boolean {
  return !enriched.task.last_addressed || hasNewFeedback(enriched, reviewBot);
}

/**
 * Sort enriched tasks into the six buckets — the classification loop of the
 * Python `main()`. Exposed for tests and reused by the run flow.
 */
export function classifyBuckets(
  enrichedTasks: readonly EnrichedGhTask[],
  options: GhPrStatusOptions = {},
): GhStatusBuckets {
  const merged: EnrichedGhTask[] = [];
  const closed: EnrichedGhTask[] = [];
  const ciFail: EnrichedGhTask[] = [];
  const conflict: EnrichedGhTask[] = [];
  const feedback: EnrichedGhTask[] = [];
  const clean: EnrichedGhTask[] = [];
  const suppress = options.suppressTerminalIfAddressed ?? false;
  const reviewBot = options.reviewBotFeedback;
  for (const enriched of enrichedTasks) {
    const { issues } = enriched;
    if (issues.includes("merged")) {
      if (suppress && enriched.task.last_addressed && !hasNewFeedback(enriched, reviewBot)) {
        clean.push(enriched);
      } else {
        merged.push(enriched);
      }
    } else if (issues.includes("closed")) {
      if (suppress && enriched.task.last_addressed && !hasNewFeedback(enriched, reviewBot)) {
        clean.push(enriched);
      } else {
        closed.push(enriched);
      }
    } else if (issues.some((issue) => issue.startsWith("ci_fail"))) {
      const ciOnly = issues.every(
        (issue) => issue.startsWith("ci_fail") || issue.startsWith("konflux_urls"),
      );
      if (ciOnly && !ciFailureNeedsSession(enriched, reviewBot)) {
        clean.push(enriched);
      } else {
        ciFail.push(enriched);
      }
    } else if (issues.includes("conflict")) {
      conflict.push(enriched);
    } else if (
      issues.some((issue) => issue === "changes_requested" || issue.startsWith("review:"))
    ) {
      if (hasNewFeedback(enriched, reviewBot) || !enriched.task.last_addressed) {
        feedback.push(enriched);
      } else {
        clean.push(enriched);
      }
    } else if (hasNewFeedback(enriched, reviewBot)) {
      feedback.push(enriched);
    } else {
      clean.push(enriched);
    }
  }
  return { merged, closed, ciFail, conflict, feedback, clean };
}

/** Format a task with its GH PR details — the Python `fmt_task`. */
function fmtTask(enriched: EnrichedGhTask): string {
  const lines = fmtTaskHeader(enriched.task);
  for (const pr of enriched.prs) {
    const issueStr = pr.issues.length > 0 ? pr.issues.join(",") : "clean";
    lines.push(`  PR ${pr.repo}#${pr.num} (github) state=${pr.state} [${issueStr}]`);
    for (const issue of pr.issues) {
      if (issue.startsWith("konflux_urls:")) {
        for (const url of issue.slice("konflux_urls:".length).split(";")) {
          lines.push(`    konflux_details: ${url}`);
        }
      }
    }
  }
  const lastAddressed = enriched.task.last_addressed;
  if (enriched.prComments.length > 0) {
    lines.push(fmtComments(enriched.prComments, "pr_comments", lastAddressed));
  }
  return lines.join("\n");
}

/**
 * The ported `main()` flow: fetch tasks and capacity through the shared
 * memory-server client, enrich active tasks' GitHub PRs, classify into
 * buckets, save the run state, and return the protocol result.
 */
export async function runGhPrStatus(
  deps: GhPrStatusDeps,
  options: GhPrStatusOptions = {},
): Promise<PreflightExecutionResult> {
  const tasks = await deps.memory.getTasks();
  // The pr-label wrapper's task scoping: only external keys with the
  // configured prefix are this workflow's tasks. Applied before the active
  // filter, so other workflows' tasks never reach the buckets (and never
  // count as active for the skip message).
  const scopedTasks =
    options.taskKeyPrefix === undefined
      ? tasks
      : tasks.filter(
          (task) =>
            typeof task.external_key === "string" &&
            task.external_key.startsWith(options.taskKeyPrefix as string),
        );
  const capacity = await deps.memory.getCapacity();
  const active = scopedTasks.filter((task) => ACTIVE_TASK_STATUSES.includes(task?.status ?? ""));

  if (active.length === 0) {
    return {
      status: "skip",
      content: `GH PR status: no active tasks (capacity ${capacity.active}/${capacity.max})`,
    };
  }

  const repos = deps.repos ?? {};
  const trackers: GhFetchTrackers = {
    items: new FetchTracker(),
    comments: new FetchTracker(),
  };
  const enrichedTasks: EnrichedGhTask[] = [];
  for (const task of active) {
    const enriched = await enrichGh(task, deps.github, repos, trackers);
    if (enriched !== null) {
      enrichedTasks.push(enriched);
    }
  }

  // The failure policy: a total inability to fetch the attempted PRs —
  // auth (401/403), rate limit (429), upstream 5xx, network/timeout, or
  // the 404 of a route the proxy does not serve — is an execution error
  // naming the required route, never a silent "no PRs to check" skip. The
  // same holds when every fetched PR's comments failed: feedback would be
  // silently erased. Isolated failures are tolerated and recorded below.
  const itemOutage = totalFetchFailureError(trackers.items, {
    system: "GitHub",
    noun: "PR",
    route: deps.github.route,
  });
  if (itemOutage !== null) {
    throw itemOutage;
  }
  const commentOutage = totalFetchFailureError(trackers.comments, {
    system: "GitHub",
    noun: "PR comment",
    route: deps.github.route,
  });
  if (commentOutage !== null) {
    throw commentOutage;
  }

  if (enrichedTasks.length === 0) {
    // Every attempted PR was either confirmed missing by the API (a
    // healthy route — the fetch succeeded) or failed in isolation, so this
    // stays a skip; the tolerated failures keep their evidence instead of
    // being dropped by the early return. Comments are only fetched for
    // non-null PRs, so none can have been attempted here.
    const lines = [`GH PR status: no GH PRs to check (${active.length} active tasks)`];
    const emptyRunFailures = failureEvidenceLines(trackers.items, "PR");
    if (emptyRunFailures.length > 0) {
      lines.push("");
      lines.push(`### UNFETCHABLE (${emptyRunFailures.length})`);
      lines.push(...emptyRunFailures);
      lines.push("");
    }
    return { status: "skip", content: lines.join("\n") };
  }

  const buckets = classifyBuckets(enrichedTasks, options);

  const lines = [`## GH PR Status (${enrichedTasks.length} PRs checked)`, ""];
  let actionable = 0;
  for (const [bucket, label] of BUCKET_SECTIONS) {
    const entries = buckets[bucket];
    if (entries.length === 0) {
      continue;
    }
    lines.push(`### ${label} (${entries.length})`);
    for (const enriched of entries) {
      lines.push(fmtTask(enriched));
      lines.push("");
    }
    actionable += entries.length;
  }
  if (buckets.clean.length > 0) {
    lines.push(`### CLEAN (${buckets.clean.length})`);
    for (const enriched of buckets.clean) {
      const task = enriched.task;
      lines.push(`  ${task.external_key ?? "?"} [${task.status ?? "?"}] ${task.repo ?? "?"}`);
    }
    lines.push("");
  }
  const failureLines = [
    ...failureEvidenceLines(trackers.items, "PR"),
    ...failureEvidenceLines(trackers.comments, "PR comments"),
  ];
  if (failureLines.length > 0) {
    // Isolated fetch failures are evidence, not actionable buckets: the
    // skipped PR/MR (or its comments) could not be checked this run.
    lines.push(`### UNFETCHABLE (${failureLines.length})`);
    lines.push(...failureLines);
    lines.push("");
  }

  deps.state.set("gh_pr", {
    merged: buckets.merged.length,
    closed: buckets.closed.length,
    ci_fail: buckets.ciFail.length,
    conflicts: buckets.conflict.length,
    feedback: buckets.feedback.length,
    clean: buckets.clean.length,
  });
  deps.state.set("has_actionable", actionable > 0);

  const content = lines.join("\n");
  return actionable > 0 ? { status: "start", content } : { status: "skip", content };
}

/**
 * The registered preflight. Wires the run context into the flow: the GitHub
 * client is built from the run's auth-proxy route, the repo map resolves
 * bare repo names, and any failure — including an unwired proxy route —
 * surfaces as an `error` result, never a silent skip.
 */
export const ghPrStatus = definePreflight({
  id: "gh-pr-status",
  input: GH_PR_STATUS_INPUT,
  run: async (
    ctx: PreflightRunContext,
    params: GhPrStatusParams,
  ): Promise<PreflightExecutionResult> => {
    if (ctx.proxy === undefined) {
      return {
        status: "error",
        content:
          "gh-pr-status: auth proxy route is not wired for this run (missing proxy base URL)",
      };
    }
    try {
      const { review_bot_author: author, review_bot_markers: markers } = params;
      return await runGhPrStatus(
        {
          memory: ctx.memory,
          state: ctx.state,
          github: createGitHubClient(
            typeof ctx.proxy === "string" ? { baseUrl: ctx.proxy } : ctx.proxy,
          ),
          repos: ctx.repos ?? {},
        },
        {
          suppressTerminalIfAddressed: params.suppress_terminal_if_addressed,
          taskKeyPrefix: params.task_key_prefix,
          reviewBotFeedback:
            author !== undefined && markers !== undefined ? { author, markers } : undefined,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "error", content: `gh-pr-status: ${message}` };
    }
  },
});

function commentAuthor(comment: CommentRecord): string | null {
  const author = comment.a;
  return typeof author === "string" ? author : null;
}

function commentTimestamp(comment: CommentRecord): string {
  const timestamp = comment.t;
  return typeof timestamp === "string" ? timestamp : "";
}
