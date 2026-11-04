import { Code } from '@connectrpc/connect';
/** A field rejected by the gateway. */
export interface FieldViolation {
    field: string;
    description: string;
}
/** A stable error reason scoped to its producing service. */
export interface ErrorInfo {
    reason: string;
    domain: string;
    metadata: Record<string, string>;
}
export type SdkErrorCode = 'invalid_config' | 'tls' | 'connect' | 'auth' | 'io' | 'not_found' | 'already_exists' | 'aborted' | 'canceled' | 'rpc';
/** Extra context attached to an SdkError raised from a Connect RPC. */
export interface SdkErrorOptions {
    /** The original error, preserved so callers can inspect the underlying cause. */
    cause?: unknown;
    /** The Connect status code, so callers can inspect it without parsing text. */
    connectCode?: Code;
}
export declare class SdkError extends Error {
    readonly code: SdkErrorCode;
    /** The Connect status code when this error originated from an RPC. */
    readonly connectCode?: Code;
    /** Decoded field violations; the complete wire details remain in cause. */
    readonly fieldViolations: FieldViolation[];
    /** Server-provided reason, domain, and metadata, when present. */
    readonly errorInfo?: ErrorInfo;
    /** Suggested minimum delay in milliseconds; does not establish mutation retry safety. */
    readonly retryDelayMs?: number;
    constructor(code: SdkErrorCode, message: string, options?: SdkErrorOptions);
}
export declare function fromConnect(err: unknown): SdkError;
export declare function errorCode(err: unknown): string | null;
//# sourceMappingURL=errors.d.ts.map