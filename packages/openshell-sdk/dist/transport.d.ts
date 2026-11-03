import type { Interceptor, Transport } from '@connectrpc/connect';
import type { OidcTokenProvider } from './oidc.js';
export interface ConnectOptions {
    /** Gateway URL (`http://...` or `https://...`). */
    gateway: string;
    /** CA certificate (PEM). Omit to use system roots. */
    caCert?: Buffer;
    /**
     * Client certificate (PEM) for mTLS. Authenticates the CALLER, not just the
     * server. The default local OpenShell gateway (Docker, VM, Homebrew, Linux
     * package) requires this. Must be paired with clientKey.
     */
    clientCert?: Buffer;
    /** Client private key (PEM) for mTLS. Must be paired with clientCert. */
    clientKey?: Buffer;
    /** Bearer token for direct OIDC auth. Mutually exclusive with edgeToken. */
    oidcToken?: string;
    /** Renewable OIDC bearer provider. Mutually exclusive with oidcToken and edgeToken. */
    oidcTokenProvider?: OidcTokenProvider;
    /** Cloudflare Access token. See the sidecar note above for CF-fronted gateways. */
    edgeToken?: string;
    /** Disable TLS verification (dev/debug only). */
    insecureSkipVerify?: boolean;
    /**
     * Permit sending an auth token (oidcToken/oidcTokenProvider/edgeToken) over
     * plaintext `http://` to a non-loopback host. Off by default: tokens over
     * cleartext to a remote host leak credentials on the wire. Loopback hosts are
     * always allowed.
     */
    allowInsecureAuth?: boolean;
}
/** @internal Exported for transport contract tests; not part of the package root API. */
export declare function authInterceptor(opts: ConnectOptions): Interceptor;
export declare function buildTransport(opts: ConnectOptions): Transport;
//# sourceMappingURL=transport.d.ts.map