import type { GenExtension, GenFile, GenMessage } from "@bufbuild/protobuf/codegenv2";
import type { FieldOptions, MethodOptions } from "@bufbuild/protobuf/wkt";
import type { Message } from "@bufbuild/protobuf";
/**
 * Describes the file options.proto.
 */
export declare const file_options: GenFile;
/**
 * Per-method authorization rule. Consumed at runtime by the gateway's
 * descriptor-pool-based auth table to enforce auth mode, role, and scope.
 *
 * @generated from message openshell.options.v1.AuthorizationRule
 */
export type AuthorizationRule = Message<"openshell.options.v1.AuthorizationRule"> & {
    /**
     * Authentication mode: "bearer", "sandbox", "dual", "peer", "operator",
     * or "unauthenticated". Operator requires a verified mTLS operator certificate.
     *
     * @generated from field: string auth_mode = 1;
     */
    authMode: string;
    /**
     * Minimum workspace-level role required (checked by handler via
     * authorize_workspace): "user" or "admin". Mutually exclusive with
     * global_role.
     *
     * @generated from field: string workspace_role = 2;
     */
    workspaceRole: string;
    /**
     * Global role required (checked by middleware via OIDC claims):
     * "platform_admin". Mutually exclusive with workspace_role.
     *
     * @generated from field: string global_role = 3;
     */
    globalRole: string;
    /**
     * Required OIDC scope on the bearer path (e.g. "sandbox:read").
     *
     * @generated from field: string scope = 4;
     */
    scope: string;
};
/**
 * Describes the message openshell.options.v1.AuthorizationRule.
 * Use `create(AuthorizationRuleSchema)` to create a new message.
 */
export declare const AuthorizationRuleSchema: GenMessage<AuthorizationRule>;
/**
 * Authorization metadata for a gRPC method.
 *
 * @generated from extension: openshell.options.v1.AuthorizationRule authorization = 50000;
 */
export declare const authorization: GenExtension<MethodOptions, AuthorizationRule>;
/**
 * @generated from extension: bool secret = 50001;
 */
export declare const secret: GenExtension<FieldOptions, boolean>;
//# sourceMappingURL=options_pb.d.ts.map