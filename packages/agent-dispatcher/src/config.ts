import type { JenkinsInstance, JenkinsInstances, SlackWebhookConfig } from "@rehor/preflights";
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

// Reject syntax that URL normalization would otherwise erase, including empty
// userinfo, query/fragment delimiters and dot-segment paths.
function strictRoute(value: string, label: string, path: "origin" | "memory" | "health"): URL {
  const shape = path === "origin"
    ? /^https:\/\/[^/?#@\\\s]+\/?$/i
    : path === "memory" ? /^https:\/\/[^/?#@\\\s]+\/mcp$/i : /^https:\/\/[^/?#@\\\s]+\/health$/i;
  if (!shape.test(value)) throw new Error(`${label} has an invalid HTTPS route`);
  if (value.slice(value.indexOf("://") + 3).split("/")[0].endsWith(":")) {
    throw new Error(`${label} has an invalid host or port`);
  }
  const url = parseHttpsUrl(value, label);
  if (!/^[a-z0-9.-]+$/.test(url.hostname) || (url.port !== "" && Number(url.port) === 0)) {
    throw new Error(`${label} has an invalid host or port`);
  }
  // The path spelling itself is exact, not case-insensitive.
  if (path === "memory" && url.pathname !== "/mcp") throw new Error(`${label} must use the exact /mcp path`);
  if (path === "health" && url.pathname !== "/health") throw new Error(`${label} must use the exact /health path`);
  return url;
}

export function readServiceGatewayUrl(env: NodeJS.ProcessEnv, auth: AuthConfig | undefined, modelProxyUrl?: URL): URL | undefined {
  const value = env.AGENT_DISPATCHER_SERVICE_GATEWAY_URL;
  if (value === undefined || value === "") return undefined;
  const url = strictRoute(value, "AGENT_DISPATCHER_SERVICE_GATEWAY_URL", "origin");
  if (!auth) throw new Error("AGENT_DISPATCHER_SERVICE_GATEWAY_URL requires auth configuration");
  if (url.hostname.length > 253 || url.hostname.split(".").some((label) => !dnsLabel.test(label) || label.length > 63)
    || url.host === auth.memoryUrl.host || url.host === modelProxyUrl?.host) {
    throw new Error("AGENT_DISPATCHER_SERVICE_GATEWAY_URL is not compatible with the sandbox policy");
  }
  return url;
}

export function readBotMemoryUrl(env: NodeJS.ProcessEnv, auth: AuthConfig | undefined): URL | undefined {
  const value = env.BOT_MEMORY_URL;
  if (value === undefined || value === "") return undefined;
  const url = strictRoute(value, "BOT_MEMORY_URL", "memory");
  if (!auth || !env.AGENT_DISPATCHER_AUTH_MEMORY_URL) {
    throw new Error("BOT_MEMORY_URL requires the configured authenticated memory health origin");
  }
  const health = strictRoute(env.AGENT_DISPATCHER_AUTH_MEMORY_URL, "AGENT_DISPATCHER_AUTH_MEMORY_URL", "health");
  if (health.href !== auth.memoryUrl.href || url.origin !== health.origin) {
    throw new Error("BOT_MEMORY_URL requires the configured authenticated memory health origin");
  }
  return url;
}

const publicEgressFlagVariable = "AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED";

// Global deployment-owned opt-in for the centrally compiled public-egress
// rule (REHOR-253). Default false keeps the sandbox policy exactly as it is
// today; this is a dispatcher-deployment rollout switch, never a per-team or
// per-instance knob. Parsing is fail-closed: only the exact strings "true"
// and "false" are accepted so a typo cannot silently disable or enable it.
export function readPublicEgressEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[publicEgressFlagVariable];
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${publicEgressFlagVariable}, when set, must be exactly "true" or "false"`);
}

const sessionLockTtlVariable = "AGENT_DISPATCHER_SESSION_LOCK_TTL_MS";

// Cluster-wide per-agent session mutex (REHOR-218): whole milliseconds for
// the memory-server lock lease acquired before each sandbox session and
// renewed at one third of the TTL while it runs. Default 30 minutes; 0
// disables the mutex entirely (single-replica behavior). The TTL bounds how
// long a hard-killed replica can block an agent. Fail-closed: only plain
// decimal milliseconds are accepted so a typo cannot silently disable or
// extend the lease.
export function readSessionLockTtlMs(env: NodeJS.ProcessEnv): number {
  const value = env[sessionLockTtlVariable];
  if (value === undefined) return 30 * 60_000;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${sessionLockTtlVariable}, when set, must be a whole number of milliseconds between 0 and 86400000`);
  }
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 86_400_000) {
    throw new Error(`${sessionLockTtlVariable}, when set, must be a whole number of milliseconds between 0 and 86400000`);
  }
  return milliseconds;
}

const sandboxRetentionVariable = "AGENT_DISPATCHER_SANDBOX_RETENTION";

// Debug aid (REHOR-245): whole seconds to keep a finished session's gateway
// resources before cleanup so failed sandboxes can be inspected. Default 0
// preserves immediate cleanup; the ceiling bounds how long a session can hold
// the dispatcher loop. Fail-closed: only plain decimal seconds are accepted so
// a typo cannot silently disable or extend the hold.
export function readSandboxRetentionMs(env: NodeJS.ProcessEnv): number {
  const value = env[sandboxRetentionVariable];
  if (value === undefined) return 0;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${sandboxRetentionVariable}, when set, must be a whole number of seconds between 0 and 86400`);
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds > 86_400) {
    throw new Error(`${sandboxRetentionVariable}, when set, must be a whole number of seconds between 0 and 86400`);
  }
  return seconds * 1000;
}

const preflightStateDirVariable = "AGENT_DISPATCHER_PREFLIGHT_STATE_DIR";

// Writable directory holding one JSON state file per agent instance — the
// cross-run preflight bookkeeping (throttle timestamps, weekly markers).
// Deployment-owned; absent wiring leaves the self-throttling preflights
// unwired (they fail closed with an execution error). Fail-closed parsing:
// only a non-empty string is accepted.
export function readPreflightStateDir(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[preflightStateDirVariable];
  if (value === undefined) return undefined;
  if (value.trim() === "") {
    throw new Error(`${preflightStateDirVariable}, when set, must be a non-empty directory path`);
  }
  return value;
}

const slackWebhooksVariable = "AGENT_DISPATCHER_SLACK_WEBHOOKS";

// Slack webhook channels for preflights that report without an AI session.
// Secret-rendered deployment configuration (values are credentials and are
// never logged or exposed to preflight results): a flat JSON object mapping
// channel names to webhook URLs, with the reserved key "default" backing
// plain sends and every other key naming an override channel. Absent wiring
// degrades those reports — the Python "Slack skipped (no webhook)" path.
// Fail-closed parsing: only string values are accepted so a malformed
// render cannot half-configure notifications.
export function readSlackWebhooks(env: NodeJS.ProcessEnv): SlackWebhookConfig | undefined {
  const value = env[slackWebhooksVariable];
  if (value === undefined || value.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${slackWebhooksVariable}, when set, must be a JSON object of channel names to webhook URLs`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${slackWebhooksVariable}, when set, must be a JSON object of channel names to webhook URLs`);
  }
  const channels: Record<string, string> = {};
  let defaults: string | undefined;
  for (const [channel, webhook] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof webhook !== "string" || webhook.trim() === "") {
      throw new Error(`${slackWebhooksVariable}: channel "${channel}" must be a non-empty webhook URL string`);
    }
    if (channel === "default") defaults = webhook;
    else channels[channel] = webhook;
  }
  return {
    ...(defaults === undefined ? {} : { default: defaults }),
    channels,
  };
}

const jenkinsInstancesVariable = "AGENT_DISPATCHER_JENKINS_INSTANCES";

// Jenkins instance endpoints for the watchduty preflights, rendered from
// deployment configuration (secret rendering): a JSON object with "qe" and
// "idp" entries, each `{ "url": "...", "prefix": "..." }`. The corporate
// Jenkins hosts serve self-signed certificates and need no credentials;
// the endpoints themselves are deployment config, never engine constants.
// Absent wiring leaves the watchduty preflights unwired (fail closed).
export function readJenkinsInstances(env: NodeJS.ProcessEnv): JenkinsInstances | undefined {
  const value = env[jenkinsInstancesVariable];
  if (value === undefined || value.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${jenkinsInstancesVariable}, when set, must be a JSON object with "qe" and "idp" instances`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${jenkinsInstancesVariable}, when set, must be a JSON object with "qe" and "idp" instances`);
  }
  const record = parsed as Record<string, unknown>;
  const instances: Partial<Record<"qe" | "idp", JenkinsInstance>> = {};
  for (const name of ["qe", "idp"] as const) {
    const instance = record[name];
    if (typeof instance !== "object" || instance === null) {
      throw new Error(`${jenkinsInstancesVariable}: instance "${name}" must be an object with "url" and "prefix"`);
    }
    const { url, prefix } = instance as Record<string, unknown>;
    if (typeof url !== "string" || !/^https:\/\//.test(url)) {
      throw new Error(`${jenkinsInstancesVariable}: instance "${name}" url must be an https URL`);
    }
    if (typeof prefix !== "string") {
      throw new Error(`${jenkinsInstancesVariable}: instance "${name}" prefix must be a string (may be empty)`);
    }
    instances[name] = { url: url.replace(/\/+$/, ""), prefix };
  }
  return { qe: instances.qe!, idp: instances.idp! };
}

const jenkinsIdpJobsVariable = "AGENT_DISPATCHER_JENKINS_IDP_JOBS";

// Job names the "idp" Jenkins instance serves (every other job routes to
// "qe"). Optional override of the ported Python default set; fail-closed
// parsing accepts only an array of non-empty strings.
export function readJenkinsIdpJobs(env: NodeJS.ProcessEnv): readonly string[] | undefined {
  const value = env[jenkinsIdpJobsVariable];
  if (value === undefined || value.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${jenkinsIdpJobsVariable}, when set, must be a JSON array of job names`);
  }
  if (!Array.isArray(parsed) || parsed.some((job) => typeof job !== "string" || job.trim() === "")) {
    throw new Error(`${jenkinsIdpJobsVariable}, when set, must be a JSON array of job names`);
  }
  return parsed as readonly string[];
}
