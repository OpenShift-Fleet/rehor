import { parseHttpsUrl } from "./url.js";

export type AuthConfig = {
  namespace: string;
  serviceAccount: string;
  audience?: string;
  memoryUrl: URL;
};

const prefix = "AGENT_DISPATCHER_AUTH_";
const names = ["NAMESPACE", "SERVICE_ACCOUNT", "AUDIENCE", "MEMORY_URL"];

// A DNS label: 1-63 characters of lowercase letters, digits, or hyphens,
// where the first and last character must be alphanumeric (no leading or
// trailing hyphen). Kubernetes requires this shape for namespaces and for
// each dot-separated segment of a service account name.
const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

export function readAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | undefined {
  // Auth is opt-in: with no AGENT_DISPATCHER_AUTH_* variables the dispatcher
  // runs without the memory preflight. But once any variable is set, the
  // configuration must be complete and valid — no partial or typo'd setup.
  const keys = Object.keys(env).filter((key) => key.startsWith(prefix));
  if (!keys.length) return undefined;
  const unknown = keys.find((key) => !names.includes(key.slice(prefix.length)));
  if (unknown) throw new Error(`${unknown} is not a recognized auth configuration variable`);

  const namespace = env[`${prefix}NAMESPACE`];
  const serviceAccount = env[`${prefix}SERVICE_ACCOUNT`];
  const memory = env[`${prefix}MEMORY_URL`];
  const audience = env[`${prefix}AUDIENCE`];

  if (!namespace) throw new Error(`${prefix}NAMESPACE is required when auth is configured`);
  if (namespace.length > 63 || !dnsLabel.test(namespace)) {
    throw new Error(`${prefix}NAMESPACE must be a DNS label: 1-63 lowercase alphanumeric characters or hyphens, no leading or trailing hyphen`);
  }
  if (!serviceAccount) throw new Error(`${prefix}SERVICE_ACCOUNT is required when auth is configured`);
  if (serviceAccount.length > 253
      || !serviceAccount.split(".").every((part) => part.length <= 63 && dnsLabel.test(part))) {
    throw new Error(`${prefix}SERVICE_ACCOUNT must be a DNS name: dot-separated DNS labels, at most 253 characters`);
  }
  if (!memory) throw new Error(`${prefix}MEMORY_URL is required when auth is configured`);
  if (audience !== undefined && !audience.trim()) {
    throw new Error(`${prefix}AUDIENCE, when set, must be a non-empty string`);
  }
  return { namespace, serviceAccount, audience, memoryUrl: parseHttpsUrl(memory, `${prefix}MEMORY_URL`) };
}

const modelProxyUrlVariable = "AGENT_DISPATCHER_MODEL_PROXY_URL";

// Optional model-gateway Route (REHOR-237), standalone rather than part of
// the auth group above: unset keeps the sandbox policy memory-only, while a
// set value must be the exact HTTPS /v1 endpoint the model-proxy rule admits.
export function readModelProxyUrl(env: NodeJS.ProcessEnv): URL | undefined {
  const value = env[modelProxyUrlVariable];
  if (value === undefined) return undefined;
  if (!value.trim()) throw new Error(`${modelProxyUrlVariable}, when set, must be a non-empty string`);
  const url = parseHttpsUrl(value, modelProxyUrlVariable);
  if (url.pathname !== "/v1") throw new Error(`${modelProxyUrlVariable} must point at the exact /v1 path`);
  // WHATWG URL leaves search/hash empty for a trailing delimiter while href
  // keeps it; the coordinator rejects those, so startup must too (fail closed
  // at configuration instead of failing a sandbox after it exists).
  if (/[?#]$/.test(url.href)) {
    throw new Error(`${modelProxyUrlVariable} must not end with an empty query or fragment delimiter`);
  }
  if (!/^[a-z0-9.-]+$/.test(url.hostname)) {
    throw new Error(`${modelProxyUrlVariable} hostname must be lowercase letters, digits, dots, or hyphens`);
  }
  const port = Number(url.port);
  if (url.port !== "" && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`${modelProxyUrlVariable} port must be an integer between 1 and 65535`);
  }
  return url;
}
