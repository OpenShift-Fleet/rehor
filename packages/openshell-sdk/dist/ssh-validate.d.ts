/** The subset of the response the SDK validates and forwards. */
export interface SshResponseFields {
    sandboxId: string;
    token: string;
    gatewayHost: string;
    gatewayPort: number;
    gatewayScheme: string;
    hostKeyFingerprint: string;
}
export declare function validateSshResponse(resp: SshResponseFields, expectedSandboxId?: string): void;
//# sourceMappingURL=ssh-validate.d.ts.map