import { readFile } from "node:fs/promises";
import type { AuthConfig } from "./config.js";
import { HttpRequestError, httpsRequest, type HttpClient } from "./https.js";
import { isolateLifecycleLogger, type ErrorCategory, type LifecycleLogger } from "./logging.js";

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
  return error instanceof PreflightError ? error.message : "Agent dispatcher credential preflight failed";
}

// Preflight failures are categorized so startup problems are diagnosable from
// lifecycle logs. The category is fixed at the throw site; message content and
// underlying errors never leave the preflight.
class CategorizedError extends Error {
  constructor(message: string, readonly category: ErrorCategory) {
    super(message);
  }
}

function failureCategory(error: unknown): ErrorCategory {
  if (error instanceof HttpRequestError) return "network";
  if (error instanceof CategorizedError) return error.category;
  return "internal";
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

async function readProjectedCredentials(deps: Dependencies): Promise<{ token: string; ca: Buffer }> {
  let files: [Buffer, Buffer];
  try {
    files = await Promise.all([
      deps.readFile(`${serviceAccountDirectory}/token`),
      deps.readFile(`${serviceAccountDirectory}/ca.crt`),
    ]);
  } catch {
    throw new CategorizedError("Missing Kubernetes credentials", "credentials");
  }
  const token = files[0].toString("utf8").trim();
  if (!token || !files[1].length) throw new CategorizedError("Missing Kubernetes credentials", "credentials");
  return { token, ca: files[1] };
}

async function mint(config: AuthConfig, deps: Dependencies): Promise<Credential> {
  const url = apiUrl(deps.env, config);
  const projected = await readProjectedCredentials(deps);
  const spec: { expirationSeconds: number; audiences?: string[] } = { expirationSeconds: 3600 };
  if (config.audience !== undefined) spec.audiences = [config.audience];
  const response = await deps.http({
    url, method: "POST", ca: projected.ca,
    headers: { authorization: `Bearer ${projected.token}`, "content-type": "application/json" },
    body: JSON.stringify({ apiVersion: "authentication.k8s.io/v1", kind: "TokenRequest", spec }),
  });
  if (response.status < 200 || response.status >= 300) throw new CategorizedError("TokenRequest rejected", "authorization");
  let status: { token?: unknown; expirationTimestamp?: unknown };
  try { status = JSON.parse(response.body).status; } catch { throw new CategorizedError("Invalid TokenRequest response", "response"); }
  if (!status || typeof status.token !== "string" || !status.token || /\s/.test(status.token)
      || typeof status.expirationTimestamp !== "string") throw new CategorizedError("Invalid TokenRequest response", "response");
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
      if (response.status !== 401 && response.status !== 403) throw new CategorizedError("Endpoint did not reject missing or invalid credentials", "authorization");
      step.success();
    } catch (error) {
      step.failure(failureCategory(error));
      throw error;
    }
  }
  const step = logger.start("memory.token");
  try {
    const response = await deps.http({ url: config.memoryUrl, method: "GET", headers: { authorization: `Bearer ${credential.token}` } });
    if (response.status < 200 || response.status >= 300) throw new CategorizedError("Endpoint rejected credential", "authentication");
    step.success();
  } catch (error) {
    step.failure(failureCategory(error));
    throw error;
  }
}

/** Mints a credential and checks it against the configured memory endpoint. Startup only. */
export function createCredentialProvider(config: AuthConfig, overrides: Partial<Dependencies> = {}, lifecycle?: LifecycleLogger) {
  // `config` comes from readAuthConfig; copy the URL so callers cannot mutate it afterwards.
  const checked = { ...config, memoryUrl: new URL(config.memoryUrl) };
  const deps: Dependencies = { http: httpsRequest, now: Date.now, readFile, env: process.env, ...overrides };
  const logger = isolateLifecycleLogger(lifecycle);
  return {
    async get(): Promise<Credential> {
      // Never propagate HTTP, filesystem, response, or credential contents.
      let credential: Credential;
      const tokenRequest = logger.start("kubernetes.token_request");
      try { credential = await mint(checked, deps); tokenRequest.success(); }
      catch (error) { tokenRequest.failure(failureCategory(error)); throw new PreflightError("token-request"); }
      try { await checkMemoryEndpoint(checked, credential, deps, logger); }
      catch { throw new PreflightError("memory-endpoint"); }
      return credential;
    },
  };
}
