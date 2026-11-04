import type { MessageInitShape } from '@bufbuild/protobuf';
import { type CallOptions, type Client, type Transport } from '@connectrpc/connect';
import { errorCode, SdkError } from './errors.js';
import type { SandboxWorkloadTemplate } from './gen/openshell_pb.js';
import { type ExecSandboxInputSchema, OpenShell, SandboxPhase, type SandboxSpecSchema, type SandboxWorkloadTemplateSchema, ServiceStatus, type TcpForwardFrameSchema } from './gen/openshell_pb.js';
import type { SandboxPolicy, SettingValue } from './gen/sandbox_pb.js';
import { PolicySource, type SandboxPolicySchema, SettingScope, type SettingValueSchema } from './gen/sandbox_pb.js';
import { ProviderClient } from './providers.js';
import { type ConnectOptions } from './transport.js';
export type { SandboxResources, SandboxServiceLevel, SandboxStartup, SandboxWorkloadConfig, SandboxWorkloadTemplate, SandboxWorkloadTemplateSpec, } from './gen/openshell_pb.js';
export type { SandboxPolicy, SettingValue } from './gen/sandbox_pb.js';
export type { ConnectOptions };
export { errorCode };
/** Lowercase mirror of the generated `SandboxPhase` enum. Hand-maintained. */
export type SandboxPhaseName = 'unspecified' | 'provisioning' | 'ready' | 'error' | 'deleting' | 'unknown' | 'stopping' | 'stopped' | 'starting' | 'completed';
/** Restart behavior after the canonical main process exits. */
export type SandboxRestartPolicyName = 'never' | 'on-failure' | 'always';
/** Lowercase mirror of the generated `ServiceStatus` enum. Hand-maintained. */
export type HealthStatus = 'unspecified' | 'healthy' | 'degraded' | 'unhealthy';
/** Lowercase mirror of the generated `SettingScope` enum. Hand-maintained. */
export type SettingScopeName = 'unspecified' | 'sandbox' | 'global';
/** Lowercase mirror of the generated `PolicySource` enum. Hand-maintained. */
export type PolicySourceName = 'unspecified' | 'sandbox' | 'global';
export interface Health {
    status: HealthStatus;
    version: string;
}
export type DeletionOutcome = 'unspecified' | 'completed' | 'accepted' | 'already_absent' | 'unknown';
export interface DeletionResult {
    outcome: DeletionOutcome;
    /** Original enum number, including values introduced by a newer gateway. */
    rawOutcome: number;
    /** Original sandbox UUID; absent if no target existed or this is not a sandbox deletion. */
    sandboxId?: string;
}
export interface DeleteOptions extends SandboxWorkspaceOptions {
    allowMissing?: boolean;
}
export interface SandboxSpec {
    name?: string;
    /** Workspace name. Omit for `default`; empty strings are invalid. */
    workspace?: string;
    image?: string;
    labels?: Record<string, string>;
    environment?: Record<string, string>;
    providers?: string[];
    gpu?: boolean;
    /** Exact canonical command. Empty selects the gateway scratch shell. */
    command?: string[];
    /** Allocate a retained pseudo-terminal for the canonical command. */
    tty?: boolean;
    /** Loopback HTTP services to expose when the sandbox is created. */
    serviceExposures?: ServiceExposure[];
    /** Restart behavior after the canonical main process exits. */
    restartPolicy?: SandboxRestartPolicyName;
    /**
     * Create-time sandbox policy (the safety boundary). Sandbox-scoped
     * `setPolicy` cannot introduce static fields later, so express filesystem,
     * landlock, process, and initial network policy here.
     */
    policy?: MessageInitShape<typeof SandboxPolicySchema>;
    /**
     * Advanced escape hatch: the full generated proto spec. Curated fields build
     * the base spec, then `rawSpec` shallow-overrides at the top spec level, so
     * any field it sets wins. Use it to reach proto spec fields the curated shape
     * does not surface (template runtime class, resource limits, log level, and
     * future additions) without an SDK change.
     */
    rawSpec?: MessageInitShape<typeof SandboxSpecSchema>;
}
export interface ServiceExposure {
    /** Service name. Empty or omitted selects the unnamed endpoint. */
    service?: string;
    /** Loopback TCP port inside the sandbox. */
    targetPort: number;
    /** Handling for an incoming application Authorization header. */
    authorizationMode?: ServiceAuthorizationMode;
}
export declare enum ServiceAuthorizationMode {
    Strip = "strip",
    BearerPassthrough = "bearer_passthrough"
}
export interface SandboxFromTemplateSpec {
    name?: string;
    /** Workspace name. Omit for `default`; empty strings are invalid. */
    workspace?: string;
    workloadTemplate: string;
    labels?: Record<string, string>;
    providers?: string[];
    /** Exact canonical command. Empty selects the gateway scratch shell. */
    command?: string[];
    /** Allocate a retained pseudo-terminal for the canonical command. */
    tty?: boolean;
    /** Loopback HTTP services to expose when the sandbox is created. */
    serviceExposures?: ServiceExposure[];
    /**
     * Create-time sandbox policy (the safety boundary). The named workload
     * template supplies runtime workload fields.
     */
    policy?: MessageInitShape<typeof SandboxPolicySchema>;
}
export interface SandboxRef {
    id: string;
    name: string;
    workspace: string;
    phase: SandboxPhaseName;
    labels: Record<string, string>;
    /** u64 rendered as a string — JS numbers can't hold it safely. */
    resourceVersion: string;
    /** Stable SSH host identity; absent on older runtimes. */
    hostKeyFingerprint?: string;
    mainProcessInstanceId?: string;
    exitCode?: number;
    createdFromWorkloadTemplate?: SandboxWorkloadTemplateProvenance;
    /** Service URLs returned by creation, keyed by service name. */
    serviceUrls: Record<string, string>;
    restartCount: number;
    /** Creation time in epoch milliseconds; absent when the gateway omits it. */
    createdAtMs?: number;
    nextRestartAtMs?: number;
    mainProcessStartedAtMs?: number;
}
export interface SandboxWorkloadTemplateProvenance {
    name: string;
    resourceVersion: string;
}
interface PaginationOptions {
    /** Maximum resources requested per page. */
    pageSize?: number;
    /** Opaque token from a previous page. Omit to start at the beginning. */
    pageToken?: string;
    labelSelector?: string;
}
/** Mutually exclusive named/default or all-workspaces list scope. */
export type WorkspaceListScope = {
    workspace?: string;
    allWorkspaces?: false | undefined;
} | {
    workspace?: never;
    allWorkspaces: true;
};
export type ListOptions = PaginationOptions & WorkspaceListScope;
export interface SandboxWorkspaceOptions {
    /** Workspace name. Omit for `default`; empty strings are invalid. */
    workspace?: string;
}
/** Pagination and workspace scope for providers attached to one sandbox. */
export type SandboxProviderListOptions = SandboxWorkspaceOptions & {
    /** Maximum providers requested per page. */
    pageSize?: number;
    /** Opaque token from a previous page. Omit to start at the beginning. */
    pageToken?: string;
};
export type SandboxCallOptions = CallOptions & SandboxWorkspaceOptions;
export interface SandboxTemplateWorkspaceOptions {
    /** Workspace name. Omit for `default`; empty strings are invalid. */
    workspace?: string;
}
export type SandboxTemplateListOptions = WorkspaceListScope & {
    /** Maximum templates requested per page. */
    pageSize?: number;
    /** Opaque token from a previous page. Omit to start at the beginning. */
    pageToken?: string;
    /** Optional label selector in key=value comma-separated form. */
    labelSelector?: string;
};
export interface ExecOptions extends SandboxWorkspaceOptions {
    workdir?: string;
    environment?: Record<string, string>;
    timeoutSecs?: number;
    stdin?: Buffer;
    /**
     * Skip sourcing shell login/profile startup files before the command.
     * Defaults to `false`, which preserves login-shell behavior. Set `true` for
     * automation and managed checks that need predictable startup behavior.
     */
    noLoginShell?: boolean;
    /** Abort the exec (and the in-flight stream RPC) early. */
    signal?: AbortSignal;
}
export interface ExecResult {
    exitCode: number;
    stdout: Buffer;
    stderr: Buffer;
}
/** One stdout/stderr chunk yielded by `execStream`/`execInteractive`. */
export interface ExecStreamChunk {
    stream: 'stdout' | 'stderr';
    data: Buffer;
}
export interface ExecExitEvent {
    type: 'exit';
    exitCode: number;
}
/** An exec stream item: a stdout/stderr chunk or the terminal exit event. */
export type ExecStreamEvent = ExecStreamChunk | ExecExitEvent;
export interface ExecInteractiveOptions extends SandboxWorkspaceOptions {
    workdir?: string;
    environment?: Record<string, string>;
    timeoutSecs?: number;
    /** Request a pseudo-terminal (default true). */
    tty?: boolean;
    /** Initial terminal columns (0 = server default). */
    cols?: number;
    /** Initial terminal rows (0 = server default). */
    rows?: number;
    /**
     * Skip sourcing shell login/profile startup files before the command.
     * Defaults to `false`, which preserves login-shell behavior.
     */
    noLoginShell?: boolean;
    /** Abort the interactive exec (and the in-flight stream RPC) early. */
    signal?: AbortSignal;
}
export interface ExecInteractiveSession {
    output: AsyncIterable<ExecStreamEvent>;
    write(data: Buffer): void;
    resize(cols: number, rows: number): void;
    /** Close stdin and resize input while preserving output. */
    close(): void;
    done: Promise<number>;
}
/** Lifecycle controls available on SDK-created sessions. The base interface
 * retains its original members for existing custom sessions and wrappers. */
export interface ExecInteractiveSessionControl extends ExecInteractiveSession {
    /** Close stdin and resize input, preserving output until completion. */
    closeInput(): void;
    /** Cancel the RPC and stop receiving output. */
    cancel(): void;
    /** Observed process exit, retained even if final RPC completion fails. */
    readonly exitCode: number | undefined;
}
/** A curated log line delivered by `watchLogs`. */
export interface LogLine {
    sandboxId: string;
    /** Milliseconds since epoch. 0 if the wire timestamp was absent or unrepresentable. */
    timestampMs: number;
    level: string;
    target: string;
    message: string;
    /** Log source (e.g. `'gateway'`, `'sandbox'`). An empty wire value is normalized to `'gateway'`. */
    source: string;
    fields: Record<string, string>;
}
/** A curated platform (compute-backend) event delivered by `watchLogs`. */
export interface PlatformEvent {
    /** Milliseconds since epoch. 0 if the wire timestamp was absent or unrepresentable. */
    timestampMs: number;
    source: string;
    type: string;
    reason: string;
    message: string;
    metadata: Record<string, string>;
}
export interface WatchLogEvent {
    kind: 'log';
    line: LogLine;
    /** Opaque high-water-mark cursor. Feed back as `WatchOptions.resumeAfterCursor` to resume. */
    cursor: string;
}
export interface WatchPlatformEvent {
    kind: 'event';
    event: PlatformEvent;
    /** Opaque high-water-mark cursor. Feed back as `WatchOptions.resumeAfterCursor` to resume. */
    cursor: string;
}
/** Recoverable server-side loss notice. The stream continues; never advances the cursor. */
export interface WatchWarningEvent {
    kind: 'warning';
    message: string;
}
/** One item from `watchLogs`. Discriminate on `kind`. */
export type WatchEvent = WatchLogEvent | WatchPlatformEvent | WatchWarningEvent;
export interface WatchOptions extends SandboxWorkspaceOptions {
    /** Stream server/supervisor log lines. Defaults to `true` when neither this nor `followEvents` is set. */
    followLogs?: boolean;
    /** Stream platform (compute-backend) events. */
    followEvents?: boolean;
    /** Restrict to these log sources (e.g. `'gateway'`, `'sandbox'`). Omit or empty for no filter. */
    logSources?: string[];
    /** Minimum log level to include (e.g. `'INFO'`, `'WARN'`, `'ERROR'`). Omit for no filter. */
    logMinLevel?: string;
    /**
     * Opaque cursor to resume after, taken from a previous `WatchEvent`'s `cursor`.
     * Omit or leave empty to start from the tail. Do not construct or parse one.
     */
    resumeAfterCursor?: string;
    /** Replay the last N log lines (best-effort) before following. */
    logTailLines?: number;
    /** Replay the last N platform events (best-effort) before following. */
    eventTail?: number;
    /** Abort the watch (including any pending reconnect backoff) early. */
    signal?: AbortSignal;
}
/** Cancellation for the poll-based wait helpers. */
export interface WaitOptions extends SandboxWorkspaceOptions {
    /** Abort the wait (and the in-flight poll RPC) early. */
    signal?: AbortSignal;
}
export interface WaitDeletedOptions extends WaitOptions {
    /** Original ID from delete(). Complete on absence or a different ID; omit to wait for name absence. */
    expectedSandboxId?: string;
}
export interface ForwardOptions extends SandboxWorkspaceOptions {
    /** Loopback TCP port inside the sandbox to dial. */
    targetPort: number;
    /** Target host inside the sandbox (loopback only). Default 127.0.0.1. */
    targetHost?: string;
    /** Local port to bind. Default 0 (ephemeral). */
    localPort?: number;
    /** Local address to bind. Default 127.0.0.1. */
    localHost?: string;
    /** Abort forward setup and tear down the local listener early. */
    signal?: AbortSignal;
    /** Receives failures from individual accepted connections. */
    onConnectionError?: (error: SdkError) => void;
}
export interface ForwardHandle {
    localHost: string;
    localPort: number;
    targetHost: string;
    targetPort: number;
    close(): Promise<void>;
    closed: Promise<void>;
}
export interface SshSession {
    sandboxId: string;
    token: string;
    gatewayHost: string;
    gatewayPort: number;
    gatewayScheme: string;
    hostKeyFingerprint?: string;
    /** int64 ms-since-epoch rendered as a string; omitted when 0 (no expiry). */
    expiresAtMs?: string;
}
export interface ProviderRef {
    id: string;
    name: string;
    type: string;
    labels: Record<string, string>;
    /** u64 rendered as a string. */
    resourceVersion: string;
}
export interface ProviderChange {
    sandbox: SandboxRef;
    /** True when the attach/detach actually changed the attachment set. */
    changed: boolean;
}
export interface ProviderChangeOptions extends SandboxWorkspaceOptions {
    /** Pin the sandbox resource version for optimistic concurrency (u64 as string). */
    expectedResourceVersion?: string;
}
/** Effective value of one setting plus the scope it resolved from. */
export interface EffectiveSettingView {
    value?: SettingValue;
    /** 'unspecified' | 'sandbox' | 'global'. */
    scope: SettingScopeName;
}
export interface SandboxConfig {
    policy?: SandboxPolicy;
    version: number;
    policyHash: string;
    settings: Record<string, EffectiveSettingView>;
    /** u64 rendered as a string. */
    configRevision: string;
    /** 'unspecified' | 'sandbox' | 'global'. */
    policySource: PolicySourceName;
    globalPolicyVersion: number;
    /** u64 rendered as a string. */
    providerEnvRevision: string;
}
export interface SetPolicyOptions extends SandboxWorkspaceOptions {
    /** Pin the sandbox resource version for optimistic concurrency (u64 as string). */
    expectedResourceVersion?: string;
    /** Poll getConfig until the applied policy hash is observed. */
    wait?: boolean;
    /** Bound the `wait` poll (seconds). Default 60. */
    waitTimeoutSecs?: number;
}
export interface UpdateConfigResult {
    version: number;
    policyHash: string;
    /** u64 rendered as a string. */
    settingsRevision: string;
    deleted: boolean;
}
export declare const PHASE_NAMES: Record<SandboxPhase, SandboxPhaseName>;
export declare const STATUS_NAMES: Record<ServiceStatus, HealthStatus>;
export declare const SCOPE_NAMES: Record<SettingScope, SettingScopeName>;
export declare const POLICY_SOURCE_NAMES: Record<PolicySource, PolicySourceName>;
/**
 * Test-only seam for the `watchLogs` reconnect backoff delay. Not part of the
 * public API surface — not re-exported from index.ts. Call with no argument
 * to restore the real timer-based sleep.
 */
export declare function __setWatchLogsBackoffSleepForTests(fn?: (delayMs: number, signal?: AbortSignal) => Promise<void>): void;
export declare class Pushable<T> implements AsyncIterable<T> {
    private readonly queue;
    private readonly waiting;
    private ended;
    private error;
    onDrain?: () => void;
    get size(): number;
    push(value: T): void;
    end(error?: unknown): void;
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
/** One response page from a list operation. */
export interface Page<T> {
    readonly items: T[];
    readonly nextPageToken: string;
}
/** Lazy, single-pass iterator that fetches one RPC page per advance. */
export declare class Pager<T> implements AsyncIterable<Page<T>> {
    private readonly fetch;
    private readonly maxConsumedTokens;
    private readonly maxConsumedTokenBytes;
    private nextToken;
    private readonly consumedTokens;
    private consumedTokenBytes;
    constructor(fetch: (pageToken: string) => Promise<Page<T>>, pageToken?: string, maxConsumedTokens?: number, maxConsumedTokenBytes?: number);
    private validateCurrentTokenBudget;
    /** Fetch the next page, or return undefined after the final page. */
    nextPage(): Promise<Page<T> | undefined>;
    /** Consume the pager and collect every remaining item. */
    all(): Promise<T[]>;
    [Symbol.asyncIterator](): AsyncIterator<Page<T>>;
}
export declare class SandboxTemplateClient {
    private readonly grpc;
    readonly raw: Client<typeof OpenShell>;
    readonly transport: Transport;
    constructor(transport: Transport, grpc?: Client<import("@bufbuild/protobuf/codegenv2").GenService<{
        health: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").HealthRequestSchema;
            output: typeof import("./gen/openshell_pb.js").HealthResponseSchema;
        };
        getCurrentUser: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetCurrentUserRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetCurrentUserResponseSchema;
        };
        getGatewayInfo: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetGatewayInfoRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetGatewayInfoResponseSchema;
        };
        createSandbox: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").CreateSandboxRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SandboxResponseSchema;
        };
        beginRootfsTarStaging: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").BeginRootfsTarStagingRequestSchema;
            output: typeof import("./gen/openshell_pb.js").BeginRootfsTarStagingResponseSchema;
        };
        getSandbox: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetSandboxRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SandboxResponseSchema;
        };
        listSandboxes: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListSandboxesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListSandboxesResponseSchema;
        };
        createSandboxTemplate: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").CreateSandboxTemplateRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SandboxTemplateResponseSchema;
        };
        getSandboxTemplate: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetSandboxTemplateRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SandboxTemplateResponseSchema;
        };
        listSandboxTemplates: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListSandboxTemplatesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListSandboxTemplatesResponseSchema;
        };
        deleteSandboxTemplate: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DeleteSandboxTemplateRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DeleteSandboxTemplateResponseSchema;
        };
        listSandboxProviders: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListSandboxProvidersRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListSandboxProvidersResponseSchema;
        };
        attachSandboxProvider: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").AttachSandboxProviderRequestSchema;
            output: typeof import("./gen/openshell_pb.js").AttachSandboxProviderResponseSchema;
        };
        detachSandboxProvider: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DetachSandboxProviderRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DetachSandboxProviderResponseSchema;
        };
        getSandboxProviderStatus: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetSandboxProviderStatusRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetSandboxProviderStatusResponseSchema;
        };
        deleteSandbox: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DeleteSandboxRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DeleteSandboxResponseSchema;
        };
        stopSandbox: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").StopSandboxRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SandboxResponseSchema;
        };
        startSandbox: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").StartSandboxRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SandboxResponseSchema;
        };
        createSshSession: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").CreateSshSessionRequestSchema;
            output: typeof import("./gen/openshell_pb.js").CreateSshSessionResponseSchema;
        };
        exposeService: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ExposeServiceRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ServiceEndpointResponseSchema;
        };
        getService: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetServiceRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ServiceEndpointResponseSchema;
        };
        listServices: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListServicesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListServicesResponseSchema;
        };
        deleteService: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DeleteServiceRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DeleteServiceResponseSchema;
        };
        revokeSshSession: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").RevokeSshSessionRequestSchema;
            output: typeof import("./gen/openshell_pb.js").RevokeSshSessionResponseSchema;
        };
        execSandbox: {
            methodKind: "server_streaming";
            input: typeof import("./gen/openshell_pb.js").ExecSandboxRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ExecSandboxEventSchema;
        };
        forwardTcp: {
            methodKind: "bidi_streaming";
            input: typeof TcpForwardFrameSchema;
            output: typeof TcpForwardFrameSchema;
        };
        execSandboxInteractive: {
            methodKind: "bidi_streaming";
            input: typeof ExecSandboxInputSchema;
            output: typeof import("./gen/openshell_pb.js").ExecSandboxEventSchema;
        };
        createProvider: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").CreateProviderRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ProviderResponseSchema;
        };
        getProvider: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetProviderRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ProviderResponseSchema;
        };
        getProviderCredentials: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetProviderCredentialsRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetProviderCredentialsResponseSchema;
        };
        listProviders: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListProvidersRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListProvidersResponseSchema;
        };
        listProviderProfiles: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListProviderProfilesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListProviderProfilesResponseSchema;
        };
        getProviderProfile: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetProviderProfileRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ProviderProfileResponseSchema;
        };
        importProviderProfiles: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ImportProviderProfilesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ImportProviderProfilesResponseSchema;
        };
        updateProviderProfiles: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").UpdateProviderProfilesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").UpdateProviderProfilesResponseSchema;
        };
        lintProviderProfiles: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").LintProviderProfilesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").LintProviderProfilesResponseSchema;
        };
        updateProvider: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").UpdateProviderRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ProviderResponseSchema;
        };
        getProviderRefreshStatus: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetProviderRefreshStatusRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetProviderRefreshStatusResponseSchema;
        };
        configureProviderRefresh: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ConfigureProviderRefreshRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ConfigureProviderRefreshResponseSchema;
        };
        rotateProviderCredential: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").RotateProviderCredentialRequestSchema;
            output: typeof import("./gen/openshell_pb.js").RotateProviderCredentialResponseSchema;
        };
        deleteProviderRefresh: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DeleteProviderRefreshRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DeleteProviderRefreshResponseSchema;
        };
        deleteProvider: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DeleteProviderRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DeleteProviderResponseSchema;
        };
        deleteProviderProfile: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DeleteProviderProfileRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DeleteProviderProfileResponseSchema;
        };
        getSandboxConfig: {
            methodKind: "unary";
            input: typeof import("./gen/sandbox_pb.js").GetSandboxConfigRequestSchema;
            output: typeof import("./gen/sandbox_pb.js").GetSandboxConfigResponseSchema;
        };
        getGatewayConfig: {
            methodKind: "unary";
            input: typeof import("./gen/sandbox_pb.js").GetGatewayConfigRequestSchema;
            output: typeof import("./gen/sandbox_pb.js").GetGatewayConfigResponseSchema;
        };
        updateConfig: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").UpdateConfigRequestSchema;
            output: typeof import("./gen/openshell_pb.js").UpdateConfigResponseSchema;
        };
        getSandboxPolicyStatus: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetSandboxPolicyStatusRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetSandboxPolicyStatusResponseSchema;
        };
        listSandboxPolicies: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListSandboxPoliciesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListSandboxPoliciesResponseSchema;
        };
        reportPolicyStatus: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ReportPolicyStatusRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ReportPolicyStatusResponseSchema;
        };
        reportEndpointStatus: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ReportEndpointStatusRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ReportEndpointStatusResponseSchema;
        };
        reportProviderReadiness: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ReportProviderReadinessRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ReportProviderReadinessResponseSchema;
        };
        reportSandboxConfiguration: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ReportSandboxConfigurationRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ReportSandboxConfigurationResponseSchema;
        };
        getSandboxProviderEnvironment: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetSandboxProviderEnvironmentRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetSandboxProviderEnvironmentResponseSchema;
        };
        exchangeProviderSubjectToken: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ExchangeProviderSubjectTokenRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ExchangeProviderSubjectTokenResponseSchema;
        };
        getSandboxLogs: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetSandboxLogsRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetSandboxLogsResponseSchema;
        };
        pushSandboxLogs: {
            methodKind: "client_streaming";
            input: typeof import("./gen/openshell_pb.js").PushSandboxLogsRequestSchema;
            output: typeof import("./gen/openshell_pb.js").PushSandboxLogsResponseSchema;
        };
        connectSupervisor: {
            methodKind: "bidi_streaming";
            input: typeof import("./gen/openshell_pb.js").SupervisorMessageSchema;
            output: typeof import("./gen/openshell_pb.js").GatewayMessageSchema;
        };
        reportMainProcessExit: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ReportMainProcessExitRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ReportMainProcessExitResponseSchema;
        };
        finalizeMainProcessExit: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").FinalizeMainProcessExitRequestSchema;
            output: typeof import("./gen/openshell_pb.js").FinalizeMainProcessExitResponseSchema;
        };
        relayStream: {
            methodKind: "bidi_streaming";
            input: typeof import("./gen/openshell_pb.js").RelayFrameSchema;
            output: typeof import("./gen/openshell_pb.js").RelayFrameSchema;
        };
        peerRelay: {
            methodKind: "bidi_streaming";
            input: typeof import("./gen/openshell_pb.js").PeerRelayFrameSchema;
            output: typeof import("./gen/openshell_pb.js").PeerRelayFrameSchema;
        };
        peerReportProviderReadiness: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ReportProviderReadinessRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ReportProviderReadinessResponseSchema;
        };
        peerReportEndpointStatus: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ReportEndpointStatusRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ReportEndpointStatusResponseSchema;
        };
        peerGetSandboxProviderStatus: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetSandboxProviderStatusRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetSandboxProviderStatusResponseSchema;
        };
        peerNotifyConfigUpdate: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").PeerNotifyConfigUpdateRequestSchema;
            output: typeof import("./gen/openshell_pb.js").PeerNotifyConfigUpdateResponseSchema;
        };
        watchSandbox: {
            methodKind: "server_streaming";
            input: typeof import("./gen/openshell_pb.js").WatchSandboxRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SandboxStreamEventSchema;
        };
        submitPolicyAnalysis: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").SubmitPolicyAnalysisRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SubmitPolicyAnalysisResponseSchema;
        };
        getDraftPolicy: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetDraftPolicyRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetDraftPolicyResponseSchema;
        };
        approveDraftChunk: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ApproveDraftChunkRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ApproveDraftChunkResponseSchema;
        };
        rejectDraftChunk: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").RejectDraftChunkRequestSchema;
            output: typeof import("./gen/openshell_pb.js").RejectDraftChunkResponseSchema;
        };
        approveAllDraftChunks: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ApproveAllDraftChunksRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ApproveAllDraftChunksResponseSchema;
        };
        editDraftChunk: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").EditDraftChunkRequestSchema;
            output: typeof import("./gen/openshell_pb.js").EditDraftChunkResponseSchema;
        };
        undoDraftChunk: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").UndoDraftChunkRequestSchema;
            output: typeof import("./gen/openshell_pb.js").UndoDraftChunkResponseSchema;
        };
        clearDraftChunks: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ClearDraftChunksRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ClearDraftChunksResponseSchema;
        };
        getDraftHistory: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetDraftHistoryRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetDraftHistoryResponseSchema;
        };
        issueSandboxToken: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").IssueSandboxTokenRequestSchema;
            output: typeof import("./gen/openshell_pb.js").IssueSandboxTokenResponseSchema;
        };
        refreshSandboxToken: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").RefreshSandboxTokenRequestSchema;
            output: typeof import("./gen/openshell_pb.js").RefreshSandboxTokenResponseSchema;
        };
        createWorkspace: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").CreateWorkspaceRequestSchema;
            output: typeof import("./gen/openshell_pb.js").CreateWorkspaceResponseSchema;
        };
        getWorkspace: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetWorkspaceRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetWorkspaceResponseSchema;
        };
        listWorkspaces: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListWorkspacesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListWorkspacesResponseSchema;
        };
        deleteWorkspace: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DeleteWorkspaceRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DeleteWorkspaceResponseSchema;
        };
        addWorkspaceMember: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").AddWorkspaceMemberRequestSchema;
            output: typeof import("./gen/openshell_pb.js").AddWorkspaceMemberResponseSchema;
        };
        removeWorkspaceMember: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").RemoveWorkspaceMemberRequestSchema;
            output: typeof import("./gen/openshell_pb.js").RemoveWorkspaceMemberResponseSchema;
        };
        listWorkspaceMembers: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListWorkspaceMembersRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListWorkspaceMembersResponseSchema;
        };
    }>>);
    static connect(options: ConnectOptions): Promise<SandboxTemplateClient>;
    create(template: MessageInitShape<typeof SandboxWorkloadTemplateSchema>, options?: SandboxTemplateWorkspaceOptions | null): Promise<SandboxWorkloadTemplate>;
    get(name: string, options?: SandboxTemplateWorkspaceOptions | null): Promise<SandboxWorkloadTemplate>;
    list(options?: SandboxTemplateListOptions | null): Pager<SandboxWorkloadTemplate>;
    /** List and collect every sandbox template in this scope. */
    listAll(options?: SandboxTemplateListOptions | null): Promise<SandboxWorkloadTemplate[]>;
    delete(name: string, options?: DeleteOptions | null): Promise<DeletionResult>;
}
export declare class SandboxClient {
    private readonly grpc;
    /**
     * Advanced escape hatch: a generated client for every gateway RPC, including
     * surface the curated methods do not wrap yet. Request/response types are the
     * generated wire messages (import them from '@nvidia/openshell-sdk/raw').
     */
    readonly raw: Client<typeof OpenShell>;
    /** The shared Connect transport, for building extra clients over the same connection. */
    readonly transport: Transport;
    constructor(transport: Transport, grpc?: Client<import("@bufbuild/protobuf/codegenv2").GenService<{
        health: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").HealthRequestSchema;
            output: typeof import("./gen/openshell_pb.js").HealthResponseSchema;
        };
        getCurrentUser: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetCurrentUserRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetCurrentUserResponseSchema;
        };
        getGatewayInfo: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetGatewayInfoRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetGatewayInfoResponseSchema;
        };
        createSandbox: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").CreateSandboxRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SandboxResponseSchema;
        };
        beginRootfsTarStaging: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").BeginRootfsTarStagingRequestSchema;
            output: typeof import("./gen/openshell_pb.js").BeginRootfsTarStagingResponseSchema;
        };
        getSandbox: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetSandboxRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SandboxResponseSchema;
        };
        listSandboxes: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListSandboxesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListSandboxesResponseSchema;
        };
        createSandboxTemplate: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").CreateSandboxTemplateRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SandboxTemplateResponseSchema;
        };
        getSandboxTemplate: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetSandboxTemplateRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SandboxTemplateResponseSchema;
        };
        listSandboxTemplates: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListSandboxTemplatesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListSandboxTemplatesResponseSchema;
        };
        deleteSandboxTemplate: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DeleteSandboxTemplateRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DeleteSandboxTemplateResponseSchema;
        };
        listSandboxProviders: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListSandboxProvidersRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListSandboxProvidersResponseSchema;
        };
        attachSandboxProvider: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").AttachSandboxProviderRequestSchema;
            output: typeof import("./gen/openshell_pb.js").AttachSandboxProviderResponseSchema;
        };
        detachSandboxProvider: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DetachSandboxProviderRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DetachSandboxProviderResponseSchema;
        };
        getSandboxProviderStatus: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetSandboxProviderStatusRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetSandboxProviderStatusResponseSchema;
        };
        deleteSandbox: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DeleteSandboxRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DeleteSandboxResponseSchema;
        };
        stopSandbox: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").StopSandboxRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SandboxResponseSchema;
        };
        startSandbox: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").StartSandboxRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SandboxResponseSchema;
        };
        createSshSession: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").CreateSshSessionRequestSchema;
            output: typeof import("./gen/openshell_pb.js").CreateSshSessionResponseSchema;
        };
        exposeService: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ExposeServiceRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ServiceEndpointResponseSchema;
        };
        getService: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetServiceRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ServiceEndpointResponseSchema;
        };
        listServices: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListServicesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListServicesResponseSchema;
        };
        deleteService: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DeleteServiceRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DeleteServiceResponseSchema;
        };
        revokeSshSession: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").RevokeSshSessionRequestSchema;
            output: typeof import("./gen/openshell_pb.js").RevokeSshSessionResponseSchema;
        };
        execSandbox: {
            methodKind: "server_streaming";
            input: typeof import("./gen/openshell_pb.js").ExecSandboxRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ExecSandboxEventSchema;
        };
        forwardTcp: {
            methodKind: "bidi_streaming";
            input: typeof TcpForwardFrameSchema;
            output: typeof TcpForwardFrameSchema;
        };
        execSandboxInteractive: {
            methodKind: "bidi_streaming";
            input: typeof ExecSandboxInputSchema;
            output: typeof import("./gen/openshell_pb.js").ExecSandboxEventSchema;
        };
        createProvider: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").CreateProviderRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ProviderResponseSchema;
        };
        getProvider: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetProviderRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ProviderResponseSchema;
        };
        getProviderCredentials: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetProviderCredentialsRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetProviderCredentialsResponseSchema;
        };
        listProviders: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListProvidersRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListProvidersResponseSchema;
        };
        listProviderProfiles: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListProviderProfilesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListProviderProfilesResponseSchema;
        };
        getProviderProfile: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetProviderProfileRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ProviderProfileResponseSchema;
        };
        importProviderProfiles: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ImportProviderProfilesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ImportProviderProfilesResponseSchema;
        };
        updateProviderProfiles: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").UpdateProviderProfilesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").UpdateProviderProfilesResponseSchema;
        };
        lintProviderProfiles: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").LintProviderProfilesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").LintProviderProfilesResponseSchema;
        };
        updateProvider: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").UpdateProviderRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ProviderResponseSchema;
        };
        getProviderRefreshStatus: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetProviderRefreshStatusRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetProviderRefreshStatusResponseSchema;
        };
        configureProviderRefresh: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ConfigureProviderRefreshRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ConfigureProviderRefreshResponseSchema;
        };
        rotateProviderCredential: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").RotateProviderCredentialRequestSchema;
            output: typeof import("./gen/openshell_pb.js").RotateProviderCredentialResponseSchema;
        };
        deleteProviderRefresh: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DeleteProviderRefreshRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DeleteProviderRefreshResponseSchema;
        };
        deleteProvider: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DeleteProviderRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DeleteProviderResponseSchema;
        };
        deleteProviderProfile: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DeleteProviderProfileRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DeleteProviderProfileResponseSchema;
        };
        getSandboxConfig: {
            methodKind: "unary";
            input: typeof import("./gen/sandbox_pb.js").GetSandboxConfigRequestSchema;
            output: typeof import("./gen/sandbox_pb.js").GetSandboxConfigResponseSchema;
        };
        getGatewayConfig: {
            methodKind: "unary";
            input: typeof import("./gen/sandbox_pb.js").GetGatewayConfigRequestSchema;
            output: typeof import("./gen/sandbox_pb.js").GetGatewayConfigResponseSchema;
        };
        updateConfig: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").UpdateConfigRequestSchema;
            output: typeof import("./gen/openshell_pb.js").UpdateConfigResponseSchema;
        };
        getSandboxPolicyStatus: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetSandboxPolicyStatusRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetSandboxPolicyStatusResponseSchema;
        };
        listSandboxPolicies: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListSandboxPoliciesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListSandboxPoliciesResponseSchema;
        };
        reportPolicyStatus: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ReportPolicyStatusRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ReportPolicyStatusResponseSchema;
        };
        reportEndpointStatus: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ReportEndpointStatusRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ReportEndpointStatusResponseSchema;
        };
        reportProviderReadiness: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ReportProviderReadinessRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ReportProviderReadinessResponseSchema;
        };
        reportSandboxConfiguration: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ReportSandboxConfigurationRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ReportSandboxConfigurationResponseSchema;
        };
        getSandboxProviderEnvironment: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetSandboxProviderEnvironmentRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetSandboxProviderEnvironmentResponseSchema;
        };
        exchangeProviderSubjectToken: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ExchangeProviderSubjectTokenRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ExchangeProviderSubjectTokenResponseSchema;
        };
        getSandboxLogs: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetSandboxLogsRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetSandboxLogsResponseSchema;
        };
        pushSandboxLogs: {
            methodKind: "client_streaming";
            input: typeof import("./gen/openshell_pb.js").PushSandboxLogsRequestSchema;
            output: typeof import("./gen/openshell_pb.js").PushSandboxLogsResponseSchema;
        };
        connectSupervisor: {
            methodKind: "bidi_streaming";
            input: typeof import("./gen/openshell_pb.js").SupervisorMessageSchema;
            output: typeof import("./gen/openshell_pb.js").GatewayMessageSchema;
        };
        reportMainProcessExit: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ReportMainProcessExitRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ReportMainProcessExitResponseSchema;
        };
        finalizeMainProcessExit: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").FinalizeMainProcessExitRequestSchema;
            output: typeof import("./gen/openshell_pb.js").FinalizeMainProcessExitResponseSchema;
        };
        relayStream: {
            methodKind: "bidi_streaming";
            input: typeof import("./gen/openshell_pb.js").RelayFrameSchema;
            output: typeof import("./gen/openshell_pb.js").RelayFrameSchema;
        };
        peerRelay: {
            methodKind: "bidi_streaming";
            input: typeof import("./gen/openshell_pb.js").PeerRelayFrameSchema;
            output: typeof import("./gen/openshell_pb.js").PeerRelayFrameSchema;
        };
        peerReportProviderReadiness: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ReportProviderReadinessRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ReportProviderReadinessResponseSchema;
        };
        peerReportEndpointStatus: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ReportEndpointStatusRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ReportEndpointStatusResponseSchema;
        };
        peerGetSandboxProviderStatus: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetSandboxProviderStatusRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetSandboxProviderStatusResponseSchema;
        };
        peerNotifyConfigUpdate: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").PeerNotifyConfigUpdateRequestSchema;
            output: typeof import("./gen/openshell_pb.js").PeerNotifyConfigUpdateResponseSchema;
        };
        watchSandbox: {
            methodKind: "server_streaming";
            input: typeof import("./gen/openshell_pb.js").WatchSandboxRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SandboxStreamEventSchema;
        };
        submitPolicyAnalysis: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").SubmitPolicyAnalysisRequestSchema;
            output: typeof import("./gen/openshell_pb.js").SubmitPolicyAnalysisResponseSchema;
        };
        getDraftPolicy: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetDraftPolicyRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetDraftPolicyResponseSchema;
        };
        approveDraftChunk: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ApproveDraftChunkRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ApproveDraftChunkResponseSchema;
        };
        rejectDraftChunk: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").RejectDraftChunkRequestSchema;
            output: typeof import("./gen/openshell_pb.js").RejectDraftChunkResponseSchema;
        };
        approveAllDraftChunks: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ApproveAllDraftChunksRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ApproveAllDraftChunksResponseSchema;
        };
        editDraftChunk: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").EditDraftChunkRequestSchema;
            output: typeof import("./gen/openshell_pb.js").EditDraftChunkResponseSchema;
        };
        undoDraftChunk: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").UndoDraftChunkRequestSchema;
            output: typeof import("./gen/openshell_pb.js").UndoDraftChunkResponseSchema;
        };
        clearDraftChunks: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ClearDraftChunksRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ClearDraftChunksResponseSchema;
        };
        getDraftHistory: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetDraftHistoryRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetDraftHistoryResponseSchema;
        };
        issueSandboxToken: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").IssueSandboxTokenRequestSchema;
            output: typeof import("./gen/openshell_pb.js").IssueSandboxTokenResponseSchema;
        };
        refreshSandboxToken: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").RefreshSandboxTokenRequestSchema;
            output: typeof import("./gen/openshell_pb.js").RefreshSandboxTokenResponseSchema;
        };
        createWorkspace: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").CreateWorkspaceRequestSchema;
            output: typeof import("./gen/openshell_pb.js").CreateWorkspaceResponseSchema;
        };
        getWorkspace: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").GetWorkspaceRequestSchema;
            output: typeof import("./gen/openshell_pb.js").GetWorkspaceResponseSchema;
        };
        listWorkspaces: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListWorkspacesRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListWorkspacesResponseSchema;
        };
        deleteWorkspace: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").DeleteWorkspaceRequestSchema;
            output: typeof import("./gen/openshell_pb.js").DeleteWorkspaceResponseSchema;
        };
        addWorkspaceMember: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").AddWorkspaceMemberRequestSchema;
            output: typeof import("./gen/openshell_pb.js").AddWorkspaceMemberResponseSchema;
        };
        removeWorkspaceMember: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").RemoveWorkspaceMemberRequestSchema;
            output: typeof import("./gen/openshell_pb.js").RemoveWorkspaceMemberResponseSchema;
        };
        listWorkspaceMembers: {
            methodKind: "unary";
            input: typeof import("./gen/openshell_pb.js").ListWorkspaceMembersRequestSchema;
            output: typeof import("./gen/openshell_pb.js").ListWorkspaceMembersResponseSchema;
        };
    }>>);
    /**
     * Constructs a lazy Connect client. No network request is made until the
     * first RPC; call get() or another operation to verify reachability.
     */
    static connect(options: ConnectOptions): Promise<SandboxClient>;
    create(spec: SandboxSpec): Promise<SandboxRef>;
    createFromTemplate(spec: SandboxFromTemplateSpec): Promise<SandboxRef>;
    get(name: string, options?: SandboxCallOptions | null): Promise<SandboxRef>;
    list(options?: ListOptions | null): Pager<SandboxRef>;
    /** List and collect every sandbox in this scope. */
    listAll(options?: ListOptions | null): Promise<SandboxRef[]>;
    delete(name: string, options?: DeleteOptions | null): Promise<DeletionResult>;
    waitReady(name: string, timeoutSecs: number, options?: WaitOptions | null): Promise<SandboxRef>;
    waitDeleted(name: string, timeoutSecs: number, options?: WaitDeletedOptions | null): Promise<void>;
    execStream(name: string, command: string[], options?: ExecOptions | null): AsyncGenerator<ExecStreamEvent, void, void>;
    exec(name: string, command: string[], options?: ExecOptions | null): Promise<ExecResult>;
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
    watchLogs(name: string, options?: WatchOptions | null): AsyncGenerator<WatchEvent, void, void>;
    execInteractive(name: string, command: string[], options?: ExecInteractiveOptions | null): Promise<ExecInteractiveSessionControl>;
    forward(name: string, opts: ForwardOptions): Promise<ForwardHandle>;
    private forwardConnection;
    createSshSession(name: string, options?: SandboxWorkspaceOptions | null): Promise<SshSession>;
    revokeSshSession(token: string, options?: Pick<DeleteOptions, 'allowMissing'>): Promise<DeletionResult>;
    attachProvider(name: string, provider: string, options?: ProviderChangeOptions | null): Promise<ProviderChange>;
    detachProvider(name: string, provider: string, options?: ProviderChangeOptions | null): Promise<ProviderChange>;
    listProviders(name: string, options?: SandboxProviderListOptions | null): Pager<ProviderRef>;
    /** List and collect every provider attached to this sandbox. */
    listAllProviders(name: string, options?: SandboxProviderListOptions | null): Promise<ProviderRef[]>;
    getConfig(name: string, options?: SandboxCallOptions | null): Promise<SandboxConfig>;
    setPolicy(name: string, policy: MessageInitShape<typeof SandboxPolicySchema>, options?: SetPolicyOptions | null): Promise<UpdateConfigResult>;
    setSetting(name: string, key: string, value: MessageInitShape<typeof SettingValueSchema>, options?: SandboxWorkspaceOptions | null): Promise<UpdateConfigResult>;
    private waitForPolicyHash;
}
export declare class OpenShellClient {
    /** Sandbox lifecycle + exec: create/get/list/delete, waitReady/waitDeleted, exec. */
    readonly sandbox: SandboxClient;
    /** Reusable sandbox workload template lifecycle. */
    readonly sandboxTemplates: SandboxTemplateClient;
    /** Privileged provider credential retrieval; requires direct operator mTLS. */
    readonly providers: ProviderClient;
    /**
     * Advanced escape hatch: a generated client for every gateway RPC, including
     * surface the curated sub-clients do not wrap yet (gateway config, provider
     * CRUD, policy status, watch, logs, and the full observed Sandbox). See
     * '@nvidia/openshell-sdk/raw' for the generated request/response types.
     */
    readonly raw: Client<typeof OpenShell>;
    /** The shared Connect transport, for building extra clients over the same connection. */
    readonly transport: Transport;
    private readonly grpc;
    private constructor();
    /**
     * Constructs a lazy Connect client. No network request is made until the
     * first RPC; call health() when startup must verify gateway reachability.
     */
    static connect(options: ConnectOptions): Promise<OpenShellClient>;
    health(): Promise<Health>;
}
//# sourceMappingURL=client.d.ts.map