export interface OidcTokenProvider {
    getToken(signal?: AbortSignal): Promise<string>;
}
export interface ClientCredentialsOptions {
    issuer: string;
    clientId: string;
    clientSecret: string | (() => string | Promise<string>);
    scopes?: readonly string[];
    audience?: string;
    /** Timeout for each complete discovery or token response, including its body. */
    timeoutMs?: number;
}
export declare function clientCredentials(options: ClientCredentialsOptions): OidcTokenProvider;
//# sourceMappingURL=oidc.d.ts.map