import type { GenEnum, GenFile, GenMessage, GenService } from "@bufbuild/protobuf/codegenv2";
import type { ObjectMeta, Provider, Workspace, WorkspaceSelector } from "./datamodel_pb.js";
import type { Duration, Timestamp } from "@bufbuild/protobuf/wkt";
import type { GetGatewayConfigRequestSchema, GetGatewayConfigResponseSchema, GetSandboxConfigRequestSchema, GetSandboxConfigResponseSchema, L7DenyRule, L7Rule, NetworkBinary, NetworkEndpoint, NetworkPolicyRule, PolicySource, SandboxConfigSnapshot, SandboxPolicy, SettingValue } from "./sandbox_pb.js";
import type { JsonObject, Message } from "@bufbuild/protobuf";
/**
 * Describes the file openshell.proto.
 */
export declare const file_openshell: GenFile;
/**
 * IssueSandboxToken request. Empty body; identity is established by the
 * authentication credentials carried in the request headers (a projected
 * Kubernetes ServiceAccount JWT in the K8s driver path).
 *
 * @generated from message openshell.v1.IssueSandboxTokenRequest
 */
export type IssueSandboxTokenRequest = Message<"openshell.v1.IssueSandboxTokenRequest"> & {};
/**
 * Describes the message openshell.v1.IssueSandboxTokenRequest.
 * Use `create(IssueSandboxTokenRequestSchema)` to create a new message.
 */
export declare const IssueSandboxTokenRequestSchema: GenMessage<IssueSandboxTokenRequest>;
/**
 * IssueSandboxToken response. The supervisor caches the returned token in
 * memory and presents it as `Authorization: Bearer` on every subsequent
 * gateway RPC.
 *
 * @generated from message openshell.v1.IssueSandboxTokenResponse
 */
export type IssueSandboxTokenResponse = Message<"openshell.v1.IssueSandboxTokenResponse"> & {
    /**
     * Gateway-minted session JWT bound to the calling sandbox's UUID, active
     * runtime generation, authorization epoch, and durable token lineage.
     *
     * @generated from field: string token = 1;
     */
    token: string;
    /**
     * Absolute expiry of the issued token. Absence means the token is non-expiring.
     *
     * @generated from field: google.protobuf.Timestamp expiration_time = 102;
     */
    expirationTime?: Timestamp | undefined;
};
/**
 * Describes the message openshell.v1.IssueSandboxTokenResponse.
 * Use `create(IssueSandboxTokenResponseSchema)` to create a new message.
 */
export declare const IssueSandboxTokenResponseSchema: GenMessage<IssueSandboxTokenResponse>;
/**
 * RefreshSandboxToken request. The calling principal must already be a
 * sandbox principal (i.e. the request carries a still-valid gateway-minted
 * JWT in its Authorization header). Extension service names are resolved
 * against server-owned registrations and the sandbox's effective policy;
 * callers never choose token audiences directly.
 *
 * @generated from message openshell.v1.RefreshSandboxTokenRequest
 */
export type RefreshSandboxTokenRequest = Message<"openshell.v1.RefreshSandboxTokenRequest"> & {
    /**
     * Operator registration names for extension services selected by the
     * sandbox's effective policy.
     *
     * @generated from field: repeated string extension_service_names = 1;
     */
    extensionServiceNames: string[];
};
/**
 * Describes the message openshell.v1.RefreshSandboxTokenRequest.
 * Use `create(RefreshSandboxTokenRequestSchema)` to create a new message.
 */
export declare const RefreshSandboxTokenRequestSchema: GenMessage<RefreshSandboxTokenRequest>;
/**
 * RefreshSandboxToken response. The new token replaces the supervisor's
 * in-memory bearer credential.
 *
 * @generated from message openshell.v1.RefreshSandboxTokenResponse
 */
export type RefreshSandboxTokenResponse = Message<"openshell.v1.RefreshSandboxTokenResponse"> & {
    /**
     * Fresh gateway-minted JWT bound to the same sandbox UUID.
     *
     * @generated from field: string token = 1;
     */
    token: string;
    /**
     * Absolute expiry of the new token. Absence means the token is non-expiring.
     *
     * @generated from field: google.protobuf.Timestamp expiration_time = 102;
     */
    expirationTime?: Timestamp | undefined;
    /**
     * Fresh credentials for the requested, policy-authorized extension
     * services. These remain in supervisor memory and are never persisted.
     *
     * @generated from field: repeated openshell.v1.ExtensionServiceCredential extension_credentials = 3;
     */
    extensionCredentials: ExtensionServiceCredential[];
    /**
     * Fresh Sandbox Protocol bearer token from the same atomic refresh.
     *
     * @generated from field: string sandbox_token = 4;
     */
    sandboxToken: string;
    /**
     * Absolute Sandbox Protocol token expiry. Absence means the token is non-expiring.
     *
     * @generated from field: google.protobuf.Timestamp sandbox_expiration_time = 105;
     */
    sandboxExpirationTime?: Timestamp | undefined;
    /**
     * Launch generation to which both refreshed credentials are bound.
     *
     * @generated from field: string session_id = 6;
     */
    sessionId: string;
    /**
     * Durable authorization epoch shared by the gateway and Sandbox Runtime.
     *
     * @generated from field: uint64 credential_epoch = 7;
     */
    credentialEpoch: bigint;
};
/**
 * Describes the message openshell.v1.RefreshSandboxTokenResponse.
 * Use `create(RefreshSandboxTokenResponseSchema)` to create a new message.
 */
export declare const RefreshSandboxTokenResponseSchema: GenMessage<RefreshSandboxTokenResponse>;
/**
 * Health check request.
 *
 * @generated from message openshell.v1.HealthRequest
 */
export type HealthRequest = Message<"openshell.v1.HealthRequest"> & {};
/**
 * Describes the message openshell.v1.HealthRequest.
 * Use `create(HealthRequestSchema)` to create a new message.
 */
export declare const HealthRequestSchema: GenMessage<HealthRequest>;
/**
 * Health check response.
 *
 * @generated from message openshell.v1.HealthResponse
 */
export type HealthResponse = Message<"openshell.v1.HealthResponse"> & {
    /**
     * Service status.
     *
     * @generated from field: openshell.v1.ServiceStatus status = 1;
     */
    status: ServiceStatus;
    /**
     * Service version.
     *
     * @generated from field: string version = 2;
     */
    version: string;
};
/**
 * Describes the message openshell.v1.HealthResponse.
 * Use `create(HealthResponseSchema)` to create a new message.
 */
export declare const HealthResponseSchema: GenMessage<HealthResponse>;
/**
 * Current-user request. The identity comes from the authenticated request.
 *
 * @generated from message openshell.v1.GetCurrentUserRequest
 */
export type GetCurrentUserRequest = Message<"openshell.v1.GetCurrentUserRequest"> & {};
/**
 * Describes the message openshell.v1.GetCurrentUserRequest.
 * Use `create(GetCurrentUserRequestSchema)` to create a new message.
 */
export declare const GetCurrentUserRequestSchema: GenMessage<GetCurrentUserRequest>;
/**
 * Authenticated user identity as validated by the gateway.
 *
 * @generated from message openshell.v1.GetCurrentUserResponse
 */
export type GetCurrentUserResponse = Message<"openshell.v1.GetCurrentUserResponse"> & {
    /**
     * Stable identity subject (for example, the OIDC `sub` claim).
     *
     * @generated from field: string subject = 1;
     */
    subject: string;
    /**
     * Human-readable identity name when supplied by the authentication provider.
     *
     * @generated from field: string display_name = 2;
     */
    displayName: string;
    /**
     * Roles granted to the authenticated identity.
     *
     * @generated from field: repeated string roles = 3;
     */
    roles: string[];
    /**
     * OAuth2 scopes granted to the authenticated identity.
     *
     * @generated from field: repeated string scopes = 4;
     */
    scopes: string[];
    /**
     * Authentication provider that established the identity.
     *
     * @generated from field: string identity_provider = 5;
     */
    identityProvider: string;
};
/**
 * Describes the message openshell.v1.GetCurrentUserResponse.
 * Use `create(GetCurrentUserResponseSchema)` to create a new message.
 */
export declare const GetCurrentUserResponseSchema: GenMessage<GetCurrentUserResponse>;
/**
 * Gateway info request.
 *
 * @generated from message openshell.v1.GetGatewayInfoRequest
 */
export type GetGatewayInfoRequest = Message<"openshell.v1.GetGatewayInfoRequest"> & {};
/**
 * Describes the message openshell.v1.GetGatewayInfoRequest.
 * Use `create(GetGatewayInfoRequestSchema)` to create a new message.
 */
export declare const GetGatewayInfoRequestSchema: GenMessage<GetGatewayInfoRequest>;
/**
 * Gateway info response.
 *
 * @generated from message openshell.v1.GetGatewayInfoResponse
 */
export type GetGatewayInfoResponse = Message<"openshell.v1.GetGatewayInfoResponse"> & {
    /**
     * Service status.
     *
     * @generated from field: openshell.v1.ServiceStatus status = 1;
     */
    status: ServiceStatus;
    /**
     * OpenShell gateway binary version.
     *
     * @generated from field: string gateway_version = 2;
     */
    gatewayVersion: string;
    /**
     * Compute driver runtimes initialized by this gateway. Current gateways
     * return exactly one entry.
     *
     * @generated from field: repeated openshell.v1.ComputeDriverInfo compute_drivers = 3;
     */
    computeDrivers: ComputeDriverInfo[];
    /**
     * Negotiated non-secret metadata for every initialized extension.
     *
     * @generated from field: repeated openshell.v1.NegotiatedExtensionInfo extensions = 4;
     */
    extensions: NegotiatedExtensionInfo[];
};
/**
 * Describes the message openshell.v1.GetGatewayInfoResponse.
 * Use `create(GetGatewayInfoResponseSchema)` to create a new message.
 */
export declare const GetGatewayInfoResponseSchema: GenMessage<GetGatewayInfoResponse>;
/**
 * Public, non-secret snapshot of one successful startup negotiation.
 *
 * @generated from message openshell.v1.NegotiatedExtensionInfo
 */
export type NegotiatedExtensionInfo = Message<"openshell.v1.NegotiatedExtensionInfo"> & {
    /**
     * @generated from field: openshell.v1.ExtensionKind kind = 1;
     */
    kind: ExtensionKind;
    /**
     * Gateway/operator-selected registration name.
     *
     * @generated from field: string configured_name = 2;
     */
    configuredName: string;
    /**
     * Extension-reported implementation identity.
     *
     * @generated from field: string implementation_name = 3;
     */
    implementationName: string;
    /**
     * Extension build version, distinct from the protocol version.
     *
     * @generated from field: string implementation_version = 4;
     */
    implementationVersion: string;
    /**
     * @generated from field: uint32 protocol_major = 5;
     */
    protocolMajor: number;
    /**
     * @generated from field: uint32 protocol_minor = 6;
     */
    protocolMinor: number;
    /**
     * Extension-supported optional capabilities, sorted for stable output.
     *
     * @generated from field: repeated string supported_capabilities = 7;
     */
    supportedCapabilities: string[];
    /**
     * Capabilities the extension requires from the gateway.
     *
     * @generated from field: repeated string required_capabilities = 8;
     */
    requiredCapabilities: string[];
};
/**
 * Describes the message openshell.v1.NegotiatedExtensionInfo.
 * Use `create(NegotiatedExtensionInfoSchema)` to create a new message.
 */
export declare const NegotiatedExtensionInfoSchema: GenMessage<NegotiatedExtensionInfo>;
/**
 * Info for one initialized compute driver runtime.
 *
 * @generated from message openshell.v1.ComputeDriverInfo
 */
export type ComputeDriverInfo = Message<"openshell.v1.ComputeDriverInfo"> & {
    /**
     * Gateway-selected driver name used for routing and driver_config keys.
     *
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * Capabilities reported by the driver during gateway runtime initialization.
     *
     * @generated from field: openshell.v1.ComputeDriverCapabilities capabilities = 2;
     */
    capabilities?: ComputeDriverCapabilities | undefined;
};
/**
 * Describes the message openshell.v1.ComputeDriverInfo.
 * Use `create(ComputeDriverInfoSchema)` to create a new message.
 */
export declare const ComputeDriverInfoSchema: GenMessage<ComputeDriverInfo>;
/**
 * Public compute driver capability snapshot.
 *
 * @generated from message openshell.v1.ComputeDriverCapabilities
 */
export type ComputeDriverCapabilities = Message<"openshell.v1.ComputeDriverCapabilities"> & {
    /**
     * Driver-reported human-readable name from the startup capability snapshot.
     *
     * @generated from field: string driver_name = 1;
     */
    driverName: string;
    /**
     * Driver-reported implementation version from the startup capability snapshot.
     *
     * @generated from field: string driver_version = 2;
     */
    driverVersion: string;
    /**
     * Static portable resource request forms reported by the driver.
     *
     * @generated from field: openshell.v1.ResourceCapabilities resource_capabilities = 3;
     */
    resourceCapabilities?: ResourceCapabilities | undefined;
};
/**
 * Describes the message openshell.v1.ComputeDriverCapabilities.
 * Use `create(ComputeDriverCapabilitiesSchema)` to create a new message.
 */
export declare const ComputeDriverCapabilitiesSchema: GenMessage<ComputeDriverCapabilities>;
/**
 * Static portable resource request forms reported by a compute driver.
 * An omitted domain means the driver does not report that domain.
 *
 * @generated from message openshell.v1.ResourceCapabilities
 */
export type ResourceCapabilities = Message<"openshell.v1.ResourceCapabilities"> & {
    /**
     * @generated from field: openshell.v1.CpuResourceCapabilities cpu = 1;
     */
    cpu?: CpuResourceCapabilities | undefined;
    /**
     * @generated from field: openshell.v1.MemoryResourceCapabilities memory = 2;
     */
    memory?: MemoryResourceCapabilities | undefined;
    /**
     * @generated from field: openshell.v1.GpuResourceCapabilities gpu = 3;
     */
    gpu?: GpuResourceCapabilities | undefined;
};
/**
 * Describes the message openshell.v1.ResourceCapabilities.
 * Use `create(ResourceCapabilitiesSchema)` to create a new message.
 */
export declare const ResourceCapabilitiesSchema: GenMessage<ResourceCapabilities>;
/**
 * @generated from message openshell.v1.CpuResourceCapabilities
 */
export type CpuResourceCapabilities = Message<"openshell.v1.CpuResourceCapabilities"> & {
    /**
     * The driver accepts and enforces a portable CPU limit.
     *
     * @generated from field: bool limit_supported = 1;
     */
    limitSupported: boolean;
};
/**
 * Describes the message openshell.v1.CpuResourceCapabilities.
 * Use `create(CpuResourceCapabilitiesSchema)` to create a new message.
 */
export declare const CpuResourceCapabilitiesSchema: GenMessage<CpuResourceCapabilities>;
/**
 * @generated from message openshell.v1.MemoryResourceCapabilities
 */
export type MemoryResourceCapabilities = Message<"openshell.v1.MemoryResourceCapabilities"> & {
    /**
     * The driver accepts and enforces a portable memory limit.
     *
     * @generated from field: bool limit_supported = 1;
     */
    limitSupported: boolean;
};
/**
 * Describes the message openshell.v1.MemoryResourceCapabilities.
 * Use `create(MemoryResourceCapabilitiesSchema)` to create a new message.
 */
export declare const MemoryResourceCapabilitiesSchema: GenMessage<MemoryResourceCapabilities>;
/**
 * @generated from message openshell.v1.GpuResourceCapabilities
 */
export type GpuResourceCapabilities = Message<"openshell.v1.GpuResourceCapabilities"> & {
    /**
     * The driver accepts a GPU request with no explicit count.
     *
     * @generated from field: bool default_selection_supported = 1;
     */
    defaultSelectionSupported: boolean;
    /**
     * The driver accepts an explicit `gpu.count` request.
     *
     * @generated from field: bool count_selection_supported = 2;
     */
    countSelectionSupported: boolean;
};
/**
 * Describes the message openshell.v1.GpuResourceCapabilities.
 * Use `create(GpuResourceCapabilitiesSchema)` to create a new message.
 */
export declare const GpuResourceCapabilitiesSchema: GenMessage<GpuResourceCapabilities>;
/**
 * Public sandbox resource exposed by the OpenShell API.
 *
 * This is the canonical gateway-owned view of a sandbox. It merges user intent
 * (`spec`) with gateway-managed metadata and status derived from internal
 * compute-driver observations.
 *
 * Note: The `namespace` field has been removed from the public API. It remains
 * in the internal `DriverSandbox` message as a compute-driver implementation detail.
 *
 * @generated from message openshell.v1.Sandbox
 */
export type Sandbox = Message<"openshell.v1.Sandbox"> & {
    /**
     * Kubernetes-style metadata (id, name, labels, timestamps, resource version).
     *
     * @generated from field: openshell.datamodel.v1.ObjectMeta metadata = 1;
     */
    metadata?: ObjectMeta | undefined;
    /**
     * Desired sandbox configuration submitted through the API.
     *
     * @generated from field: openshell.v1.SandboxSpec spec = 2;
     */
    spec?: SandboxSpec | undefined;
    /**
     * Latest user-facing observed status derived by the gateway.
     *
     * @generated from field: openshell.v1.SandboxStatus status = 3;
     */
    status?: SandboxStatus | undefined;
    /**
     * Read-only SSH host identity in OpenSSH SHA256:<base64> form. Stable for
     * this sandbox's lifetime, including runtime restarts. Empty on legacy
     * runtimes that do not provide a gateway-managed SSH identity.
     *
     * @generated from field: string host_key_fingerprint = 6;
     */
    hostKeyFingerprint: string;
    /**
     * Read-only provenance for sandboxes created from a reusable workload template.
     *
     * @generated from field: openshell.v1.SandboxWorkloadTemplateProvenance created_from_workload_template = 20;
     */
    createdFromWorkloadTemplate?: SandboxWorkloadTemplateProvenance | undefined;
};
/**
 * Describes the message openshell.v1.Sandbox.
 * Use `create(SandboxSchema)` to create a new message.
 */
export declare const SandboxSchema: GenMessage<Sandbox>;
/**
 * Desired sandbox configuration provided through the public API.
 *
 * @generated from message openshell.v1.SandboxSpec
 */
export type SandboxSpec = Message<"openshell.v1.SandboxSpec"> & {
    /**
     * Log level exposed to processes running inside the sandbox.
     *
     * @generated from field: string log_level = 1;
     */
    logLevel: string;
    /**
     * Environment variables injected into the sandbox runtime.
     *
     * @generated from field: map<string, string> environment = 5;
     */
    environment: {
        [key: string]: string;
    };
    /**
     * Container or VM template used to provision the sandbox.
     *
     * @generated from field: openshell.v1.SandboxTemplate template = 6;
     */
    template?: SandboxTemplate | undefined;
    /**
     * Required sandbox policy configuration.
     *
     * @generated from field: openshell.sandbox.v1.SandboxPolicy policy = 7;
     */
    policy?: SandboxPolicy | undefined;
    /**
     * Provider names to attach to this sandbox.
     *
     * @generated from field: repeated string providers = 8;
     */
    providers: string[];
    /**
     * Portable resource requirements used by the gateway for driver selection
     * and by drivers for provisioning.
     *
     * @generated from field: openshell.v1.ResourceRequirements resource_requirements = 9;
     */
    resourceRequirements?: ResourceRequirements | undefined;
    /**
     * Canonical command launched once by the sandbox supervisor. No shell
     * parsing is performed. The gateway normalizes an omitted command to the
     * portable scratch login shell before persistence.
     *
     * @generated from field: repeated string command = 12;
     */
    command: string[];
    /**
     * Allocate a retained pseudo-terminal for the main process.
     *
     * @generated from field: bool tty = 13;
     */
    tty: boolean;
    /**
     * Gateway-owned attachment identity, changed atomically with the provider set.
     * Equality only: detach and reattach must not revive an older receipt.
     *
     * @generated from field: string provider_attachment_epoch = 14;
     */
    providerAttachmentEpoch: string;
    /**
     * Gateway-owned policy for replacing the sandbox runtime after the canonical
     * main process exits. Unspecified is normalized to Never before persistence.
     *
     * @generated from field: openshell.v1.SandboxRestartPolicy restart_policy = 15;
     */
    restartPolicy: SandboxRestartPolicy;
};
/**
 * Describes the message openshell.v1.SandboxSpec.
 * Use `create(SandboxSpecSchema)` to create a new message.
 */
export declare const SandboxSpecSchema: GenMessage<SandboxSpec>;
/**
 * @generated from message openshell.v1.ResourceRequirements
 */
export type ResourceRequirements = Message<"openshell.v1.ResourceRequirements"> & {
    /**
     * GPU requirements for the sandbox. Presence indicates a GPU request.
     *
     * @generated from field: openshell.v1.GpuResourceRequirements gpu = 1;
     */
    gpu?: GpuResourceRequirements | undefined;
};
/**
 * Describes the message openshell.v1.ResourceRequirements.
 * Use `create(ResourceRequirementsSchema)` to create a new message.
 */
export declare const ResourceRequirementsSchema: GenMessage<ResourceRequirements>;
/**
 * Public GPU resource requirements.
 *
 * @generated from message openshell.v1.GpuResourceRequirements
 */
export type GpuResourceRequirements = Message<"openshell.v1.GpuResourceRequirements"> & {
    /**
     * Optional number of GPUs requested. When omitted, the request is for one
     * GPU using the selected driver's default assignment behavior.
     *
     * @generated from field: optional uint32 count = 1;
     */
    count?: number | undefined;
};
/**
 * Describes the message openshell.v1.GpuResourceRequirements.
 * Use `create(GpuResourceRequirementsSchema)` to create a new message.
 */
export declare const GpuResourceRequirementsSchema: GenMessage<GpuResourceRequirements>;
/**
 * Historical inline compute template mapped onto compute-driver template inputs.
 *
 * Despite its name, this is not a reusable named sandbox template resource. It
 * is an inline part of `SandboxSpec` kept for v1 compatibility. A future
 * breaking API cleanup may rename this message to free `SandboxTemplate` for
 * the reusable template resource now represented by `SandboxWorkloadTemplate`.
 *
 * @generated from message openshell.v1.SandboxTemplate
 */
export type SandboxTemplate = Message<"openshell.v1.SandboxTemplate"> & {
    /**
     * Fully-qualified OCI image reference used to boot the sandbox.
     *
     * @generated from field: string image = 1;
     */
    image: string;
    /**
     * Optional runtime class name requested from the compute platform.
     *
     * @generated from field: string runtime_class_name = 2;
     */
    runtimeClassName: string;
    /**
     * Optional agent socket path exposed to the workload.
     *
     * @generated from field: string agent_socket = 3;
     */
    agentSocket: string;
    /**
     * Labels applied to compute-platform resources for this sandbox.
     *
     * @generated from field: map<string, string> labels = 4;
     */
    labels: {
        [key: string]: string;
    };
    /**
     * Annotations applied to compute-platform resources for this sandbox.
     *
     * @generated from field: map<string, string> annotations = 5;
     */
    annotations: {
        [key: string]: string;
    };
    /**
     * Additional environment variables injected by the template.
     *
     * @generated from field: map<string, string> environment = 6;
     */
    environment: {
        [key: string]: string;
    };
    /**
     * Platform-specific compute resource requirements and limits.
     *
     * @generated from field: google.protobuf.Struct resources = 7;
     */
    resources?: JsonObject | undefined;
    /**
     * Enable Kubernetes user namespace isolation (hostUsers: false).
     * When true, container UID 0 maps to a non-root host UID and capabilities
     * become namespaced. Requires Kubernetes 1.33+ with user namespace support
     * available (beta through 1.35, GA in 1.36+) and a supporting runtime.
     * When unset, the cluster-wide default is used.
     *
     * @generated from field: optional bool user_namespaces = 10;
     */
    userNamespaces?: boolean | undefined;
    /**
     * Driver-keyed opaque config envelope supplied by the caller.
     * The gateway selects the block matching the active compute driver and
     * forwards only that inner Struct to DriverSandboxTemplate.driver_config.
     * The selected driver owns nested schema validation.
     *
     * @generated from field: google.protobuf.Struct driver_config = 11;
     */
    driverConfig?: JsonObject | undefined;
};
/**
 * Describes the message openshell.v1.SandboxTemplate.
 * Use `create(SandboxTemplateSchema)` to create a new message.
 */
export declare const SandboxTemplateSchema: GenMessage<SandboxTemplate>;
/**
 * Reusable named sandbox workload template resource.
 *
 * This is the actual workspace-scoped template resource used to create
 * sandboxes by reference. It uses the longer name in v1 to avoid colliding with
 * the historical inline `SandboxTemplate` message. A future breaking API
 * cleanup may rename this resource to `SandboxTemplate`.
 *
 * @generated from message openshell.v1.SandboxWorkloadTemplate
 */
export type SandboxWorkloadTemplate = Message<"openshell.v1.SandboxWorkloadTemplate"> & {
    /**
     * Kubernetes-style metadata (id, name, labels, timestamps, resource version).
     *
     * @generated from field: openshell.datamodel.v1.ObjectMeta metadata = 1;
     */
    metadata?: ObjectMeta | undefined;
    /**
     * Desired reusable workload shape and template-owned driver config.
     *
     * @generated from field: openshell.v1.SandboxWorkloadTemplateSpec spec = 2;
     */
    spec?: SandboxWorkloadTemplateSpec | undefined;
};
/**
 * Describes the message openshell.v1.SandboxWorkloadTemplate.
 * Use `create(SandboxWorkloadTemplateSchema)` to create a new message.
 */
export declare const SandboxWorkloadTemplateSchema: GenMessage<SandboxWorkloadTemplate>;
/**
 * @generated from message openshell.v1.SandboxWorkloadTemplateSpec
 */
export type SandboxWorkloadTemplateSpec = Message<"openshell.v1.SandboxWorkloadTemplateSpec"> & {
    /**
     * Portable workload shape.
     *
     * @generated from field: openshell.v1.SandboxWorkloadConfig workload = 1;
     */
    workload?: SandboxWorkloadConfig | undefined;
    /**
     * Driver-keyed opaque config envelope supplied by the template owner.
     *
     * @generated from field: google.protobuf.Struct driver_config = 2;
     */
    driverConfig?: JsonObject | undefined;
    /**
     * Desired service level associated with this template.
     *
     * @generated from field: openshell.v1.SandboxServiceLevel desired_service_level = 3;
     */
    desiredServiceLevel?: SandboxServiceLevel | undefined;
};
/**
 * Describes the message openshell.v1.SandboxWorkloadTemplateSpec.
 * Use `create(SandboxWorkloadTemplateSpecSchema)` to create a new message.
 */
export declare const SandboxWorkloadTemplateSpecSchema: GenMessage<SandboxWorkloadTemplateSpec>;
/**
 * @generated from message openshell.v1.SandboxWorkloadConfig
 */
export type SandboxWorkloadConfig = Message<"openshell.v1.SandboxWorkloadConfig"> & {
    /**
     * Fully-qualified OCI image reference used to boot the sandbox.
     *
     * @generated from field: string image = 1;
     */
    image: string;
    /**
     * Environment variables injected into the sandbox runtime.
     *
     * @generated from field: map<string, string> environment = 2;
     */
    environment: {
        [key: string]: string;
    };
    /**
     * Portable resource requirements for sandboxes created from this workload.
     *
     * @generated from field: openshell.v1.SandboxResources resources = 3;
     */
    resources?: SandboxResources | undefined;
};
/**
 * Describes the message openshell.v1.SandboxWorkloadConfig.
 * Use `create(SandboxWorkloadConfigSchema)` to create a new message.
 */
export declare const SandboxWorkloadConfigSchema: GenMessage<SandboxWorkloadConfig>;
/**
 * @generated from message openshell.v1.SandboxResources
 */
export type SandboxResources = Message<"openshell.v1.SandboxResources"> & {
    /**
     * Portable CPU quantity, for example "500m" or "2".
     *
     * @generated from field: string cpu = 1;
     */
    cpu: string;
    /**
     * Portable memory quantity, for example "512Mi" or "2Gi".
     *
     * @generated from field: string memory = 2;
     */
    memory: string;
    /**
     * GPU requirements for the sandbox workload. Presence indicates a GPU
     * request. When count is omitted, the request uses the selected driver's
     * default GPU assignment behavior.
     *
     * @generated from field: openshell.v1.GpuResourceRequirements gpu = 3;
     */
    gpu?: GpuResourceRequirements | undefined;
};
/**
 * Describes the message openshell.v1.SandboxResources.
 * Use `create(SandboxResourcesSchema)` to create a new message.
 */
export declare const SandboxResourcesSchema: GenMessage<SandboxResources>;
/**
 * @generated from message openshell.v1.SandboxServiceLevel
 */
export type SandboxServiceLevel = Message<"openshell.v1.SandboxServiceLevel"> & {
    /**
     * @generated from field: openshell.v1.SandboxStartup startup = 1;
     */
    startup?: SandboxStartup | undefined;
};
/**
 * Describes the message openshell.v1.SandboxServiceLevel.
 * Use `create(SandboxServiceLevelSchema)` to create a new message.
 */
export declare const SandboxServiceLevelSchema: GenMessage<SandboxServiceLevel>;
/**
 * @generated from message openshell.v1.SandboxStartup
 */
export type SandboxStartup = Message<"openshell.v1.SandboxStartup"> & {
    /**
     * @generated from field: google.protobuf.Duration ready_within = 1;
     */
    readyWithin?: Duration | undefined;
    /**
     * @generated from field: uint32 max_burst = 2;
     */
    maxBurst: number;
};
/**
 * Describes the message openshell.v1.SandboxStartup.
 * Use `create(SandboxStartupSchema)` to create a new message.
 */
export declare const SandboxStartupSchema: GenMessage<SandboxStartup>;
/**
 * @generated from message openshell.v1.SandboxWorkloadTemplateProvenance
 */
export type SandboxWorkloadTemplateProvenance = Message<"openshell.v1.SandboxWorkloadTemplateProvenance"> & {
    /**
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * @generated from field: string resource_version = 2;
     */
    resourceVersion: string;
};
/**
 * Describes the message openshell.v1.SandboxWorkloadTemplateProvenance.
 * Use `create(SandboxWorkloadTemplateProvenanceSchema)` to create a new message.
 */
export declare const SandboxWorkloadTemplateProvenanceSchema: GenMessage<SandboxWorkloadTemplateProvenance>;
/**
 * User-facing sandbox status derived by the gateway from compute-driver observations.
 *
 * Public status does not embed driver-only flags such as `deleting`.
 *
 * @generated from message openshell.v1.SandboxStatus
 */
export type SandboxStatus = Message<"openshell.v1.SandboxStatus"> & {
    /**
     * Name of the agent pod or equivalent runtime instance.
     *
     * @generated from field: string agent_pod = 2;
     */
    agentPod: string;
    /**
     * File descriptor or endpoint for reaching the agent service, when available.
     *
     * @generated from field: string agent_fd = 3;
     */
    agentFd: string;
    /**
     * File descriptor or endpoint for reaching the sandbox service, when available.
     *
     * @generated from field: string sandbox_fd = 4;
     */
    sandboxFd: string;
    /**
     * Latest user-facing readiness and lifecycle conditions.
     *
     * @generated from field: repeated openshell.v1.SandboxCondition conditions = 5;
     */
    conditions: SandboxCondition[];
    /**
     * Gateway-derived lifecycle summary.
     *
     * @generated from field: openshell.v1.SandboxPhase phase = 6;
     */
    phase: SandboxPhase;
    /**
     * Currently active policy version (updated when sandbox reports loaded).
     *
     * @generated from field: uint32 current_policy_version = 7;
     */
    currentPolicyVersion: number;
    /**
     * Supervisor instance currently associated with the canonical main process.
     * The gateway uses this to reject stale exit reports after a restart.
     *
     * @generated from field: string main_process_instance_id = 8;
     */
    mainProcessInstanceId: string;
    /**
     * Most recent normalized main process result. Signal exits use 128 + signal number.
     * Cleared when a replacement main process becomes ready.
     *
     * @generated from field: optional int32 exit_code = 9;
     */
    exitCode?: number | undefined;
    /**
     * Last accepted network result for each configured tool server endpoint.
     * Currently populated for MCP-over-HTTP endpoints. These passive results
     * remain separate from sandbox lifecycle conditions and readiness.
     *
     * @generated from field: repeated openshell.v1.EndpointStatus endpoint_statuses = 10;
     */
    endpointStatuses: EndpointStatus[];
    /**
     * Independent of infrastructure phase; retained across driver observations.
     *
     * @generated from field: openshell.v1.SandboxConfigurationAdmission configuration_admission = 11;
     */
    configurationAdmission?: SandboxConfigurationAdmission | undefined;
    /**
     * Durable first-acceptance marker. Absent on legacy records; never reset by restart.
     *
     * @generated from field: optional bool configuration_activated = 12;
     */
    configurationActivated?: boolean | undefined;
    /**
     * Gateway-owned provisioning deadlines, retained after timeout for inspection and retry.
     *
     * @generated from field: openshell.v1.SandboxProvisioning provisioning = 13;
     */
    provisioning?: SandboxProvisioning | undefined;
    /**
     * Consecutive policy-driven restart number in the current crash loop.
     *
     * @generated from field: uint32 restart_count = 14;
     */
    restartCount: number;
    /**
     * Deadline for the next restart attempt or recovery check.
     *
     * @generated from field: google.protobuf.Timestamp next_restart_time = 15;
     */
    nextRestartTime?: Timestamp | undefined;
    /**
     * Time when the current main process became ready.
     *
     * @generated from field: google.protobuf.Timestamp main_process_started_time = 16;
     */
    mainProcessStartedTime?: Timestamp | undefined;
    /**
     * Latest refused token grant across all outbound HTTP protocols, including
     * failures before a configured endpoint or credential could be selected.
     * Matching grant success or a policy, provider, or supervisor reset clears it.
     *
     * @generated from field: openshell.v1.TokenGrantFailureObservation last_token_grant_failure = 17;
     */
    lastTokenGrantFailure?: TokenGrantFailureObservation | undefined;
};
/**
 * Describes the message openshell.v1.SandboxStatus.
 * Use `create(SandboxStatusSchema)` to create a new message.
 */
export declare const SandboxStatusSchema: GenMessage<SandboxStatus>;
/**
 * User-facing sandbox condition derived from platform or gateway observations.
 *
 * @generated from message openshell.v1.SandboxCondition
 */
export type SandboxCondition = Message<"openshell.v1.SandboxCondition"> & {
    /**
     * Condition class, typically mirroring the underlying platform condition type.
     *
     * @generated from field: string type = 1;
     */
    type: string;
    /**
     * Condition status value such as `True`, `False`, or `Unknown`.
     *
     * @generated from field: string status = 2;
     */
    status: string;
    /**
     * Short machine-readable reason associated with the condition.
     *
     * @generated from field: string reason = 3;
     */
    reason: string;
    /**
     * Human-readable condition message.
     *
     * @generated from field: string message = 4;
     */
    message: string;
    /**
     * Timestamp reported by the condition owner for the last transition.
     *
     * @generated from field: google.protobuf.Timestamp transition_time = 105;
     */
    transitionTime?: Timestamp | undefined;
};
/**
 * Describes the message openshell.v1.SandboxCondition.
 * Use `create(SandboxConditionSchema)` to create a new message.
 */
export declare const SandboxConditionSchema: GenMessage<SandboxCondition>;
/**
 * Public platform event exposed on the sandbox watch stream.
 *
 * @generated from message openshell.v1.PlatformEvent
 */
export type PlatformEvent = Message<"openshell.v1.PlatformEvent"> & {
    /**
     * Time when the event occurred.
     *
     * @generated from field: google.protobuf.Timestamp event_time = 101;
     */
    eventTime?: Timestamp | undefined;
    /**
     * Event source (e.g. "kubernetes", "docker", "process").
     *
     * @generated from field: string source = 2;
     */
    source: string;
    /**
     * Event type/severity (e.g. "Normal", "Warning").
     *
     * @generated from field: string type = 3;
     */
    type: string;
    /**
     * Short reason code (e.g. "Started", "Pulled", "Failed").
     *
     * @generated from field: string reason = 4;
     */
    reason: string;
    /**
     * Human-readable event message.
     *
     * @generated from field: string message = 5;
     */
    message: string;
    /**
     * Optional metadata as key-value pairs.
     *
     * @generated from field: map<string, string> metadata = 6;
     */
    metadata: {
        [key: string]: string;
    };
};
/**
 * Describes the message openshell.v1.PlatformEvent.
 * Use `create(PlatformEventSchema)` to create a new message.
 */
export declare const PlatformEventSchema: GenMessage<PlatformEvent>;
/**
 * Create sandbox request.
 *
 * @generated from message openshell.v1.CreateSandboxRequest
 */
export type CreateSandboxRequest = Message<"openshell.v1.CreateSandboxRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 7;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: openshell.v1.SandboxSpec spec = 1;
     */
    spec?: SandboxSpec | undefined;
    /**
     * Optional user-supplied sandbox name. When empty the server generates one.
     *
     * @generated from field: string name = 2;
     */
    name: string;
    /**
     * Optional labels for the sandbox (key-value metadata).
     *
     * @generated from field: map<string, string> labels = 3;
     */
    labels: {
        [key: string]: string;
    };
    /**
     * Optional annotations for the sandbox (non-selector metadata). Keys under
     * the `internal.openshell.ai/` prefix are reserved for the gateway.
     *
     * @generated from field: map<string, string> annotations = 4;
     */
    annotations: {
        [key: string]: string;
    };
    /**
     * One-shot launch hint indicating that the creating client will attach to
     * the canonical main process. The supervisor keeps the terminal transport
     * alive until that attachment connects and closes naturally.
     *
     * @generated from field: bool await_main_process_attachment = 5;
     */
    awaitMainProcessAttachment: boolean;
    /**
     * Workspace-scoped SandboxWorkloadTemplate name to resolve at creation time.
     *
     * @generated from field: string workload_template = 6;
     */
    workloadTemplate: string;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 8;
     */
    requestId: string;
    /**
     * HTTP services to expose when the sandbox is created. Endpoints are
     * registered after the sandbox has been persisted and route only while the
     * sandbox is ready.
     *
     * @generated from field: repeated openshell.v1.SandboxServiceExposure service_exposures = 9;
     */
    serviceExposures: SandboxServiceExposure[];
};
/**
 * Describes the message openshell.v1.CreateSandboxRequest.
 * Use `create(CreateSandboxRequestSchema)` to create a new message.
 */
export declare const CreateSandboxRequestSchema: GenMessage<CreateSandboxRequest>;
/**
 * @generated from message openshell.v1.CreateSandboxTemplateRequest
 */
export type CreateSandboxTemplateRequest = Message<"openshell.v1.CreateSandboxTemplateRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: openshell.v1.SandboxWorkloadTemplate template = 1;
     */
    template?: SandboxWorkloadTemplate | undefined;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 3;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.CreateSandboxTemplateRequest.
 * Use `create(CreateSandboxTemplateRequestSchema)` to create a new message.
 */
export declare const CreateSandboxTemplateRequestSchema: GenMessage<CreateSandboxTemplateRequest>;
/**
 * @generated from message openshell.v1.GetSandboxTemplateRequest
 */
export type GetSandboxTemplateRequest = Message<"openshell.v1.GetSandboxTemplateRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string name = 1;
     */
    name: string;
};
/**
 * Describes the message openshell.v1.GetSandboxTemplateRequest.
 * Use `create(GetSandboxTemplateRequestSchema)` to create a new message.
 */
export declare const GetSandboxTemplateRequestSchema: GenMessage<GetSandboxTemplateRequest>;
/**
 * @generated from message openshell.v1.ListSandboxTemplatesRequest
 */
export type ListSandboxTemplatesRequest = Message<"openshell.v1.ListSandboxTemplatesRequest"> & {
    /**
     * Workspace scope. Named and all-workspaces selections are accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 4;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * The maximum number of templates to return. Zero uses 100. Values above
     * 1000 are coerced to 1000; negative values are invalid.
     *
     * @generated from field: int32 page_size = 1;
     */
    pageSize: number;
    /**
     * Token from a previous ListSandboxTemplates response. All other request
     * parameters except page_size must match the request that produced it.
     *
     * @generated from field: string page_token = 2;
     */
    pageToken: string;
    /**
     * Optional label selector in key=value comma-separated form.
     *
     * @generated from field: string label_selector = 3;
     */
    labelSelector: string;
};
/**
 * Describes the message openshell.v1.ListSandboxTemplatesRequest.
 * Use `create(ListSandboxTemplatesRequestSchema)` to create a new message.
 */
export declare const ListSandboxTemplatesRequestSchema: GenMessage<ListSandboxTemplatesRequest>;
/**
 * @generated from message openshell.v1.DeleteSandboxTemplateRequest
 */
export type DeleteSandboxTemplateRequest = Message<"openshell.v1.DeleteSandboxTemplateRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * Succeed with ALREADY_ABSENT if the target is missing. Authorization and
     * parent-workspace checks still apply.
     *
     * @generated from field: bool allow_missing = 3;
     */
    allowMissing: boolean;
    /**
     * Optional nonzero UUID. Same ID and payload replay success for 24 hours.
     *
     * @generated from field: string request_id = 4;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.DeleteSandboxTemplateRequest.
 * Use `create(DeleteSandboxTemplateRequestSchema)` to create a new message.
 */
export declare const DeleteSandboxTemplateRequestSchema: GenMessage<DeleteSandboxTemplateRequest>;
/**
 * @generated from message openshell.v1.SandboxTemplateResponse
 */
export type SandboxTemplateResponse = Message<"openshell.v1.SandboxTemplateResponse"> & {
    /**
     * @generated from field: openshell.v1.SandboxWorkloadTemplate template = 1;
     */
    template?: SandboxWorkloadTemplate | undefined;
};
/**
 * Describes the message openshell.v1.SandboxTemplateResponse.
 * Use `create(SandboxTemplateResponseSchema)` to create a new message.
 */
export declare const SandboxTemplateResponseSchema: GenMessage<SandboxTemplateResponse>;
/**
 * @generated from message openshell.v1.ListSandboxTemplatesResponse
 */
export type ListSandboxTemplatesResponse = Message<"openshell.v1.ListSandboxTemplatesResponse"> & {
    /**
     * @generated from field: repeated openshell.v1.SandboxWorkloadTemplate templates = 1;
     */
    templates: SandboxWorkloadTemplate[];
    /**
     * Token for the next page. Empty when there are no subsequent pages.
     *
     * @generated from field: string next_page_token = 2;
     */
    nextPageToken: string;
};
/**
 * Describes the message openshell.v1.ListSandboxTemplatesResponse.
 * Use `create(ListSandboxTemplatesResponseSchema)` to create a new message.
 */
export declare const ListSandboxTemplatesResponseSchema: GenMessage<ListSandboxTemplatesResponse>;
/**
 * @generated from message openshell.v1.DeleteSandboxTemplateResponse
 */
export type DeleteSandboxTemplateResponse = Message<"openshell.v1.DeleteSandboxTemplateResponse"> & {
    /**
     * @generated from field: openshell.v1.DeletionOutcome outcome = 2;
     */
    outcome: DeletionOutcome;
};
/**
 * Describes the message openshell.v1.DeleteSandboxTemplateResponse.
 * Use `create(DeleteSandboxTemplateResponseSchema)` to create a new message.
 */
export declare const DeleteSandboxTemplateResponseSchema: GenMessage<DeleteSandboxTemplateResponse>;
/**
 * Request a gateway-owned staging slot for a local rootfs tar archive.
 *
 * @generated from message openshell.v1.BeginRootfsTarStagingRequest
 */
export type BeginRootfsTarStagingRequest = Message<"openshell.v1.BeginRootfsTarStagingRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Base file name of the local archive. The gateway uses it only to name the
     * staged file; path separators and traversal components are rejected.
     *
     * @generated from field: string file_name = 1;
     */
    fileName: string;
    /**
     * Size of the local archive in bytes, checked against the driver limit
     * before the gateway allocates a slot.
     *
     * @generated from field: uint64 size_bytes = 2;
     */
    sizeBytes: bigint;
};
/**
 * Describes the message openshell.v1.BeginRootfsTarStagingRequest.
 * Use `create(BeginRootfsTarStagingRequestSchema)` to create a new message.
 */
export declare const BeginRootfsTarStagingRequestSchema: GenMessage<BeginRootfsTarStagingRequest>;
/**
 * Gateway-issued staging slot.
 *
 * @generated from message openshell.v1.BeginRootfsTarStagingResponse
 */
export type BeginRootfsTarStagingResponse = Message<"openshell.v1.BeginRootfsTarStagingResponse"> & {
    /**
     * Opaque single-use token. Pass it as
     * `template.driver_config.<driver>.rootfs_tar_staging_token` on
     * CreateSandbox. The first CreateSandbox presenting it consumes it.
     *
     * @generated from field: string staging_token = 1;
     */
    stagingToken: string;
    /**
     * Absolute path on the gateway host the client must write the archive to.
     *
     * @generated from field: string upload_path = 2;
     */
    uploadPath: string;
    /**
     * Maximum accepted archive size in bytes, enforced again by the driver.
     *
     * @generated from field: uint64 max_bytes = 3;
     */
    maxBytes: bigint;
    /**
     * Wall-clock deadline after which the gateway reclaims the slot.
     *
     * @generated from field: google.protobuf.Timestamp expiration_time = 104;
     */
    expirationTime?: Timestamp | undefined;
};
/**
 * Describes the message openshell.v1.BeginRootfsTarStagingResponse.
 * Use `create(BeginRootfsTarStagingResponseSchema)` to create a new message.
 */
export declare const BeginRootfsTarStagingResponseSchema: GenMessage<BeginRootfsTarStagingResponse>;
/**
 * Get sandbox request.
 *
 * @generated from message openshell.v1.GetSandboxRequest
 */
export type GetSandboxRequest = Message<"openshell.v1.GetSandboxRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string name = 1;
     */
    name: string;
};
/**
 * Describes the message openshell.v1.GetSandboxRequest.
 * Use `create(GetSandboxRequestSchema)` to create a new message.
 */
export declare const GetSandboxRequestSchema: GenMessage<GetSandboxRequest>;
/**
 * List sandboxes request.
 *
 * @generated from message openshell.v1.ListSandboxesRequest
 */
export type ListSandboxesRequest = Message<"openshell.v1.ListSandboxesRequest"> & {
    /**
     * Workspace scope. Named and all-workspaces selections are accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 4;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * The maximum number of sandboxes to return. Zero uses 100. Values above
     * 1000 are coerced to 1000; negative values are invalid.
     *
     * @generated from field: int32 page_size = 1;
     */
    pageSize: number;
    /**
     * Token from a previous ListSandboxes response. All other request parameters
     * except page_size must match the request that produced it.
     *
     * @generated from field: string page_token = 2;
     */
    pageToken: string;
    /**
     * Optional label selector for filtering (format: "key1=value1,key2=value2").
     *
     * @generated from field: string label_selector = 3;
     */
    labelSelector: string;
};
/**
 * Describes the message openshell.v1.ListSandboxesRequest.
 * Use `create(ListSandboxesRequestSchema)` to create a new message.
 */
export declare const ListSandboxesRequestSchema: GenMessage<ListSandboxesRequest>;
/**
 * List providers attached to a sandbox request.
 *
 * @generated from message openshell.v1.ListSandboxProvidersRequest
 */
export type ListSandboxProvidersRequest = Message<"openshell.v1.ListSandboxProvidersRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * The maximum number of providers to return. Zero uses 100. Values above
     * 1000 are coerced to 1000; negative values are invalid.
     *
     * @generated from field: int32 page_size = 3;
     */
    pageSize: number;
    /**
     * Token from a previous ListSandboxProviders response. All other request
     * parameters except page_size must match the request that produced it.
     *
     * @generated from field: string page_token = 4;
     */
    pageToken: string;
};
/**
 * Describes the message openshell.v1.ListSandboxProvidersRequest.
 * Use `create(ListSandboxProvidersRequestSchema)` to create a new message.
 */
export declare const ListSandboxProvidersRequestSchema: GenMessage<ListSandboxProvidersRequest>;
/**
 * Attach provider to sandbox request.
 *
 * @generated from message openshell.v1.AttachSandboxProviderRequest
 */
export type AttachSandboxProviderRequest = Message<"openshell.v1.AttachSandboxProviderRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 4;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * Provider name to attach.
     *
     * @generated from field: string provider = 2;
     */
    provider: string;
    /**
     * Expected resource version for optimistic concurrency control.
     * If 0, the server uses the current version (backward compatibility).
     * If non-zero, the server validates that the sandbox's current resource_version
     * matches this value before applying the mutation, returning ABORTED on mismatch.
     *
     * @generated from field: uint64 expected_resource_version = 3;
     */
    expectedResourceVersion: bigint;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 5;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.AttachSandboxProviderRequest.
 * Use `create(AttachSandboxProviderRequestSchema)` to create a new message.
 */
export declare const AttachSandboxProviderRequestSchema: GenMessage<AttachSandboxProviderRequest>;
/**
 * Detach provider from sandbox request.
 *
 * @generated from message openshell.v1.DetachSandboxProviderRequest
 */
export type DetachSandboxProviderRequest = Message<"openshell.v1.DetachSandboxProviderRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 4;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * Provider name to detach.
     *
     * @generated from field: string provider = 2;
     */
    provider: string;
    /**
     * Expected resource version for optimistic concurrency control.
     * If 0, the server uses the current version (backward compatibility).
     * If non-zero, the server validates that the sandbox's current resource_version
     * matches this value before applying the mutation, returning ABORTED on mismatch.
     *
     * @generated from field: uint64 expected_resource_version = 3;
     */
    expectedResourceVersion: bigint;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 5;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.DetachSandboxProviderRequest.
 * Use `create(DetachSandboxProviderRequestSchema)` to create a new message.
 */
export declare const DetachSandboxProviderRequestSchema: GenMessage<DetachSandboxProviderRequest>;
/**
 * Delete sandbox request.
 *
 * @generated from message openshell.v1.DeleteSandboxRequest
 */
export type DeleteSandboxRequest = Message<"openshell.v1.DeleteSandboxRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Canonical sandbox name.
     *
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * Succeed with ALREADY_ABSENT if the target is missing. Does not wait for
     * asynchronous cleanup and does not suppress authorization or parent errors.
     *
     * @generated from field: bool allow_missing = 3;
     */
    allowMissing: boolean;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 4;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.DeleteSandboxRequest.
 * Use `create(DeleteSandboxRequestSchema)` to create a new message.
 */
export declare const DeleteSandboxRequestSchema: GenMessage<DeleteSandboxRequest>;
/**
 * Stop sandbox request.
 *
 * @generated from message openshell.v1.StopSandboxRequest
 */
export type StopSandboxRequest = Message<"openshell.v1.StopSandboxRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 3;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.StopSandboxRequest.
 * Use `create(StopSandboxRequestSchema)` to create a new message.
 */
export declare const StopSandboxRequestSchema: GenMessage<StopSandboxRequest>;
/**
 * Start sandbox request.
 *
 * @generated from message openshell.v1.StartSandboxRequest
 */
export type StartSandboxRequest = Message<"openshell.v1.StartSandboxRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 3;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.StartSandboxRequest.
 * Use `create(StartSandboxRequestSchema)` to create a new message.
 */
export declare const StartSandboxRequestSchema: GenMessage<StartSandboxRequest>;
/**
 * Sandbox response.
 *
 * @generated from message openshell.v1.SandboxResponse
 */
export type SandboxResponse = Message<"openshell.v1.SandboxResponse"> & {
    /**
     * @generated from field: openshell.v1.Sandbox sandbox = 1;
     */
    sandbox?: Sandbox | undefined;
    /**
     * Service URLs created by CreateSandbox, keyed by service name. The empty
     * key identifies the unnamed service. Other sandbox RPCs return an empty map.
     *
     * @generated from field: map<string, string> service_urls = 2;
     */
    serviceUrls: {
        [key: string]: string;
    };
};
/**
 * Describes the message openshell.v1.SandboxResponse.
 * Use `create(SandboxResponseSchema)` to create a new message.
 */
export declare const SandboxResponseSchema: GenMessage<SandboxResponse>;
/**
 * List sandboxes response.
 *
 * @generated from message openshell.v1.ListSandboxesResponse
 */
export type ListSandboxesResponse = Message<"openshell.v1.ListSandboxesResponse"> & {
    /**
     * @generated from field: repeated openshell.v1.Sandbox sandboxes = 1;
     */
    sandboxes: Sandbox[];
    /**
     * Token for the next page. Empty when there are no subsequent pages.
     *
     * @generated from field: string next_page_token = 2;
     */
    nextPageToken: string;
};
/**
 * Describes the message openshell.v1.ListSandboxesResponse.
 * Use `create(ListSandboxesResponseSchema)` to create a new message.
 */
export declare const ListSandboxesResponseSchema: GenMessage<ListSandboxesResponse>;
/**
 * List providers attached to a sandbox response.
 *
 * @generated from message openshell.v1.ListSandboxProvidersResponse
 */
export type ListSandboxProvidersResponse = Message<"openshell.v1.ListSandboxProvidersResponse"> & {
    /**
     * @generated from field: repeated openshell.datamodel.v1.Provider providers = 1;
     */
    providers: Provider[];
    /**
     * Token for the next page. Empty when there are no subsequent pages.
     *
     * @generated from field: string next_page_token = 2;
     */
    nextPageToken: string;
};
/**
 * Describes the message openshell.v1.ListSandboxProvidersResponse.
 * Use `create(ListSandboxProvidersResponseSchema)` to create a new message.
 */
export declare const ListSandboxProvidersResponseSchema: GenMessage<ListSandboxProvidersResponse>;
/**
 * Attach provider to sandbox response.
 *
 * @generated from message openshell.v1.AttachSandboxProviderResponse
 */
export type AttachSandboxProviderResponse = Message<"openshell.v1.AttachSandboxProviderResponse"> & {
    /**
     * @generated from field: openshell.v1.Sandbox sandbox = 1;
     */
    sandbox?: Sandbox | undefined;
    /**
     * True when the provider was newly attached. False means it was already attached.
     *
     * @generated from field: bool attached = 2;
     */
    attached: boolean;
    /**
     * Persisted intent; readiness requires current supervisor observations.
     *
     * @generated from field: openshell.v1.ProviderMutationReceipt receipt = 3;
     */
    receipt?: ProviderMutationReceipt | undefined;
};
/**
 * Describes the message openshell.v1.AttachSandboxProviderResponse.
 * Use `create(AttachSandboxProviderResponseSchema)` to create a new message.
 */
export declare const AttachSandboxProviderResponseSchema: GenMessage<AttachSandboxProviderResponse>;
/**
 * Detach provider from sandbox response.
 *
 * @generated from message openshell.v1.DetachSandboxProviderResponse
 */
export type DetachSandboxProviderResponse = Message<"openshell.v1.DetachSandboxProviderResponse"> & {
    /**
     * @generated from field: openshell.v1.Sandbox sandbox = 1;
     */
    sandbox?: Sandbox | undefined;
    /**
     * True when the provider was removed. False means it was not attached.
     *
     * @generated from field: bool detached = 2;
     */
    detached: boolean;
    /**
     * Revocation is complete only when this receipt reports REVOKED.
     *
     * @generated from field: openshell.v1.ProviderMutationReceipt receipt = 3;
     */
    receipt?: ProviderMutationReceipt | undefined;
};
/**
 * Describes the message openshell.v1.DetachSandboxProviderResponse.
 * Use `create(DetachSandboxProviderResponseSchema)` to create a new message.
 */
export declare const DetachSandboxProviderResponseSchema: GenMessage<DetachSandboxProviderResponse>;
/**
 * Exact desired authority. Revisions are opaque identities, never ordered.
 *
 * @generated from message openshell.v1.ProviderDesiredIdentity
 */
export type ProviderDesiredIdentity = Message<"openshell.v1.ProviderDesiredIdentity"> & {
    /**
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * @generated from field: string sandbox = 2;
     */
    sandbox: string;
    /**
     * @generated from field: string attachment_epoch = 3;
     */
    attachmentEpoch: string;
    /**
     * Empty for a detached provider.
     *
     * @generated from field: string provider_id = 4;
     */
    providerId: string;
    /**
     * @generated from field: uint64 provider_resource_version = 5;
     */
    providerResourceVersion: bigint;
    /**
     * @generated from field: uint64 provider_env_revision = 6;
     */
    providerEnvRevision: bigint;
    /**
     * @generated from field: uint64 config_revision = 7;
     */
    configRevision: bigint;
    /**
     * @generated from field: string policy_hash = 8;
     */
    policyHash: string;
};
/**
 * Describes the message openshell.v1.ProviderDesiredIdentity.
 * Use `create(ProviderDesiredIdentitySchema)` to create a new message.
 */
export declare const ProviderDesiredIdentitySchema: GenMessage<ProviderDesiredIdentity>;
/**
 * Identifies one component snapshot revision. Revisions are equality tokens,
 * not members of one shared ordering domain.
 *
 * @generated from message openshell.v1.ConfigSnapshotRevision
 */
export type ConfigSnapshotRevision = Message<"openshell.v1.ConfigSnapshotRevision"> & {
    /**
     * @generated from oneof openshell.v1.ConfigSnapshotRevision.component
     */
    component: {
        /**
         * @generated from field: openshell.v1.SandboxConfigRevision sandbox_config = 1;
         */
        value: SandboxConfigRevision;
        case: "sandboxConfig";
    } | {
        /**
         * @generated from field: uint64 provider_environment = 2;
         */
        value: bigint;
        case: "providerEnvironment";
    } | {
        /**
         * Complete desired authority for one sandbox-scoped provider mutation.
         *
         * @generated from field: openshell.v1.ProviderDesiredIdentity provider_target = 3;
         */
        value: ProviderDesiredIdentity;
        case: "providerTarget";
    } | {
        case: undefined;
        value?: undefined;
    };
};
/**
 * Describes the message openshell.v1.ConfigSnapshotRevision.
 * Use `create(ConfigSnapshotRevisionSchema)` to create a new message.
 */
export declare const ConfigSnapshotRevisionSchema: GenMessage<ConfigSnapshotRevision>;
/**
 * Identity needed to correlate effective sandbox configuration with the
 * policy-history row whose apply status the gateway records.
 *
 * @generated from message openshell.v1.SandboxConfigRevision
 */
export type SandboxConfigRevision = Message<"openshell.v1.SandboxConfigRevision"> & {
    /**
     * @generated from field: uint64 config_revision = 1;
     */
    configRevision: bigint;
    /**
     * @generated from field: uint32 policy_version = 2;
     */
    policyVersion: number;
    /**
     * @generated from field: openshell.sandbox.v1.PolicySource policy_source = 3;
     */
    policySource: PolicySource;
    /**
     * @generated from field: uint32 global_policy_version = 4;
     */
    globalPolicyVersion: number;
    /**
     * Monotonic revision of the sandbox-scoped settings row. This disambiguates
     * setting operations whose effective config fingerprint is equality-only.
     *
     * @generated from field: uint64 settings_revision = 5;
     */
    settingsRevision: bigint;
};
/**
 * Describes the message openshell.v1.SandboxConfigRevision.
 * Use `create(SandboxConfigRevisionSchema)` to create a new message.
 */
export declare const SandboxConfigRevisionSchema: GenMessage<SandboxConfigRevision>;
/**
 * Durable progress for one sandbox-scoped desired-state mutation. Snapshot
 * contents and credentials are never stored in this resource.
 *
 * @generated from message openshell.v1.ConfigUpdateOperation
 */
export type ConfigUpdateOperation = Message<"openshell.v1.ConfigUpdateOperation"> & {
    /**
     * @generated from field: string operation_id = 1;
     */
    operationId: string;
    /**
     * @generated from field: string sandbox_id = 2;
     */
    sandboxId: string;
    /**
     * @generated from field: openshell.v1.ConfigComponent component = 3;
     */
    component: ConfigComponent;
    /**
     * @generated from field: openshell.v1.ConfigSnapshotRevision target_revision = 4;
     */
    targetRevision?: ConfigSnapshotRevision | undefined;
    /**
     * @generated from field: openshell.v1.ConfigUpdateOperationState state = 5;
     */
    state: ConfigUpdateOperationState;
    /**
     * @generated from field: openshell.v1.ConfigApplyOutcome outcome = 6;
     */
    outcome: ConfigApplyOutcome;
    /**
     * @generated from field: string sanitized_error = 7;
     */
    sanitizedError: string;
    /**
     * @generated from field: google.protobuf.Timestamp created_time = 108;
     */
    createdTime?: Timestamp | undefined;
    /**
     * @generated from field: google.protobuf.Timestamp updated_time = 109;
     */
    updatedTime?: Timestamp | undefined;
    /**
     * Absent until the operation reaches a terminal state.
     *
     * @generated from field: google.protobuf.Timestamp completed_time = 110;
     */
    completedTime?: Timestamp | undefined;
};
/**
 * Describes the message openshell.v1.ConfigUpdateOperation.
 * Use `create(ConfigUpdateOperationSchema)` to create a new message.
 */
export declare const ConfigUpdateOperationSchema: GenMessage<ConfigUpdateOperation>;
/**
 * Immutable, secret-free record of one sandbox's intended provider mutation.
 *
 * @generated from message openshell.v1.ProviderMutationReceipt
 */
export type ProviderMutationReceipt = Message<"openshell.v1.ProviderMutationReceipt"> & {
    /**
     * @generated from field: string receipt_id = 1;
     */
    receiptId: string;
    /**
     * Shared by all sandbox receipts from one provider update.
     *
     * @generated from field: string mutation_id = 2;
     */
    mutationId: string;
    /**
     * @generated from field: string provider = 3;
     */
    provider: string;
    /**
     * @generated from field: string workspace = 4;
     */
    workspace: string;
    /**
     * @generated from field: openshell.v1.ProviderMutationKind kind = 5;
     */
    kind: ProviderMutationKind;
    /**
     * @generated from field: openshell.v1.ProviderDesiredIdentity desired = 6;
     */
    desired?: ProviderDesiredIdentity | undefined;
    /**
     * @generated from field: google.protobuf.Timestamp persisted_time = 107;
     */
    persistedTime?: Timestamp | undefined;
};
/**
 * Describes the message openshell.v1.ProviderMutationReceipt.
 * Use `create(ProviderMutationReceiptSchema)` to create a new message.
 */
export declare const ProviderMutationReceiptSchema: GenMessage<ProviderMutationReceipt>;
/**
 * Installed state reported by the current supervisor. Process installation is
 * acknowledged by the authenticated sandbox boundary after replacing its
 * environment for future process launches.
 *
 * @generated from message openshell.v1.ProviderReadinessObservation
 */
export type ProviderReadinessObservation = Message<"openshell.v1.ProviderReadinessObservation"> & {
    /**
     * Gateway-issued identifier from the current ConnectSupervisor response.
     *
     * @generated from field: string session_id = 1;
     */
    sessionId: string;
    /**
     * Monotonic only within this connection; unrelated to revision fingerprints.
     *
     * @generated from field: uint64 sequence = 2;
     */
    sequence: bigint;
    /**
     * @generated from field: string attachment_epoch = 3;
     */
    attachmentEpoch: string;
    /**
     * @generated from field: uint64 provider_env_revision = 4;
     */
    providerEnvRevision: bigint;
    /**
     * @generated from field: uint64 config_revision = 5;
     */
    configRevision: bigint;
    /**
     * @generated from field: string policy_hash = 6;
     */
    policyHash: string;
    /**
     * @generated from field: bool credentials_installed = 7;
     */
    credentialsInstalled: boolean;
    /**
     * @generated from field: bool policy_active = 8;
     */
    policyActive: boolean;
    /**
     * @generated from field: bool launch_environment_installed = 9;
     */
    launchEnvironmentInstalled: boolean;
    /**
     * @generated from field: string process_instance_id = 10;
     */
    processInstanceId: string;
    /**
     * @generated from field: openshell.v1.ProviderReadinessReason reason = 11;
     */
    reason: ProviderReadinessReason;
};
/**
 * Describes the message openshell.v1.ProviderReadinessObservation.
 * Use `create(ProviderReadinessObservationSchema)` to create a new message.
 */
export declare const ProviderReadinessObservationSchema: GenMessage<ProviderReadinessObservation>;
/**
 * Operator view of desired and observed state; contains no credential material.
 *
 * @generated from message openshell.v1.ProviderReadinessStatus
 */
export type ProviderReadinessStatus = Message<"openshell.v1.ProviderReadinessStatus"> & {
    /**
     * @generated from field: openshell.v1.ProviderMutationReceipt receipt = 1;
     */
    receipt?: ProviderMutationReceipt | undefined;
    /**
     * @generated from field: openshell.v1.ProviderReadinessState state = 2;
     */
    state: ProviderReadinessState;
    /**
     * @generated from field: openshell.v1.ProviderReadinessReason reason = 3;
     */
    reason: ProviderReadinessReason;
    /**
     * @generated from field: openshell.v1.ProviderReadinessObservation observed = 4;
     */
    observed?: ProviderReadinessObservation | undefined;
    /**
     * @generated from field: string network_instance_id = 5;
     */
    networkInstanceId: string;
    /**
     * Absent until the current supervisor session supplies accepted evidence.
     *
     * @generated from field: google.protobuf.Timestamp observed_time = 106;
     */
    observedTime?: Timestamp | undefined;
    /**
     * @generated from field: google.protobuf.Timestamp evaluated_time = 107;
     */
    evaluatedTime?: Timestamp | undefined;
    /**
     * Durable operation for the receipt, including its terminal apply outcome.
     *
     * @generated from field: openshell.v1.ConfigUpdateOperation operation = 8;
     */
    operation?: ConfigUpdateOperation | undefined;
};
/**
 * Describes the message openshell.v1.ProviderReadinessStatus.
 * Use `create(ProviderReadinessStatusSchema)` to create a new message.
 */
export declare const ProviderReadinessStatusSchema: GenMessage<ProviderReadinessStatus>;
/**
 * Query an immutable receipt, or reconstruct the current desired state when
 * receipt_id is empty. The sandbox identity must match the receipt.
 *
 * @generated from message openshell.v1.GetSandboxProviderStatusRequest
 */
export type GetSandboxProviderStatusRequest = Message<"openshell.v1.GetSandboxProviderStatusRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 4;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * @generated from field: string provider = 2;
     */
    provider: string;
    /**
     * @generated from field: string receipt_id = 3;
     */
    receiptId: string;
};
/**
 * Describes the message openshell.v1.GetSandboxProviderStatusRequest.
 * Use `create(GetSandboxProviderStatusRequestSchema)` to create a new message.
 */
export declare const GetSandboxProviderStatusRequestSchema: GenMessage<GetSandboxProviderStatusRequest>;
/**
 * @generated from message openshell.v1.GetSandboxProviderStatusResponse
 */
export type GetSandboxProviderStatusResponse = Message<"openshell.v1.GetSandboxProviderStatusResponse"> & {
    /**
     * @generated from field: openshell.v1.ProviderReadinessStatus status = 1;
     */
    status?: ProviderReadinessStatus | undefined;
};
/**
 * Describes the message openshell.v1.GetSandboxProviderStatusResponse.
 * Use `create(GetSandboxProviderStatusResponseSchema)` to create a new message.
 */
export declare const GetSandboxProviderStatusResponseSchema: GenMessage<GetSandboxProviderStatusResponse>;
/**
 * Installation evidence from the authenticated supervisor for this sandbox.
 * A caller-provided instance identifier alone never establishes authority.
 *
 * @generated from message openshell.v1.ReportProviderReadinessRequest
 */
export type ReportProviderReadinessRequest = Message<"openshell.v1.ReportProviderReadinessRequest"> & {
    /**
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * @generated from field: openshell.v1.ProviderReadinessObservation observation = 2;
     */
    observation?: ProviderReadinessObservation | undefined;
};
/**
 * Describes the message openshell.v1.ReportProviderReadinessRequest.
 * Use `create(ReportProviderReadinessRequestSchema)` to create a new message.
 */
export declare const ReportProviderReadinessRequestSchema: GenMessage<ReportProviderReadinessRequest>;
/**
 * Acknowledges accepted evidence without granting a separate session authority.
 * Identical retries do not extend the evidence's original acceptance time.
 *
 * @generated from message openshell.v1.ReportProviderReadinessResponse
 */
export type ReportProviderReadinessResponse = Message<"openshell.v1.ReportProviderReadinessResponse"> & {
    /**
     * @generated from field: uint64 accepted_sequence = 1;
     */
    acceptedSequence: bigint;
    /**
     * @generated from field: google.protobuf.Duration report_interval = 102;
     */
    reportInterval?: Duration | undefined;
    /**
     * @generated from field: google.protobuf.Duration observation_ttl = 103;
     */
    observationTtl?: Duration | undefined;
};
/**
 * Describes the message openshell.v1.ReportProviderReadinessResponse.
 * Use `create(ReportProviderReadinessResponseSchema)` to create a new message.
 */
export declare const ReportProviderReadinessResponseSchema: GenMessage<ReportProviderReadinessResponse>;
/**
 * Delete sandbox response.
 *
 * @generated from message openshell.v1.DeleteSandboxResponse
 */
export type DeleteSandboxResponse = Message<"openshell.v1.DeleteSandboxResponse"> & {
    /**
     * @generated from field: openshell.v1.DeletionOutcome outcome = 2;
     */
    outcome: DeletionOutcome;
    /**
     * Immutable identity of the targeted sandbox, empty for ALREADY_ABSENT.
     * A same-name replacement is not part of this deletion.
     *
     * @generated from field: string sandbox_id = 3;
     */
    sandboxId: string;
};
/**
 * Describes the message openshell.v1.DeleteSandboxResponse.
 * Use `create(DeleteSandboxResponseSchema)` to create a new message.
 */
export declare const DeleteSandboxResponseSchema: GenMessage<DeleteSandboxResponse>;
/**
 * Create SSH session request.
 *
 * @generated from message openshell.v1.CreateSshSessionRequest
 */
export type CreateSshSessionRequest = Message<"openshell.v1.CreateSshSessionRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
};
/**
 * Describes the message openshell.v1.CreateSshSessionRequest.
 * Use `create(CreateSshSessionRequestSchema)` to create a new message.
 */
export declare const CreateSshSessionRequestSchema: GenMessage<CreateSshSessionRequest>;
/**
 * Create SSH session response.
 *
 * Fields are interpolated into an SSH `ProxyCommand` string that OpenSSH
 * executes through `/bin/sh -c` on the caller's workstation. Servers MUST
 * uphold the charset contract below; clients MUST reject responses that
 * violate it. The client's own escaping provides defense-in-depth, but
 * narrow charsets close injection vectors at the trust boundary.
 *
 * @generated from message openshell.v1.CreateSshSessionResponse
 */
export type CreateSshSessionResponse = Message<"openshell.v1.CreateSshSessionResponse"> & {
    /**
     * Sandbox id. [A-Za-z0-9._-]{1,128}.
     *
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * Session token for the gateway tunnel. URL-safe ASCII
     * ([A-Za-z0-9._~+/=-]) up to 4096 bytes. No shell metacharacters or
     * whitespace.
     *
     * @generated from field: string token = 2;
     */
    token: string;
    /**
     * Gateway host for SSH proxy connection. IPv4 address, bracketed IPv6
     * address, or DNS hostname (Punycode-encoded for IDN). Alphanumeric plus
     * `.-:[]` only, up to 253 bytes.
     *
     * @generated from field: string gateway_host = 3;
     */
    gatewayHost: string;
    /**
     * Gateway port for SSH proxy connection. Must be in range 1..=65535.
     *
     * @generated from field: uint32 gateway_port = 4;
     */
    gatewayPort: number;
    /**
     * Gateway scheme. Must be exactly "http" or "https".
     *
     * @generated from field: string gateway_scheme = 5;
     */
    gatewayScheme: string;
    /**
     * Expected sandbox SSH host identity in OpenSSH SHA256:<base64> form.
     * Stable for the sandbox's lifetime. Empty only for legacy runtimes.
     *
     * @generated from field: string host_key_fingerprint = 7;
     */
    hostKeyFingerprint: string;
    /**
     * Absolute expiry. Absence means no expiry.
     *
     * @generated from field: google.protobuf.Timestamp expiration_time = 108;
     */
    expirationTime?: Timestamp | undefined;
};
/**
 * Describes the message openshell.v1.CreateSshSessionResponse.
 * Use `create(CreateSshSessionResponseSchema)` to create a new message.
 */
export declare const CreateSshSessionResponseSchema: GenMessage<CreateSshSessionResponse>;
/**
 * Request to expose an HTTP service running inside a sandbox.
 *
 * @generated from message openshell.v1.ExposeServiceRequest
 */
export type ExposeServiceRequest = Message<"openshell.v1.ExposeServiceRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 5;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Service name within the sandbox.
     *
     * @generated from field: string name = 2;
     */
    name: string;
    /**
     * Loopback TCP port inside the sandbox.
     *
     * @generated from field: uint32 target_port = 3;
     */
    targetPort: number;
    /**
     * Whether to print/use the browser-facing service URL.
     *
     * @generated from field: bool domain = 4;
     */
    domain: boolean;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 6;
     */
    requestId: string;
    /**
     * Application authorization behavior. Omission resolves to STRIP.
     *
     * @generated from field: openshell.v1.ServiceAuthorizationMode authorization_mode = 7;
     */
    authorizationMode: ServiceAuthorizationMode;
};
/**
 * Describes the message openshell.v1.ExposeServiceRequest.
 * Use `create(ExposeServiceRequestSchema)` to create a new message.
 */
export declare const ExposeServiceRequestSchema: GenMessage<ExposeServiceRequest>;
/**
 * Request to fetch an exposed sandbox service endpoint.
 *
 * @generated from message openshell.v1.GetServiceRequest
 */
export type GetServiceRequest = Message<"openshell.v1.GetServiceRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Service name within the sandbox. Empty selects the unnamed endpoint.
     *
     * @generated from field: string name = 2;
     */
    name: string;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
};
/**
 * Describes the message openshell.v1.GetServiceRequest.
 * Use `create(GetServiceRequestSchema)` to create a new message.
 */
export declare const GetServiceRequestSchema: GenMessage<GetServiceRequest>;
/**
 * Request to list exposed sandbox service endpoints.
 *
 * @generated from message openshell.v1.ListServicesRequest
 */
export type ListServicesRequest = Message<"openshell.v1.ListServicesRequest"> & {
    /**
     * Workspace scope. Named and all-workspaces selections are accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 4;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * The maximum number of services to return. Zero uses 100. Values above
     * 1000 are coerced to 1000; negative values are invalid.
     *
     * @generated from field: int32 page_size = 2;
     */
    pageSize: number;
    /**
     * Token from a previous ListServices response. All other request parameters
     * except page_size must match the request that produced it.
     *
     * @generated from field: string page_token = 3;
     */
    pageToken: string;
    /**
     * Optional sandbox name. Empty lists endpoints for all sandboxes.
     *
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
};
/**
 * Describes the message openshell.v1.ListServicesRequest.
 * Use `create(ListServicesRequestSchema)` to create a new message.
 */
export declare const ListServicesRequestSchema: GenMessage<ListServicesRequest>;
/**
 * Response containing exposed sandbox service endpoints.
 *
 * @generated from message openshell.v1.ListServicesResponse
 */
export type ListServicesResponse = Message<"openshell.v1.ListServicesResponse"> & {
    /**
     * @generated from field: repeated openshell.v1.ServiceEndpointResponse services = 1;
     */
    services: ServiceEndpointResponse[];
    /**
     * Token for the next page. Empty when there are no subsequent pages.
     *
     * @generated from field: string next_page_token = 2;
     */
    nextPageToken: string;
};
/**
 * Describes the message openshell.v1.ListServicesResponse.
 * Use `create(ListServicesResponseSchema)` to create a new message.
 */
export declare const ListServicesResponseSchema: GenMessage<ListServicesResponse>;
/**
 * Request to delete an exposed sandbox service endpoint.
 *
 * @generated from message openshell.v1.DeleteServiceRequest
 */
export type DeleteServiceRequest = Message<"openshell.v1.DeleteServiceRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Service name within the sandbox. Empty selects the unnamed endpoint.
     *
     * @generated from field: string name = 2;
     */
    name: string;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * @generated from field: bool allow_missing = 4;
     */
    allowMissing: boolean;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 5;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.DeleteServiceRequest.
 * Use `create(DeleteServiceRequestSchema)` to create a new message.
 */
export declare const DeleteServiceRequestSchema: GenMessage<DeleteServiceRequest>;
/**
 * Response for deleting an exposed sandbox service endpoint.
 *
 * @generated from message openshell.v1.DeleteServiceResponse
 */
export type DeleteServiceResponse = Message<"openshell.v1.DeleteServiceResponse"> & {
    /**
     * @generated from field: openshell.v1.DeletionOutcome outcome = 2;
     */
    outcome: DeletionOutcome;
};
/**
 * Describes the message openshell.v1.DeleteServiceResponse.
 * Use `create(DeleteServiceResponseSchema)` to create a new message.
 */
export declare const DeleteServiceResponseSchema: GenMessage<DeleteServiceResponse>;
/**
 * Persisted sandbox service endpoint.
 *
 * @generated from message openshell.v1.ServiceEndpoint
 */
export type ServiceEndpoint = Message<"openshell.v1.ServiceEndpoint"> & {
    /**
     * Kubernetes-style metadata.
     *
     * @generated from field: openshell.datamodel.v1.ObjectMeta metadata = 1;
     */
    metadata?: ObjectMeta | undefined;
    /**
     * Sandbox object ID.
     *
     * @generated from field: string sandbox_id = 2;
     */
    sandboxId: string;
    /**
     * Sandbox name.
     *
     * @generated from field: string sandbox = 3;
     */
    sandbox: string;
    /**
     * Service name within the sandbox.
     *
     * @generated from field: string name = 4;
     */
    name: string;
    /**
     * Loopback TCP port inside the sandbox.
     *
     * @generated from field: uint32 target_port = 5;
     */
    targetPort: number;
    /**
     * Whether browser-facing service routing is enabled for this endpoint.
     *
     * @generated from field: bool domain = 6;
     */
    domain: boolean;
    /**
     * Effective application authorization behavior for ingress requests.
     *
     * @generated from field: openshell.v1.ServiceAuthorizationMode authorization_mode = 7;
     */
    authorizationMode: ServiceAuthorizationMode;
};
/**
 * Describes the message openshell.v1.ServiceEndpoint.
 * Use `create(ServiceEndpointSchema)` to create a new message.
 */
export declare const ServiceEndpointSchema: GenMessage<ServiceEndpoint>;
/**
 * Response containing a service endpoint and, when available, its local URL.
 *
 * @generated from message openshell.v1.ServiceEndpointResponse
 */
export type ServiceEndpointResponse = Message<"openshell.v1.ServiceEndpointResponse"> & {
    /**
     * @generated from field: openshell.v1.ServiceEndpoint endpoint = 1;
     */
    endpoint?: ServiceEndpoint | undefined;
    /**
     * @generated from field: string url = 2;
     */
    url: string;
};
/**
 * Describes the message openshell.v1.ServiceEndpointResponse.
 * Use `create(ServiceEndpointResponseSchema)` to create a new message.
 */
export declare const ServiceEndpointResponseSchema: GenMessage<ServiceEndpointResponse>;
/**
 * Revoke SSH session request.
 *
 * @generated from message openshell.v1.RevokeSshSessionRequest
 */
export type RevokeSshSessionRequest = Message<"openshell.v1.RevokeSshSessionRequest"> & {
    /**
     * Session token to revoke.
     *
     * @generated from field: string token = 1;
     */
    token: string;
    /**
     * A missing token is NOT_FOUND unless this is true. Revoking an existing,
     * already-revoked session succeeds with COMPLETED.
     *
     * @generated from field: bool allow_missing = 2;
     */
    allowMissing: boolean;
};
/**
 * Describes the message openshell.v1.RevokeSshSessionRequest.
 * Use `create(RevokeSshSessionRequestSchema)` to create a new message.
 */
export declare const RevokeSshSessionRequestSchema: GenMessage<RevokeSshSessionRequest>;
/**
 * Revoke SSH session response.
 *
 * @generated from message openshell.v1.RevokeSshSessionResponse
 */
export type RevokeSshSessionResponse = Message<"openshell.v1.RevokeSshSessionResponse"> & {
    /**
     * @generated from field: openshell.v1.DeletionOutcome outcome = 2;
     */
    outcome: DeletionOutcome;
};
/**
 * Describes the message openshell.v1.RevokeSshSessionResponse.
 * Use `create(RevokeSshSessionResponseSchema)` to create a new message.
 */
export declare const RevokeSshSessionResponseSchema: GenMessage<RevokeSshSessionResponse>;
/**
 * Execute command request.
 *
 * @generated from message openshell.v1.ExecSandboxRequest
 */
export type ExecSandboxRequest = Message<"openshell.v1.ExecSandboxRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 12;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Canonical sandbox name.
     *
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * Command and arguments.
     *
     * @generated from field: repeated string command = 2;
     */
    command: string[];
    /**
     * Optional working directory.
     *
     * @generated from field: string workdir = 3;
     */
    workdir: string;
    /**
     * Optional environment overrides.
     *
     * @generated from field: map<string, string> environment = 4;
     */
    environment: {
        [key: string]: string;
    };
    /**
     * Optional execution timeout. Absence means no timeout.
     *
     * @generated from field: google.protobuf.Duration execution_timeout = 105;
     */
    executionTimeout?: Duration | undefined;
    /**
     * Optional stdin payload passed to the command.
     *
     * @generated from field: bytes stdin = 6;
     */
    stdin: Uint8Array;
    /**
     * Request a pseudo-terminal for the remote command.
     *
     * @generated from field: bool tty = 7;
     */
    tty: boolean;
    /**
     * Initial terminal columns (used when tty=true, 0 = use default).
     *
     * @generated from field: uint32 cols = 8;
     */
    cols: number;
    /**
     * Initial terminal rows (used when tty=true, 0 = use default).
     *
     * @generated from field: uint32 rows = 9;
     */
    rows: number;
    /**
     * Skip sourcing shell login/profile startup files before running the command.
     * When false (the default), the command runs through a login shell
     * (`bash -lc`) so user startup files (.bash_profile/.profile, and .bashrc if
     * sourced by them) are applied. When true, the command runs without those
     * files (`bash -c`), for automation that needs predictable startup behavior.
     *
     * @generated from field: bool no_login_shell = 10;
     */
    noLoginShell: boolean;
    /**
     * Optional nonzero UUID for durable launch admission. Also applies to the
     * initial ExecSandboxInteractive start message. Duplicates never relaunch,
     * reattach, or replay output/stdin. Unconfirmed executions remain fenced;
     * confirmed terminal executions retain the fence for 24 hours.
     *
     * @generated from field: string request_id = 11;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.ExecSandboxRequest.
 * Use `create(ExecSandboxRequestSchema)` to create a new message.
 */
export declare const ExecSandboxRequestSchema: GenMessage<ExecSandboxRequest>;
/**
 * One stdout chunk from a sandbox exec.
 *
 * @generated from message openshell.v1.ExecSandboxStdout
 */
export type ExecSandboxStdout = Message<"openshell.v1.ExecSandboxStdout"> & {
    /**
     * @generated from field: bytes data = 1;
     */
    data: Uint8Array;
};
/**
 * Describes the message openshell.v1.ExecSandboxStdout.
 * Use `create(ExecSandboxStdoutSchema)` to create a new message.
 */
export declare const ExecSandboxStdoutSchema: GenMessage<ExecSandboxStdout>;
/**
 * One stderr chunk from a sandbox exec.
 *
 * @generated from message openshell.v1.ExecSandboxStderr
 */
export type ExecSandboxStderr = Message<"openshell.v1.ExecSandboxStderr"> & {
    /**
     * @generated from field: bytes data = 1;
     */
    data: Uint8Array;
};
/**
 * Describes the message openshell.v1.ExecSandboxStderr.
 * Use `create(ExecSandboxStderrSchema)` to create a new message.
 */
export declare const ExecSandboxStderrSchema: GenMessage<ExecSandboxStderr>;
/**
 * Final exit status for a sandbox exec.
 *
 * @generated from message openshell.v1.ExecSandboxExit
 */
export type ExecSandboxExit = Message<"openshell.v1.ExecSandboxExit"> & {
    /**
     * @generated from field: int32 exit_code = 1;
     */
    exitCode: number;
};
/**
 * Describes the message openshell.v1.ExecSandboxExit.
 * Use `create(ExecSandboxExitSchema)` to create a new message.
 */
export declare const ExecSandboxExitSchema: GenMessage<ExecSandboxExit>;
/**
 * One event in a sandbox exec stream.
 *
 * @generated from message openshell.v1.ExecSandboxEvent
 */
export type ExecSandboxEvent = Message<"openshell.v1.ExecSandboxEvent"> & {
    /**
     * @generated from oneof openshell.v1.ExecSandboxEvent.payload
     */
    payload: {
        /**
         * @generated from field: openshell.v1.ExecSandboxStdout stdout = 1;
         */
        value: ExecSandboxStdout;
        case: "stdout";
    } | {
        /**
         * @generated from field: openshell.v1.ExecSandboxStderr stderr = 2;
         */
        value: ExecSandboxStderr;
        case: "stderr";
    } | {
        /**
         * @generated from field: openshell.v1.ExecSandboxExit exit = 3;
         */
        value: ExecSandboxExit;
        case: "exit";
    } | {
        case: undefined;
        value?: undefined;
    };
};
/**
 * Describes the message openshell.v1.ExecSandboxEvent.
 * Use `create(ExecSandboxEventSchema)` to create a new message.
 */
export declare const ExecSandboxEventSchema: GenMessage<ExecSandboxEvent>;
/**
 * Initial frame for one TCP forward stream.
 *
 * @generated from message openshell.v1.TcpForwardInit
 */
export type TcpForwardInit = Message<"openshell.v1.TcpForwardInit"> & {
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * @generated from field: string workspace = 3;
     */
    workspace: string;
    /**
     * Optional service identifier for audit/correlation.
     *
     * @generated from field: string service_id = 4;
     */
    serviceId: string;
    /**
     * Target the gateway should request from the supervisor.
     *
     * @generated from oneof openshell.v1.TcpForwardInit.target
     */
    target: {
        /**
         * @generated from field: openshell.v1.SshRelayTarget ssh = 5;
         */
        value: SshRelayTarget;
        case: "ssh";
    } | {
        /**
         * @generated from field: openshell.v1.TcpRelayTarget tcp = 6;
         */
        value: TcpRelayTarget;
        case: "tcp";
    } | {
        case: undefined;
        value?: undefined;
    };
    /**
     * Optional target-specific authorization token. SSH targets use this as the
     * short-lived SSH session token issued by CreateSshSession.
     *
     * @generated from field: string authorization_token = 7;
     */
    authorizationToken: string;
};
/**
 * Describes the message openshell.v1.TcpForwardInit.
 * Use `create(TcpForwardInitSchema)` to create a new message.
 */
export declare const TcpForwardInitSchema: GenMessage<TcpForwardInit>;
/**
 * A single frame on the CLI-to-gateway TCP forward stream.
 *
 * @generated from message openshell.v1.TcpForwardFrame
 */
export type TcpForwardFrame = Message<"openshell.v1.TcpForwardFrame"> & {
    /**
     * @generated from oneof openshell.v1.TcpForwardFrame.payload
     */
    payload: {
        /**
         * @generated from field: openshell.v1.TcpForwardInit init = 1;
         */
        value: TcpForwardInit;
        case: "init";
    } | {
        /**
         * @generated from field: bytes data = 2;
         */
        value: Uint8Array;
        case: "data";
    } | {
        case: undefined;
        value?: undefined;
    };
};
/**
 * Describes the message openshell.v1.TcpForwardFrame.
 * Use `create(TcpForwardFrameSchema)` to create a new message.
 */
export declare const TcpForwardFrameSchema: GenMessage<TcpForwardFrame>;
/**
 * Client-to-server message for interactive exec.
 *
 * @generated from message openshell.v1.ExecSandboxInput
 */
export type ExecSandboxInput = Message<"openshell.v1.ExecSandboxInput"> & {
    /**
     * @generated from oneof openshell.v1.ExecSandboxInput.payload
     */
    payload: {
        /**
         * First message: exec request metadata.
         *
         * @generated from field: openshell.v1.ExecSandboxRequest start = 1;
         */
        value: ExecSandboxRequest;
        case: "start";
    } | {
        /**
         * Subsequent messages: raw stdin bytes.
         *
         * @generated from field: bytes stdin = 2;
         */
        value: Uint8Array;
        case: "stdin";
    } | {
        /**
         * Terminal window size change.
         *
         * @generated from field: openshell.v1.ExecSandboxWindowResize resize = 3;
         */
        value: ExecSandboxWindowResize;
        case: "resize";
    } | {
        case: undefined;
        value?: undefined;
    };
};
/**
 * Describes the message openshell.v1.ExecSandboxInput.
 * Use `create(ExecSandboxInputSchema)` to create a new message.
 */
export declare const ExecSandboxInputSchema: GenMessage<ExecSandboxInput>;
/**
 * Terminal window resize event for interactive exec.
 *
 * @generated from message openshell.v1.ExecSandboxWindowResize
 */
export type ExecSandboxWindowResize = Message<"openshell.v1.ExecSandboxWindowResize"> & {
    /**
     * @generated from field: uint32 cols = 1;
     */
    cols: number;
    /**
     * @generated from field: uint32 rows = 2;
     */
    rows: number;
};
/**
 * Describes the message openshell.v1.ExecSandboxWindowResize.
 * Use `create(ExecSandboxWindowResizeSchema)` to create a new message.
 */
export declare const ExecSandboxWindowResizeSchema: GenMessage<ExecSandboxWindowResize>;
/**
 * SSH session record stored in persistence.
 *
 * @generated from message openshell.v1.SshSession
 */
export type SshSession = Message<"openshell.v1.SshSession"> & {
    /**
     * Kubernetes-style metadata (id, name, labels, timestamps, resource version).
     *
     * @generated from field: openshell.datamodel.v1.ObjectMeta metadata = 1;
     */
    metadata?: ObjectMeta | undefined;
    /**
     * Sandbox id.
     *
     * @generated from field: string sandbox_id = 2;
     */
    sandboxId: string;
    /**
     * Session token.
     *
     * @generated from field: string token = 3;
     */
    token: string;
    /**
     * Absolute expiry. Absence means no expiry.
     *
     * @generated from field: google.protobuf.Timestamp expiration_time = 104;
     */
    expirationTime?: Timestamp | undefined;
    /**
     * Revoked flag.
     *
     * @generated from field: bool revoked = 5;
     */
    revoked: boolean;
};
/**
 * Describes the message openshell.v1.SshSession.
 * Use `create(SshSessionSchema)` to create a new message.
 */
export declare const SshSessionSchema: GenMessage<SshSession>;
/**
 * Watch sandbox request.
 *
 * @generated from message openshell.v1.WatchSandboxRequest
 */
export type WatchSandboxRequest = Message<"openshell.v1.WatchSandboxRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 11;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Canonical sandbox name.
     *
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * Stream sandbox status snapshots.
     *
     * @generated from field: bool follow_status = 2;
     */
    followStatus: boolean;
    /**
     * Stream openshell-server process logs correlated to this sandbox.
     *
     * @generated from field: bool follow_logs = 3;
     */
    followLogs: boolean;
    /**
     * Stream platform events correlated to this sandbox.
     *
     * @generated from field: bool follow_events = 4;
     */
    followEvents: boolean;
    /**
     * Replay the last N log lines (best-effort) before following.
     *
     * @generated from field: uint32 log_tail_lines = 5;
     */
    logTailLines: number;
    /**
     * Replay the last N platform events (best-effort) before following.
     *
     * @generated from field: uint32 event_tail = 6;
     */
    eventTail: number;
    /**
     * Stop streaming once the sandbox reaches READY or a terminal result phase
     * (COMPLETED, STOPPED, or ERROR).
     *
     * @generated from field: bool stop_on_terminal = 7;
     */
    stopOnTerminal: boolean;
    /**
     * Only include log lines at or after this time. Absence means no time filter.
     * Applies to both tail replay and live streaming.
     *
     * @generated from field: google.protobuf.Timestamp since_time = 108;
     */
    sinceTime?: Timestamp | undefined;
    /**
     * Filter by log source (e.g. "gateway", "sandbox"). Empty means all sources.
     *
     * @generated from field: repeated string log_sources = 9;
     */
    logSources: string[];
    /**
     * Minimum log level to include (e.g. "INFO", "WARN", "ERROR"). Empty means all levels.
     *
     * @generated from field: string log_min_level = 10;
     */
    logMinLevel: string;
    /**
     * Resume streaming after this cursor. Empty means no cursor resume: the
     * server falls back to tail-limited replay controlled by log_tail_lines and
     * event_tail. Otherwise set it to the highest `SandboxStreamEvent.cursor`
     * already processed; the server replays only log and platform events after
     * it, merged in cursor order, before resuming live delivery. If the requested
     * cursor has already been trimmed from the server's buffer, the resume is
     * unrecoverable and the stream terminates with OUT_OF_RANGE (see
     * SandboxStreamWarning for the recoverable case).
     *
     * A cursor is bound to the cursor space that issued it. A gateway restart,
     * teardown of the sandbox's buffers, or a reconnect to a different gateway
     * replica starts a new space, and cursors from the previous one are rejected
     * with OUT_OF_RANGE rather than silently suppressing live events beneath
     * them. OUT_OF_RANGE is terminal for that cursor: restart the watch with an
     * empty resume_after_cursor, because retrying the same token fails
     * identically. A cursor this server could not have issued is rejected with
     * INVALID_ARGUMENT.
     *
     * @generated from field: string resume_after_cursor = 12;
     */
    resumeAfterCursor: string;
};
/**
 * Describes the message openshell.v1.WatchSandboxRequest.
 * Use `create(WatchSandboxRequestSchema)` to create a new message.
 */
export declare const WatchSandboxRequestSchema: GenMessage<WatchSandboxRequest>;
/**
 * One event in a sandbox watch stream.
 *
 * @generated from message openshell.v1.SandboxStreamEvent
 */
export type SandboxStreamEvent = Message<"openshell.v1.SandboxStreamEvent"> & {
    /**
     * @generated from oneof openshell.v1.SandboxStreamEvent.payload
     */
    payload: {
        /**
         * Latest sandbox snapshot.
         *
         * @generated from field: openshell.v1.Sandbox sandbox = 1;
         */
        value: Sandbox;
        case: "sandbox";
    } | {
        /**
         * One server log line/event.
         *
         * @generated from field: openshell.v1.SandboxLogLine log = 2;
         */
        value: SandboxLogLine;
        case: "log";
    } | {
        /**
         * One platform event.
         *
         * @generated from field: openshell.v1.PlatformEvent event = 3;
         */
        value: PlatformEvent;
        case: "event";
    } | {
        /**
         * Recoverable warning from the server, e.g. messages dropped because a
         * broadcast receiver lagged. The stream continues after this warning; the
         * client can detect the gap from the warning itself.
         *
         * @generated from field: openshell.v1.SandboxStreamWarning warning = 4;
         */
        value: SandboxStreamWarning;
        case: "warning";
    } | {
        /**
         * Draft policy update notification.
         *
         * @generated from field: openshell.v1.DraftPolicyUpdate draft_policy_update = 5;
         */
        value: DraftPolicyUpdate;
        case: "draftPolicyUpdate";
    } | {
        case: undefined;
        value?: undefined;
    };
    /**
     * Opaque position in this sandbox's cursor space, shared across the resumable
     * log and platform event sources. Empty for non-resumable events (status
     * snapshots, warnings).
     *
     * Do not parse this token; its encoding is not part of the contract. The only
     * supported operation is comparing two non-empty cursors observed on the same
     * stream and keeping the greater one, then passing it as
     * WatchSandboxRequest.resume_after_cursor to resume without loss or
     * duplication. That comparison is a plain byte-wise string comparison. It is
     * well defined only within one stream: a stream never spans two cursor
     * spaces, because a reset ends it.
     *
     * @generated from field: string cursor = 6;
     */
    cursor: string;
};
/**
 * Describes the message openshell.v1.SandboxStreamEvent.
 * Use `create(SandboxStreamEventSchema)` to create a new message.
 */
export declare const SandboxStreamEventSchema: GenMessage<SandboxStreamEvent>;
/**
 * Log line correlated to a sandbox.
 *
 * @generated from message openshell.v1.SandboxLogLine
 */
export type SandboxLogLine = Message<"openshell.v1.SandboxLogLine"> & {
    /**
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * @generated from field: google.protobuf.Timestamp event_time = 102;
     */
    eventTime?: Timestamp | undefined;
    /**
     * @generated from field: string level = 3;
     */
    level: string;
    /**
     * @generated from field: string target = 4;
     */
    target: string;
    /**
     * @generated from field: string message = 5;
     */
    message: string;
    /**
     * Log source: "gateway" (server-side) or "sandbox" (supervisor).
     * Empty is treated as "gateway" for backward compatibility.
     *
     * @generated from field: string source = 6;
     */
    source: string;
    /**
     * Structured key-value fields from the tracing event (e.g. dst_host, action).
     *
     * @generated from field: map<string, string> fields = 7;
     */
    fields: {
        [key: string]: string;
    };
};
/**
 * Describes the message openshell.v1.SandboxLogLine.
 * Use `create(SandboxLogLineSchema)` to create a new message.
 */
export declare const SandboxLogLineSchema: GenMessage<SandboxLogLine>;
/**
 * Recoverable loss notification on a watch stream. Emitted when the server
 * skips ahead after a broadcast lag instead of terminating; the stream keeps
 * running. Cursors are opaque, so this message is the only signal that events
 * were skipped. Unrecoverable loss (a trimmed or foreign resume cursor) is
 * reported as an OUT_OF_RANGE stream status, not this message.
 *
 * @generated from message openshell.v1.SandboxStreamWarning
 */
export type SandboxStreamWarning = Message<"openshell.v1.SandboxStreamWarning"> & {
    /**
     * @generated from field: string message = 1;
     */
    message: string;
};
/**
 * Describes the message openshell.v1.SandboxStreamWarning.
 * Use `create(SandboxStreamWarningSchema)` to create a new message.
 */
export declare const SandboxStreamWarningSchema: GenMessage<SandboxStreamWarning>;
/**
 * Create provider request.
 *
 * @generated from message openshell.v1.CreateProviderRequest
 */
export type CreateProviderRequest = Message<"openshell.v1.CreateProviderRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: openshell.datamodel.v1.Provider provider = 1;
     */
    provider?: Provider | undefined;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 3;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.CreateProviderRequest.
 * Use `create(CreateProviderRequestSchema)` to create a new message.
 */
export declare const CreateProviderRequestSchema: GenMessage<CreateProviderRequest>;
/**
 * Get provider request.
 *
 * @generated from message openshell.v1.GetProviderRequest
 */
export type GetProviderRequest = Message<"openshell.v1.GetProviderRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string name = 1;
     */
    name: string;
};
/**
 * Describes the message openshell.v1.GetProviderRequest.
 * Use `create(GetProviderRequestSchema)` to create a new message.
 */
export declare const GetProviderRequestSchema: GenMessage<GetProviderRequest>;
/**
 * Retrieve selected runtime credentials from one provider in one workspace.
 * Refresh side effects can persist even when the complete request fails.
 *
 * @generated from message openshell.v1.GetProviderCredentialsRequest
 */
export type GetProviderCredentialsRequest = Message<"openshell.v1.GetProviderCredentialsRequest"> & {
    /**
     * Required named workspace selection; all_workspaces is not accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 1;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Provider canonical name.
     *
     * @generated from field: string name = 2;
     */
    name: string;
    /**
     * Nonempty selection of runtime environment keys (maximum 32).
     *
     * @generated from field: repeated string credential_keys = 3;
     */
    credentialKeys: string[];
    /**
     * Omitted/zero uses a five-minute safety margin. Maximum is 24 hours.
     *
     * @generated from field: google.protobuf.Duration minimum_remaining_lifetime = 4;
     */
    minimumRemainingLifetime?: Duration | undefined;
};
/**
 * Describes the message openshell.v1.GetProviderCredentialsRequest.
 * Use `create(GetProviderCredentialsRequestSchema)` to create a new message.
 */
export declare const GetProviderCredentialsRequestSchema: GenMessage<GetProviderCredentialsRequest>;
/**
 * Usable runtime value, never gateway-only minting material.
 *
 * @generated from message openshell.v1.ProviderCredentialValue
 */
export type ProviderCredentialValue = Message<"openshell.v1.ProviderCredentialValue"> & {
    /**
     * @generated from field: string value = 1;
     */
    value: string;
    /**
     * Absent for credentials with no declared expiration.
     *
     * @generated from field: google.protobuf.Timestamp expiration_time = 2;
     */
    expirationTime?: Timestamp | undefined;
};
/**
 * Describes the message openshell.v1.ProviderCredentialValue.
 * Use `create(ProviderCredentialValueSchema)` to create a new message.
 */
export declare const ProviderCredentialValueSchema: GenMessage<ProviderCredentialValue>;
/**
 * @generated from message openshell.v1.GetProviderCredentialsResponse
 */
export type GetProviderCredentialsResponse = Message<"openshell.v1.GetProviderCredentialsResponse"> & {
    /**
     * All requested values or an error; no partial response.
     *
     * @generated from field: map<string, openshell.v1.ProviderCredentialValue> credentials = 1;
     */
    credentials: {
        [key: string]: ProviderCredentialValue;
    };
};
/**
 * Describes the message openshell.v1.GetProviderCredentialsResponse.
 * Use `create(GetProviderCredentialsResponseSchema)` to create a new message.
 */
export declare const GetProviderCredentialsResponseSchema: GenMessage<GetProviderCredentialsResponse>;
/**
 * List providers request.
 *
 * @generated from message openshell.v1.ListProvidersRequest
 */
export type ListProvidersRequest = Message<"openshell.v1.ListProvidersRequest"> & {
    /**
     * Workspace scope. Named and all-workspaces selections are accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * The maximum number of providers to return. Zero uses 100. Values above
     * 1000 are coerced to 1000; negative values are invalid.
     *
     * @generated from field: int32 page_size = 1;
     */
    pageSize: number;
    /**
     * Token from a previous ListProviders response. All other request parameters
     * except page_size must match the request that produced it.
     *
     * @generated from field: string page_token = 2;
     */
    pageToken: string;
    /**
     * Optional label selector for filtering (format: "key1=value1,key2=value2").
     *
     * @generated from field: string label_selector = 4;
     */
    labelSelector: string;
};
/**
 * Describes the message openshell.v1.ListProvidersRequest.
 * Use `create(ListProvidersRequestSchema)` to create a new message.
 */
export declare const ListProvidersRequestSchema: GenMessage<ListProvidersRequest>;
/**
 * Update provider request.
 *
 * @generated from message openshell.v1.UpdateProviderRequest
 */
export type UpdateProviderRequest = Message<"openshell.v1.UpdateProviderRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: openshell.datamodel.v1.Provider provider = 1;
     */
    provider?: Provider | undefined;
    /**
     * Optional per-credential expiry timestamps to merge into the provider.
     * Omitted keys are unchanged. Use clear_credential_expiration_keys to remove
     * an existing expiry.
     *
     * @generated from field: map<string, google.protobuf.Timestamp> credential_expiration_times = 102;
     */
    credentialExpirationTimes: {
        [key: string]: Timestamp;
    };
    /**
     * Credential keys whose existing expiry should be removed.
     *
     * @generated from field: repeated string clear_credential_expiration_keys = 103;
     */
    clearCredentialExpirationKeys: string[];
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 4;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.UpdateProviderRequest.
 * Use `create(UpdateProviderRequestSchema)` to create a new message.
 */
export declare const UpdateProviderRequestSchema: GenMessage<UpdateProviderRequest>;
/**
 * Delete provider request.
 *
 * @generated from message openshell.v1.DeleteProviderRequest
 */
export type DeleteProviderRequest = Message<"openshell.v1.DeleteProviderRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * @generated from field: bool allow_missing = 4;
     */
    allowMissing: boolean;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 5;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.DeleteProviderRequest.
 * Use `create(DeleteProviderRequestSchema)` to create a new message.
 */
export declare const DeleteProviderRequestSchema: GenMessage<DeleteProviderRequest>;
/**
 * Provider response.
 *
 * @generated from message openshell.v1.ProviderResponse
 */
export type ProviderResponse = Message<"openshell.v1.ProviderResponse"> & {
    /**
     * @generated from field: openshell.datamodel.v1.Provider provider = 1;
     */
    provider?: Provider | undefined;
    /**
     * Selection-time sandbox target set for an update, with one receipt per target.
     * Sandboxes attached later are outside this operation's readiness result.
     *
     * @generated from field: repeated openshell.v1.ProviderMutationReceipt target_receipts = 2;
     */
    targetReceipts: ProviderMutationReceipt[];
    /**
     * Identifies the update even when its target set is empty.
     *
     * @generated from field: string mutation_id = 3;
     */
    mutationId: string;
};
/**
 * Describes the message openshell.v1.ProviderResponse.
 * Use `create(ProviderResponseSchema)` to create a new message.
 */
export declare const ProviderResponseSchema: GenMessage<ProviderResponse>;
/**
 * List providers response.
 *
 * @generated from message openshell.v1.ListProvidersResponse
 */
export type ListProvidersResponse = Message<"openshell.v1.ListProvidersResponse"> & {
    /**
     * @generated from field: repeated openshell.datamodel.v1.Provider providers = 1;
     */
    providers: Provider[];
    /**
     * Token for the next page. Empty when there are no subsequent pages.
     *
     * @generated from field: string next_page_token = 2;
     */
    nextPageToken: string;
};
/**
 * Describes the message openshell.v1.ListProvidersResponse.
 * Use `create(ListProvidersResponseSchema)` to create a new message.
 */
export declare const ListProvidersResponseSchema: GenMessage<ListProvidersResponse>;
/**
 * List provider type profiles request.
 *
 * @generated from message openshell.v1.ListProviderProfilesRequest
 */
export type ListProviderProfilesRequest = Message<"openshell.v1.ListProviderProfilesRequest"> & {
    /**
     * Workspace scope. Omit for platform profiles; otherwise select one named workspace.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * The maximum number of profiles to return. Zero uses 100. Values above
     * 1000 are coerced to 1000; negative values are invalid.
     *
     * @generated from field: int32 page_size = 1;
     */
    pageSize: number;
    /**
     * Token from a previous ListProviderProfiles response. All other request
     * parameters except page_size must match the request that produced it.
     *
     * @generated from field: string page_token = 2;
     */
    pageToken: string;
};
/**
 * Describes the message openshell.v1.ListProviderProfilesRequest.
 * Use `create(ListProviderProfilesRequestSchema)` to create a new message.
 */
export declare const ListProviderProfilesRequestSchema: GenMessage<ListProviderProfilesRequest>;
/**
 * Fetch provider type profile request.
 *
 * @generated from message openshell.v1.GetProviderProfileRequest
 */
export type GetProviderProfileRequest = Message<"openshell.v1.GetProviderProfileRequest"> & {
    /**
     * Workspace scope. Omit for platform profiles; otherwise select one named workspace.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string id = 1;
     */
    id: string;
};
/**
 * Describes the message openshell.v1.GetProviderProfileRequest.
 * Use `create(GetProviderProfileRequestSchema)` to create a new message.
 */
export declare const GetProviderProfileRequestSchema: GenMessage<GetProviderProfileRequest>;
/**
 * Provider profile payload with optional source metadata for diagnostics.
 *
 * @generated from message openshell.v1.ProviderProfileImportItem
 */
export type ProviderProfileImportItem = Message<"openshell.v1.ProviderProfileImportItem"> & {
    /**
     * @generated from field: openshell.v1.ProviderProfile profile = 1;
     */
    profile?: ProviderProfile | undefined;
    /**
     * @generated from field: string source = 2;
     */
    source: string;
};
/**
 * Describes the message openshell.v1.ProviderProfileImportItem.
 * Use `create(ProviderProfileImportItemSchema)` to create a new message.
 */
export declare const ProviderProfileImportItemSchema: GenMessage<ProviderProfileImportItem>;
/**
 * Provider profile validation diagnostic.
 *
 * @generated from message openshell.v1.ProviderProfileDiagnostic
 */
export type ProviderProfileDiagnostic = Message<"openshell.v1.ProviderProfileDiagnostic"> & {
    /**
     * @generated from field: string source = 1;
     */
    source: string;
    /**
     * @generated from field: string profile_id = 2;
     */
    profileId: string;
    /**
     * @generated from field: string field = 3;
     */
    field: string;
    /**
     * @generated from field: string message = 4;
     */
    message: string;
    /**
     * @generated from field: string severity = 5;
     */
    severity: string;
};
/**
 * Describes the message openshell.v1.ProviderProfileDiagnostic.
 * Use `create(ProviderProfileDiagnosticSchema)` to create a new message.
 */
export declare const ProviderProfileDiagnosticSchema: GenMessage<ProviderProfileDiagnostic>;
/**
 * Endpoint selector for token grant audience overrides.
 *
 * @generated from message openshell.v1.ProviderCredentialTokenGrantAudienceOverride
 */
export type ProviderCredentialTokenGrantAudienceOverride = Message<"openshell.v1.ProviderCredentialTokenGrantAudienceOverride"> & {
    /**
     * Optional: endpoint host selector. If omitted, inherits the profile endpoint host.
     *
     * @generated from field: string host = 1;
     */
    host: string;
    /**
     * Optional: endpoint port selector. If omitted, matches the expanded profile endpoint port.
     *
     * @generated from field: uint32 port = 2;
     */
    port: number;
    /**
     * Optional: endpoint path selector. If omitted, inherits the profile endpoint path.
     *
     * @generated from field: string path = 3;
     */
    path: string;
    /**
     * Resource audience to request for matching endpoints.
     *
     * @generated from field: string audience = 4;
     */
    audience: string;
    /**
     * Optional: OAuth2 scopes to request. If omitted, inherits the token grant scopes.
     *
     * @generated from field: repeated string scopes = 5;
     */
    scopes: string[];
};
/**
 * Describes the message openshell.v1.ProviderCredentialTokenGrantAudienceOverride.
 * Use `create(ProviderCredentialTokenGrantAudienceOverrideSchema)` to create a new message.
 */
export declare const ProviderCredentialTokenGrantAudienceOverrideSchema: GenMessage<ProviderCredentialTokenGrantAudienceOverride>;
/**
 * @generated from message openshell.v1.ProviderCredentialTokenGrantSubjectToken
 */
export type ProviderCredentialTokenGrantSubjectToken = Message<"openshell.v1.ProviderCredentialTokenGrantSubjectToken"> & {
    /**
     * Source for the token exchange subject token. Phase one supports
     * "provider_credential".
     *
     * @generated from field: string source = 1;
     */
    source: string;
    /**
     * Provider credential key that stores the subject token.
     *
     * @generated from field: string credential = 2;
     */
    credential: string;
    /**
     * OAuth2 subject_token_type. If omitted, OpenShell uses
     * urn:ietf:params:oauth:token-type:access_token.
     *
     * @generated from field: string subject_token_type = 3;
     */
    subjectTokenType: string;
};
/**
 * Describes the message openshell.v1.ProviderCredentialTokenGrantSubjectToken.
 * Use `create(ProviderCredentialTokenGrantSubjectTokenSchema)` to create a new message.
 */
export declare const ProviderCredentialTokenGrantSubjectTokenSchema: GenMessage<ProviderCredentialTokenGrantSubjectToken>;
/**
 * @generated from message openshell.v1.ProviderCredentialTokenGrant
 */
export type ProviderCredentialTokenGrant = Message<"openshell.v1.ProviderCredentialTokenGrant"> & {
    /**
     * OAuth2 token endpoint URL (e.g., https://keycloak.example.com/realms/my-realm/protocol/openid-connect/token)
     *
     * @generated from field: string token_endpoint = 1;
     */
    tokenEndpoint: string;
    /**
     * Optional: default resource audience to request from the token service
     *
     * @generated from field: string audience = 2;
     */
    audience: string;
    /**
     * Optional: audience to request when fetching the JWT-SVID from SPIRE.
     * If omitted, the sandbox derives this from token_endpoint.
     *
     * @generated from field: string jwt_svid_audience = 6;
     */
    jwtSvidAudience: string;
    /**
     * Optional: OAuth2 scopes to request
     *
     * @generated from field: repeated string scopes = 3;
     */
    scopes: string[];
    /**
     * Optional token cache TTL override. If absent, use expires_in from the token response.
     *
     * @generated from field: google.protobuf.Duration cache_ttl = 104;
     */
    cacheTtl?: Duration | undefined;
    /**
     * Optional: endpoint-specific resource audience overrides.
     *
     * @generated from field: repeated openshell.v1.ProviderCredentialTokenGrantAudienceOverride audience_overrides = 5;
     */
    audienceOverrides: ProviderCredentialTokenGrantAudienceOverride[];
    /**
     * Optional: OAuth2 client_assertion_type value. If omitted, OpenShell uses
     * urn:ietf:params:oauth:client-assertion-type:jwt-bearer.
     *
     * @generated from field: string client_assertion_type = 7;
     */
    clientAssertionType: string;
    /**
     * Grant type. If omitted/unspecified, OpenShell treats this as client_credentials
     * for backwards compatibility.
     *
     * @generated from field: openshell.v1.ProviderCredentialTokenGrantType grant_type = 8;
     */
    grantType: ProviderCredentialTokenGrantType;
    /**
     * Subject token metadata for token_exchange grants.
     *
     * @generated from field: openshell.v1.ProviderCredentialTokenGrantSubjectToken subject_token = 9;
     */
    subjectToken?: ProviderCredentialTokenGrantSubjectToken | undefined;
    /**
     * OAuth2 requested_token_type. If omitted for token_exchange, OpenShell uses
     * urn:ietf:params:oauth:token-type:access_token.
     *
     * @generated from field: string requested_token_type = 10;
     */
    requestedTokenType: string;
};
/**
 * Describes the message openshell.v1.ProviderCredentialTokenGrant.
 * Use `create(ProviderCredentialTokenGrantSchema)` to create a new message.
 */
export declare const ProviderCredentialTokenGrantSchema: GenMessage<ProviderCredentialTokenGrant>;
/**
 * Provider credential declaration.
 *
 * @generated from message openshell.v1.ProviderProfileCredential
 */
export type ProviderProfileCredential = Message<"openshell.v1.ProviderProfileCredential"> & {
    /**
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * @generated from field: string description = 2;
     */
    description: string;
    /**
     * @generated from field: repeated string env_vars = 3;
     */
    envVars: string[];
    /**
     * @generated from field: bool required = 4;
     */
    required: boolean;
    /**
     * @generated from field: string auth_style = 5;
     */
    authStyle: string;
    /**
     * @generated from field: string header_name = 6;
     */
    headerName: string;
    /**
     * @generated from field: string query_param = 7;
     */
    queryParam: string;
    /**
     * @generated from field: openshell.v1.ProviderCredentialRefresh refresh = 8;
     */
    refresh?: ProviderCredentialRefresh | undefined;
    /**
     * @generated from field: string path_template = 9;
     */
    pathTemplate: string;
    /**
     * @generated from field: openshell.v1.ProviderCredentialTokenGrant token_grant = 10;
     */
    tokenGrant?: ProviderCredentialTokenGrant | undefined;
    /**
     * Output-only gateway-derived endpoint authorities for resolved token grants.
     * For inspected L7 requests, empty means no endpoint may obtain this grant.
     * L4 injection uses selectors without checking these authorities.
     * Profile-authored values are ignored; normal policies name the originating
     * provider endpoint, while a global policy uses its own endpoint authorities.
     *
     * @generated from field: repeated string token_grant_owners = 11;
     */
    tokenGrantOwners: string[];
    /**
     * Opt in to an opaque identity-bound environment placeholder for every env
     * var declared by this credential. Use this only when an external credential
     * updater requires one placeholder across value-only provider revisions.
     * Gateway-managed refresh and token-grant credentials cannot opt in because
     * they require identity-bearing handles for authorization-epoch revocation.
     *
     * @generated from field: bool stable_placeholder = 12;
     */
    stablePlaceholder: boolean;
};
/**
 * Describes the message openshell.v1.ProviderProfileCredential.
 * Use `create(ProviderProfileCredentialSchema)` to create a new message.
 */
export declare const ProviderProfileCredentialSchema: GenMessage<ProviderProfileCredential>;
/**
 * @generated from message openshell.v1.ProviderCredentialRefreshMaterial
 */
export type ProviderCredentialRefreshMaterial = Message<"openshell.v1.ProviderCredentialRefreshMaterial"> & {
    /**
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * @generated from field: string description = 2;
     */
    description: string;
    /**
     * @generated from field: bool required = 3;
     */
    required: boolean;
    /**
     * @generated from field: bool secret = 4;
     */
    secret: boolean;
};
/**
 * Describes the message openshell.v1.ProviderCredentialRefreshMaterial.
 * Use `create(ProviderCredentialRefreshMaterialSchema)` to create a new message.
 */
export declare const ProviderCredentialRefreshMaterialSchema: GenMessage<ProviderCredentialRefreshMaterial>;
/**
 * Declares that a single refresh operation mints more than one credential.
 * The refresh is attached to a primary credential; each additional output
 * maps a strategy-defined semantic output id to a sibling credential whose
 * env_vars receive the minted value.
 *
 * @generated from message openshell.v1.ProviderCredentialRefreshOutput
 */
export type ProviderCredentialRefreshOutput = Message<"openshell.v1.ProviderCredentialRefreshOutput"> & {
    /**
     * strategy-defined semantic output id (e.g. "session_token")
     *
     * @generated from field: string output = 1;
     */
    output: string;
    /**
     * sibling credential name whose env_vars receive this output
     *
     * @generated from field: string credential = 2;
     */
    credential: string;
};
/**
 * Describes the message openshell.v1.ProviderCredentialRefreshOutput.
 * Use `create(ProviderCredentialRefreshOutputSchema)` to create a new message.
 */
export declare const ProviderCredentialRefreshOutputSchema: GenMessage<ProviderCredentialRefreshOutput>;
/**
 * @generated from message openshell.v1.ProviderCredentialRefresh
 */
export type ProviderCredentialRefresh = Message<"openshell.v1.ProviderCredentialRefresh"> & {
    /**
     * @generated from field: openshell.v1.ProviderCredentialRefreshStrategy strategy = 1;
     */
    strategy: ProviderCredentialRefreshStrategy;
    /**
     * @generated from field: string token_url = 2;
     */
    tokenUrl: string;
    /**
     * @generated from field: repeated string scopes = 3;
     */
    scopes: string[];
    /**
     * @generated from field: google.protobuf.Duration refresh_before = 104;
     */
    refreshBefore?: Duration | undefined;
    /**
     * @generated from field: google.protobuf.Duration max_lifetime = 105;
     */
    maxLifetime?: Duration | undefined;
    /**
     * @generated from field: repeated openshell.v1.ProviderCredentialRefreshMaterial material = 6;
     */
    material: ProviderCredentialRefreshMaterial[];
    /**
     * @generated from field: repeated openshell.v1.ProviderCredentialRefreshOutput additional_outputs = 7;
     */
    additionalOutputs: ProviderCredentialRefreshOutput[];
};
/**
 * Describes the message openshell.v1.ProviderCredentialRefresh.
 * Use `create(ProviderCredentialRefreshSchema)` to create a new message.
 */
export declare const ProviderCredentialRefreshSchema: GenMessage<ProviderCredentialRefresh>;
/**
 * @generated from message openshell.v1.ProviderCredentialRefreshStatus
 */
export type ProviderCredentialRefreshStatus = Message<"openshell.v1.ProviderCredentialRefreshStatus"> & {
    /**
     * @generated from field: string provider = 1;
     */
    provider: string;
    /**
     * @generated from field: string provider_id = 2;
     */
    providerId: string;
    /**
     * @generated from field: string credential_key = 3;
     */
    credentialKey: string;
    /**
     * @generated from field: openshell.v1.ProviderCredentialRefreshStrategy strategy = 4;
     */
    strategy: ProviderCredentialRefreshStrategy;
    /**
     * @generated from field: string status = 5;
     */
    status: string;
    /**
     * @generated from field: google.protobuf.Timestamp expiration_time = 106;
     */
    expirationTime?: Timestamp | undefined;
    /**
     * Next automatic refresh time. Absence means no automatic retry is scheduled;
     * use recovery_action to determine the required recovery workflow.
     *
     * @generated from field: google.protobuf.Timestamp next_refresh_time = 107;
     */
    nextRefreshTime?: Timestamp | undefined;
    /**
     * @generated from field: google.protobuf.Timestamp last_refresh_time = 108;
     */
    lastRefreshTime?: Timestamp | undefined;
    /**
     * @generated from field: string last_error = 9;
     */
    lastError: string;
    /**
     * @generated from field: openshell.v1.ProviderCredentialRefreshRecoveryAction recovery_action = 10;
     */
    recoveryAction: ProviderCredentialRefreshRecoveryAction;
    /**
     * Stable gateway-owned failure identifier, for example
     * "oauth_invalid_grant". This is not provider-controlled prose and
     * incorporates any recognized top-level OAuth error classification.
     *
     * @generated from field: string failure_code = 11;
     */
    failureCode: string;
    /**
     * A bounded, recognized provider subtype that refines failure_code; clients
     * do not need a separate provider_error field. Unknown provider-controlled
     * values are not persisted or returned.
     *
     * @generated from field: string provider_error_subtype = 12;
     */
    providerErrorSubtype: string;
    /**
     * @generated from field: google.protobuf.Timestamp last_error_time = 113;
     */
    lastErrorTime?: Timestamp | undefined;
};
/**
 * Describes the message openshell.v1.ProviderCredentialRefreshStatus.
 * Use `create(ProviderCredentialRefreshStatusSchema)` to create a new message.
 */
export declare const ProviderCredentialRefreshStatusSchema: GenMessage<ProviderCredentialRefreshStatus>;
/**
 * Provider profile local discovery declaration.
 *
 * @generated from message openshell.v1.ProviderProfileDiscovery
 */
export type ProviderProfileDiscovery = Message<"openshell.v1.ProviderProfileDiscovery"> & {
    /**
     * Credential names from ProviderProfile.credentials eligible for local discovery.
     *
     * @generated from field: repeated string credentials = 1;
     */
    credentials: string[];
};
/**
 * Describes the message openshell.v1.ProviderProfileDiscovery.
 * Use `create(ProviderProfileDiscoverySchema)` to create a new message.
 */
export declare const ProviderProfileDiscoverySchema: GenMessage<ProviderProfileDiscovery>;
/**
 * @generated from message openshell.v1.GetProviderRefreshStatusRequest
 */
export type GetProviderRefreshStatusRequest = Message<"openshell.v1.GetProviderRefreshStatusRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string provider = 1;
     */
    provider: string;
    /**
     * @generated from field: string credential_key = 2;
     */
    credentialKey: string;
};
/**
 * Describes the message openshell.v1.GetProviderRefreshStatusRequest.
 * Use `create(GetProviderRefreshStatusRequestSchema)` to create a new message.
 */
export declare const GetProviderRefreshStatusRequestSchema: GenMessage<GetProviderRefreshStatusRequest>;
/**
 * @generated from message openshell.v1.GetProviderRefreshStatusResponse
 */
export type GetProviderRefreshStatusResponse = Message<"openshell.v1.GetProviderRefreshStatusResponse"> & {
    /**
     * @generated from field: repeated openshell.v1.ProviderCredentialRefreshStatus credentials = 1;
     */
    credentials: ProviderCredentialRefreshStatus[];
};
/**
 * Describes the message openshell.v1.GetProviderRefreshStatusResponse.
 * Use `create(GetProviderRefreshStatusResponseSchema)` to create a new message.
 */
export declare const GetProviderRefreshStatusResponseSchema: GenMessage<GetProviderRefreshStatusResponse>;
/**
 * @generated from message openshell.v1.ConfigureProviderRefreshRequest
 */
export type ConfigureProviderRefreshRequest = Message<"openshell.v1.ConfigureProviderRefreshRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 7;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string provider = 1;
     */
    provider: string;
    /**
     * @generated from field: string credential_key = 2;
     */
    credentialKey: string;
    /**
     * @generated from field: openshell.v1.ProviderCredentialRefreshStrategy strategy = 3;
     */
    strategy: ProviderCredentialRefreshStrategy;
    /**
     * @generated from field: map<string, string> material = 4;
     */
    material: {
        [key: string]: string;
    };
    /**
     * Additional material names the caller requests be stored as secrets. Every
     * name must be present in material. The server also classifies secrets from
     * the authoritative provider profile and refresh strategy.
     *
     * @generated from field: repeated string secret_material_keys = 5;
     */
    secretMaterialKeys: string[];
    /**
     * @generated from field: google.protobuf.Timestamp expiration_time = 106;
     */
    expirationTime?: Timestamp | undefined;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 8;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.ConfigureProviderRefreshRequest.
 * Use `create(ConfigureProviderRefreshRequestSchema)` to create a new message.
 */
export declare const ConfigureProviderRefreshRequestSchema: GenMessage<ConfigureProviderRefreshRequest>;
/**
 * @generated from message openshell.v1.ConfigureProviderRefreshResponse
 */
export type ConfigureProviderRefreshResponse = Message<"openshell.v1.ConfigureProviderRefreshResponse"> & {
    /**
     * @generated from field: openshell.v1.ProviderCredentialRefreshStatus status = 1;
     */
    status?: ProviderCredentialRefreshStatus | undefined;
};
/**
 * Describes the message openshell.v1.ConfigureProviderRefreshResponse.
 * Use `create(ConfigureProviderRefreshResponseSchema)` to create a new message.
 */
export declare const ConfigureProviderRefreshResponseSchema: GenMessage<ConfigureProviderRefreshResponse>;
/**
 * @generated from message openshell.v1.RotateProviderCredentialRequest
 */
export type RotateProviderCredentialRequest = Message<"openshell.v1.RotateProviderCredentialRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string provider = 1;
     */
    provider: string;
    /**
     * @generated from field: string credential_key = 2;
     */
    credentialKey: string;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 4;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.RotateProviderCredentialRequest.
 * Use `create(RotateProviderCredentialRequestSchema)` to create a new message.
 */
export declare const RotateProviderCredentialRequestSchema: GenMessage<RotateProviderCredentialRequest>;
/**
 * @generated from message openshell.v1.RotateProviderCredentialResponse
 */
export type RotateProviderCredentialResponse = Message<"openshell.v1.RotateProviderCredentialResponse"> & {
    /**
     * @generated from field: openshell.v1.ProviderCredentialRefreshStatus status = 1;
     */
    status?: ProviderCredentialRefreshStatus | undefined;
};
/**
 * Describes the message openshell.v1.RotateProviderCredentialResponse.
 * Use `create(RotateProviderCredentialResponseSchema)` to create a new message.
 */
export declare const RotateProviderCredentialResponseSchema: GenMessage<RotateProviderCredentialResponse>;
/**
 * @generated from message openshell.v1.DeleteProviderRefreshRequest
 */
export type DeleteProviderRefreshRequest = Message<"openshell.v1.DeleteProviderRefreshRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 4;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string provider = 1;
     */
    provider: string;
    /**
     * @generated from field: string credential_key = 2;
     */
    credentialKey: string;
    /**
     * @generated from field: bool allow_missing = 5;
     */
    allowMissing: boolean;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 6;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.DeleteProviderRefreshRequest.
 * Use `create(DeleteProviderRefreshRequestSchema)` to create a new message.
 */
export declare const DeleteProviderRefreshRequestSchema: GenMessage<DeleteProviderRefreshRequest>;
/**
 * @generated from message openshell.v1.DeleteProviderRefreshResponse
 */
export type DeleteProviderRefreshResponse = Message<"openshell.v1.DeleteProviderRefreshResponse"> & {
    /**
     * @generated from field: openshell.v1.DeletionOutcome outcome = 2;
     */
    outcome: DeletionOutcome;
};
/**
 * Describes the message openshell.v1.DeleteProviderRefreshResponse.
 * Use `create(DeleteProviderRefreshResponseSchema)` to create a new message.
 */
export declare const DeleteProviderRefreshResponseSchema: GenMessage<DeleteProviderRefreshResponse>;
/**
 * Provider type profile metadata exposed to clients.
 *
 * @generated from message openshell.v1.ProviderProfile
 */
export type ProviderProfile = Message<"openshell.v1.ProviderProfile"> & {
    /**
     * @generated from field: string id = 1;
     */
    id: string;
    /**
     * @generated from field: string display_name = 2;
     */
    displayName: string;
    /**
     * @generated from field: string description = 3;
     */
    description: string;
    /**
     * @generated from field: openshell.v1.ProviderProfileCategory category = 4;
     */
    category: ProviderProfileCategory;
    /**
     * @generated from field: repeated openshell.v1.ProviderProfileCredential credentials = 5;
     */
    credentials: ProviderProfileCredential[];
    /**
     * @generated from field: repeated openshell.sandbox.v1.NetworkEndpoint endpoints = 6;
     */
    endpoints: NetworkEndpoint[];
    /**
     * @generated from field: repeated openshell.sandbox.v1.NetworkBinary binaries = 7;
     */
    binaries: NetworkBinary[];
    /**
     * @generated from field: bool inference_capable = 8;
     */
    inferenceCapable: boolean;
    /**
     * @generated from field: openshell.v1.ProviderProfileDiscovery discovery = 9;
     */
    discovery?: ProviderProfileDiscovery | undefined;
    /**
     * Storage resource version for custom profiles. Built-in profiles and new
     * profile files use 0. Gateway responses set this for stored custom profiles.
     * Update calls use this for optimistic concurrency.
     *
     * @generated from field: uint64 resource_version = 10;
     */
    resourceVersion: bigint;
    /**
     * Optional non-secret annotations attached by profile sources or importers.
     *
     * @generated from field: map<string, string> annotations = 11;
     */
    annotations: {
        [key: string]: string;
    };
    /**
     * Server-set provenance: "builtin", "user", or "interceptor/{name}".
     * Ignored on import/update payloads.
     *
     * @generated from field: string source = 12;
     */
    source: string;
    /**
     * Server-set visibility: "platform", "workspace", or empty for
     * non-scoped sources. Ignored on import/update payloads.
     *
     * @generated from field: string scope = 13;
     */
    scope: string;
    /**
     * EXPERIMENTAL: Non-secret files rendered from provider configuration for the
     * workload. This API and its behavior may change or be removed.
     *
     * @generated from field: repeated openshell.v1.ProviderProfileFile files = 14;
     */
    files: ProviderProfileFile[];
};
/**
 * Describes the message openshell.v1.ProviderProfile.
 * Use `create(ProviderProfileSchema)` to create a new message.
 */
export declare const ProviderProfileSchema: GenMessage<ProviderProfile>;
/**
 * EXPERIMENTAL: Provider file templates may change or be removed.
 *
 * @generated from message openshell.v1.ProviderProfileFile
 */
export type ProviderProfileFile = Message<"openshell.v1.ProviderProfileFile"> & {
    /**
     * One virtual file name below /run/openshell/providers/<provider>/.
     *
     * @generated from field: string path = 1;
     */
    path: string;
    /**
     * UTF-8 template. Only {{config.KEY}} references are supported.
     *
     * @generated from field: string content = 2;
     */
    content: string;
    /**
     * Optional environment variable containing the virtual absolute path.
     *
     * @generated from field: string env_var = 3;
     */
    envVar: string;
};
/**
 * Describes the message openshell.v1.ProviderProfileFile.
 * Use `create(ProviderProfileFileSchema)` to create a new message.
 */
export declare const ProviderProfileFileSchema: GenMessage<ProviderProfileFile>;
/**
 * Provider profile response.
 *
 * @generated from message openshell.v1.ProviderProfileResponse
 */
export type ProviderProfileResponse = Message<"openshell.v1.ProviderProfileResponse"> & {
    /**
     * @generated from field: openshell.v1.ProviderProfile profile = 1;
     */
    profile?: ProviderProfile | undefined;
};
/**
 * Describes the message openshell.v1.ProviderProfileResponse.
 * Use `create(ProviderProfileResponseSchema)` to create a new message.
 */
export declare const ProviderProfileResponseSchema: GenMessage<ProviderProfileResponse>;
/**
 * List provider profiles response.
 *
 * @generated from message openshell.v1.ListProviderProfilesResponse
 */
export type ListProviderProfilesResponse = Message<"openshell.v1.ListProviderProfilesResponse"> & {
    /**
     * @generated from field: repeated openshell.v1.ProviderProfile profiles = 1;
     */
    profiles: ProviderProfile[];
    /**
     * Token for the next page. Empty when there are no subsequent pages.
     *
     * @generated from field: string next_page_token = 2;
     */
    nextPageToken: string;
};
/**
 * Describes the message openshell.v1.ListProviderProfilesResponse.
 * Use `create(ListProviderProfilesResponseSchema)` to create a new message.
 */
export declare const ListProviderProfilesResponseSchema: GenMessage<ListProviderProfilesResponse>;
/**
 * Import custom provider profiles request.
 *
 * @generated from message openshell.v1.ImportProviderProfilesRequest
 */
export type ImportProviderProfilesRequest = Message<"openshell.v1.ImportProviderProfilesRequest"> & {
    /**
     * Workspace scope. Omit for platform profiles; otherwise select one named workspace.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: repeated openshell.v1.ProviderProfileImportItem profiles = 1;
     */
    profiles: ProviderProfileImportItem[];
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 3;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.ImportProviderProfilesRequest.
 * Use `create(ImportProviderProfilesRequestSchema)` to create a new message.
 */
export declare const ImportProviderProfilesRequestSchema: GenMessage<ImportProviderProfilesRequest>;
/**
 * Import custom provider profiles response.
 *
 * @generated from message openshell.v1.ImportProviderProfilesResponse
 */
export type ImportProviderProfilesResponse = Message<"openshell.v1.ImportProviderProfilesResponse"> & {
    /**
     * @generated from field: repeated openshell.v1.ProviderProfileDiagnostic diagnostics = 1;
     */
    diagnostics: ProviderProfileDiagnostic[];
    /**
     * @generated from field: repeated openshell.v1.ProviderProfile profiles = 2;
     */
    profiles: ProviderProfile[];
    /**
     * @generated from field: bool imported = 3;
     */
    imported: boolean;
};
/**
 * Describes the message openshell.v1.ImportProviderProfilesResponse.
 * Use `create(ImportProviderProfilesResponseSchema)` to create a new message.
 */
export declare const ImportProviderProfilesResponseSchema: GenMessage<ImportProviderProfilesResponse>;
/**
 * Update one custom provider profile request.
 *
 * @generated from message openshell.v1.UpdateProviderProfilesRequest
 */
export type UpdateProviderProfilesRequest = Message<"openshell.v1.UpdateProviderProfilesRequest"> & {
    /**
     * Workspace scope. Omit for platform profiles; otherwise select one named workspace.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 4;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: openshell.v1.ProviderProfileImportItem profile = 1;
     */
    profile?: ProviderProfileImportItem | undefined;
    /**
     * Expected storage resource version for optimistic concurrency control.
     * If 0, the server uses the resource_version embedded in profile.profile.
     * Updates without a non-zero version are rejected to prevent stale files from
     * silently overwriting newer profile definitions.
     *
     * @generated from field: uint64 expected_resource_version = 2;
     */
    expectedResourceVersion: bigint;
    /**
     * Existing custom provider profile ID to update. The payload ID must match.
     *
     * @generated from field: string id = 3;
     */
    id: string;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 5;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.UpdateProviderProfilesRequest.
 * Use `create(UpdateProviderProfilesRequestSchema)` to create a new message.
 */
export declare const UpdateProviderProfilesRequestSchema: GenMessage<UpdateProviderProfilesRequest>;
/**
 * Update one custom provider profile response.
 *
 * @generated from message openshell.v1.UpdateProviderProfilesResponse
 */
export type UpdateProviderProfilesResponse = Message<"openshell.v1.UpdateProviderProfilesResponse"> & {
    /**
     * @generated from field: repeated openshell.v1.ProviderProfileDiagnostic diagnostics = 1;
     */
    diagnostics: ProviderProfileDiagnostic[];
    /**
     * @generated from field: openshell.v1.ProviderProfile profile = 2;
     */
    profile?: ProviderProfile | undefined;
    /**
     * @generated from field: bool updated = 3;
     */
    updated: boolean;
};
/**
 * Describes the message openshell.v1.UpdateProviderProfilesResponse.
 * Use `create(UpdateProviderProfilesResponseSchema)` to create a new message.
 */
export declare const UpdateProviderProfilesResponseSchema: GenMessage<UpdateProviderProfilesResponse>;
/**
 * Lint provider profiles request.
 *
 * @generated from message openshell.v1.LintProviderProfilesRequest
 */
export type LintProviderProfilesRequest = Message<"openshell.v1.LintProviderProfilesRequest"> & {
    /**
     * Workspace scope. Omit for platform profiles; otherwise select one named workspace.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: repeated openshell.v1.ProviderProfileImportItem profiles = 1;
     */
    profiles: ProviderProfileImportItem[];
};
/**
 * Describes the message openshell.v1.LintProviderProfilesRequest.
 * Use `create(LintProviderProfilesRequestSchema)` to create a new message.
 */
export declare const LintProviderProfilesRequestSchema: GenMessage<LintProviderProfilesRequest>;
/**
 * Lint provider profiles response.
 *
 * @generated from message openshell.v1.LintProviderProfilesResponse
 */
export type LintProviderProfilesResponse = Message<"openshell.v1.LintProviderProfilesResponse"> & {
    /**
     * @generated from field: repeated openshell.v1.ProviderProfileDiagnostic diagnostics = 1;
     */
    diagnostics: ProviderProfileDiagnostic[];
    /**
     * @generated from field: bool valid = 2;
     */
    valid: boolean;
    /**
     * Clients enabling stable_placeholder check this before import or update,
     * since older gateways silently discard unknown credential fields.
     *
     * @generated from field: bool supports_stable_placeholder = 3;
     */
    supportsStablePlaceholder: boolean;
};
/**
 * Describes the message openshell.v1.LintProviderProfilesResponse.
 * Use `create(LintProviderProfilesResponseSchema)` to create a new message.
 */
export declare const LintProviderProfilesResponseSchema: GenMessage<LintProviderProfilesResponse>;
/**
 * Delete provider response.
 *
 * @generated from message openshell.v1.DeleteProviderResponse
 */
export type DeleteProviderResponse = Message<"openshell.v1.DeleteProviderResponse"> & {
    /**
     * @generated from field: openshell.v1.DeletionOutcome outcome = 2;
     */
    outcome: DeletionOutcome;
};
/**
 * Describes the message openshell.v1.DeleteProviderResponse.
 * Use `create(DeleteProviderResponseSchema)` to create a new message.
 */
export declare const DeleteProviderResponseSchema: GenMessage<DeleteProviderResponse>;
/**
 * Delete custom provider profile request.
 *
 * @generated from message openshell.v1.DeleteProviderProfileRequest
 */
export type DeleteProviderProfileRequest = Message<"openshell.v1.DeleteProviderProfileRequest"> & {
    /**
     * Workspace scope. Omit for platform profiles; otherwise select one named workspace.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string id = 1;
     */
    id: string;
    /**
     * @generated from field: bool allow_missing = 3;
     */
    allowMissing: boolean;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 4;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.DeleteProviderProfileRequest.
 * Use `create(DeleteProviderProfileRequestSchema)` to create a new message.
 */
export declare const DeleteProviderProfileRequestSchema: GenMessage<DeleteProviderProfileRequest>;
/**
 * Delete custom provider profile response.
 *
 * @generated from message openshell.v1.DeleteProviderProfileResponse
 */
export type DeleteProviderProfileResponse = Message<"openshell.v1.DeleteProviderProfileResponse"> & {
    /**
     * @generated from field: openshell.v1.DeletionOutcome outcome = 2;
     */
    outcome: DeletionOutcome;
};
/**
 * Describes the message openshell.v1.DeleteProviderProfileResponse.
 * Use `create(DeleteProviderProfileResponseSchema)` to create a new message.
 */
export declare const DeleteProviderProfileResponseSchema: GenMessage<DeleteProviderProfileResponse>;
/**
 * Get sandbox provider environment request.
 *
 * @generated from message openshell.v1.GetSandboxProviderEnvironmentRequest
 */
export type GetSandboxProviderEnvironmentRequest = Message<"openshell.v1.GetSandboxProviderEnvironmentRequest"> & {
    /**
     * The sandbox ID.
     *
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * Whether the requesting supervisor enforces endpoint bindings for static
     * provider credentials. Gateways withhold static credential material when
     * this capability is absent.
     *
     * @generated from field: bool supports_static_credential_bindings = 2;
     */
    supportsStaticCredentialBindings: boolean;
    /**
     * Whether the requesting supervisor understands stable external-placeholder
     * metadata. Gateways withhold credentials that require this behavior when
     * the capability is absent.
     *
     * @generated from field: bool supports_stable_placeholder_environment_keys = 3;
     */
    supportsStablePlaceholderEnvironmentKeys: boolean;
};
/**
 * Describes the message openshell.v1.GetSandboxProviderEnvironmentRequest.
 * Use `create(GetSandboxProviderEnvironmentRequestSchema)` to create a new message.
 */
export declare const GetSandboxProviderEnvironmentRequestSchema: GenMessage<GetSandboxProviderEnvironmentRequest>;
/**
 * One network endpoint at which a static provider credential may be resolved.
 *
 * @generated from message openshell.v1.StaticCredentialEndpointBinding
 */
export type StaticCredentialEndpointBinding = Message<"openshell.v1.StaticCredentialEndpointBinding"> & {
    /**
     * @generated from field: string host = 1;
     */
    host: string;
    /**
     * @generated from field: uint32 port = 2;
     */
    port: number;
    /**
     * @generated from field: string path = 3;
     */
    path: string;
};
/**
 * Describes the message openshell.v1.StaticCredentialEndpointBinding.
 * Use `create(StaticCredentialEndpointBindingSchema)` to create a new message.
 */
export declare const StaticCredentialEndpointBindingSchema: GenMessage<StaticCredentialEndpointBinding>;
/**
 * Endpoint allowlist for one static provider credential environment variable.
 *
 * @generated from message openshell.v1.StaticCredentialBinding
 */
export type StaticCredentialBinding = Message<"openshell.v1.StaticCredentialBinding"> & {
    /**
     * @generated from field: repeated openshell.v1.StaticCredentialEndpointBinding endpoints = 1;
     */
    endpoints: StaticCredentialEndpointBinding[];
    /**
     * Stable identity of the provider credential that produced this binding.
     * Supervisors use it to retain old revision placeholders only across
     * rotations of the same provider credential.
     *
     * @generated from field: string credential_identity = 2;
     */
    credentialIdentity: string;
    /**
     * Opaque gateway-issued handle for a stable credential lifecycle. When
     * non-empty, supervisors keep the workload placeholder stable across value
     * updates and replace only the resolver value. The handle changes when the
     * sandbox, provider, credential key, endpoint authorization, or an applicable
     * refresh authorization epoch changes.
     *
     * @generated from field: string workload_credential_handle = 3;
     */
    workloadCredentialHandle: string;
};
/**
 * Describes the message openshell.v1.StaticCredentialBinding.
 * Use `create(StaticCredentialBindingSchema)` to create a new message.
 */
export declare const StaticCredentialBindingSchema: GenMessage<StaticCredentialBinding>;
/**
 * Polling projection of ProviderEnvironmentSnapshot. The parallel maps below
 * are keyed by the same environment variable names. Removed with the polling
 * RPCs; new provider environment fields belong on the snapshot first.
 *
 * @generated from message openshell.v1.GetSandboxProviderEnvironmentResponse
 */
export type GetSandboxProviderEnvironmentResponse = Message<"openshell.v1.GetSandboxProviderEnvironmentResponse"> & {
    /**
     * Provider credential environment variables.
     *
     * @generated from field: map<string, string> environment = 1;
     */
    environment: {
        [key: string]: string;
    };
    /**
     * Fingerprint for the provider credential inputs that produced environment.
     *
     * @generated from field: uint64 provider_env_revision = 2;
     */
    providerEnvRevision: bigint;
    /**
     * Expiration timestamps for returned environment variables.
     *
     * @generated from field: map<string, google.protobuf.Timestamp> credential_expiration_times = 103;
     */
    credentialExpirationTimes: {
        [key: string]: Timestamp;
    };
    /**
     * Dynamic credentials that require token grants or other runtime injection.
     * Maps endpoint-bound provider metadata to credential metadata.
     * Supervisor uses this to inject Authorization headers for token grant credentials.
     *
     * @generated from field: map<string, openshell.v1.ProviderProfileCredential> dynamic_credentials = 4;
     */
    dynamicCredentials: {
        [key: string]: ProviderProfileCredential;
    };
    /**
     * Endpoint allowlists for static credential environment variables. Metadata
     * can be incomplete when a provider profile is invalid; capable supervisors
     * reject all static material in that snapshot while preserving independently
     * endpoint-bound dynamic credentials.
     *
     * @generated from field: map<string, openshell.v1.StaticCredentialBinding> static_credential_bindings = 5;
     */
    staticCredentialBindings: {
        [key: string]: StaticCredentialBinding;
    };
    /**
     * Environment variables that contain provider configuration rather than
     * credentials and therefore do not require endpoint-scoped resolution.
     *
     * @generated from field: repeated string non_secret_environment_keys = 6;
     */
    nonSecretEnvironmentKeys: string[];
    /**
     * Attachment identity captured with the returned provider records.
     *
     * @generated from field: string provider_attachment_epoch = 7;
     */
    providerAttachmentEpoch: string;
    /**
     * Effective policy identity used to derive this snapshot's endpoint bindings.
     *
     * @generated from field: string policy_hash = 8;
     */
    policyHash: string;
    /**
     * Nonzero when material was withheld; installing an empty map is not readiness.
     *
     * @generated from field: openshell.v1.ProviderReadinessReason readiness_reason = 9;
     */
    readinessReason: ProviderReadinessReason;
    /**
     * Complete desired set of non-secret managed files, keyed by absolute path.
     *
     * @generated from field: map<string, string> files = 10;
     */
    files: {
        [key: string]: string;
    };
    /**
     * Credential environment variables whose opaque resolver handle remains
     * stable across value-only provider revisions. These keys are still secrets;
     * this metadata only selects the stable external-placeholder behavior.
     *
     * @generated from field: repeated string stable_placeholder_environment_keys = 11;
     */
    stablePlaceholderEnvironmentKeys: string[];
    /**
     * Supporting gateways always acknowledge the stable-placeholder delivery
     * contract, including responses without opted-in credentials. Supervisors
     * require acknowledgment for declared or previously activated external
     * stable credentials; ordinary legacy delivery does not require it.
     *
     * @generated from field: bool supports_stable_placeholder_environment_keys = 12;
     */
    supportsStablePlaceholderEnvironmentKeys: boolean;
};
/**
 * Describes the message openshell.v1.GetSandboxProviderEnvironmentResponse.
 * Use `create(GetSandboxProviderEnvironmentResponseSchema)` to create a new message.
 */
export declare const GetSandboxProviderEnvironmentResponseSchema: GenMessage<GetSandboxProviderEnvironmentResponse>;
/**
 * One environment value and all metadata that shares its key. Names are unique
 * within a snapshot. static_credential_binding is present exactly when
 * classification is STATIC_CREDENTIAL. Snapshots that violate either rule are
 * invalid.
 *
 * @generated from message openshell.v1.ProviderEnvironmentValue
 */
export type ProviderEnvironmentValue = Message<"openshell.v1.ProviderEnvironmentValue"> & {
    /**
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * @generated from field: string value = 2;
     */
    value: string;
    /**
     * @generated from field: openshell.v1.ProviderEnvironmentValueClassification classification = 4;
     */
    classification: ProviderEnvironmentValueClassification;
    /**
     * @generated from field: openshell.v1.StaticCredentialBinding static_credential_binding = 5;
     */
    staticCredentialBinding?: StaticCredentialBinding | undefined;
    /**
     * Absolute expiration time. Absence means no expiry.
     *
     * @generated from field: google.protobuf.Timestamp expiration_time = 3;
     */
    expirationTime?: Timestamp | undefined;
    /**
     * The static credential keeps one opaque resolver handle across value-only
     * provider revisions. Set only for STATIC_CREDENTIAL values whose binding
     * carries a workload_credential_handle.
     *
     * @generated from field: bool stable_placeholder = 6;
     */
    stablePlaceholder: boolean;
};
/**
 * Describes the message openshell.v1.ProviderEnvironmentValue.
 * Use `create(ProviderEnvironmentValueSchema)` to create a new message.
 */
export declare const ProviderEnvironmentValueSchema: GenMessage<ProviderEnvironmentValue>;
/**
 * Complete provider environment state delivered to a supervisor. This is the
 * canonical provider environment shape; GetSandboxProviderEnvironmentResponse
 * is its polling projection and is removed with the polling RPCs. Dynamic
 * credentials are endpoint selectors rather than environment values and stay
 * in their own collection.
 *
 * @generated from message openshell.v1.ProviderEnvironmentSnapshot
 */
export type ProviderEnvironmentSnapshot = Message<"openshell.v1.ProviderEnvironmentSnapshot"> & {
    /**
     * @generated from field: uint64 provider_env_revision = 1;
     */
    providerEnvRevision: bigint;
    /**
     * @generated from field: repeated openshell.v1.ProviderEnvironmentValue values = 2;
     */
    values: ProviderEnvironmentValue[];
    /**
     * @generated from field: map<string, openshell.v1.ProviderProfileCredential> dynamic_credentials = 3;
     */
    dynamicCredentials: {
        [key: string]: ProviderProfileCredential;
    };
    /**
     * @generated from field: string provider_attachment_epoch = 4;
     */
    providerAttachmentEpoch: string;
    /**
     * @generated from field: string policy_hash = 5;
     */
    policyHash: string;
    /**
     * @generated from field: openshell.v1.ProviderReadinessReason readiness_reason = 6;
     */
    readinessReason: ProviderReadinessReason;
    /**
     * Complete desired set of non-secret managed files, keyed by absolute path.
     *
     * @generated from field: map<string, string> files = 7;
     */
    files: {
        [key: string]: string;
    };
};
/**
 * Describes the message openshell.v1.ProviderEnvironmentSnapshot.
 * Use `create(ProviderEnvironmentSnapshotSchema)` to create a new message.
 */
export declare const ProviderEnvironmentSnapshotSchema: GenMessage<ProviderEnvironmentSnapshot>;
/**
 * @generated from message openshell.v1.ExchangeProviderSubjectTokenRequest
 */
export type ExchangeProviderSubjectTokenRequest = Message<"openshell.v1.ExchangeProviderSubjectTokenRequest"> & {
    /**
     * The sandbox ID. Must match the authenticated sandbox principal.
     *
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * Attached provider record holding the configured subject token credential.
     *
     * @generated from field: string provider = 2;
     */
    provider: string;
    /**
     * Provider profile credential that declares the token_exchange grant.
     *
     * @generated from field: string credential_key = 3;
     */
    credentialKey: string;
    /**
     * Supervisor JWT-SVID. The gateway verifies this and uses its `sub` claim
     * as the requested audience for the intermediate token.
     *
     * @generated from field: string supervisor_jwt_svid = 4;
     */
    supervisorJwtSvid: string;
};
/**
 * Describes the message openshell.v1.ExchangeProviderSubjectTokenRequest.
 * Use `create(ExchangeProviderSubjectTokenRequestSchema)` to create a new message.
 */
export declare const ExchangeProviderSubjectTokenRequestSchema: GenMessage<ExchangeProviderSubjectTokenRequest>;
/**
 * @generated from message openshell.v1.ExchangeProviderSubjectTokenResponse
 */
export type ExchangeProviderSubjectTokenResponse = Message<"openshell.v1.ExchangeProviderSubjectTokenResponse"> & {
    /**
     * @generated from field: string access_token = 1;
     */
    accessToken: string;
    /**
     * @generated from field: google.protobuf.Duration expires_after = 102;
     */
    expiresAfter?: Duration | undefined;
    /**
     * @generated from field: string token_type = 3;
     */
    tokenType: string;
};
/**
 * Describes the message openshell.v1.ExchangeProviderSubjectTokenResponse.
 * Use `create(ExchangeProviderSubjectTokenResponseSchema)` to create a new message.
 */
export declare const ExchangeProviderSubjectTokenResponseSchema: GenMessage<ExchangeProviderSubjectTokenResponse>;
/**
 * Update sandbox policy request.
 *
 * @generated from message openshell.v1.UpdateConfigRequest
 */
export type UpdateConfigRequest = Message<"openshell.v1.UpdateConfigRequest"> & {
    /**
     * Workspace scope. Omit for global updates; otherwise select one named workspace.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 10;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * The new policy to apply.
     *
     * Sandbox scope (`global=false`):
     * - only network_policies may differ from create-time
     *   policy; static fields must match version 1.
     *
     * Global scope (`global=true`):
     * - applies to all sandboxes in full (no merge).
     *
     * @generated from field: openshell.sandbox.v1.SandboxPolicy policy = 2;
     */
    policy?: SandboxPolicy | undefined;
    /**
     * Optional single setting key to mutate.
     *
     * @generated from field: string setting_key = 3;
     */
    settingKey: string;
    /**
     * Setting value for upsert operations.
     *
     * @generated from field: openshell.sandbox.v1.SettingValue setting_value = 4;
     */
    settingValue?: SettingValue | undefined;
    /**
     * Delete the setting key from scope.
     * Sandbox-scoped deletes are rejected; only global delete is supported.
     *
     * @generated from field: bool delete_setting = 5;
     */
    deleteSetting: boolean;
    /**
     * Apply mutation at gateway-global scope.
     *
     * @generated from field: bool global = 6;
     */
    global: boolean;
    /**
     * Batched incremental policy merge operations. Sandbox-scoped only.
     *
     * @generated from field: repeated openshell.v1.PolicyMergeOperation merge_operations = 7;
     */
    mergeOperations: PolicyMergeOperation[];
    /**
     * Expected resource version for optimistic concurrency control (sandbox-scoped only).
     * If 0, the server uses the current version (backward compatibility).
     * If non-zero, the server validates that the sandbox's current resource_version
     * matches this value before applying the mutation, returning ABORTED on mismatch.
     * Ignored for global-scoped updates.
     *
     * @generated from field: uint64 expected_resource_version = 8;
     */
    expectedResourceVersion: bigint;
    /**
     * Caller-provided annotations associated with a sandbox-scoped update. Values
     * must not contain secrets; the gateway treats them as opaque metadata and does
     * not interpret or verify their semantics. For policy updates, the gateway
     * stores the annotations immutably with the revision and merges them into
     * sandbox metadata as a convenience projection. For setting-only updates, it
     * only merges them into sandbox metadata. Keys under the
     * `internal.openshell.ai/` prefix are reserved for the gateway.
     *
     * @generated from field: map<string, string> annotations = 9;
     */
    annotations: {
        [key: string]: string;
    };
    /**
     * Required for sandbox-scoped updates and empty for global updates.
     *
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 11;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.UpdateConfigRequest.
 * Use `create(UpdateConfigRequestSchema)` to create a new message.
 */
export declare const UpdateConfigRequestSchema: GenMessage<UpdateConfigRequest>;
/**
 * @generated from message openshell.v1.PolicyMergeOperation
 */
export type PolicyMergeOperation = Message<"openshell.v1.PolicyMergeOperation"> & {
    /**
     * @generated from oneof openshell.v1.PolicyMergeOperation.operation
     */
    operation: {
        /**
         * @generated from field: openshell.v1.AddNetworkRule add_rule = 1;
         */
        value: AddNetworkRule;
        case: "addRule";
    } | {
        /**
         * @generated from field: openshell.v1.RemoveNetworkEndpoint remove_endpoint = 2;
         */
        value: RemoveNetworkEndpoint;
        case: "removeEndpoint";
    } | {
        /**
         * @generated from field: openshell.v1.RemoveNetworkRule remove_rule = 3;
         */
        value: RemoveNetworkRule;
        case: "removeRule";
    } | {
        /**
         * @generated from field: openshell.v1.AddDenyRules add_deny_rules = 4;
         */
        value: AddDenyRules;
        case: "addDenyRules";
    } | {
        /**
         * @generated from field: openshell.v1.AddAllowRules add_allow_rules = 5;
         */
        value: AddAllowRules;
        case: "addAllowRules";
    } | {
        /**
         * @generated from field: openshell.v1.RemoveNetworkBinary remove_binary = 6;
         */
        value: RemoveNetworkBinary;
        case: "removeBinary";
    } | {
        case: undefined;
        value?: undefined;
    };
};
/**
 * Describes the message openshell.v1.PolicyMergeOperation.
 * Use `create(PolicyMergeOperationSchema)` to create a new message.
 */
export declare const PolicyMergeOperationSchema: GenMessage<PolicyMergeOperation>;
/**
 * @generated from message openshell.v1.AddNetworkRule
 */
export type AddNetworkRule = Message<"openshell.v1.AddNetworkRule"> & {
    /**
     * @generated from field: string rule_name = 1;
     */
    ruleName: string;
    /**
     * @generated from field: openshell.sandbox.v1.NetworkPolicyRule rule = 2;
     */
    rule?: NetworkPolicyRule | undefined;
};
/**
 * Describes the message openshell.v1.AddNetworkRule.
 * Use `create(AddNetworkRuleSchema)` to create a new message.
 */
export declare const AddNetworkRuleSchema: GenMessage<AddNetworkRule>;
/**
 * @generated from message openshell.v1.RemoveNetworkEndpoint
 */
export type RemoveNetworkEndpoint = Message<"openshell.v1.RemoveNetworkEndpoint"> & {
    /**
     * @generated from field: string rule_name = 1;
     */
    ruleName: string;
    /**
     * @generated from field: string host = 2;
     */
    host: string;
    /**
     * @generated from field: uint32 port = 3;
     */
    port: number;
};
/**
 * Describes the message openshell.v1.RemoveNetworkEndpoint.
 * Use `create(RemoveNetworkEndpointSchema)` to create a new message.
 */
export declare const RemoveNetworkEndpointSchema: GenMessage<RemoveNetworkEndpoint>;
/**
 * @generated from message openshell.v1.RemoveNetworkRule
 */
export type RemoveNetworkRule = Message<"openshell.v1.RemoveNetworkRule"> & {
    /**
     * @generated from field: string rule_name = 1;
     */
    ruleName: string;
};
/**
 * Describes the message openshell.v1.RemoveNetworkRule.
 * Use `create(RemoveNetworkRuleSchema)` to create a new message.
 */
export declare const RemoveNetworkRuleSchema: GenMessage<RemoveNetworkRule>;
/**
 * Exact endpoint and complete authorization scope affected by an L7 append.
 * All ports and binaries must match the stored target; omitted scope is invalid.
 *
 * @generated from message openshell.v1.L7RuleTarget
 */
export type L7RuleTarget = Message<"openshell.v1.L7RuleTarget"> & {
    /**
     * @generated from field: string rule_name = 1;
     */
    ruleName: string;
    /**
     * @generated from field: string host = 2;
     */
    host: string;
    /**
     * @generated from field: repeated uint32 ports = 3;
     */
    ports: number[];
    /**
     * An absent path requires a unique endpoint. An empty path selects an
     * endpoint without a path selector. This is not the appended request path.
     *
     * @generated from field: optional string path = 4;
     */
    path?: string | undefined;
    /**
     * Declare either a nonempty binary list or any_binary, never both.
     *
     * @generated from field: repeated openshell.sandbox.v1.NetworkBinary binaries = 5;
     */
    binaries: NetworkBinary[];
    /**
     * @generated from field: bool any_binary = 6;
     */
    anyBinary: boolean;
};
/**
 * Describes the message openshell.v1.L7RuleTarget.
 * Use `create(L7RuleTargetSchema)` to create a new message.
 */
export declare const L7RuleTargetSchema: GenMessage<L7RuleTarget>;
/**
 * @generated from message openshell.v1.AddDenyRules
 */
export type AddDenyRules = Message<"openshell.v1.AddDenyRules"> & {
    /**
     * @generated from field: repeated openshell.sandbox.v1.L7DenyRule deny_rules = 3;
     */
    denyRules: L7DenyRule[];
    /**
     * @generated from field: openshell.v1.L7RuleTarget target = 4;
     */
    target?: L7RuleTarget | undefined;
};
/**
 * Describes the message openshell.v1.AddDenyRules.
 * Use `create(AddDenyRulesSchema)` to create a new message.
 */
export declare const AddDenyRulesSchema: GenMessage<AddDenyRules>;
/**
 * @generated from message openshell.v1.AddAllowRules
 */
export type AddAllowRules = Message<"openshell.v1.AddAllowRules"> & {
    /**
     * @generated from field: repeated openshell.sandbox.v1.L7Rule rules = 3;
     */
    rules: L7Rule[];
    /**
     * @generated from field: openshell.v1.L7RuleTarget target = 4;
     */
    target?: L7RuleTarget | undefined;
};
/**
 * Describes the message openshell.v1.AddAllowRules.
 * Use `create(AddAllowRulesSchema)` to create a new message.
 */
export declare const AddAllowRulesSchema: GenMessage<AddAllowRules>;
/**
 * @generated from message openshell.v1.RemoveNetworkBinary
 */
export type RemoveNetworkBinary = Message<"openshell.v1.RemoveNetworkBinary"> & {
    /**
     * @generated from field: string rule_name = 1;
     */
    ruleName: string;
    /**
     * @generated from field: string binary_path = 2;
     */
    binaryPath: string;
};
/**
 * Describes the message openshell.v1.RemoveNetworkBinary.
 * Use `create(RemoveNetworkBinarySchema)` to create a new message.
 */
export declare const RemoveNetworkBinarySchema: GenMessage<RemoveNetworkBinary>;
/**
 * Update sandbox policy response.
 *
 * @generated from message openshell.v1.UpdateConfigResponse
 */
export type UpdateConfigResponse = Message<"openshell.v1.UpdateConfigResponse"> & {
    /**
     * Assigned policy version (monotonically increasing per sandbox).
     *
     * @generated from field: uint32 version = 1;
     */
    version: number;
    /**
     * SHA-256 hash of the serialized policy payload.
     *
     * @generated from field: string policy_hash = 2;
     */
    policyHash: string;
    /**
     * Settings revision for the scope that was modified.
     *
     * @generated from field: uint64 settings_revision = 3;
     */
    settingsRevision: bigint;
    /**
     * True when a setting delete operation removed an existing key.
     *
     * @generated from field: bool deleted = 4;
     */
    deleted: boolean;
    /**
     * Sandbox metadata annotations after the update. Empty for global updates.
     *
     * @generated from field: map<string, string> annotations = 5;
     */
    annotations: {
        [key: string]: string;
    };
};
/**
 * Describes the message openshell.v1.UpdateConfigResponse.
 * Use `create(UpdateConfigResponseSchema)` to create a new message.
 */
export declare const UpdateConfigResponseSchema: GenMessage<UpdateConfigResponse>;
/**
 * Get sandbox policy status request.
 *
 * @generated from message openshell.v1.GetSandboxPolicyStatusRequest
 */
export type GetSandboxPolicyStatusRequest = Message<"openshell.v1.GetSandboxPolicyStatusRequest"> & {
    /**
     * Workspace scope. Omit for global queries; otherwise select one named workspace.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 4;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * The specific policy version to query. 0 means latest.
     *
     * @generated from field: uint32 version = 2;
     */
    version: number;
    /**
     * Query global policy revisions instead of a sandbox-scoped one.
     *
     * @generated from field: bool global = 3;
     */
    global: boolean;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
};
/**
 * Describes the message openshell.v1.GetSandboxPolicyStatusRequest.
 * Use `create(GetSandboxPolicyStatusRequestSchema)` to create a new message.
 */
export declare const GetSandboxPolicyStatusRequestSchema: GenMessage<GetSandboxPolicyStatusRequest>;
/**
 * Get sandbox policy status response.
 *
 * @generated from message openshell.v1.GetSandboxPolicyStatusResponse
 */
export type GetSandboxPolicyStatusResponse = Message<"openshell.v1.GetSandboxPolicyStatusResponse"> & {
    /**
     * The queried policy revision.
     *
     * @generated from field: openshell.v1.SandboxPolicyRevision revision = 1;
     */
    revision?: SandboxPolicyRevision | undefined;
    /**
     * The currently active (loaded) policy version for this sandbox.
     *
     * @generated from field: uint32 active_version = 2;
     */
    activeVersion: number;
};
/**
 * Describes the message openshell.v1.GetSandboxPolicyStatusResponse.
 * Use `create(GetSandboxPolicyStatusResponseSchema)` to create a new message.
 */
export declare const GetSandboxPolicyStatusResponseSchema: GenMessage<GetSandboxPolicyStatusResponse>;
/**
 * List sandbox policies request.
 *
 * @generated from message openshell.v1.ListSandboxPoliciesRequest
 */
export type ListSandboxPoliciesRequest = Message<"openshell.v1.ListSandboxPoliciesRequest"> & {
    /**
     * Workspace scope. Omit for global queries; otherwise select one named workspace.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 5;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * The maximum number of revisions to return. Zero uses 100. Values above
     * 1000 are coerced to 1000; negative values are invalid.
     *
     * @generated from field: int32 page_size = 2;
     */
    pageSize: number;
    /**
     * Token from a previous ListSandboxPolicies response. All other request
     * parameters except page_size must match the request that produced it.
     *
     * @generated from field: string page_token = 3;
     */
    pageToken: string;
    /**
     * List global policy revisions instead of sandbox-scoped ones.
     *
     * @generated from field: bool global = 4;
     */
    global: boolean;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
};
/**
 * Describes the message openshell.v1.ListSandboxPoliciesRequest.
 * Use `create(ListSandboxPoliciesRequestSchema)` to create a new message.
 */
export declare const ListSandboxPoliciesRequestSchema: GenMessage<ListSandboxPoliciesRequest>;
/**
 * List sandbox policies response.
 *
 * @generated from message openshell.v1.ListSandboxPoliciesResponse
 */
export type ListSandboxPoliciesResponse = Message<"openshell.v1.ListSandboxPoliciesResponse"> & {
    /**
     * Invalid historical payloads remain visible as failed projections so one
     * legacy row cannot hide the rest of the policy history.
     *
     * @generated from field: repeated openshell.v1.SandboxPolicyRevision revisions = 1;
     */
    revisions: SandboxPolicyRevision[];
    /**
     * Token for the next page. Empty when there are no subsequent pages.
     *
     * @generated from field: string next_page_token = 2;
     */
    nextPageToken: string;
};
/**
 * Describes the message openshell.v1.ListSandboxPoliciesResponse.
 * Use `create(ListSandboxPoliciesResponseSchema)` to create a new message.
 */
export declare const ListSandboxPoliciesResponseSchema: GenMessage<ListSandboxPoliciesResponse>;
/**
 * Report policy load status (called by sandbox runtime after reload attempt).
 *
 * @generated from message openshell.v1.ReportPolicyStatusRequest
 */
export type ReportPolicyStatusRequest = Message<"openshell.v1.ReportPolicyStatusRequest"> & {
    /**
     * Sandbox id.
     *
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * The policy version that was attempted.
     *
     * @generated from field: uint32 version = 2;
     */
    version: number;
    /**
     * Load result status.
     *
     * @generated from field: openshell.v1.PolicyStatus status = 3;
     */
    status: PolicyStatus;
    /**
     * Error message if status is FAILED.
     *
     * @generated from field: string load_error = 4;
     */
    loadError: string;
};
/**
 * Describes the message openshell.v1.ReportPolicyStatusRequest.
 * Use `create(ReportPolicyStatusRequestSchema)` to create a new message.
 */
export declare const ReportPolicyStatusRequestSchema: GenMessage<ReportPolicyStatusRequest>;
/**
 * Report policy status response.
 *
 * @generated from message openshell.v1.ReportPolicyStatusResponse
 */
export type ReportPolicyStatusResponse = Message<"openshell.v1.ReportPolicyStatusResponse"> & {};
/**
 * Describes the message openshell.v1.ReportPolicyStatusResponse.
 * Use `create(ReportPolicyStatusResponseSchema)` to create a new message.
 */
export declare const ReportPolicyStatusResponseSchema: GenMessage<ReportPolicyStatusResponse>;
/**
 * @generated from message openshell.v1.SandboxConfigurationAdmission
 */
export type SandboxConfigurationAdmission = Message<"openshell.v1.SandboxConfigurationAdmission"> & {
    /**
     * @generated from field: string instance_id = 1;
     */
    instanceId: string;
    /**
     * @generated from field: openshell.v1.ConfigurationAdmissionState state = 2;
     */
    state: ConfigurationAdmissionState;
    /**
     * @generated from field: uint32 policy_version = 3;
     */
    policyVersion: number;
    /**
     * @generated from field: string policy_hash = 4;
     */
    policyHash: string;
    /**
     * @generated from field: uint64 config_revision = 5;
     */
    configRevision: bigint;
    /**
     * @generated from field: uint64 provider_env_revision = 6;
     */
    providerEnvRevision: bigint;
    /**
     * @generated from field: string error = 7;
     */
    error: string;
};
/**
 * Describes the message openshell.v1.SandboxConfigurationAdmission.
 * Use `create(SandboxConfigurationAdmissionSchema)` to create a new message.
 */
export declare const SandboxConfigurationAdmissionSchema: GenMessage<SandboxConfigurationAdmission>;
/**
 * @generated from message openshell.v1.ReportSandboxConfigurationRequest
 */
export type ReportSandboxConfigurationRequest = Message<"openshell.v1.ReportSandboxConfigurationRequest"> & {
    /**
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * @generated from field: openshell.v1.SandboxConfigurationAdmission admission = 2;
     */
    admission?: SandboxConfigurationAdmission | undefined;
    /**
     * Pending registration replaces only this previously observed instance.
     *
     * @generated from field: string expected_instance_id = 3;
     */
    expectedInstanceId: string;
};
/**
 * Describes the message openshell.v1.ReportSandboxConfigurationRequest.
 * Use `create(ReportSandboxConfigurationRequestSchema)` to create a new message.
 */
export declare const ReportSandboxConfigurationRequestSchema: GenMessage<ReportSandboxConfigurationRequest>;
/**
 * @generated from message openshell.v1.ReportSandboxConfigurationResponse
 */
export type ReportSandboxConfigurationResponse = Message<"openshell.v1.ReportSandboxConfigurationResponse"> & {};
/**
 * Describes the message openshell.v1.ReportSandboxConfigurationResponse.
 * Use `create(ReportSandboxConfigurationResponseSchema)` to create a new message.
 */
export declare const ReportSandboxConfigurationResponseSchema: GenMessage<ReportSandboxConfigurationResponse>;
/**
 * A versioned policy revision with metadata.
 *
 * @generated from message openshell.v1.SandboxPolicyRevision
 */
export type SandboxPolicyRevision = Message<"openshell.v1.SandboxPolicyRevision"> & {
    /**
     * Policy version (monotonically increasing per sandbox).
     *
     * @generated from field: uint32 version = 1;
     */
    version: number;
    /**
     * SHA-256 hash of the canonical serialized policy payload. Empty in a
     * ListSandboxPolicies projection when the stored payload is invalid under
     * the current schema and therefore has no trusted canonical identity.
     *
     * @generated from field: string policy_hash = 2;
     */
    policyHash: string;
    /**
     * Load status of this revision. ListSandboxPolicies reports FAILED when a
     * stored historical payload is invalid under the current schema, regardless
     * of its persisted sandbox load status.
     *
     * @generated from field: openshell.v1.PolicyStatus status = 3;
     */
    status: PolicyStatus;
    /**
     * Sandbox load error, or the schema-validation diagnostic for an invalid
     * historical row returned by ListSandboxPolicies.
     *
     * @generated from field: string load_error = 4;
     */
    loadError: string;
    /**
     * Time when this revision was created.
     *
     * @generated from field: google.protobuf.Timestamp created_time = 105;
     */
    createdTime?: Timestamp | undefined;
    /**
     * Time when this revision was loaded by the sandbox. Absent if not loaded.
     *
     * @generated from field: google.protobuf.Timestamp loaded_time = 106;
     */
    loadedTime?: Timestamp | undefined;
    /**
     * The full policy (only populated when explicitly requested).
     *
     * @generated from field: openshell.sandbox.v1.SandboxPolicy policy = 7;
     */
    policy?: SandboxPolicy | undefined;
    /**
     * Immutable provenance supplied with this policy revision.
     *
     * @generated from field: map<string, string> provenance = 8;
     */
    provenance: {
        [key: string]: string;
    };
};
/**
 * Describes the message openshell.v1.SandboxPolicyRevision.
 * Use `create(SandboxPolicyRevisionSchema)` to create a new message.
 */
export declare const SandboxPolicyRevisionSchema: GenMessage<SandboxPolicyRevision>;
/**
 * Get sandbox logs request (one-shot fetch).
 *
 * @generated from message openshell.v1.GetSandboxLogsRequest
 */
export type GetSandboxLogsRequest = Message<"openshell.v1.GetSandboxLogsRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 6;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Canonical sandbox name.
     *
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * Maximum number of log lines to return. 0 means use default (2000).
     *
     * @generated from field: uint32 lines = 2;
     */
    lines: number;
    /**
     * Only include logs at or after this time. Absence means no filter.
     *
     * @generated from field: google.protobuf.Timestamp since_time = 103;
     */
    sinceTime?: Timestamp | undefined;
    /**
     * Filter by log source (e.g. "gateway", "sandbox"). Empty means all sources.
     *
     * @generated from field: repeated string sources = 4;
     */
    sources: string[];
    /**
     * Minimum log level to include (e.g. "INFO", "WARN", "ERROR"). Empty means all levels.
     *
     * @generated from field: string min_level = 5;
     */
    minLevel: string;
};
/**
 * Describes the message openshell.v1.GetSandboxLogsRequest.
 * Use `create(GetSandboxLogsRequestSchema)` to create a new message.
 */
export declare const GetSandboxLogsRequestSchema: GenMessage<GetSandboxLogsRequest>;
/**
 * Batch of log lines pushed from sandbox to server.
 *
 * @generated from message openshell.v1.PushSandboxLogsRequest
 */
export type PushSandboxLogsRequest = Message<"openshell.v1.PushSandboxLogsRequest"> & {
    /**
     * The sandbox ID.
     *
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * Log lines to ingest.
     *
     * @generated from field: repeated openshell.v1.SandboxLogLine logs = 2;
     */
    logs: SandboxLogLine[];
};
/**
 * Describes the message openshell.v1.PushSandboxLogsRequest.
 * Use `create(PushSandboxLogsRequestSchema)` to create a new message.
 */
export declare const PushSandboxLogsRequestSchema: GenMessage<PushSandboxLogsRequest>;
/**
 * Push sandbox logs response.
 *
 * @generated from message openshell.v1.PushSandboxLogsResponse
 */
export type PushSandboxLogsResponse = Message<"openshell.v1.PushSandboxLogsResponse"> & {};
/**
 * Describes the message openshell.v1.PushSandboxLogsResponse.
 * Use `create(PushSandboxLogsResponseSchema)` to create a new message.
 */
export declare const PushSandboxLogsResponseSchema: GenMessage<PushSandboxLogsResponse>;
/**
 * Get sandbox logs response.
 *
 * @generated from message openshell.v1.GetSandboxLogsResponse
 */
export type GetSandboxLogsResponse = Message<"openshell.v1.GetSandboxLogsResponse"> & {
    /**
     * Log lines in chronological order.
     *
     * @generated from field: repeated openshell.v1.SandboxLogLine logs = 1;
     */
    logs: SandboxLogLine[];
    /**
     * Total number of lines in the server's buffer for this sandbox.
     *
     * @generated from field: uint32 buffer_total = 2;
     */
    bufferTotal: number;
};
/**
 * Describes the message openshell.v1.GetSandboxLogsResponse.
 * Use `create(GetSandboxLogsResponseSchema)` to create a new message.
 */
export declare const GetSandboxLogsResponseSchema: GenMessage<GetSandboxLogsResponse>;
/**
 * Envelope for supervisor-to-gateway messages on the ConnectSupervisor stream.
 *
 * @generated from message openshell.v1.SupervisorMessage
 */
export type SupervisorMessage = Message<"openshell.v1.SupervisorMessage"> & {
    /**
     * @generated from oneof openshell.v1.SupervisorMessage.payload
     */
    payload: {
        /**
         * @generated from field: openshell.v1.SupervisorHello hello = 1;
         */
        value: SupervisorHello;
        case: "hello";
    } | {
        /**
         * @generated from field: openshell.v1.SupervisorHeartbeat heartbeat = 2;
         */
        value: SupervisorHeartbeat;
        case: "heartbeat";
    } | {
        /**
         * @generated from field: openshell.v1.RelayOpenResult relay_open_result = 3;
         */
        value: RelayOpenResult;
        case: "relayOpenResult";
    } | {
        /**
         * @generated from field: openshell.v1.RelayClose relay_close = 4;
         */
        value: RelayClose;
        case: "relayClose";
    } | {
        /**
         * @generated from field: openshell.v1.ConfigUpdateResult config_update_result = 5;
         */
        value: ConfigUpdateResult;
        case: "configUpdateResult";
    } | {
        case: undefined;
        value?: undefined;
    };
};
/**
 * Describes the message openshell.v1.SupervisorMessage.
 * Use `create(SupervisorMessageSchema)` to create a new message.
 */
export declare const SupervisorMessageSchema: GenMessage<SupervisorMessage>;
/**
 * Envelope for gateway-to-supervisor messages on the ConnectSupervisor stream.
 *
 * @generated from message openshell.v1.GatewayMessage
 */
export type GatewayMessage = Message<"openshell.v1.GatewayMessage"> & {
    /**
     * @generated from oneof openshell.v1.GatewayMessage.payload
     */
    payload: {
        /**
         * @generated from field: openshell.v1.SessionAccepted session_accepted = 1;
         */
        value: SessionAccepted;
        case: "sessionAccepted";
    } | {
        /**
         * @generated from field: openshell.v1.SessionRejected session_rejected = 2;
         */
        value: SessionRejected;
        case: "sessionRejected";
    } | {
        /**
         * @generated from field: openshell.v1.GatewayHeartbeat heartbeat = 3;
         */
        value: GatewayHeartbeat;
        case: "heartbeat";
    } | {
        /**
         * @generated from field: openshell.v1.RelayOpen relay_open = 4;
         */
        value: RelayOpen;
        case: "relayOpen";
    } | {
        /**
         * @generated from field: openshell.v1.RelayClose relay_close = 5;
         */
        value: RelayClose;
        case: "relayClose";
    } | {
        /**
         * @generated from field: openshell.v1.SessionRedirect session_redirect = 6;
         */
        value: SessionRedirect;
        case: "sessionRedirect";
    } | {
        /**
         * @generated from field: openshell.v1.ConfigUpdate config_update = 7;
         */
        value: ConfigUpdate;
        case: "configUpdate";
    } | {
        case: undefined;
        value?: undefined;
    };
};
/**
 * Describes the message openshell.v1.GatewayMessage.
 * Use `create(GatewayMessageSchema)` to create a new message.
 */
export declare const GatewayMessageSchema: GenMessage<GatewayMessage>;
/**
 * Supervisor identifies itself and the sandbox it manages.
 *
 * @generated from message openshell.v1.SupervisorHello
 */
export type SupervisorHello = Message<"openshell.v1.SupervisorHello"> & {
    /**
     * Sandbox ID this supervisor manages.
     *
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * Supervisor instance ID (e.g. boot id or process epoch).
     *
     * @generated from field: string instance_id = 2;
     */
    instanceId: string;
    /**
     * Monotonic counter scoped to instance_id. Incremented for each reconnect so
     * gateways can distinguish a fresh supervisor connection from stale cleanup.
     *
     * @generated from field: uint64 connection_epoch = 3;
     */
    connectionEpoch: bigint;
    /**
     * The supervisor can report credential, policy, and launch-environment installation.
     *
     * @generated from field: bool supports_provider_readiness = 4;
     */
    supportsProviderReadiness: boolean;
    /**
     * Set when this connection is the result of following a SessionRedirect. The
     * receiving gateway serves a redirected hello locally instead of redirecting
     * again, so a disagreement about membership cannot bounce the supervisor
     * between replicas. A gateway that is shutting down may still redirect it.
     *
     * @generated from field: bool redirected = 5;
     */
    redirected: boolean;
    /**
     * The supervisor understands SessionRedirect. Gateways never redirect a
     * supervisor that does not set this.
     *
     * @generated from field: bool supports_session_redirect = 6;
     */
    supportsSessionRedirect: boolean;
    /**
     * The supervisor can receive its configuration over this stream instead of
     * polling for it: it applies the bootstrap ConfigUpdate and later
     * ConfigUpdate payloads, and answers each with its result and admission.
     * Gateways push configuration only to supervisors that set this.
     *
     * @generated from field: bool supports_config_push = 7;
     */
    supportsConfigPush: boolean;
};
/**
 * Describes the message openshell.v1.SupervisorHello.
 * Use `create(SupervisorHelloSchema)` to create a new message.
 */
export declare const SupervisorHelloSchema: GenMessage<SupervisorHello>;
/**
 * Gateway accepts the supervisor session.
 *
 * @generated from message openshell.v1.SessionAccepted
 */
export type SessionAccepted = Message<"openshell.v1.SessionAccepted"> & {
    /**
     * Gateway-assigned session ID for this connection.
     *
     * @generated from field: string session_id = 1;
     */
    sessionId: string;
    /**
     * The session's first configuration update. Present exactly when
     * config_push_enabled is set.
     *
     * @generated from field: openshell.v1.ConfigUpdate bootstrap = 3;
     */
    bootstrap?: ConfigUpdate | undefined;
    /**
     * The gateway pushes configuration authoritatively on this stream instead
     * of the supervisor polling for it: the bootstrap is required, ConfigUpdate
     * payloads are applied and acknowledged, and the supervisor stops polling.
     * Set only for supervisors that set SupervisorHello.supports_config_push.
     *
     * @generated from field: bool config_push_enabled = 4;
     */
    configPushEnabled: boolean;
    /**
     * Recommended heartbeat interval.
     *
     * @generated from field: google.protobuf.Duration heartbeat_interval = 102;
     */
    heartbeatInterval?: Duration | undefined;
};
/**
 * Describes the message openshell.v1.SessionAccepted.
 * Use `create(SessionAcceptedSchema)` to create a new message.
 */
export declare const SessionAcceptedSchema: GenMessage<SessionAccepted>;
/**
 * Complete gateway-owned configuration for a supervisor session. Each update
 * replaces the previous one. The supervisor applies the two parts together
 * and answers every update with one ConfigUpdateResult before the gateway
 * sends the next.
 *
 * @generated from message openshell.v1.ConfigUpdate
 */
export type ConfigUpdate = Message<"openshell.v1.ConfigUpdate"> & {
    /**
     * Opaque non-empty identifier scoped to the active supervisor session.
     *
     * @generated from field: string update_id = 1;
     */
    updateId: string;
    /**
     * @generated from field: openshell.sandbox.v1.SandboxConfigSnapshot sandbox_config = 2;
     */
    sandboxConfig?: SandboxConfigSnapshot | undefined;
    /**
     * The provider environment the sandbox configuration names through its
     * provider revision, attachment epoch, and policy hash.
     *
     * @generated from field: openshell.v1.ProviderEnvironmentSnapshot provider_environment = 3;
     */
    providerEnvironment?: ProviderEnvironmentSnapshot | undefined;
};
/**
 * Describes the message openshell.v1.ConfigUpdate.
 * Use `create(ConfigUpdateSchema)` to create a new message.
 */
export declare const ConfigUpdateSchema: GenMessage<ConfigUpdate>;
/**
 * Sanitized application failure. Messages must not contain configuration
 * payloads, credentials, or provider values.
 *
 * @generated from message openshell.v1.ConfigApplyFailure
 */
export type ConfigApplyFailure = Message<"openshell.v1.ConfigApplyFailure"> & {
    /**
     * @generated from field: string code = 1;
     */
    code: string;
    /**
     * @generated from field: string message = 2;
     */
    message: string;
    /**
     * @generated from field: bool retryable = 3;
     */
    retryable: boolean;
};
/**
 * Describes the message openshell.v1.ConfigApplyFailure.
 * Use `create(ConfigApplyFailureSchema)` to create a new message.
 */
export declare const ConfigApplyFailureSchema: GenMessage<ConfigApplyFailure>;
/**
 * Application result for one ConfigUpdate, including the bootstrap.
 *
 * @generated from message openshell.v1.ConfigUpdateResult
 */
export type ConfigUpdateResult = Message<"openshell.v1.ConfigUpdateResult"> & {
    /**
     * Echoes ConfigUpdate.update_id for session-local correlation.
     *
     * @generated from field: string update_id = 1;
     */
    updateId: string;
    /**
     * @generated from field: openshell.v1.ConfigApplyOutcome outcome = 2;
     */
    outcome: ConfigApplyOutcome;
    /**
     * Why the update did not take effect. Omitted when it did.
     *
     * @generated from field: openshell.v1.ConfigApplyFailure failure = 3;
     */
    failure?: ConfigApplyFailure | undefined;
    /**
     * Admission state of the delivered sandbox configuration.
     *
     * @generated from field: openshell.v1.SandboxConfigurationAdmission admission = 4;
     */
    admission?: SandboxConfigurationAdmission | undefined;
    /**
     * Load result of the sandbox policy revision the update changed, as a
     * polling supervisor reports it with ReportPolicyStatus. Omitted when the
     * update did not change the sandbox policy.
     *
     * @generated from field: openshell.v1.PolicyLoadResult policy_load = 5;
     */
    policyLoad?: PolicyLoadResult | undefined;
};
/**
 * Describes the message openshell.v1.ConfigUpdateResult.
 * Use `create(ConfigUpdateResultSchema)` to create a new message.
 */
export declare const ConfigUpdateResultSchema: GenMessage<ConfigUpdateResult>;
/**
 * Load result of one sandbox policy revision.
 *
 * @generated from message openshell.v1.PolicyLoadResult
 */
export type PolicyLoadResult = Message<"openshell.v1.PolicyLoadResult"> & {
    /**
     * @generated from field: uint32 version = 1;
     */
    version: number;
    /**
     * @generated from field: bool loaded = 2;
     */
    loaded: boolean;
    /**
     * Sanitized load error. Empty when loaded.
     *
     * @generated from field: string error = 3;
     */
    error: string;
};
/**
 * Describes the message openshell.v1.PolicyLoadResult.
 * Use `create(PolicyLoadResultSchema)` to create a new message.
 */
export declare const PolicyLoadResultSchema: GenMessage<PolicyLoadResult>;
/**
 * Gateway rejects the supervisor session.
 *
 * @generated from message openshell.v1.SessionRejected
 */
export type SessionRejected = Message<"openshell.v1.SessionRejected"> & {
    /**
     * Human-readable rejection reason.
     *
     * @generated from field: string reason = 1;
     */
    reason: string;
};
/**
 * Describes the message openshell.v1.SessionRejected.
 * Use `create(SessionRejectedSchema)` to create a new message.
 */
export declare const SessionRejectedSchema: GenMessage<SessionRejected>;
/**
 * Gateway declines to own this session and names the replica that should.
 *
 * Sent instead of SessionAccepted when the placement ring puts the sandbox on
 * a different live replica, and to established sessions when their gateway
 * shuts down. The supervisor reconnects to peer_endpoint once with
 * SupervisorHello.redirected set, and falls back to its configured gateway
 * address if that fails.
 *
 * @generated from message openshell.v1.SessionRedirect
 */
export type SessionRedirect = Message<"openshell.v1.SessionRedirect"> & {
    /**
     * Peer endpoint of the replica that should own this sandbox.
     *
     * @generated from field: string peer_endpoint = 1;
     */
    peerEndpoint: string;
    /**
     * Replica ID that should own this sandbox, for logging.
     *
     * @generated from field: string owner_replica_id = 2;
     */
    ownerReplicaId: string;
};
/**
 * Describes the message openshell.v1.SessionRedirect.
 * Use `create(SessionRedirectSchema)` to create a new message.
 */
export declare const SessionRedirectSchema: GenMessage<SessionRedirect>;
/**
 * Supervisor heartbeat.
 *
 * @generated from message openshell.v1.SupervisorHeartbeat
 */
export type SupervisorHeartbeat = Message<"openshell.v1.SupervisorHeartbeat"> & {};
/**
 * Describes the message openshell.v1.SupervisorHeartbeat.
 * Use `create(SupervisorHeartbeatSchema)` to create a new message.
 */
export declare const SupervisorHeartbeatSchema: GenMessage<SupervisorHeartbeat>;
/**
 * Gateway heartbeat.
 *
 * @generated from message openshell.v1.GatewayHeartbeat
 */
export type GatewayHeartbeat = Message<"openshell.v1.GatewayHeartbeat"> & {};
/**
 * Describes the message openshell.v1.GatewayHeartbeat.
 * Use `create(GatewayHeartbeatSchema)` to create a new message.
 */
export declare const GatewayHeartbeatSchema: GenMessage<GatewayHeartbeat>;
/**
 * Terminal result reported before the supervisor shuts down. A successful RPC
 * response confirms that the result was durably handled by the gateway.
 *
 * @generated from message openshell.v1.ReportMainProcessExitRequest
 */
export type ReportMainProcessExitRequest = Message<"openshell.v1.ReportMainProcessExitRequest"> & {
    /**
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * @generated from field: string instance_id = 2;
     */
    instanceId: string;
    /**
     * Normalized process result. Signal exits use 128 + signal number.
     *
     * @generated from field: int32 exit_code = 3;
     */
    exitCode: number;
};
/**
 * Describes the message openshell.v1.ReportMainProcessExitRequest.
 * Use `create(ReportMainProcessExitRequestSchema)` to create a new message.
 */
export declare const ReportMainProcessExitRequestSchema: GenMessage<ReportMainProcessExitRequest>;
/**
 * @generated from message openshell.v1.ReportMainProcessExitResponse
 */
export type ReportMainProcessExitResponse = Message<"openshell.v1.ReportMainProcessExitResponse"> & {};
/**
 * Describes the message openshell.v1.ReportMainProcessExitResponse.
 * Use `create(ReportMainProcessExitResponseSchema)` to create a new message.
 */
export declare const ReportMainProcessExitResponseSchema: GenMessage<ReportMainProcessExitResponse>;
/**
 * Terminal-delivery completion reported after all expected foreground SSH
 * attachments close. A successful response permits ephemeral cleanup.
 *
 * @generated from message openshell.v1.FinalizeMainProcessExitRequest
 */
export type FinalizeMainProcessExitRequest = Message<"openshell.v1.FinalizeMainProcessExitRequest"> & {
    /**
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * @generated from field: string instance_id = 2;
     */
    instanceId: string;
};
/**
 * Describes the message openshell.v1.FinalizeMainProcessExitRequest.
 * Use `create(FinalizeMainProcessExitRequestSchema)` to create a new message.
 */
export declare const FinalizeMainProcessExitRequestSchema: GenMessage<FinalizeMainProcessExitRequest>;
/**
 * @generated from message openshell.v1.FinalizeMainProcessExitResponse
 */
export type FinalizeMainProcessExitResponse = Message<"openshell.v1.FinalizeMainProcessExitResponse"> & {};
/**
 * Describes the message openshell.v1.FinalizeMainProcessExitResponse.
 * Use `create(FinalizeMainProcessExitResponseSchema)` to create a new message.
 */
export declare const FinalizeMainProcessExitResponseSchema: GenMessage<FinalizeMainProcessExitResponse>;
/**
 * Gateway requests the supervisor to open a relay channel.
 *
 * On receiving this, the supervisor should initiate a RelayStream RPC to
 * the gateway, sending a RelayInit in the first RelayFrame to associate
 * the new HTTP/2 stream with the pending relay slot. The supervisor
 * bridges that stream to the requested local target.
 *
 * @generated from message openshell.v1.RelayOpen
 */
export type RelayOpen = Message<"openshell.v1.RelayOpen"> & {
    /**
     * Gateway-allocated channel identifier (UUID).
     *
     * @generated from field: string channel_id = 1;
     */
    channelId: string;
    /**
     * Target the supervisor should dial inside the sandbox.
     * If absent, supervisors treat the relay as SSH for compatibility.
     *
     * @generated from oneof openshell.v1.RelayOpen.target
     */
    target: {
        /**
         * @generated from field: openshell.v1.SshRelayTarget ssh = 2;
         */
        value: SshRelayTarget;
        case: "ssh";
    } | {
        /**
         * @generated from field: openshell.v1.TcpRelayTarget tcp = 3;
         */
        value: TcpRelayTarget;
        case: "tcp";
    } | {
        case: undefined;
        value?: undefined;
    };
    /**
     * Optional service identifier for audit/correlation.
     *
     * @generated from field: string service_id = 5;
     */
    serviceId: string;
};
/**
 * Describes the message openshell.v1.RelayOpen.
 * Use `create(RelayOpenSchema)` to create a new message.
 */
export declare const RelayOpenSchema: GenMessage<RelayOpen>;
/**
 * Built-in SSH relay target.
 *
 * @generated from message openshell.v1.SshRelayTarget
 */
export type SshRelayTarget = Message<"openshell.v1.SshRelayTarget"> & {};
/**
 * Describes the message openshell.v1.SshRelayTarget.
 * Use `create(SshRelayTargetSchema)` to create a new message.
 */
export declare const SshRelayTargetSchema: GenMessage<SshRelayTarget>;
/**
 * TCP target dialed by the supervisor from inside the sandbox.
 *
 * @generated from message openshell.v1.TcpRelayTarget
 */
export type TcpRelayTarget = Message<"openshell.v1.TcpRelayTarget"> & {
    /**
     * Phase 1 accepts loopback only: 127.0.0.1, ::1, or localhost.
     *
     * @generated from field: string host = 1;
     */
    host: string;
    /**
     * Target port. Must fit in u16 and be non-zero.
     *
     * @generated from field: uint32 port = 2;
     */
    port: number;
};
/**
 * Describes the message openshell.v1.TcpRelayTarget.
 * Use `create(TcpRelayTargetSchema)` to create a new message.
 */
export declare const TcpRelayTargetSchema: GenMessage<TcpRelayTarget>;
/**
 * Initial RelayStream frame sent by the supervisor to claim a pending relay.
 *
 * @generated from message openshell.v1.RelayInit
 */
export type RelayInit = Message<"openshell.v1.RelayInit"> & {
    /**
     * Gateway-allocated channel identifier (UUID).
     *
     * @generated from field: string channel_id = 1;
     */
    channelId: string;
};
/**
 * Describes the message openshell.v1.RelayInit.
 * Use `create(RelayInitSchema)` to create a new message.
 */
export declare const RelayInitSchema: GenMessage<RelayInit>;
/**
 * A single frame on the RelayStream RPC.
 *
 * The supervisor MUST send `init` as the first frame. All subsequent frames
 * in either direction carry raw bytes in `data`.
 *
 * @generated from message openshell.v1.RelayFrame
 */
export type RelayFrame = Message<"openshell.v1.RelayFrame"> & {
    /**
     * @generated from oneof openshell.v1.RelayFrame.payload
     */
    payload: {
        /**
         * @generated from field: openshell.v1.RelayInit init = 1;
         */
        value: RelayInit;
        case: "init";
    } | {
        /**
         * @generated from field: bytes data = 2;
         */
        value: Uint8Array;
        case: "data";
    } | {
        case: undefined;
        value?: undefined;
    };
};
/**
 * Describes the message openshell.v1.RelayFrame.
 * Use `create(RelayFrameSchema)` to create a new message.
 */
export declare const RelayFrameSchema: GenMessage<RelayFrame>;
/**
 * Initial frame for gateway peer relay forwarding.
 *
 * @generated from message openshell.v1.PeerRelayInit
 */
export type PeerRelayInit = Message<"openshell.v1.PeerRelayInit"> & {
    /**
     * Stable sandbox UUID whose supervisor relay should be opened.
     *
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * Relay target to ask the owning gateway to open on its local supervisor
     * session. The channel_id is assigned by the forwarding gateway.
     *
     * @generated from field: openshell.v1.RelayOpen relay_open = 2;
     */
    relayOpen?: RelayOpen | undefined;
    /**
     * Gateway replica id that initiated the peer relay.
     *
     * @generated from field: string requester_replica_id = 3;
     */
    requesterReplicaId: string;
};
/**
 * Describes the message openshell.v1.PeerRelayInit.
 * Use `create(PeerRelayInitSchema)` to create a new message.
 */
export declare const PeerRelayInitSchema: GenMessage<PeerRelayInit>;
/**
 * A single frame on the gateway-to-gateway peer relay RPC.
 *
 * @generated from message openshell.v1.PeerRelayFrame
 */
export type PeerRelayFrame = Message<"openshell.v1.PeerRelayFrame"> & {
    /**
     * @generated from oneof openshell.v1.PeerRelayFrame.payload
     */
    payload: {
        /**
         * @generated from field: openshell.v1.PeerRelayInit init = 1;
         */
        value: PeerRelayInit;
        case: "init";
    } | {
        /**
         * @generated from field: bytes data = 2;
         */
        value: Uint8Array;
        case: "data";
    } | {
        case: undefined;
        value?: undefined;
    };
};
/**
 * Describes the message openshell.v1.PeerRelayFrame.
 * Use `create(PeerRelayFrameSchema)` to create a new message.
 */
export declare const PeerRelayFrameSchema: GenMessage<PeerRelayFrame>;
/**
 * @generated from message openshell.v1.PeerConfigSandboxTarget
 */
export type PeerConfigSandboxTarget = Message<"openshell.v1.PeerConfigSandboxTarget"> & {
    /**
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * Fences a targeted notification to the session observed by the sending replica.
     *
     * @generated from field: string session_id = 2;
     */
    sessionId: string;
};
/**
 * Describes the message openshell.v1.PeerConfigSandboxTarget.
 * Use `create(PeerConfigSandboxTargetSchema)` to create a new message.
 */
export declare const PeerConfigSandboxTargetSchema: GenMessage<PeerConfigSandboxTarget>;
/**
 * Sandboxes in a workspace that attach the named provider.
 *
 * @generated from message openshell.v1.PeerConfigProviderTarget
 */
export type PeerConfigProviderTarget = Message<"openshell.v1.PeerConfigProviderTarget"> & {
    /**
     * @generated from field: string workspace = 1;
     */
    workspace: string;
    /**
     * @generated from field: string name = 2;
     */
    name: string;
};
/**
 * Describes the message openshell.v1.PeerConfigProviderTarget.
 * Use `create(PeerConfigProviderTargetSchema)` to create a new message.
 */
export declare const PeerConfigProviderTargetSchema: GenMessage<PeerConfigProviderTarget>;
/**
 * @generated from message openshell.v1.PeerNotifyConfigUpdateRequest
 */
export type PeerNotifyConfigUpdateRequest = Message<"openshell.v1.PeerNotifyConfigUpdateRequest"> & {
    /**
     * @generated from oneof openshell.v1.PeerNotifyConfigUpdateRequest.scope
     */
    scope: {
        /**
         * @generated from field: openshell.v1.PeerConfigSandboxTarget sandbox = 1;
         */
        value: PeerConfigSandboxTarget;
        case: "sandbox";
    } | {
        /**
         * @generated from field: string workspace = 2;
         */
        value: string;
        case: "workspace";
    } | {
        /**
         * @generated from field: bool all_connected = 3;
         */
        value: boolean;
        case: "allConnected";
    } | {
        /**
         * @generated from field: openshell.v1.PeerConfigProviderTarget provider = 4;
         */
        value: PeerConfigProviderTarget;
        case: "provider";
    } | {
        case: undefined;
        value?: undefined;
    };
};
/**
 * Describes the message openshell.v1.PeerNotifyConfigUpdateRequest.
 * Use `create(PeerNotifyConfigUpdateRequestSchema)` to create a new message.
 */
export declare const PeerNotifyConfigUpdateRequestSchema: GenMessage<PeerNotifyConfigUpdateRequest>;
/**
 * @generated from message openshell.v1.PeerNotifyConfigUpdateResponse
 */
export type PeerNotifyConfigUpdateResponse = Message<"openshell.v1.PeerNotifyConfigUpdateResponse"> & {
    /**
     * The targeted session moved before the receiving replica accepted the notification.
     *
     * @generated from field: bool stale_owner = 1;
     */
    staleOwner: boolean;
};
/**
 * Describes the message openshell.v1.PeerNotifyConfigUpdateResponse.
 * Use `create(PeerNotifyConfigUpdateResponseSchema)` to create a new message.
 */
export declare const PeerNotifyConfigUpdateResponseSchema: GenMessage<PeerNotifyConfigUpdateResponse>;
/**
 * Supervisor reports the result of a relay open request.
 *
 * @generated from message openshell.v1.RelayOpenResult
 */
export type RelayOpenResult = Message<"openshell.v1.RelayOpenResult"> & {
    /**
     * Channel identifier from the RelayOpen request.
     *
     * @generated from field: string channel_id = 1;
     */
    channelId: string;
    /**
     * True if the relay was successfully established.
     *
     * @generated from field: bool success = 2;
     */
    success: boolean;
    /**
     * Error message if success is false.
     *
     * @generated from field: string error = 3;
     */
    error: string;
};
/**
 * Describes the message openshell.v1.RelayOpenResult.
 * Use `create(RelayOpenResultSchema)` to create a new message.
 */
export declare const RelayOpenResultSchema: GenMessage<RelayOpenResult>;
/**
 * Either side requests closure of a relay channel.
 *
 * @generated from message openshell.v1.RelayClose
 */
export type RelayClose = Message<"openshell.v1.RelayClose"> & {
    /**
     * Channel identifier to close.
     *
     * @generated from field: string channel_id = 1;
     */
    channelId: string;
    /**
     * Optional reason for closure.
     *
     * @generated from field: string reason = 2;
     */
    reason: string;
};
/**
 * Describes the message openshell.v1.RelayClose.
 * Use `create(RelayCloseSchema)` to create a new message.
 */
export declare const RelayCloseSchema: GenMessage<RelayClose>;
/**
 * Observed HTTP method+path pattern from L7 inspection.
 *
 * @generated from message openshell.v1.L7RequestSample
 */
export type L7RequestSample = Message<"openshell.v1.L7RequestSample"> & {
    /**
     * HTTP method: GET, POST, PUT, DELETE, etc.
     *
     * @generated from field: string method = 1;
     */
    method: string;
    /**
     * HTTP path: /v1/models, /repos/myorg/issues
     *
     * @generated from field: string path = 2;
     */
    path: string;
    /**
     * L7 decision: "audit" or "deny" (allowed requests not collected).
     *
     * @generated from field: string decision = 3;
     */
    decision: string;
    /**
     * Number of times this (method, path) was observed.
     *
     * @generated from field: uint32 count = 4;
     */
    count: number;
};
/**
 * Describes the message openshell.v1.L7RequestSample.
 * Use `create(L7RequestSampleSchema)` to create a new message.
 */
export declare const L7RequestSampleSchema: GenMessage<L7RequestSample>;
/**
 * Structured denial summary from sandbox aggregator.
 *
 * @generated from message openshell.v1.DenialSummary
 */
export type DenialSummary = Message<"openshell.v1.DenialSummary"> & {
    /**
     * Sandbox ID that produced this summary.
     *
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * Denied destination host.
     *
     * @generated from field: string host = 2;
     */
    host: string;
    /**
     * Denied destination port.
     *
     * @generated from field: uint32 port = 3;
     */
    port: number;
    /**
     * Binary that attempted the connection.
     *
     * @generated from field: string binary = 4;
     */
    binary: string;
    /**
     * Process ancestor chain.
     *
     * @generated from field: repeated string ancestors = 5;
     */
    ancestors: string[];
    /**
     * Denial reason from OPA evaluation.
     *
     * @generated from field: string deny_reason = 6;
     */
    denyReason: string;
    /**
     * Time of the first denial.
     *
     * @generated from field: google.protobuf.Timestamp first_seen_time = 107;
     */
    firstSeenTime?: Timestamp | undefined;
    /**
     * Time of the most recent denial.
     *
     * @generated from field: google.protobuf.Timestamp last_seen_time = 108;
     */
    lastSeenTime?: Timestamp | undefined;
    /**
     * Number of denials in the current window.
     *
     * @generated from field: uint32 count = 9;
     */
    count: number;
    /**
     * Events dropped during aggregator cooldown.
     *
     * @generated from field: uint32 suppressed_count = 10;
     */
    suppressedCount: number;
    /**
     * Cumulative lifetime count (never resets).
     *
     * @generated from field: uint32 total_count = 11;
     */
    totalCount: number;
    /**
     * Distinct cmdline strings observed (sanitized of credentials).
     *
     * @generated from field: repeated string sample_cmdlines = 12;
     */
    sampleCmdlines: string[];
    /**
     * SHA-256 of the binary for audit trail.
     *
     * @generated from field: string binary_sha256 = 13;
     */
    binarySha256: string;
    /**
     * True if emitted by stale-flush rather than threshold.
     *
     * @generated from field: bool persistent = 14;
     */
    persistent: boolean;
    /**
     * Denial category: "l4_deny", "l7_deny", "l7_audit", "ssrf".
     *
     * @generated from field: string denial_stage = 15;
     */
    denialStage: string;
    /**
     * Observed HTTP request patterns (from L7 inspection).
     *
     * @generated from field: repeated openshell.v1.L7RequestSample l7_request_samples = 16;
     */
    l7RequestSamples: L7RequestSample[];
    /**
     * True if L7 inspection was active during observation window.
     *
     * @generated from field: bool l7_inspection_active = 17;
     */
    l7InspectionActive: boolean;
};
/**
 * Describes the message openshell.v1.DenialSummary.
 * Use `create(DenialSummarySchema)` to create a new message.
 */
export declare const DenialSummarySchema: GenMessage<DenialSummary>;
/**
 * Count of denied actions grouped only by sanitized telemetry category.
 *
 * @generated from message openshell.v1.DenialGroupCount
 */
export type DenialGroupCount = Message<"openshell.v1.DenialGroupCount"> & {
    /**
     * Sanitized denial category, e.g. "connect_policy", "l7_policy", "ssrf".
     *
     * @generated from field: string deny_group = 1;
     */
    denyGroup: string;
    /**
     * Number of denied actions in this category.
     *
     * @generated from field: uint32 denied_count = 2;
     */
    deniedCount: number;
};
/**
 * Describes the message openshell.v1.DenialGroupCount.
 * Use `create(DenialGroupCountSchema)` to create a new message.
 */
export declare const DenialGroupCountSchema: GenMessage<DenialGroupCount>;
/**
 * Anonymous sandbox network activity counters. This intentionally excludes
 * hosts, paths, binaries, raw deny reasons, sandbox IDs, and user content.
 *
 * @generated from message openshell.v1.NetworkActivitySummary
 */
export type NetworkActivitySummary = Message<"openshell.v1.NetworkActivitySummary"> & {
    /**
     * Total observed network activities in the current window.
     *
     * @generated from field: uint32 network_activity_count = 1;
     */
    networkActivityCount: number;
    /**
     * Total denied actions in the current window.
     *
     * @generated from field: uint32 denied_action_count = 2;
     */
    deniedActionCount: number;
    /**
     * Denied action counts grouped by sanitized category.
     *
     * @generated from field: repeated openshell.v1.DenialGroupCount denials_by_group = 3;
     */
    denialsByGroup: DenialGroupCount[];
};
/**
 * Describes the message openshell.v1.NetworkActivitySummary.
 * Use `create(NetworkActivitySummarySchema)` to create a new message.
 */
export declare const NetworkActivitySummarySchema: GenMessage<NetworkActivitySummary>;
/**
 * A proposed policy rule with rationale and approval status.
 *
 * @generated from message openshell.v1.PolicyChunk
 */
export type PolicyChunk = Message<"openshell.v1.PolicyChunk"> & {
    /**
     * Unique chunk identifier.
     *
     * @generated from field: string id = 1;
     */
    id: string;
    /**
     * Approval status: "pending", "approved", "rejected".
     *
     * @generated from field: string status = 2;
     */
    status: string;
    /**
     * Proposed network_policies map key.
     *
     * @generated from field: string rule_name = 3;
     */
    ruleName: string;
    /**
     * The proposed network policy rule.
     *
     * @generated from field: openshell.sandbox.v1.NetworkPolicyRule proposed_rule = 4;
     */
    proposedRule?: NetworkPolicyRule | undefined;
    /**
     * Human-readable explanation of why this rule is proposed.
     *
     * @generated from field: string rationale = 5;
     */
    rationale: string;
    /**
     * Security concerns flagged by analysis (empty if none).
     *
     * @generated from field: string security_notes = 6;
     */
    securityNotes: string;
    /**
     * Analysis confidence (0.0-1.0). 0 for mechanistic mode.
     *
     * @generated from field: float confidence = 7;
     */
    confidence: number;
    /**
     * IDs of denial summaries that led to this chunk.
     *
     * @generated from field: repeated string denial_summary_ids = 8;
     */
    denialSummaryIds: string[];
    /**
     * Time when this chunk was created.
     *
     * @generated from field: google.protobuf.Timestamp created_time = 109;
     */
    createdTime?: Timestamp | undefined;
    /**
     * Time when the user approved or rejected the chunk. Absent if undecided.
     *
     * @generated from field: google.protobuf.Timestamp decided_time = 110;
     */
    decidedTime?: Timestamp | undefined;
    /**
     * Recommendation stage: "initial" or "refined" (progressive L7 visibility).
     *
     * @generated from field: string stage = 11;
     */
    stage: string;
    /**
     * For stage="refined": the initial chunk this replaces.
     *
     * @generated from field: string supersedes_chunk_id = 12;
     */
    supersedesChunkId: string;
    /**
     * How many times this endpoint has been seen across denial flush cycles.
     *
     * @generated from field: int32 hit_count = 13;
     */
    hitCount: number;
    /**
     * First time this endpoint was proposed.
     *
     * @generated from field: google.protobuf.Timestamp first_seen_time = 114;
     */
    firstSeenTime?: Timestamp | undefined;
    /**
     * Most recent time this endpoint was proposed again.
     *
     * @generated from field: google.protobuf.Timestamp last_seen_time = 115;
     */
    lastSeenTime?: Timestamp | undefined;
    /**
     * Binary path that triggered the denial (denormalized for display convenience).
     *
     * @generated from field: string binary = 16;
     */
    binary: string;
    /**
     * Validation verdict from gateway-side static checks (prover output).
     * Free-form summary string for human consumption in the inbox card.
     * Empty until the prover has run for this chunk.
     *
     * @generated from field: string validation_result = 17;
     */
    validationResult: string;
    /**
     * Operator-supplied free-form text accompanying a rejection. Populated
     * when the reviewer rejects via `RejectDraftChunkRequest.reason`; surfaced
     * back to the in-sandbox agent so it can revise the proposal.
     * Empty for non-rejected chunks.
     *
     * @generated from field: string rejection_reason = 18;
     */
    rejectionReason: string;
    /**
     * Gateway-side merge/application preflight failure. Kept separate from
     * prover output and operator rejection so clients can explain why a
     * prover-clean proposal is not currently applicable.
     *
     * @generated from field: string application_error = 19;
     */
    applicationError: string;
    /**
     * Opaque digest binding review to the exact live inputs and complete
     * effective candidate evaluated by the gateway.
     *
     * @generated from field: string review_token = 20;
     */
    reviewToken: string;
    /**
     * Deterministic hashes for compact candidate display and diagnostics.
     *
     * @generated from field: string current_effective_policy_hash = 21;
     */
    currentEffectivePolicyHash: string;
    /**
     * @generated from field: string candidate_effective_policy_hash = 22;
     */
    candidateEffectivePolicyHash: string;
    /**
     * Complete effective policies used for review. These contain policy
     * configuration only; credential secret values are never materialized.
     *
     * @generated from field: openshell.sandbox.v1.SandboxPolicy current_effective_policy = 23;
     */
    currentEffectivePolicy?: SandboxPolicy | undefined;
    /**
     * @generated from field: openshell.sandbox.v1.SandboxPolicy candidate_effective_policy = 24;
     */
    candidateEffectivePolicy?: SandboxPolicy | undefined;
};
/**
 * Describes the message openshell.v1.PolicyChunk.
 * Use `create(PolicyChunkSchema)` to create a new message.
 */
export declare const PolicyChunkSchema: GenMessage<PolicyChunk>;
/**
 * Notification that the draft policy was updated.
 *
 * @generated from message openshell.v1.DraftPolicyUpdate
 */
export type DraftPolicyUpdate = Message<"openshell.v1.DraftPolicyUpdate"> & {
    /**
     * Current draft version.
     *
     * @generated from field: uint64 draft_version = 1;
     */
    draftVersion: bigint;
    /**
     * Number of new chunks added in this update.
     *
     * @generated from field: uint32 new_chunks = 2;
     */
    newChunks: number;
    /**
     * Total pending chunks awaiting approval.
     *
     * @generated from field: uint32 total_pending = 3;
     */
    totalPending: number;
    /**
     * Brief description of what changed.
     *
     * @generated from field: string summary = 4;
     */
    summary: string;
};
/**
 * Describes the message openshell.v1.DraftPolicyUpdate.
 * Use `create(DraftPolicyUpdateSchema)` to create a new message.
 */
export declare const DraftPolicyUpdateSchema: GenMessage<DraftPolicyUpdate>;
/**
 * Submit analysis results from sandbox to gateway.
 *
 * @generated from message openshell.v1.SubmitPolicyAnalysisRequest
 */
export type SubmitPolicyAnalysisRequest = Message<"openshell.v1.SubmitPolicyAnalysisRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 6;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Aggregated denial summaries.
     *
     * @generated from field: repeated openshell.v1.DenialSummary summaries = 1;
     */
    summaries: DenialSummary[];
    /**
     * Proposed policy chunks (validated by sandbox OPA engine).
     *
     * @generated from field: repeated openshell.v1.PolicyChunk proposed_chunks = 2;
     */
    proposedChunks: PolicyChunk[];
    /**
     * Analysis mode. `mechanistic` is the observation-driven path from the
     * denial aggregator — chunks targeting the same host|port|binary fold
     * into one row with hit_count incremented. `agent_authored` is an
     * intentional proposal from an in-sandbox agent — each submission lands
     * as its own chunk so the redraft-after-rejection loop has a stable id
     * to watch. Other values are treated as agent-style (no dedup) so a new
     * mode does not silently collapse proposals.
     *
     * @generated from field: string analysis_mode = 3;
     */
    analysisMode: string;
    /**
     * Sandbox name. The authenticated sandbox principal remains authoritative
     * for this internal callback.
     *
     * @generated from field: string name = 4;
     */
    name: string;
    /**
     * Anonymous network activity counters.
     *
     * @generated from field: repeated openshell.v1.NetworkActivitySummary network_activity_summaries = 5;
     */
    networkActivitySummaries: NetworkActivitySummary[];
};
/**
 * Describes the message openshell.v1.SubmitPolicyAnalysisRequest.
 * Use `create(SubmitPolicyAnalysisRequestSchema)` to create a new message.
 */
export declare const SubmitPolicyAnalysisRequestSchema: GenMessage<SubmitPolicyAnalysisRequest>;
/**
 * @generated from message openshell.v1.SubmitPolicyAnalysisResponse
 */
export type SubmitPolicyAnalysisResponse = Message<"openshell.v1.SubmitPolicyAnalysisResponse"> & {
    /**
     * Number of chunks accepted by the gateway.
     *
     * @generated from field: uint32 accepted_chunks = 1;
     */
    acceptedChunks: number;
    /**
     * Number of chunks rejected by gateway validation.
     *
     * @generated from field: uint32 rejected_chunks = 2;
     */
    rejectedChunks: number;
    /**
     * Reasons for each rejected chunk.
     *
     * @generated from field: repeated string rejection_reasons = 3;
     */
    rejectionReasons: string[];
    /**
     * Server-assigned chunk IDs for the accepted chunks, in submission order.
     * Agents use these to watch proposal state via policy.local's
     * GET /v1/proposals/{id} and /wait endpoints.
     *
     * @generated from field: repeated string accepted_chunk_ids = 4;
     */
    acceptedChunkIds: string[];
};
/**
 * Describes the message openshell.v1.SubmitPolicyAnalysisResponse.
 * Use `create(SubmitPolicyAnalysisResponseSchema)` to create a new message.
 */
export declare const SubmitPolicyAnalysisResponseSchema: GenMessage<SubmitPolicyAnalysisResponse>;
/**
 * Get draft policy for a sandbox.
 *
 * @generated from message openshell.v1.GetDraftPolicyRequest
 */
export type GetDraftPolicyRequest = Message<"openshell.v1.GetDraftPolicyRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Optional status filter: "pending", "approved", "rejected", or "" for all.
     *
     * @generated from field: string status_filter = 2;
     */
    statusFilter: string;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
};
/**
 * Describes the message openshell.v1.GetDraftPolicyRequest.
 * Use `create(GetDraftPolicyRequestSchema)` to create a new message.
 */
export declare const GetDraftPolicyRequestSchema: GenMessage<GetDraftPolicyRequest>;
/**
 * @generated from message openshell.v1.GetDraftPolicyResponse
 */
export type GetDraftPolicyResponse = Message<"openshell.v1.GetDraftPolicyResponse"> & {
    /**
     * Draft policy chunks.
     *
     * @generated from field: repeated openshell.v1.PolicyChunk chunks = 1;
     */
    chunks: PolicyChunk[];
    /**
     * LLM-generated summary of all analysis (empty in mechanistic mode).
     *
     * @generated from field: string rolling_summary = 2;
     */
    rollingSummary: string;
    /**
     * Current draft version.
     *
     * @generated from field: uint64 draft_version = 3;
     */
    draftVersion: bigint;
    /**
     * Time when the last analysis completed.
     *
     * @generated from field: google.protobuf.Timestamp last_analyzed_time = 104;
     */
    lastAnalyzedTime?: Timestamp | undefined;
};
/**
 * Describes the message openshell.v1.GetDraftPolicyResponse.
 * Use `create(GetDraftPolicyResponseSchema)` to create a new message.
 */
export declare const GetDraftPolicyResponseSchema: GenMessage<GetDraftPolicyResponse>;
/**
 * Approve a single draft chunk.
 *
 * @generated from message openshell.v1.ApproveDraftChunkRequest
 */
export type ApproveDraftChunkRequest = Message<"openshell.v1.ApproveDraftChunkRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Chunk ID to approve.
     *
     * @generated from field: string chunk_id = 2;
     */
    chunkId: string;
    /**
     * Token returned with the reviewed PolicyChunk. Approval fails with
     * FAILED_PRECONDITION if live decision inputs no longer match it.
     *
     * @generated from field: string review_token = 4;
     */
    reviewToken: string;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 5;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.ApproveDraftChunkRequest.
 * Use `create(ApproveDraftChunkRequestSchema)` to create a new message.
 */
export declare const ApproveDraftChunkRequestSchema: GenMessage<ApproveDraftChunkRequest>;
/**
 * @generated from message openshell.v1.ApproveDraftChunkResponse
 */
export type ApproveDraftChunkResponse = Message<"openshell.v1.ApproveDraftChunkResponse"> & {
    /**
     * New policy version after merge.
     *
     * @generated from field: uint32 policy_version = 1;
     */
    policyVersion: number;
    /**
     * SHA-256 hash of the new policy.
     *
     * @generated from field: string policy_hash = 2;
     */
    policyHash: string;
};
/**
 * Describes the message openshell.v1.ApproveDraftChunkResponse.
 * Use `create(ApproveDraftChunkResponseSchema)` to create a new message.
 */
export declare const ApproveDraftChunkResponseSchema: GenMessage<ApproveDraftChunkResponse>;
/**
 * Reject a single draft chunk.
 *
 * @generated from message openshell.v1.RejectDraftChunkRequest
 */
export type RejectDraftChunkRequest = Message<"openshell.v1.RejectDraftChunkRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 4;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Chunk ID to reject.
     *
     * @generated from field: string chunk_id = 2;
     */
    chunkId: string;
    /**
     * Optional reason for rejection (fed to LLM context in future analysis).
     *
     * @generated from field: string reason = 3;
     */
    reason: string;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 5;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.RejectDraftChunkRequest.
 * Use `create(RejectDraftChunkRequestSchema)` to create a new message.
 */
export declare const RejectDraftChunkRequestSchema: GenMessage<RejectDraftChunkRequest>;
/**
 * @generated from message openshell.v1.RejectDraftChunkResponse
 */
export type RejectDraftChunkResponse = Message<"openshell.v1.RejectDraftChunkResponse"> & {};
/**
 * Describes the message openshell.v1.RejectDraftChunkResponse.
 * Use `create(RejectDraftChunkResponseSchema)` to create a new message.
 */
export declare const RejectDraftChunkResponseSchema: GenMessage<RejectDraftChunkResponse>;
/**
 * Approve all pending chunks.
 *
 * @generated from message openshell.v1.DraftChunkApproval
 */
export type DraftChunkApproval = Message<"openshell.v1.DraftChunkApproval"> & {
    /**
     * @generated from field: string chunk_id = 1;
     */
    chunkId: string;
    /**
     * @generated from field: string review_token = 2;
     */
    reviewToken: string;
};
/**
 * Describes the message openshell.v1.DraftChunkApproval.
 * Use `create(DraftChunkApprovalSchema)` to create a new message.
 */
export declare const DraftChunkApprovalSchema: GenMessage<DraftChunkApproval>;
/**
 * @generated from message openshell.v1.ApproveAllDraftChunksRequest
 */
export type ApproveAllDraftChunksRequest = Message<"openshell.v1.ApproveAllDraftChunksRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 4;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Include chunks with security_notes (default false: skips them).
     *
     * @generated from field: bool include_security_flagged = 2;
     */
    includeSecurityFlagged: boolean;
    /**
     * Exact reviewed chunks and tokens. The server validates them against one
     * live snapshot, stages compatible operations in order, and writes once.
     *
     * @generated from field: repeated openshell.v1.DraftChunkApproval approvals = 3;
     */
    approvals: DraftChunkApproval[];
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 5;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.ApproveAllDraftChunksRequest.
 * Use `create(ApproveAllDraftChunksRequestSchema)` to create a new message.
 */
export declare const ApproveAllDraftChunksRequestSchema: GenMessage<ApproveAllDraftChunksRequest>;
/**
 * @generated from message openshell.v1.ApproveAllDraftChunksResponse
 */
export type ApproveAllDraftChunksResponse = Message<"openshell.v1.ApproveAllDraftChunksResponse"> & {
    /**
     * New policy version after merge.
     *
     * @generated from field: uint32 policy_version = 1;
     */
    policyVersion: number;
    /**
     * SHA-256 hash of the new policy.
     *
     * @generated from field: string policy_hash = 2;
     */
    policyHash: string;
    /**
     * Number of chunks approved.
     *
     * @generated from field: uint32 chunks_approved = 3;
     */
    chunksApproved: number;
    /**
     * Number of chunks skipped for any reason, including security flags,
     * stale or invalid candidates, and conflicts within the staged batch.
     *
     * @generated from field: uint32 chunks_skipped = 4;
     */
    chunksSkipped: number;
};
/**
 * Describes the message openshell.v1.ApproveAllDraftChunksResponse.
 * Use `create(ApproveAllDraftChunksResponseSchema)` to create a new message.
 */
export declare const ApproveAllDraftChunksResponseSchema: GenMessage<ApproveAllDraftChunksResponse>;
/**
 * Edit a pending chunk in-place.
 *
 * @generated from message openshell.v1.EditDraftChunkRequest
 */
export type EditDraftChunkRequest = Message<"openshell.v1.EditDraftChunkRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 4;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Chunk ID to edit.
     *
     * @generated from field: string chunk_id = 2;
     */
    chunkId: string;
    /**
     * The modified rule (replaces existing proposed_rule).
     *
     * @generated from field: openshell.sandbox.v1.NetworkPolicyRule proposed_rule = 3;
     */
    proposedRule?: NetworkPolicyRule | undefined;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 5;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.EditDraftChunkRequest.
 * Use `create(EditDraftChunkRequestSchema)` to create a new message.
 */
export declare const EditDraftChunkRequestSchema: GenMessage<EditDraftChunkRequest>;
/**
 * @generated from message openshell.v1.EditDraftChunkResponse
 */
export type EditDraftChunkResponse = Message<"openshell.v1.EditDraftChunkResponse"> & {};
/**
 * Describes the message openshell.v1.EditDraftChunkResponse.
 * Use `create(EditDraftChunkResponseSchema)` to create a new message.
 */
export declare const EditDraftChunkResponseSchema: GenMessage<EditDraftChunkResponse>;
/**
 * Reverse an approval (remove merged rule from active policy).
 *
 * @generated from message openshell.v1.UndoDraftChunkRequest
 */
export type UndoDraftChunkRequest = Message<"openshell.v1.UndoDraftChunkRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * Chunk ID to undo.
     *
     * @generated from field: string chunk_id = 2;
     */
    chunkId: string;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 4;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.UndoDraftChunkRequest.
 * Use `create(UndoDraftChunkRequestSchema)` to create a new message.
 */
export declare const UndoDraftChunkRequestSchema: GenMessage<UndoDraftChunkRequest>;
/**
 * @generated from message openshell.v1.UndoDraftChunkResponse
 */
export type UndoDraftChunkResponse = Message<"openshell.v1.UndoDraftChunkResponse"> & {
    /**
     * New policy version after removal.
     *
     * @generated from field: uint32 policy_version = 1;
     */
    policyVersion: number;
    /**
     * SHA-256 hash of the updated policy.
     *
     * @generated from field: string policy_hash = 2;
     */
    policyHash: string;
};
/**
 * Describes the message openshell.v1.UndoDraftChunkResponse.
 * Use `create(UndoDraftChunkResponseSchema)` to create a new message.
 */
export declare const UndoDraftChunkResponseSchema: GenMessage<UndoDraftChunkResponse>;
/**
 * Clear all pending draft chunks for a sandbox.
 *
 * @generated from message openshell.v1.ClearDraftChunksRequest
 */
export type ClearDraftChunksRequest = Message<"openshell.v1.ClearDraftChunksRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
    /**
     * Optional nonzero UUID for durable at-most-once admission. Successful results
     * can be replayed for 24 hours; see the API errors and retries reference.
     *
     * @generated from field: string request_id = 3;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.ClearDraftChunksRequest.
 * Use `create(ClearDraftChunksRequestSchema)` to create a new message.
 */
export declare const ClearDraftChunksRequestSchema: GenMessage<ClearDraftChunksRequest>;
/**
 * @generated from message openshell.v1.ClearDraftChunksResponse
 */
export type ClearDraftChunksResponse = Message<"openshell.v1.ClearDraftChunksResponse"> & {
    /**
     * Number of chunks cleared.
     *
     * @generated from field: uint32 chunks_cleared = 1;
     */
    chunksCleared: number;
};
/**
 * Describes the message openshell.v1.ClearDraftChunksResponse.
 * Use `create(ClearDraftChunksResponseSchema)` to create a new message.
 */
export declare const ClearDraftChunksResponseSchema: GenMessage<ClearDraftChunksResponse>;
/**
 * Get decision history for a sandbox's draft policy.
 *
 * @generated from message openshell.v1.GetDraftHistoryRequest
 */
export type GetDraftHistoryRequest = Message<"openshell.v1.GetDraftHistoryRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 2;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string sandbox = 1;
     */
    sandbox: string;
};
/**
 * Describes the message openshell.v1.GetDraftHistoryRequest.
 * Use `create(GetDraftHistoryRequestSchema)` to create a new message.
 */
export declare const GetDraftHistoryRequestSchema: GenMessage<GetDraftHistoryRequest>;
/**
 * @generated from message openshell.v1.DraftHistoryEntry
 */
export type DraftHistoryEntry = Message<"openshell.v1.DraftHistoryEntry"> & {
    /**
     * Time when the event occurred.
     *
     * @generated from field: google.protobuf.Timestamp event_time = 101;
     */
    eventTime?: Timestamp | undefined;
    /**
     * Event type: "denial_detected", "analysis_cycle", "approved",
     * "rejected", "edited", "undone", "cleared".
     *
     * @generated from field: string event_type = 2;
     */
    eventType: string;
    /**
     * Human-readable description.
     *
     * @generated from field: string description = 3;
     */
    description: string;
    /**
     * Associated chunk ID (if applicable).
     *
     * @generated from field: string chunk_id = 4;
     */
    chunkId: string;
};
/**
 * Describes the message openshell.v1.DraftHistoryEntry.
 * Use `create(DraftHistoryEntrySchema)` to create a new message.
 */
export declare const DraftHistoryEntrySchema: GenMessage<DraftHistoryEntry>;
/**
 * @generated from message openshell.v1.GetDraftHistoryResponse
 */
export type GetDraftHistoryResponse = Message<"openshell.v1.GetDraftHistoryResponse"> & {
    /**
     * Chronological decision history.
     *
     * @generated from field: repeated openshell.v1.DraftHistoryEntry entries = 1;
     */
    entries: DraftHistoryEntry[];
};
/**
 * Describes the message openshell.v1.GetDraftHistoryResponse.
 * Use `create(GetDraftHistoryResponseSchema)` to create a new message.
 */
export declare const GetDraftHistoryResponseSchema: GenMessage<GetDraftHistoryResponse>;
/**
 * Create workspace request.
 *
 * @generated from message openshell.v1.CreateWorkspaceRequest
 */
export type CreateWorkspaceRequest = Message<"openshell.v1.CreateWorkspaceRequest"> & {
    /**
     * Workspace name. Must be a valid DNS-1123 label.
     *
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * Optional labels for the workspace (key-value metadata).
     *
     * @generated from field: map<string, string> labels = 2;
     */
    labels: {
        [key: string]: string;
    };
    /**
     * Optional nonzero UUID. Same ID and payload replay success for 24 hours.
     *
     * @generated from field: string request_id = 3;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.CreateWorkspaceRequest.
 * Use `create(CreateWorkspaceRequestSchema)` to create a new message.
 */
export declare const CreateWorkspaceRequestSchema: GenMessage<CreateWorkspaceRequest>;
/**
 * Create workspace response.
 *
 * @generated from message openshell.v1.CreateWorkspaceResponse
 */
export type CreateWorkspaceResponse = Message<"openshell.v1.CreateWorkspaceResponse"> & {
    /**
     * @generated from field: openshell.datamodel.v1.Workspace workspace = 1;
     */
    workspace?: Workspace | undefined;
};
/**
 * Describes the message openshell.v1.CreateWorkspaceResponse.
 * Use `create(CreateWorkspaceResponseSchema)` to create a new message.
 */
export declare const CreateWorkspaceResponseSchema: GenMessage<CreateWorkspaceResponse>;
/**
 * Get workspace request.
 *
 * @generated from message openshell.v1.GetWorkspaceRequest
 */
export type GetWorkspaceRequest = Message<"openshell.v1.GetWorkspaceRequest"> & {
    /**
     * Workspace name (canonical lookup key).
     *
     * @generated from field: string name = 1;
     */
    name: string;
};
/**
 * Describes the message openshell.v1.GetWorkspaceRequest.
 * Use `create(GetWorkspaceRequestSchema)` to create a new message.
 */
export declare const GetWorkspaceRequestSchema: GenMessage<GetWorkspaceRequest>;
/**
 * Get workspace response.
 *
 * @generated from message openshell.v1.GetWorkspaceResponse
 */
export type GetWorkspaceResponse = Message<"openshell.v1.GetWorkspaceResponse"> & {
    /**
     * @generated from field: openshell.datamodel.v1.Workspace workspace = 1;
     */
    workspace?: Workspace | undefined;
};
/**
 * Describes the message openshell.v1.GetWorkspaceResponse.
 * Use `create(GetWorkspaceResponseSchema)` to create a new message.
 */
export declare const GetWorkspaceResponseSchema: GenMessage<GetWorkspaceResponse>;
/**
 * List workspaces request.
 *
 * @generated from message openshell.v1.ListWorkspacesRequest
 */
export type ListWorkspacesRequest = Message<"openshell.v1.ListWorkspacesRequest"> & {
    /**
     * The maximum number of workspaces to return. Zero uses 100. Values above
     * 1000 are coerced to 1000; negative values are invalid.
     *
     * @generated from field: int32 page_size = 1;
     */
    pageSize: number;
    /**
     * Token from a previous ListWorkspaces response. All other request parameters
     * except page_size must match the request that produced it.
     *
     * @generated from field: string page_token = 2;
     */
    pageToken: string;
    /**
     * Optional label selector for filtering (format: "key1=value1,key2=value2").
     *
     * @generated from field: string label_selector = 3;
     */
    labelSelector: string;
};
/**
 * Describes the message openshell.v1.ListWorkspacesRequest.
 * Use `create(ListWorkspacesRequestSchema)` to create a new message.
 */
export declare const ListWorkspacesRequestSchema: GenMessage<ListWorkspacesRequest>;
/**
 * List workspaces response.
 *
 * @generated from message openshell.v1.ListWorkspacesResponse
 */
export type ListWorkspacesResponse = Message<"openshell.v1.ListWorkspacesResponse"> & {
    /**
     * @generated from field: repeated openshell.datamodel.v1.Workspace workspaces = 1;
     */
    workspaces: Workspace[];
    /**
     * Token for the next page. Empty when there are no subsequent pages.
     *
     * @generated from field: string next_page_token = 2;
     */
    nextPageToken: string;
};
/**
 * Describes the message openshell.v1.ListWorkspacesResponse.
 * Use `create(ListWorkspacesResponseSchema)` to create a new message.
 */
export declare const ListWorkspacesResponseSchema: GenMessage<ListWorkspacesResponse>;
/**
 * Delete workspace request.
 *
 * @generated from message openshell.v1.DeleteWorkspaceRequest
 */
export type DeleteWorkspaceRequest = Message<"openshell.v1.DeleteWorkspaceRequest"> & {
    /**
     * Workspace name (canonical lookup key).
     *
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * @generated from field: bool allow_missing = 2;
     */
    allowMissing: boolean;
    /**
     * Optional nonzero UUID. Same ID and payload replay success for 24 hours.
     *
     * @generated from field: string request_id = 3;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.DeleteWorkspaceRequest.
 * Use `create(DeleteWorkspaceRequestSchema)` to create a new message.
 */
export declare const DeleteWorkspaceRequestSchema: GenMessage<DeleteWorkspaceRequest>;
/**
 * Delete workspace response.
 *
 * @generated from message openshell.v1.DeleteWorkspaceResponse
 */
export type DeleteWorkspaceResponse = Message<"openshell.v1.DeleteWorkspaceResponse"> & {
    /**
     * @generated from field: openshell.v1.DeletionOutcome outcome = 2;
     */
    outcome: DeletionOutcome;
};
/**
 * Describes the message openshell.v1.DeleteWorkspaceResponse.
 * Use `create(DeleteWorkspaceResponseSchema)` to create a new message.
 */
export declare const DeleteWorkspaceResponseSchema: GenMessage<DeleteWorkspaceResponse>;
/**
 * Workspace membership record.
 *
 * @generated from message openshell.v1.WorkspaceMember
 */
export type WorkspaceMember = Message<"openshell.v1.WorkspaceMember"> & {
    /**
     * @generated from field: openshell.datamodel.v1.ObjectMeta metadata = 1;
     */
    metadata?: ObjectMeta | undefined;
    /**
     * OIDC subject claim identifying the principal.
     *
     * @generated from field: string principal_subject = 2;
     */
    principalSubject: string;
    /**
     * Role assigned to the principal within the workspace.
     *
     * @generated from field: openshell.v1.WorkspaceRole role = 3;
     */
    role: WorkspaceRole;
};
/**
 * Describes the message openshell.v1.WorkspaceMember.
 * Use `create(WorkspaceMemberSchema)` to create a new message.
 */
export declare const WorkspaceMemberSchema: GenMessage<WorkspaceMember>;
/**
 * Add workspace member request.
 *
 * @generated from message openshell.v1.AddWorkspaceMemberRequest
 */
export type AddWorkspaceMemberRequest = Message<"openshell.v1.AddWorkspaceMemberRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 1;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * OIDC subject claim identifying the principal.
     *
     * @generated from field: string principal_subject = 2;
     */
    principalSubject: string;
    /**
     * Role to assign.
     *
     * @generated from field: openshell.v1.WorkspaceRole role = 3;
     */
    role: WorkspaceRole;
    /**
     * Optional nonzero UUID. Same ID and payload replay success for 24 hours.
     *
     * @generated from field: string request_id = 4;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.AddWorkspaceMemberRequest.
 * Use `create(AddWorkspaceMemberRequestSchema)` to create a new message.
 */
export declare const AddWorkspaceMemberRequestSchema: GenMessage<AddWorkspaceMemberRequest>;
/**
 * Add workspace member response.
 *
 * @generated from message openshell.v1.AddWorkspaceMemberResponse
 */
export type AddWorkspaceMemberResponse = Message<"openshell.v1.AddWorkspaceMemberResponse"> & {
    /**
     * @generated from field: openshell.v1.WorkspaceMember member = 1;
     */
    member?: WorkspaceMember | undefined;
};
/**
 * Describes the message openshell.v1.AddWorkspaceMemberResponse.
 * Use `create(AddWorkspaceMemberResponseSchema)` to create a new message.
 */
export declare const AddWorkspaceMemberResponseSchema: GenMessage<AddWorkspaceMemberResponse>;
/**
 * Remove workspace member request.
 *
 * @generated from message openshell.v1.RemoveWorkspaceMemberRequest
 */
export type RemoveWorkspaceMemberRequest = Message<"openshell.v1.RemoveWorkspaceMemberRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 1;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * OIDC subject claim identifying the principal to remove.
     *
     * @generated from field: string principal_subject = 2;
     */
    principalSubject: string;
    /**
     * @generated from field: bool allow_missing = 3;
     */
    allowMissing: boolean;
    /**
     * Optional nonzero UUID. Same ID and payload replay success for 24 hours.
     *
     * @generated from field: string request_id = 4;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.RemoveWorkspaceMemberRequest.
 * Use `create(RemoveWorkspaceMemberRequestSchema)` to create a new message.
 */
export declare const RemoveWorkspaceMemberRequestSchema: GenMessage<RemoveWorkspaceMemberRequest>;
/**
 * Remove workspace member response.
 *
 * @generated from message openshell.v1.RemoveWorkspaceMemberResponse
 */
export type RemoveWorkspaceMemberResponse = Message<"openshell.v1.RemoveWorkspaceMemberResponse"> & {
    /**
     * @generated from field: openshell.v1.DeletionOutcome outcome = 2;
     */
    outcome: DeletionOutcome;
};
/**
 * Describes the message openshell.v1.RemoveWorkspaceMemberResponse.
 * Use `create(RemoveWorkspaceMemberResponseSchema)` to create a new message.
 */
export declare const RemoveWorkspaceMemberResponseSchema: GenMessage<RemoveWorkspaceMemberResponse>;
/**
 * List workspace members request.
 *
 * @generated from message openshell.v1.ListWorkspaceMembersRequest
 */
export type ListWorkspaceMembersRequest = Message<"openshell.v1.ListWorkspaceMembersRequest"> & {
    /**
     * Workspace scope. Only a named workspace selection is accepted.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 1;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * The maximum number of members to return. Zero uses 100. Values above
     * 1000 are coerced to 1000; negative values are invalid.
     *
     * @generated from field: int32 page_size = 2;
     */
    pageSize: number;
    /**
     * Token from a previous ListWorkspaceMembers response. All other request
     * parameters except page_size must match the request that produced it.
     *
     * @generated from field: string page_token = 3;
     */
    pageToken: string;
};
/**
 * Describes the message openshell.v1.ListWorkspaceMembersRequest.
 * Use `create(ListWorkspaceMembersRequestSchema)` to create a new message.
 */
export declare const ListWorkspaceMembersRequestSchema: GenMessage<ListWorkspaceMembersRequest>;
/**
 * List workspace members response.
 *
 * @generated from message openshell.v1.ListWorkspaceMembersResponse
 */
export type ListWorkspaceMembersResponse = Message<"openshell.v1.ListWorkspaceMembersResponse"> & {
    /**
     * @generated from field: repeated openshell.v1.WorkspaceMember members = 1;
     */
    members: WorkspaceMember[];
    /**
     * Token for the next page. Empty when there are no subsequent pages.
     *
     * @generated from field: string next_page_token = 2;
     */
    nextPageToken: string;
};
/**
 * Describes the message openshell.v1.ListWorkspaceMembersResponse.
 * Use `create(ListWorkspaceMembersResponseSchema)` to create a new message.
 */
export declare const ListWorkspaceMembersResponseSchema: GenMessage<ListWorkspaceMembersResponse>;
/**
 * Short-lived credential for one policy-authorized extension service.
 * Kept at the end of the file so adding it does not renumber existing
 * generated message descriptors.
 *
 * @generated from message openshell.v1.ExtensionServiceCredential
 */
export type ExtensionServiceCredential = Message<"openshell.v1.ExtensionServiceCredential"> & {
    /**
     * Operator registration name used to correlate the credential with the
     * stable service registration delivered by GetSandboxConfig.
     *
     * @generated from field: string service_name = 1;
     */
    serviceName: string;
    /**
     * Gateway-minted JWT with an audience derived from the registration.
     *
     * @generated from field: string token = 2;
     */
    token: string;
    /**
     * Absolute expiry of the token.
     *
     * @generated from field: google.protobuf.Timestamp expiration_time = 103;
     */
    expirationTime?: Timestamp | undefined;
};
/**
 * Describes the message openshell.v1.ExtensionServiceCredential.
 * Use `create(ExtensionServiceCredentialSchema)` to create a new message.
 */
export declare const ExtensionServiceCredentialSchema: GenMessage<ExtensionServiceCredential>;
/**
 * One redacted endpoint result in a supervisor's complete status report.
 *
 * @generated from message openshell.v1.EndpointObservation
 */
export type EndpointObservation = Message<"openshell.v1.EndpointObservation"> & {
    /**
     * Stable identifier derived from the configured host, ports, and path.
     *
     * @generated from field: string endpoint_id = 1;
     */
    endpointId: string;
    /**
     * Latest result under the reported configuration and supervisor session.
     *
     * @generated from field: openshell.v1.EndpointResult result = 2;
     */
    result: EndpointResult;
    /**
     * Bounded cause of result, when the supervisor classified it. Each failure
     * domain names the results it can explain.
     *
     * @generated from field: openshell.v1.EndpointFailure failure = 3;
     */
    failure?: EndpointFailure | undefined;
};
/**
 * Describes the message openshell.v1.EndpointObservation.
 * Use `create(EndpointObservationSchema)` to create a new message.
 */
export declare const EndpointObservationSchema: GenMessage<EndpointObservation>;
/**
 * Complete endpoint status report for the caller's current configuration.
 *
 * @generated from message openshell.v1.ReportEndpointStatusRequest
 */
export type ReportEndpointStatusRequest = Message<"openshell.v1.ReportEndpointStatusRequest"> & {
    /**
     * Sandbox id. Must match the authenticated sandbox principal.
     *
     * @generated from field: string sandbox_id = 1;
     */
    sandboxId: string;
    /**
     * Hash from the active effective policy delivered by the gateway.
     *
     * @generated from field: string policy_hash = 2;
     */
    policyHash: string;
    /**
     * Provider environment revision delivered with the active configuration.
     *
     * @generated from field: uint64 provider_env_revision = 3;
     */
    providerEnvRevision: bigint;
    /**
     * Exactly one result for every distinct observed endpoint in the policy.
     *
     * @generated from field: repeated openshell.v1.EndpointObservation observations = 4;
     */
    observations: EndpointObservation[];
    /**
     * Endpoints with a new observation in this batch. Omitted endpoints retain
     * their prior report time; an identical retry never advances report time.
     *
     * @generated from field: repeated string observed_endpoint_ids = 5;
     */
    observedEndpointIds: string[];
    /**
     * Active ConnectSupervisor session that owns these observations.
     *
     * @generated from field: string supervisor_session_id = 6;
     */
    supervisorSessionId: string;
    /**
     * Monotonically increasing sequence within the authenticated session. Gaps
     * are allowed when an inventory reset supersedes a frozen snapshot. Retrying
     * a report preserves its complete body and sequence for idempotent acknowledgement.
     *
     * @generated from field: uint64 report_sequence = 7;
     */
    reportSequence: bigint;
    /**
     * Complete latest grant state. Omission retains legacy compatibility;
     * a present message with no last_failure explicitly clears the prior cause.
     *
     * @generated from field: openshell.v1.TokenGrantStatus token_grant_status = 8;
     */
    tokenGrantStatus?: TokenGrantStatus | undefined;
};
/**
 * Describes the message openshell.v1.ReportEndpointStatusRequest.
 * Use `create(ReportEndpointStatusRequestSchema)` to create a new message.
 */
export declare const ReportEndpointStatusRequestSchema: GenMessage<ReportEndpointStatusRequest>;
/**
 * Latest token-grant state sent by the authenticated supervisor.
 *
 * @generated from message openshell.v1.TokenGrantStatus
 */
export type TokenGrantStatus = Message<"openshell.v1.TokenGrantStatus"> & {
    /**
     * @generated from field: openshell.v1.TokenGrantFailureObservation last_failure = 1;
     */
    lastFailure?: TokenGrantFailureObservation | undefined;
};
/**
 * Describes the message openshell.v1.TokenGrantStatus.
 * Use `create(TokenGrantStatusSchema)` to create a new message.
 */
export declare const TokenGrantStatusSchema: GenMessage<TokenGrantStatus>;
/**
 * A refused grant and its destination, without request paths or remote text.
 * This describes the failed attempt, not the destination's current health.
 *
 * @generated from message openshell.v1.TokenGrantFailureObservation
 */
export type TokenGrantFailureObservation = Message<"openshell.v1.TokenGrantFailureObservation"> & {
    /**
     * Canonical observed host or IP address, bounded to 253 ASCII bytes.
     *
     * @generated from field: string destination_host = 1;
     */
    destinationHost: string;
    /**
     * Observed destination port in the range 1 through 65535.
     *
     * @generated from field: uint32 destination_port = 2;
     */
    destinationPort: number;
    /**
     * Bounded token_grant cause. Provider and credential may be absent when
     * selection failed; the request ID still identifies the refused exchange.
     *
     * @generated from field: openshell.v1.EndpointFailure failure = 3;
     */
    failure?: EndpointFailure | undefined;
};
/**
 * Describes the message openshell.v1.TokenGrantFailureObservation.
 * Use `create(TokenGrantFailureObservationSchema)` to create a new message.
 */
export declare const TokenGrantFailureObservationSchema: GenMessage<TokenGrantFailureObservation>;
/**
 * Empty acknowledgement for a persisted endpoint status report.
 *
 * @generated from message openshell.v1.ReportEndpointStatusResponse
 */
export type ReportEndpointStatusResponse = Message<"openshell.v1.ReportEndpointStatusResponse"> & {};
/**
 * Describes the message openshell.v1.ReportEndpointStatusResponse.
 * Use `create(ReportEndpointStatusResponseSchema)` to create a new message.
 */
export declare const ReportEndpointStatusResponseSchema: GenMessage<ReportEndpointStatusResponse>;
/**
 * A configured endpoint and its last accepted network result in one record.
 * Address fields contain policy selectors, never request URLs or credentials.
 *
 * @generated from message openshell.v1.EndpointStatus
 */
export type EndpointStatus = Message<"openshell.v1.EndpointStatus"> & {
    /**
     * Stable identifier for selecting this endpoint without parsing display text.
     *
     * @generated from field: string endpoint_id = 1;
     */
    endpointId: string;
    /**
     * Lowercase configured endpoint host.
     *
     * @generated from field: string host = 2;
     */
    host: string;
    /**
     * Sorted, deduplicated effective endpoint ports. Validated endpoints have at
     * least one port.
     *
     * @generated from field: repeated uint32 ports = 3;
     */
    ports: number[];
    /**
     * Canonical configured path selector; an unrestricted path is /**.
     *
     * @generated from field: string path = 4;
     */
    path: string;
    /**
     * Last accepted result, aggregated across configured callers and ports.
     * NoObservedExchange retains the address and has no report timestamp.
     *
     * @generated from field: openshell.v1.EndpointResult last_result = 5;
     */
    lastResult: EndpointResult;
    /**
     * Time when the gateway accepted the observation. This is not the request
     * time: still-valid evidence can be reaccepted after a reset. Identical
     * same-sequence retries do not advance it. Absent until a result is reported.
     *
     * @generated from field: google.protobuf.Timestamp last_reported_time = 106;
     */
    lastReportedTime?: Timestamp | undefined;
    /**
     * Bounded cause of last_result, when the supervisor classified it. Each
     * failure domain names the results it can explain. Replaced or cleared by
     * every later observation, and cleared by the same resets that clear
     * last_result.
     *
     * @generated from field: openshell.v1.EndpointFailure last_failure = 7;
     */
    lastFailure?: EndpointFailure | undefined;
};
/**
 * Describes the message openshell.v1.EndpointStatus.
 * Use `create(EndpointStatusSchema)` to create a new message.
 */
export declare const EndpointStatusSchema: GenMessage<EndpointStatus>;
/**
 * Durable provisioning attempt, independent of supervisor registration and polling.
 *
 * @generated from message openshell.v1.SandboxProvisioning
 */
export type SandboxProvisioning = Message<"openshell.v1.SandboxProvisioning"> & {
    /**
     * @generated from field: string attempt_id = 1;
     */
    attemptId: string;
    /**
     * @generated from field: string configuration_change_id = 2;
     */
    configurationChangeId: string;
    /**
     * @generated from field: google.protobuf.Timestamp configuration_change_time = 3;
     */
    configurationChangeTime?: Timestamp | undefined;
    /**
     * @generated from field: google.protobuf.Timestamp first_rejection_time = 4;
     */
    firstRejectionTime?: Timestamp | undefined;
    /**
     * Active preparation or admission-repair deadline. Absent after Ready/timeout.
     *
     * @generated from field: google.protobuf.Timestamp deadline = 5;
     */
    deadline?: Timestamp | undefined;
    /**
     * @generated from field: google.protobuf.Timestamp timeout_time = 6;
     */
    timeoutTime?: Timestamp | undefined;
    /**
     * Set only after both supervisor and workload compute have been reclaimed.
     *
     * @generated from field: google.protobuf.Timestamp cleanup_completed_time = 7;
     */
    cleanupCompletedTime?: Timestamp | undefined;
    /**
     * A safe gateway-authored diagnostic; never a raw driver error.
     *
     * @generated from field: string cleanup_error = 8;
     */
    cleanupError: string;
    /**
     * Durable backoff for interrupted or failed reclamation.
     *
     * @generated from field: google.protobuf.Timestamp cleanup_retry_time = 9;
     */
    cleanupRetryTime?: Timestamp | undefined;
    /**
     * Attachment edits have their own durable clock; status writes do not change it.
     *
     * @generated from field: string attachment_change_id = 10;
     */
    attachmentChangeId: string;
    /**
     * @generated from field: google.protobuf.Timestamp attachment_change_time = 11;
     */
    attachmentChangeTime?: Timestamp | undefined;
    /**
     * Absolute ceiling for image preparation and initial supervisor startup.
     * Set once per new attempt; progress, configuration writes, and restarts
     * cannot extend it. Absent on attempts created before preparation timing.
     *
     * @generated from field: google.protobuf.Timestamp preparation_deadline = 12;
     */
    preparationDeadline?: Timestamp | undefined;
    /**
     * First authenticated supervisor configuration report for this attempt.
     * Starts the admission repair window. Absent while preparing, including
     * after a preparation timeout. Duplicate reports never change this value.
     *
     * @generated from field: google.protobuf.Timestamp admission_start_time = 13;
     */
    admissionStartTime?: Timestamp | undefined;
    /**
     * An owned driver create/start future is still pending. Claimed before
     * dispatch and cleared on its actual success or error response. Monitor
     * interruption, owner loss, and StopSandbox/NotFound do not clear it.
     * While set, cleanup cannot complete and retry/deletion remain blocked.
     * This does not strengthen a driver's transport-error settlement contract.
     *
     * @generated from field: bool driver_operation_pending = 14;
     */
    driverOperationPending: boolean;
    /**
     * Unique for each claimed driver operation, including recovery and automatic
     * restart. Retained after settlement to reject delayed callbacks from an
     * earlier operation on the same attempt and runtime generation.
     *
     * @generated from field: string driver_operation_id = 15;
     */
    driverOperationId: string;
};
/**
 * Describes the message openshell.v1.SandboxProvisioning.
 * Use `create(SandboxProvisioningSchema)` to create a new message.
 */
export declare const SandboxProvisioningSchema: GenMessage<SandboxProvisioning>;
/**
 * Create-time request to expose one loopback HTTP service in a sandbox.
 *
 * @generated from message openshell.v1.SandboxServiceExposure
 */
export type SandboxServiceExposure = Message<"openshell.v1.SandboxServiceExposure"> & {
    /**
     * Service name within the sandbox. Empty selects the unnamed endpoint.
     *
     * @generated from field: string service = 1;
     */
    service: string;
    /**
     * Loopback TCP port inside the sandbox.
     *
     * @generated from field: uint32 target_port = 2;
     */
    targetPort: number;
    /**
     * Application authorization behavior. Omission resolves to STRIP.
     *
     * @generated from field: openshell.v1.ServiceAuthorizationMode authorization_mode = 3;
     */
    authorizationMode: ServiceAuthorizationMode;
};
/**
 * Describes the message openshell.v1.SandboxServiceExposure.
 * Use `create(SandboxServiceExposureSchema)` to create a new message.
 */
export declare const SandboxServiceExposureSchema: GenMessage<SandboxServiceExposure>;
/**
 * Bounded cause of a failed endpoint observation, including failures before
 * any request reaches the endpoint. No field carries remote
 * text: code and stage come from the domain's closed sets, provider and
 * credential_key are configured names, and request_id is an opaque random ID.
 *
 * @generated from message openshell.v1.EndpointFailure
 */
export type EndpointFailure = Message<"openshell.v1.EndpointFailure"> & {
    /**
     * @generated from field: openshell.v1.EndpointFailureDomain domain = 1;
     */
    domain: EndpointFailureDomain;
    /**
     * Stable lower_snake_case code from the domain's closed set, such as
     * provider_authorization_required.
     *
     * @generated from field: string code = 2;
     */
    code: string;
    /**
     * Who can resolve the failure; always the action documented for the code.
     *
     * @generated from field: openshell.v1.ProviderCredentialRefreshRecoveryAction recovery_action = 3;
     */
    recoveryAction: ProviderCredentialRefreshRecoveryAction;
    /**
     * Provider whose credential failed. Empty when the failure happened before
     * a credential was selected.
     *
     * @generated from field: string provider = 4;
     */
    provider: string;
    /**
     * Credential name within the provider. Never a credential value.
     *
     * @generated from field: string credential_key = 5;
     */
    credentialKey: string;
    /**
     * Step that observed the failure, from the domain's closed set.
     *
     * @generated from field: string stage = 6;
     */
    stage: string;
    /**
     * HTTP status a token service returned, when one was received.
     *
     * @generated from field: optional uint32 upstream_http_status = 7;
     */
    upstreamHttpStatus?: number | undefined;
    /**
     * Supervisor-minted UUID of the refused exchange. The workload receives the
     * same value in the x-openshell-request-id response header.
     *
     * @generated from field: string request_id = 8;
     */
    requestId: string;
};
/**
 * Describes the message openshell.v1.EndpointFailure.
 * Use `create(EndpointFailureSchema)` to create a new message.
 */
export declare const EndpointFailureSchema: GenMessage<EndpointFailure>;
/**
 * @generated from enum openshell.v1.ExtensionKind
 */
export declare enum ExtensionKind {
    /**
     * @generated from enum value: EXTENSION_KIND_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: EXTENSION_KIND_COMPUTE_DRIVER = 1;
     */
    COMPUTE_DRIVER = 1,
    /**
     * @generated from enum value: EXTENSION_KIND_CREDENTIAL_DRIVER = 2;
     */
    CREDENTIAL_DRIVER = 2,
    /**
     * @generated from enum value: EXTENSION_KIND_GATEWAY_INTERCEPTOR = 3;
     */
    GATEWAY_INTERCEPTOR = 3,
    /**
     * @generated from enum value: EXTENSION_KIND_SUPERVISOR_MIDDLEWARE = 4;
     */
    SUPERVISOR_MIDDLEWARE = 4
}
/**
 * Describes the enum openshell.v1.ExtensionKind.
 */
export declare const ExtensionKindSchema: GenEnum<ExtensionKind>;
/**
 * High-level sandbox lifecycle phase derived by the gateway.
 *
 * Clients should rely on this normalized lifecycle summary for readiness and
 * deletion decisions instead of interpreting raw conditions.
 *
 * @generated from enum openshell.v1.SandboxPhase
 */
export declare enum SandboxPhase {
    /**
     * @generated from enum value: SANDBOX_PHASE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: SANDBOX_PHASE_PROVISIONING = 1;
     */
    PROVISIONING = 1,
    /**
     * @generated from enum value: SANDBOX_PHASE_READY = 2;
     */
    READY = 2,
    /**
     * @generated from enum value: SANDBOX_PHASE_ERROR = 3;
     */
    ERROR = 3,
    /**
     * @generated from enum value: SANDBOX_PHASE_DELETING = 4;
     */
    DELETING = 4,
    /**
     * @generated from enum value: SANDBOX_PHASE_UNKNOWN = 5;
     */
    UNKNOWN = 5,
    /**
     * @generated from enum value: SANDBOX_PHASE_STOPPING = 6;
     */
    STOPPING = 6,
    /**
     * @generated from enum value: SANDBOX_PHASE_STOPPED = 7;
     */
    STOPPED = 7,
    /**
     * @generated from enum value: SANDBOX_PHASE_STARTING = 8;
     */
    STARTING = 8,
    /**
     * The canonical main process exited successfully and its result is final.
     *
     * @generated from enum value: SANDBOX_PHASE_COMPLETED = 9;
     */
    COMPLETED = 9
}
/**
 * Describes the enum openshell.v1.SandboxPhase.
 */
export declare const SandboxPhaseSchema: GenEnum<SandboxPhase>;
/**
 * Operation whose installed authority is tracked by a receipt.
 *
 * @generated from enum openshell.v1.ProviderMutationKind
 */
export declare enum ProviderMutationKind {
    /**
     * @generated from enum value: PROVIDER_MUTATION_KIND_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: PROVIDER_MUTATION_KIND_ATTACH = 1;
     */
    ATTACH = 1,
    /**
     * @generated from enum value: PROVIDER_MUTATION_KIND_DETACH = 2;
     */
    DETACH = 2,
    /**
     * @generated from enum value: PROVIDER_MUTATION_KIND_UPDATE = 3;
     */
    UPDATE = 3,
    /**
     * Reconstructed status for existing desired state without a mutation receipt.
     *
     * @generated from enum value: PROVIDER_MUTATION_KIND_OBSERVE = 4;
     */
    OBSERVE = 4
}
/**
 * Describes the enum openshell.v1.ProviderMutationKind.
 */
export declare const ProviderMutationKindSchema: GenEnum<ProviderMutationKind>;
/**
 * Readiness states describe persisted intent separately from installed state.
 *
 * @generated from enum openshell.v1.ProviderReadinessState
 */
export declare enum ProviderReadinessState {
    /**
     * @generated from enum value: PROVIDER_READINESS_STATE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: PROVIDER_READINESS_STATE_PERSISTED = 1;
     */
    PERSISTED = 1,
    /**
     * @generated from enum value: PROVIDER_READINESS_STATE_PENDING = 2;
     */
    PENDING = 2,
    /**
     * @generated from enum value: PROVIDER_READINESS_STATE_READY = 3;
     */
    READY = 3,
    /**
     * @generated from enum value: PROVIDER_READINESS_STATE_WITHHELD = 4;
     */
    WITHHELD = 4,
    /**
     * @generated from enum value: PROVIDER_READINESS_STATE_REVOKED = 5;
     */
    REVOKED = 5,
    /**
     * @generated from enum value: PROVIDER_READINESS_STATE_FAILED = 6;
     */
    FAILED = 6,
    /**
     * @generated from enum value: PROVIDER_READINESS_STATE_SUPERSEDED = 7;
     */
    SUPERSEDED = 7
}
/**
 * Describes the enum openshell.v1.ProviderReadinessState.
 */
export declare const ProviderReadinessStateSchema: GenEnum<ProviderReadinessState>;
/**
 * Closed reason categories are safe to display. Raw installation errors are
 * never part of the readiness protocol.
 *
 * @generated from enum openshell.v1.ProviderReadinessReason
 */
export declare enum ProviderReadinessReason {
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_WAITING_FOR_SUPERVISOR = 1;
     */
    WAITING_FOR_SUPERVISOR = 1,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_WAITING_FOR_CREDENTIALS = 2;
     */
    WAITING_FOR_CREDENTIALS = 2,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_WAITING_FOR_POLICY = 3;
     */
    WAITING_FOR_POLICY = 3,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_WAITING_FOR_PROCESS = 4;
     */
    WAITING_FOR_PROCESS = 4,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_UNSUPPORTED_SUPERVISOR = 5;
     */
    UNSUPPORTED_SUPERVISOR = 5,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_CREDENTIALS_WITHHELD = 6;
     */
    CREDENTIALS_WITHHELD = 6,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_CREDENTIAL_INSTALL_FAILED = 7;
     */
    CREDENTIAL_INSTALL_FAILED = 7,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_POLICY_ACTIVATION_FAILED = 8;
     */
    POLICY_ACTIVATION_FAILED = 8,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_PROCESS_INSTALL_FAILED = 9;
     */
    PROCESS_INSTALL_FAILED = 9,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_SUPERVISOR_DISCONNECTED = 10;
     */
    SUPERVISOR_DISCONNECTED = 10,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_SUPERVISOR_LEASE_EXPIRED = 11;
     */
    SUPERVISOR_LEASE_EXPIRED = 11,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_DESIRED_STATE_CHANGED = 12;
     */
    DESIRED_STATE_CHANGED = 12,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_CREDENTIAL_EXPIRED = 13;
     */
    CREDENTIAL_EXPIRED = 13,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_LOCAL_POLICY = 14;
     */
    LOCAL_POLICY = 14,
    /**
     * @generated from enum value: PROVIDER_READINESS_REASON_SNAPSHOT_MISMATCH = 15;
     */
    SNAPSHOT_MISMATCH = 15
}
/**
 * Describes the enum openshell.v1.ProviderReadinessReason.
 */
export declare const ProviderReadinessReasonSchema: GenEnum<ProviderReadinessReason>;
/**
 * Component whose desired state is tracked by a durable update operation.
 *
 * @generated from enum openshell.v1.ConfigComponent
 */
export declare enum ConfigComponent {
    /**
     * @generated from enum value: CONFIG_COMPONENT_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: CONFIG_COMPONENT_SANDBOX_CONFIG = 1;
     */
    SANDBOX_CONFIG = 1,
    /**
     * @generated from enum value: CONFIG_COMPONENT_PROVIDER_ENVIRONMENT = 2;
     */
    PROVIDER_ENVIRONMENT = 2
}
/**
 * Describes the enum openshell.v1.ConfigComponent.
 */
export declare const ConfigComponentSchema: GenEnum<ConfigComponent>;
/**
 * Result of applying a component revision at its owning runtime boundary.
 *
 * @generated from enum openshell.v1.ConfigApplyOutcome
 */
export declare enum ConfigApplyOutcome {
    /**
     * @generated from enum value: CONFIG_APPLY_OUTCOME_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: CONFIG_APPLY_OUTCOME_APPLIED = 1;
     */
    APPLIED = 1,
    /**
     * @generated from enum value: CONFIG_APPLY_OUTCOME_IGNORED_DUPLICATE = 2;
     */
    IGNORED_DUPLICATE = 2,
    /**
     * @generated from enum value: CONFIG_APPLY_OUTCOME_IGNORED_STALE = 3;
     */
    IGNORED_STALE = 3,
    /**
     * @generated from enum value: CONFIG_APPLY_OUTCOME_RETAINED_LOCAL_OVERRIDE = 4;
     */
    RETAINED_LOCAL_OVERRIDE = 4,
    /**
     * @generated from enum value: CONFIG_APPLY_OUTCOME_DEGRADED = 5;
     */
    DEGRADED = 5,
    /**
     * @generated from enum value: CONFIG_APPLY_OUTCOME_FAILED_RETAINED_LAST_KNOWN_GOOD = 6;
     */
    FAILED_RETAINED_LAST_KNOWN_GOOD = 6,
    /**
     * @generated from enum value: CONFIG_APPLY_OUTCOME_FAILED_CLOSED = 7;
     */
    FAILED_CLOSED = 7,
    /**
     * @generated from enum value: CONFIG_APPLY_OUTCOME_UNSUPPORTED = 8;
     */
    UNSUPPORTED = 8
}
/**
 * Describes the enum openshell.v1.ConfigApplyOutcome.
 */
export declare const ConfigApplyOutcomeSchema: GenEnum<ConfigApplyOutcome>;
/**
 * Durable lifecycle of one desired-state update operation.
 *
 * @generated from enum openshell.v1.ConfigUpdateOperationState
 */
export declare enum ConfigUpdateOperationState {
    /**
     * @generated from enum value: CONFIG_UPDATE_OPERATION_STATE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: CONFIG_UPDATE_OPERATION_STATE_PENDING = 1;
     */
    PENDING = 1,
    /**
     * @generated from enum value: CONFIG_UPDATE_OPERATION_STATE_APPLIED = 2;
     */
    APPLIED = 2,
    /**
     * @generated from enum value: CONFIG_UPDATE_OPERATION_STATE_INACTIVE = 3;
     */
    INACTIVE = 3,
    /**
     * @generated from enum value: CONFIG_UPDATE_OPERATION_STATE_FAILED = 4;
     */
    FAILED = 4,
    /**
     * @generated from enum value: CONFIG_UPDATE_OPERATION_STATE_SUPERSEDED = 5;
     */
    SUPERSEDED = 5,
    /**
     * @generated from enum value: CONFIG_UPDATE_OPERATION_STATE_CANCELLED = 6;
     */
    CANCELLED = 6
}
/**
 * Describes the enum openshell.v1.ConfigUpdateOperationState.
 */
export declare const ConfigUpdateOperationStateSchema: GenEnum<ConfigUpdateOperationState>;
/**
 * Provider credential token grant configuration.
 * When present, the credential is obtained dynamically via OAuth2 grant when needed.
 *
 * @generated from enum openshell.v1.ProviderCredentialTokenGrantType
 */
export declare enum ProviderCredentialTokenGrantType {
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_TOKEN_GRANT_TYPE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_TOKEN_GRANT_TYPE_CLIENT_CREDENTIALS = 1;
     */
    CLIENT_CREDENTIALS = 1,
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_TOKEN_GRANT_TYPE_TOKEN_EXCHANGE = 2;
     */
    TOKEN_EXCHANGE = 2
}
/**
 * Describes the enum openshell.v1.ProviderCredentialTokenGrantType.
 */
export declare const ProviderCredentialTokenGrantTypeSchema: GenEnum<ProviderCredentialTokenGrantType>;
/**
 * @generated from enum openshell.v1.ProviderCredentialRefreshStrategy
 */
export declare enum ProviderCredentialRefreshStrategy {
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_REFRESH_STRATEGY_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_REFRESH_STRATEGY_STATIC = 1;
     */
    STATIC = 1,
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_REFRESH_STRATEGY_EXTERNAL = 2;
     */
    EXTERNAL = 2,
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_REFRESH_TOKEN = 3;
     */
    OAUTH2_REFRESH_TOKEN = 3,
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_REFRESH_STRATEGY_OAUTH2_CLIENT_CREDENTIALS = 4;
     */
    OAUTH2_CLIENT_CREDENTIALS = 4,
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_REFRESH_STRATEGY_GOOGLE_SERVICE_ACCOUNT_JWT = 5;
     */
    GOOGLE_SERVICE_ACCOUNT_JWT = 5,
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_REFRESH_STRATEGY_AWS_STS_ASSUME_ROLE = 6;
     */
    AWS_STS_ASSUME_ROLE = 6
}
/**
 * Describes the enum openshell.v1.ProviderCredentialRefreshStrategy.
 */
export declare const ProviderCredentialRefreshStrategySchema: GenEnum<ProviderCredentialRefreshStrategy>;
/**
 * Stable provider profile categories used by clients for grouping and filtering.
 *
 * @generated from enum openshell.v1.ProviderProfileCategory
 */
export declare enum ProviderProfileCategory {
    /**
     * @generated from enum value: PROVIDER_PROFILE_CATEGORY_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: PROVIDER_PROFILE_CATEGORY_OTHER = 1;
     */
    OTHER = 1,
    /**
     * @generated from enum value: PROVIDER_PROFILE_CATEGORY_INFERENCE = 2;
     */
    INFERENCE = 2,
    /**
     * @generated from enum value: PROVIDER_PROFILE_CATEGORY_AGENT = 3;
     */
    AGENT = 3,
    /**
     * @generated from enum value: PROVIDER_PROFILE_CATEGORY_SOURCE_CONTROL = 4;
     */
    SOURCE_CONTROL = 4,
    /**
     * @generated from enum value: PROVIDER_PROFILE_CATEGORY_MESSAGING = 5;
     */
    MESSAGING = 5,
    /**
     * @generated from enum value: PROVIDER_PROFILE_CATEGORY_DATA = 6;
     */
    DATA = 6,
    /**
     * @generated from enum value: PROVIDER_PROFILE_CATEGORY_KNOWLEDGE = 7;
     */
    KNOWLEDGE = 7
}
/**
 * Describes the enum openshell.v1.ProviderProfileCategory.
 */
export declare const ProviderProfileCategorySchema: GenEnum<ProviderProfileCategory>;
/**
 * Receivers treat UNSPECIFIED and unknown values as secret.
 *
 * @generated from enum openshell.v1.ProviderEnvironmentValueClassification
 */
export declare enum ProviderEnvironmentValueClassification {
    /**
     * @generated from enum value: PROVIDER_ENVIRONMENT_VALUE_CLASSIFICATION_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: PROVIDER_ENVIRONMENT_VALUE_CLASSIFICATION_NON_SECRET = 1;
     */
    NON_SECRET = 1,
    /**
     * @generated from enum value: PROVIDER_ENVIRONMENT_VALUE_CLASSIFICATION_STATIC_CREDENTIAL = 2;
     */
    STATIC_CREDENTIAL = 2
}
/**
 * Describes the enum openshell.v1.ProviderEnvironmentValueClassification.
 */
export declare const ProviderEnvironmentValueClassificationSchema: GenEnum<ProviderEnvironmentValueClassification>;
/**
 * @generated from enum openshell.v1.ConfigurationAdmissionState
 */
export declare enum ConfigurationAdmissionState {
    /**
     * @generated from enum value: CONFIGURATION_ADMISSION_STATE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: CONFIGURATION_ADMISSION_STATE_PENDING = 1;
     */
    PENDING = 1,
    /**
     * @generated from enum value: CONFIGURATION_ADMISSION_STATE_ACCEPTED = 2;
     */
    ACCEPTED = 2,
    /**
     * @generated from enum value: CONFIGURATION_ADMISSION_STATE_REJECTED = 3;
     */
    REJECTED = 3
}
/**
 * Describes the enum openshell.v1.ConfigurationAdmissionState.
 */
export declare const ConfigurationAdmissionStateSchema: GenEnum<ConfigurationAdmissionState>;
/**
 * Policy load status.
 *
 * @generated from enum openshell.v1.PolicyStatus
 */
export declare enum PolicyStatus {
    /**
     * @generated from enum value: POLICY_STATUS_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * Server received the update; sandbox has not yet loaded it.
     *
     * @generated from enum value: POLICY_STATUS_PENDING = 1;
     */
    PENDING = 1,
    /**
     * Sandbox successfully applied this policy version.
     *
     * @generated from enum value: POLICY_STATUS_LOADED = 2;
     */
    LOADED = 2,
    /**
     * Sandbox attempted to apply but failed; LKG policy remains active.
     * ListSandboxPolicies also uses FAILED for historical payloads that are
     * invalid under the current schema; load_error contains the diagnostic.
     *
     * @generated from enum value: POLICY_STATUS_FAILED = 3;
     */
    FAILED = 3,
    /**
     * A newer version was persisted before the sandbox loaded this one.
     *
     * @generated from enum value: POLICY_STATUS_SUPERSEDED = 4;
     */
    SUPERSEDED = 4
}
/**
 * Describes the enum openshell.v1.PolicyStatus.
 */
export declare const PolicyStatusSchema: GenEnum<PolicyStatus>;
/**
 * Service status enum.
 *
 * @generated from enum openshell.v1.ServiceStatus
 */
export declare enum ServiceStatus {
    /**
     * @generated from enum value: SERVICE_STATUS_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: SERVICE_STATUS_HEALTHY = 1;
     */
    HEALTHY = 1,
    /**
     * @generated from enum value: SERVICE_STATUS_DEGRADED = 2;
     */
    DEGRADED = 2,
    /**
     * @generated from enum value: SERVICE_STATUS_UNHEALTHY = 3;
     */
    UNHEALTHY = 3
}
/**
 * Describes the enum openshell.v1.ServiceStatus.
 */
export declare const ServiceStatusSchema: GenEnum<ServiceStatus>;
/**
 * Workspace-scoped role for members.
 *
 * @generated from enum openshell.v1.WorkspaceRole
 */
export declare enum WorkspaceRole {
    /**
     * @generated from enum value: WORKSPACE_ROLE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: WORKSPACE_ROLE_USER = 1;
     */
    USER = 1,
    /**
     * @generated from enum value: WORKSPACE_ROLE_ADMIN = 2;
     */
    ADMIN = 2
}
/**
 * Describes the enum openshell.v1.WorkspaceRole.
 */
export declare const WorkspaceRoleSchema: GenEnum<WorkspaceRole>;
/**
 * Stable recovery action for the most recent provider credential refresh
 * failure. Kept after the pre-existing enums so adding it does not renumber
 * their generated descriptors. Clients should use this field instead of
 * parsing last_error.
 *
 * @generated from enum openshell.v1.ProviderCredentialRefreshRecoveryAction
 */
export declare enum ProviderCredentialRefreshRecoveryAction {
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_REFRESH_RECOVERY_ACTION_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_REFRESH_RECOVERY_ACTION_RETRY = 1;
     */
    RETRY = 1,
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_REFRESH_RECOVERY_ACTION_REAUTHORIZE = 2;
     */
    REAUTHORIZE = 2,
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_REFRESH_RECOVERY_ACTION_FIX_CONFIGURATION = 3;
     */
    FIX_CONFIGURATION = 3,
    /**
     * @generated from enum value: PROVIDER_CREDENTIAL_REFRESH_RECOVERY_ACTION_INVESTIGATE = 4;
     */
    INVESTIGATE = 4
}
/**
 * Describes the enum openshell.v1.ProviderCredentialRefreshRecoveryAction.
 */
export declare const ProviderCredentialRefreshRecoveryActionSchema: GenEnum<ProviderCredentialRefreshRecoveryAction>;
/**
 * Policy applied when the canonical main process exits outside an intentional
 * stop or delete operation. Kept after existing enums so generated enum
 * descriptors remain stable.
 *
 * @generated from enum openshell.v1.SandboxRestartPolicy
 */
export declare enum SandboxRestartPolicy {
    /**
     * @generated from enum value: SANDBOX_RESTART_POLICY_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: SANDBOX_RESTART_POLICY_NEVER = 1;
     */
    NEVER = 1,
    /**
     * @generated from enum value: SANDBOX_RESTART_POLICY_ON_FAILURE = 2;
     */
    ON_FAILURE = 2,
    /**
     * @generated from enum value: SANDBOX_RESTART_POLICY_ALWAYS = 3;
     */
    ALWAYS = 3
}
/**
 * Describes the enum openshell.v1.SandboxRestartPolicy.
 */
export declare const SandboxRestartPolicySchema: GenEnum<SandboxRestartPolicy>;
/**
 * Result of a public delete, membership removal, or session revocation.
 * Default requests return NOT_FOUND for a missing target. With allow_missing,
 * only a missing target becomes ALREADY_ABSENT; parent lookup, authorization,
 * validation, precondition, and backend errors retain their normal status.
 * These results describe the targeted resource, not a same-name replacement.
 *
 * @generated from enum openshell.v1.DeletionOutcome
 */
export declare enum DeletionOutcome {
    /**
     * No outcome was supplied. Never infer completion from this value.
     *
     * @generated from enum value: DELETION_OUTCOME_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * The targeted gateway resource is removed (or the SSH session is revoked).
     * Downstream platform garbage collection may still be finishing.
     *
     * @generated from enum value: DELETION_OUTCOME_COMPLETED = 1;
     */
    COMPLETED = 1,
    /**
     * Sandbox deletion is accepted but its gateway record still exists.
     * Observe the targeted sandbox ID until it disappears for completion.
     *
     * @generated from enum value: DELETION_OUTCOME_ACCEPTED = 2;
     */
    ACCEPTED = 2,
    /**
     * The target did not exist and allow_missing was true.
     *
     * @generated from enum value: DELETION_OUTCOME_ALREADY_ABSENT = 3;
     */
    ALREADY_ABSENT = 3
}
/**
 * Describes the enum openshell.v1.DeletionOutcome.
 */
export declare const DeletionOutcomeSchema: GenEnum<DeletionOutcome>;
/**
 * Last observed network result for a configured external tool endpoint.
 * Results describe accepted traffic observations, not present availability.
 *
 * @generated from enum openshell.v1.EndpointResult
 */
export declare enum EndpointResult {
    /**
     * @generated from enum value: ENDPOINT_RESULT_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * No exchange has been observed under the current configuration and session.
     *
     * @generated from enum value: ENDPOINT_RESULT_NO_OBSERVED_EXCHANGE = 1;
     */
    NO_OBSERVED_EXCHANGE = 1,
    /**
     * An upstream HTTP status below 400 was received. Its body can still contain
     * an MCP error; this result does not establish tool-call success.
     *
     * @generated from enum value: ENDPOINT_RESULT_HTTP_RESPONSE_RECEIVED = 2;
     */
    HTTP_RESPONSE_RECEIVED = 2,
    /**
     * OpenShell policy denied the request locally.
     *
     * @generated from enum value: ENDPOINT_RESULT_POLICY_DENIED = 3;
     */
    POLICY_DENIED = 3,
    /**
     * An applicable OpenShell-managed credential was unavailable.
     *
     * @generated from enum value: ENDPOINT_RESULT_CREDENTIAL_UNAVAILABLE = 4;
     */
    CREDENTIAL_UNAVAILABLE = 4,
    /**
     * TLS setup for the upstream connection failed.
     *
     * @generated from enum value: ENDPOINT_RESULT_TLS_FAILED = 5;
     */
    TLS_FAILED = 5,
    /**
     * The upstream transport failed before an HTTP response arrived.
     *
     * @generated from enum value: ENDPOINT_RESULT_TRANSPORT_FAILED = 6;
     */
    TRANSPORT_FAILED = 6,
    /**
     * The upstream service returned an HTTP rejection.
     *
     * @generated from enum value: ENDPOINT_RESULT_UPSTREAM_REJECTED = 7;
     */
    UPSTREAM_REJECTED = 7
}
/**
 * Describes the enum openshell.v1.EndpointResult.
 */
export declare const EndpointResultSchema: GenEnum<EndpointResult>;
/**
 * Controls whether an exposed service receives the request's application
 * Authorization header.
 *
 * @generated from enum openshell.v1.ServiceAuthorizationMode
 */
export declare enum ServiceAuthorizationMode {
    /**
     * Omission preserves the secure legacy behavior and resolves to STRIP.
     *
     * @generated from enum value: SERVICE_AUTHORIZATION_MODE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * Remove Authorization before forwarding to the sandbox service.
     *
     * @generated from enum value: SERVICE_AUTHORIZATION_MODE_STRIP = 1;
     */
    STRIP = 1,
    /**
     * Forward one syntactically valid bearer Authorization header unchanged.
     *
     * @generated from enum value: SERVICE_AUTHORIZATION_MODE_BEARER_PASSTHROUGH = 2;
     */
    BEARER_PASSTHROUGH = 2
}
/**
 * Describes the enum openshell.v1.ServiceAuthorizationMode.
 */
export declare const ServiceAuthorizationModeSchema: GenEnum<ServiceAuthorizationMode>;
/**
 * Subsystem whose closed code set explains an endpoint failure. Each domain
 * defines its codes, stages, recovery actions, and the endpoint results it
 * can explain. Kept at the end of the file so adding it does not renumber
 * existing generated descriptors.
 *
 * @generated from enum openshell.v1.EndpointFailureDomain
 */
export declare enum EndpointFailureDomain {
    /**
     * @generated from enum value: ENDPOINT_FAILURE_DOMAIN_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * A dynamic token grant for a provider credential failed, so OpenShell
     * refused the request before any of it reached the endpoint. Explains
     * ENDPOINT_RESULT_CREDENTIAL_UNAVAILABLE.
     *
     * @generated from enum value: ENDPOINT_FAILURE_DOMAIN_TOKEN_GRANT = 1;
     */
    TOKEN_GRANT = 1
}
/**
 * Describes the enum openshell.v1.EndpointFailureDomain.
 */
export declare const EndpointFailureDomainSchema: GenEnum<EndpointFailureDomain>;
/**
 * OpenShell service provides sandbox, provider, and runtime management capabilities.
 *
 * Conventions:
 * - This file owns the public API resource model exposed to OpenShell clients.
 * - `Sandbox`, `SandboxSpec`, `SandboxStatus`, and `SandboxPhase` are gateway-owned
 *   public types. Internal compute drivers must not import or return them directly.
 * - The gateway translates internal compute-driver observations into these public
 *   resource messages before persisting or returning them to clients.
 *
 * @generated from service openshell.v1.OpenShell
 */
export declare const OpenShell: GenService<{
    /**
     * Check the health of the service.
     *
     * @generated from rpc openshell.v1.OpenShell.Health
     */
    health: {
        methodKind: "unary";
        input: typeof HealthRequestSchema;
        output: typeof HealthResponseSchema;
    };
    /**
     * Return the authenticated caller identity established by the gateway.
     *
     * @generated from rpc openshell.v1.OpenShell.GetCurrentUser
     */
    getCurrentUser: {
        methodKind: "unary";
        input: typeof GetCurrentUserRequestSchema;
        output: typeof GetCurrentUserResponseSchema;
    };
    /**
     * Fetch elevated live gateway runtime metadata.
     *
     * @generated from rpc openshell.v1.OpenShell.GetGatewayInfo
     */
    getGatewayInfo: {
        methodKind: "unary";
        input: typeof GetGatewayInfoRequestSchema;
        output: typeof GetGatewayInfoResponseSchema;
    };
    /**
     * Create a new sandbox.
     *
     * @generated from rpc openshell.v1.OpenShell.CreateSandbox
     */
    createSandbox: {
        methodKind: "unary";
        input: typeof CreateSandboxRequestSchema;
        output: typeof SandboxResponseSchema;
    };
    /**
     * Allocate a gateway-owned staging slot for a local rootfs tar archive.
     *
     * The gateway creates a request-scoped directory inside the compute driver's
     * staging root and returns an opaque single-use token plus the absolute path
     * the client must write the archive to. The token is then passed as
     * `template.driver_config.<driver>.rootfs_tar_staging_token` on
     * CreateSandbox; callers never name a filesystem path themselves. Only a
     * client sharing the gateway's filesystem can complete the upload.
     *
     * @generated from rpc openshell.v1.OpenShell.BeginRootfsTarStaging
     */
    beginRootfsTarStaging: {
        methodKind: "unary";
        input: typeof BeginRootfsTarStagingRequestSchema;
        output: typeof BeginRootfsTarStagingResponseSchema;
    };
    /**
     * Fetch a sandbox by name.
     *
     * @generated from rpc openshell.v1.OpenShell.GetSandbox
     */
    getSandbox: {
        methodKind: "unary";
        input: typeof GetSandboxRequestSchema;
        output: typeof SandboxResponseSchema;
    };
    /**
     * List sandboxes.
     *
     * @generated from rpc openshell.v1.OpenShell.ListSandboxes
     */
    listSandboxes: {
        methodKind: "unary";
        input: typeof ListSandboxesRequestSchema;
        output: typeof ListSandboxesResponseSchema;
    };
    /**
     * Create a reusable sandbox workload template.
     *
     * @generated from rpc openshell.v1.OpenShell.CreateSandboxTemplate
     */
    createSandboxTemplate: {
        methodKind: "unary";
        input: typeof CreateSandboxTemplateRequestSchema;
        output: typeof SandboxTemplateResponseSchema;
    };
    /**
     * Fetch a reusable sandbox workload template by name.
     *
     * @generated from rpc openshell.v1.OpenShell.GetSandboxTemplate
     */
    getSandboxTemplate: {
        methodKind: "unary";
        input: typeof GetSandboxTemplateRequestSchema;
        output: typeof SandboxTemplateResponseSchema;
    };
    /**
     * List reusable sandbox workload templates.
     *
     * @generated from rpc openshell.v1.OpenShell.ListSandboxTemplates
     */
    listSandboxTemplates: {
        methodKind: "unary";
        input: typeof ListSandboxTemplatesRequestSchema;
        output: typeof ListSandboxTemplatesResponseSchema;
    };
    /**
     * Delete a reusable sandbox workload template by name.
     *
     * @generated from rpc openshell.v1.OpenShell.DeleteSandboxTemplate
     */
    deleteSandboxTemplate: {
        methodKind: "unary";
        input: typeof DeleteSandboxTemplateRequestSchema;
        output: typeof DeleteSandboxTemplateResponseSchema;
    };
    /**
     * List provider records attached to a sandbox.
     *
     * @generated from rpc openshell.v1.OpenShell.ListSandboxProviders
     */
    listSandboxProviders: {
        methodKind: "unary";
        input: typeof ListSandboxProvidersRequestSchema;
        output: typeof ListSandboxProvidersResponseSchema;
    };
    /**
     * Attach a provider record to an existing sandbox.
     *
     * @generated from rpc openshell.v1.OpenShell.AttachSandboxProvider
     */
    attachSandboxProvider: {
        methodKind: "unary";
        input: typeof AttachSandboxProviderRequestSchema;
        output: typeof AttachSandboxProviderResponseSchema;
    };
    /**
     * Detach a provider record from an existing sandbox.
     *
     * @generated from rpc openshell.v1.OpenShell.DetachSandboxProvider
     */
    detachSandboxProvider: {
        methodKind: "unary";
        input: typeof DetachSandboxProviderRequestSchema;
        output: typeof DetachSandboxProviderResponseSchema;
    };
    /**
     * Inspect the installed authority for one sandbox provider mutation.
     *
     * @generated from rpc openshell.v1.OpenShell.GetSandboxProviderStatus
     */
    getSandboxProviderStatus: {
        methodKind: "unary";
        input: typeof GetSandboxProviderStatusRequestSchema;
        output: typeof GetSandboxProviderStatusResponseSchema;
    };
    /**
     * Delete a sandbox by name.
     *
     * @generated from rpc openshell.v1.OpenShell.DeleteSandbox
     */
    deleteSandbox: {
        methodKind: "unary";
        input: typeof DeleteSandboxRequestSchema;
        output: typeof DeleteSandboxResponseSchema;
    };
    /**
     * Stop a sandbox while retaining its persistent state.
     *
     * @generated from rpc openshell.v1.OpenShell.StopSandbox
     */
    stopSandbox: {
        methodKind: "unary";
        input: typeof StopSandboxRequestSchema;
        output: typeof SandboxResponseSchema;
    };
    /**
     * Start a previously stopped sandbox.
     *
     * @generated from rpc openshell.v1.OpenShell.StartSandbox
     */
    startSandbox: {
        methodKind: "unary";
        input: typeof StartSandboxRequestSchema;
        output: typeof SandboxResponseSchema;
    };
    /**
     * Create a short-lived SSH session for a sandbox.
     *
     * @generated from rpc openshell.v1.OpenShell.CreateSshSession
     */
    createSshSession: {
        methodKind: "unary";
        input: typeof CreateSshSessionRequestSchema;
        output: typeof CreateSshSessionResponseSchema;
    };
    /**
     * Create or update a sandbox HTTP service endpoint for local routing.
     *
     * @generated from rpc openshell.v1.OpenShell.ExposeService
     */
    exposeService: {
        methodKind: "unary";
        input: typeof ExposeServiceRequestSchema;
        output: typeof ServiceEndpointResponseSchema;
    };
    /**
     * Fetch one sandbox HTTP service endpoint.
     *
     * @generated from rpc openshell.v1.OpenShell.GetService
     */
    getService: {
        methodKind: "unary";
        input: typeof GetServiceRequestSchema;
        output: typeof ServiceEndpointResponseSchema;
    };
    /**
     * List sandbox HTTP service endpoints.
     *
     * @generated from rpc openshell.v1.OpenShell.ListServices
     */
    listServices: {
        methodKind: "unary";
        input: typeof ListServicesRequestSchema;
        output: typeof ListServicesResponseSchema;
    };
    /**
     * Delete one sandbox HTTP service endpoint.
     *
     * @generated from rpc openshell.v1.OpenShell.DeleteService
     */
    deleteService: {
        methodKind: "unary";
        input: typeof DeleteServiceRequestSchema;
        output: typeof DeleteServiceResponseSchema;
    };
    /**
     * Revoke a previously issued SSH session.
     *
     * @generated from rpc openshell.v1.OpenShell.RevokeSshSession
     */
    revokeSshSession: {
        methodKind: "unary";
        input: typeof RevokeSshSessionRequestSchema;
        output: typeof RevokeSshSessionResponseSchema;
    };
    /**
     * Execute a command in a ready sandbox and stream output.
     *
     * @generated from rpc openshell.v1.OpenShell.ExecSandbox
     */
    execSandbox: {
        methodKind: "server_streaming";
        input: typeof ExecSandboxRequestSchema;
        output: typeof ExecSandboxEventSchema;
    };
    /**
     * Forward one CLI-side TCP connection to a loopback TCP target in a sandbox.
     *
     * @generated from rpc openshell.v1.OpenShell.ForwardTcp
     */
    forwardTcp: {
        methodKind: "bidi_streaming";
        input: typeof TcpForwardFrameSchema;
        output: typeof TcpForwardFrameSchema;
    };
    /**
     * Execute an interactive command with bidirectional stdin/stdout streaming.
     * The first client message MUST carry an ExecSandboxInput with the start
     * variant. Subsequent messages carry stdin bytes or window resize events.
     *
     * @generated from rpc openshell.v1.OpenShell.ExecSandboxInteractive
     */
    execSandboxInteractive: {
        methodKind: "bidi_streaming";
        input: typeof ExecSandboxInputSchema;
        output: typeof ExecSandboxEventSchema;
    };
    /**
     * Create a provider.
     *
     * @generated from rpc openshell.v1.OpenShell.CreateProvider
     */
    createProvider: {
        methodKind: "unary";
        input: typeof CreateProviderRequestSchema;
        output: typeof ProviderResponseSchema;
    };
    /**
     * Fetch a provider by name.
     *
     * @generated from rpc openshell.v1.OpenShell.GetProvider
     */
    getProvider: {
        methodKind: "unary";
        input: typeof GetProviderRequestSchema;
        output: typeof ProviderResponseSchema;
    };
    /**
     * Export selected usable runtime credentials. Only directly authenticated
     * mTLS operators may call this method; refresh material is never returned.
     *
     * @generated from rpc openshell.v1.OpenShell.GetProviderCredentials
     */
    getProviderCredentials: {
        methodKind: "unary";
        input: typeof GetProviderCredentialsRequestSchema;
        output: typeof GetProviderCredentialsResponseSchema;
    };
    /**
     * List providers.
     *
     * @generated from rpc openshell.v1.OpenShell.ListProviders
     */
    listProviders: {
        methodKind: "unary";
        input: typeof ListProvidersRequestSchema;
        output: typeof ListProvidersResponseSchema;
    };
    /**
     * List available provider type profiles.
     *
     * @generated from rpc openshell.v1.OpenShell.ListProviderProfiles
     */
    listProviderProfiles: {
        methodKind: "unary";
        input: typeof ListProviderProfilesRequestSchema;
        output: typeof ListProviderProfilesResponseSchema;
    };
    /**
     * Fetch one provider type profile by id.
     *
     * @generated from rpc openshell.v1.OpenShell.GetProviderProfile
     */
    getProviderProfile: {
        methodKind: "unary";
        input: typeof GetProviderProfileRequestSchema;
        output: typeof ProviderProfileResponseSchema;
    };
    /**
     * Import custom provider type profiles.
     *
     * @generated from rpc openshell.v1.OpenShell.ImportProviderProfiles
     */
    importProviderProfiles: {
        methodKind: "unary";
        input: typeof ImportProviderProfilesRequestSchema;
        output: typeof ImportProviderProfilesResponseSchema;
    };
    /**
     * Update an existing custom provider type profile.
     *
     * @generated from rpc openshell.v1.OpenShell.UpdateProviderProfiles
     */
    updateProviderProfiles: {
        methodKind: "unary";
        input: typeof UpdateProviderProfilesRequestSchema;
        output: typeof UpdateProviderProfilesResponseSchema;
    };
    /**
     * Validate provider type profiles without registering them.
     *
     * @generated from rpc openshell.v1.OpenShell.LintProviderProfiles
     */
    lintProviderProfiles: {
        methodKind: "unary";
        input: typeof LintProviderProfilesRequestSchema;
        output: typeof LintProviderProfilesResponseSchema;
    };
    /**
     * Update an existing provider by name.
     *
     * @generated from rpc openshell.v1.OpenShell.UpdateProvider
     */
    updateProvider: {
        methodKind: "unary";
        input: typeof UpdateProviderRequestSchema;
        output: typeof ProviderResponseSchema;
    };
    /**
     * Fetch refresh status for one provider or provider credential.
     *
     * @generated from rpc openshell.v1.OpenShell.GetProviderRefreshStatus
     */
    getProviderRefreshStatus: {
        methodKind: "unary";
        input: typeof GetProviderRefreshStatusRequestSchema;
        output: typeof GetProviderRefreshStatusResponseSchema;
    };
    /**
     * Configure gateway-owned refresh material for one provider credential.
     *
     * @generated from rpc openshell.v1.OpenShell.ConfigureProviderRefresh
     */
    configureProviderRefresh: {
        methodKind: "unary";
        input: typeof ConfigureProviderRefreshRequestSchema;
        output: typeof ConfigureProviderRefreshResponseSchema;
    };
    /**
     * Record a gateway-owned refresh request for one provider credential.
     *
     * @generated from rpc openshell.v1.OpenShell.RotateProviderCredential
     */
    rotateProviderCredential: {
        methodKind: "unary";
        input: typeof RotateProviderCredentialRequestSchema;
        output: typeof RotateProviderCredentialResponseSchema;
    };
    /**
     * Delete gateway-owned refresh configuration for one provider credential.
     *
     * @generated from rpc openshell.v1.OpenShell.DeleteProviderRefresh
     */
    deleteProviderRefresh: {
        methodKind: "unary";
        input: typeof DeleteProviderRefreshRequestSchema;
        output: typeof DeleteProviderRefreshResponseSchema;
    };
    /**
     * Delete a provider by name.
     *
     * @generated from rpc openshell.v1.OpenShell.DeleteProvider
     */
    deleteProvider: {
        methodKind: "unary";
        input: typeof DeleteProviderRequestSchema;
        output: typeof DeleteProviderResponseSchema;
    };
    /**
     * Delete a custom provider type profile by id.
     *
     * @generated from rpc openshell.v1.OpenShell.DeleteProviderProfile
     */
    deleteProviderProfile: {
        methodKind: "unary";
        input: typeof DeleteProviderProfileRequestSchema;
        output: typeof DeleteProviderProfileResponseSchema;
    };
    /**
     * Get sandbox settings by id (called by users, and by supervisors at startup
     * and in their poll loop). A supervisor whose session pushes configuration
     * receives later updates over ConnectSupervisor and stops polling.
     *
     * @generated from rpc openshell.v1.OpenShell.GetSandboxConfig
     */
    getSandboxConfig: {
        methodKind: "unary";
        input: typeof GetSandboxConfigRequestSchema;
        output: typeof GetSandboxConfigResponseSchema;
    };
    /**
     * Get gateway-global settings (read-only runtime configuration; any
     * authenticated user may read these without requiring Platform Admin).
     *
     * Scope-only (no role): scopes are granted by the IdP at token issuance,
     * orthogonal to workspace membership. Deployments that enable scope
     * enforcement configure the IdP to grant config:read (or openshell:all)
     * to all sandbox users, so this does not block least-privilege flows.
     *
     * @generated from rpc openshell.v1.OpenShell.GetGatewayConfig
     */
    getGatewayConfig: {
        methodKind: "unary";
        input: typeof GetGatewayConfigRequestSchema;
        output: typeof GetGatewayConfigResponseSchema;
    };
    /**
     * Update settings or policy at sandbox or global scope.
     *
     * @generated from rpc openshell.v1.OpenShell.UpdateConfig
     */
    updateConfig: {
        methodKind: "unary";
        input: typeof UpdateConfigRequestSchema;
        output: typeof UpdateConfigResponseSchema;
    };
    /**
     * Get the load status of a specific policy version.
     *
     * @generated from rpc openshell.v1.OpenShell.GetSandboxPolicyStatus
     */
    getSandboxPolicyStatus: {
        methodKind: "unary";
        input: typeof GetSandboxPolicyStatusRequestSchema;
        output: typeof GetSandboxPolicyStatusResponseSchema;
    };
    /**
     * List policy history for a sandbox.
     *
     * @generated from rpc openshell.v1.OpenShell.ListSandboxPolicies
     */
    listSandboxPolicies: {
        methodKind: "unary";
        input: typeof ListSandboxPoliciesRequestSchema;
        output: typeof ListSandboxPoliciesResponseSchema;
    };
    /**
     * Report policy load result (called by sandbox after reload attempt).
     *
     * @generated from rpc openshell.v1.OpenShell.ReportPolicyStatus
     */
    reportPolicyStatus: {
        methodKind: "unary";
        input: typeof ReportPolicyStatusRequestSchema;
        output: typeof ReportPolicyStatusResponseSchema;
    };
    /**
     * Replace the gateway's observed tool server endpoint status for one sandbox.
     *
     * @generated from rpc openshell.v1.OpenShell.ReportEndpointStatus
     */
    reportEndpointStatus: {
        methodKind: "unary";
        input: typeof ReportEndpointStatusRequestSchema;
        output: typeof ReportEndpointStatusResponseSchema;
    };
    /**
     * Report installed provider state for the current ConnectSupervisor session.
     * Replacing or losing that session invalidates its observations.
     *
     * @generated from rpc openshell.v1.OpenShell.ReportProviderReadiness
     */
    reportProviderReadiness: {
        methodKind: "unary";
        input: typeof ReportProviderReadinessRequestSchema;
        output: typeof ReportProviderReadinessResponseSchema;
    };
    /**
     * Register startup and acknowledge an exact validated runtime configuration.
     *
     * @generated from rpc openshell.v1.OpenShell.ReportSandboxConfiguration
     */
    reportSandboxConfiguration: {
        methodKind: "unary";
        input: typeof ReportSandboxConfigurationRequestSchema;
        output: typeof ReportSandboxConfigurationResponseSchema;
    };
    /**
     * Get provider environment for a sandbox (called by the sandbox supervisor at
     * startup and by its poll loop). Polling projection of the provider
     * environment delivered over ConnectSupervisor; removed with the polling RPCs.
     *
     * @generated from rpc openshell.v1.OpenShell.GetSandboxProviderEnvironment
     */
    getSandboxProviderEnvironment: {
        methodKind: "unary";
        input: typeof GetSandboxProviderEnvironmentRequestSchema;
        output: typeof GetSandboxProviderEnvironmentResponseSchema;
    };
    /**
     * Exchange a stored provider subject token for an intermediate token scoped
     * to the calling supervisor's SPIFFE identity.
     *
     * @generated from rpc openshell.v1.OpenShell.ExchangeProviderSubjectToken
     */
    exchangeProviderSubjectToken: {
        methodKind: "unary";
        input: typeof ExchangeProviderSubjectTokenRequestSchema;
        output: typeof ExchangeProviderSubjectTokenResponseSchema;
    };
    /**
     * Fetch recent sandbox logs (one-shot).
     *
     * @generated from rpc openshell.v1.OpenShell.GetSandboxLogs
     */
    getSandboxLogs: {
        methodKind: "unary";
        input: typeof GetSandboxLogsRequestSchema;
        output: typeof GetSandboxLogsResponseSchema;
    };
    /**
     * Push sandbox supervisor logs to the server (client-streaming).
     *
     * @generated from rpc openshell.v1.OpenShell.PushSandboxLogs
     */
    pushSandboxLogs: {
        methodKind: "client_streaming";
        input: typeof PushSandboxLogsRequestSchema;
        output: typeof PushSandboxLogsResponseSchema;
    };
    /**
     * Persistent supervisor-to-gateway session (bidirectional streaming).
     *
     * The supervisor opens this stream at startup and keeps it alive for the
     * sandbox lifetime. The gateway uses it to coordinate relay channels for
     * SSH connect, ExecSandbox, targetable sandbox services, and configuration
     * delivery. Supervisors advertise optional stream features in
     * SupervisorHello, and the gateway sends only payloads the supervisor
     * advertises. Raw service bytes flow over RelayStream calls (separate HTTP/2
     * streams on the same connection), not over this stream.
     *
     * @generated from rpc openshell.v1.OpenShell.ConnectSupervisor
     */
    connectSupervisor: {
        methodKind: "bidi_streaming";
        input: typeof SupervisorMessageSchema;
        output: typeof GatewayMessageSchema;
    };
    /**
     * Persist the canonical main process result before the supervisor exits.
     *
     * @generated from rpc openshell.v1.OpenShell.ReportMainProcessExit
     */
    reportMainProcessExit: {
        methodKind: "unary";
        input: typeof ReportMainProcessExitRequestSchema;
        output: typeof ReportMainProcessExitResponseSchema;
    };
    /**
     * Confirm that foreground terminal delivery completed naturally.
     *
     * @generated from rpc openshell.v1.OpenShell.FinalizeMainProcessExit
     */
    finalizeMainProcessExit: {
        methodKind: "unary";
        input: typeof FinalizeMainProcessExitRequestSchema;
        output: typeof FinalizeMainProcessExitResponseSchema;
    };
    /**
     * Raw byte relay between supervisor and gateway.
     *
     * The supervisor initiates this call after receiving a RelayOpen message
     * on its ConnectSupervisor stream. The first RelayFrame carries a
     * RelayInit with the channel_id to associate the new HTTP/2 stream with
     * the pending relay slot on the gateway. Subsequent frames carry raw bytes in either
     * direction between the gateway-side waiter (ForwardTcp / exec handler)
     * and the supervisor-side target bridge.
     *
     * This rides the same TCP+TLS+HTTP/2 connection as ConnectSupervisor —
     * no new TLS handshake, no reverse HTTP CONNECT.
     *
     * @generated from rpc openshell.v1.OpenShell.RelayStream
     */
    relayStream: {
        methodKind: "bidi_streaming";
        input: typeof RelayFrameSchema;
        output: typeof RelayFrameSchema;
    };
    /**
     * Internal gateway-to-gateway relay forwarding.
     *
     * A gateway replica that receives a user request for a sandbox whose
     * supervisor session is owned by a different replica opens this stream to the
     * owner. The first frame carries PeerRelayInit; subsequent frames carry raw
     * bytes in either direction. This RPC is authenticated as a gateway peer, not
     * as a user or sandbox supervisor.
     *
     * @generated from rpc openshell.v1.OpenShell.PeerRelay
     */
    peerRelay: {
        methodKind: "bidi_streaming";
        input: typeof PeerRelayFrameSchema;
        output: typeof PeerRelayFrameSchema;
    };
    /**
     * Internal gateway-to-owner forwarding for supervisor-bound state.
     *
     * @generated from rpc openshell.v1.OpenShell.PeerReportProviderReadiness
     */
    peerReportProviderReadiness: {
        methodKind: "unary";
        input: typeof ReportProviderReadinessRequestSchema;
        output: typeof ReportProviderReadinessResponseSchema;
    };
    /**
     * @generated from rpc openshell.v1.OpenShell.PeerReportEndpointStatus
     */
    peerReportEndpointStatus: {
        methodKind: "unary";
        input: typeof ReportEndpointStatusRequestSchema;
        output: typeof ReportEndpointStatusResponseSchema;
    };
    /**
     * @generated from rpc openshell.v1.OpenShell.PeerGetSandboxProviderStatus
     */
    peerGetSandboxProviderStatus: {
        methodKind: "unary";
        input: typeof GetSandboxProviderStatusRequestSchema;
        output: typeof GetSandboxProviderStatusResponseSchema;
    };
    /**
     * Best-effort notification to the replica that owns a supervisor session.
     * The receiver rebuilds snapshots from authoritative state.
     *
     * @generated from rpc openshell.v1.OpenShell.PeerNotifyConfigUpdate
     */
    peerNotifyConfigUpdate: {
        methodKind: "unary";
        input: typeof PeerNotifyConfigUpdateRequestSchema;
        output: typeof PeerNotifyConfigUpdateResponseSchema;
    };
    /**
     * Watch a sandbox and stream updates.
     *
     * This stream can include:
     * - Sandbox status snapshots (phase/status)
     * - OpenShell server process logs correlated by sandbox_id
     * - Platform events correlated to the sandbox
     *
     * @generated from rpc openshell.v1.OpenShell.WatchSandbox
     */
    watchSandbox: {
        methodKind: "server_streaming";
        input: typeof WatchSandboxRequestSchema;
        output: typeof SandboxStreamEventSchema;
    };
    /**
     * Submit denial analysis results from sandbox (summaries + proposed chunks).
     *
     * @generated from rpc openshell.v1.OpenShell.SubmitPolicyAnalysis
     */
    submitPolicyAnalysis: {
        methodKind: "unary";
        input: typeof SubmitPolicyAnalysisRequestSchema;
        output: typeof SubmitPolicyAnalysisResponseSchema;
    };
    /**
     * Get draft policy recommendations for a sandbox.
     *
     * @generated from rpc openshell.v1.OpenShell.GetDraftPolicy
     */
    getDraftPolicy: {
        methodKind: "unary";
        input: typeof GetDraftPolicyRequestSchema;
        output: typeof GetDraftPolicyResponseSchema;
    };
    /**
     * Approve a single draft policy chunk (merges into active policy).
     *
     * @generated from rpc openshell.v1.OpenShell.ApproveDraftChunk
     */
    approveDraftChunk: {
        methodKind: "unary";
        input: typeof ApproveDraftChunkRequestSchema;
        output: typeof ApproveDraftChunkResponseSchema;
    };
    /**
     * Reject a single draft policy chunk.
     *
     * @generated from rpc openshell.v1.OpenShell.RejectDraftChunk
     */
    rejectDraftChunk: {
        methodKind: "unary";
        input: typeof RejectDraftChunkRequestSchema;
        output: typeof RejectDraftChunkResponseSchema;
    };
    /**
     * Approve all pending draft chunks (skips security-flagged unless forced).
     *
     * @generated from rpc openshell.v1.OpenShell.ApproveAllDraftChunks
     */
    approveAllDraftChunks: {
        methodKind: "unary";
        input: typeof ApproveAllDraftChunksRequestSchema;
        output: typeof ApproveAllDraftChunksResponseSchema;
    };
    /**
     * Edit a pending draft chunk in-place (e.g. narrow allowed_ips).
     *
     * @generated from rpc openshell.v1.OpenShell.EditDraftChunk
     */
    editDraftChunk: {
        methodKind: "unary";
        input: typeof EditDraftChunkRequestSchema;
        output: typeof EditDraftChunkResponseSchema;
    };
    /**
     * Reverse an approval (remove merged rule from active policy).
     *
     * @generated from rpc openshell.v1.OpenShell.UndoDraftChunk
     */
    undoDraftChunk: {
        methodKind: "unary";
        input: typeof UndoDraftChunkRequestSchema;
        output: typeof UndoDraftChunkResponseSchema;
    };
    /**
     * Clear all pending draft chunks for a sandbox.
     *
     * @generated from rpc openshell.v1.OpenShell.ClearDraftChunks
     */
    clearDraftChunks: {
        methodKind: "unary";
        input: typeof ClearDraftChunksRequestSchema;
        output: typeof ClearDraftChunksResponseSchema;
    };
    /**
     * Get decision history for a sandbox's draft policy.
     *
     * @generated from rpc openshell.v1.OpenShell.GetDraftHistory
     */
    getDraftHistory: {
        methodKind: "unary";
        input: typeof GetDraftHistoryRequestSchema;
        output: typeof GetDraftHistoryResponseSchema;
    };
    /**
     * Exchange a sandbox-bootstrap credential (e.g. a Kubernetes projected
     * ServiceAccount token) for a gateway-minted JWT bound to the calling
     * sandbox's UUID. Used by the Kubernetes driver path; singleplayer
     * drivers receive the gateway JWT directly from the create-sandbox flow
     * and never call this RPC.
     *
     * @generated from rpc openshell.v1.OpenShell.IssueSandboxToken
     */
    issueSandboxToken: {
        methodKind: "unary";
        input: typeof IssueSandboxTokenRequestSchema;
        output: typeof IssueSandboxTokenResponseSchema;
    };
    /**
     * Renew the calling sandbox's gateway JWT. Older tokens remain valid
     * until their own expiry; deployments should keep token TTLs short to
     * bound replay exposure. The supervisor calls this from a background
     * task at ~80% of the token's lifetime; the new token is cached in
     * memory only — the on-disk bootstrap file is intentionally not
     * rewritten.
     *
     * @generated from rpc openshell.v1.OpenShell.RefreshSandboxToken
     */
    refreshSandboxToken: {
        methodKind: "unary";
        input: typeof RefreshSandboxTokenRequestSchema;
        output: typeof RefreshSandboxTokenResponseSchema;
    };
    /**
     * Create a workspace.
     *
     * @generated from rpc openshell.v1.OpenShell.CreateWorkspace
     */
    createWorkspace: {
        methodKind: "unary";
        input: typeof CreateWorkspaceRequestSchema;
        output: typeof CreateWorkspaceResponseSchema;
    };
    /**
     * Fetch a workspace by name.
     *
     * @generated from rpc openshell.v1.OpenShell.GetWorkspace
     */
    getWorkspace: {
        methodKind: "unary";
        input: typeof GetWorkspaceRequestSchema;
        output: typeof GetWorkspaceResponseSchema;
    };
    /**
     * List workspaces.
     *
     * @generated from rpc openshell.v1.OpenShell.ListWorkspaces
     */
    listWorkspaces: {
        methodKind: "unary";
        input: typeof ListWorkspacesRequestSchema;
        output: typeof ListWorkspacesResponseSchema;
    };
    /**
     * Delete a workspace by name.
     *
     * @generated from rpc openshell.v1.OpenShell.DeleteWorkspace
     */
    deleteWorkspace: {
        methodKind: "unary";
        input: typeof DeleteWorkspaceRequestSchema;
        output: typeof DeleteWorkspaceResponseSchema;
    };
    /**
     * Add a member to a workspace.
     *
     * @generated from rpc openshell.v1.OpenShell.AddWorkspaceMember
     */
    addWorkspaceMember: {
        methodKind: "unary";
        input: typeof AddWorkspaceMemberRequestSchema;
        output: typeof AddWorkspaceMemberResponseSchema;
    };
    /**
     * Remove a member from a workspace.
     *
     * @generated from rpc openshell.v1.OpenShell.RemoveWorkspaceMember
     */
    removeWorkspaceMember: {
        methodKind: "unary";
        input: typeof RemoveWorkspaceMemberRequestSchema;
        output: typeof RemoveWorkspaceMemberResponseSchema;
    };
    /**
     * List members of a workspace.
     *
     * @generated from rpc openshell.v1.OpenShell.ListWorkspaceMembers
     */
    listWorkspaceMembers: {
        methodKind: "unary";
        input: typeof ListWorkspaceMembersRequestSchema;
        output: typeof ListWorkspaceMembersResponseSchema;
    };
}>;
//# sourceMappingURL=openshell_pb.d.ts.map