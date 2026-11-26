export const OPENCODE_MCP_URL_ENVIRONMENT = "JIRA_MCP_URL" as const;
export const OPENCODE_VERTEX_PROXY_URL_ENVIRONMENT = "REHOR_VERTEX_PROXY_URL" as const;

export const OPENCODE_BLOCKED_PASSTHROUGH = [
  "ANTHROPIC_API_KEY",
  "EXECUTOR_CA_FILE",
  "EXECUTOR_TOKEN_FILE",
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
 *
 * Agent-specific settings do NOT belong here: they travel through the
 * declared/declaredSandbox options above, driven by the selected agent's
 * own configuration, so this list stays limited to platform-shared
 * operational names.
 *
 * EXECUTOR_HTTP_URL and EXECUTOR_TRANSPORT are nonsecret thin-client HTTP
 * coordinates (explicit gateway endpoint and transport selection). The
 * EXECUTOR_TOKEN sandbox placeholder is handled separately below: it is
 * copied only in sandbox mode and only when it is the exact nonsecret
 * openshell:resolve:env marker, never a real credential. EXECUTOR_TOKEN_FILE
 * and EXECUTOR_CA_FILE are never forwarded.
 */
export const OPENCODE_OPERATIONAL_ENVIRONMENT_ALLOWLIST = [
  "BOT_BOARD_ID",
  "BOT_BOARD_NAME",
  "BOT_CONFIG_PATH",
  "BOT_INSTANCE_ID",
  "BOT_JIRA_EMAIL",
  "BOT_MEMORY_URL",
  "EXECUTOR_ADDR",
  "EXECUTOR_HTTP_URL",
  "EXECUTOR_TRANSPORT",
  "GH_RELEASE_UPLOAD_URL",
  "GH_USER_NAME",
  "GL_USER_NAME",
  "SLACK_NOTIFY_MODE",
  "SLACK_WEBHOOK_URL",
] as const;

/**
 * Names the selected agent's configuration declares for the OpenCode child.
 * The list carries names only — never values — from the authoritative
 * selected profile and environment/workflow manifests (the Python bridge
 * collects them per cycle). Values are read exclusively from the sanitized
 * runner environment, so agent-specific settings travel without hardcoding
 * any per-agent name here and without copying undeclared deployment ambient
 * values merely because they exist.
 *
 * Two provenance classes exist:
 *
 * - `declared`: workflow/env-preset manifest `requires.env_vars` /
 *   `optional_env_vars` plus the profile's `env` (or legacy `preflight.env`)
 *   category. These names describe settings whose values normally come from
 *   deployment ambient or profile configuration, so secret-looking names are
 *   rejected exactly like the dispatcher's forwarded-variable policy.
 * - `declaredSandbox`: the profile's explicit `sandbox.env` declarations.
 *   These are the dispatcher's tier-2 secret delivery channel: values are
 *   rendered from Kubernetes Secrets (or literal config values) and merged
 *   into the sandbox runner environment by the dispatcher only. They are
 *   forwarded only in sandbox mode, where the value's provenance is the
 *   trusted render, and secret-looking names are allowed because that is
 *   the channel's purpose.
 * - `declaredLiterals`: validated nonsecret literal values from the
 *   profile's `env`/`preflight.env` category, applied as a fallback when a
 *   declared name is absent from the runner environment so legacy host
 *   deployments (no dispatcher profile merge) still deliver config-specified
 *   values. Deployment-provided values always win; sandbox secret
 *   references never appear here.
 *
 * All classes are additionally subject to the protected platform name
 * policy below: deployment credentials, runtime/loader/security controls,
 * and reserved namespaces never pass, regardless of declaration. A declared
 * name that can never be forwarded fails closed instead of being quietly
 * omitted.
 */

/**
 * Platform runtime, loader, and security controls never forwarded from
 * declarations. These are generic categories, not per-agent lists:
 *
 * - Interpreter/loader injection: NODE_PATH, PYTHONPATH/PYTHONHOME/
 *   PYTHONSTARTUP, PERL5OPT, RUBYOPT, BASH_ENV/ENV, and the listed LD_ and
 *   DYLD_ loader variables change how the server and its tooling execute.
 * - Git execution and credential interception: GIT_SSH_COMMAND, GIT_ASKPASS,
 *   and the GIT_CONFIG_COUNT/KEY/VALUE mechanism would redirect git
 *   transport or credential prompts away from the runner-owned
 *   GIT_CONFIG_GLOBAL setup.
 * - Proxy rerouting: ALL_PROXY/all_proxy bypass the runner-owned, normalized
 *   HTTP_PROXY/HTTPS_PROXY/NO_PROXY aliases.
 * - Interception CA paths: NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, SSL_CERT_DIR,
 *   CURL_CA_BUNDLE, REQUESTS_CA_BUNDLE, GIT_SSL_CAINFO follow the
 *   sandbox-only OpenShell contract above.
 * - Runtime/loader control: NODE_OPTIONS and NODE_USE_ENV_PROXY change how
 *   the server process itself executes.
 *
 * Ordinary agent configuration names are unaffected: any non-protected name
 * declared by the selected agent's manifests or profile forwards when
 * present, and explicitly declared tier-2 sandbox values (including
 * secret-looking custom names) still flow through declaredSandbox.
 */
const DECLARED_PROTECTED_NAMES: ReadonlySet<string> = new Set([
  ...OPENCODE_BLOCKED_PASSTHROUGH,
  // The EXECUTOR_TOKEN sandbox placeholder contract below is the only path;
  // a declared raw value must never override it.
  "EXECUTOR_TOKEN",
  // Interpreter and loader injection.
  "NODE_OPTIONS",
  "NODE_USE_ENV_PROXY",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PERL5OPT",
  "RUBYOPT",
  "BASH_ENV",
  "ENV",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  // Git execution and credential interception.
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_CONFIG_COUNT",
  // Proxy rerouting outside the runner-owned normalized aliases.
  "ALL_PROXY",
  "all_proxy",
  // Interception CA paths follow the sandbox-only OpenShell contract above.
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
]);
const DECLARED_PROTECTED_PREFIXES = [
  ...OPENCODE_BLOCKED_PASSTHROUGH_PREFIXES,
  "REHOR_",
  "rehor_",
  "GIT_CONFIG_KEY_",
  "GIT_CONFIG_VALUE_",
] as const;
const DECLARED_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Mirrors the dispatcher's forwarded-variable secret heuristic. */
const DECLARED_SECRET_PATTERN = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)/;

function isDeclaredProtectedName(name: string): boolean {
  return (
    DECLARED_PROTECTED_NAMES.has(name) ||
    DECLARED_PROTECTED_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * A declared name that can never be forwarded is an explicit incompatibility,
 * not a quiet omission: fail closed with the name (never a value) so the
 * configuration error surfaces instead of silently diverging.
 */
function assertForwardableDeclaration(source: string, name: string): void {
  if (!DECLARED_NAME_PATTERN.test(name)) {
    throw new Error(
      `${source} declares '${name}', which is not a valid environment variable name`,
    );
  }
  if (isDeclaredProtectedName(name)) {
    throw new Error(
      `${source} declares '${name}', a protected platform runtime, loader, or security control that is never forwarded to the OpenCode child`,
    );
  }
}

const BLOCKED_PASSTHROUGH: ReadonlySet<string> = new Set(OPENCODE_BLOCKED_PASSTHROUGH);
const BLOCKED_PASSTHROUGH_PREFIXES = OPENCODE_BLOCKED_PASSTHROUGH_PREFIXES;
const ENVIRONMENT_ALLOWLIST = OPENCODE_ENVIRONMENT_ALLOWLIST;
const OPERATIONAL_ENVIRONMENT_ALLOWLIST = OPENCODE_OPERATIONAL_ENVIRONMENT_ALLOWLIST;
const PROVIDER_ENVIRONMENT_ALLOWLIST: ReadonlySet<string> = new Set(
  OPENCODE_PROVIDER_ENVIRONMENT_ALLOWLIST,
);
/** OpenShell supplies public interception CA paths for sandbox HTTPS traffic. */
const OPENSHELL_CA_ENVIRONMENT = [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
] as const;

/**
 * Exact nonsecret placeholder accepted for the thin client's EXECUTOR_TOKEN,
 * mirroring the coordinator's MCP render marker. Anything else — notably a
 * raw bearer or JWT — is dropped, never forwarded.
 */
const EXECUTOR_TOKEN_PLACEHOLDER_PATTERN = /^openshell:resolve:env:[A-Za-z0-9_]+(?![\s\S])/;

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
  /**
   * Manifest/profile-declared variable names (provenance: workflow and env
   * preset manifests plus the profile `env` category). Names only; values are
   * read from `base`. Secret-looking names are rejected.
   */
  declared?: readonly string[];
  /**
   * Profile `sandbox.env` declarations (dispatcher tier-2 render channel).
   * Names only; values are read from `base` and forwarded only in sandbox
   * mode. Secret-looking names are allowed because the channel exists for
   * explicitly authorized secret delivery.
   */
  declaredSandbox?: readonly string[];
  /**
   * Validated nonsecret literal values from the selected profile's `env`
   * (or legacy `preflight.env`) category. Applied as a fallback only when a
   * declared name is absent from the runner environment, so legacy host
   * deployments without the dispatcher's profile merge still deliver
   * config-specified values. Deployment-provided values always win;
   * sandbox secret references never appear here.
   */
  declaredLiterals?: Readonly<Record<string, string>>;
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
  if (base.REHOR_INPUT_SOURCE === "sandbox") {
    environment.REHOR_INPUT_SOURCE = "sandbox";
    for (const name of OPENSHELL_CA_ENVIRONMENT) copyIfPresent(environment, base, name);
    // The sandbox thin client may carry only the nonsecret EXECUTOR_TOKEN
    // placeholder, either set explicitly or derived from the existing
    // BOT_MEMORY_TOKEN placeholder. Real tokens never reach the agent; the
    // public-route TLS root is already trusted, so no custom CA is needed.
    const executorToken = base.EXECUTOR_TOKEN ?? base.BOT_MEMORY_TOKEN;
    if (
      executorToken !== undefined &&
      EXECUTOR_TOKEN_PLACEHOLDER_PATTERN.test(executorToken) &&
      isValidHttpsRoute(base.EXECUTOR_HTTP_URL)
    ) {
      environment.EXECUTOR_TOKEN = executorToken;
    }
  }
  for (const name of options.declared ?? []) {
    assertForwardableDeclaration("manifest or profile environment", name);
    // Manifest/profile declarations describe ordinary settings; secret-looking
    // names stay out so an ambient credential cannot ride a declaration. The
    // same name may still flow through declaredSandbox below.
    if (!DECLARED_SECRET_PATTERN.test(name)) copyIfPresent(environment, base, name);
  }
  // Validation is mode-independent: an incompatible declaration is a config
  // error even when the sandbox render path is not active this cycle.
  for (const name of options.declaredSandbox ?? []) {
    assertForwardableDeclaration("sandbox environment", name);
  }
  if (base.REHOR_INPUT_SOURCE === "sandbox") {
    for (const name of options.declaredSandbox ?? []) {
      // Explicit sandbox.env declarations are the authorized tier-2 channel;
      // in sandbox mode the value's provenance is the dispatcher's render.
      // Secret-looking names are permitted; protected platform names are not.
      copyIfPresent(environment, base, name);
    }
  }
  for (const [name, value] of Object.entries(options.declaredLiterals ?? {})) {
    assertForwardableDeclaration("profile environment literals", name);
    // Fallback only: a value already in the runner environment (deployment
    // ambient or the dispatcher's profile merge) always wins.
    if (environment[name] === undefined) environment[name] = value;
  }
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

function isValidHttpsRoute(value: string | undefined): boolean {
  if (
    !value ||
    /[\s\\?#]/.test(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127,
    ) ||
    !/^https:\/\/[^/@]+\/executor\/execute$/i.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
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
