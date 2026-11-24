// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Error taxonomy — every thrown error message is prefixed with `[code] ` so
// callers can discriminate with errorCode(). This mirrors the shape the (now
// retired) napi binding exposed, kept stable so consumers migrating off it see
// an identical contract.
import { Code, ConnectError } from '@connectrpc/connect';
import { BadRequestSchema, ErrorInfoSchema, RetryInfoSchema } from './gen/google/rpc/error_details_pb.js';
export class SdkError extends Error {
    code;
    /** The Connect status code when this error originated from an RPC. */
    connectCode;
    /** Decoded field violations; the complete wire details remain in cause. */
    fieldViolations = [];
    /** Server-provided reason, domain, and metadata, when present. */
    errorInfo;
    /** Suggested minimum delay in milliseconds; does not establish mutation retry safety. */
    retryDelayMs;
    constructor(code, message, options) {
        // Format `[code] message` so errorCode() can recover the code from any Error.
        super(`[${code}] ${message}`, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = 'SdkError';
        this.code = code;
        if (options?.connectCode !== undefined)
            this.connectCode = options.connectCode;
        if (options?.cause instanceof ConnectError) {
            const error = options.cause;
            this.fieldViolations = error
                .findDetails(BadRequestSchema)
                .flatMap((detail) => detail.fieldViolations.map(({ field, description }) => ({ field, description })));
            const info = error.findDetails(ErrorInfoSchema)[0];
            if (info) {
                this.errorInfo = { reason: info.reason, domain: info.domain, metadata: { ...info.metadata } };
            }
            const delay = error.findDetails(RetryInfoSchema)[0]?.retryDelay;
            if (delay && delay.seconds >= 0n && delay.seconds <= 315576000000n && delay.nanos >= 0 && delay.nanos < 1e9) {
                this.retryDelayMs = Number(delay.seconds) * 1000 + delay.nanos / 1e6;
            }
        }
    }
}
// Map a gRPC status (surfaced by connect-es as ConnectError) onto our codes.
// The originating ConnectError is kept as `cause` and its status as
// `connectCode` so callers can inspect the Connect status directly.
export function fromConnect(err) {
    // Curated response validation also runs inside RPC try/catch blocks. Preserve
    // those SDK errors instead of remapping them to a generic Connect status.
    if (err instanceof SdkError)
        return err;
    const ce = ConnectError.from(err);
    const options = { cause: ce, connectCode: ce.code };
    switch (ce.code) {
        case Code.NotFound:
            return new SdkError('not_found', ce.rawMessage, options);
        case Code.AlreadyExists:
            return new SdkError('already_exists', ce.rawMessage, options);
        case Code.Aborted:
            return new SdkError('aborted', ce.rawMessage, options);
        case Code.Canceled:
        case Code.DeadlineExceeded:
            return new SdkError('canceled', ce.rawMessage, options);
        case Code.InvalidArgument:
            return new SdkError('invalid_config', ce.rawMessage, options);
        case Code.Unauthenticated:
        case Code.PermissionDenied:
            return new SdkError('auth', ce.rawMessage, options);
        default:
            return new SdkError('rpc', ce.rawMessage, options);
    }
}
// Extract the `[code]` prefix from any error message.
export function errorCode(err) {
    if (err instanceof SdkError)
        return err.code;
    const msg = err instanceof Error ? err.message : String(err);
    const m = /^\[([a-z_]+)\]/.exec(msg);
    return m ? m[1] : null;
}
//# sourceMappingURL=errors.js.map