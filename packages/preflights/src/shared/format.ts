import type { MemoryTask } from "./memory-server.js";
import type { ProjectReposMap } from "./repos.js";
import { upstreamRepo } from "./repos.js";
import { isNewer } from "./time.js";

/**
 * Comment, task, and PR formatting — the port of the Python `fmt_comments`,
 * `fmt_task_header`, `get_task_prs`, and `is_bot_author` helpers. Output is
 * byte-for-byte the Python formatting: the ported preflights (REHOR-260/261/
 * 262) build their Markdown content from these.
 */

/** A comment record from Jira, GitHub, or GitLab (`a`/`author`, `t`/`created`, `b`/`body`). */
export type CommentRecord = Readonly<Record<string, unknown>>;

/** PR/MR info extracted from task metadata, artifacts, or the pr_number fallback. */
export interface TaskPrInfo {
  readonly repo?: string;
  readonly number?: number;
  readonly host?: string;
  readonly [field: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const GITHUB_PR_URL = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;
const GITLAB_MR_URL = /gitlab[^/]*\/([^/]+(?:\/[^/]+)+)\/-\/merge_requests\/(\d+)/;

/** Check whether a comment author is a known bot. */
export function isBotAuthor(author: string | null | undefined): boolean {
  if (!author || author === "?") return false;
  const normalized = author.toLowerCase();
  return (
    normalized.includes("[bot]") ||
    normalized.endsWith("-bot") ||
    normalized.endsWith("-robot") ||
    normalized === "github-actions" ||
    normalized === "dependabot" ||
    normalized === "renovate"
  );
}

/**
 * Format a list of comments, newest first, optionally filtered to those
 * newer than `since` (typically the task's `last_addressed`). Truncates to
 * `maxComments` with a footer pointing at Jira for the full history.
 */
export function fmtComments(
  comments: readonly CommentRecord[] | null | undefined,
  label: string,
  since?: string,
  maxComments = 30,
): string {
  if (!comments || comments.length === 0) {
    return `  ${label}: (none)`;
  }
  let filtered = comments;
  if (since) {
    filtered = comments.filter((comment) =>
      isNewer(commentField(comment, "t", "created", ""), since),
    );
  }
  if (filtered.length === 0) {
    return `  ${label}: (none since last_addressed)`;
  }
  const newestFirst = [...filtered].reverse();
  const truncated = newestFirst.length > maxComments;
  const shown = truncated ? newestFirst.slice(0, maxComments) : newestFirst;
  const lines = [`  ${label} (${shown.length}, newest first):`];
  for (const comment of shown) {
    const author = authorOf(comment);
    const timestamp = String(commentField(comment, "t", "created", "")).slice(0, 16);
    const body = String(commentField(comment, "b", "body", ""));
    lines.push(`    [${timestamp}] ${author}:`);
    for (const bodyLine of body.trim().split("\n")) {
      lines.push(`      ${bodyLine}`);
    }
  }
  if (truncated) {
    lines.push(`    ... truncated (showing ${maxComments} of latest, use Jira for full history)`);
  }
  return lines.join("\n");
}

/** Format the common task fields as header lines. */
export function fmtTaskHeader(task: MemoryTask): string[] {
  const key = task.external_key ?? "?";
  const status = task.status ?? "?";
  const repo = task.repo ?? "?";
  const metadata = isRecord(task.metadata) ? task.metadata : {};
  const lines = [`${key} [${status}] ${repo}`];
  if (task.title) lines.push(`  title: ${task.title}`);
  if (task.summary) lines.push(`  summary: ${String(task.summary).slice(0, 150)}`);
  if (metadata.last_step) lines.push(`  last_step: ${metadata.last_step}`);
  if (task.last_addressed) lines.push(`  last_addressed: ${task.last_addressed}`);
  return lines;
}

/**
 * Extract PR info from task metadata (`prs` + `mrs`), pull_request artifact
 * URLs, or the `pr_number` fallback with the host resolved from
 * project-repos — the Python `get_task_prs` behavior.
 */
export function getTaskPrs(task: MemoryTask, repos: ProjectReposMap): TaskPrInfo[] {
  const metadata = isRecord(task.metadata) ? task.metadata : {};
  const prs: TaskPrInfo[] = [
    ...(Array.isArray(metadata.prs) ? (metadata.prs as readonly TaskPrInfo[]) : []),
    ...(Array.isArray(metadata.mrs) ? (metadata.mrs as readonly TaskPrInfo[]) : []),
  ];
  if (prs.length === 0) {
    for (const artifact of Array.isArray(task.artifacts) ? task.artifacts : []) {
      if (!isRecord(artifact) || artifact.type !== "pull_request") continue;
      const url = typeof artifact.url === "string" ? artifact.url : "";
      if (url === "") continue;
      const github = GITHUB_PR_URL.exec(url);
      if (github) {
        prs.push({ repo: github[1], number: Number(github[2]), host: "github" });
        continue;
      }
      const gitlab = GITLAB_MR_URL.exec(url);
      if (gitlab) {
        prs.push({ repo: gitlab[1], number: Number(gitlab[2]), host: "gitlab" });
      }
    }
  }
  if (prs.length === 0 && task.pr_number) {
    const { host } = upstreamRepo(task.repo ?? "", repos);
    prs.push({ repo: task.repo ?? "", number: task.pr_number, host });
  }
  return prs;
}

function commentField(
  comment: CommentRecord,
  primary: string,
  secondary: string,
  fallback: unknown,
): unknown {
  if (primary in comment) return comment[primary];
  if (secondary in comment) return comment[secondary];
  return fallback;
}

function authorOf(comment: CommentRecord): string {
  if ("a" in comment) return stringify(comment.a);
  const author = comment.author;
  if (isRecord(author)) return stringify(author.displayName ?? "?");
  return author === undefined ? "?" : stringify(author);
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}
