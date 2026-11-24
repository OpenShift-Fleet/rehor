import type { JiraComment, JiraIssue } from "../../shared/jira.js";
import type { MemoryTask } from "../../shared/memory-server.js";

/**
 * Jira response-shape readers shared by the jira preflights. The Python
 * scripts read MCP responses, which put comments, labels, and status at the
 * top level of the issue object; the REST client nests them under `fields`
 * and merges paginated comments into `fields.comment.comments`. These
 * readers accept both shapes, so the ported behavior tolerates either.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python-style truthiness, for the `or` chains the ported logic relied on. */
export function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

/** A task's `metadata`, or `{}` when absent or not a record. */
export function taskMetadata(task: MemoryTask): Record<string, unknown> {
  return isRecord(task.metadata) ? task.metadata : {};
}

/**
 * Every comment of an issue: top-level `comments` (the MCP shape) or
 * `fields.comment.comments` (the merged REST shape), oldest first.
 */
export function issueComments(issue: JiraIssue | null | undefined): readonly JiraComment[] {
  if (!issue) return [];
  if (Array.isArray(issue.comments)) return issue.comments as readonly JiraComment[];
  const fields = isRecord(issue.fields) ? issue.fields : {};
  const comment = fields.comment;
  if (isRecord(comment) && Array.isArray(comment.comments)) {
    return comment.comments as readonly JiraComment[];
  }
  return [];
}

/** Issue labels: top-level `labels` (MCP) or `fields.labels` (REST). */
export function issueLabels(issue: JiraIssue | null): string[] {
  if (issue === null) return [];
  if (Array.isArray(issue.labels)) return issue.labels.map(String);
  const fields = isRecord(issue.fields) ? issue.fields : {};
  return Array.isArray(fields.labels) ? fields.labels.map(String) : [];
}

/** Issue status name: top-level `status` (MCP) or `fields.status` (REST). */
export function issueStatusName(issue: JiraIssue | null): string {
  if (issue === null) return "";
  const raw = isRecord(issue.status) ? issue.status : issueStatusRecord(issue);
  if (raw === undefined) return "";
  if (isRecord(raw)) return String(raw.name ?? "");
  return String(raw);
}

function issueStatusRecord(issue: JiraIssue): Record<string, unknown> | undefined {
  const fields = isRecord(issue.fields) ? issue.fields : {};
  return isRecord(fields.status) ? fields.status : undefined;
}

/**
 * The `name` of a field value that may be a record, a scalar, or missing —
 * the Python `x.get("name", "?") if isinstance(x, dict) else str(x)` shape.
 */
export function nameOrString(value: unknown, fallback = "?"): string {
  if (isRecord(value)) return String(value.name ?? fallback);
  if (value === undefined || value === null) return fallback;
  return String(value);
}

/**
 * Append up to five `link:` lines for an issue's `issuelinks` — the shared
 * formatting of `_fmt_jira` and `_fmt_candidate` in the Python scripts.
 */
export function appendIssueLinks(lines: string[], links: unknown): void {
  if (!Array.isArray(links)) return;
  for (const link of links.slice(0, 5)) {
    if (!isRecord(link)) continue;
    const type = nameOrString(link.type);
    const linked = linkedIssueOf(link.inwardIssue) ?? linkedIssueOf(link.outwardIssue);
    if (linked === undefined) continue;
    const fields = isRecord(linked.fields) ? linked.fields : {};
    const status = nameOrString(fields.status);
    lines.push(`  link: ${type} ${String(linked.key ?? "?")} [${status}]`);
  }
}

function linkedIssueOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && Object.keys(value).length > 0 ? value : undefined;
}
