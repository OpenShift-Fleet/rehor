import { readFile } from "node:fs/promises";
import { readAuthConfig, type AuthConfig } from "./config.js";
import { httpsRequest, type HttpClient } from "./https.js";
import { isolateLifecycleLogger, type LifecycleLogger } from "./logging.js";

type Credential = { token: string; expiresAt: number };
type Dependencies = {
  http: HttpClient;
  now: () => number;
  readFile: (path: string) => Promise<Buffer>;
  env: NodeJS.ProcessEnv;
};

const serviceAccountDirectory = "/var/run/secrets/kubernetes.io/serviceaccount";
const refreshMarginMs = 60_000;
const invalidBearer = "invalid-preflight-credential";

export class PreflightError extends Error {
  constructor(readonly stage: "token-request" | "memory-endpoint") {
    super(stage === "token-request"
      ? "Agent dispatcher TokenRequest failed"
      : "Agent dispatcher memory endpoint preflight failed");
  }
}

export function preflightFailureMessage(error: unknown): string {
  if (error instanceof PreflightError && error.stage === "token-request") return "Agent dispatcher TokenRequest failed";
  if (error instanceof PreflightError && error.stage === "memory-endpoint") return "Agent dispatcher memory endpoint preflight failed";
  return "Agent dispatcher credential preflight failed";
}

function apiUrl(env: NodeJS.ProcessEnv, config: AuthConfig): URL {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443";
  if (!host || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid Kubernetes API configuration");
  // Host is supplied by Kubernetes, not an arbitrary URL or authority.
  if (!/^[a-zA-Z0-9.:-]+$/.test(host)) throw new Error("Invalid Kubernetes API configuration");
  const authority = host.includes(":") ? `[${host}]` : host;
  try {
    return new URL(`https://${authority}:${port}/api/v1/namespaces/${config.namespace}/serviceaccounts/${config.serviceAccount}/token`);
  } catch { throw new Error("Invalid Kubernetes API configuration"); }
}

async function mint(config: AuthConfig, deps: Dependencies): Promise<Credential> {
  const url = apiUrl(deps.env, config);
  const [projectedToken, ca] = await Promise.all([
    deps.readFile(`${serviceAccountDirectory}/token`),
    deps.readFile(`${serviceAccountDirectory}/ca.crt`),
  ]);
  const token = projectedToken.toString("utf8").trim();
  if (!token || !ca.length) throw new Error("Missing Kubernetes credentials");
  const spec: { expirationSeconds: number; audiences?: string[] } = { expirationSeconds: 3600 };
  if (config.audience !== undefined) spec.audiences = [config.audience];
  const response = await deps.http({
    url, method: "POST", ca,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ apiVersion: "authentication.k8s.io/v1", kind: "TokenRequest", spec }),
  });
  if (response.status < 200 || response.status >= 300) throw new Error("TokenRequest rejected");
  let status: { token?: unknown; expirationTimestamp?: unknown };
  try { status = JSON.parse(response.body).status; } catch { throw new Error("Invalid TokenRequest response"); }
  if (!status || typeof status.token !== "string" || !status.token || /\s/.test(status.token)
      || typeof status.expirationTimestamp !== "string") throw new Error("Invalid TokenRequest response");
  const expiresAt = Date.parse(status.expirationTimestamp);
  if (!Number.isFinite(expiresAt) || expiresAt <= deps.now() + refreshMarginMs) throw new Error("TokenRequest credential expires too soon");
  return { token: status.token, expiresAt };
}

async function checkMemoryEndpoint(config: AuthConfig, credential: Credential, deps: Dependencies, logger: LifecycleLogger): Promise<void> {
  // Complete both negative checks first so an open endpoint never receives the real token.
  for (const [event, bearer] of [["memory.missing_token", undefined], ["memory.invalid_token", invalidBearer]] as const) {
    const step = logger.start(event);
    try {
      const response = await deps.http({ url: config.memoryUrl, method: "GET", ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}) });
      if (response.status !== 401 && response.status !== 403) throw new Error("Endpoint did not reject missing or invalid credentials");
      step.success();
    } catch (error) {
      step.failure("internal");
      throw error;
    }
  }
  const step = logger.start("memory.token");
  try {
    if (credential.expiresAt <= deps.now() + refreshMarginMs) throw new Error("Credential expires too soon");
    const response = await deps.http({ url: config.memoryUrl, method: "GET", headers: { authorization: `Bearer ${credential.token}` } });
    if (response.status < 200 || response.status >= 300) throw new Error("Endpoint rejected credential");
    if (credential.expiresAt <= deps.now() + refreshMarginMs) throw new Error("Credential expires too soon");
    step.success();
  } catch (error) {
    step.failure("internal");
    throw error;
  }
}

/** Returns only credentials already validated against the configured memory endpoint. */
export function createCredentialProvider(config: AuthConfig, overrides: Partial<Dependencies> = {}, lifecycle?: LifecycleLogger) {
  // Validate and copy the URL before accepting injected configuration or starting work.
  const checked = readAuthConfig({
    AGENT_DISPATCHER_AUTH_NAMESPACE: config.namespace,
    AGENT_DISPATCHER_AUTH_SERVICE_ACCOUNT: config.serviceAccount,
    AGENT_DISPATCHER_AUTH_AUDIENCE: config.audience,
    AGENT_DISPATCHER_AUTH_MEMORY_URL: config.memoryUrl.toString(),
  })!;
  const deps: Dependencies = { http: httpsRequest, now: Date.now, readFile, env: process.env, ...overrides };
  const logger = isolateLifecycleLogger(lifecycle);
  let cached: Credential | undefined;
  let pending: Promise<Credential> | undefined;
  return {
    async get(): Promise<Credential> {
      if (cached && cached.expiresAt > deps.now() + refreshMarginMs) return { ...cached };
      cached = undefined;
      if (!pending) {
        pending = (async () => {
          // Never propagate HTTP, filesystem, response, or credential contents.
          let credential: Credential;
          const tokenRequest = logger.start("kubernetes.token_request");
          try { credential = await mint(checked, deps); tokenRequest.success(); }
          catch { tokenRequest.failure("internal"); throw new PreflightError("token-request"); }
          try { await checkMemoryEndpoint(checked, credential, deps, logger); }
          catch { throw new PreflightError("memory-endpoint"); }
          cached = credential;
          return credential;
        })().finally(() => { pending = undefined; });
      }
      const credential = await pending;
      if (credential.expiresAt <= deps.now() + refreshMarginMs) throw new PreflightError("memory-endpoint");
      return { ...credential };
    },
  };
}
