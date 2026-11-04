import { asObject } from "../shared";
import {
  type JsonObject,
  OpenCodeConfigValidationError,
  type OpenCodePermissionRule,
} from "./types";

// Native v2.1.2 Config.Agent / Config.Command / Permission.Rule contracts.
// Used for JSON and Markdown so upstream's legacy decoder is never selected.
export function validateNativeAgent(value: unknown, path: string): void {
  const agent = object(value, path);
  keys(
    agent,
    [
      "model",
      "request",
      "system",
      "description",
      "mode",
      "hidden",
      "color",
      "steps",
      "disabled",
      "permissions",
    ],
    path,
  );
  strings(agent, ["system", "description"], path);
  booleans(agent, ["hidden", "disabled"], path);
  if (
    agent.mode !== undefined &&
    (typeof agent.mode !== "string" || !["primary", "subagent", "all"].includes(agent.mode))
  )
    fail(`${path}.mode is invalid`);
  if (
    agent.color !== undefined &&
    (typeof agent.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(agent.color))
  )
    fail(`${path}.color must be hex RGB`);
  if (agent.steps !== undefined && (!Number.isSafeInteger(agent.steps) || Number(agent.steps) <= 0))
    fail(`${path}.steps must be a positive safe integer`);
  if (agent.model !== undefined) validateModelSelection(agent.model, `${path}.model`);
  if (agent.permissions !== undefined)
    validatePermissions(agent.permissions, `${path}.permissions`);
  if (agent.request !== undefined) {
    const request = object(agent.request, `${path}.request`);
    keys(request, ["headers", "body"], `${path}.request`);
    if (
      request.headers !== undefined &&
      Object.values(object(request.headers, `${path}.request.headers`)).some(
        (item) => typeof item !== "string",
      )
    )
      fail(`${path}.request.headers must contain only strings`);
    if (request.body !== undefined) object(request.body, `${path}.request.body`);
  }
}

export function validateNativeCommand(value: unknown, path: string): void {
  const command = object(value, path);
  keys(command, ["template", "description", "agent", "model", "subagent"], path);
  if (typeof command.template !== "string") fail(`${path}.template must be a string`);
  strings(command, ["description", "agent"], path);
  booleans(command, ["subagent"], path);
  if (command.model !== undefined) validateModelSelection(command.model, `${path}.model`);
}

export function validatePermissions(
  value: unknown,
  path: string,
  denyOnly = false,
): OpenCodePermissionRule[] {
  if (!Array.isArray(value)) fail(`${path} must be a native ordered permissions array`);
  return (value as unknown[]).map((item) => {
    const rule = object(item, path);
    keys(rule, ["action", "resource", "effect"], path);
    if (
      typeof rule.action !== "string" ||
      typeof rule.resource !== "string" ||
      typeof rule.effect !== "string" ||
      !["allow", "deny", "ask"].includes(rule.effect)
    )
      fail(`${path} requires action, resource, effect`);
    if (
      ["bash", "task", "write", "patch", "lsp", "doom_loop", "list"].includes(rule.action as string)
    )
      fail(`${path} action '${rule.action}' is not native V2; use shell/subagent/edit/read`);
    if (denyOnly && rule.effect !== "deny") fail(`${path} may only add deny-only restrictions`);
    return {
      action: rule.action as string,
      resource: rule.resource as string,
      effect: rule.effect as OpenCodePermissionRule["effect"],
    };
  });
}

function validateModelSelection(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (!/^[^/#]+\/[^#]+(?:#[^#]+)?$/.test(value)) fail(`${path} must use provider/model#variant`);
    return;
  }
  const model = object(value, path);
  keys(model, ["providerID", "model", "variant"], path);
  if (
    typeof model.providerID !== "string" ||
    !/^[^/#]+$/.test(model.providerID) ||
    typeof model.model !== "string" ||
    !/^[^#]+$/.test(model.model) ||
    (model.variant !== undefined &&
      (typeof model.variant !== "string" || !/^[^#]+$/.test(model.variant)))
  )
    fail(`${path} requires native providerID/model selection`);
}

/** Reject YAML-only objects/scalars, non-finite numbers, cycles and excessive nesting. */
export function validateDefinitionJson(value: unknown, path: string, depth = 0): void {
  if (depth > 64) fail(`${path} exceeds definition nesting limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateDefinitionJson(item, `${path}[${index}]`, depth + 1);
    });
    return;
  }
  if (
    asObject(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    for (const [key, item] of Object.entries(value as object))
      validateDefinitionJson(item, `${path}.${key}`, depth + 1);
    return;
  }
  fail(`${path} must contain only native JSON-compatible values`);
}

function object(value: unknown, path: string): JsonObject {
  validateDefinitionJson(value, path);
  const result = asObject(value);
  if (!result) fail(`${path} must be an object`);
  return result as JsonObject;
}
function keys(value: JsonObject, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      fail(`${path}.${key} is unknown or legacy; use only native V2 fields`);
}
function strings(value: JsonObject, names: readonly string[], path: string): void {
  for (const name of names)
    if (value[name] !== undefined && typeof value[name] !== "string")
      fail(`${path}.${name} must be a string`);
}
function booleans(value: JsonObject, names: readonly string[], path: string): void {
  for (const name of names)
    if (value[name] !== undefined && typeof value[name] !== "boolean")
      fail(`${path}.${name} must be boolean`);
}
function fail(message: string): never {
  throw new OpenCodeConfigValidationError([message]);
}
