import { createRequesterFn } from "@gitbeaker/requester-utils";
import type { ExpandedMergeRequestSchema, NoteSchema } from "@gitbeaker/rest";
import { Gitlab } from "@gitbeaker/rest";
import type { FetchLike } from "../../shared/http.js";
import { PreflightHttpError } from "../../shared/http.js";

/**
 * GitLab transport for the gl-mr-status preflight — the port of the Python
 * `gl_mr` / `gl_mr_notes` glab-CLI wrappers (`presets/shared/preflight/
 * gl_mr_status.py`), rebuilt on gitbeaker per the REHOR-239 decision.
 *
 * ## Transport decision
 *
 * gitbeaker (pinned 43.8.0 — the newest line whose `engines` accepts the
 * repo's Node 22 floor; 44.x requires Node ≥24.16) composes every request
 * URL as `host/api/v4/...` — the old `pathPrefix` option is gone — so the
 * client is pointed at the auth proxy
 * by overriding `host` with the proxy base URL plus this package's GitLab
 * path prefix. Requests then hit `{route}/api/v4/...` (e.g.
 * `https://proxy.example/devbot-proxy/gitlab/api/v4/projects/...`), which
 * the auth proxy forwards to the GitLab API v4 root (REHOR-263); the
 * package declares the route, never credentials — no auth headers are sent
 * and the proxy injects them upstream.
 *
 * The gitbeaker-bundled requester cannot be pointed at an injectable fetch
 * (it calls the global `fetch`) and adds retry/backoff (up to 10 retries on
 * 429/502), global rate limiting, and a 5-minute default timeout —
 * semantics that clash with this package's fail-fast error model. This
 * module therefore supplies a custom `requesterFn` (built from
 * `@gitbeaker/requester-utils`' public `createRequesterFn`, which applies
 * gitbeaker's default options handling — query formatting, header assembly,
 * the queryTimeout abort signal — before the request handler) that routes
 * every request through an injectable {@link FetchLike} and raises
 * {@link PreflightHttpError} on non-2xx,
 * timeout, or network failure — the shared HTTP contract: an execution
 * error, never a silent skip. gitbeaker still provides what the spike
 * decided to keep it for: typed schemas, endpoint building with
 * project-path encoding, query formatting, and link-header pagination (the
 * `glab api --paginate` behavior).
 */

/** Route prefix this package requires on the auth proxy for GitLab. */
export const GITLAB_PATH_PREFIX = "/gitlab";

/** The Python wrapper's glab subprocess timeout, in milliseconds. */
const DEFAULT_GITLAB_TIMEOUT_MS = 15_000;

/** The Python wrapper's `per_page=50` for MR notes. */
const NOTES_PER_PAGE = 50;

/** A GitLab MR as returned by `projects/:id/merge_requests/:iid`. */
export type GlMergeRequest = ExpandedMergeRequestSchema;

/**
 * A MR note mapped to the Python wrapper's compact shape: `a` (author
 * username), `t` (created_at), `b` (body) — the fields the shared
 * `fmtComments` / `hasNewFeedback` helpers read. System notes are excluded.
 */
export type GlMrNote = {
  readonly a: string;
  readonly t: string;
  readonly b: string;
};

export interface GitlabClientConfig {
  /** Proxy base URL, e.g. `https://proxy.example/devbot-proxy`. */
  readonly baseUrl: string;
  /** Path prefix; defaults to {@link GITLAB_PATH_PREFIX}. */
  readonly pathPrefix?: string;
  /** Request timeout in milliseconds; defaults to 15 s (the glab timeout). */
  readonly timeoutMs?: number;
  /** Injectable fetch for fixture-based tests. */
  readonly fetch?: FetchLike;
}

export interface GitlabClient {
  /** Composed proxy base URL + path prefix — the route this client requires. */
  readonly route: string;
  /** Fetch one MR by project path and MR iid; the raw GitLab schema. */
  getMergeRequest(projectPath: string, mrIid: number): Promise<GlMergeRequest>;
  /** Fetch every non-system MR note, oldest first, as compact records. */
  listMergeRequestNotes(projectPath: string, mrIid: number): Promise<readonly GlMrNote[]>;
}

export function createGitlabClient(config: GitlabClientConfig): GitlabClient {
  const route = composeGitlabRoute(config.baseUrl, config.pathPrefix ?? GITLAB_PATH_PREFIX);
  const timeoutMs = config.timeoutMs ?? DEFAULT_GITLAB_TIMEOUT_MS;
  const fetchImpl: FetchLike = config.fetch ?? fetch;
  const api = new Gitlab({
    host: route,
    queryTimeout: timeoutMs,
    requesterFn: createPreflightRequester(fetchImpl, route, timeoutMs),
  });
  return {
    route,
    getMergeRequest: (projectPath, mrIid) => api.MergeRequests.show(projectPath, mrIid),
    listMergeRequestNotes: async (projectPath, mrIid) => {
      const notes = await api.MergeRequestNotes.all(projectPath, mrIid, {
        sort: "asc",
        perPage: NOTES_PER_PAGE,
      });
      return notes.filter((note) => !note.system).map((note) => mapNote(note));
    },
  };
}

/** Map a GitLab note to the compact record, with the Python defaults. */
function mapNote(note: NoteSchema): GlMrNote {
  return {
    a: typeof note.author?.username === "string" ? note.author.username : "?",
    t: typeof note.created_at === "string" ? note.created_at : "",
    b: typeof note.body === "string" ? note.body : "",
  };
}

/**
 * The request options gitbeaker's default options handler produces. Its
 * `RequestHandlerFn` types the bag loosely (`Record<string, unknown>`),
 * so the handler narrows once to the fields it consumes.
 */
interface GitbeakerRequestOptions {
  headers?: Record<string, string>;
  method?: string;
  searchParams?: string;
  prefixUrl?: string;
  body?: string | FormData;
  signal?: AbortSignal;
}

/** The JSON body shapes gitbeaker's endpoints return (a subset of its `ResponseBodyTypes`). */
type GitbeakerJsonBody = Record<string, unknown> | Record<string, unknown>[];

/**
 * Build the gitbeaker requester: gitbeaker's default options handler (query
 * formatting, header assembly, the queryTimeout abort signal) plus a
 * request handler that calls the injected fetch and maps every failure to
 * a {@link PreflightHttpError}. Retries and rate limiting are deliberately
 * absent — retrying with backoff is the dispatcher's job, not a single
 * preflight run's.
 */
function createPreflightRequester(
  fetchImpl: FetchLike,
  route: string,
  timeoutMs: number,
): ReturnType<typeof createRequesterFn> {
  return createRequesterFn(
    (_serviceOptions, requestOptions) => Promise.resolve(requestOptions),
    async (endpoint, options = {}) => {
      const opts = options as GitbeakerRequestOptions;
      const base = opts.prefixUrl?.endsWith("/") ? opts.prefixUrl : `${opts.prefixUrl ?? ""}/`;
      const url = new URL(endpoint, base);
      url.search = opts.searchParams ?? "";
      const method = opts.method ?? "GET";
      const target = url.toString();
      let response: Response;
      try {
        response = await fetchImpl(target, {
          method,
          headers: opts.headers ?? {},
          body: typeof opts.body === "string" ? opts.body : undefined,
          signal: opts.signal,
          redirect: "error",
        });
      } catch (cause) {
        throw new PreflightHttpError({
          status: null,
          method,
          url: target,
          route,
          message: describeTransportFailure(method, target, timeoutMs, cause),
        });
      }
      if (!response.ok) {
        throw new PreflightHttpError({
          status: response.status,
          method,
          url: target,
          route,
          message: await describeHttpStatus(method, target, response),
        });
      }
      const text = await response.text();
      let body: GitbeakerJsonBody;
      try {
        body = text === "" ? {} : (JSON.parse(text) as GitbeakerJsonBody);
      } catch {
        throw new PreflightHttpError({
          status: response.status,
          method,
          url: target,
          route,
          message: `${method} ${target} returned a non-JSON body (HTTP ${response.status})`,
        });
      }
      return {
        body,
        headers: Object.fromEntries(response.headers.entries()),
        status: response.status,
      };
    },
  );
}

/** Compose the required route; same rules as the shared HTTP client. */
function composeGitlabRoute(baseUrl: string, pathPrefix: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === "") {
    throw new Error("gitlab client baseUrl must be a non-empty string");
  }
  const base = trimmed.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`gitlab client baseUrl must be an absolute URL: "${baseUrl}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`gitlab client baseUrl must be an absolute URL: "${baseUrl}"`);
  }
  let prefix = pathPrefix;
  if (prefix !== "" && !prefix.startsWith("/")) prefix = `/${prefix}`;
  prefix = prefix.replace(/\/+$/, "");
  return `${base}${prefix}`;
}

/** Message format mirrors the shared HTTP client (`shared/http.ts`). */
function describeTransportFailure(
  method: string,
  url: string,
  timeoutMs: number,
  cause: unknown,
): string {
  const name = cause instanceof Error ? cause.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return `${method} ${url} timed out after ${timeoutMs}ms`;
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return `${method} ${url} failed: ${detail}`;
}

/** Message format mirrors the shared HTTP client (`shared/http.ts`). */
async function describeHttpStatus(
  method: string,
  url: string,
  response: Response,
): Promise<string> {
  let message = `${method} ${url} failed with HTTP ${response.status}`;
  const bodyText = await response.text().catch(() => "");
  if (bodyText !== "") {
    message += `: ${bodyText.slice(0, 200)}`;
  }
  return message;
}
