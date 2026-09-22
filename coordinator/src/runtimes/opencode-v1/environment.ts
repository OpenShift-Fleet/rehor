const ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
] as const;

export const DEFAULT_NO_PROXY_HOSTS = [
  "127.0.0.1",
  "localhost",
  "devbot-proxy",
  "proxy",
  "model-gateway",
  "memory-server",
  "jira-proxy",
  "jira-mcp",
] as const;

export interface ProxyEnvironment {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string | readonly string[];
}

export interface OpenCodeEnvironmentOptions {
  /** Sanitized runner environment. It is copied, never read by the child implicitly. */
  base?: NodeJS.ProcessEnv;
  proxy?: ProxyEnvironment;
  /** Explicitly permitted variables needed by a provider or an MCP server. */
  passthrough?: readonly string[];
  noProxyHosts?: readonly string[];
}

export type OpenCodeFetch = (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Builds the sanitized environment used by the OpenCode child.
 *
 * Proxy names are copied deliberately, including their lowercase aliases. This
 * avoids relying on a pod's ambient proxy configuration while preserving proxy
 * use for external registry/catalog traffic. Loopback and service hosts always
 * bypass the proxy.
 */
export function buildOpenCodeEnvironment(
  options: OpenCodeEnvironmentOptions = {},
): Record<string, string> {
  const base = options.base ?? process.env;
  const environment: Record<string, string> = {};

  for (const name of ENVIRONMENT_ALLOWLIST) copyIfPresent(environment, base, name);
  for (const name of options.passthrough ?? []) copyIfPresent(environment, base, name);

  const proxy = options.proxy ?? {
    httpProxy: base.HTTP_PROXY ?? base.http_proxy,
    httpsProxy: base.HTTPS_PROXY ?? base.https_proxy,
    noProxy: base.NO_PROXY ?? base.no_proxy,
  };
  setProxyAlias(environment, "HTTP_PROXY", "http_proxy", proxy.httpProxy);
  setProxyAlias(environment, "HTTPS_PROXY", "https_proxy", proxy.httpsProxy);

  const inheritedNoProxy = normalizeHosts(proxy.noProxy);
  const noProxyHosts = [
    ...DEFAULT_NO_PROXY_HOSTS,
    ...(options.noProxyHosts ?? []),
    ...inheritedNoProxy,
  ];
  const noProxy = [...new Set(noProxyHosts.filter(Boolean))].join(",");
  environment.NO_PROXY = noProxy;
  environment.no_proxy = noProxy;

  return environment;
}

function copyIfPresent(
  target: Record<string, string>,
  source: NodeJS.ProcessEnv,
  name: string,
): void {
  const value = source[name];
  if (value !== undefined) target[name] = value;
}

function setProxyAlias(
  target: Record<string, string>,
  upper: string,
  lower: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete target[upper];
    delete target[lower];
    return;
  }
  target[upper] = value;
  target[lower] = value;
}

function normalizeHosts(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return value.split(",").map((host) => host.trim());
  return [...value].map((host) => host.trim());
}

/**
 * Wraps fetch with a loopback-only contract for the OpenCode server.
 * Node's built-in fetch does not use HTTP_PROXY unless NODE_USE_ENV_PROXY is
 * enabled, so the URL check is sufficient for this local transport.
 * An injected `directFetch` is a test/transport hook.
 */
export function createOpenCodeFetch(directFetch: OpenCodeFetch = globalThis.fetch): OpenCodeFetch {
  if (process.env.NODE_USE_ENV_PROXY === "1") {
    throw new Error("OpenCode loopback fetch cannot run with NODE_USE_ENV_PROXY=1");
  }
  return async (input, init) => {
    const request = new Request(input, init);
    const hostname = new URL(request.url).hostname;
    if (!isLoopbackHostname(hostname)) {
      throw new Error(`OpenCode URL ${hostname} is not a loopback address`);
    }
    return directFetch(request);
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
