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
import type { ProjectReposMap } from "../../shared/repos.js";
import type { LocalScheduleWindow } from "../../shared/schedule.js";
import { isWithinLocalWindow } from "../../shared/schedule.js";
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
 * the merge phase; merged/closed/done/archived/paused tasks and everything
 * else skip. The task for a week is keyed `weekly-report-{friday}` in the
 * memory server (the weekly-status repo organizes reports by Friday
 * date), and the task's PRs are enriched through the gh-pr-status
 * machinery (`enrichGh`, `hasNewFeedback`) with the same failure policy.
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
 * - The port adds a time gate: the manager is KEDA-scheduled 07:00–21:00
 *   Europe/Prague (its effective timezone — the GitOps UTC comment is
 *   stale), and this preflight dispatches Monday/Tuesday, so cycles
 *   outside Mon/Tue 07:00–21:00 Europe/Prague skip before any state is
 *   read. The UTC weekday, merge hour, and Friday-calendar selection are
 *   unchanged.
 * - The port looks the week's task up by exact key (`getTaskByKey`)
 *   instead of scanning the newest-50 active listing: the deterministic
 *   gate must also see archived tasks and tasks displaced past the newest
 *   50, or a Monday cycle would re-start the generate phase for a week
 *   whose task already exists. The canonical lookup targets the
 *   `scheduled` source the manager-tasks workflow creates its tasks with
 *   (AGENTS.md `task_add`), with a same-key any-source fallback so tasks
 *   created before that convention (or with the `task_add` default source)
 *   still gate the week; every lookup failure errors the cycle instead of
 *   masquerading as "no task yet".
 * - The port treats a `paused` task as parked: it never triggers the
 *   feedback or merge phases, because unpausing is an explicit human
 *   action (the Python script never saw paused weekly tasks — the listing
 *   it read predated pause support in this workflow).
 */

/**
 * The manager's effective active window intersected with this preflight's
 * dispatch days: KEDA runs the manager 07:00–21:00 Europe/Prague on
 * Mon–Wed/Fri, the weekly-report dispatch only acts Monday/Tuesday, so
 * the intersection is Mon/Tue 07:00–21:00 Europe/Prague. Start inclusive,
 * end exclusive, DST-aware through the shared schedule helper.
 */
const ACTIVE_WINDOW: LocalScheduleWindow = {
  days: [0, 1],
  startHour: 7,
  endHour: 21,
  timeZone: "Europe/Prague",
};

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

  // Inside the dispatch days but outside the manager's active hours
  // (07:00–21:00 Europe/Prague) — skip before touching memory or GitHub.
  if (!isWithinLocalWindow(now, ACTIVE_WINDOW)) {
    return {
      status: "skip",
      content: "Outside the manager active window (Mon/Tue 07:00–21:00 Europe/Prague)",
    };
  }

  const friday = fridayOfWeek(now);
  const fridayStr = isoDateUtc(friday);
  const taskId = `weekly-report-${fridayStr}`;

  // Exact-key lookup over the whole task table — archived tasks included,
  // independent of the newest-50 listing cap — so an existing week never
  // re-enters the generate phase. The canonical source is `scheduled`
  // (the manager-tasks `task_add` convention); the any-source fallback
  // keeps tasks created with a different source (the `task_add` default
  // is `jira`) gating the week too. Both lookups fail closed: an error
  // propagates and errors the cycle — it must never read as "no task".
  const task =
    (await deps.memory.getTaskByKey(taskId, { sourceType: "scheduled" })) ??
    (await deps.memory.getTaskByKey(taskId)) ??
    null;

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

  // Archived is terminal like done: the week's work is finished (or
  // removed) — never a reason to generate, feed back, or merge again.
  if (status === "archived") {
    return { status: "skip", content: `Task ${taskId} already archived` };
  }

  // Paused is an explicit human parking of the task: without an unpause
  // it must not trigger the feedback or merge phases (no PR enrichment
  // either — there is nothing to decide from while parked).
  if (status === "paused") {
    return {
      status: "skip",
      content: `Task ${taskId} is paused — explicit unpause required before further dispatch`,
    };
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
