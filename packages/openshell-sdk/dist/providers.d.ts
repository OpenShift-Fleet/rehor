import { type Client, type Transport } from '@connectrpc/connect';
import { OpenShell } from './gen/openshell_pb.js';
import { type ConnectOptions } from './transport.js';
/** An exported runtime secret. Never log or serialize it into shared output. */
export interface ProviderCredentialValue {
    value: string;
    /** Absent for non-expiring values; sub-millisecond precision is truncated. */
    expirationTime?: Date;
}
export interface ProviderCredentialsOptions {
    /** Required explicit workspace. There is no implicit default or all-workspaces export. */
    workspace: string;
    /** Omitted or zero uses the gateway's five-minute margin. Maximum: 24 hours. */
    minimumRemainingLifetimeSecs?: number;
    /** Abort delivery. An already-started gateway refresh can still commit. */
    signal?: AbortSignal;
    /** Deadline for this RPC in milliseconds. */
    timeoutMs?: number;
}
/** Provider operations over a shared transport; no sandbox is required. */
export declare class ProviderClient {
    readonly raw: Client<typeof OpenShell>;
    readonly transport: Transport;
    constructor(transport: Transport);
    /**
     * Use direct gateway HTTPS with a trusted OU=operator client certificate/key
     * and no OIDC or edge token. Operator authentication must be enabled at the gateway.
     */
    static connect(options: ConnectOptions): Promise<ProviderClient>;
    /**
     * Export exactly the selected runtime keys, or reject without a result.
     * Requires direct operator mTLS. The gateway refreshes eligible missing or
     * short-lived outputs, never exports private refresh inputs, and may commit
     * refresh effects even if delivery fails. This helper does not retry or cache.
     */
    getCredentials(name: string, credentialKeys: readonly string[], options: ProviderCredentialsOptions): Promise<Record<string, ProviderCredentialValue>>;
}
//# sourceMappingURL=providers.d.ts.map