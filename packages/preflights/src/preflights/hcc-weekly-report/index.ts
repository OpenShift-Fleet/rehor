import { z } from "zod";
import type { PreflightExecutionResult } from "../../core/results.js";
import {
  appendFetchEvidence,
  FetchTracker,
  totalFetchFailureError,
} from "../../shared/failure-policy.js";
import { fmtComments, fmtTaskHeader } from "../../shared/format.js";
import type { GitHubClient } from "../../shared/github.js";
import { defineGitHubPreflight } from "../../shared/github.js";
import type { MemoryServerClient } from "../../shared/memory-server.js";
import { findTaskByKey } from "../../shared/memory-server.js";
import type { ProjectReposMap } from "../../shared/repos.js";
import { isoDateUtc } from "../../shared/time.js";
import type { GhFetchTrackers } from "../gh-pr-status/index.js";
import { enrichGh, hasNewFeedback } from "../gh-pr-status/index.js";

/**
 * `hcc-weekly-report` — the port of the hcc-framework-agent-dev
 * manager-tasks preflight `01-task-dispatch.py` (task dispatch for the HCC
 * weekly status reports).
 *
 * Only Monday and Tuesday act. Monday without a task for the week starts
 * the generate phase; a task with new PR feedback starts the feedback
 * phase; Tuesday at/after `merge_hour_utc` with no blocking reviews starts
 * the merge phase; merged/closed/done tasks and everything else skip. The
 * task for a week is keyed `weekly-report-{friday}` in the memory server
 * (the weekly-status repo organizes reports by Friday date), and the task's
 * PRs are enriched through the gh-pr-status machinery (`enrichGh`,
 * `hasNewFeedback`) with the same failure policy.
 *
 * Behavior parity with the Python script, with the agreed adaptations:
 *
 * - The Python constants (`UPSTREAM_REPO`, `BRANCH_PATTERN`,
 *   `MERGE_HOUR_UTC`) become input parameters with the same defaults, so
 *   the instance configures them in `instance.yaml` instead of the script.
 * - The Python read the runner's local `date.today()`; the port reads the
 *   UTC day and hour of the injected clock (the merge hour was already a
 *   UTC hour, so one clock keeps the schedule coherent).
 * - The Python `main()` logged each check's skip reason to stderr and
 *   emitted a generic skip; the port surfaces the check's reason as the
 *   skip content, where the cycle report can see it.
 */

export const HCC_WEEKLY_REPORT_INPUT = z.strictObject({
  /**
   * Upstream repository of the weekly reports (the Python `UPSTREAM_REPO`
   * constant), `owner/repo`.
   */
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repo must look like owner/repo"),
  /** Branch name pattern (Python `BRANCH_PATTERN`). */
  branch_pattern: z.string().default("hcc-team-weekly-report"),
  /**
   * UTC hour from which the Tuesday merge step may run (Python
   * `MERGE_HOUR_UTC`; 10:00 UTC = noon Prague in summer).
   */
  merge_hour_utc: z.number().int().min(0).max(23).default(10),
});

export type HccWeeklyReportParams = z.infer<typeof HCC_WEEKLY_REPORT_INPUT>;

/** Dependencies of the ported `main()` flow, injectable for tests. */
export interface HccWeeklyReportDeps {
  readonly memory: MemoryServerClient;
  readonly github: GitHubClient;
  /** Instance repo map for bare repo-name resolution; defaults to empty. */
  readonly repos?: ProjectReposMap;
  /** Injectable clock so tests can fix the weekday and the hour. */
  readonly now?: () => Date;
}

/**
 * The Friday of the current reporting week — the Python
 * `_friday_of_week`. Monday–Saturday map to their week's Friday; Sunday
 * maps to the previous Friday (that week is already done).
 */
function fridayOfWeek(date: Date): Date {
  const weekday = pythonWeekday(date);
  if (weekday === 6) {
    // Sunday
    return shiftUtcDays(date, -2);
  }
  return shiftUtcDays(date, 4 - weekday);
}

/** Python `weekday()`: Monday=0 … Sunday=6, on the UTC calendar day. */
function pythonWeekday(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

function shiftUtcDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

/**
 * The ported `main()` flow: decide which weekly-report phase (generate,
 * feedback, merge) this cycle is in, or skip.
 */
export async function runHccWeeklyReport(
  deps: HccWeeklyReportDeps,
  params: HccWeeklyReportParams,
): Promise<PreflightExecutionResult> {
  const now = deps.now?.() ?? new Date();
  const weekday = pythonWeekday(now);

  // Monday (generate), Tuesday (feedback/merge); other days do nothing.
  if (weekday !== 0 && weekday !== 1) {
    return { status: "skip", content: "Not a scheduled day" };
  }

  const friday = fridayOfWeek(now);
  const fridayStr = isoDateUtc(friday);
  const taskId = `weekly-report-${fridayStr}`;

  const tasks = await deps.memory.getTasks();
  const task = findTaskByKey(tasks, taskId) ?? null;

  // No task exists yet — generate phase (Monday only).
  if (task === null) {
    if (weekday === 0) {
      const content =
        `## TASK: weekly-report-generate\n\n` +
        `Generate HCC weekly status reports for week ending ${fridayStr}.\n\n` +
        `- **Task ID**: ${taskId}\n` +
        `- **Task status**: new\n` +
        `- **Scope**: hcc-team all (all HCC sub-teams)\n` +
        `- **Repo**: ${params.repo}\n` +
        `- **Branch**: {git_user}/${params.branch_pattern}-${fridayStr}\n` +
        `- **Friday date**: ${fridayStr}\n`;
      return { status: "start", content };
    }
    return { status: "skip", content: `Tuesday but no task found for ${fridayStr}` };
  }

  // Task exists — check its status.
  const status = task.status ?? "";

  if (status === "done") {
    return { status: "skip", content: `Task ${taskId} already done` };
  }

  // Enrich the task's PRs with GitHub data, tracked and escalated exactly
  // like gh-pr-status: an isolated PR/comment fetch failure is tolerated
  // with evidence, a total inability to fetch is an execution error.
  const trackers: GhFetchTrackers = {
    items: new FetchTracker(),
    comments: new FetchTracker(),
  };
  const enriched = await enrichGh(task, deps.github, deps.repos ?? {}, trackers);

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

  if (enriched !== null) {
    const prIssues = enriched.issues;

    // PR was merged — task should be marked done.
    if (prIssues.includes("merged")) {
      return {
        status: "skip",
        content: appendFetchEvidence(`PR already merged for ${taskId}`, [
          [trackers.items, "PR"],
          [trackers.comments, "PR comments"],
        ]),
      };
    }

    // PR was closed.
    if (prIssues.includes("closed")) {
      return {
        status: "skip",
        content: appendFetchEvidence(`PR closed for ${taskId}`, [
          [trackers.items, "PR"],
          [trackers.comments, "PR comments"],
        ]),
      };
    }

    // PR has new feedback to address.
    if (hasNewFeedback(enriched)) {
      const lines = fmtTaskHeader(task);
      for (const pr of enriched.prs) {
        const issueStr = pr.issues.length > 0 ? pr.issues.join(",") : "clean";
        lines.push(`  PR ${pr.repo}#${pr.num} [${issueStr}]`);
      }
      if (enriched.prComments.length > 0) {
        lines.push(fmtComments(enriched.prComments, "review_comments", task.last_addressed));
      }
      const content =
        `## TASK: weekly-report-feedback\n\n` +
        `Address review feedback on the weekly report PR.\n\n` +
        `- **Task ID**: ${taskId}\n` +
        `- **Task status**: in_progress\n` +
        `- **Friday date**: ${fridayStr}\n\n` +
        `### PR Details\n\n${lines.join("\n")}\n`;
      return {
        status: "start",
        content: appendFetchEvidence(content, [
          [trackers.items, "PR"],
          [trackers.comments, "PR comments"],
        ]),
      };
    }

    // Tuesday at/after the merge hour, no blocking reviews — merge.
    if (weekday === 1 && now.getUTCHours() >= params.merge_hour_utc) {
      const pr = enriched.prs[0];
      const prRepo = pr?.repo ?? params.repo;
      const prNum = pr?.num ?? "?";
      const content =
        `## TASK: weekly-report-merge\n\n` +
        `Merge the weekly report PR — no blocking reviews.\n\n` +
        `- **Task ID**: ${taskId}\n` +
        `- **Task status**: in_progress\n` +
        `- **PR**: ${prRepo}#${prNum}\n` +
        `- **Friday date**: ${fridayStr}\n`;
      return {
        status: "start",
        content: appendFetchEvidence(content, [
          [trackers.items, "PR"],
          [trackers.comments, "PR comments"],
        ]),
      };
    }
  }

  return {
    status: "skip",
    content: appendFetchEvidence(`Task ${taskId} [${status}], no action needed`, [
      [trackers.items, "PR"],
      [trackers.comments, "PR comments"],
    ]),
  };
}

/**
 * The registered preflight — the shared GitHub-preflight factory
 * (`defineGitHubPreflight`) wires the run context into the flow: the GitHub
 * client is built from the run's auth-proxy route, the repo map resolves
 * bare repo names, and any failure — including an unwired proxy route —
 * surfaces as an `error` result, never a silent skip.
 */
export const hccWeeklyReport = defineGitHubPreflight({
  id: "hcc-weekly-report",
  input: HCC_WEEKLY_REPORT_INPUT,
  run: runHccWeeklyReport,
});
