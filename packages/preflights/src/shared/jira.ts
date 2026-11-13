import type { FetchLike, HttpClient, QueryValue } from "./http.js";
import { createHttpClient } from "./http.js";

/**
 * Jira REST client — replaces the Python `jira_mcp.py` MCP wrapper (REHOR-239
 * decision: direct REST from TypeScript). Runs on the shared HTTP module
 * with the proxy base URL plus the `/jira` path prefix; no Authorization
 * header is sent — the auth proxy injects credentials on the upstream leg.
 *
 * JQL search uses the enhanced search endpoint
 * `POST /rest/api/{version}/search/jql`: the offset-based `/search` endpoint
 * is retired from Jira Cloud (Atlassian CHANGE-2046 — it answers 410), so the
 * client never calls it and surfaces that 410 like any other execution error.
 * The enhanced endpoint pages sequentially with an opaque `nextPageToken`
 * plus an `isLast` flag; the token is absent, null, or empty on the final
 * page (JRACLOUD-92184), and pages may be short or even empty while a
 * continuation token is present, so the loop follows the token rather than
 * counting issues.
 *
 * Issue comments come from the dedicated `/issue/{key}/comment` endpoint,
 * which still pages with `startAt`/`maxResults` (offset pagination remains
 * valid there). Native pagination replaces the MCP client's oldest-first
 * comment-limit workaround, which makes the Python preflights'
 * truncation-detection heuristic unnecessary: `getIssueComments` and
 * `getIssueWithComments` return every comment, newest slicing left to callers.
 *
 * Covers the operations the Python preflights use (JQL search, issue fetch,
 * comments); the API version defaults to v2. The enhanced search encodes
 * rich-text fields (description, comment bodies) as Atlassian Document
 * Format documents — always in v3, and in v2 the current API reference
 * example shows ADF as well (v2 deployments have been observed returning
 * plain strings) — so search results flatten any ADF value to plain text
 * and the preflights keep treating `body`/`description` as strings.
 */

/** Route prefix this package requires on the auth proxy for Jira REST. */
export const JIRA_PATH_PREFIX = "/jira";

export interface JiraClientConfig {
  /** Proxy base URL, e.g. `https://proxy.example/devbot-proxy`. */
  readonly baseUrl: string;
  /** Path prefix; defaults to {@link JIRA_PATH_PREFIX}. */
  readonly pathPrefix?: string;
  /** REST API version; defaults to `"2"`. */
  readonly apiVersion?: "2" | "3";
  /** Request timeout in milliseconds; defaults to 30 s (the MCP wrapper's timeout). */
  readonly timeoutMs?: number;
  /** Injectable fetch for fixture-based tests. */
  readonly fetch?: FetchLike;
}

/** A Jira issue as returned by the REST API (loose: fields vary by request). */
export interface JiraIssue {
  readonly key?: string;
  readonly id?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly [field: string]: unknown;
}

/** A Jira comment as returned by the REST API. */
export interface JiraComment {
  readonly author?: unknown;
  readonly created?: string;
  readonly body?: string;
  readonly [field: string]: unknown;
}

export interface JiraSearchOptions {
  /**
   * Issue fields to request; omitted means Jira's default field set
   * (`*navigable` — the enhanced search endpoint returns only issue ids
   * unless fields are requested explicitly).
   */
  readonly fields?: readonly string[];
  /** Stop after this many issues; omit to page through every result. */
  readonly limit?: number;
}

export interface JiraIssueOptions {
  readonly fields?: readonly string[];
}

export interface JiraClient {
  /**
   * JQL search via the enhanced `/search/jql` endpoint, paged sequentially
   * with `nextPageToken` until `isLast` (or `limit`).
   */
  searchIssues(jql: string, options?: JiraSearchOptions): Promise<readonly JiraIssue[]>;
  /** Fetch one issue by key with the requested fields. */
  getIssue(issueKey: string, options?: JiraIssueOptions): Promise<JiraIssue>;
  /** Fetch every comment for an issue, oldest first (the REST order). */
  getIssueComments(
    issueKey: string,
    options?: { readonly limit?: number },
  ): Promise<readonly JiraComment[]>;
  /**
   * Fetch an issue together with all of its comments, merged into
   * `fields.comment.comments` — the drop-in replacement for the MCP
   * `jira_get_issue` + `comment_limit` calls, without the oldest-first cap.
   */
  getIssueWithComments(issueKey: string, options?: JiraIssueOptions): Promise<JiraIssue>;
}

/** A page from the enhanced JQL search endpoint (`/search/jql`). */
interface SearchPage {
  readonly issues?: readonly JiraIssue[];
  /** Final-page flag; the continuation token is absent there. */
  readonly isLast?: boolean;
  /** Opaque continuation token; absent, null, or empty on the final page. */
  readonly nextPageToken?: string | null;
}

interface CommentPage {
  readonly comments?: readonly JiraComment[];
  readonly total?: number;
}

const DEFAULT_JIRA_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 50;

export function createJiraClient(config: JiraClientConfig): JiraClient {
  const apiRoot = `/rest/api/${config.apiVersion ?? "2"}`;
  const http: HttpClient = createHttpClient({
    baseUrl: config.baseUrl,
    pathPrefix: config.pathPrefix ?? JIRA_PATH_PREFIX,
    timeoutMs: config.timeoutMs ?? DEFAULT_JIRA_TIMEOUT_MS,
    fetch: config.fetch,
  });

  async function searchIssues(
    jql: string,
    options: JiraSearchOptions = {},
  ): Promise<readonly JiraIssue[]> {
    const issues: JiraIssue[] = [];
    const seenTokens = new Set<string>();
    let nextPageToken: string | undefined;
    for (;;) {
      const body: Record<string, unknown> = {
        jql,
        maxResults: PAGE_SIZE,
        // search/jql returns only issue ids unless fields are requested, so
        // an omitted `fields` option keeps asking for the classic default
        // (navigable) field set.
        fields: options.fields ? [...options.fields] : ["*navigable"],
      };
      if (nextPageToken !== undefined) body.nextPageToken = nextPageToken;
      const page = await http.postJson<SearchPage>(`${apiRoot}/search/jql`, body);
      const batch = Array.isArray(page?.issues) ? page.issues : [];
      issues.push(...batch.map(normalizeSearchIssue));
      if (options.limit !== undefined && issues.length >= options.limit) break;
      const token =
        typeof page?.nextPageToken === "string" && page.nextPageToken !== ""
          ? page.nextPageToken
          : undefined;
      if (page?.isLast === true || token === undefined) {
        if (page?.isLast === false) {
          // A page that is explicitly not last must carry a continuation
          // token; stopping here would silently truncate the results.
          throw new Error(
            `jira search ${apiRoot}/search/jql page signaled isLast=false but carried no nextPageToken`,
          );
        }
        break;
      }
      if (seenTokens.has(token)) {
        // Following the same opaque token again would page forever; stopping
        // would silently truncate, so the invalid pagination surfaces.
        throw new Error(
          `jira search ${apiRoot}/search/jql repeated continuation token; refusing to loop`,
        );
      }
      seenTokens.add(token);
      nextPageToken = token;
    }
    return options.limit === undefined ? issues : issues.slice(0, options.limit);
  }

  async function getIssue(issueKey: string, options: JiraIssueOptions = {}): Promise<JiraIssue> {
    const query: Record<string, QueryValue> | undefined = options.fields
      ? { fields: options.fields.join(",") }
      : undefined;
    return await http.getJson<JiraIssue>(`${apiRoot}/issue/${encodeURIComponent(issueKey)}`, {
      query,
    });
  }

  async function getIssueComments(
    issueKey: string,
    options: { readonly limit?: number } = {},
  ): Promise<readonly JiraComment[]> {
    const comments: JiraComment[] = [];
    let startAt = 0;
    for (;;) {
      const page = await http.getJson<CommentPage>(
        `${apiRoot}/issue/${encodeURIComponent(issueKey)}/comment`,
        {
          query: { startAt, maxResults: PAGE_SIZE },
        },
      );
      const batch = Array.isArray(page?.comments) ? page.comments : [];
      comments.push(...batch);
      startAt += batch.length;
      const total = typeof page?.total === "number" ? page.total : startAt;
      if (batch.length === 0 || startAt >= total) break;
      if (options.limit !== undefined && comments.length >= options.limit) break;
    }
    return options.limit === undefined ? comments : comments.slice(0, options.limit);
  }

  async function getIssueWithComments(
    issueKey: string,
    options: JiraIssueOptions = {},
  ): Promise<JiraIssue> {
    // The issue GET must not request the embedded comment field — comments
    // come from the paginated endpoint, which has no oldest-first cap.
    const issueFields = (options.fields ?? []).filter((field) => field !== "comment");
    const [issue, comments] = await Promise.all([
      getIssue(issueKey, { fields: issueFields.length > 0 ? issueFields : undefined }),
      getIssueComments(issueKey),
    ]);
    const fields: Record<string, unknown> = { ...(issue.fields ?? {}) };
    fields.comment = { comments: [...comments] };
    return { ...issue, fields };
  }

  return { searchIssues, getIssue, getIssueComments, getIssueWithComments };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ADF node types rendered inline — joined without newline separators. */
const INLINE_ADF_TYPES = new Set([
  "text",
  "hardBreak",
  "emoji",
  "mention",
  "inlineCard",
  "date",
  "status",
  "mediaInline",
]);

/**
 * True for an Atlassian Document Format document (`{ type: "doc", version,
 * content }`) — the rich-text encoding the enhanced search may use for
 * `description` and comment `body` values (always in v3; the current v2
 * reference example shows ADF as well).
 */
function isAdfDoc(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "doc";
}

/**
 * Flatten an ADF node to plain text: text nodes keep their words,
 * `hardBreak`s become newlines, and block-level children are separated by
 * newlines. Marks, mentions, and media are dropped — the preflights only
 * display the words, never the formatting.
 */
function adfToText(node: unknown): string {
  if (!isRecord(node)) return "";
  if (typeof node.text === "string") return node.text;
  if (node.type === "hardBreak") return "\n";
  const children = Array.isArray(node.content) ? node.content : [];
  const parts = children.map(adfToText);
  const inline = children.every(
    (child) => isRecord(child) && INLINE_ADF_TYPES.has(String(child.type)),
  );
  return parts.join(inline ? "" : "\n");
}

/**
 * Normalize one search issue: ADF `description` and embedded comment `body`
 * values flatten to plain text so consumers never see `[object Object]`;
 * plain strings (the observed v2 behavior) pass through untouched.
 */
function normalizeSearchIssue(issue: JiraIssue): JiraIssue {
  const fields = issue.fields;
  if (!isRecord(fields)) return issue;
  const normalized: Record<string, unknown> = { ...fields };
  if (isAdfDoc(normalized.description)) {
    normalized.description = adfToText(normalized.description);
  }
  const comment = normalized.comment;
  if (isRecord(comment) && Array.isArray(comment.comments)) {
    normalized.comment = {
      ...comment,
      comments: comment.comments.map((entry) =>
        isRecord(entry) && isAdfDoc(entry.body) ? { ...entry, body: adfToText(entry.body) } : entry,
      ),
    };
  }
  return { ...issue, fields: normalized };
}
