/**
 * Names permitted in a preflight environment. Values are never validated
 * here: callers decide whether a name is forwarded (process environment) or
 * accepted (instance configuration).
 */
export function isForwardedPreflightVariable(name: string): boolean {
  return name === "PATH"
    || name === "JIRA_MCP_URL"
    || name === "EXECUTOR_ADDR"
    || /^(?:HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)$/.test(name)
    || (/^BOT_[A-Z0-9_]+$/.test(name) && !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)/.test(name));
}

/**
 * Names an instance configuration may set. Deliberately narrower than the
 * forwarded set: configuration repositories are trusted, but an instance
 * must not silently redirect operational traffic (PATH, proxies, MCP and
 * executor endpoints) that the dispatcher forwards from its own environment.
 */
export function isInstancePreflightVariable(name: string): boolean {
  return /^BOT_[A-Z0-9_]+$/.test(name) && !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)/.test(name);
}
