export type AuthConfig = {
  namespace: string;
  serviceAccount: string;
  audience?: string;
  memoryUrl: URL;
};

const prefix = "AGENT_DISPATCHER_AUTH_";
const names = ["NAMESPACE", "SERVICE_ACCOUNT", "AUDIENCE", "MEMORY_URL"];

function endpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid preflight endpoint"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Preflight endpoints must be HTTPS without userinfo, query, or fragment");
  }
  return url;
}

export function readAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | undefined {
  const keys = Object.keys(env).filter((key) => key.startsWith(prefix));
  if (!keys.length) return undefined;
  if (keys.some((key) => !names.includes(key.slice(prefix.length)))) throw new Error("Unknown auth configuration");
  const namespace = env[`${prefix}NAMESPACE`];
  const serviceAccount = env[`${prefix}SERVICE_ACCOUNT`];
  const memory = env[`${prefix}MEMORY_URL`];
  const audience = env[`${prefix}AUDIENCE`];
  const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
  if (!namespace || namespace.length > 63 || !dnsLabel.test(namespace)
      || !serviceAccount || serviceAccount.length > 253
      || !serviceAccount.split(".").every((part) => part.length <= 63 && dnsLabel.test(part))
      || !memory || (audience !== undefined && !audience.trim())) {
    throw new Error("Incomplete or invalid auth configuration");
  }
  return { namespace, serviceAccount, audience, memoryUrl: endpoint(memory) };
}
