// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { enumDesc, fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv2";
import { file_options } from "./options_pb.js";
import { file_google_protobuf_timestamp } from "@bufbuild/protobuf/wkt";
/**
 * Describes the file datamodel.proto.
 */
export const file_datamodel = /*@__PURE__*/ fileDesc("Cg9kYXRhbW9kZWwucHJvdG8SFm9wZW5zaGVsbC5kYXRhbW9kZWwudjEidgoRV29ya3NwYWNlU2VsZWN0b3ISEwoJd29ya3NwYWNlGAEgASgJSAASPwoOYWxsX3dvcmtzcGFjZXMYAiABKAsyJS5vcGVuc2hlbGwuZGF0YW1vZGVsLnYxLkFsbFdvcmtzcGFjZXNIAEILCglzZWxlY3Rpb24iDwoNQWxsV29ya3NwYWNlcyLXAwoKT2JqZWN0TWV0YRIKCgJpZBgBIAEoCRIMCgRuYW1lGAIgASgJEjAKDGNyZWF0ZWRfdGltZRhnIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbXASPgoGbGFiZWxzGAQgAygLMi4ub3BlbnNoZWxsLmRhdGFtb2RlbC52MS5PYmplY3RNZXRhLkxhYmVsc0VudHJ5EhgKEHJlc291cmNlX3ZlcnNpb24YBSABKAQSSAoLYW5ub3RhdGlvbnMYBiADKAsyMy5vcGVuc2hlbGwuZGF0YW1vZGVsLnYxLk9iamVjdE1ldGEuQW5ub3RhdGlvbnNFbnRyeRIRCgl3b3Jrc3BhY2UYByABKAkSMQoNZGVsZXRpb25fdGltZRhsIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbXAaLQoLTGFiZWxzRW50cnkSCwoDa2V5GAEgASgJEg0KBXZhbHVlGAIgASgJOgI4ARoyChBBbm5vdGF0aW9uc0VudHJ5EgsKA2tleRgBIAEoCRINCgV2YWx1ZRgCIAEoCToCOAFKBAgDEARKBAgIEAlSDWNyZWF0ZWRfYXRfbXNSFWRlbGV0aW9uX3RpbWVzdGFtcF9tcyJICg9Xb3Jrc3BhY2VTdGF0dXMSNQoFcGhhc2UYASABKA4yJi5vcGVuc2hlbGwuZGF0YW1vZGVsLnYxLldvcmtzcGFjZVBoYXNlInoKCVdvcmtzcGFjZRI0CghtZXRhZGF0YRgBIAEoCzIiLm9wZW5zaGVsbC5kYXRhbW9kZWwudjEuT2JqZWN0TWV0YRI3CgZzdGF0dXMYAiABKAsyJy5vcGVuc2hlbGwuZGF0YW1vZGVsLnYxLldvcmtzcGFjZVN0YXR1cyKtAQoQQ3JlZGVudGlhbEhhbmRsZRIOCgZkcml2ZXIYASABKAkSDgoGaGFuZGxlGAIgASgJEkgKCG1ldGFkYXRhGAMgAygLMjYub3BlbnNoZWxsLmRhdGFtb2RlbC52MS5DcmVkZW50aWFsSGFuZGxlLk1ldGFkYXRhRW50cnkaLwoNTWV0YWRhdGFFbnRyeRILCgNrZXkYASABKAkSDQoFdmFsdWUYAiABKAk6AjgBIvUFCghQcm92aWRlchI0CghtZXRhZGF0YRgBIAEoCzIiLm9wZW5zaGVsbC5kYXRhbW9kZWwudjEuT2JqZWN0TWV0YRIMCgR0eXBlGAIgASgJEkwKC2NyZWRlbnRpYWxzGAMgAygLMjEub3BlbnNoZWxsLmRhdGFtb2RlbC52MS5Qcm92aWRlci5DcmVkZW50aWFsc0VudHJ5QgSItRgBEjwKBmNvbmZpZxgEIAMoCzIsLm9wZW5zaGVsbC5kYXRhbW9kZWwudjEuUHJvdmlkZXIuQ29uZmlnRW50cnkSZAobY3JlZGVudGlhbF9leHBpcmF0aW9uX3RpbWVzGGkgAygLMj8ub3BlbnNoZWxsLmRhdGFtb2RlbC52MS5Qcm92aWRlci5DcmVkZW50aWFsRXhwaXJhdGlvblRpbWVzRW50cnkSGQoRcHJvZmlsZV93b3Jrc3BhY2UYBiABKAkSUwoSY3JlZGVudGlhbF9oYW5kbGVzGAcgAygLMjcub3BlbnNoZWxsLmRhdGFtb2RlbC52MS5Qcm92aWRlci5DcmVkZW50aWFsSGFuZGxlc0VudHJ5GjIKEENyZWRlbnRpYWxzRW50cnkSCwoDa2V5GAEgASgJEg0KBXZhbHVlGAIgASgJOgI4ARotCgtDb25maWdFbnRyeRILCgNrZXkYASABKAkSDQoFdmFsdWUYAiABKAk6AjgBGlwKHkNyZWRlbnRpYWxFeHBpcmF0aW9uVGltZXNFbnRyeRILCgNrZXkYASABKAkSKQoFdmFsdWUYAiABKAsyGi5nb29nbGUucHJvdG9idWYuVGltZXN0YW1wOgI4ARpiChZDcmVkZW50aWFsSGFuZGxlc0VudHJ5EgsKA2tleRgBIAEoCRI3CgV2YWx1ZRgCIAEoCzIoLm9wZW5zaGVsbC5kYXRhbW9kZWwudjEuQ3JlZGVudGlhbEhhbmRsZToCOAFKBAgFEAZSGGNyZWRlbnRpYWxfZXhwaXJlc19hdF9tcypuCg5Xb3Jrc3BhY2VQaGFzZRIfChtXT1JLU1BBQ0VfUEhBU0VfVU5TUEVDSUZJRUQQABIaChZXT1JLU1BBQ0VfUEhBU0VfQUNUSVZFEAESHwobV09SS1NQQUNFX1BIQVNFX1RFUk1JTkFUSU5HEAJiBnByb3RvMw", [file_options, file_google_protobuf_timestamp]);
/**
 * Describes the message openshell.datamodel.v1.WorkspaceSelector.
 * Use `create(WorkspaceSelectorSchema)` to create a new message.
 */
export const WorkspaceSelectorSchema = /*@__PURE__*/ messageDesc(file_datamodel, 0);
/**
 * Describes the message openshell.datamodel.v1.AllWorkspaces.
 * Use `create(AllWorkspacesSchema)` to create a new message.
 */
export const AllWorkspacesSchema = /*@__PURE__*/ messageDesc(file_datamodel, 1);
/**
 * Describes the message openshell.datamodel.v1.ObjectMeta.
 * Use `create(ObjectMetaSchema)` to create a new message.
 */
export const ObjectMetaSchema = /*@__PURE__*/ messageDesc(file_datamodel, 2);
/**
 * Describes the message openshell.datamodel.v1.WorkspaceStatus.
 * Use `create(WorkspaceStatusSchema)` to create a new message.
 */
export const WorkspaceStatusSchema = /*@__PURE__*/ messageDesc(file_datamodel, 3);
/**
 * Describes the message openshell.datamodel.v1.Workspace.
 * Use `create(WorkspaceSchema)` to create a new message.
 */
export const WorkspaceSchema = /*@__PURE__*/ messageDesc(file_datamodel, 4);
/**
 * Describes the message openshell.datamodel.v1.CredentialHandle.
 * Use `create(CredentialHandleSchema)` to create a new message.
 */
export const CredentialHandleSchema = /*@__PURE__*/ messageDesc(file_datamodel, 5);
/**
 * Describes the message openshell.datamodel.v1.Provider.
 * Use `create(ProviderSchema)` to create a new message.
 */
export const ProviderSchema = /*@__PURE__*/ messageDesc(file_datamodel, 6);
/**
 * Phase of a workspace's lifecycle.
 *
 * @generated from enum openshell.datamodel.v1.WorkspacePhase
 */
export var WorkspacePhase;
(function (WorkspacePhase) {
    /**
     * @generated from enum value: WORKSPACE_PHASE_UNSPECIFIED = 0;
     */
    WorkspacePhase[WorkspacePhase["UNSPECIFIED"] = 0] = "UNSPECIFIED";
    /**
     * @generated from enum value: WORKSPACE_PHASE_ACTIVE = 1;
     */
    WorkspacePhase[WorkspacePhase["ACTIVE"] = 1] = "ACTIVE";
    /**
     * @generated from enum value: WORKSPACE_PHASE_TERMINATING = 2;
     */
    WorkspacePhase[WorkspacePhase["TERMINATING"] = 2] = "TERMINATING";
})(WorkspacePhase || (WorkspacePhase = {}));
/**
 * Describes the enum openshell.datamodel.v1.WorkspacePhase.
 */
export const WorkspacePhaseSchema = /*@__PURE__*/ enumDesc(file_datamodel, 0);
//# sourceMappingURL=datamodel_pb.js.map