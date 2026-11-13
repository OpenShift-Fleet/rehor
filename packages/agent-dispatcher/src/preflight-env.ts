/**
 * Names permitted in the preflight environment. Values are never validated
 * here: callers decide whether a name is forwarded (process environment) or
 * accepted (instance configuration).
 *
 * The preflight engine receives its wiring explicitly. Forwarded variables
 * provide sandbox runtime settings, endpoints, git identity, and proxies;
 * secret-bearing `BOT_*` names are excluded.
 */
export function isForwardedPreflightVariable(name: string): boolean {
  return name === "JIRA_MCP_URL"
    || name === "EXECUTOR_ADDR"
    || /^(?:GH_USER_NAME|GH_USER_EMAIL|GL_USER_NAME|GL_USER_EMAIL)$/.test(name)
    || /^(?:HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)$/.test(name)
    || (/^BOT_[A-Z0-9_]+$/.test(name) && !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)/.test(name));
}

/**
 * Names an instance configuration may set. Deliberately narrower than the
 * forwarded set: configuration repositories are trusted, but an instance
 * must not silently redirect operational traffic (proxies, MCP and executor
 * endpoints) that the dispatcher forwards from its own environment.
 */
export function isInstancePreflightVariable(name: string): boolean {
  return /^BOT_[A-Z0-9_]+$/.test(name) && !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)/.test(name);
}

// Runtime-owned names inside the sandbox (mirroring the coordinator's
// baseline environment allowlist) plus the dispatcher-controlled REHOR_ and
// OPENCODE_ namespaces.
const sandboxDeniedNames = /^(?:PATH|HOME|USER|SHELL|LANG|LC_[A-Z_]+|NO_COLOR|TMPDIR|GIT_CONFIG_GLOBAL|XDG_(?:CACHE|CONFIG|DATA|STATE)_HOME)$/;

/**
 * Names an instance configuration may set in `sandbox.env`. Rejects
 * runtime-owned names, the REHOR_ and OPENCODE_ namespaces, and values the
 * dispatcher forwards itself; non-secret BOT_ settings belong in the profile
 * `env` category.
 */
export function isSandboxEnvironmentVariable(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name)
    && !sandboxDeniedNames.test(name)
    && !name.startsWith("REHOR_")
    && !name.startsWith("OPENCODE_")
    && !isForwardedPreflightVariable(name);
}
