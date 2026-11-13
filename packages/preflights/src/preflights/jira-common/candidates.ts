import type { JiraClient, JiraComment, JiraIssue } from "../../shared/jira.js";
import { matchRepoLabels } from "../../shared/repos.js";
import { appendIssueLinks, isRecord, nameOrString, pyTruthy } from "./shapes.js";

/**
 * Candidate search and formatting shared by jira-sprint and jira-kanban —
 * the port of the Python `_jira_search`, `_format_candidates`, `_fmt_candidate`,
 * and the deduplicating `collect` closure.
 */

/** Fields the candidate searches request (the Python `_jira_search` list). */
export const CANDIDATE_SEARCH_FIELDS: readonly string[] = [
  "summary",
  "status",
  "labels",
  "assignee",
  "priority",
  "description",
  "comment",
  "issuelinks",
  "issuetype",
];

/** Quote a status list for a JQL `IN (...)` clause, e.g. `"New", "To Do"`. */
export function quotedStatusList(statuses: readonly string[]): string {
  return statuses.map((status) => `"${status}"`).join(", ");
}

/** A search result normalized for candidate formatting. */
export interface JiraCandidate {
  readonly key: string;
  readonly summary: string;
  readonly status: string;
  readonly priority: string;
  readonly type: string;
  readonly labels: readonly string[];
  readonly repos: readonly string[];
  readonly description: string;
  readonly comments: readonly JiraComment[];
  readonly links: readonly unknown[];
}

/**
 * Normalize search results: repo labels resolve through the project-repos
 * lookup (any unmatched label fails the whole match), comments keep the
 * newest five, and status/priority/type fall back through both response
 * shapes — the Python `_format_candidates`.
 */
export function formatCandidates(
  issues: readonly JiraIssue[],
  repoLookup: Record<string, string>,
): JiraCandidate[] {
  return issues.map((issue) => {
    const rawFields = issue.fields;
    const fields: Record<string, unknown> =
      isRecord(rawFields) && Object.keys(rawFields).length > 0 ? rawFields : issue;
    const labels = Array.isArray(fields.labels) ? fields.labels.map(String) : [];
    const commentData = fields.comment;
    const comments =
      isRecord(commentData) && Array.isArray(commentData.comments)
        ? (commentData.comments as readonly JiraComment[]).slice(-5)
        : [];
    const issueType = pyTruthy(fields.issuetype)
      ? fields.issuetype
      : pyTruthy(fields.issue_type)
        ? fields.issue_type
        : {};
    return {
      key: String(issue.key ?? ""),
      summary: pyTruthy(fields.summary) ? String(fields.summary) : String(issue.summary ?? ""),
      status: nameOrString(fields.status),
      priority: nameOrString(fields.priority),
      type: nameOrString(issueType),
      labels,
      repos: matchRepoLabels(labels, repoLookup),
      description: pyTruthy(fields.description) ? String(fields.description) : "",
      comments,
      links: Array.isArray(fields.issuelinks) ? fields.issuelinks : [],
    };
  });
}

export interface CandidateFormatOptions {
  /** The bot's own label — excluded from the `labels:` line. */
  readonly botLabel: string;
  /** Line content after `repos:` when a candidate has no matching repos. */
  readonly noRepoNote: string;
}

/** Format one candidate — the Python `_fmt_candidate`. */
export function fmtCandidate(candidate: JiraCandidate, options: CandidateFormatOptions): string {
  const lines = [
    `${candidate.key} [${candidate.status}] priority=${candidate.priority} type=${candidate.type}`,
    `  title: ${candidate.summary}`,
  ];
  if (candidate.repos.length > 0) {
    lines.push(`  repos: ${candidate.repos.join(",")}`);
  } else {
    const repoLabels = candidate.labels.filter((label) => label.startsWith("repo:"));
    if (repoLabels.length > 0) {
      lines.push(`  repo_labels: ${repoLabels.join(",")} (NO MATCH in project-repos.json)`);
    } else {
      lines.push(`  repos: ${options.noRepoNote}`);
    }
  }
  const otherLabels = candidate.labels.filter(
    (label) => !label.startsWith("repo:") && label !== options.botLabel,
  );
  if (otherLabels.length > 0) {
    lines.push(`  labels: ${otherLabels.join(",")}`);
  }
  appendIssueLinks(lines, candidate.links);
  if (candidate.description !== "") {
    lines.push("  description:");
    for (const line of candidate.description.trim().split("\n")) {
      lines.push(`    ${line}`);
    }
  }
  if (candidate.comments.length > 0) {
    lines.push(`  comments (${candidate.comments.length}):`);
    for (const comment of candidate.comments) {
      const author = isRecord(comment.author) ? String(comment.author.displayName ?? "?") : "?";
      const created = String(comment.created ?? "").slice(0, 16);
      const body = String(comment.body ?? "");
      lines.push(`    [${created}] ${author}:`);
      for (const line of body.trim().split("\n")) {
        lines.push(`      ${line}`);
      }
    }
  }
  return lines.join("\n");
}

export interface CandidateAccumulator {
  /** Candidates collected so far. */
  readonly count: number;
  /** Run one JQL query, adding unseen issues until the 10-candidate cap. */
  collect(jql: string): Promise<void>;
  /** Format the accumulated issues. */
  formatted(): JiraCandidate[];
}

/**
 * Deduplicating candidate accumulator — the Python `collect` closure: each
 * query adds unseen issues (capped at ten, per query limit ten) and the
 * batch is formatted once at the end. The Python stderr progress lines are
 * not ported; the run context carries no stderr channel.
 */
export function createCandidateAccumulator(
  jira: JiraClient,
  repoLookup: Record<string, string>,
): CandidateAccumulator {
  const issues: JiraIssue[] = [];
  const seenKeys = new Set<string>();
  return {
    get count() {
      return issues.length;
    },
    collect: async (jql: string) => {
      const batch = await jira.searchIssues(jql, {
        fields: CANDIDATE_SEARCH_FIELDS,
        limit: 10,
      });
      for (const issue of batch) {
        const key = String(issue.key ?? "");
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        issues.push(issue);
        if (issues.length >= 10) break;
      }
    },
    formatted: () => formatCandidates(issues, repoLookup),
  };
}
