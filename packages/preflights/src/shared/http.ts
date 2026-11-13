/**
 * Shared HTTP client for preflight external-system access.
 *
 * Every external request composes a proxy base URL plus the target system's
 * path prefix (e.g. `https://proxy.example/devbot-proxy` + `/jira`): the
 * package declares required routes, never credentials — the auth proxy
 * injects them on the upstream leg. An unavailable route, any non-2xx
 * response, a timeout, or a network failure throws {@link PreflightHttpError}
 * — an execution error the caller maps to an `error` result, never a silent
 * skip.
 */

/** Minimal fetch initializer the clients rely on (a subset of RequestInit). */
export interface FetchRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal | undefined;
  readonly redirect?: "follow" | "error" | "manual";
}

/** Injectable fetch for tests; the native Node 22 `fetch` satisfies it. */
export type FetchLike = (url: string, init: FetchRequestInit) => Promise<Response>;

/** Query parameter value; arrays serialize as repeated keys. */
export type QueryValue = string | number | readonly (string | number)[];

export interface HttpClientConfig {
  /** Proxy base URL, e.g. `https://proxy.example/devbot-proxy`. */
  readonly baseUrl: string;
  /** Per-system path prefix appended to the base URL, e.g. `/jira`. */
  readonly pathPrefix?: string;
  /** Request timeout in milliseconds; defaults to 10 s. */
  readonly timeoutMs?: number;
  /** Headers sent with every request (e.g. memory-server bearer auth). */
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  /** Injectable fetch for fixture-based tests. */
  readonly fetch?: FetchLike;
}

export interface JsonRequestOptions {
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface HttpClient {
  /** Composed base URL + path prefix — the route this client requires. */
  readonly route: string;
  getJson<T>(path: string, options?: JsonRequestOptions): Promise<T>;
  postJson<T>(path: string, body: unknown, options?: JsonRequestOptions): Promise<T>;
}

export interface HttpErrorInit {
  readonly status: number | null;
  readonly method: string;
  readonly url: string;
  readonly route: string;
  readonly message: string;
}

/**
 * Execution-time HTTP failure: non-2xx response, timeout, or network error.
 * Carries the composed route so an unavailable proxy route is diagnosable.
 */
export class PreflightHttpError extends Error {
  /** HTTP status code, or null for timeouts and network failures. */
  readonly status: number | null;
  readonly method: string;
  readonly url: string;
  readonly route: string;

  constructor(init: HttpErrorInit) {
    super(init.message);
    this.name = "PreflightHttpError";
    this.status = init.status;
    this.method = init.method;
    this.url = init.url;
    this.route = init.route;
  }

  /**
   * True when the proxy answered 404 — the required route (base URL + path
   * prefix) is not available on this proxy. Never a reason to skip silently.
   */
  get routeUnavailable(): boolean {
    return this.status === 404;
  }
}

export function isPreflightHttpError(error: unknown): error is PreflightHttpError {
  return error instanceof PreflightHttpError;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createHttpClient(config: HttpClientConfig): HttpClient {
  const route = composeRoute(config.baseUrl, config.pathPrefix ?? "");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: FetchLike = config.fetch ?? fetch;

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    options: JsonRequestOptions | undefined,
  ): Promise<T> {
    if (!path.startsWith("/") || path === "/") {
      throw new Error(`request path must start with "/" and name a resource: "${path}"`);
    }
    const url = buildUrl(route, path, options?.query);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (config.defaultHeaders) Object.assign(headers, config.defaultHeaders);
    if (options?.headers) Object.assign(headers, options.headers);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const requestTimeoutMs = options?.timeoutMs ?? timeoutMs;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
        redirect: "error",
      });
    } catch (cause) {
      throw new PreflightHttpError({
        status: null,
        method,
        url,
        route,
        message: describeTransportFailure(method, url, requestTimeoutMs, cause),
      });
    }
    if (!response.ok) {
      throw new PreflightHttpError({
        status: response.status,
        method,
        url,
        route,
        message: await describeHttpStatus(method, url, response, route),
      });
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PreflightHttpError({
        status: response.status,
        method,
        url,
        route,
        message: `${method} ${url} returned a non-JSON body (HTTP ${response.status})`,
      });
    }
  }

  return {
    route,
    getJson: (path, options) => request("GET", path, undefined, options),
    postJson: (path, body, options) => request("POST", path, body, options),
  };
}

/** Compose the required route from the proxy base URL and the path prefix. */
/**
 * Compose the required route from the proxy base URL and the path prefix.
 * Exported for SDK-based clients (Octokit, gitbeaker, …) that bring their own
 * request machinery but must resolve and validate the route identically.
 */
export function composeRoute(baseUrl: string, pathPrefix: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === "") {
    throw new Error("httpClient baseUrl must be a non-empty string");
  }
  const base = trimmed.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`httpClient baseUrl must be an absolute URL: "${baseUrl}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`httpClient baseUrl must be an absolute URL: "${baseUrl}"`);
  }
  let prefix = pathPrefix;
  if (prefix !== "" && !prefix.startsWith("/")) prefix = `/${prefix}`;
  prefix = prefix.replace(/\/+$/, "");
  return `${base}${prefix}`;
}

function buildUrl(
  route: string,
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
): string {
  if (query === undefined || Object.keys(query).length === 0) {
    return `${route}${path}`;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  return `${route}${path}?${params.toString()}`;
}

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

async function describeHttpStatus(
  method: string,
  url: string,
  response: Response,
  route: string,
): Promise<string> {
  let message = `${method} ${url} failed with HTTP ${response.status}`;
  if (response.status === 404) {
    message += ` (required route "${route}" is not available on the proxy)`;
  }
  const bodyText = await response.text().catch(() => "");
  if (bodyText !== "") {
    message += `: ${bodyText.slice(0, 200)}`;
  }
  return message;
}
