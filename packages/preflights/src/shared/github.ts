import { GraphqlResponseError, graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import type { CommentRecord } from "./format.js";
import type { FetchLike, FetchRequestInit } from "./http.js";
import { composeRoute, isPreflightHttpError, PreflightHttpError } from "./http.js";

/**
 * GitHub client — replaces the Python `gh` CLI calls of `gh_pr_status.py`
 * (REHOR-239 decision: Octokit from TypeScript). All traffic routes through
 * the auth proxy: the REST client's base URL and the GraphQL endpoint both
 * compose as the proxy base URL plus the `/github` path prefix, and no
 * Authorization header is sent — the proxy injects credentials on the
 * upstream leg.
 *
 * Every outgoing SDK URL is constrained to that route (origin AND route
 * path boundary) by a fetch wrapper that sits under Octokit:
 *
 * - The gateway rewrites pagination `Link` headers and redirect `Location`
 *   headers into gateway-relative `/github/...` paths (it cannot infer its
 *   public origin behind the OAuth proxy). Octokit's endpoint merger
 *   prepends its base URL to such paths, which would double the prefix —
 *   the wrapper normalizes them back onto the route, resolving against the
 *   configured proxy base so an external path prefix (e.g. `/devbot-proxy`)
 *   is never dropped or duplicated.
 * - Absolute URLs that leave the route — another origin, another prefix on
 *   the same origin, or a path outside the `/github` subtree — are rejected
 *   with an execution error before the underlying fetch runs. The wrapper
 *   never rebases an unknown host or guesses an enterprise API host.
 * - Redirects are handled manually (never by the native fetch auto-follow,
 *   which would bypass the wrapper): same-route redirects are followed,
 *   off-route ones are rejected before the target is requested.
 *
 * PR details come from one GraphQL query — `statusCheckRollup` and
 * `reviewDecision` are GraphQL-only fields today (`gh pr view --json` is
 * GraphQL-backed), and the GraphQL field names (`submittedAt`,
 * `author.login`, `state`) match what the Python code read, so no field
 * reshaping is needed. Rollup nodes are preserved exactly as `gh pr view
 * --json` exported them: CheckRun nodes carry {name, conclusion,
 * detailsUrl}, StatusContext nodes carry {context, state, targetUrl}. The
 * Python classifier read `conclusion`/`name`/`detailsUrl`, so legacy
 * commit-status failures stayed invisible to it — preserving the
 * CLI-exported shape (instead of normalizing StatusContext into the
 * check-run shape) keeps that parity and creates no new actionable CI
 * states.
 *
 * Comments come from the two REST endpoints the Python code paginated with
 * `gh api --paginate` — inline review comments and issue comments — using
 * Octokit's built-in pagination. Every walk carries the Python subprocess
 * timeout (15 s) as an operation-scoped AbortController: Octokit's iterator
 * does not forward per-call request options, so the deadline signal is bound
 * into the endpoint's fetch, aborting in-flight page requests and refusing
 * any page requested after the deadline. The GraphQL call keeps its native
 * fetch deadline (an AbortSignal.timeout passed with the request).
 */

/** Route prefix this package requires on the auth proxy for GitHub. */
export const GITHUB_PATH_PREFIX = "/github";

/** Per-request timeout; the Python `gh` subprocess calls used 15 s. */
export const GITHUB_TIMEOUT_MS = 15_000;

/** Upper bound on manually followed same-route redirects per request. */
const MAX_REDIRECT_HOPS = 10;

/** A PR review, as returned by the GraphQL `reviews` connection. */
export interface GhPrReview {
  readonly state?: string | null;
  readonly body?: string | null;
  readonly submittedAt?: string | null;
  readonly author?: { readonly login?: string | null } | null;
}

/**
 * One rollup entry, preserved in the shape `gh pr view --json` exported:
 * CheckRun nodes carry name/conclusion/detailsUrl, StatusContext nodes
 * carry context/state/targetUrl. All fields are optional because the two
 * node types never share them.
 */
export interface GhStatusCheckEntry {
  readonly __typename?: string | null;
  /** CheckRun fields. */
  readonly name?: string | null;
  readonly conclusion?: string | null;
  readonly detailsUrl?: string | null;
  /** StatusContext fields. */
  readonly context?: string | null;
  readonly state?: string | null;
  readonly targetUrl?: string | null;
}

/** PR details — the fields `gh pr view --json` returned that the port reads. */
export interface GhPrData {
  readonly state?: string | null;
  readonly mergeable?: string | null;
  readonly reviewDecision?: string | null;
  readonly url?: string | null;
  readonly title?: string | null;
  readonly isDraft?: boolean | null;
  readonly reviews?: readonly GhPrReview[] | null;
  readonly statusCheckRollup?: readonly GhStatusCheckEntry[] | null;
}

export interface GitHubClientConfig {
  /** Proxy base URL, e.g. `https://proxy.example/devbot-proxy`. */
  readonly baseUrl: string;
  /** Path prefix; defaults to {@link GITHUB_PATH_PREFIX}. */
  readonly pathPrefix?: string;
  /** Request timeout in milliseconds; defaults to {@link GITHUB_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Injectable fetch for fixture-based tests. */
  readonly fetch?: FetchLike;
}

export interface GitHubClient {
  /** Composed proxy base URL + path prefix — the route this client requires. */
  readonly route: string;
  /**
   * Fetch one PR's details (state, mergeability, check rollup, review
   * decision, reviews) via GraphQL. Returns null when the pull request does
   * not exist.
   */
  getPr(ownerRepo: string, number: number): Promise<GhPrData | null>;
  /**
   * Fetch every PR comment — inline review comments first, then general
   * issue comments — mapped to `{a, t, b}` records, the shape the Python
   * `gh api --jq` projection produced. The two endpoints fail
   * independently: when only one fails, the other endpoint's comments are
   * still returned; when both fail, the call throws an HTTP execution
   * error naming both failures.
   */
  getPrComments(ownerRepo: string, number: number): Promise<readonly CommentRecord[]>;
}

// The fields mirror `gh pr view --json state,mergeable,statusCheckRollup,
// reviewDecision,reviews,url,title,isDraft`. The page sizes match gh: one
// page of reviews and one page of rollup contexts (100 each).
const PR_STATUS_QUERY = `query PrStatus($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state
      mergeable
      reviewDecision
      url
      title
      isDraft
      reviews(first: 100) {
        nodes {
          state
          body
          submittedAt
          author {
            login
          }
        }
      }
      statusCheckRollup {
        contexts(first: 100) {
          nodes {
            __typename
            ... on CheckRun {
              name
              conclusion
              detailsUrl
            }
            ... on StatusContext {
              context
              state
              targetUrl
            }
          }
        }
      }
    }
  }
}`;

interface RollupNode {
  readonly __typename?: string | null;
  readonly name?: string | null;
  readonly conclusion?: string | null;
  readonly detailsUrl?: string | null;
  readonly context?: string | null;
  readonly state?: string | null;
  readonly targetUrl?: string | null;
}

interface PrStatusResponse {
  readonly repository?: {
    readonly pullRequest?: {
      readonly state?: string | null;
      readonly mergeable?: string | null;
      readonly reviewDecision?: string | null;
      readonly url?: string | null;
      readonly title?: string | null;
      readonly isDraft?: boolean | null;
      readonly reviews?: { readonly nodes?: readonly GhPrReview[] | null } | null;
      readonly statusCheckRollup?: {
        readonly contexts?: { readonly nodes?: readonly RollupNode[] | null } | null;
      } | null;
    } | null;
  } | null;
}

interface RestComment {
  readonly user?: { readonly login?: string | null } | null;
  readonly created_at?: string | null;
  readonly body?: string | null;
}

/** The configured proxy route, split for URL boundary enforcement. */
interface ProxyRouteGeometry {
  /** Full required route (proxy base URL + GitHub path prefix). */
  readonly route: string;
  /**
   * Proxy base URL (the route minus the GitHub prefix). Gateway-relative
   * `/github/...` paths resolve against this, so an external path prefix of
   * the proxy base is preserved instead of dropped.
   */
  readonly gatewayBase: string;
  /** Origin the route must stay on. */
  readonly origin: string;
  /** Route path without a trailing slash ("" when the route is the origin). */
  readonly path: string;
  /** Normalized GitHub path prefix ("" when the prefix is empty). */
  readonly prefix: string;
}

function proxyRouteGeometry(route: string, pathPrefix: string): ProxyRouteGeometry {
  // Mirrors the normalization composeRoute applies to the prefix, so the
  // gateway base is exactly the base URL composeRoute stripped it from.
  let prefix = pathPrefix;
  if (prefix !== "" && !prefix.startsWith("/")) prefix = `/${prefix}`;
  prefix = prefix.replace(/\/+$/, "");
  const parsed = new URL(route);
  const path = parsed.pathname.replace(/\/+$/, "");
  return {
    route,
    gatewayBase: route.slice(0, route.length - prefix.length),
    origin: parsed.origin,
    path,
    prefix,
  };
}

function isAbsoluteUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** True when the URL is on the route origin and inside the route path. */
function isWithinRoute(geometry: ProxyRouteGeometry, url: URL): boolean {
  return (
    url.origin === geometry.origin &&
    (url.pathname === geometry.path || url.pathname.startsWith(`${geometry.path}/`))
  );
}

/**
 * Normalize one outgoing SDK URL to an absolute URL on the route, or reject
 * it before any transport call. Handles the two shapes the SDKs hand to
 * fetch: absolute URLs (validated as-is) and gateway-relative paths
 * (resolved against the gateway base). Octokit's endpoint merger may have
 * already prepended the route to a gateway-relative Link path — the
 * duplicated prefix is stripped, because the GitHub REST API has no
 * top-level `/github/...` paths of its own.
 */
function resolveRouteTarget(geometry: ProxyRouteGeometry, rawUrl: string): URL {
  let candidate: URL;
  if (isAbsoluteUrl(rawUrl)) {
    candidate = stripDoubledPrefix(geometry, new URL(rawUrl));
  } else if (rawUrl.startsWith("/")) {
    candidate = stripDoubledPrefix(geometry, new URL(`${geometry.gatewayBase}${rawUrl}`));
  } else {
    throw offRouteError(geometry, rawUrl, "GET", "not an absolute URL or gateway-relative path");
  }
  if (!isWithinRoute(geometry, candidate)) {
    throw offRouteError(
      geometry,
      rawUrl,
      "GET",
      `request escapes the route (resolved to ${candidate.toString()})`,
    );
  }
  return candidate;
}

function stripDoubledPrefix(geometry: ProxyRouteGeometry, url: URL): URL {
  if (geometry.prefix === "") return url;
  const doubled = `${geometry.path}${geometry.prefix}`;
  if (url.pathname === doubled || url.pathname.startsWith(`${doubled}/`)) {
    const rest = url.pathname.slice(doubled.length);
    return new URL(`${url.origin}${geometry.path}${rest}${url.search}${url.hash}`);
  }
  return url;
}

/**
 * Resolve a redirect `Location` value to a URL string for
 * {@link resolveRouteTarget}. Root-relative values are gateway-relative
 * (the gateway does not know the external prefix), so they anchor on the
 * gateway base — not on the bare origin, which would drop the prefix.
 */
function resolveLocation(geometry: ProxyRouteGeometry, location: string, currentUrl: URL): string {
  if (isAbsoluteUrl(location)) return location;
  if (location.startsWith("/")) return `${geometry.gatewayBase}${location}`;
  return new URL(location, currentUrl).toString();
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Build the follow-up request for a redirect, following the WHATWG fetch
 * semantics the native auto-follow would have applied: 307/308 preserve
 * method and body, 301/302/303 drop the body and turn POST into GET.
 */
function redirectRequestInit(init: FetchRequestInit, status: number): FetchRequestInit {
  if (status === 307 || status === 308) return init;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === "content-type" || lower === "content-length") continue;
    headers[name] = value;
  }
  const method = status === 303 || init.method === "POST" ? "GET" : (init.method ?? "GET");
  return { method, headers, signal: init.signal };
}

function offRouteError(
  geometry: ProxyRouteGeometry,
  rawUrl: string,
  method: string,
  detail: string,
): PreflightHttpError {
  return new PreflightHttpError({
    status: null,
    method,
    url: rawUrl,
    route: geometry.route,
    message: `${method} ${rawUrl} was rejected before sending: ${detail} — GitHub requests must stay on the proxy route ${geometry.route}`,
  });
}

/** A per-operation deadline bound into the guarded fetch. */
interface FetchDeadline {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

/**
 * Wrap the injectable (or native) fetch with the proxy-route boundary:
 * every URL is normalized and validated before the underlying fetch runs,
 * and redirects are followed manually so the boundary also holds for every
 * hop. The underlying fetch keeps its `(url, init) => Promise<Response>`
 * shape and stays headerless — the wrapper adds no headers of its own.
 *
 * When a deadline is given, its signal is merged into every request (so the
 * transport can abort in flight) and checked before every request — a page
 * requested after the deadline is refused without touching the transport,
 * even when the transport itself ignores abort signals.
 */
function createProxyFetch(
  rawFetch: FetchLike,
  geometry: ProxyRouteGeometry,
  deadline?: FetchDeadline,
): FetchLike {
  return async (rawUrl: string, init: FetchRequestInit): Promise<Response> => {
    let url = resolveRouteTarget(geometry, rawUrl);
    let currentInit: FetchRequestInit = init;
    for (let hop = 0; ; hop++) {
      const method = currentInit.method ?? "GET";
      if (deadline?.signal.aborted) {
        throw new PreflightHttpError({
          status: null,
          method,
          url: url.toString(),
          route: geometry.route,
          message: `${method} ${url.toString()} timed out after ${deadline.timeoutMs}ms`,
        });
      }
      const signal = mergeAbortSignals(currentInit.signal, deadline?.signal);
      const response = await rawFetch(url.toString(), {
        ...currentInit,
        redirect: "manual",
        signal,
      });
      if (!isRedirectStatus(response.status)) return response;
      const location = response.headers.get("location");
      // Without a Location there is nothing to follow; surface the redirect
      // response to the SDK like a manual-redirect fetch would.
      if (location === null || location === "") return response;
      if (hop >= MAX_REDIRECT_HOPS) {
        throw new PreflightHttpError({
          status: null,
          method,
          url: url.toString(),
          route: geometry.route,
          message: `${method} ${url.toString()} exceeded ${MAX_REDIRECT_HOPS} redirects on the proxy route`,
        });
      }
      url = resolveRouteTarget(geometry, resolveLocation(geometry, location, url));
      currentInit = redirectRequestInit(currentInit, response.status);
    }
  };
}

function mergeAbortSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  const signals = [first, second].filter((signal) => signal !== undefined);
  if (signals.length === 0) return undefined;
  const aborted = signals.find((signal) => signal.aborted);
  if (aborted !== undefined) return aborted;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

export function createGitHubClient(config: GitHubClientConfig): GitHubClient {
  const route = composeRoute(config.baseUrl, config.pathPrefix ?? GITHUB_PATH_PREFIX);
  const timeoutMs = config.timeoutMs ?? GITHUB_TIMEOUT_MS;
  const geometry = proxyRouteGeometry(route, config.pathPrefix ?? GITHUB_PATH_PREFIX);
  const rawFetch: FetchLike = config.fetch ?? fetch;
  const proxyFetch = createProxyFetch(rawFetch, geometry);

  function splitOwnerRepo(ownerRepo: string): { owner: string; repo: string } {
    const separator = ownerRepo.indexOf("/");
    if (separator <= 0 || separator === ownerRepo.length - 1) {
      throw new Error(`GitHub owner/repo must look like "org/repo": "${ownerRepo}"`);
    }
    return { owner: ownerRepo.slice(0, separator), repo: ownerRepo.slice(separator + 1) };
  }

  async function getPr(ownerRepo: string, number: number): Promise<GhPrData | null> {
    const { owner, repo } = splitOwnerRepo(ownerRepo);
    const url = `${route}/graphql`;
    const response = await mapHttpError(
      route,
      url,
      "POST",
      () =>
        withTimeout(
          () =>
            graphql<PrStatusResponse>(PR_STATUS_QUERY, {
              baseUrl: route,
              owner,
              repo,
              number,
              request: { fetch: proxyFetch, signal: AbortSignal.timeout(timeoutMs) },
            }),
          timeoutMs,
          route,
          url,
          "POST",
        ),
      timeoutMs,
    );
    const pr = response?.repository?.pullRequest;
    if (!pr) return null;
    return {
      state: pr.state ?? null,
      mergeable: pr.mergeable ?? null,
      reviewDecision: pr.reviewDecision ?? null,
      url: pr.url ?? null,
      title: pr.title ?? null,
      isDraft: pr.isDraft ?? null,
      reviews: pr.reviews?.nodes ?? [],
      statusCheckRollup: pr.statusCheckRollup?.contexts?.nodes?.map(normalizeRollupEntry) ?? [],
    };
  }

  /**
   * Walk one comments endpoint under its own deadline, the budget a single
   * `gh api --paginate` subprocess had in the Python code. Octokit's
   * pagination iterator does not forward per-call request options, so the
   * deadline signal is bound into a per-operation Octokit's fetch: page
   * requests abort in flight when the deadline fires, and pages requested
   * after it are refused before the transport runs.
   */
  async function paginateCommentsEndpoint(
    endpoint: {
      readonly route: string;
      readonly params: Record<string, number>;
      readonly path: string;
    },
    owner: string,
    repo: string,
  ): Promise<readonly RestComment[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const deadlineFetch = createProxyFetch(rawFetch, geometry, {
        signal: controller.signal,
        timeoutMs,
      });
      // No auth option anywhere: the proxy injects credentials upstream, so
      // Octokit runs headerless.
      const endpointOctokit = new Octokit({
        baseUrl: route,
        request: { fetch: deadlineFetch },
      });
      return (await endpointOctokit.paginate(endpoint.route, {
        owner,
        repo,
        ...endpoint.params,
      })) as readonly RestComment[];
    } catch (error) {
      if (controller.signal.aborted && !isPreflightHttpError(error)) {
        throw new PreflightHttpError({
          status: null,
          method: "GET",
          url: `${route}${endpoint.path}`,
          route,
          message: `GET ${route}${endpoint.path} timed out after ${timeoutMs}ms`,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getPrComments(ownerRepo: string, number: number): Promise<CommentRecord[]> {
    const { owner, repo } = splitOwnerRepo(ownerRepo);
    const comments: CommentRecord[] = [];
    const endpoints: readonly {
      route: string;
      params: Record<string, number>;
      path: string;
    }[] = [
      {
        route: "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
        params: { pull_number: number },
        path: `/repos/${ownerRepo}/pulls/${number}/comments`,
      },
      {
        route: "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        params: { issue_number: number },
        path: `/repos/${ownerRepo}/issues/${number}/comments`,
      },
    ];
    // Each endpoint fails independently, like the Python gh_pr_comments
    // wrapper did — one failing `gh api` subprocess never discarded the
    // other endpoint's comments or stopped it from running. Only when every
    // endpoint failed is the whole call an HTTP failure; a silent empty
    // list would look healthy.
    const failures: PreflightHttpError[] = [];
    for (const endpoint of endpoints) {
      try {
        const page = await paginateCommentsEndpoint(endpoint, owner, repo);
        for (const comment of page) {
          comments.push({
            a: comment?.user?.login ?? null,
            t: comment?.created_at ?? null,
            b: comment?.body ?? null,
          });
        }
      } catch (error) {
        failures.push(
          toPreflightHttpError(error, route, `${route}${endpoint.path}`, "GET", timeoutMs),
        );
      }
    }
    if (failures.length === endpoints.length) {
      const first = failures[0];
      throw new PreflightHttpError({
        status: first.status,
        method: first.method,
        url: first.url,
        route,
        message: `all GitHub comment endpoints failed: ${failures
          .map((failure) => failure.message)
          .join("; ")}`,
      });
    }
    return comments;
  }

  return {
    route,
    getPr,
    getPrComments,
  };
}

/**
 * `gh pr view --json statusCheckRollup` preserves each rollup node as the
 * GraphQL query returned it — commit statuses keep {context, state,
 * targetUrl} and are NOT flattened into the check-run shape — so the
 * ported Python classifier (which reads `conclusion`, `name`,
 * `detailsUrl`) treats them exactly like it did: invisible as CI failures.
 */
function normalizeRollupEntry(node: RollupNode): GhStatusCheckEntry {
  return { ...node };
}

/**
 * Race an operation against a timeout, reporting it like the shared HTTP
 * client does. Used for the GraphQL call, where the native fetch deadline
 * (an AbortSignal.timeout passed with the request) cancels the transport
 * and this race guarantees the failure surfaces as a timeout error.
 */
async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  route: string,
  url: string,
  method: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new PreflightHttpError({
              status: null,
              method,
              url,
              route,
              message: `${method} ${url} timed out after ${timeoutMs}ms`,
            }),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map an Octokit/GraphQL failure onto the package's execution-error type so
 * an unavailable proxy route (404), an upstream failure, or a GraphQL error
 * is reported like every other preflight HTTP failure. When `timeoutMs` is
 * given, abort failures (the native deadline firing) are reported as
 * timeouts instead of the misleading HTTP 500 Octokit's fetch wrapper
 * stamps on them.
 */
async function mapHttpError<T>(
  route: string,
  fallbackUrl: string,
  fallbackMethod: string,
  operation: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toPreflightHttpError(error, route, fallbackUrl, fallbackMethod, timeoutMs);
  }
}

function toPreflightHttpError(
  error: unknown,
  route: string,
  fallbackUrl: string,
  fallbackMethod: string,
  timeoutMs?: number,
): PreflightHttpError {
  if (error instanceof PreflightHttpError) return error;
  // Octokit's fetch wrapper rewraps errors thrown by a custom fetch into a
  // RequestError that carries the original as `cause` — recover the
  // execution error the wrapper rejected with.
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  if (cause instanceof PreflightHttpError) return cause;
  const name = error instanceof Error ? error.name : "";
  if (timeoutMs !== undefined && (name === "AbortError" || name === "TimeoutError")) {
    return new PreflightHttpError({
      status: null,
      method: fallbackMethod,
      url: fallbackUrl,
      route,
      message: `${fallbackMethod} ${fallbackUrl} timed out after ${timeoutMs}ms`,
    });
  }
  if (error instanceof GraphqlResponseError) {
    return new PreflightHttpError({
      status: null,
      method: fallbackMethod,
      url: fallbackUrl,
      route,
      message: `${fallbackMethod} ${fallbackUrl} failed: ${error.message}`,
    });
  }
  const candidate = error as { status?: unknown; request?: { url?: unknown; method?: unknown } };
  const status = typeof candidate?.status === "number" ? candidate.status : null;
  const url = typeof candidate?.request?.url === "string" ? candidate.request.url : fallbackUrl;
  const method =
    typeof candidate?.request?.method === "string" ? candidate.request.method : fallbackMethod;
  const detail = error instanceof Error ? error.message : String(error);
  let message = `${method} ${url} failed: ${detail}`;
  if (status !== null) {
    message = `${method} ${url} failed with HTTP ${status}`;
    if (status === 404) {
      message += ` (required route "${route}" is not available on the proxy)`;
    }
    message += `: ${detail}`;
  }
  return new PreflightHttpError({ status, method, url, route, message });
}
