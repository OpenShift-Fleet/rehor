import { z } from "zod";
import { definePreflight } from "../../core/registry.js";
import type { PreflightExecutionResult } from "../../core/results.js";
import { fmtComments, fmtTaskHeader, getTaskPrs } from "../../shared/format.js";
import type { JiraClient, JiraIssue } from "../../shared/jira.js";
import type { PreflightRunContext } from "../../shared/run-context.js";
import { isNewer } from "../../shared/time.js";
import { executionErrorResult, JIRA_CLIENT_NOT_WIRED } from "../jira-common/errors.js";
import { isRecord, issueComments, taskMetadata } from "../jira-common/shapes.js";
import { ACTIVE_TASK_STATUSES, selectPromptComments } from "../jira-common/triage.js";
import type { PrMergeCheck } from "./phases.js";
import {
  AUTO_ADVANCE_STEPS,
  anyPrMrMerged,
  createProxyPrMergeCheck,
  fmtOnboardingCandidate,
  getOnboardingLabel,
  hasNewOnboardingFeedback,
  isBlocked,
} from "./phases.js";

/**
 * onboarding — the port of `onboarding_preflight.py`. Label-based candidate
 * finder for onboarding requests plus phase-advancement checks on active
 * onboarding tasks. Returns start when there is actionable work:
 *   - active tasks with new Jira feedback → start
 *   - active tasks ready to advance phase (PR/MR merged) → start
 *   - new onboarding tickets found → start
 *   - nothing actionable → skip
 */

/** Fields requested for an active onboarding task's issue. */
const ONBOARDING_ISSUE_FIELDS: readonly string[] = [
  "summary",
  "status",
  "assignee",
  "labels",
  "issuelinks",
  "comment",
  "updated",
];

/** Fields requested for the onboarding candidate search. */
const ONBOARDING_SEARCH_FIELDS: readonly string[] = [
  "summary",
  "status",
  "assignee",
  "labels",
  "created",
];

/** Rejects blank strings (empty or whitespace-only) without altering the value. */
const nonBlank = (value: string) => value.trim() !== "";

const onboardingInput = z.strictObject({
  /**
   * Onboarding label (Python `BOT_LABEL`), validated against the same
   * character set the Python script enforced before interpolating it into
   * JQL.
   */
  label: z.string().regex(/^[a-zA-Z0-9:_-]+$/, "label may only contain [a-zA-Z0-9:_-]"),
  /**
   * Jira project for candidate search (Python `BOT_JIRA_PROJECT`). Blank
   * values fail closed at validation; omitted keeps the REHOR default.
   */
  project: z.string().refine(nonBlank, { message: "project must not be blank" }).default("REHOR"),
});

export type OnboardingParams = z.infer<typeof onboardingInput>;

/** Injectable run dependencies (the PR/MR merge check). */
export interface OnboardingRunDeps {
  readonly isPrMerged?: PrMergeCheck;
}

export const onboarding = definePreflight({
  id: "onboarding",
  input: onboardingInput,
  run: (ctx: PreflightRunContext, params) => {
    // The default merge check composes the GitHub and GitLab clients from
    // the run's auth-proxy route, exactly like gh-pr-status and gl-mr-status.
    // Without a route the check errors the moment a merge check is actually
    // needed (never a silent "not merged"); triage and candidate finding do
    // not need the route and keep working.
    const deps: OnboardingRunDeps =
      ctx.proxy === undefined ? {} : { isPrMerged: createProxyPrMergeCheck(ctx.proxy) };
    return runOnboardingPreflight(ctx, params, deps).catch(executionErrorResult);
  },
});

export async function runOnboardingPreflight(
  ctx: PreflightRunContext,
  params: OnboardingParams,
  deps: OnboardingRunDeps = {},
): Promise<PreflightExecutionResult> {
  const jira = ctx.jira;
  if (jira === undefined) {
    return { status: "error", content: JIRA_CLIENT_NOT_WIRED };
  }

  const tasks = await ctx.memory.getTasks();
  const capacity = await ctx.memory.getCapacity();
  const lines: string[] = [];
  let hasWork = false;

  // Phase 1: triage active onboarding tasks.
  const activeTasks = tasks.filter((task) => ACTIVE_TASK_STATUSES.includes(task.status ?? ""));

  for (const task of activeTasks) {
    const key = task.external_key ?? "";
    if (key === "") continue;

    const taskLines = fmtTaskHeader(task);
    const metadata = taskMetadata(task);

    const issue = await jira.getIssueWithComments(key, { fields: ONBOARDING_ISSUE_FIELDS });

    if (isBlocked(issue)) {
      taskLines.push("  *** BLOCKED — requires Rehor team intervention, skipping ***");
      lines.push(taskLines.join("\n"));
      continue;
    }

    const onboardingLabel = getOnboardingLabel(issue);
    const stepFromLabel =
      onboardingLabel !== null
        ? onboardingLabel.slice(onboardingLabel.indexOf(":") + 1)
        : String(metadata.step ?? "unknown");
    taskLines.push(`  onboarding_step: ${stepFromLabel} (label: ${onboardingLabel ?? "none"})`);

    const phaseTickets = isRecord(metadata.phase_tickets) ? metadata.phase_tickets : {};
    if (Object.keys(phaseTickets).length > 0) {
      taskLines.push(
        `  phase_tickets: P1=${phaseTickets.phase1 ?? "?"} P2=${phaseTickets.phase2 ?? "?"} P3=${phaseTickets.phase3 ?? "?"}`,
      );
    }

    const allComments = issueComments(issue);
    const lastAddressed = task.last_addressed ?? "";
    // Classification reads the full paginated history (a newest-slice tail
    // could hide feedback under newer comments); the rendered comments are
    // the bounded selection that keeps the triggering feedback visible.
    // Onboarding counts any unaddressed comment as feedback — no marker
    // filter — matching the ported Python helper.
    if (hasNewOnboardingFeedback(allComments, lastAddressed)) {
      taskLines.push("  *** HAS NEW JIRA FEEDBACK ***");
      hasWork = true;
    }
    const jiraComments = selectPromptComments(allComments, lastAddressed, (comment) =>
      isNewer(comment.created || comment.t || "", lastAddressed),
    );
    taskLines.push(fmtComments(jiraComments, "jira_comments", lastAddressed));

    const prs = getTaskPrs(task, ctx.repos);
    for (const pr of prs) {
      taskLines.push(`  pr: ${pr.host ?? "github"} #${pr.number ?? "?"} (${pr.repo ?? "?"})`);
    }

    if (AUTO_ADVANCE_STEPS.includes(stepFromLabel)) {
      if (
        await anyPrMrMerged(task, stepFromLabel, {
          jira,
          repos: ctx.repos,
          isPrMerged: deps.isPrMerged,
        })
      ) {
        taskLines.push(`  *** PR/MR MERGED — ADVANCE PHASE (current: ${stepFromLabel}) ***`);
        hasWork = true;
      } else {
        taskLines.push(`  waiting for PR/MR merge (current: ${stepFromLabel})`);
      }
    }

    lines.push(taskLines.join("\n"));
  }

  // Phase 2: find new onboarding candidates.
  const candidates = await getOnboardingCandidates(jira, params);
  const candidateLines = candidates.map((issue) => fmtOnboardingCandidate(issue));
  if (candidates.length > 0) hasWork = true;

  ctx.state.set("active_onboarding_count", activeTasks.length);
  ctx.state.set("candidate_count", candidates.length);

  // Build output.
  const outputParts: string[] = [];
  if (activeTasks.length > 0) {
    outputParts.push(`ACTIVE ONBOARDING TASKS (${activeTasks.length}):`);
    outputParts.push(...lines);
  }
  outputParts.push(`\nCAPACITY: ${capacity.active}/${capacity.max} active tasks`);
  if (candidateLines.length > 0) {
    outputParts.push(`\nNEW ONBOARDING CANDIDATES (${candidates.length}):`);
    outputParts.push(...candidateLines);
  } else if (activeTasks.length === 0) {
    outputParts.push("\nNo active tasks and no new candidates.");
  }

  const content = outputParts.join("\n");
  return hasWork ? { status: "start", content } : { status: "skip", content };
}

async function getOnboardingCandidates(
  jira: JiraClient,
  params: OnboardingParams,
): Promise<readonly JiraIssue[]> {
  const jql =
    `project = ${params.project} AND labels = "${params.label}" ` +
    'AND status in ("New", "Backlog", "To Do", "Open") AND assignee is EMPTY ' +
    "ORDER BY priority DESC, created ASC";
  return await jira.searchIssues(jql, { fields: ONBOARDING_SEARCH_FIELDS, limit: 10 });
}
