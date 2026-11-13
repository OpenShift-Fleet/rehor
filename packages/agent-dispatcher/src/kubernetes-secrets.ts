import { readFile } from "node:fs/promises";
import { httpsRequest, type HttpClient } from "./https.js";
import { isSecretReferenceName, SecretRenderError, type SecretData, type SecretReader } from "./secret-rendering.js";

/** Label marking second-tier agent secrets synced from Vault by External
 * Secrets Operator and readable by dispatched agent instances. */
export const SECRET_TIER_LABEL = "rehor.dev/secret-tier";
export const SECRET_TIER_VALUE = "2";
/** Tier-1 service-credential Secret (dispatcher authentication, Gateway
 * configuration): explicitly denied to agent instances, labeled or not. */
export const TIER_ONE_SECRET_NAME = "devbot-secrets";

export type KubernetesSecretDependencies = {
  http: HttpClient;
  readFile: (path: string) => Promise<Buffer>;
  env: NodeJS.ProcessEnv;
};

const serviceAccountDirectory = "/var/run/secrets/kubernetes.io/serviceaccount";
// The API server's maximum object size bounds Secret responses.
const MAX_RESPONSE_BYTES = 1_048_576;
const namespacePattern = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads Kubernetes Secrets in the dispatcher's own namespace using its
 * automounted service-account token: token, CA, and namespace come from the
 * standard projected files, and the API server host and port from the
 * in-cluster environment. Cluster-side RBAC (get on secrets in this
 * namespace) is provisioned separately. Every failure is a fixed-message
 * `SecretRenderError`; response bodies, tokens, and values never surface. */
export function createKubernetesSecretReader(overrides: Partial<KubernetesSecretDependencies> = {}): SecretReader {
  const deps: KubernetesSecretDependencies = { http: httpsRequest, readFile, env: process.env, ...overrides };
  return (name) => readKubernetesSecret(deps, name);
}

async function readKubernetesSecret(deps: KubernetesSecretDependencies, name: string): Promise<SecretData> {
  if (!isSecretReferenceName(name)) {
    throw new SecretRenderError("Sandbox environment value contains an invalid secret reference", "configuration", "invalid-reference");
  }
  // Tier-1 service credentials are denied before any request is made.
  if (name === TIER_ONE_SECRET_NAME) {
    throw new SecretRenderError(
      `Secret '${name}' holds tier-1 service credentials and is not available to agent instances`,
      "authorization",
      "tier",
    );
  }
  const credentials = await readProjectedCredentials(deps);
  const response = await requestSecret(deps, credentials.namespace, credentials.token, credentials.ca, name);
  return parseSecret(response.body, credentials.namespace, name);
}

async function readProjectedCredentials(deps: KubernetesSecretDependencies): Promise<{ token: string; ca: Buffer; namespace: string }> {
  let files: [Buffer, Buffer, Buffer];
  try {
    files = await Promise.all([
      deps.readFile(`${serviceAccountDirectory}/token`),
      deps.readFile(`${serviceAccountDirectory}/ca.crt`),
      deps.readFile(`${serviceAccountDirectory}/namespace`),
    ]);
  } catch {
    throw new SecretRenderError("Missing Kubernetes service-account credentials", "credentials", "transport");
  }
  const token = files[0].toString("utf8").trim();
  const namespace = files[2].toString("utf8").trim();
  if (!token || !files[1].length || !namespace || namespace.length > 63 || !namespacePattern.test(namespace)) {
    throw new SecretRenderError("Missing Kubernetes service-account credentials", "credentials", "transport");
  }
  return { token, ca: files[1], namespace };
}

// Host and port are supplied by Kubernetes, never an arbitrary URL.
function secretUrl(env: NodeJS.ProcessEnv, namespace: string, name: string): URL {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443";
  if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host) || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new SecretRenderError("Kubernetes API configuration is invalid", "configuration", "transport");
  }
  const authority = host.includes(":") ? `[${host}]` : host;
  try {
    return new URL(`https://${authority}:${port}/api/v1/namespaces/${namespace}/secrets/${name}`);
  } catch {
    throw new SecretRenderError("Kubernetes API configuration is invalid", "configuration", "transport");
  }
}

async function requestSecret(
  deps: KubernetesSecretDependencies,
  namespace: string,
  token: string,
  ca: Buffer,
  name: string,
): Promise<{ status: number; body: string }> {
  // Built before the transport try so a configuration failure keeps its own
  // category instead of being absorbed into a network failure.
  const url = secretUrl(deps.env, namespace, name);
  let response;
  try {
    response = await deps.http({
      url,
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      ca,
      readResponseBody: true,
    });
  } catch {
    // Connect and timeout failures carry no response content.
    throw new SecretRenderError("Kubernetes Secret read failed", "network", "transport");
  }
  if (response.status === 404) {
    throw new SecretRenderError(`Secret '${name}' was not found`, "configuration", "missing-secret");
  }
  if (response.status === 401 || response.status === 403) {
    throw new SecretRenderError("Kubernetes rejected the Secret read", "authorization", "transport");
  }
  if (response.status < 200 || response.status >= 300 || response.body.length > MAX_RESPONSE_BYTES) {
    throw new SecretRenderError("Kubernetes Secret response was invalid", "response", "transport");
  }
  return response;
}

function parseSecret(body: string, namespace: string, name: string): SecretData {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new SecretRenderError("Kubernetes Secret response was invalid", "response", "transport");
  }
  if (!object(payload) || (payload.kind !== undefined && payload.kind !== "Secret")) {
    throw new SecretRenderError("Kubernetes Secret response was invalid", "response", "transport");
  }
  const metadata = payload.metadata;
  if (!object(metadata) || metadata.name !== name || metadata.namespace !== namespace) {
    throw new SecretRenderError("Kubernetes Secret response was invalid", "response", "transport");
  }
  // Tier enforcement: only Secrets labeled rehor.dev/secret-tier: "2" are
  // readable; anything unlabeled or otherwise labeled is denied.
  const labels = metadata.labels;
  if (labels !== undefined && !object(labels)) {
    throw new SecretRenderError("Kubernetes Secret response was invalid", "response", "transport");
  }
  if (!object(labels) || labels[SECRET_TIER_LABEL] !== SECRET_TIER_VALUE) {
    throw new SecretRenderError(`Secret '${name}' does not carry the ${SECRET_TIER_LABEL}: "${SECRET_TIER_VALUE}" label`, "authorization", "tier");
  }
  const entries = payload.data;
  if (entries === undefined) return new Map();
  if (!object(entries)) {
    throw new SecretRenderError("Kubernetes Secret response was invalid", "response", "transport");
  }
  const data = new Map<string, Buffer>();
  for (const [key, value] of Object.entries(entries)) {
    // The API server guarantees base64 data; anything else is a malformed
    // response, and the whole read fails closed.
    if (typeof value !== "string" || value.length % 4 !== 0 || !base64Pattern.test(value)) {
      throw new SecretRenderError("Kubernetes Secret response was invalid", "response", "transport");
    }
    data.set(key, Buffer.from(value, "base64"));
  }
  return data;
}
