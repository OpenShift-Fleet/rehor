import { fmtComments, fmtTaskHeader, getTaskPrs } from "../../shared/format.js";
import type { JiraClient, JiraComment, JiraIssue } from "../../shared/jira.js";
import type { MemoryTask } from "../../shared/memory-server.js";
import type { ProjectReposMap } from "../../shared/repos.js";
import { interruptedRetryDue, isNewer } from "../../shared/time.js";
import {
  appendIssueLinks,
  isRecord,
  issueComments,
  nameOrString,
  pyTruthy,
  taskMetadata,
} from "./shapes.js";

/**
 * Active-task triage shared by jira-sprint, jira-kanban, and jira-triage —
 * the port of the Phase 1 loop the three Python scripts duplicated. Each
 * active task's Jira issue is fetched (with every comment, paginated by the
 * client) and classified as feedback, interrupted, or clean. Classification
 * reads the full comment history; the comments carried for the rendered
 * prompt are a bounded selection (see selectPromptComments).
 */

/** Task statuses the preflights treat as active (the Python active filter). */
export const ACTIVE_TASK_STATUSES: readonly string[] = ["in_progress", "pr_open", "pr_changes"];

/**
 * Fields requested for an active task's Jira issue. Comments come from the
 * paginated comment endpoint (the client merges them into
 * `fields.comment.comments`), so the MCP `comment_limit` cap and the
 * truncation-detection heuristic are not ported.
 */
const TRIAGE_ISSUE_FIELDS: readonly string[] = [
  "summary",
  "status",
  "assignee",
  "labels",
  "issuelinks",
  "comment",
  "updated",
];

/**
 * True when a comment newer than `lastAddressed` carries human feedback —
 * the structured bot markers (`### `, `| `, `PR:`) do not count. The whole
 * comment history is classified: the REST client paginates (unlike the MCP
 * client the Python scripts used, which returned an oldest-first capped
 * window), so a human comment is never hidden by newer bot comments.
 */
export function hasNewJiraFeedback(
  comments: readonly JiraComment[],
  lastAddressed: string,
): boolean {
  if (lastAddressed === "") return false;
  return comments.some((comment) => isFeedbackTrigger(comment, lastAddressed));
}

/** The structured bot-comment markers: `### `, `| `, `PR:`. */
function hasStructuredBotMarkers(body: string): boolean {
  return body.includes("### ") || body.includes("| ") || body.includes("PR:");
}

/** A comment newer than `lastAddressed` without structured bot markers. */
function isFeedbackTrigger(comment: JiraComment, lastAddressed: string): boolean {
  return (
    isNewer(comment.created ?? "", lastAddressed) && !hasStructuredBotMarkers(comment.body ?? "")
  );
}

/** Newest comments rendered per task — the Python `all_comments[-10:]` slice. */
const RENDERED_TAIL_LIMIT = 10;

/**
 * Oldest feedback-triggering comments kept in the rendered selection. The
 * tail plus this window stays within fmtComments' 30-comment rendering cap,
 * so the comment that triggered a feedback start is never the part of the
 * selection that cap drops.
 */
const RENDERED_TRIGGER_LIMIT = 20;

/**
 * The comments to render for a triaged task: the newest slice (the Python
 * `[-10:]` prompt tail) plus the oldest comments selected by `isTrigger`,
 * preserving history order. Classification always sees the full history;
 * this selection keeps the rendered prompt bounded while ensuring the
 * triggering feedback stays visible — newer structured bot comments must
 * not push it out of the tail, and fmtComments' 30-newest rendering cap
 * must not drop it either.
 */
export function selectPromptComments(
  comments: readonly JiraComment[],
  lastAddressed: string,
  isTrigger: (comment: JiraComment) => boolean,
): readonly JiraComment[] {
  const tailStart = Math.max(0, comments.length - RENDERED_TAIL_LIMIT);
  if (lastAddressed === "") {
    // Without last_addressed nothing can be "new"; the newest slice is the
    // whole rendered story, exactly like the Python rendering.
    return comments.slice(tailStart);
  }
  const triggers = new Set<JiraComment>();
  for (const comment of comments) {
    if (isTrigger(comment)) {
      triggers.add(comment);
      if (triggers.size >= RENDERED_TRIGGER_LIMIT) break;
    }
  }
  if (triggers.size === 0) {
    return comments.slice(tailStart);
  }
  return comments.filter((comment, index) => index >= tailStart || triggers.has(comment));
}

/** Format a task with its Jira details — the Python `_fmt_jira`. */
export function fmtJira(
  task: MemoryTask,
  jiraData: JiraIssue | null,
  jiraComments: readonly JiraComment[],
): string {
  const lines = fmtTaskHeader(task);
  if (jiraData !== null) {
    const fields = isRecord(jiraData.fields) ? jiraData.fields : {};
    lines.push(`  jira_status: ${nameOrString(fields.status)}`);
    const labels = Array.isArray(fields.labels) ? fields.labels.map(String) : [];
    if (labels.length > 0) {
      lines.push(`  labels: ${labels.join(",")}`);
    }
    appendIssueLinks(lines, fields.issuelinks);
    lines.push(fmtComments(jiraComments, "jira_comments", task.last_addressed));
  } else {
    lines.push("  [jira unavailable — use jira_get_issue]");
  }
  return lines.join("\n");
}

/** The one-line CLEAN section entry for a task. */
export function cleanTaskLine(task: MemoryTask): string {
  return `  ${task.external_key ?? "?"} [${task.status ?? "?"}] ${task.repo ?? "?"}`;
}

export type TaskTriageKind = "feedback" | "interrupted" | "clean";

export interface TriagedTask {
  readonly kind: TaskTriageKind;
  readonly task: MemoryTask;
  readonly jira: JiraIssue | null;
  /**
   * The comments to render for this task: the bounded prompt selection
   * (newest slice plus feedback triggers) — not the full history the
   * classification read.
   */
  readonly jiraComments: readonly JiraComment[];
}

export interface TriageOptions {
  readonly jira: JiraClient;
  readonly repos: ProjectReposMap;
  /** Interrupted-retry cooldown in minutes (`interrupted_retry_minutes`). */
  readonly retryMinutes: number;
  /**
   * jira-sprint and jira-kanban exempt tasks whose last step was
   * `investigation_posted` from the interrupted bucket; jira-triage (the
   * older triage-only script) does not. Both behaviors are preserved.
   */
  readonly investigationStepExempt: boolean;
}

/**
 * Classify every active task: feedback (new human Jira comment), interrupted
 * (mid-work without a PR, past the blocked-retry cooldown), or clean. Tasks
 * are processed in order, one Jira fetch each, like the Python loop.
 */
export async function triageActiveTasks(
  active: readonly MemoryTask[],
  options: TriageOptions,
): Promise<readonly TriagedTask[]> {
  const triaged: TriagedTask[] = [];
  for (const task of active) {
    const key = task.external_key ?? "";
    const metadata = taskMetadata(task);
    const prs = getTaskPrs(task, options.repos);
    const jira =
      key !== ""
        ? await options.jira.getIssueWithComments(key, { fields: TRIAGE_ISSUE_FIELDS })
        : null;
    // Classification reads the full paginated history; the comments carried
    // for the prompt are the bounded selection that keeps any triggering
    // feedback visible even when newer bot comments bury it.
    const allComments = issueComments(jira);
    const lastAddressed = task.last_addressed ?? "";
    const kind: TaskTriageKind = hasNewJiraFeedback(allComments, lastAddressed)
      ? "feedback"
      : isInterruptedTask(task, metadata, prs, options)
        ? "interrupted"
        : "clean";
    triaged.push({
      kind,
      task,
      jira,
      jiraComments: selectPromptComments(allComments, lastAddressed, (comment) =>
        isFeedbackTrigger(comment, lastAddressed),
      ),
    });
  }
  return triaged;
}

/**
 * The Python `is_interrupted` conditions: in-progress without a PR/MR, not
 * parked on an investigation step (when exempt), and either unblocked or
 * past the retry cooldown for blocked tasks waiting on external input.
 * Crashed cycles (stale last_addressed) stay immediately actionable.
 */
function isInterruptedTask(
  task: MemoryTask,
  metadata: Record<string, unknown>,
  prs: readonly unknown[],
  options: TriageOptions,
): boolean {
  if (task.status !== "in_progress") return false;
  if (task.pr_number) return false;
  if (pyTruthy(metadata.prs)) return false;
  if (prs.length > 0) return false;
  if (options.investigationStepExempt && metadata.last_step === "investigation_posted") {
    return false;
  }
  if (
    pyTruthy(metadata.blockers) &&
    !interruptedRetryDue(task, { retryMinutes: options.retryMinutes })
  ) {
    return false;
  }
  return true;
}
