import { z } from "zod";
import { definePreflight } from "../../core/registry.js";
import type { PreflightExecutionResult } from "../../core/results.js";
import type { JiraClient, JiraIssue } from "../../shared/jira.js";
import type { PersistentStateStore } from "../../shared/state.js";
import type { PreflightRunContext } from "../../shared/run-context.js";
import { nonBlank } from "../../shared/strings.js";
import { executionErrorResult, JIRA_CLIENT_NOT_WIRED } from "../jira-common/errors.js";
import {
  asRecord,
  asStringArray,
  descriptionLines,
  fixVersionNames,
  issueFields,
  recordName,
  splitLabels,
} from "../obsint-common/jira-fields.js";
import { isoWeekKeyUtc, pythonWeekdayUtc, weekdayName } from "../obsint-common/time.js";

/**
 * `obsint-backlog-scan` — the port of the backlog-groomer preflight
 * `01-backlog-scan.py` (ungroomed Jira backlog ticket scan). Returns start
 * when ungroomed tickets exist, skip otherwise; ticket data is fetched here
 * to save session tokens.
 *
 * Gating:
 * - only the configured weekday runs (default Wednesday; the Python used
 *   `datetime.utcnow().weekday()`, so the gate stays UTC — the bot's local
 *   zone is irrelevant, unlike the weekly-status windows)
 * - once per ISO week (`%G-W%V` marker in persistent state)
 *
 * Behavior parity with the Python script, with the deliberate adaptations
 * the engine requires:
 *
 * - The Python `BOT_LABEL` env becomes the required `label` parameter
 *   (blank labels fail closed at validation instead of degrading to an
 *   empty search), and the search limit / grooming weekday become
 *   parameters with the Python defaults.
 * - The groomed-week marker lives in the run context's persistent state
 *   store under `obsint-backlog-scan:groomed-weeks` (a `{weekKey: true}`
 *   dict, like the Python state file) instead of `data/groomed-weeks.json`.
 * - The Python's Jira MCP wrapper returned `None` on failure, which the
 *   script treated as "no tickets" (a skip). The engine Jira client throws,
 *   and this port lets that propagate to an `error` result — fail closed, a
 *   Jira outage must not look like a groomed backlog.
 * - The Python's `BOT_INSTANCE_ID` guard is structurally satisfied: the run
 *   context factory refuses to build without a non-empty instance id.
 */

export const OBSINT_BACKLOG_SCAN_INPUT = z.strictObject({
  /** Team label the backlog is searched for (the Python `BOT_LABEL`). */
  label: z.string().refine(nonBlank, { message: "label must not be blank" }),
  /** Maximum tickets per scan (the Python `jira_search` limit). */
  limit: z.number().int().min(1).default(10),
  /** Weekday the groomer runs on, Monday=0 (the Python `GROOMING_DAY`). */
  grooming_day: z.number().int().min(0).max(6).default(2),
});

export type ObsintBacklogScanParams = z.infer<typeof OBSINT_BACKLOG_SCAN_INPUT>;

/** Persistent-state key of the `{isoWeek: true}` groomed-week markers. */
export const BACKLOG_GROOMED_WEEKS_KEY = "obsint-backlog-scan:groomed-weeks";

/** Statuses that count as not started (the Python `NOT_STARTED_STATUSES`). */
const NOT_STARTED_STATUSES: readonly string[] = ["New", "Backlog", "Refinement", "To Do"];

/** The Python `jira_search` fields list. */
const BACKLOG_FIELDS: readonly string[] = [
  "summary",
  "status",
  "labels",
  "priority",
  "description",
  "comment",
  "issuetype",
  "created",
  "updated",
  "parent",
  "customfield_12311140",
  "fixVersions",
];

/** Dependencies of the ported `main()` flow, injectable for tests. */
export interface ObsintBacklogScanDeps {
  readonly jira: JiraClient;
  readonly persistentState: PersistentStateStore;
  /** Injectable clock so tests can fix the weekday. */
  readonly now?: () => Date;
}

export async function runObsintBacklogScan(
  deps: ObsintBacklogScanDeps,
  params: ObsintBacklogScanParams,
): Promise<PreflightExecutionResult> {
  const now = deps.now?.() ?? new Date();

  // Weekday gate in UTC, like the Python's `datetime.utcnow().weekday()`.
  if (pythonWeekdayUtc(now) !== params.grooming_day) {
    return {
      status: "skip",
      content: `Backlog grooming only runs on ${weekdayName(params.grooming_day)}s`,
    };
  }

  // Once-per-ISO-week gate.
  const weekKey = isoWeekKeyUtc(now);
  const done = await readGroomedWeeks(deps.persistentState);
  if (done[weekKey] === true) {
    return { status: "skip", content: "Already groomed this week" };
  }

  const statusList = NOT_STARTED_STATUSES.map((status) => `"${status}"`).join(", ");
  const jql =
    `labels = ${params.label} ` +
    `AND status IN (${statusList}) ` +
    `AND labels != ai-groomed ` +
    `AND assignee is EMPTY ` +
    `AND sprint is EMPTY ` +
    `AND type NOT IN (Epic) ` +
    `ORDER BY created ASC`;

  const tickets = await deps.jira.searchIssues(jql, { fields: BACKLOG_FIELDS, limit: params.limit });

  if (tickets.length === 0) {
    return { status: "skip", content: "No ungroomed backlog tickets" };
  }

  // Mark the week groomed only when there was work — an empty scan retries
  // next cycle, like the Python.
  await deps.persistentState.set(BACKLOG_GROOMED_WEEKS_KEY, { ...done, [weekKey]: true });

  const lines: string[] = [`## Backlog Grooming — ${tickets.length} ticket(s) to assess`, ""];
  for (const ticket of tickets) {
    lines.push(formatTicket(ticket, params.label));
    lines.push("");
  }
  return { status: "start", content: lines.join("\n") };
}

/** The groomed-week markers, tolerantly read like the Python state file. */
async function readGroomedWeeks(store: PersistentStateStore): Promise<Record<string, boolean>> {
  const value = await store.get<unknown>(BACKLOG_GROOMED_WEEKS_KEY);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, boolean>;
}

/** The Python `_format_ticket`: one ticket block of the grooming report. */
function formatTicket(issue: JiraIssue, botLabel: string): string {
  const fields = issueFields(issue);
  const labels = asStringArray(fields.labels);
  const created = String(fields.created ?? "").slice(0, 10);
  const updated = String(fields.updated ?? "").slice(0, 10);

  const lines: string[] = [
    `${issue.key ?? "?"} [${recordName(fields.status)}] priority=${recordName(fields.priority)} type=${recordName(fields.issuetype ?? fields.issue_type)}`,
  ];
  lines.push(`  title: ${String(fields.summary ?? "")}`);
  lines.push(`  created: ${created} | updated: ${updated}`);

  const parent = asRecord(fields.parent);
  if (parent !== undefined) {
    const parentFields = asRecord(parent.fields) ?? {};
    lines.push(
      `  epic: ${String(parent.key ?? "?")} [${recordName(parentFields.status)}] — ${String(parentFields.summary ?? "")}`,
    );
  }

  const fixVersions = fixVersionNames(fields.fixVersions);
  if (fixVersions.length > 0) {
    lines.push(`  fixVersions: ${fixVersions.join(", ")}`);
  }

  const targetQuarter = fields.customfield_12311140;
  if (targetQuarter !== undefined && targetQuarter !== null && targetQuarter !== "") {
    lines.push(`  targetQuarter: ${String(targetQuarter)}`);
  }

  const { repoLabels, otherLabels } = splitLabels(labels, botLabel);
  if (repoLabels.length > 0) {
    lines.push(`  repos: ${repoLabels.join(",")}`);
  }
  if (otherLabels.length > 0) {
    lines.push(`  labels: ${otherLabels.join(",")}`);
  }

  lines.push(...descriptionLines(fields.description));

  const commentData = asRecord(fields.comment);
  const comments =
    commentData !== undefined && Array.isArray(commentData.comments)
      ? commentData.comments.slice(-3)
      : [];
  if (comments.length > 0) {
    lines.push(`  recent_comments (${comments.length}):`);
    for (const entry of comments) {
      const comment = asRecord(entry) ?? {};
      const timestamp = String(comment.created ?? "").slice(0, 16);
      let body = String(comment.body ?? "");
      if (body.length > 200) {
        body = `${body.slice(0, 200)}...`;
      }
      const author = asRecord(comment.author);
      lines.push(
        `    [${timestamp}] ${typeof author?.displayName === "string" ? author.displayName : "?"}: ${body}`,
      );
    }
  }

  return lines.join("\n");
}

export const obsintBacklogScan = definePreflight({
  id: "obsint-backlog-scan",
  input: OBSINT_BACKLOG_SCAN_INPUT,
  run: async (
    ctx: PreflightRunContext,
    params: ObsintBacklogScanParams,
  ): Promise<PreflightExecutionResult> => {
    if (ctx.jira === undefined) {
      return { status: "error", content: JIRA_CLIENT_NOT_WIRED };
    }
    if (ctx.persistentState === undefined) {
      return {
        status: "error",
        content:
          "obsint-backlog-scan requires a wired persistent state store (an unpersisted groomed-week marker would re-groom every cycle)",
      };
    }
    return runObsintBacklogScan(
      { jira: ctx.jira, persistentState: ctx.persistentState },
      params,
    ).catch(executionErrorResult);
  },
});
