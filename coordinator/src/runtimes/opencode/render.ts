import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import type { ConfigPreparationResult } from "../../ports/python-bridge";
import type { McpServerConfig } from "../../ports/runtime-config";
import { asObject, sortedEntries, stableJson } from "../shared";
import { OPEN_CODE_INSTANCE_SETTING_KEYS, OPEN_CODE_MANAGEMENT_PLUGIN_REMOVALS } from "./constants";
import {
  assertHttpUrlTemplate,
  assertMcpUrlEnvironment,
  assertProviderEnvironment,
  normalizeEnvString,
  normalizeJsonObject,
  parseEnvironmentReferences,
  rejectMcpEnvironmentReference,
} from "./env-refs";
import { resolveDefaultSmallModel } from "./model-defaults";
import {
  validateNativeAgent,
  validateNativeCommand,
  validatePermissions,
} from "./native-definitions";
import { normalizePackageLock, pinPackageReference, renderProviderPackage } from "./packages";
import {
  isSafeOpenCodeProjectFilePath,
  normalizeOpenCodeInstructionPaths,
  type OpenCodeProjectConfiguration,
  type OpenCodeProjectFile,
  validateOpenCodeProjectFile,
} from "./project-config";
import {
  type JsonObject,
  type JsonValue,
  OPENCODE_CONFIG_SCHEMA,
  type OpenCodeConfigFiles,
  type OpenCodeConfigInput,
  OpenCodeConfigValidationError,
  type OpenCodeDeploymentConfig,
  type OpenCodeModelConfig,
  type OpenCodePermissionRule,
  type RenderedOpenCodeConfig,
} from "./types";

const VERTEX_PACKAGE = `aisdk:${new URL("./vertex-provider.js", import.meta.url).href}`;
// Shared runtime grants, not V1 config aliases. The Python bridge explicitly
// omits unsupported LSP for V2.1.2; never grant a nonexistent native lsp tool.
const TOOL_ACTIONS: Readonly<Record<string, string>> = {
  Edit: "edit",
  Write: "edit",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  Bash: "shell",
  Skill: "skill",
  Task: "subagent",
  TodoWrite: "todowrite",
  Question: "question",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  List: "read",
};
const SECRET_KEY =
  /(?:api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)/i;

export function renderOpenCodeConfigForCycle(
  preparation: Pick<ConfigPreparationResult, "model"> &
    Partial<
      Pick<ConfigPreparationResult, "openCodeMcpServers" | "allowedTools" | "optionalMcpServers">
    >,
  providerId: string,
  deployment: OpenCodeDeploymentConfig = {},
  profile: OpenCodeProjectConfiguration = { settings: {}, files: [] },
  vertexAllowedModels: readonly string[] = [],
): RenderedOpenCodeConfig {
  const id = deployment.providerId ?? providerId;
  const model = deployment.model ?? preparation.model;
  return applyProfile(
    renderOpenCodeConfig({
      ...deployment,
      model,
      providerId: id,
      smallModel:
        deployment.smallModel ??
        resolveDefaultSmallModel(id, model, deployment.providers ?? [], vertexAllowedModels),
      mcpServers: preparation.openCodeMcpServers,
      allowedTools: preparation.allowedTools ?? [],
      optionalMcpServers: preparation.optionalMcpServers ?? [],
    }),
    profile,
  );
}

/** Render only native OpenCode V2 syntax from Rehor's runtime-owned inputs. */
export function renderOpenCodeConfig(input: OpenCodeConfigInput): RenderedOpenCodeConfig {
  rejectKeys(input, ["provider", "packageLock"], "deployment");
  const model = normalizeModel(input.model, input.providerId);
  const providers = input.providers ?? [];
  const ids = new Set<string>();
  for (const provider of providers) {
    rejectKeys(
      provider,
      ["npm", "options", "api", "whitelist", "blacklist"],
      `providers.${provider.id}`,
    );
    if (
      Object.keys(provider).some(
        (key) => !["id", "package", "name", "settings", "models"].includes(key),
      )
    )
      fail(`providers.${provider.id} contains unsupported native fields`);
    if (typeof provider.id !== "string" || !provider.id || ids.has(provider.id))
      fail("provider ids must be non-empty and unique");
    ids.add(provider.id);
  }
  const packageLock = normalizePackageLock(input.packages ?? [], input.plugins ?? [], providers);
  const required = new Set<string>();
  const output: JsonObject = {};
  for (const provider of [...providers].sort((a, b) => a.id.localeCompare(b.id))) {
    if (provider.id === "vertex" && provider.package !== undefined)
      fail("providers.vertex.package is coordinator-managed");
    const entry: JsonObject = {};
    if (provider.id === "vertex") entry.package = VERTEX_PACKAGE;
    else if (provider.package !== undefined)
      entry.package = renderProviderPackage(
        provider.package,
        packageLock,
        `providers.${provider.id}.package`,
      );
    if (provider.name !== undefined) {
      normalizeEnvString(provider.name, `providers.${provider.id}.name`, (name, path) =>
        assertProviderEnvironment(name, path, false),
      );
      entry.name = provider.name;
    }
    if (provider.settings !== undefined)
      entry.settings = normalizeJsonObject(
        provider.settings,
        `providers.${provider.id}.settings`,
        required,
      );
    const models: JsonObject = {};
    for (const [id, value] of sortedEntries(provider.models ?? {}))
      models[id] = renderModel(value, `providers.${provider.id}.models.${id}`, required);
    if (provider.id === model.providerID && models[model.modelID] === undefined)
      models[model.modelID] = { name: model.modelID };
    if (Object.keys(models).length) entry.models = models;
    output[provider.id] = entry;
  }
  const servers = renderMcpServers(input.mcpServers ?? {});
  const permissions = renderPermissions(
    input.allowedTools ?? [],
    servers,
    input.optionalMcpServers ?? [],
    validateAdditionalDirectories(input.additionalDirectories),
  );
  const plugins: JsonValue[] = (input.plugins ?? []).map((plugin) => {
    const spec = pinPackageReference(plugin.name, packageLock, "plugins");
    return plugin.options === undefined
      ? spec
      : {
          package: spec,
          options: normalizeJsonObject(plugin.options, "plugins.options", required),
        };
  });
  const config: JsonObject = {
    $schema: OPENCODE_CONFIG_SCHEMA,
    share: "disabled",
    update: "disable",
    model: model.value,
    agents: {
      title: {
        model:
          input.smallModel === undefined
            ? model.value
            : normalizeModel(input.smallModel, model.providerID).value,
      },
    },
    providers: output,
    plugins: [...plugins, ...OPEN_CODE_MANAGEMENT_PLUGIN_REMOVALS],
    mcp: { servers },
    permissions: permissions as unknown as JsonValue,
    policies: [
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: model.providerID, effect: "allow" },
      ...renderOpenCodeExternalDirectoryPolicies(permissions),
    ],
    ...((input.allowedTools ?? []).includes("TodoWrite") ? { experimental: { todo: true } } : {}),
  };
  const json = `${stableJson(config)}\n`;
  return {
    config: deepFreeze(config),
    json,
    enforcementJson: renderEnforcement(config),
    profileConfig: deepFreeze({}),
    hash: hashOpenCodeConfig(config),
    packageLock: deepFreeze(packageLock),
    effectiveModel: Object.freeze(model),
    requiredEnvironment: Object.freeze([...required].sort()),
    projectFiles: Object.freeze([]),
  };
}

function renderModel(model: OpenCodeModelConfig, path: string, required: Set<string>): JsonObject {
  rejectKeys(model, ["id", "options", "reasoning", "tool_call", "modalities", "variants"], path);
  if (
    Object.keys(model).some(
      (key) => !["name", "modelID", "limit", "settings", "capabilities"].includes(key),
    )
  )
    fail(`${path} contains legacy or unsupported fields`);
  const result: JsonObject = {};
  if (model.name !== undefined) {
    normalizeEnvString(model.name, `${path}.name`, (name, referencePath) =>
      assertProviderEnvironment(name, referencePath, false),
    );
    result.name = model.name;
  }
  if (model.modelID !== undefined) result.modelID = model.modelID;
  if (model.limit !== undefined)
    result.limit = {
      context: positiveInteger(model.limit.context, `${path}.limit.context`),
      output: positiveInteger(model.limit.output, `${path}.limit.output`),
    };
  if (model.settings !== undefined)
    result.settings = normalizeJsonObject(model.settings, `${path}.settings`, required);
  if (model.capabilities !== undefined) {
    const cap = model.capabilities;
    if (cap.tools !== undefined && typeof cap.tools !== "boolean")
      fail(`${path}.capabilities.tools must be boolean`);
    if (cap.temperature !== undefined && typeof cap.temperature !== "boolean")
      fail(`${path}.capabilities.temperature must be boolean`);
    for (const key of ["input", "output"] as const)
      if (
        cap[key] !== undefined &&
        (!Array.isArray(cap[key]) || cap[key]?.some((value) => typeof value !== "string"))
      )
        fail(`${path}.capabilities.${key} must be strings`);
    if (
      cap.reasoning !== undefined &&
      (!asObject(cap.reasoning) || typeof cap.reasoning.supported !== "boolean")
    )
      fail(`${path}.capabilities.reasoning requires supported boolean`);
    result.capabilities = cap as unknown as JsonValue;
  }
  return result;
}

export function hashOpenCodeConfig(config: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(stableJson(config)).digest("hex");
}

export async function writeOpenCodeConfig(
  directory: string,
  rendered: RenderedOpenCodeConfig,
): Promise<OpenCodeConfigFiles> {
  const files = validateFiles(rendered.projectFiles);
  directory = resolve(directory);
  const configPath = join(directory, "instance-opencode.json");
  const globalConfigDirectory = join(directory, "xdg-config", "opencode");
  const globalConfigPath = join(globalConfigDirectory, "opencode.json");
  const packageLockPath = join(directory, "opencode-packages.lock.json");
  await rm(globalConfigDirectory, { recursive: true, force: true });
  await mkdir(globalConfigDirectory, { recursive: true });
  for (const file of files) {
    const path = join(globalConfigDirectory, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, "utf8");
  }
  const profile: JsonObject = { $schema: OPENCODE_CONFIG_SCHEMA, ...rendered.profileConfig };
  if (Array.isArray(profile.instructions))
    profile.instructions = profile.instructions.map((value) =>
      typeof value === "string" && value.startsWith("./")
        ? join(globalConfigDirectory, value.slice(2))
        : value,
    );
  await Promise.all([
    writeFile(globalConfigPath, rendered.json, "utf8"),
    writeFile(configPath, `${JSON.stringify(profile)}\n`, "utf8"),
    writeFile(packageLockPath, `${stableJson(rendered.packageLock)}\n`, "utf8"),
  ]);
  return { configPath, globalConfigPath, globalConfigDirectory, packageLockPath };
}

function applyProfile(
  rendered: RenderedOpenCodeConfig,
  profile: OpenCodeProjectConfiguration,
): RenderedOpenCodeConfig {
  const settings = profile.settings;
  for (const [key, value] of Object.entries(settings)) {
    if (key === "$schema") {
      if (value !== OPENCODE_CONFIG_SCHEMA) fail("instance $schema is unsupported");
      continue;
    }
    if (!OPEN_CODE_INSTANCE_SETTING_KEYS.has(key))
      fail(
        `instance opencode.json field '${key}' is unsupported or coordinator-controlled; use native V2 fields`,
      );
    validateReferences(value, `opencode.json.${key}`);
  }
  const files = validateFiles(profile.files);
  if (settings.compaction !== undefined)
    rejectKeys(
      record(settings.compaction, "compaction"),
      ["preserve_recent_tokens", "reserved", "tail_turns", "prune"],
      "compaction",
    );
  const staged: JsonObject = { ...settings };
  const denies =
    settings.permissions === undefined
      ? []
      : validatePermissions(settings.permissions, "instance permissions", true);
  if (settings.agents !== undefined) {
    const agents = record(settings.agents, "instance agents");
    for (const [name, agent] of Object.entries(agents)) {
      validateNativeAgent(agent, `agents.${name}`);
    }
  }
  if (settings.commands !== undefined)
    for (const [name, command] of Object.entries(record(settings.commands, "instance commands"))) {
      validateNativeCommand(command, `commands.${name}`);
    }
  const experimental = validateExperimental(settings.experimental);
  const generatedServers = record(record(rendered.config.mcp, "mcp").servers, "mcp.servers");
  let profileServers: JsonObject | undefined;
  if (settings.mcp !== undefined) {
    const mcp = record(settings.mcp, "instance mcp");
    if (Object.keys(mcp).some((key) => key !== "servers"))
      fail("instance mcp must use native mcp.servers");
    profileServers = record(mcp.servers, "instance mcp.servers");
    const servers: JsonObject = {};
    for (const [name, server] of Object.entries(profileServers)) {
      if (generatedServers[name] !== undefined)
        fail(`instance mcp.servers.${name} conflicts with coordinator-generated MCP configuration`);
      servers[name] = validateNativeMcp(name, server);
    }
    staged.mcp = { servers };
    profileServers = servers;
  }
  if (settings.plugins !== undefined) {
    if (!Array.isArray(settings.plugins))
      fail("instance plugins must be an array of pinned packages");
    for (const value of settings.plugins as JsonValue[]) {
      const spec = typeof value === "string" ? value : record(value, "plugins entry").package;
      if (
        typeof spec !== "string" ||
        spec !== pinPackageReference(spec, rendered.packageLock, "instance plugins")
      )
        fail("instance plugins must use declared exact-pinned packages");
      if (
        typeof value !== "string" &&
        Object.keys(value as object).some((key) => key !== "package" && key !== "options")
      )
        fail("plugins entries require package and optional options");
    }
  }
  if (settings.instructions !== undefined)
    staged.instructions = normalizeOpenCodeInstructionPaths(settings.instructions, files);
  const permissions = [
    ...(rendered.config.permissions as unknown as OpenCodePermissionRule[]),
    ...denies,
  ];
  const config: JsonObject = {
    ...rendered.config,
    policies: [
      ...(rendered.config.policies as JsonValue[]).filter(
        (value) => record(value, "policy").action !== "tool.use",
      ),
      ...renderOpenCodeExternalDirectoryPolicies(permissions),
    ],
  };
  const enforcement = JSON.parse(renderEnforcement(config)) as JsonObject;
  enforcement.permissions = permissions as unknown as JsonValue;
  if (profileServers !== undefined)
    enforcement.mcp = { servers: { ...generatedServers, ...profileServers } };
  if (experimental !== undefined)
    enforcement.experimental = {
      ...asObject(enforcement.experimental),
      ...experimental,
    } as JsonObject;
  const hash = createHash("sha256")
    .update(stableJson(config))
    .update("\0")
    .update(JSON.stringify(staged));
  for (const file of files) hash.update("\0").update(file.path).update("\0").update(file.content);
  return {
    ...rendered,
    config: deepFreeze(config),
    json: `${stableJson(config)}\n`,
    profileConfig: deepFreeze(staged),
    enforcementJson: `${stableJson(enforcement)}\n`,
    hash: hash.digest("hex"),
    projectFiles: Object.freeze(files),
  };
}

function renderEnforcement(config: JsonObject): string {
  const { policies: _, plugins: _plugins, ...enforced } = config;
  enforced.plugins = [...OPEN_CODE_MANAGEMENT_PLUGIN_REMOVALS];
  return `${stableJson(enforced)}\n`;
}

function validateExperimental(value: JsonValue | undefined): JsonObject | undefined {
  if (value === undefined) return undefined;
  const settings = record(value, "experimental");
  for (const [key, item] of Object.entries(settings)) {
    if (key === "todo" && typeof item === "boolean") continue;
    if (key === "subagent_depth" && Number.isSafeInteger(item) && Number(item) >= 0) continue;
    fail(`experimental.${key} must be boolean todo or non-negative integer subagent_depth`);
  }
  return settings;
}

function validateNativeMcp(name: string, value: JsonValue): JsonObject {
  const server = record(value, `mcp.servers.${name}`);
  rejectKeys(server, ["enabled"], `mcp.servers.${name}`);
  if (server.disabled !== undefined && typeof server.disabled !== "boolean")
    fail(`mcp.servers.${name}.disabled must be boolean`);
  if (server.codemode !== undefined && typeof server.codemode !== "boolean")
    fail(`mcp.servers.${name}.codemode must be boolean`);
  const allowed =
    server.type === "local"
      ? ["type", "command", "environment", "disabled", "timeout", "codemode"]
      : ["type", "url", "headers", "disabled", "timeout", "codemode"];
  if (Object.keys(server).some((key) => !allowed.includes(key)))
    fail(`mcp.servers.${name} contains unsupported fields`);
  if (server.type === "local") {
    if (
      !Array.isArray(server.command) ||
      !server.command.length ||
      server.command.some((part) => typeof part !== "string" || !part)
    )
      fail(`mcp.servers.${name}.command must be non-empty strings`);
    if (server.environment !== undefined)
      normalizeJsonObject(
        stringMap(server.environment, "environment"),
        `mcp.servers.${name}.environment`,
        undefined,
        rejectMcpEnvironmentReference,
      );
  } else if (server.type === "remote") {
    if (typeof server.url !== "string") fail(`mcp.servers.${name}.url must be a string`);
    assertHttpUrlTemplate(server.url as string, `mcp.servers.${name}.url`);
    if (server.headers !== undefined)
      normalizeJsonObject(
        stringMap(server.headers, "headers"),
        `mcp.servers.${name}.headers`,
        undefined,
        rejectMcpEnvironmentReference,
      );
  } else fail(`mcp.servers.${name}.type must be local or remote`);
  if (server.timeout !== undefined) {
    const timeout = record(server.timeout, `mcp.servers.${name}.timeout`);
    for (const [key, item] of Object.entries(timeout)) {
      if (!["startup", "catalog", "execution"].includes(key))
        fail(`mcp.servers.${name}.timeout.${key} is unsupported`);
      positiveInteger(item, `mcp.servers.${name}.timeout.${key}`);
    }
  }
  return server;
}

function renderMcpServers(servers: Readonly<Record<string, McpServerConfig>>): JsonObject {
  const result: JsonObject = {};
  for (const [name, server] of sortedEntries(servers)) {
    if (server.codemode !== undefined && typeof server.codemode !== "boolean")
      fail(`mcp.${name}.codemode must be boolean`);
    const common = {
      disabled: server.alwaysLoad === false,
      ...(server.codemode === undefined ? {} : { codemode: server.codemode }),
      ...(server.timeout === undefined
        ? {}
        : {
            timeout: {
              startup: positiveInteger(server.timeout, "MCP timeout"),
              catalog: server.timeout,
              execution: server.timeout,
            },
          }),
    };
    if ("command" in server) {
      if (server.type !== undefined && server.type !== "stdio")
        fail(`mcp.${name}.type must be stdio when command is provided`);
      const command = [server.command, ...(server.args ?? [])];
      if (command.some((part) => typeof part !== "string" || !part))
        fail(`mcp.${name}.command must contain non-empty strings`);
      result[name] = {
        type: "local",
        command,
        ...common,
        ...(server.env === undefined
          ? {}
          : {
              environment: normalizeJsonObject(
                server.env,
                `mcp.${name}.environment`,
                undefined,
                rejectMcpEnvironmentReference,
              ),
            }),
      };
    } else {
      if (server.type !== "http" && server.type !== "sse")
        fail(`mcp.${name}.type must be http or sse`);
      const url = normalizeEnvString(server.url, `mcp.${name}.url`, assertMcpUrlEnvironment);
      assertHttpUrlTemplate(url, `mcp.${name}.url`);
      result[name] = {
        type: "remote",
        url,
        ...common,
        ...(server.headers === undefined
          ? {}
          : {
              headers: normalizeJsonObject(
                server.headers,
                `mcp.${name}.headers`,
                undefined,
                rejectMcpEnvironmentReference,
              ),
            }),
      };
    }
  }
  return result;
}

function renderPermissions(
  tools: readonly string[],
  servers: JsonObject,
  optional: readonly string[],
  directories: readonly string[],
): OpenCodePermissionRule[] {
  const rules: OpenCodePermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }];
  const configured = Object.keys(servers);
  const names = new Map<string, string>();
  for (const server of configured) {
    const namespace = server.replace(/[^a-zA-Z0-9_-]/g, "_");
    if (names.has(namespace)) fail(`MCP namespace '${namespace}' collides`);
    names.set(namespace, server);
    rules.push({ action: `${namespace}_*`, resource: "*", effect: "deny" });
  }
  const sources = new Map<string, string>();
  let needsExecute = false;
  for (const tool of tools) {
    const mcp = /^mcp__(.+)__(.+)$/.exec(tool);
    if (mcp) {
      if (!configured.includes(mcp[1])) {
        if (optional.includes(mcp[1])) continue;
        fail(`allowed MCP tool '${tool}' references unconfigured server '${mcp[1]}'`);
      }
      const action = `${mcp[1].replace(/[^a-zA-Z0-9_-]/g, "_")}_${mcp[2].replace(/[^a-zA-Z0-9_*?-]/g, "_")}`;
      if (sources.has(action) && sources.get(action) !== tool)
        fail(`MCP permission key '${action}' collides`);
      sources.set(action, tool);
      rules.push({ action, resource: "*", effect: "allow" });
      const server = record(servers[mcp[1]], `mcp.${mcp[1]}`);
      if (server.codemode !== false && server.disabled !== true) needsExecute = true;
      continue;
    }
    const shell = /^Bash\((.*)\)$/s.exec(tool);
    const action = shell ? "shell" : tool === "execute" ? "execute" : TOOL_ACTIONS[tool];
    if (!action || (shell && !shell[1]))
      fail(`allowed tool '${tool}' cannot be mapped to a native OpenCode permission`);
    rules.push({ action, resource: shell ? shell[1] : "*", effect: "allow" });
  }
  if (needsExecute && !rules.some((rule) => rule.action === "execute" && rule.effect === "allow"))
    rules.push({ action: "execute", resource: "*", effect: "allow" });
  rules.push({ action: "external_directory", resource: "*", effect: "deny" });
  for (const directory of directories)
    rules.push({ action: "external_directory", resource: `${directory}/*`, effect: "allow" });
  return rules;
}

/** Global policy ceiling consumes native ordered rules, including profile denies. */
export function renderOpenCodeExternalDirectoryPolicies(
  permissions: readonly OpenCodePermissionRule[],
): JsonValue[] {
  const rules = validatePermissions(permissions, "permissions");
  const result: JsonValue[] = [
    { action: "tool.use", resource: "external_directory:*", effect: "deny" },
  ];
  // Renderer-owned grants are literal roots; profile rules may only tighten them.
  for (const rule of rules) {
    const actionPattern = rule.action
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    if (!new RegExp(`^${actionPattern}$`, "s").test("external_directory")) continue;
    if (rule.effect === "deny" && rule.resource === "*" && result.length === 1) continue;
    if (rule.effect === "allow") {
      if (!rule.resource.endsWith("/*"))
        fail("external_directory policy requires literal deployment root grants");
      validateAdditionalDirectories([rule.resource.slice(0, -2)]);
    }
    if (rule.effect === "ask") fail("external_directory ceiling cannot grant ask");
    result.push({
      action: "tool.use",
      resource: `external_directory:${rule.resource}`,
      effect: rule.effect,
    });
  }
  return result;
}

export function validateAdditionalDirectories(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("additionalDirectories must be an array of absolute paths");
  for (const directory of value as unknown[]) {
    if (
      typeof directory !== "string" ||
      !posix.isAbsolute(directory) ||
      directory === "/" ||
      posix.normalize(directory) !== directory ||
      /[\\*?[\]{}$~\p{Cc}\p{Cf}]/u.test(directory) ||
      directory
        .split("/")
        .slice(1)
        .some((part) => !part || part.trim() !== part)
    )
      fail(
        "additionalDirectories must contain canonical absolute non-root paths without wildcards, traversal, controls, or references",
      );
  }
  return [...new Set(value as string[])].sort();
}

function validateReferences(value: unknown, path: string): void {
  if (typeof value === "string") {
    const refs = parseEnvironmentReferences(normalizeEnvString(value, path), path);
    const mcpUrl = /^opencode\.json\.mcp\.servers\.[^.]+\.url$/.test(path);
    if (SECRET_KEY.test(path.split(".").at(-1) ?? "") && !refs.length)
      fail(`${path} cannot contain literal credentials`);
    if (/\{(?:env|file):|\$\{[A-Za-z_]/.test(value) && (!mcpUrl || /\{file:/.test(value)))
      fail(`${path} cannot use environment or file references`);
    if (mcpUrl) for (const ref of refs) assertMcpUrlEnvironment(ref, path);
  } else if (Array.isArray(value))
    value.forEach((item, index) => {
      validateReferences(item, `${path}[${index}]`);
    });
  else if (asObject(value))
    for (const [key, item] of Object.entries(value as object))
      validateReferences(item, `${path}.${key}`);
}

function validateFiles(files: readonly OpenCodeProjectFile[]): OpenCodeProjectFile[] {
  const seen = new Set<string>();
  return files.map((file) => {
    if (
      !isSafeOpenCodeProjectFilePath(file.path) ||
      seen.has(file.path) ||
      typeof file.content !== "string"
    )
      fail(`instance file path '${file.path}' is not allowed or duplicated`);
    validateOpenCodeProjectFile(file);
    seen.add(file.path);
    return Object.freeze({ ...file });
  });
}

function normalizeModel(
  raw: string,
  providerId?: string,
): { providerID: string; modelID: string; value: string } {
  if (typeof raw !== "string" || !raw.trim()) fail("model must be non-empty");
  const value = raw.includes("/") ? raw : providerId ? `${providerId}/${raw}` : "";
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1) fail("model requires provider/model");
  if (providerId !== undefined && providerId !== value.slice(0, separator))
    fail("providerId conflicts with model provider");
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1), value };
}
function record(value: unknown, path: string): JsonObject {
  const object = asObject(value);
  if (!object) fail(`${path} must be an object`);
  return object as JsonObject;
}
function stringMap(value: unknown, path: string): Record<string, string> {
  const object = record(value, path);
  if (Object.values(object).some((item) => typeof item !== "string"))
    fail(`${path} must contain only strings`);
  return object as Record<string, string>;
}
function rejectKeys(value: object, keys: readonly string[], path: string): void {
  for (const key of keys)
    if (Object.hasOwn(value, key))
      fail(`${path}.${key} is legacy or unsupported; use native V2 configuration`);
}
function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    fail(`${path} must be a positive safe integer`);
  return value as number;
}
function fail(message: string): never {
  throw new OpenCodeConfigValidationError([message]);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
