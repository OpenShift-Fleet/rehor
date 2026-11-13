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
 * jira-kanban — the port of `jira_kanban_preflight.py`. Same triage of
 * active tasks as jira-sprint, with a project/status-based kanban candidate
 * search instead of sprint queries. Returns start only when there is
 * genuinely actionable work (same decision table as jira-sprint).
 */

/** Rejects blank strings (empty or whitespace-only) without altering the value. */
const nonBlank = (value: string) => value.trim() !== "";

const jiraKanbanInput = z.strictObject({
  /**
   * Jira project for candidate search (Python `BOT_JIRA_PROJECT`). Blank
   * values fail closed at validation.
   */
  project: z.string().refine(nonBlank, { message: "project must not be blank" }),
  /**
   * Team label for candidate search (Python `BOT_LABEL`). Blank values fail
   * closed at validation — an unfiltered label cannot silently select work.
   */
  label: z.string().refine(nonBlank, { message: "label must not be blank" }),
  /**
   * Kanban statuses that count as not started (`BOT_KANBAN_STATUSES`).
   * An empty list or blank elements fail closed at validation: the Python
   * env var silently dropped blanks, but a configured empty list can only
   * mean a misconfigured agent.
   */
  statuses: z
    .array(z.string().refine(nonBlank, { message: "statuses must not contain blank entries" }))
    .min(1, { message: "statuses must contain at least one status" })
    .default(["New", "Backlog", "To Do"]),
  /** Extra JQL appended to every candidate query (`BOT_KANBAN_JQL_EXTRA`). */
  jql_extra: z.string().optional(),
  /** Bot's Jira identity — the bot-assigned candidate fallback (`BOT_JIRA_EMAIL`). */
  email: z.string().optional(),
  /**
   * Interrupted-retry cooldown in minutes (`BOT_INTERRUPTED_RETRY_MINUTES`;
   * the Python `int()` read — whole minutes, any sign).
   */
  interrupted_retry_minutes: z.number().int().default(30),
});

export type JiraKanbanParams = z.infer<typeof jiraKanbanInput>;

export const jiraKanban = definePreflight({
  id: "jira-kanban",
  input: jiraKanbanInput,
  run: (ctx: PreflightRunContext, params) =>
    runJiraKanbanPreflight(ctx, params).catch(executionErrorResult),
});

export async function runJiraKanbanPreflight(
  ctx: PreflightRunContext,
  params: JiraKanbanParams,
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
    `## Jira Kanban Preflight (capacity ${capacity.active}/${capacity.max})`,
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
    const candidates = await getKanbanInvestigationCandidates(jira, params, repoLookup);
    if (candidates.length === 0) {
      lines.push(`At capacity (${capacity.active}/${capacity.max}), no investigation tickets`);
      ctx.state.set("jira", { feedback: 0, interrupted: 0 });
      return { status: "skip", content: lines.join("\n") };
    }
    lines.push(`### Investigation Candidates (at capacity ${capacity.active}/${capacity.max})`);
    lines.push("");
    for (const candidate of candidates) {
      lines.push(fmtCandidate(candidate, kanbanFormat(params.label)));
      lines.push("");
    }
    ctx.state.set("jira", { feedback: 0, interrupted: 0 });
    return { status: "start", content: lines.join("\n") };
  }

  const candidates = await getKanbanCandidates(jira, params, repoLookup);
  if (candidates.length === 0) {
    lines.push("No eligible work candidates in kanban backlog");
    ctx.state.set("jira", { feedback: 0, interrupted: 0 });
    return { status: "skip", content: lines.join("\n") };
  }

  lines.push(`### New Work Candidates (${candidates.length})`);
  lines.push("");
  for (const candidate of candidates) {
    lines.push(fmtCandidate(candidate, kanbanFormat(params.label)));
    lines.push("");
  }
  lines.push(`-> ${candidates.length} candidate(s) found`);
  lines.push(`-> Top pick: ${candidates[0].key}`);
  if (candidates[0].repos.length > 0) {
    lines.push(`   repos=${candidates[0].repos.join(",")}`);
  }

  ctx.state.set("jira", { feedback: 0, interrupted: 0 });
  return { status: "start", content: lines.join("\n") };
}

function kanbanFormat(botLabel: string) {
  return { botLabel, noRepoNote: "(no repo: label — agent determines repo from ticket content)" };
}

/**
 * The ` AND <expression>` clause appended to every candidate query. The
 * documented form (docs/preflight-rework-spike-input.md) supplies the
 * leading AND — `jql_extra: 'AND priority not in ("Undefined")'` — while a
 * bare expression also works; an optional leading `AND` (case-insensitive,
 * followed by whitespace) is normalized away so both forms produce exactly
 * one AND. Nothing else in the expression is rewritten.
 */
function jqlExtraClause(jqlExtra: string | undefined): string {
  if (jqlExtra === undefined || jqlExtra.trim() === "") return "";
  return ` AND ${jqlExtra.trim().replace(/^and\s+/i, "")}`;
}

/** Kanban candidates: unassigned, then bot-assigned, within the project. */
async function getKanbanCandidates(
  jira: JiraClient,
  params: JiraKanbanParams,
  repoLookup: Record<string, string>,
): Promise<JiraCandidate[]> {
  const statusList = quotedStatusList(params.statuses);
  const extra = jqlExtraClause(params.jql_extra);
  const labelFilter = `AND labels = ${params.label} `;
  const accumulator = createCandidateAccumulator(jira, repoLookup);
  await accumulator.collect(
    `project = ${params.project} AND status IN (${statusList}) ` +
      `${labelFilter}AND assignee is EMPTY${extra} ` +
      `ORDER BY priority DESC, created ASC`,
  );
  if (accumulator.count < 10 && params.email !== undefined && params.email !== "") {
    await accumulator.collect(
      `project = ${params.project} AND status IN (${statusList}) ` +
        `${labelFilter}AND assignee = "${params.email}"${extra} ` +
        `ORDER BY priority DESC, created ASC`,
    );
  }
  return accumulator.formatted();
}

/** needs-investigation tickets for at-capacity runs. */
async function getKanbanInvestigationCandidates(
  jira: JiraClient,
  params: JiraKanbanParams,
  repoLookup: Record<string, string>,
): Promise<JiraCandidate[]> {
  const statusList = quotedStatusList(params.statuses);
  const extra = jqlExtraClause(params.jql_extra);
  const issues = await jira.searchIssues(
    `project = ${params.project} AND labels = ${params.label} AND labels = needs-investigation ` +
      `AND assignee is EMPTY AND status IN (${statusList})${extra} ` +
      `ORDER BY priority DESC, created ASC`,
    { fields: CANDIDATE_SEARCH_FIELDS, limit: 5 },
  );
  return formatCandidates(issues, repoLookup);
}
