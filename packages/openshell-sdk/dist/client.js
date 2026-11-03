// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import * as net from 'node:net';
import { durationFromMs } from '@bufbuild/protobuf/wkt';
import { Code, createClient } from '@connectrpc/connect';
import { errorCode, fromConnect, SdkError } from './errors.js';
import { OpenShell, ServiceAuthorizationMode as ProtoServiceAuthorizationMode, SandboxPhase, SandboxRestartPolicy, ServiceStatus, } from './gen/openshell_pb.js';
import { PolicySource, SettingScope } from './gen/sandbox_pb.js';
import { ProviderClient } from './providers.js';
import { validateSshResponse } from './ssh-validate.js';
import { buildTransport } from './transport.js';
function durationFromSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        throw new RangeError('timeoutSecs must be a finite, non-negative number');
    }
    return seconds === 0 ? undefined : durationFromMs(seconds * 1000);
}
// Distinct from timestampMillis(): LogLine/PlatformEvent timestamps are
// always-present numbers that default to 0 when absent or unrepresentable,
// not an optional string field like expiresAtMs.
function eventTimeMillis(timestamp) {
    if (!timestamp)
        return 0;
    return Number(timestamp.seconds * 1000n + BigInt(Math.trunc(timestamp.nanos / 1_000_000)));
}
function timestampMillis(timestamp) {
    if (!timestamp)
        return undefined;
    const millis = timestamp.seconds * 1000n + BigInt(Math.trunc(timestamp.nanos / 1_000_000));
    return millis === 0n ? undefined : millis.toString();
}
function timestampEpochMs(timestamp) {
    const millis = timestampMillis(timestamp);
    return millis ? Number(millis) : undefined;
}
export { errorCode };
function deletionResult(response) {
    const names = {
        0: 'unspecified',
        1: 'completed',
        2: 'accepted',
        3: 'already_absent',
    };
    return {
        outcome: names[response.outcome] ?? 'unknown',
        rawOutcome: response.outcome,
        ...(response.sandboxId ? { sandboxId: response.sandboxId } : {}),
    };
}
export var ServiceAuthorizationMode;
(function (ServiceAuthorizationMode) {
    ServiceAuthorizationMode["Strip"] = "strip";
    ServiceAuthorizationMode["BearerPassthrough"] = "bearer_passthrough";
})(ServiceAuthorizationMode || (ServiceAuthorizationMode = {}));
function serviceAuthorizationModeToProto(mode) {
    switch (mode) {
        case ServiceAuthorizationMode.BearerPassthrough:
            return ProtoServiceAuthorizationMode.BEARER_PASSTHROUGH;
        case ServiceAuthorizationMode.Strip:
        case undefined:
            return ProtoServiceAuthorizationMode.STRIP;
    }
}
// ---- enum → lowercase string -----------------------------------------------
// Exported for the enum-name drift test only; not re-exported from index.ts, so
// they are not part of the public package API.
export const PHASE_NAMES = {
    [SandboxPhase.UNSPECIFIED]: 'unspecified',
    [SandboxPhase.PROVISIONING]: 'provisioning',
    [SandboxPhase.READY]: 'ready',
    [SandboxPhase.ERROR]: 'error',
    [SandboxPhase.DELETING]: 'deleting',
    [SandboxPhase.UNKNOWN]: 'unknown',
    [SandboxPhase.STOPPING]: 'stopping',
    [SandboxPhase.STOPPED]: 'stopped',
    [SandboxPhase.STARTING]: 'starting',
    [SandboxPhase.COMPLETED]: 'completed',
};
export const STATUS_NAMES = {
    [ServiceStatus.UNSPECIFIED]: 'unspecified',
    [ServiceStatus.HEALTHY]: 'healthy',
    [ServiceStatus.DEGRADED]: 'degraded',
    [ServiceStatus.UNHEALTHY]: 'unhealthy',
};
export const SCOPE_NAMES = {
    [SettingScope.UNSPECIFIED]: 'unspecified',
    [SettingScope.SANDBOX]: 'sandbox',
    [SettingScope.GLOBAL]: 'global',
};
export const POLICY_SOURCE_NAMES = {
    [PolicySource.UNSPECIFIED]: 'unspecified',
    [PolicySource.SANDBOX]: 'sandbox',
    [PolicySource.GLOBAL]: 'global',
};
function phaseName(p) {
    return PHASE_NAMES[p] ?? 'unspecified';
}
function restartPolicyValue(policy) {
    switch (policy) {
        case 'on-failure':
            return SandboxRestartPolicy.ON_FAILURE;
        case 'always':
            return SandboxRestartPolicy.ALWAYS;
        default:
            return SandboxRestartPolicy.NEVER;
    }
}
function statusName(s) {
    return STATUS_NAMES[s] ?? 'unspecified';
}
function scopeName(s) {
    return SCOPE_NAMES[s] ?? 'unspecified';
}
function policySourceName(s) {
    return POLICY_SOURCE_NAMES[s] ?? 'unspecified';
}
function sandboxRef(sandbox, serviceUrls = {}) {
    if (!sandbox)
        throw new SdkError('invalid_config', 'sandbox missing from gateway response');
    const meta = sandbox.metadata;
    if (!meta?.id || !meta.name) {
        throw new SdkError('invalid_config', 'sandbox metadata.id and metadata.name are required in gateway responses');
    }
    return {
        id: meta.id,
        name: meta.name,
        workspace: meta.workspace,
        phase: phaseName(sandbox.status?.phase ?? SandboxPhase.UNSPECIFIED),
        labels: meta?.labels ?? {},
        resourceVersion: (meta?.resourceVersion ?? 0n).toString(),
        hostKeyFingerprint: sandbox.hostKeyFingerprint || undefined,
        mainProcessInstanceId: sandbox.status?.mainProcessInstanceId || undefined,
        exitCode: sandbox.status?.exitCode,
        createdFromWorkloadTemplate: sandbox.createdFromWorkloadTemplate
            ? {
                name: sandbox.createdFromWorkloadTemplate.name,
                resourceVersion: sandbox.createdFromWorkloadTemplate.resourceVersion,
            }
            : undefined,
        serviceUrls,
        restartCount: sandbox.status?.restartCount ?? 0,
        createdAtMs: timestampEpochMs(meta.createdTime),
        nextRestartAtMs: timestampEpochMs(sandbox.status?.nextRestartTime),
        mainProcessStartedAtMs: timestampEpochMs(sandbox.status?.mainProcessStartedTime),
    };
}
function sandboxTemplate(template) {
    if (!template)
        throw new SdkError('invalid_config', 'sandbox template missing from gateway response');
    return template;
}
function providerRef(provider) {
    const meta = provider.metadata;
    return {
        id: meta?.id ?? '',
        name: meta?.name ?? '',
        type: provider.type,
        labels: meta?.labels ?? {},
        resourceVersion: (meta?.resourceVersion ?? 0n).toString(),
    };
}
function sandboxConfig(resp) {
    const settings = {};
    for (const [key, setting] of Object.entries(resp.settings)) {
        settings[key] = effectiveSetting(setting);
    }
    return {
        ...(resp.policy ? { policy: resp.policy } : {}),
        version: resp.version,
        policyHash: resp.policyHash,
        settings,
        configRevision: resp.configRevision.toString(),
        policySource: policySourceName(resp.policySource),
        globalPolicyVersion: resp.globalPolicyVersion,
        providerEnvRevision: resp.providerEnvRevision.toString(),
    };
}
function effectiveSetting(setting) {
    return {
        ...(setting.value ? { value: setting.value } : {}),
        scope: scopeName(setting.scope),
    };
}
function updateConfigResult(resp) {
    return {
        version: resp.version,
        policyHash: resp.policyHash,
        settingsRevision: resp.settingsRevision.toString(),
        deleted: resp.deleted,
    };
}
// Optimistic-concurrency version pin: absent/empty means 0n (server uses the
// current version, backward-compatible). A mismatch surfaces as Aborted →
// SdkError code 'aborted'.
function versionPin(value) {
    if (!value)
        return 0n;
    let pin;
    try {
        pin = BigInt(value);
    }
    catch {
        // BigInt() throws a raw SyntaxError on non-integer input; keep the SdkError
        // taxonomy intact so callers' errorCode() checks still match.
        throw new SdkError('invalid_config', `expectedResourceVersion is not a u64: '${value}'`);
    }
    if (pin < 0n) {
        throw new SdkError('invalid_config', `expectedResourceVersion is not a u64: '${value}'`);
    }
    return pin;
}
const FORWARD_CHUNK = 64 * 1024;
function workspaceName(options) {
    const workspace = options?.workspace ?? 'default';
    if (workspace.trim() === '')
        throw new SdkError('invalid_config', 'workspace must be non-empty');
    return workspace;
}
function workspaceScope(options) {
    return { selection: { case: 'workspace', value: workspaceName(options) } };
}
function listWorkspaceScope(options) {
    return options?.allWorkspaces ? { selection: { case: 'allWorkspaces', value: {} } } : workspaceScope(options);
}
function sandboxTarget(name, options) {
    return { sandbox: name, workspaceScope: workspaceScope(options) };
}
function namedTarget(name, options) {
    return { name, workspaceScope: workspaceScope(options) };
}
function requestCallOptions(options) {
    if (!options)
        return undefined;
    const { workspace: _workspace, ...callOptions } = options;
    return callOptions;
}
// Build CallOptions that bound one poll RPC by the remaining wall-clock budget
// and honor caller cancellation, so a stalled RPC cannot outlive the deadline.
function deadlineOptions(remainingMs, signal) {
    const timeout = AbortSignal.timeout(Math.max(0, remainingMs));
    return {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    };
}
// Translate a poll failure at the wait boundary: caller cancellation and the
// poll's deadline signal both become explicit SdkErrors; anything else propagates.
function mapWaitError(err, name, deadline, signal, pollSignal) {
    if (signal?.aborted)
        return new SdkError('connect', `wait for sandbox '${name}' aborted`);
    if (pollSignal?.aborted || Date.now() >= deadline)
        return new SdkError('connect', `timed out waiting for sandbox '${name}'`);
    return err instanceof SdkError ? err : fromConnect(err);
}
// Sleep between polls, bounded by the remaining deadline and interruptible by
// the caller signal so the returned promise stays within its timeout budget.
function waitSleep(delayMs, deadline, signal) {
    const bounded = Math.min(delayMs, Math.max(0, deadline - Date.now()));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, bounded);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new SdkError('connect', 'wait aborted'));
        };
        if (signal)
            signal.addEventListener('abort', onAbort, { once: true });
    });
}
// Reconnect backoff for watchLogs: uncapped deadline, just a capped delay
// interruptible by the caller signal. Distinct from waitSleep, which is
// deadline-bounded for poll loops.
function defaultWatchLogsBackoffSleep(delayMs, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new SdkError('canceled', 'watchLogs aborted'));
        };
        if (signal)
            signal.addEventListener('abort', onAbort, { once: true });
    });
}
let watchLogsBackoffSleep = defaultWatchLogsBackoffSleep;
/**
 * Test-only seam for the `watchLogs` reconnect backoff delay. Not part of the
 * public API surface — not re-exported from index.ts. Call with no argument
 * to restore the real timer-based sleep.
 */
export function __setWatchLogsBackoffSleepForTests(fn) {
    watchLogsBackoffSleep = fn ?? defaultWatchLogsBackoffSleep;
}
// Only Unavailable (connection drop, gateway restart) is retryable. Every
// other status — including OUT_OF_RANGE — is terminal so the caller sees it
// instead of the loop silently restarting from an empty cursor and hiding a gap.
function isRetryableWatchLogsError(err) {
    return err.connectCode === Code.Unavailable;
}
function toLogLine(value) {
    return {
        sandboxId: value.sandboxId,
        timestampMs: eventTimeMillis(value.eventTime),
        level: value.level,
        target: value.target,
        message: value.message,
        source: value.source || 'gateway',
        fields: { ...value.fields },
    };
}
function toPlatformEvent(value) {
    return {
        timestampMs: eventTimeMillis(value.eventTime),
        source: value.source,
        type: value.type,
        reason: value.reason,
        message: value.message,
        metadata: { ...value.metadata },
    };
}
// Converts one wire watch event into a curated WatchEvent, returning the
// (possibly advanced) cursor alongside it. `cursor` is a high-water mark, not
// "last seen": the gateway reads the log and platform sources independently
// during live delivery, so arrival order can differ from cursor order. Taking
// the max keeps the resume point monotonic; assigning directly would let a
// later lower-cursor event rewind it and replay already-delivered events after
// a reconnect. The comparison is a plain byte-wise string compare on an opaque
// token — well defined only because both cursors come from the same stream.
function convertWatchEvent(wireEvent, cursor) {
    switch (wireEvent.payload.case) {
        case 'log': {
            const next = wireEvent.cursor > cursor ? wireEvent.cursor : cursor;
            return {
                event: { kind: 'log', line: toLogLine(wireEvent.payload.value), cursor: wireEvent.cursor },
                cursor: next,
            };
        }
        case 'event': {
            const next = wireEvent.cursor > cursor ? wireEvent.cursor : cursor;
            return {
                event: { kind: 'event', event: toPlatformEvent(wireEvent.payload.value), cursor: wireEvent.cursor },
                cursor: next,
            };
        }
        case 'warning':
            return { event: { kind: 'warning', message: wireEvent.payload.value.message }, cursor };
        default:
            // Sandbox snapshots and draft-policy updates are not part of this
            // curated log/event stream.
            return { cursor };
    }
}
// Wait for a socket to drain before writing more. Resolves on 'drain', and
// also on 'close'/'error' so a pending await never leaks when the socket is
// torn down mid-backpressure; short-circuits if it is already gone.
function waitForDrain(socket) {
    if (socket.writableEnded || socket.destroyed)
        return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            socket.removeListener('drain', done);
            socket.removeListener('close', done);
            socket.removeListener('error', done);
            resolve();
        };
        socket.once('drain', done);
        socket.once('close', done);
        socket.once('error', done);
    });
}
// An async-iterable queue for the client-send half of bidi streams. Producers
// `push()` frames; the connect transport consumes them as it drains the send
// side. `end()` closes the stream (optionally with an error). `onDrain` fires
// when the buffered queue empties via consumption, so callers can relieve TCP
// backpressure.
export class Pushable {
    queue = [];
    waiting = [];
    ended = false;
    error;
    onDrain;
    get size() {
        return this.queue.length;
    }
    push(value) {
        if (this.ended)
            return;
        const waiter = this.waiting.shift();
        if (waiter) {
            waiter.resolve({ value, done: false });
        }
        else {
            this.queue.push(value);
        }
    }
    end(error) {
        if (this.ended)
            return;
        this.ended = true;
        this.error = error;
        let waiter = this.waiting.shift();
        while (waiter) {
            if (error !== undefined)
                waiter.reject(error);
            else
                waiter.resolve({ value: undefined, done: true });
            waiter = this.waiting.shift();
        }
    }
    async *[Symbol.asyncIterator]() {
        for (;;) {
            if (this.queue.length > 0) {
                const value = this.queue.shift();
                if (this.queue.length === 0)
                    this.onDrain?.();
                yield value;
                continue;
            }
            if (this.ended) {
                if (this.error !== undefined)
                    throw this.error;
                return;
            }
            const next = await new Promise((resolve, reject) => {
                this.waiting.push({ resolve, reject });
            });
            if (next.done) {
                if (this.error !== undefined)
                    throw this.error;
                return;
            }
            yield next.value;
        }
    }
}
// Single producer/consumer queue. Closing wakes both directions, including a
// producer blocked by backpressure. Successful completion drains queued values.
class ExecOutputQueue {
    values = [];
    ended = false;
    error;
    reader;
    writer;
    async push(value) {
        // The terminal exit carries no output bytes and must never block cleanup
        // after done has already settled and its cancellation listener is removed.
        while (!('type' in value) && this.values.length >= 16 && !this.ended) {
            await new Promise((resolve) => {
                this.writer = resolve;
            });
        }
        if (this.ended)
            throw this.error ?? new SdkError('canceled', 'exec output closed');
        this.values.push(value);
        this.reader?.();
        this.reader = undefined;
    }
    end(error, discard = false) {
        if (discard)
            this.values.length = 0;
        if (!this.ended) {
            this.ended = true;
            this.error = error;
        }
        this.reader?.();
        this.writer?.();
        this.reader = undefined;
        this.writer = undefined;
    }
    async *[Symbol.asyncIterator]() {
        for (;;) {
            const value = this.values.shift();
            if (value !== undefined) {
                this.writer?.();
                this.writer = undefined;
                yield value;
            }
            else if (this.ended) {
                if (this.error !== undefined)
                    throw this.error;
                return;
            }
            else {
                await new Promise((resolve) => {
                    this.reader = resolve;
                });
            }
        }
    }
}
const maxConsumedPageTokens = 10_000;
const maxConsumedPageTokenBytes = 1 << 20;
/** Lazy, single-pass iterator that fetches one RPC page per advance. */
export class Pager {
    fetch;
    maxConsumedTokens;
    maxConsumedTokenBytes;
    nextToken;
    consumedTokens = new Set();
    consumedTokenBytes = 0;
    constructor(fetch, pageToken = '', maxConsumedTokens = maxConsumedPageTokens, maxConsumedTokenBytes = maxConsumedPageTokenBytes) {
        this.fetch = fetch;
        this.maxConsumedTokens = maxConsumedTokens;
        this.maxConsumedTokenBytes = maxConsumedTokenBytes;
        this.nextToken = pageToken;
    }
    validateCurrentTokenBudget(pageToken) {
        if (pageToken === '')
            return 0;
        const tokenBytes = new TextEncoder().encode(pageToken).byteLength;
        if (this.consumedTokens.size >= this.maxConsumedTokens ||
            tokenBytes > this.maxConsumedTokenBytes - this.consumedTokenBytes) {
            throw new Error('pager continuation token history limit exceeded');
        }
        return tokenBytes;
    }
    /** Fetch the next page, or return undefined after the final page. */
    async nextPage() {
        if (this.nextToken === undefined)
            return undefined;
        const pageToken = this.nextToken;
        const tokenBytes = this.validateCurrentTokenBudget(pageToken);
        const page = await this.fetch(pageToken);
        if (pageToken !== '') {
            this.consumedTokens.add(pageToken);
            this.consumedTokenBytes += tokenBytes;
        }
        if (page.nextPageToken !== '' && this.consumedTokens.has(page.nextPageToken)) {
            throw new Error('pager received a repeated continuation token');
        }
        this.nextToken = page.nextPageToken === '' ? undefined : page.nextPageToken;
        return page;
    }
    /** Consume the pager and collect every remaining item. */
    async all() {
        const items = [];
        for await (const page of this)
            items.push(...page.items);
        return items;
    }
    async *[Symbol.asyncIterator]() {
        for (;;) {
            const page = await this.nextPage();
            if (page === undefined)
                return;
            yield page;
        }
    }
}
// ---- sandbox template client ----------------------------------------------
// Reusable sandbox workload template lifecycle. Templates intentionally return
// generated proto messages because the resource owns portable workload fields
// plus driver-specific config that should not be lossy in the curated layer.
export class SandboxTemplateClient {
    grpc;
    raw;
    transport;
    constructor(transport, grpc = createClient(OpenShell, transport)) {
        this.transport = transport;
        this.grpc = grpc;
        this.raw = this.grpc;
    }
    static async connect(options) {
        return new SandboxTemplateClient(buildTransport(options));
    }
    async create(template, options) {
        try {
            const resp = await this.grpc.createSandboxTemplate({
                workspaceScope: workspaceScope(options),
                template,
            });
            return sandboxTemplate(resp.template);
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
    }
    async get(name, options) {
        if (name.trim() === '')
            throw new SdkError('invalid_config', 'template name is required');
        try {
            const resp = await this.grpc.getSandboxTemplate({
                workspaceScope: workspaceScope(options),
                name,
            });
            return sandboxTemplate(resp.template);
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
    }
    list(options) {
        return new Pager(async (pageToken) => {
            try {
                const resp = await this.grpc.listSandboxTemplates({
                    pageSize: options?.pageSize ?? 0,
                    pageToken,
                    labelSelector: options?.labelSelector ?? '',
                    workspaceScope: listWorkspaceScope(options),
                });
                return { items: resp.templates, nextPageToken: resp.nextPageToken };
            }
            catch (e) {
                throw fromConnect(e);
            }
        }, options?.pageToken ?? '');
    }
    /** List and collect every sandbox template in this scope. */
    async listAll(options) {
        return this.list(options).all();
    }
    async delete(name, options) {
        if (name.trim() === '')
            throw new SdkError('invalid_config', 'template name is required');
        try {
            const resp = await this.grpc.deleteSandboxTemplate({
                workspaceScope: workspaceScope(options),
                allowMissing: options?.allowMissing ?? false,
                name,
            });
            return deletionResult(resp);
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
}
// ---- sandbox client --------------------------------------------------------
// Sandbox lifecycle + exec. Usable standalone via `SandboxClient.connect()`,
// or reached as `client.sandbox` on an OpenShellClient, which shares one
// transport (one connection) across all of its scoped clients.
export class SandboxClient {
    grpc;
    /**
     * Advanced escape hatch: a generated client for every gateway RPC, including
     * surface the curated methods do not wrap yet. Request/response types are the
     * generated wire messages (import them from '@nvidia/openshell-sdk/raw').
     */
    raw;
    /** The shared Connect transport, for building extra clients over the same connection. */
    transport;
    // Takes a transport rather than options so OpenShellClient can compose
    // several scoped clients over a single connection. For standalone use,
    // prefer the SandboxClient.connect() factory below.
    constructor(transport, grpc = createClient(OpenShell, transport)) {
        this.transport = transport;
        this.grpc = grpc;
        this.raw = this.grpc;
    }
    /**
     * Constructs a lazy Connect client. No network request is made until the
     * first RPC; call get() or another operation to verify reachability.
     */
    static async connect(options) {
        return new SandboxClient(buildTransport(options));
    }
    async create(spec) {
        try {
            // Curated fields build the base spec; rawSpec then shallow-overrides at
            // the top spec level (Object.assign, so any field it sets wins). The
            // runtime assign avoids the generated $typeName upgrading the literal and
            // rejecting the curated `template: { image }` init shorthand.
            const specInit = {
                environment: spec.environment ?? {},
                providers: spec.providers ?? [],
                template: spec.image ? { image: spec.image } : undefined,
                resourceRequirements: spec.gpu ? { gpu: {} } : undefined,
                policy: spec.policy,
                command: spec.command ?? [],
                tty: spec.tty ?? false,
                restartPolicy: restartPolicyValue(spec.restartPolicy),
            };
            if (spec.rawSpec)
                Object.assign(specInit, spec.rawSpec);
            const resp = await this.grpc.createSandbox({
                workspaceScope: workspaceScope(spec),
                name: spec.name ?? '',
                labels: spec.labels ?? {},
                spec: specInit,
                serviceExposures: spec.serviceExposures?.map((exposure) => ({
                    service: exposure.service ?? '',
                    targetPort: exposure.targetPort,
                    authorizationMode: serviceAuthorizationModeToProto(exposure.authorizationMode),
                })) ?? [],
            });
            return sandboxRef(resp.sandbox, resp.serviceUrls);
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    async createFromTemplate(spec) {
        if (spec.workloadTemplate.trim() === '')
            throw new SdkError('invalid_config', 'workloadTemplate is required');
        try {
            const resp = await this.grpc.createSandbox({
                workspaceScope: workspaceScope(spec),
                name: spec.name ?? '',
                labels: spec.labels ?? {},
                spec: {
                    providers: spec.providers ?? [],
                    command: spec.command ?? [],
                    tty: spec.tty ?? false,
                    policy: spec.policy,
                },
                workloadTemplate: spec.workloadTemplate,
                serviceExposures: spec.serviceExposures?.map((exposure) => ({
                    service: exposure.service ?? '',
                    targetPort: exposure.targetPort,
                    authorizationMode: serviceAuthorizationModeToProto(exposure.authorizationMode),
                })) ?? [],
            });
            return sandboxRef(resp.sandbox, resp.serviceUrls);
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    async get(name, options) {
        try {
            const resp = await this.grpc.getSandbox({ ...namedTarget(name, options) }, requestCallOptions(options));
            return sandboxRef(resp.sandbox);
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    list(options) {
        return new Pager(async (pageToken) => {
            try {
                const resp = await this.grpc.listSandboxes({
                    pageSize: options?.pageSize ?? 0,
                    pageToken,
                    labelSelector: options?.labelSelector ?? '',
                    workspaceScope: listWorkspaceScope(options),
                });
                return {
                    items: resp.sandboxes.map((sandbox) => sandboxRef(sandbox)),
                    nextPageToken: resp.nextPageToken,
                };
            }
            catch (e) {
                throw fromConnect(e);
            }
        }, options?.pageToken ?? '');
    }
    /** List and collect every sandbox in this scope. */
    async listAll(options) {
        return this.list(options).all();
    }
    async delete(name, options) {
        try {
            const resp = await this.grpc.deleteSandbox({
                ...namedTarget(name, options),
                allowMissing: options?.allowMissing ?? false,
            });
            return deletionResult(resp);
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    // Poll until the sandbox is ready. The timeout bounds the returned promise,
    // not just the sleep loop: each poll RPC carries the remaining deadline (and
    // any caller signal), so a stalled get() is aborted rather than hanging.
    async waitReady(name, timeoutSecs, options) {
        const deadline = Date.now() + timeoutSecs * 1000;
        const signal = options?.signal;
        let delay = 250;
        for (;;) {
            if (signal?.aborted)
                throw new SdkError('connect', `wait for sandbox '${name}' aborted`);
            if (Date.now() >= deadline)
                throw new SdkError('connect', `timed out waiting for sandbox '${name}'`);
            let ref;
            const pollOptions = deadlineOptions(deadline - Date.now(), signal);
            try {
                ref = await this.get(name, {
                    ...pollOptions,
                    workspace: options?.workspace,
                });
            }
            catch (e) {
                throw mapWaitError(e, name, deadline, signal, pollOptions.signal);
            }
            if (ref.phase === 'ready' || ref.phase === 'completed')
                return ref;
            if (ref.phase === 'stopped')
                throw new SdkError('connect', `sandbox '${name}' stopped before becoming ready`);
            if (ref.phase === 'error')
                throw new SdkError('connect', `sandbox '${name}' entered error phase`);
            if (Date.now() >= deadline)
                throw new SdkError('connect', `timed out waiting for sandbox '${name}'`);
            await waitSleep(delay, deadline, signal);
            delay = Math.min(delay * 2, 2000);
        }
    }
    // Poll until the sandbox is gone, or its name resolves to a different ID when
    // expectedSandboxId is supplied. Timeout and cancellation work as in waitReady.
    async waitDeleted(name, timeoutSecs, options) {
        const deadline = Date.now() + timeoutSecs * 1000;
        const signal = options?.signal;
        let delay = 250;
        for (;;) {
            if (signal?.aborted)
                throw new SdkError('connect', `wait for sandbox '${name}' aborted`);
            if (Date.now() >= deadline)
                throw new SdkError('connect', `timed out waiting for sandbox '${name}' to delete`);
            const pollOptions = deadlineOptions(deadline - Date.now(), signal);
            try {
                const ref = await this.get(name, { ...pollOptions, workspace: options?.workspace });
                if (options?.expectedSandboxId !== undefined && ref.id !== options.expectedSandboxId)
                    return;
            }
            catch (e) {
                if (e instanceof SdkError && e.code === 'not_found')
                    return;
                throw mapWaitError(e, name, deadline, signal, pollOptions.signal);
            }
            if (Date.now() >= deadline)
                throw new SdkError('connect', `timed out waiting for sandbox '${name}' to delete`);
            await waitSleep(delay, deadline, signal);
            delay = Math.min(delay * 2, 2000);
        }
    }
    // Stream stdout/stderr as they arrive, then a terminal exit event. The exit
    // is yielded in-band (not returned) so `for await` consumers cannot silently
    // discard it: a failing command is impossible to miss. If the gateway closes
    // the stream without an exit event, this throws. `exec()` drains this same
    // path to reconstruct the buffered result.
    async *execStream(name, command, options) {
        try {
            // Preserve the existing preflight so lookup failures surface before the stream starts.
            await this.get(name, {
                workspace: options?.workspace,
                ...(options?.signal ? { signal: options.signal } : {}),
            });
            const stream = this.grpc.execSandbox({
                ...sandboxTarget(name, options),
                command,
                workdir: options?.workdir ?? '',
                environment: options?.environment ?? {},
                executionTimeout: durationFromSeconds(options?.timeoutSecs ?? 0),
                stdin: options?.stdin ? new Uint8Array(options.stdin) : new Uint8Array(),
                tty: false,
                noLoginShell: options?.noLoginShell ?? false,
            }, { signal: options?.signal });
            let sawExit = false;
            for await (const event of stream) {
                switch (event.payload.case) {
                    case 'stdout':
                        yield {
                            stream: 'stdout',
                            data: Buffer.from(event.payload.value.data),
                        };
                        break;
                    case 'stderr':
                        yield {
                            stream: 'stderr',
                            data: Buffer.from(event.payload.value.data),
                        };
                        break;
                    case 'exit':
                        sawExit = true;
                        yield { type: 'exit', exitCode: event.payload.value.exitCode };
                        break;
                }
            }
            if (!sawExit)
                throw new SdkError('rpc', 'ExecSandbox stream ended without an exit event');
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
    }
    async exec(name, command, options) {
        const stdout = [];
        const stderr = [];
        let exitCode;
        for await (const event of this.execStream(name, command, options)) {
            if ('type' in event) {
                exitCode = event.exitCode;
            }
            else if (event.stream === 'stdout') {
                stdout.push(event.data);
            }
            else {
                stderr.push(event.data);
            }
        }
        if (exitCode === undefined)
            throw new SdkError('rpc', 'ExecSandbox stream ended without an exit event');
        return {
            exitCode,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
        };
    }
    /**
     * Watch a sandbox's log lines and platform events with loss-aware resume.
     *
     * Reconnects transparently on a transient stream drop, resuming from the
     * highest cursor already delivered. A recoverable server-side lag surfaces
     * as a `{ kind: 'warning' }` item and the stream continues.
     *
     * An `SdkError` with `connectCode === Code.OutOfRange` is terminal and not
     * retried: the resume point is gone (trimmed from the buffer, or issued by a
     * cursor space the gateway no longer has), so events between it and now are
     * unrecoverable. Auto-restarting from scratch would hide that loss, which is
     * exactly what this method exists to surface. Callers who accept the gap can
     * start a new watch with an empty `resumeAfterCursor`; retrying the same
     * cursor fails identically.
     */
    async *watchLogs(name, options) {
        let ref;
        try {
            ref = await this.get(name, {
                workspace: options?.workspace,
                ...(options?.signal ? { signal: options.signal } : {}),
            });
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
        const signal = options?.signal;
        let followLogs = options?.followLogs ?? false;
        const followEvents = options?.followEvents ?? false;
        // With both resolved false — whether from an explicit `false` or from
        // omitting both options — the request would stream nothing and never
        // complete or error. Mirror the Go SDK's guard and default to logs, since
        // that footgun is worse than this one-line divergence from Rust's bare
        // pass-through default.
        if (!followLogs && !followEvents)
            followLogs = true;
        let cursor = options?.resumeAfterCursor ?? '';
        let backoffMs = 100;
        for (;;) {
            if (signal?.aborted)
                throw new SdkError('canceled', 'watchLogs aborted');
            // connect-es returns this AsyncIterable synchronously and unconditionally;
            // the stream only opens on first iteration, so "dial" and "drain" failures
            // both land in the single catch below (unlike tonic's separate Result).
            const stream = this.grpc.watchSandbox({
                ...sandboxTarget(ref.name, options),
                followStatus: false,
                followLogs,
                followEvents,
                logTailLines: options?.logTailLines ?? 0,
                eventTail: options?.eventTail ?? 0,
                logSources: options?.logSources ?? [],
                logMinLevel: options?.logMinLevel ?? '',
                resumeAfterCursor: cursor,
            }, { signal });
            let cleanEof = true;
            try {
                for await (const wireEvent of stream) {
                    // A delivered event means the connection is healthy again; reset the
                    // backoff so a later drop retries promptly instead of at the cap.
                    backoffMs = 100;
                    const converted = convertWatchEvent(wireEvent, cursor);
                    cursor = converted.cursor;
                    if (converted.event)
                        yield converted.event;
                }
            }
            catch (e) {
                cleanEof = false;
                const err = e instanceof SdkError ? e : fromConnect(e);
                if (!isRetryableWatchLogsError(err))
                    throw err;
                await watchLogsBackoffSleep(backoffMs, signal);
                backoffMs = Math.min(backoffMs * 2, 2000);
            }
            if (cleanEof)
                break;
        }
    }
    // TTY + stdin transport half of an interactive exec. The first client frame
    // is the `start` variant carrying the exec request; subsequent frames are
    // `stdin`/`resize`. No terminal glue: raw mode, signal forwarding, and
    // SIGWINCH stay with the caller.
    async execInteractive(name, command, options) {
        try {
            await this.get(name, { workspace: options?.workspace, ...(options?.signal ? { signal: options.signal } : {}) });
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
        const input = new Pushable();
        input.push({
            payload: {
                case: 'start',
                value: {
                    ...sandboxTarget(name, options),
                    command,
                    workdir: options?.workdir ?? '',
                    environment: options?.environment ?? {},
                    executionTimeout: durationFromSeconds(options?.timeoutSecs ?? 0),
                    stdin: new Uint8Array(),
                    tty: options?.tty ?? true,
                    cols: options?.cols ?? 0,
                    rows: options?.rows ?? 0,
                    noLoginShell: options?.noLoginShell ?? false,
                },
            },
        });
        const controller = new AbortController();
        const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
        const grpc = this.grpc;
        const queue = new ExecOutputQueue();
        let inputClosed = false;
        let exitCode;
        const closeInput = () => {
            inputClosed = true;
            input.end();
        };
        const assertInputOpen = () => {
            if (inputClosed || signal.aborted)
                throw new SdkError('io', 'exec input is closed');
        };
        let resolveDone;
        let rejectDone;
        const done = new Promise((resolve, reject) => {
            resolveDone = resolve;
            rejectDone = reject;
        });
        // `done` may settle before (or without) anyone awaiting it. A lone handler
        // keeps an unobserved rejection from surfacing as an unhandledRejection;
        // real awaiters still receive it through their own handler.
        void done.catch(() => { });
        // The process exit and the terminal transport status are separate outcomes.
        let settled = false;
        const settleExit = (code) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolveDone(code);
        };
        const settleError = (err) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            rejectDone(err);
        };
        const onAbort = () => {
            closeInput();
            const error = new SdkError('canceled', 'exec cancelled');
            queue.end(error, true);
            settleError(error);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted)
            onAbort();
        async function receive() {
            try {
                if (signal.aborted)
                    throw new SdkError('canceled', 'exec cancelled');
                // Start and observe the transport immediately, independently of output
                // consumption. Backpressure bounds the queue to 16 chunks of 64 KiB.
                const stream = grpc.execSandboxInteractive(input, { signal });
                for await (const event of stream) {
                    if (signal.aborted)
                        throw new SdkError('canceled', 'exec cancelled');
                    if (exitCode !== undefined) {
                        throw new SdkError('rpc', 'ExecSandboxInteractive received an event after exit');
                    }
                    switch (event.payload.case) {
                        case 'stdout':
                        case 'stderr':
                            for (let offset = 0; offset < event.payload.value.data.length; offset += 64 * 1024) {
                                await queue.push({
                                    stream: event.payload.case,
                                    data: Buffer.from(event.payload.value.data.subarray(offset, offset + 64 * 1024)),
                                });
                            }
                            break;
                        case 'exit':
                            exitCode = event.payload.value.exitCode;
                            closeInput();
                            break;
                        default:
                            throw new SdkError('rpc', 'ExecSandboxInteractive received an empty or unknown event');
                    }
                }
                if (exitCode === undefined) {
                    throw new SdkError('rpc', 'ExecSandboxInteractive stream ended without an exit event');
                }
                if (signal.aborted)
                    throw new SdkError('canceled', 'exec cancelled before completion');
                // Delay the public exit event until trailers have been consumed. A
                // caller can still break on exit without losing the terminal status.
                settleExit(exitCode);
                await queue.push({ type: 'exit', exitCode });
                queue.end();
            }
            catch (e) {
                const err = e instanceof SdkError ? e : fromConnect(e);
                settleError(err);
                queue.end(err);
            }
            finally {
                closeInput();
                controller.abort();
            }
        }
        // receive catches transport failures even when nobody consumes output/done.
        const receiving = receive();
        async function* output() {
            try {
                yield* queue;
            }
            finally {
                const error = new SdkError('rpc', 'exec output abandoned before completion');
                settleError(error);
                queue.end(error, true);
                closeInput();
                controller.abort();
                await receiving;
            }
        }
        return {
            output: output(),
            write(data) {
                assertInputOpen();
                input.push({ payload: { case: 'stdin', value: new Uint8Array(data) } });
            },
            resize(cols, rows) {
                assertInputOpen();
                input.push({ payload: { case: 'resize', value: { cols, rows } } });
            },
            closeInput,
            close: closeInput,
            cancel() {
                closeInput();
                queue.end(new SdkError('canceled', 'exec cancelled'), true);
                controller.abort();
                settleError(new SdkError('canceled', 'exec cancelled'));
            },
            get exitCode() {
                return exitCode;
            },
            done,
        };
    }
    // Bind a local TCP listener that tunnels each accepted connection into the
    // sandbox. Mirrors the CLI service forward: READY check, then per socket mint
    // a short-lived SSH session token, open a forwardTcp bidi whose first frame is
    // the `init` (TCP target + token), relay bytes both ways in ~64 KiB chunks,
    // and revoke the token on close. Process-lifetime only.
    async forward(name, opts) {
        const targetHost = opts.targetHost ?? '127.0.0.1';
        const targetPort = opts.targetPort;
        const localHost = opts.localHost ?? '127.0.0.1';
        const localPort = opts.localPort ?? 0;
        let sandboxId;
        try {
            const ref = await this.get(name, { workspace: opts.workspace, ...(opts.signal ? { signal: opts.signal } : {}) });
            if (ref.phase !== 'ready') {
                throw new SdkError('connect', `sandbox '${name}' is not ready (phase: ${ref.phase})`);
            }
            sandboxId = ref.id;
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
        const sockets = new Set();
        const controllers = new Set();
        const connectionTasks = new Set();
        let closing = false;
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            // Guard the window before forwardConnection attaches its own handlers
            // (it first awaits createSshSession). Without a synchronous 'error'
            // listener a peer reset here emits an unhandled 'error' and crashes the
            // process; forwardConnection's catch still tears the socket down.
            socket.on('error', () => { });
            const controller = new AbortController();
            controllers.add(controller);
            const task = this.forwardConnection(socket, sandboxId, name, opts.workspace, targetHost, targetPort, controller.signal)
                .catch((error) => {
                if (!closing) {
                    try {
                        opts.onConnectionError?.(error instanceof SdkError ? error : fromConnect(error));
                    }
                    catch {
                        // Consumer callbacks must not turn a handled connection failure
                        // into an unhandled rejection or prevent forward cleanup.
                    }
                }
            })
                .finally(() => {
                controllers.delete(controller);
                connectionTasks.delete(task);
            });
            connectionTasks.add(task);
        });
        let resolveClosed;
        const closed = new Promise((resolve) => {
            resolveClosed = resolve;
        });
        await new Promise((resolve, reject) => {
            const onError = (err) => {
                reject(new SdkError('io', `failed to bind local forward on ${localHost}:${localPort}: ${err instanceof Error ? err.message : String(err)}`));
            };
            server.once('error', onError);
            server.listen(localPort, localHost, () => {
                server.removeListener('error', onError);
                resolve();
            });
        });
        let teardownPromise;
        const onAbort = () => {
            void teardown();
        };
        const teardown = () => {
            if (teardownPromise)
                return teardownPromise;
            closing = true;
            opts.signal?.removeEventListener('abort', onAbort);
            teardownPromise = (async () => {
                for (const controller of controllers)
                    controller.abort();
                for (const socket of sockets)
                    socket.destroy();
                if (server.listening) {
                    await new Promise((resolve) => server.close(() => resolve()));
                }
                await Promise.allSettled([...connectionTasks]);
                resolveClosed();
            })();
            return teardownPromise;
        };
        // Caller cancellation tears the local listener down the same way close() does.
        if (opts.signal) {
            if (opts.signal.aborted)
                void teardown();
            else
                opts.signal.addEventListener('abort', onAbort, { once: true });
        }
        const addr = server.address();
        return {
            localHost,
            localPort: addr ? addr.port : localPort,
            targetHost,
            targetPort,
            close: teardown,
            closed,
        };
    }
    async forwardConnection(socket, sandboxId, name, workspace, targetHost, targetPort, signal) {
        let token;
        const input = new Pushable();
        input.onDrain = () => socket.resume();
        try {
            const session = await this.grpc.createSshSession({ ...sandboxTarget(name, { workspace }) }, { signal });
            // Defense-in-depth: the token feeds forwardTcp authorization, so hold it
            // to the same trust-boundary contract as createSshSession. A violation
            // tears down this one socket via the catch below.
            validateSshResponse(session, sandboxId);
            token = session.token;
            input.push({
                payload: {
                    case: 'init',
                    value: {
                        ...sandboxTarget(name, { workspace }),
                        serviceId: `service-forward:${name}:${targetHost}:${targetPort}`,
                        target: {
                            case: 'tcp',
                            value: { host: targetHost, port: targetPort },
                        },
                        authorizationToken: token,
                    },
                },
            });
            socket.on('data', (chunk) => {
                for (let off = 0; off < chunk.length; off += FORWARD_CHUNK) {
                    const slice = chunk.subarray(off, Math.min(off + FORWARD_CHUNK, chunk.length));
                    input.push({
                        payload: { case: 'data', value: new Uint8Array(slice) },
                    });
                }
                if (input.size >= 64)
                    socket.pause();
            });
            socket.on('end', () => input.end());
            socket.on('error', (error) => input.end(error));
            socket.on('close', () => input.end());
            const onAbort = () => {
                input.end(new SdkError('canceled', 'forward connection closed'));
                socket.destroy();
            };
            signal.addEventListener('abort', onAbort, { once: true });
            try {
                for await (const frame of this.grpc.forwardTcp(input, { signal })) {
                    if (frame.payload.case !== 'data')
                        continue;
                    const data = frame.payload.value;
                    if (data.length === 0)
                        continue;
                    // Respect backpressure: if the local socket buffer is full, stop
                    // pulling sandbox data until it drains so memory stays bounded.
                    if (!socket.write(Buffer.from(data)))
                        await waitForDrain(socket);
                }
            }
            finally {
                signal.removeEventListener('abort', onAbort);
            }
            socket.end();
        }
        catch (e) {
            socket.destroy();
            throw e instanceof SdkError ? e : fromConnect(e);
        }
        finally {
            input.end();
            if (token !== undefined) {
                try {
                    await this.grpc.revokeSshSession({ token, allowMissing: true }, { signal });
                }
                catch {
                    // Best-effort revoke; the token expires on its own regardless.
                }
            }
        }
    }
    // Mint a short-lived SSH session token for the sandbox — the input side of
    // ssh-config / ProxyCommand and forwardTcp authorization.
    async createSshSession(name, options) {
        try {
            const sandbox = await this.get(name, options);
            const resp = await this.grpc.createSshSession({ ...sandboxTarget(name, options) });
            // Reject any response outside the proto trust-boundary contract before
            // handing these values to the caller (they feed OpenSSH ProxyCommand).
            validateSshResponse(resp, sandbox.id);
            return {
                sandboxId: resp.sandboxId,
                token: resp.token,
                gatewayHost: resp.gatewayHost,
                gatewayPort: resp.gatewayPort,
                gatewayScheme: resp.gatewayScheme,
                ...(resp.hostKeyFingerprint ? { hostKeyFingerprint: resp.hostKeyFingerprint } : {}),
                ...(timestampMillis(resp.expirationTime) ? { expiresAtMs: timestampMillis(resp.expirationTime) } : {}),
            };
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
    }
    async revokeSshSession(token, options) {
        try {
            const resp = await this.grpc.revokeSshSession({ token, allowMissing: options?.allowMissing ?? false });
            return deletionResult(resp);
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    async attachProvider(name, provider, options) {
        try {
            const resp = await this.grpc.attachSandboxProvider({
                ...sandboxTarget(name, options),
                provider,
                expectedResourceVersion: versionPin(options?.expectedResourceVersion),
            });
            return { sandbox: sandboxRef(resp.sandbox), changed: resp.attached };
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    async detachProvider(name, provider, options) {
        try {
            const resp = await this.grpc.detachSandboxProvider({
                ...sandboxTarget(name, options),
                provider,
                expectedResourceVersion: versionPin(options?.expectedResourceVersion),
            });
            return { sandbox: sandboxRef(resp.sandbox), changed: resp.detached };
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    listProviders(name, options) {
        return new Pager(async (pageToken) => {
            try {
                const resp = await this.grpc.listSandboxProviders({
                    ...sandboxTarget(name, options),
                    pageSize: options?.pageSize ?? 0,
                    pageToken,
                });
                return {
                    items: resp.providers.map((provider) => providerRef(provider)),
                    nextPageToken: resp.nextPageToken,
                };
            }
            catch (e) {
                throw fromConnect(e);
            }
        }, options?.pageToken ?? '');
    }
    /** List and collect every provider attached to this sandbox. */
    async listAllProviders(name, options) {
        return this.listProviders(name, options).all();
    }
    async getConfig(name, options) {
        try {
            await this.get(name, options);
            const resp = await this.grpc.getSandboxConfig({ ...namedTarget(name, options) }, requestCallOptions(options));
            return sandboxConfig(resp);
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
    }
    // Update the sandbox-scoped policy. Sandbox scope (global=false) may only
    // change network_policies; static fields must match the create-time policy or
    // the gateway rejects the update. With `wait`, poll getConfig until the
    // applied policy hash is observed.
    async setPolicy(name, policy, options) {
        try {
            const resp = await this.grpc.updateConfig({
                ...sandboxTarget(name, options),
                policy,
                global: false,
                expectedResourceVersion: versionPin(options?.expectedResourceVersion),
            });
            const result = updateConfigResult(resp);
            if (options?.wait)
                await this.waitForPolicyHash(name, result.policyHash, options.waitTimeoutSecs, options.workspace);
            return result;
        }
        catch (e) {
            throw e instanceof SdkError ? e : fromConnect(e);
        }
    }
    // Upsert a single sandbox-scoped setting. Sandbox-scoped deletes are rejected
    // by the gateway, so there is no sandbox-scoped delete on this surface.
    async setSetting(name, key, value, options) {
        try {
            const resp = await this.grpc.updateConfig({
                ...sandboxTarget(name, options),
                settingKey: key,
                settingValue: value,
                global: false,
            });
            return updateConfigResult(resp);
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
    // Poll getConfig until the applied policy hash is observed. Each poll RPC is
    // bounded by the remaining deadline (deadlineOptions), so a stalled getConfig
    // cannot make the returned promise outlive timeoutSecs.
    async waitForPolicyHash(name, policyHash, timeoutSecs = 60, workspace) {
        const deadline = Date.now() + timeoutSecs * 1000;
        let delay = 100;
        for (;;) {
            let config;
            const pollOptions = deadlineOptions(deadline - Date.now());
            try {
                config = await this.getConfig(name, { ...pollOptions, workspace });
            }
            catch (e) {
                if (pollOptions.signal?.aborted || Date.now() >= deadline) {
                    throw new SdkError('connect', `timed out waiting for policy '${policyHash}' on sandbox '${name}'`);
                }
                throw e instanceof SdkError ? e : fromConnect(e);
            }
            if (config.policyHash === policyHash)
                return;
            if (Date.now() >= deadline) {
                throw new SdkError('connect', `timed out waiting for policy '${policyHash}' on sandbox '${name}'`);
            }
            await waitSleep(delay, deadline);
            delay = Math.min(delay * 2, 2000);
        }
    }
}
// ---- The client ------------------------------------------------------------
export class OpenShellClient {
    /** Sandbox lifecycle + exec: create/get/list/delete, waitReady/waitDeleted, exec. */
    sandbox;
    /** Reusable sandbox workload template lifecycle. */
    sandboxTemplates;
    /** Privileged provider credential retrieval; requires direct operator mTLS. */
    providers;
    /**
     * Advanced escape hatch: a generated client for every gateway RPC, including
     * surface the curated sub-clients do not wrap yet (gateway config, provider
     * CRUD, policy status, watch, logs, and the full observed Sandbox). See
     * '@nvidia/openshell-sdk/raw' for the generated request/response types.
     */
    raw;
    /** The shared Connect transport, for building extra clients over the same connection. */
    transport;
    grpc;
    constructor(transport) {
        // One transport (one connection) shared across every scoped client.
        this.transport = transport;
        this.grpc = createClient(OpenShell, transport);
        this.raw = this.grpc;
        this.sandbox = new SandboxClient(transport, this.grpc);
        this.sandboxTemplates = new SandboxTemplateClient(transport, this.grpc);
        this.providers = new ProviderClient(transport);
    }
    /**
     * Constructs a lazy Connect client. No network request is made until the
     * first RPC; call health() when startup must verify gateway reachability.
     */
    static async connect(options) {
        return new OpenShellClient(buildTransport(options));
    }
    // Gateway-scoped, so it stays top-level rather than under a namespace.
    async health() {
        try {
            const resp = await this.grpc.health({});
            return { status: statusName(resp.status), version: resp.version };
        }
        catch (e) {
            throw fromConnect(e);
        }
    }
}
//# sourceMappingURL=client.js.map