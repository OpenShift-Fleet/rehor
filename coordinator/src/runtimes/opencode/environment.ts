export const OPENCODE_MCP_URL_ENVIRONMENT = "JIRA_MCP_URL" as const;
export const OPENCODE_VERTEX_PROXY_URL_ENVIRONMENT = "REHOR_VERTEX_PROXY_URL" as const;

export const OPENCODE_BLOCKED_PASSTHROUGH = [
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "GPG_PRIVATE_KEY_B64",
  "GPG_SIGNING_KEY",
  "JIRA_API_TOKEN",
  "JIRA_MCP_TOKEN",
  // Legacy direct Jira auth identity; BOT_JIRA_EMAIL is only a bot identity.
  "JIRA_USERNAME",
  "OPENAI_API_KEY",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
  "OPENCODE_TEST_HOME",
  "SSO_PASSWORD",
  "SSO_USERNAME",
] as const;
export const OPENCODE_BLOCKED_PASSTHROUGH_PREFIXES = [
  "OPENCODE_",
  "NPM_CONFIG_",
  "npm_config_",
] as const;

/** Additional provider/plugin variables permitted to pass through when referenced. */
export const OPENCODE_PROVIDER_ENVIRONMENT_ALLOWLIST = [
  "REHOR_MODEL_PROXY_TOKEN",
  "REHOR_MODEL_PROXY_URL",
  OPENCODE_VERTEX_PROXY_URL_ENVIRONMENT,
] as const;

export const OPENCODE_ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "GIT_CONFIG_GLOBAL",
  OPENCODE_MCP_URL_ENVIRONMENT,
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

/**
 * Trusted operational values copied automatically when present, exactly
 * like the baseline allowlist: service coordinates, bot/fork identities, board
 * and config selection, and notification settings. SLACK_WEBHOOK_URL is an
 * intentional configured-credential exception preserving the existing
 * agent -> helper -> MCP webhook payload contract. They never require passthrough
 * opt-in, and absent values stay absent. This is an exact-name allowlist;
 * it does not widen the provider allowlist or admit prefix matches.
 */
export const OPENCODE_OPERATIONAL_ENVIRONMENT_ALLOWLIST = [
  "BOT_BOARD_ID",
  "BOT_BOARD_NAME",
  "BOT_CONFIG_PATH",
  "BOT_INSTANCE_ID",
  "BOT_JIRA_EMAIL",
  "BOT_MEMORY_URL",
  "EXECUTOR_ADDR",
  "GH_RELEASE_UPLOAD_URL",
  "GH_USER_NAME",
  "GL_USER_NAME",
  "SLACK_NOTIFY_MODE",
  "SLACK_WEBHOOK_URL",
] as const;

const BLOCKED_PASSTHROUGH: ReadonlySet<string> = new Set(OPENCODE_BLOCKED_PASSTHROUGH);
const BLOCKED_PASSTHROUGH_PREFIXES = OPENCODE_BLOCKED_PASSTHROUGH_PREFIXES;
const ENVIRONMENT_ALLOWLIST = OPENCODE_ENVIRONMENT_ALLOWLIST;
const OPERATIONAL_ENVIRONMENT_ALLOWLIST = OPENCODE_OPERATIONAL_ENVIRONMENT_ALLOWLIST;
const PROVIDER_ENVIRONMENT_ALLOWLIST: ReadonlySet<string> = new Set(
  OPENCODE_PROVIDER_ENVIRONMENT_ALLOWLIST,
);

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
  /** Explicitly permitted variables needed by trusted provider configuration. */
  passthrough?: readonly string[];
  noProxyHosts?: readonly string[];
  /** Per-cycle OpenCode global config directory. Ambient user config is excluded. */
  configDirectory?: string;
  /** Per-cycle OpenCode database/state path. */
  databasePath?: string;
}

/** Resolve the existing Vertex auth proxy, keeping Google credentials off the agent. */
export function resolveVertexProxyUrl(environment: NodeJS.ProcessEnv): string {
  const explicit =
    environment[OPENCODE_VERTEX_PROXY_URL_ENVIRONMENT]?.trim() ||
    environment.ANTHROPIC_VERTEX_BASE_URL?.trim();
  if (explicit) return explicit;

  const host = environment.PROXY_HOST?.trim() || environment.PROXY_NAME?.trim() || "devbot-proxy";
  return /^https?:\/\//i.test(host) ? host : `http://${host}:8443`;
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
  for (const name of OPERATIONAL_ENVIRONMENT_ALLOWLIST) copyIfPresent(environment, base, name);
  for (const name of options.passthrough ?? []) {
    if (
      PROVIDER_ENVIRONMENT_ALLOWLIST.has(name) &&
      !BLOCKED_PASSTHROUGH.has(name) &&
      !BLOCKED_PASSTHROUGH_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      if (name === OPENCODE_VERTEX_PROXY_URL_ENVIRONMENT) {
        environment[name] = resolveVertexProxyUrl(base);
      } else {
        copyIfPresent(environment, base, name);
      }
    }
  }

  const proxy = options.proxy ?? {
    httpProxy: base.HTTP_PROXY ?? base.http_proxy,
    httpsProxy: base.HTTPS_PROXY ?? base.https_proxy,
    noProxy: base.NO_PROXY ?? base.no_proxy,
  };
  setProxyAlias(environment, "HTTP_PROXY", "http_proxy", proxy.httpProxy);
  setProxyAlias(environment, "HTTPS_PROXY", "https_proxy", proxy.httpsProxy);

  const inheritedNoProxy = normalizeHosts(proxy.noProxy);
  const vertexProxyHost = (options.passthrough ?? []).includes(
    OPENCODE_VERTEX_PROXY_URL_ENVIRONMENT,
  )
    ? getHostname(resolveVertexProxyUrl(base))
    : undefined;
  const noProxyHosts = [
    ...DEFAULT_NO_PROXY_HOSTS,
    ...(options.noProxyHosts ?? []),
    ...inheritedNoProxy,
    ...(vertexProxyHost === undefined ? [] : [vertexProxyHost]),
  ];
  const noProxy = [...new Set(noProxyHosts.filter(Boolean))].join(",");
  environment.NO_PROXY = noProxy;
  environment.no_proxy = noProxy;
  if (options.configDirectory !== undefined) {
    environment.OPENCODE_CONFIG_DIR = options.configDirectory;
  }
  if (options.databasePath !== undefined) environment.OPENCODE_DB = options.databasePath;

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

function getHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
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
