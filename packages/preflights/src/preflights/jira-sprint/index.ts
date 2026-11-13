import { z } from "zod";
import { definePreflight } from "../../core/registry.js";
import type { PreflightExecutionResult } from "../../core/results.js";
import type { JiraClient } from "../../shared/jira.js";
import { buildRepoLookup } from "../../shared/repos.js";
import type { PreflightRunContext } from "../../shared/run-context.js";
import type { JiraCandidate } from "../jira-common/candidates.js";
import {
  CANDIDATE_SEARCH_FIELDS,
  createCandidateAccumulator,
  fmtCandidate,
  formatCandidates,
  quotedStatusList,
} from "../jira-common/candidates.js";
import { executionErrorResult, JIRA_CLIENT_NOT_WIRED } from "../jira-common/errors.js";
import {
  ACTIVE_TASK_STATUSES,
  cleanTaskLine,
  fmtJira,
  triageActiveTasks,
} from "../jira-common/triage.js";

/**
 * jira-sprint — the port of `jira_sprint_preflight.py`. Triage of active
 * tasks (new Jira feedback, interrupted work) plus new sprint/backlog
 * candidate search by team label, capacity-aware. Returns start only when
 * there is genuinely actionable work:
 *   - active tasks with Jira feedback or interrupted work → start
 *   - active tasks all clean + capacity + new candidates → start
 *   - no active tasks + new candidates → start
 *   - no active tasks + no candidates → skip
 *   - active tasks, all Jira-clean, no capacity or no candidates → skip
 */

/** Statuses that count as not started for candidate search. */
const NOT_STARTED_STATUSES: readonly string[] = ["New", "Backlog", "Refinement", "To Do"];

/** Rejects blank strings (empty or whitespace-only) without altering the value. */
const nonBlank = (value: string) => value.trim() !== "";

const jiraSprintInput = z.strictObject({
  /**
   * Team label for candidate search (Python `BOT_LABEL`). Blank values fail
   * closed at validation — an unfiltered label cannot silently select work.
   */
  label: z.string().refine(nonBlank, { message: "label must not be blank" }),
  /** Search the backlog when the open sprint yields fewer candidates (`BOT_INCLUDE_BACKLOG`). */
  include_backlog: z.boolean().default(false),
  /** Bot's Jira identity — the bot-assigned candidate fallback (`BOT_JIRA_EMAIL`). */
  email: z.string().optional(),
  /**
   * Interrupted-retry cooldown in minutes (`BOT_INTERRUPTED_RETRY_MINUTES`;
   * the Python `int()` read — whole minutes, any sign).
   */
  interrupted_retry_minutes: z.number().int().default(30),
});

export type JiraSprintParams = z.infer<typeof jiraSprintInput>;

export const jiraSprint = definePreflight({
  id: "jira-sprint",
  input: jiraSprintInput,
  run: (ctx: PreflightRunContext, params) =>
    runJiraSprintPreflight(ctx, params).catch(executionErrorResult),
});

export async function runJiraSprintPreflight(
  ctx: PreflightRunContext,
  params: JiraSprintParams,
): Promise<PreflightExecutionResult> {
  const jira = ctx.jira;
  if (jira === undefined) {
    return { status: "error", content: JIRA_CLIENT_NOT_WIRED };
  }

  const tasks = await ctx.memory.getTasks();
  const capacity = await ctx.memory.getCapacity();
  const active = tasks.filter((task) => ACTIVE_TASK_STATUSES.includes(task.status ?? ""));
  const paused = tasks.filter((task) => task.status === "paused");
  const done = tasks.filter((task) => task.status === "done");

  const lines: string[] = [
    `## Jira Sprint Preflight (capacity ${capacity.active}/${capacity.max})`,
    "",
  ];

  // Phase 1: triage active tasks for Jira feedback / interruptions.
  if (active.length > 0) {
    const triaged = await triageActiveTasks(active, {
      jira,
      repos: ctx.repos,
      retryMinutes: params.interrupted_retry_minutes,
      investigationStepExempt: true,
    });
    const feedback = triaged.filter((entry) => entry.kind === "feedback");
    const interrupted = triaged.filter((entry) => entry.kind === "interrupted");
    const clean = triaged.filter((entry) => entry.kind === "clean");

    if (feedback.length > 0) {
      lines.push(`### JIRA FEEDBACK (${feedback.length})`);
      for (const entry of feedback) {
        lines.push(fmtJira(entry.task, entry.jira, entry.jiraComments));
        lines.push("");
      }
    }
    if (interrupted.length > 0) {
      lines.push(`### INTERRUPTED (${interrupted.length})`);
      for (const entry of interrupted) {
        lines.push(fmtJira(entry.task, entry.jira, entry.jiraComments));
        lines.push("");
      }
    }
    if (clean.length > 0) {
      lines.push(`### CLEAN (${clean.length})`);
      for (const entry of clean) {
        lines.push(cleanTaskLine(entry.task));
      }
      lines.push("");
    }

    if (feedback.length + interrupted.length > 0) {
      ctx.state.set("jira", { feedback: feedback.length, interrupted: interrupted.length });
      return { status: "start", content: lines.join("\n") };
    }
    // Active tasks but all Jira-clean — still search for new work below.
  }

  // Phase 2: search for new work candidates (capacity permitting).
  if (active.length === 0) {
    lines.push("No active tasks");
  }
  if (done.length > 0) {
    lines.push(`done pending archival: ${done.map((task) => task.external_key ?? "?").join(",")}`);
  }
  if (paused.length > 0) {
    const parts = paused.map(
      (task) => `${task.external_key ?? "?"}:${String(task.paused_reason ?? "")}`,
    );
    lines.push(`paused: ${parts.join(" | ")}`);
  }
  lines.push("");

  const repoLookup = buildRepoLookup(ctx.repos);

  if (capacity.active >= capacity.max) {
    const candidates = await getInvestigationCandidates(jira, params.label, repoLookup);
    if (candidates.length === 0) {
      lines.push(`At capacity (${capacity.active}/${capacity.max}), no investigation tickets`);
      ctx.state.set("jira", { feedback: 0, interrupted: 0 });
      return { status: "skip", content: lines.join("\n") };
    }
    lines.push(`### Investigation Candidates (at capacity ${capacity.active}/${capacity.max})`);
    lines.push("");
    for (const candidate of candidates) {
      lines.push(fmtCandidate(candidate, sprintFormat(params.label)));
      lines.push("");
    }
    ctx.state.set("jira", { feedback: 0, interrupted: 0 });
    return { status: "start", content: lines.join("\n") };
  }

  const candidates = await getSprintCandidates(jira, params, repoLookup);
  const withRepos = candidates.filter((candidate) => candidate.repos.length > 0);
  const withoutRepos = candidates.filter((candidate) => candidate.repos.length === 0);

  if (withRepos.length === 0) {
    if (withoutRepos.length > 0) {
      lines.push(`No eligible work — ${withoutRepos.length} candidate(s) lack repo: labels`);
      for (const candidate of withoutRepos) {
        lines.push(`  ${candidate.key}: ${candidate.summary} (no repo: label)`);
      }
    } else {
      lines.push("No eligible work candidates in sprint/backlog");
    }
    ctx.state.set("jira", { feedback: 0, interrupted: 0 });
    return { status: "skip", content: lines.join("\n") };
  }

  lines.push(`### New Work Candidates (${withRepos.length})`);
  lines.push("");
  for (const candidate of withRepos) {
    lines.push(fmtCandidate(candidate, sprintFormat(params.label)));
    lines.push("");
  }
  lines.push(`-> ${withRepos.length} with matching repos, ${withoutRepos.length} without`);
  lines.push(`-> Top pick: ${withRepos[0].key} repos=${withRepos[0].repos.join(",")}`);

  ctx.state.set("jira", { feedback: 0, interrupted: 0 });
  return { status: "start", content: lines.join("\n") };
}

function sprintFormat(botLabel: string) {
  return { botLabel, noRepoNote: "(no repo: label)" };
}

/** Sprint candidates: open sprint (unassigned, then bot-assigned), then backlog. */
async function getSprintCandidates(
  jira: JiraClient,
  params: JiraSprintParams,
  repoLookup: Record<string, string>,
): Promise<JiraCandidate[]> {
  const statusList = quotedStatusList(NOT_STARTED_STATUSES);
  const accumulator = createCandidateAccumulator(jira, repoLookup);
  await accumulator.collect(
    `labels = ${params.label} AND sprint in openSprints() AND assignee is EMPTY ` +
      `AND status IN (${statusList}) ORDER BY priority DESC, created ASC`,
  );
  if (accumulator.count < 10 && params.email !== undefined && params.email !== "") {
    await accumulator.collect(
      `labels = ${params.label} AND sprint in openSprints() AND assignee = "${params.email}" ` +
        `AND status IN (${statusList}) ORDER BY priority DESC, created ASC`,
    );
  }
  if (accumulator.count < 10 && params.include_backlog) {
    const assigneeFilter =
      params.email !== undefined && params.email !== ""
        ? `AND (assignee is EMPTY OR assignee = "${params.email}") `
        : "AND assignee is EMPTY ";
    await accumulator.collect(
      `labels = ${params.label} ${assigneeFilter}` +
        `AND status IN (${statusList}) AND (sprint is EMPTY OR sprint not in openSprints()) ` +
        `ORDER BY priority DESC, created ASC`,
    );
  }
  return accumulator.formatted();
}

/** needs-investigation tickets for at-capacity runs. */
async function getInvestigationCandidates(
  jira: JiraClient,
  label: string,
  repoLookup: Record<string, string>,
): Promise<JiraCandidate[]> {
  const statusList = quotedStatusList(NOT_STARTED_STATUSES);
  const issues = await jira.searchIssues(
    `labels = ${label} AND labels = needs-investigation AND assignee is EMPTY ` +
      `AND status IN (${statusList}) ORDER BY priority DESC, created ASC`,
    { fields: CANDIDATE_SEARCH_FIELDS, limit: 5 },
  );
  return formatCandidates(issues, repoLookup);
}
