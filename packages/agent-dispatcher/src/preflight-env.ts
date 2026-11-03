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
