// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { extDesc, fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv2";
import { file_google_protobuf_descriptor } from "@bufbuild/protobuf/wkt";
/**
 * Describes the file options.proto.
 */
export const file_options = /*@__PURE__*/ fileDesc("Cg1vcHRpb25zLnByb3RvEhRvcGVuc2hlbGwub3B0aW9ucy52MSJiChFBdXRob3JpemF0aW9uUnVsZRIRCglhdXRoX21vZGUYASABKAkSFgoOd29ya3NwYWNlX3JvbGUYAiABKAkSEwoLZ2xvYmFsX3JvbGUYAyABKAkSDQoFc2NvcGUYBCABKAk6bwoNYXV0aG9yaXphdGlvbhIeLmdvb2dsZS5wcm90b2J1Zi5NZXRob2RPcHRpb25zGNCGAyABKAsyJy5vcGVuc2hlbGwub3B0aW9ucy52MS5BdXRob3JpemF0aW9uUnVsZVINYXV0aG9yaXphdGlvbjo3CgZzZWNyZXQSHS5nb29nbGUucHJvdG9idWYuRmllbGRPcHRpb25zGNGGAyABKAhSBnNlY3JldGIGcHJvdG8z", [file_google_protobuf_descriptor]);
/**
 * Describes the message openshell.options.v1.AuthorizationRule.
 * Use `create(AuthorizationRuleSchema)` to create a new message.
 */
export const AuthorizationRuleSchema = /*@__PURE__*/ messageDesc(file_options, 0);
/**
 * Authorization metadata for a gRPC method.
 *
 * @generated from extension: openshell.options.v1.AuthorizationRule authorization = 50000;
 */
export const authorization = /*@__PURE__*/ extDesc(file_options, 0);
/**
 * @generated from extension: bool secret = 50001;
 */
export const secret = /*@__PURE__*/ extDesc(file_options, 1);
//# sourceMappingURL=options_pb.js.map