/** Deployment owns the memory route; profile variables cannot redirect it. */
export function mergeProfileEnvironment(base: NodeJS.ProcessEnv, profile: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const merged = { ...base, ...profile };
  if (base.BOT_MEMORY_URL === undefined) delete merged.BOT_MEMORY_URL;
  else merged.BOT_MEMORY_URL = base.BOT_MEMORY_URL;
  return merged;
}

/** Gateway endpoints apply only to sandbox execution, never host preflights. */
export function sandboxEnvironment(base: NodeJS.ProcessEnv, profile: NodeJS.ProcessEnv | undefined, serviceGatewayUrl?: URL, modelProxyUrl?: URL): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(mergeProfileEnvironment(base, profile))) {
    if (name !== "PATH" && value !== undefined) environment[name] = value;
  }
  if (modelProxyUrl) environment.REHOR_MODEL_PROXY_URL = modelProxyUrl.href;
  if (serviceGatewayUrl) {
    environment.JIRA_MCP_URL = `${serviceGatewayUrl.origin}/jira/mcp`;
    environment.EXECUTOR_HTTP_URL = `${serviceGatewayUrl.origin}/executor/execute`;
  }
  return environment;
}
