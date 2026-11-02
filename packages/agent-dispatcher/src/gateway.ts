import { clientCredentials, OpenShellClient, type ClientCredentialsOptions } from "@nvidia/openshell-sdk";
import type { GatewayConfig } from "./gateway-config.js";
import { isolateLifecycleLogger, type ErrorCategory, type LifecycleLogger } from "./logging.js";

const timeoutMs = 30_000;

/**
 * Verifies the configured gateway: an OIDC client-credentials token is
 * exchanged and the authenticated identity is required to be an OIDC identity
 * with the optional pinned subject. The client is not returned: nothing uses
 * it yet, and the SDK exposes no close(), so holding it would leave the
 * connection to a caller that cannot shut it down. The underlying HTTP/2
 * session does not block process exit: connect-node unrefs idle connections
 * once the last RPC stream closes, so a failed preflight still exits 1.
 */
export async function connectGateway(config: GatewayConfig, lifecycle?: LifecycleLogger, signal?: AbortSignal): Promise<void> {
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
    const trackedProvider = {
      async getToken(requestSignal?: AbortSignal): Promise<string> {
        if (signal?.aborted || requestSignal?.aborted) throw new Error();
        const acquisition = logger.start("gateway.oidc");
        let token: string;
        try {
          const work = provider.getToken();
          pending.add(work);
          void work.then(() => pending.delete(work), () => pending.delete(work));
          token = await work;
          acquisition.success();
        } catch (error) {
          acquisition.failure("internal");
          throw error;
        }
        if (signal?.aborted || requestSignal?.aborted) throw new Error();
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
    authentication.success();
  } catch {
    authentication.failure(category);
    throw new Error("OpenShell gateway preflight failed");
  }
}
