import { z } from "zod";
import { definePreflight } from "../../core/registry.js";
import type { PreflightExecutionResult } from "../../core/results.js";
import type { PreflightRunContext } from "../../shared/run-context.js";
import { executionErrorResult, JIRA_CLIENT_NOT_WIRED } from "../jira-common/errors.js";
import {
  ACTIVE_TASK_STATUSES,
  cleanTaskLine,
  fmtJira,
  triageActiveTasks,
} from "../jira-common/triage.js";

/**
 * jira-triage — the port of `jira_triage.py`. Feedback/interrupted triage of
 * active tasks only, no find-work phase: with no active tasks it starts with
 * the priority-2 pointer (new Jira work), otherwise it starts when any
 * active task has feedback or was interrupted and skips when all are clean.
 */

const jiraTriageInput = z.strictObject({
  /**
   * Interrupted-retry cooldown in minutes (`BOT_INTERRUPTED_RETRY_MINUTES`;
   * the Python `int()` read — whole minutes, any sign).
   */
  interrupted_retry_minutes: z.number().int().default(30),
});

export type JiraTriageParams = z.infer<typeof jiraTriageInput>;

export const jiraTriage = definePreflight({
  id: "jira-triage",
  input: jiraTriageInput,
  run: (ctx: PreflightRunContext, params) =>
    runJiraTriagePreflight(ctx, params).catch(executionErrorResult),
});

export async function runJiraTriagePreflight(
  ctx: PreflightRunContext,
  params: JiraTriageParams,
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

  const lines: string[] = [`## Jira Triage (capacity ${capacity.active}/${capacity.max})`, ""];

  if (active.length === 0) {
    lines.push("No active tasks → Priority 2 (new Jira work)");
    if (done.length > 0) {
      lines.push(
        `done pending archival: ${done.map((task) => task.external_key ?? "?").join(",")}`,
      );
    }
    if (paused.length > 0) {
      lines.push(`paused: ${paused.map((task) => task.external_key ?? "?").join(",")}`);
    }
    ctx.state.set("jira", { feedback: 0, interrupted: 0 });
    return { status: "start", content: lines.join("\n") };
  }

  const triaged = await triageActiveTasks(active, {
    jira,
    repos: ctx.repos,
    retryMinutes: params.interrupted_retry_minutes,
    investigationStepExempt: false,
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

  if (paused.length > 0) {
    const parts = paused.map(
      (task) => `${task.external_key ?? "?"}:${String(task.paused_reason ?? "")}`,
    );
    lines.push(`PAUSED: ${parts.join(" | ")}`);
  }
  if (done.length > 0) {
    lines.push(`DONE (archive?): ${done.map((task) => task.external_key ?? "?").join(",")}`);
  }

  const actionable = feedback.length + interrupted.length;
  // has_actionable accumulates across the preflights of one run — the
  // Python inter-script state-file semantics.
  const previousActionable = ctx.state.get("has_actionable");
  ctx.state.set("jira", { feedback: feedback.length, interrupted: interrupted.length });
  ctx.state.set("has_actionable", previousActionable === true || actionable > 0);

  const content = lines.join("\n");
  return actionable > 0 ? { status: "start", content } : { status: "skip", content };
}
