import { performance } from "node:perf_hooks";
import { clientCredentials, OpenShellClient, type ClientCredentialsOptions } from "@nvidia/openshell-sdk";
import type { GatewayConfig } from "./gateway-config.js";
import { isolateLifecycleLogger, type ErrorCategory, type LifecycleLogger } from "./logging.js";

const timeoutMs = 30_000;

/**
 * Verifies the configured gateway: an OIDC client-credentials token is
 * exchanged and the authenticated identity is required to be an OIDC identity
 * with the optional pinned subject. The connected client is returned for
 * callers that keep using the gateway (the dispatcher session loop). The SDK
 * exposes no close(), but the underlying HTTP/2 session does not block process
 * exit: connect-node unrefs idle connections once the last RPC stream closes,
 * so a failed preflight still exits 1.
 */
export async function connectGateway(config: GatewayConfig, lifecycle?: LifecycleLogger, signal?: AbortSignal): Promise<OpenShellClient> {
  const logger = isolateLifecycleLogger(lifecycle);
  const authentication = logger.start("gateway.authentication");
  let category: ErrorCategory = "internal";
  try {
    if (signal?.aborted) throw new Error();
    // The SDK uses Node's default TLS behavior, which can be disabled globally.
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error();
    const provider = clientCredentials({ issuer: config.issuer, clientId: config.clientId, clientSecret: config.clientSecret, audience: config.audience, timeoutMs });
    // SDK cancellation stops the waiter, not its shared token exchange. Track
    // the actual work without a signal and drain it before returning, including
    // when the RPC aborts while discovery or the token response is in flight.
    const pending = new Set<Promise<string>>();
    let startupComplete = false;
    // The last token returned by the SDK provider: an unchanged token means
    // the call was served from cache, so nothing is logged. A new value is a
    // real network acquisition and logs one completion record. Tokens are
    // compared in memory only and never logged.
    let lastToken: string | undefined;
    const trackedProvider = {
      async getToken(requestSignal?: AbortSignal): Promise<string> {
        if ((!startupComplete && signal?.aborted) || requestSignal?.aborted) throw new Error();
        const startedAt = performance.now();
        let token: string;
        try {
          const work = provider.getToken();
          pending.add(work);
          void work.then(() => pending.delete(work), () => pending.delete(work));
          token = await work;
        } catch (error) {
          logger.log("gateway.oidc", "failure", { category: "internal", durationMs: Math.max(0, performance.now() - startedAt) });
          throw error;
        }
        if (token !== lastToken) {
          lastToken = token;
          logger.log("gateway.oidc", "success", { durationMs: Math.max(0, performance.now() - startedAt) });
        }
        if ((!startupComplete && signal?.aborted) || requestSignal?.aborted) throw new Error();
        return token;
      },
    };
    const client = await OpenShellClient.connect({ gateway: config.endpoint, oidcTokenProvider: trackedProvider, insecureSkipVerify: false });
    try {
      if (signal?.aborted) throw new Error();
      const deadline = AbortSignal.timeout(timeoutMs);
      const identity = await client.raw.getCurrentUser({}, { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      if (signal?.aborted) throw new Error();
      if (identity.identityProvider !== "oidc" || !identity.subject || (config.subject !== undefined && identity.subject !== config.subject)) {
        category = "authentication";
        throw new Error();
      }
    } finally {
      await Promise.allSettled([...pending]);
    }
    if (signal?.aborted) throw new Error();
    // The startup signal only governs preflight. Runtime Gateway requests
    // carry their own signals; shutdown must still authenticate cleanup RPCs.
    startupComplete = true;
    authentication.success();
    return client;
  } catch {
    authentication.failure(category);
    throw new Error("OpenShell gateway preflight failed");
  }
}
