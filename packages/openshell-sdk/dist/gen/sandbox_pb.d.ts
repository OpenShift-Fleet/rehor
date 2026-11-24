import type { GenEnum, GenFile, GenMessage } from "@bufbuild/protobuf/codegenv2";
import type { Duration } from "@bufbuild/protobuf/wkt";
import type { WorkspaceSelector } from "./datamodel_pb.js";
import type { JsonObject, Message } from "@bufbuild/protobuf";
/**
 * Describes the file sandbox.proto.
 */
export declare const file_sandbox: GenFile;
/**
 * Sandbox security policy configuration.
 *
 * @generated from message openshell.sandbox.v1.SandboxPolicy
 */
export type SandboxPolicy = Message<"openshell.sandbox.v1.SandboxPolicy"> & {
    /**
     * Policy version.
     *
     * @generated from field: uint32 version = 1;
     */
    version: number;
    /**
     * Filesystem access policy.
     *
     * @generated from field: openshell.sandbox.v1.FilesystemPolicy filesystem = 2;
     */
    filesystem?: FilesystemPolicy | undefined;
    /**
     * Landlock configuration.
     *
     * @generated from field: openshell.sandbox.v1.LandlockPolicy landlock = 3;
     */
    landlock?: LandlockPolicy | undefined;
    /**
     * Process execution policy.
     *
     * @generated from field: openshell.sandbox.v1.ProcessPolicy process = 4;
     */
    process?: ProcessPolicy | undefined;
    /**
     * Network access policies keyed by name (e.g. "claude_code", "gitlab").
     *
     * @generated from field: map<string, openshell.sandbox.v1.NetworkPolicyRule> network_policies = 5;
     */
    networkPolicies: {
        [key: string]: NetworkPolicyRule;
    };
    /**
     * Reusable supervisor middleware configs for network egress, keyed by their
     * policy-local names. At most 10 configs are accepted, and at most 10 stages
     * can be selected per request.
     *
     * @generated from field: map<string, openshell.sandbox.v1.NetworkMiddlewareConfig> network_middlewares = 6;
     */
    networkMiddlewares: {
        [key: string]: NetworkMiddlewareConfig;
    };
};
/**
 * Describes the message openshell.sandbox.v1.SandboxPolicy.
 * Use `create(SandboxPolicySchema)` to create a new message.
 */
export declare const SandboxPolicySchema: GenMessage<SandboxPolicy>;
/**
 * Filesystem access policy.
 *
 * @generated from message openshell.sandbox.v1.FilesystemPolicy
 */
export type FilesystemPolicy = Message<"openshell.sandbox.v1.FilesystemPolicy"> & {
    /**
     * Automatically include the workdir as read-write.
     *
     * @generated from field: bool include_workdir = 1;
     */
    includeWorkdir: boolean;
    /**
     * Read-only directory allow list.
     *
     * @generated from field: repeated string read_only = 2;
     */
    readOnly: string[];
    /**
     * Read-write directory allow list.
     *
     * @generated from field: repeated string read_write = 3;
     */
    readWrite: string[];
};
/**
 * Describes the message openshell.sandbox.v1.FilesystemPolicy.
 * Use `create(FilesystemPolicySchema)` to create a new message.
 */
export declare const FilesystemPolicySchema: GenMessage<FilesystemPolicy>;
/**
 * Landlock policy configuration.
 *
 * @generated from message openshell.sandbox.v1.LandlockPolicy
 */
export type LandlockPolicy = Message<"openshell.sandbox.v1.LandlockPolicy"> & {
    /**
     * Compatibility mode (e.g. "best_effort", "hard_requirement").
     *
     * @generated from field: string compatibility = 1;
     */
    compatibility: string;
};
/**
 * Describes the message openshell.sandbox.v1.LandlockPolicy.
 * Use `create(LandlockPolicySchema)` to create a new message.
 */
export declare const LandlockPolicySchema: GenMessage<LandlockPolicy>;
/**
 * Process execution policy.
 *
 * @generated from message openshell.sandbox.v1.ProcessPolicy
 */
export type ProcessPolicy = Message<"openshell.sandbox.v1.ProcessPolicy"> & {
    /**
     * User name to run the sandboxed process as.
     *
     * @generated from field: string run_as_user = 1;
     */
    runAsUser: string;
    /**
     * Group name to run the sandboxed process as.
     *
     * @generated from field: string run_as_group = 2;
     */
    runAsGroup: string;
};
/**
 * Describes the message openshell.sandbox.v1.ProcessPolicy.
 * Use `create(ProcessPolicySchema)` to create a new message.
 */
export declare const ProcessPolicySchema: GenMessage<ProcessPolicy>;
/**
 * A named network access policy rule.
 *
 * @generated from message openshell.sandbox.v1.NetworkPolicyRule
 */
export type NetworkPolicyRule = Message<"openshell.sandbox.v1.NetworkPolicyRule"> & {
    /**
     * Human-readable name for this policy rule.
     *
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * Allowed endpoint (host:port) pairs.
     *
     * @generated from field: repeated openshell.sandbox.v1.NetworkEndpoint endpoints = 2;
     */
    endpoints: NetworkEndpoint[];
    /**
     * Allowed binary identities.
     *
     * @generated from field: repeated openshell.sandbox.v1.NetworkBinary binaries = 3;
     */
    binaries: NetworkBinary[];
};
/**
 * Describes the message openshell.sandbox.v1.NetworkPolicyRule.
 * Use `create(NetworkPolicyRuleSchema)` to create a new message.
 */
export declare const NetworkPolicyRuleSchema: GenMessage<NetworkPolicyRule>;
/**
 * A reusable middleware config selected for admitted egress by host.
 *
 * @generated from message openshell.sandbox.v1.NetworkMiddlewareConfig
 */
export type NetworkMiddlewareConfig = Message<"openshell.sandbox.v1.NetworkMiddlewareConfig"> & {
    /**
     * Human-readable name for this middleware config.
     *
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * Built-in middleware name or operator-owned registration name.
     *
     * @generated from field: string middleware = 2;
     */
    middleware: string;
    /**
     * Service-specific configuration.
     *
     * @generated from field: google.protobuf.Struct config = 3;
     */
    config?: JsonObject | undefined;
    /**
     * Failure behavior: "fail_closed" (default) or "fail_open".
     *
     * @generated from field: string on_error = 4;
     */
    onError: string;
    /**
     * Host selector controlling which admitted destinations use this config.
     *
     * @generated from field: openshell.sandbox.v1.MiddlewareEndpointSelector endpoints = 5;
     */
    endpoints?: MiddlewareEndpointSelector | undefined;
    /**
     * Execution order. Values must be unique within a policy; lower values run first.
     *
     * @generated from field: int32 order = 6;
     */
    order: number;
};
/**
 * Describes the message openshell.sandbox.v1.NetworkMiddlewareConfig.
 * Use `create(NetworkMiddlewareConfigSchema)` to create a new message.
 */
export declare const NetworkMiddlewareConfigSchema: GenMessage<NetworkMiddlewareConfig>;
/**
 * Host selector controlling which admitted destinations use a middleware config.
 *
 * @generated from message openshell.sandbox.v1.MiddlewareEndpointSelector
 */
export type MiddlewareEndpointSelector = Message<"openshell.sandbox.v1.MiddlewareEndpointSelector"> & {
    /**
     * Exact host or DNS glob patterns included in the selection. Include and
     * exclude accept at most 32 combined patterns.
     *
     * @generated from field: repeated string include = 1;
     */
    include: string[];
    /**
     * Exact host or DNS glob patterns removed from the selection.
     * Exclusions take precedence over inclusions.
     *
     * @generated from field: repeated string exclude = 2;
     */
    exclude: string[];
};
/**
 * Describes the message openshell.sandbox.v1.MiddlewareEndpointSelector.
 * Use `create(MiddlewareEndpointSelectorSchema)` to create a new message.
 */
export declare const MiddlewareEndpointSelectorSchema: GenMessage<MiddlewareEndpointSelector>;
/**
 * Binds a policy endpoint to static credentials from a sandbox provider.
 *
 * @generated from message openshell.sandbox.v1.NetworkCredentialBinding
 */
export type NetworkCredentialBinding = Message<"openshell.sandbox.v1.NetworkCredentialBinding"> & {
    /**
     * Name of the provider attached to this sandbox whose static credentials
     * may be resolved for requests admitted by this endpoint.
     *
     * @generated from field: string provider = 1;
     */
    provider: string;
};
/**
 * Describes the message openshell.sandbox.v1.NetworkCredentialBinding.
 * Use `create(NetworkCredentialBindingSchema)` to create a new message.
 */
export declare const NetworkCredentialBindingSchema: GenMessage<NetworkCredentialBinding>;
/**
 * A network endpoint (host + port) with optional L7 inspection config.
 *
 * @generated from message openshell.sandbox.v1.NetworkEndpoint
 */
export type NetworkEndpoint = Message<"openshell.sandbox.v1.NetworkEndpoint"> & {
    /**
     * Hostname or host glob pattern. Exact match is case-insensitive.
     * Glob patterns use "." as delimiter: "*.example.com" matches a single
     * subdomain label, "**.example.com" matches across labels.
     *
     * @generated from field: string host = 1;
     */
    host: string;
    /**
     * Single port (backwards compat). Use `ports` for multiple ports.
     * Mutually exclusive with `ports` — if both are set, `ports` takes precedence.
     *
     * @generated from field: uint32 port = 2;
     */
    port: number;
    /**
     * Endpoint protocol. "tcp" and "" select L4-only handling; "rest",
     * "websocket", "graphql", "sql", "json-rpc", and "mcp" select L7 inspection.
     *
     * @generated from field: string protocol = 3;
     */
    protocol: string;
    /**
     * TLS handling. Unspecified enables automatic detection and termination.
     *
     * @generated from field: openshell.sandbox.v1.NetworkTlsMode tls = 4;
     */
    tls: NetworkTlsMode;
    /**
     * Enforcement mode. Unspecified preserves the audit default.
     *
     * @generated from field: openshell.sandbox.v1.NetworkEnforcementMode enforcement = 5;
     */
    enforcement: NetworkEnforcementMode;
    /**
     * Access preset shorthand. Unspecified means no preset.
     * Mutually exclusive with rules.
     *
     * @generated from field: openshell.sandbox.v1.NetworkAccessPreset access = 6;
     */
    access: NetworkAccessPreset;
    /**
     * Explicit L7 rules (mutually exclusive with access).
     *
     * @generated from field: repeated openshell.sandbox.v1.L7Rule rules = 7;
     */
    rules: L7Rule[];
    /**
     * Allowed resolved IP addresses or CIDR ranges for this endpoint.
     * When non-empty, the SSRF internal-IP check is replaced by an allowlist check:
     *   - If host is also set: domain must resolve to an IP in this list.
     *   - If host is empty: any domain is allowed as long as it resolves to an IP in this list.
     * Supports exact IPs ("10.0.5.20") and CIDR notation ("10.0.5.0/24").
     * Loopback (127.0.0.0/8) and link-local (169.254.0.0/16) are always blocked
     * regardless of this field.
     *
     * @generated from field: repeated string allowed_ips = 8;
     */
    allowedIps: string[];
    /**
     * Multiple ports. When non-empty, this endpoint covers all listed ports.
     * If `port` is set and `ports` is empty, `port` is normalized to `ports: [port]`.
     * If both are set, `ports` takes precedence.
     *
     * @generated from field: repeated uint32 ports = 9;
     */
    ports: number[];
    /**
     * Explicit L7 deny rules. When present, requests matching any deny rule
     * are blocked even if they match an allow rule or access preset.
     * Deny rules take precedence over allow rules.
     *
     * @generated from field: repeated openshell.sandbox.v1.L7DenyRule deny_rules = 10;
     */
    denyRules: L7DenyRule[];
    /**
     * When true, percent-encoded '/' (%2F) is preserved in path segments
     * rather than rejected by the L7 path canonicalizer. Required for
     * upstreams like GitLab that embed %2F in namespaced resource paths.
     * Defaults to false (strict).
     *
     * @generated from field: bool allow_encoded_slash = 11;
     */
    allowEncodedSlash: boolean;
    /**
     * GraphQL persisted-query behavior for hash-only/saved-query requests:
     * "deny" (default) or "allow_registered".
     *
     * @generated from field: string persisted_queries = 12;
     */
    persistedQueries: string;
    /**
     * Trusted GraphQL persisted-query registry keyed by hash or service-specific ID.
     * Only used when persisted_queries is "allow_registered".
     *
     * @generated from field: map<string, openshell.sandbox.v1.GraphqlOperation> graphql_persisted_queries = 13;
     */
    graphqlPersistedQueries: {
        [key: string]: GraphqlOperation;
    };
    /**
     * Maximum GraphQL request body bytes to buffer for inspection.
     * Defaults to 65536 when unset.
     *
     * @generated from field: uint32 graphql_max_body_bytes = 14;
     */
    graphqlMaxBodyBytes: number;
    /**
     * Optional HTTP path glob that scopes this L7 endpoint on shared host:port APIs.
     * Example: use path "/graphql" for protocol "graphql" and "/repos/**" for
     * protocol "rest" when both surfaces live under api.example.com:443.
     * Empty means all paths.
     *
     * @generated from field: string path = 15;
     */
    path: string;
    /**
     * When true on a "rest" endpoint, OpenShell rewrites credential placeholders
     * inside client-to-server WebSocket text messages after an allowed HTTP 101
     * upgrade. Defaults to false.
     *
     * @generated from field: bool websocket_credential_rewrite = 16;
     */
    websocketCredentialRewrite: boolean;
    /**
     * When true on a "rest" endpoint, OpenShell rewrites credential placeholders
     * inside supported textual HTTP request bodies before forwarding upstream.
     * Defaults to false.
     *
     * @generated from field: bool request_body_credential_rewrite = 17;
     */
    requestBodyCredentialRewrite: boolean;
    /**
     * Internal provenance marker for policy-advisor generated endpoints.
     * Advisor-proposed endpoints must not satisfy exact-host SSRF trust unless
     * they are converted through an explicit user-authored policy path.
     *
     * @generated from field: bool advisor_proposed = 18;
     */
    advisorProposed: boolean;
    /**
     * Proxy-side credential signing mode: "sigv4" for AWS SigV4 re-signing.
     * When set, the proxy strips the client's Authorization header and computes
     * a fresh SigV4 signature using real credentials from the provider.
     *
     * @generated from field: string credential_signing = 19;
     */
    credentialSigning: string;
    /**
     * AWS signing service name override. Required when credential_signing is
     * "sigv4" — e.g. "bedrock" for bedrock-runtime endpoints.
     *
     * @generated from field: string signing_service = 20;
     */
    signingService: string;
    /**
     * AWS region override for SigV4 signing. When set, takes precedence over
     * hostname-based region extraction. Required for non-standard endpoints.
     *
     * @generated from field: string signing_region = 21;
     */
    signingRegion: string;
    /**
     * Maximum JSON-RPC-over-HTTP request body bytes to buffer for inspection.
     * Defaults to 65536 when unset.
     *
     * @generated from field: uint32 json_rpc_max_body_bytes = 22;
     */
    jsonRpcMaxBodyBytes: number;
    /**
     * MCP-only policy and inspection options. Only used when protocol is "mcp".
     *
     * @generated from field: openshell.sandbox.v1.McpOptions mcp = 23;
     */
    mcp?: McpOptions | undefined;
    /**
     * Explicit binding authority for static credentials from an attached
     * endpointless provider profile. Profiles that already define endpoints
     * continue to use those profile endpoints as their credential boundary.
     *
     * @generated from field: openshell.sandbox.v1.NetworkCredentialBinding credential_binding = 24;
     */
    credentialBinding?: NetworkCredentialBinding | undefined;
    /**
     * Explicitly permits credential-bearing traffic to use paths that OpenShell
     * cannot inspect or rewrite. Defaults to false. This is a security-sensitive
     * escape hatch and must be explicitly approved.
     *
     * @generated from field: bool allow_uninspected_credentials = 25;
     */
    allowUninspectedCredentials: boolean;
    /**
     * Internal gateway-derived marker indicating that this endpoint belongs to
     * an attached credentialed provider. User-authored values are ignored.
     *
     * @generated from field: bool provider_credentialed = 26;
     */
    providerCredentialed: boolean;
    /**
     * Internal gateway-derived identity of this endpoint's token-grant authority.
     * It binds the provider record and complete profile policy, or the active
     * global policy, to this endpoint. User-authored values are ignored.
     *
     * @generated from field: string token_grant_owner = 27;
     */
    tokenGrantOwner: string;
};
/**
 * Describes the message openshell.sandbox.v1.NetworkEndpoint.
 * Use `create(NetworkEndpointSchema)` to create a new message.
 */
export declare const NetworkEndpointSchema: GenMessage<NetworkEndpoint>;
/**
 * MCP options are grouped so MCP-specific policy can grow without adding more
 * top-level NetworkEndpoint fields. OpenShell owns the supported revision
 * profiles instead of treating dependency enums as the policy contract.
 *
 * Sources:
 * - https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 * - https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 * - https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 *
 * @generated from message openshell.sandbox.v1.McpOptions
 */
export type McpOptions = Message<"openshell.sandbox.v1.McpOptions"> & {
    /**
     * Hardening boundary for tools/call params.name. When unset or true, the
     * supervisor enforces the MCP recommended tool-name syntax
     * ^[A-Za-z0-9_.-]{1,128}$ before policy evaluation. Set false only for
     * compatibility with servers that intentionally use non-recommended names.
     *
     * Source:
     * - https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-names
     *
     * @generated from field: optional bool strict_tool_names = 1;
     */
    strictToolNames?: boolean | undefined;
    /**
     * Method-layer default for MCP endpoints. When true, OpenShell allows parsed
     * MCP-family methods at the method layer unless a tool-name policy narrows
     * tools/call. When unset or false, explicit method rules are required.
     *
     * @generated from field: optional bool allow_all_known_mcp_methods = 2;
     */
    allowAllKnownMcpMethods?: boolean | undefined;
    /**
     * Exact MCP protocol revisions accepted by the endpoint's policy schema.
     * Authors may omit this field. Because proto3 repeated fields do not retain
     * presence, omission reaches protobuf ingress as an empty list. Checked
     * normalization materializes OpenShell's pinned default revision
     * "2025-11-25" before producing canonical downstream state, which is always
     * nonempty.
     *
     * An explicit nonempty list remains an exact allowlist. Duplicates, moving
     * aliases such as "draft" and "latest", and unknown dates are invalid.
     * Normalization stores valid values in canonical semantic order. These
     * values identify core revisions; they do not enable separate SEP overlays
     * or select runtime parsing and forwarding behavior.
     *
     * @generated from field: repeated string versions = 3;
     */
    versions: string[];
};
/**
 * Describes the message openshell.sandbox.v1.McpOptions.
 * Use `create(McpOptionsSchema)` to create a new message.
 */
export declare const McpOptionsSchema: GenMessage<McpOptions>;
/**
 * Trusted GraphQL operation classification.
 *
 * @generated from message openshell.sandbox.v1.GraphqlOperation
 */
export type GraphqlOperation = Message<"openshell.sandbox.v1.GraphqlOperation"> & {
    /**
     * Operation type: "query", "mutation", or "subscription".
     *
     * @generated from field: string operation_type = 1;
     */
    operationType: string;
    /**
     * Operation name, if known.
     *
     * @generated from field: string operation_name = 2;
     */
    operationName: string;
    /**
     * Root field names selected by the operation.
     *
     * @generated from field: repeated string fields = 3;
     */
    fields: string[];
};
/**
 * Describes the message openshell.sandbox.v1.GraphqlOperation.
 * Use `create(GraphqlOperationSchema)` to create a new message.
 */
export declare const GraphqlOperationSchema: GenMessage<GraphqlOperation>;
/**
 * An L7 deny rule that blocks specific requests.
 * Mirrors L7Allow — same fields, same matching semantics, inverted effect.
 * Deny rules are evaluated after allow rules and take precedence.
 *
 * @generated from message openshell.sandbox.v1.L7DenyRule
 */
export type L7DenyRule = Message<"openshell.sandbox.v1.L7DenyRule"> & {
    /**
     * Protocol method: HTTP method (REST/WebSocket), JSON-RPC method name, or
     * "*" for any when supported by the protocol.
     *
     * @generated from field: string method = 1;
     */
    method: string;
    /**
     * URL path glob pattern (REST): "/repos/*\/pulls/*\/reviews", "**" for any.
     *
     * @generated from field: string path = 2;
     */
    path: string;
    /**
     * SQL command (SQL): SELECT, INSERT, etc. or "*" for any.
     *
     * @generated from field: string command = 3;
     */
    command: string;
    /**
     * Query parameter matcher map (REST).
     * Same semantics as L7Allow.query.
     *
     * @generated from field: map<string, openshell.sandbox.v1.L7QueryMatcher> query = 4;
     */
    query: {
        [key: string]: L7QueryMatcher;
    };
    /**
     * GraphQL operation type: "query", "mutation", "subscription", or "*" for any.
     *
     * @generated from field: string operation_type = 5;
     */
    operationType: string;
    /**
     * GraphQL operation name glob. "*" matches any operation name.
     *
     * @generated from field: string operation_name = 6;
     */
    operationName: string;
    /**
     * GraphQL root field globs. Deny rules match when any selected root field
     * matches any configured glob.
     *
     * @generated from field: repeated string fields = 7;
     */
    fields: string[];
    /**
     * MCP params matcher map. Currently only params.name is supported for
     * tools/call filtering. Generic protocol "json-rpc" rejects params matchers.
     *
     * @generated from field: map<string, openshell.sandbox.v1.L7QueryMatcher> params = 9;
     */
    params: {
        [key: string]: L7QueryMatcher;
    };
};
/**
 * Describes the message openshell.sandbox.v1.L7DenyRule.
 * Use `create(L7DenyRuleSchema)` to create a new message.
 */
export declare const L7DenyRuleSchema: GenMessage<L7DenyRule>;
/**
 * An L7 policy rule (allow-only).
 *
 * @generated from message openshell.sandbox.v1.L7Rule
 */
export type L7Rule = Message<"openshell.sandbox.v1.L7Rule"> & {
    /**
     * @generated from field: openshell.sandbox.v1.L7Allow allow = 1;
     */
    allow?: L7Allow | undefined;
};
/**
 * Describes the message openshell.sandbox.v1.L7Rule.
 * Use `create(L7RuleSchema)` to create a new message.
 */
export declare const L7RuleSchema: GenMessage<L7Rule>;
/**
 * Allowed action definition for L7 rules.
 *
 * @generated from message openshell.sandbox.v1.L7Allow
 */
export type L7Allow = Message<"openshell.sandbox.v1.L7Allow"> & {
    /**
     * Protocol method: HTTP method (REST/WebSocket), JSON-RPC method name, or
     * "*" for any when supported by the protocol.
     *
     * @generated from field: string method = 1;
     */
    method: string;
    /**
     * URL path glob pattern (REST): "/repos/**", "**" for any.
     *
     * @generated from field: string path = 2;
     */
    path: string;
    /**
     * SQL command (SQL): SELECT, INSERT, etc. or "*" for any.
     *
     * @generated from field: string command = 3;
     */
    command: string;
    /**
     * Query parameter matcher map (REST).
     * Key is the decoded query parameter name (case-sensitive).
     * Value supports either a single glob (`glob`) or a list (`any`).
     *
     * @generated from field: map<string, openshell.sandbox.v1.L7QueryMatcher> query = 4;
     */
    query: {
        [key: string]: L7QueryMatcher;
    };
    /**
     * GraphQL operation type: "query", "mutation", "subscription", or "*" for any.
     *
     * @generated from field: string operation_type = 5;
     */
    operationType: string;
    /**
     * GraphQL operation name glob. "*" matches any operation name.
     *
     * @generated from field: string operation_name = 6;
     */
    operationName: string;
    /**
     * GraphQL root field globs. Allow rules match only when every selected root
     * field matches one of the configured globs. Omit to match all fields.
     *
     * @generated from field: repeated string fields = 7;
     */
    fields: string[];
    /**
     * MCP params matcher map. Currently only params.name is supported for
     * tools/call filtering. Generic protocol "json-rpc" rejects params matchers.
     *
     * @generated from field: map<string, openshell.sandbox.v1.L7QueryMatcher> params = 9;
     */
    params: {
        [key: string]: L7QueryMatcher;
    };
};
/**
 * Describes the message openshell.sandbox.v1.L7Allow.
 * Use `create(L7AllowSchema)` to create a new message.
 */
export declare const L7AllowSchema: GenMessage<L7Allow>;
/**
 * Query value matcher for one query parameter key.
 *
 * @generated from message openshell.sandbox.v1.L7QueryMatcher
 */
export type L7QueryMatcher = Message<"openshell.sandbox.v1.L7QueryMatcher"> & {
    /**
     * Single glob pattern.
     *
     * @generated from field: string glob = 1;
     */
    glob: string;
    /**
     * Any-of glob patterns.
     *
     * @generated from field: repeated string any = 2;
     */
    any: string[];
};
/**
 * Describes the message openshell.sandbox.v1.L7QueryMatcher.
 * Use `create(L7QueryMatcherSchema)` to create a new message.
 */
export declare const L7QueryMatcherSchema: GenMessage<L7QueryMatcher>;
/**
 * A binary identity for network policy matching.
 *
 * @generated from message openshell.sandbox.v1.NetworkBinary
 */
export type NetworkBinary = Message<"openshell.sandbox.v1.NetworkBinary"> & {
    /**
     * @generated from field: string path = 1;
     */
    path: string;
};
/**
 * Describes the message openshell.sandbox.v1.NetworkBinary.
 * Use `create(NetworkBinarySchema)` to create a new message.
 */
export declare const NetworkBinarySchema: GenMessage<NetworkBinary>;
/**
 * Request to get sandbox settings by sandbox name.
 *
 * @generated from message openshell.sandbox.v1.GetSandboxConfigRequest
 */
export type GetSandboxConfigRequest = Message<"openshell.sandbox.v1.GetSandboxConfigRequest"> & {
    /**
     * Workspace scope. Select one named workspace; authenticated sandbox callers may omit it during bootstrap.
     *
     * @generated from field: openshell.datamodel.v1.WorkspaceSelector workspace_scope = 3;
     */
    workspaceScope?: WorkspaceSelector | undefined;
    /**
     * @generated from field: string name = 1;
     */
    name: string;
};
/**
 * Describes the message openshell.sandbox.v1.GetSandboxConfigRequest.
 * Use `create(GetSandboxConfigRequestSchema)` to create a new message.
 */
export declare const GetSandboxConfigRequestSchema: GenMessage<GetSandboxConfigRequest>;
/**
 * Request to get gateway-global settings.
 *
 * @generated from message openshell.sandbox.v1.GetGatewayConfigRequest
 */
export type GetGatewayConfigRequest = Message<"openshell.sandbox.v1.GetGatewayConfigRequest"> & {};
/**
 * Describes the message openshell.sandbox.v1.GetGatewayConfigRequest.
 * Use `create(GetGatewayConfigRequestSchema)` to create a new message.
 */
export declare const GetGatewayConfigRequestSchema: GenMessage<GetGatewayConfigRequest>;
/**
 * Response containing gateway-global settings.
 *
 * @generated from message openshell.sandbox.v1.GetGatewayConfigResponse
 */
export type GetGatewayConfigResponse = Message<"openshell.sandbox.v1.GetGatewayConfigResponse"> & {
    /**
     * Gateway-global settings map excluding the reserved policy key.
     * Registered keys without a configured value are returned with an empty SettingValue.
     *
     * @generated from field: map<string, openshell.sandbox.v1.SettingValue> settings = 1;
     */
    settings: {
        [key: string]: SettingValue;
    };
    /**
     * Monotonically increasing revision for gateway-global settings.
     *
     * @generated from field: uint64 settings_revision = 2;
     */
    settingsRevision: bigint;
};
/**
 * Describes the message openshell.sandbox.v1.GetGatewayConfigResponse.
 * Use `create(GetGatewayConfigResponseSchema)` to create a new message.
 */
export declare const GetGatewayConfigResponseSchema: GenMessage<GetGatewayConfigResponse>;
/**
 * Type-aware setting value for sandbox/gateway settings.
 *
 * @generated from message openshell.sandbox.v1.SettingValue
 */
export type SettingValue = Message<"openshell.sandbox.v1.SettingValue"> & {
    /**
     * @generated from oneof openshell.sandbox.v1.SettingValue.value
     */
    value: {
        /**
         * @generated from field: string string_value = 1;
         */
        value: string;
        case: "stringValue";
    } | {
        /**
         * @generated from field: bool bool_value = 2;
         */
        value: boolean;
        case: "boolValue";
    } | {
        /**
         * @generated from field: int64 int_value = 3;
         */
        value: bigint;
        case: "intValue";
    } | {
        /**
         * @generated from field: bytes bytes_value = 4;
         */
        value: Uint8Array;
        case: "bytesValue";
    } | {
        case: undefined;
        value?: undefined;
    };
};
/**
 * Describes the message openshell.sandbox.v1.SettingValue.
 * Use `create(SettingValueSchema)` to create a new message.
 */
export declare const SettingValueSchema: GenMessage<SettingValue>;
/**
 * Effective setting value and the scope it was resolved from.
 *
 * @generated from message openshell.sandbox.v1.EffectiveSetting
 */
export type EffectiveSetting = Message<"openshell.sandbox.v1.EffectiveSetting"> & {
    /**
     * @generated from field: openshell.sandbox.v1.SettingValue value = 1;
     */
    value?: SettingValue | undefined;
    /**
     * @generated from field: openshell.sandbox.v1.SettingScope scope = 2;
     */
    scope: SettingScope;
};
/**
 * Describes the message openshell.sandbox.v1.EffectiveSetting.
 * Use `create(EffectiveSettingSchema)` to create a new message.
 */
export declare const EffectiveSettingSchema: GenMessage<EffectiveSetting>;
/**
 * Complete effective sandbox configuration delivered to a supervisor. Fields
 * have the same meaning as the identically numbered GetSandboxConfigResponse
 * fields, including fail-closed handling of an unknown
 * policy_validation_failure_mode and treating absent configuration_admitted as
 * not admitted. Move those field comments here when the polling RPC is removed.
 *
 * @generated from message openshell.sandbox.v1.SandboxConfigSnapshot
 */
export type SandboxConfigSnapshot = Message<"openshell.sandbox.v1.SandboxConfigSnapshot"> & {
    /**
     * @generated from field: openshell.sandbox.v1.SandboxPolicy policy = 1;
     */
    policy?: SandboxPolicy | undefined;
    /**
     * @generated from field: uint32 version = 2;
     */
    version: number;
    /**
     * @generated from field: string policy_hash = 3;
     */
    policyHash: string;
    /**
     * @generated from field: map<string, openshell.sandbox.v1.EffectiveSetting> settings = 4;
     */
    settings: {
        [key: string]: EffectiveSetting;
    };
    /**
     * @generated from field: uint64 config_revision = 5;
     */
    configRevision: bigint;
    /**
     * @generated from field: openshell.sandbox.v1.PolicySource policy_source = 6;
     */
    policySource: PolicySource;
    /**
     * @generated from field: uint32 global_policy_version = 7;
     */
    globalPolicyVersion: number;
    /**
     * @generated from field: uint64 provider_env_revision = 8;
     */
    providerEnvRevision: bigint;
    /**
     * @generated from field: repeated openshell.sandbox.v1.SupervisorMiddlewareService supervisor_middleware_services = 9;
     */
    supervisorMiddlewareServices: SupervisorMiddlewareService[];
    /**
     * @generated from field: string workspace = 10;
     */
    workspace: string;
    /**
     * @generated from field: string policy_validation_failure_mode = 11;
     */
    policyValidationFailureMode: string;
    /**
     * @generated from field: bool extension_authentication_enabled = 12;
     */
    extensionAuthenticationEnabled: boolean;
    /**
     * @generated from field: bool configuration_admitted = 13;
     */
    configurationAdmitted: boolean;
    /**
     * @generated from field: string provider_attachment_epoch = 14;
     */
    providerAttachmentEpoch: string;
    /**
     * @generated from field: string configuration_instance_id = 15;
     */
    configurationInstanceId: string;
    /**
     * @generated from field: string configuration_error = 16;
     */
    configurationError: string;
    /**
     * @generated from field: uint64 settings_revision = 17;
     */
    settingsRevision: bigint;
};
/**
 * Describes the message openshell.sandbox.v1.SandboxConfigSnapshot.
 * Use `create(SandboxConfigSnapshotSchema)` to create a new message.
 */
export declare const SandboxConfigSnapshotSchema: GenMessage<SandboxConfigSnapshot>;
/**
 * Response containing effective sandbox settings and policy, projected from
 * the SandboxConfigSnapshot that push supervisors receive.
 *
 * @generated from message openshell.sandbox.v1.GetSandboxConfigResponse
 */
export type GetSandboxConfigResponse = Message<"openshell.sandbox.v1.GetSandboxConfigResponse"> & {
    /**
     * The sandbox policy configuration.
     *
     * @generated from field: openshell.sandbox.v1.SandboxPolicy policy = 1;
     */
    policy?: SandboxPolicy | undefined;
    /**
     * Current policy version (monotonically increasing per sandbox).
     *
     * @generated from field: uint32 version = 2;
     */
    version: number;
    /**
     * SHA-256 hash of the serialized policy payload.
     *
     * @generated from field: string policy_hash = 3;
     */
    policyHash: string;
    /**
     * Effective settings resolved for this sandbox, excluding the reserved policy key.
     * Registered keys without a configured value are returned with an empty EffectiveSetting.value.
     *
     * @generated from field: map<string, openshell.sandbox.v1.EffectiveSetting> settings = 4;
     */
    settings: {
        [key: string]: EffectiveSetting;
    };
    /**
     * Fingerprint for effective config (policy + settings). Changes when any effective input changes.
     *
     * @generated from field: uint64 config_revision = 5;
     */
    configRevision: bigint;
    /**
     * Source of the policy payload for this response.
     *
     * @generated from field: openshell.sandbox.v1.PolicySource policy_source = 6;
     */
    policySource: PolicySource;
    /**
     * When policy_source is GLOBAL, the version of the global policy revision.
     * Zero when no global policy is active or when policy_source is SANDBOX.
     *
     * @generated from field: uint32 global_policy_version = 7;
     */
    globalPolicyVersion: number;
    /**
     * Fingerprint for provider credential inputs attached to this sandbox.
     * Changes when attached provider names or attached provider records change.
     *
     * @generated from field: uint64 provider_env_revision = 8;
     */
    providerEnvRevision: bigint;
    /**
     * Operator-registered supervisor middleware services required by the
     * effective policy. Built-in middleware is not included.
     *
     * @generated from field: repeated openshell.sandbox.v1.SupervisorMiddlewareService supervisor_middleware_services = 9;
     */
    supervisorMiddlewareServices: SupervisorMiddlewareService[];
    /**
     * Workspace the sandbox belongs to. Allows the supervisor to learn its
     * workspace context for subsequent workspace-scoped RPCs.
     *
     * @generated from field: string workspace = 10;
     */
    workspace: string;
    /**
     * Gateway-configured posture for rejected policy generations. Valid values
     * are "fail_closed" and "retain_last_valid". Unknown or empty values must
     * be treated as fail_closed by the supervisor.
     *
     * @generated from field: string policy_validation_failure_mode = 11;
     */
    policyValidationFailureMode: string;
    /**
     * Whether this gateway can mint authenticated extension credentials.
     * False also covers older gateways that do not advertise this capability;
     * supervisors preserve their legacy unauthenticated connection behavior.
     *
     * @generated from field: bool extension_authentication_enabled = 12;
     */
    extensionAuthenticationEnabled: boolean;
    /**
     * Gateway-owned attachment identity captured with this desired configuration.
     * Compare for equality; reattachment invalidates previous installation evidence.
     *
     * @generated from field: string provider_attachment_epoch = 14;
     */
    providerAttachmentEpoch: string;
    /**
     * True only after validating this complete policy/provider composition.
     * Missing (older gateway) is deliberately not admission.
     *
     * @generated from field: bool configuration_admitted = 13;
     */
    configurationAdmitted: boolean;
    /**
     * Bounded, credential-free admission diagnostic. Empty for admitted policy.
     *
     * @generated from field: string configuration_error = 16;
     */
    configurationError: string;
    /**
     * Registration fence for a new supervisor; capture once and retain on retry.
     *
     * @generated from field: string configuration_instance_id = 15;
     */
    configurationInstanceId: string;
    /**
     * Monotonic revision of the sandbox-scoped settings row.
     *
     * @generated from field: uint64 settings_revision = 17;
     */
    settingsRevision: bigint;
};
/**
 * Describes the message openshell.sandbox.v1.GetSandboxConfigResponse.
 * Use `create(GetSandboxConfigResponseSchema)` to create a new message.
 */
export declare const GetSandboxConfigResponseSchema: GenMessage<GetSandboxConfigResponse>;
/**
 * Connection details for one operator-registered supervisor middleware service.
 * V1 supports plaintext and server-authenticated TLS gRPC.
 *
 * @generated from message openshell.sandbox.v1.SupervisorMiddlewareService
 */
export type SupervisorMiddlewareService = Message<"openshell.sandbox.v1.SupervisorMiddlewareService"> & {
    /**
     * Operator-owned registration name used by policy attachments and diagnostics.
     *
     * @generated from field: string name = 1;
     */
    name: string;
    /**
     * gRPC endpoint reachable from the sandbox supervisor.
     *
     * @generated from field: string grpc_endpoint = 2;
     */
    grpcEndpoint: string;
    /**
     * Operator-owned logical payload limit applied to every binding exposed by
     * the service. This caps HTTP bodies and complete WebSocket messages.
     *
     * @generated from field: uint64 max_payload_bytes = 3;
     */
    maxPayloadBytes: bigint;
    /**
     * Default RPC timeout for this service. Absence uses the platform default of
     * 500ms. Values must be between 10ms and 30s.
     *
     * @generated from field: google.protobuf.Duration request_timeout = 104;
     */
    requestTimeout?: Duration | undefined;
    /**
     * PEM-encoded trust roots loaded by the gateway from the operator-configured
     * tls_ca_cert_path. Empty uses the platform trust store.
     *
     * @generated from field: bytes tls_ca_cert_pem = 5;
     */
    tlsCaCertPem: Uint8Array;
    /**
     * Exact JWT audience for this service. The gateway resolves an omitted
     * operator value to a kind-scoped audience derived from the registration
     * name before sending sandbox config.
     *
     * @generated from field: string audience = 6;
     */
    audience: string;
    /**
     * Operator opt-out from extension authentication for this registration.
     * When true the service may use a plaintext endpoint and OpenShell attaches
     * no bearer credential; supervisors must not request one. Intended only for
     * trusted-network development deployments.
     *
     * @generated from field: bool allow_insecure_transport = 7;
     */
    allowInsecureTransport: boolean;
};
/**
 * Describes the message openshell.sandbox.v1.SupervisorMiddlewareService.
 * Use `create(SupervisorMiddlewareServiceSchema)` to create a new message.
 */
export declare const SupervisorMiddlewareServiceSchema: GenMessage<SupervisorMiddlewareService>;
/**
 * TLS handling for a network endpoint.
 *
 * @generated from enum openshell.sandbox.v1.NetworkTlsMode
 */
export declare enum NetworkTlsMode {
    /**
     * Auto-detect TLS and terminate it when inspection is configured.
     *
     * @generated from enum value: NETWORK_TLS_MODE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * Disable TLS detection and relay the connection without inspection.
     *
     * @generated from enum value: NETWORK_TLS_MODE_SKIP = 1;
     */
    SKIP = 1,
    /**
     * Rejected by policy validation; use NETWORK_TLS_MODE_UNSPECIFIED.
     *
     * @generated from enum value: NETWORK_TLS_MODE_TERMINATE = 2 [deprecated = true];
     * @deprecated
     */
    TERMINATE = 2,
    /**
     * Rejected by policy validation; use NETWORK_TLS_MODE_UNSPECIFIED.
     *
     * @generated from enum value: NETWORK_TLS_MODE_PASSTHROUGH = 3 [deprecated = true];
     * @deprecated
     */
    PASSTHROUGH = 3
}
/**
 * Describes the enum openshell.sandbox.v1.NetworkTlsMode.
 */
export declare const NetworkTlsModeSchema: GenEnum<NetworkTlsMode>;
/**
 * Enforcement behavior for inspected network traffic.
 *
 * @generated from enum openshell.sandbox.v1.NetworkEnforcementMode
 */
export declare enum NetworkEnforcementMode {
    /**
     * Preserve the existing default: log violations and allow traffic.
     *
     * @generated from enum value: NETWORK_ENFORCEMENT_MODE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * Deny traffic that does not satisfy the endpoint policy.
     *
     * @generated from enum value: NETWORK_ENFORCEMENT_MODE_ENFORCE = 1;
     */
    ENFORCE = 1,
    /**
     * Log policy violations and allow the traffic.
     *
     * @generated from enum value: NETWORK_ENFORCEMENT_MODE_AUDIT = 2;
     */
    AUDIT = 2
}
/**
 * Describes the enum openshell.sandbox.v1.NetworkEnforcementMode.
 */
export declare const NetworkEnforcementModeSchema: GenEnum<NetworkEnforcementMode>;
/**
 * Shorthand access policy for an inspected network endpoint.
 *
 * @generated from enum openshell.sandbox.v1.NetworkAccessPreset
 */
export declare enum NetworkAccessPreset {
    /**
     * No access preset; explicit rules may define allowed traffic.
     *
     * @generated from enum value: NETWORK_ACCESS_PRESET_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * Allow read-only operations for the selected protocol.
     *
     * @generated from enum value: NETWORK_ACCESS_PRESET_READ_ONLY = 1;
     */
    READ_ONLY = 1,
    /**
     * Allow read and write operations for the selected protocol.
     *
     * @generated from enum value: NETWORK_ACCESS_PRESET_READ_WRITE = 2;
     */
    READ_WRITE = 2,
    /**
     * Allow every operation supported by the selected protocol.
     *
     * @generated from enum value: NETWORK_ACCESS_PRESET_FULL = 3;
     */
    FULL = 3
}
/**
 * Describes the enum openshell.sandbox.v1.NetworkAccessPreset.
 */
export declare const NetworkAccessPresetSchema: GenEnum<NetworkAccessPreset>;
/**
 * Scope that currently controls a setting.
 *
 * @generated from enum openshell.sandbox.v1.SettingScope
 */
export declare enum SettingScope {
    /**
     * @generated from enum value: SETTING_SCOPE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: SETTING_SCOPE_SANDBOX = 1;
     */
    SANDBOX = 1,
    /**
     * @generated from enum value: SETTING_SCOPE_GLOBAL = 2;
     */
    GLOBAL = 2
}
/**
 * Describes the enum openshell.sandbox.v1.SettingScope.
 */
export declare const SettingScopeSchema: GenEnum<SettingScope>;
/**
 * Source used for a sandbox configuration payload.
 *
 * @generated from enum openshell.sandbox.v1.PolicySource
 */
export declare enum PolicySource {
    /**
     * @generated from enum value: POLICY_SOURCE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: POLICY_SOURCE_SANDBOX = 1;
     */
    SANDBOX = 1,
    /**
     * @generated from enum value: POLICY_SOURCE_GLOBAL = 2;
     */
    GLOBAL = 2
}
/**
 * Describes the enum openshell.sandbox.v1.PolicySource.
 */
export declare const PolicySourceSchema: GenEnum<PolicySource>;
//# sourceMappingURL=sandbox_pb.d.ts.map