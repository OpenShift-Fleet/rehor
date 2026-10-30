import type { ClientCredentialsOptions, ConnectOptions, OpenShellClient } from "@nvidia/openshell-sdk";
import { readGatewayConfig, type GatewayConfig } from "./gateway-config.js";
import { isolateLifecycleLogger, type ErrorCategory, type LifecycleLogger } from "./logging.js";

const timeoutMs = 10_000;

export type GatewaySdk = {
  clientCredentials: (options: ClientCredentialsOptions) => NonNullable<ConnectOptions["oidcTokenProvider"]>;
  connect: (options: ConnectOptions) => Promise<Pick<OpenShellClient, "raw">>;
};

async function loadSdk(): Promise<GatewaySdk> {
  const sdk = await import("@nvidia/openshell-sdk");
  return { clientCredentials: sdk.clientCredentials, connect: sdk.OpenShellClient.connect };
}

export async function connectGateway(config: GatewayConfig, sdkFactory: () => Promise<GatewaySdk> = loadSdk, lifecycle?: LifecycleLogger, signal?: AbortSignal): Promise<Pick<OpenShellClient, "raw">> {
  const logger = isolateLifecycleLogger(lifecycle);
  const authentication = logger.start("gateway.authentication");
  let category: ErrorCategory = "internal";
  try {
    if (signal?.aborted) throw new Error();
    // The SDK uses Node's default TLS behavior, which can be disabled globally.
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error();
    config = readGatewayConfig({
      OPENSHELL_GATEWAY_ENDPOINT: config.endpoint,
      OPENSHELL_GATEWAY_NAME: config.name,
      OPENSHELL_OIDC_ISSUER: config.issuer,
      OPENSHELL_CLIENT_ID: config.clientId,
      OPENSHELL_OIDC_AUDIENCE: config.audience,
      OPENSHELL_OIDC_CLIENT_SECRET: config.clientSecret,
      OPENSHELL_SERVICE_ACCOUNT_SUBJECT: config.subject,
    })!;
    const sdk = await sdkFactory();
    if (signal?.aborted) throw new Error();
    const provider = sdk.clientCredentials({ issuer: config.issuer, clientId: config.clientId, clientSecret: config.clientSecret, audience: config.audience, timeoutMs });
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
    const client = await sdk.connect({ gateway: config.endpoint, oidcTokenProvider: trackedProvider, insecureSkipVerify: false });
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
    return client;
  } catch {
    authentication.failure(category);
    throw new Error("OpenShell gateway preflight failed");
  }
}
