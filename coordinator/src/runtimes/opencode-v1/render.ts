import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

import type { ConfigPreparationResult } from "../../ports/python-bridge";
import type { McpServerConfig } from "../../ports/runtime-config";
import { asObject, sortedEntries, stableJson } from "../shared";
import { OPEN_CODE_INSTANCE_SETTING_KEYS } from "./constants";
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
import { normalizePackageLock, pinPackageReference } from "./packages";
import {
  isSafeOpenCodeProjectFilePath,
  normalizeOpenCodeInstructionPaths,
  type OpenCodeProjectConfiguration,
  type OpenCodeProjectFile,
} from "./project-config";
import {
  type JsonValue,
  OPENCODE_CONFIG_SCHEMA,
  type OpenCodeConfigFiles,
  OpenCodeConfigValidationError,
  type OpenCodeModelConfig,
  type OpenCodePackageLock,
  type OpenCodePluginConfig,
  type OpenCodeProviderConfig,
  type OpenCodeV1ConfigInput,
  type OpenCodeV1DeploymentConfig,
  type RenderedOpenCodeV1Config,
} from "./types";

const VERTEX_PROXY_PROVIDER_MODULE_URL = new URL("./vertex-provider.js", import.meta.url).href;

export function normalizeDeploymentConfig(
  deployment: OpenCodeV1DeploymentConfig,
): Omit<OpenCodeV1DeploymentConfig, "provider" | "packageLock"> {
  const { provider, packageLock, ...canonicalDeployment } = deployment;
  return {
    ...canonicalDeployment,
    providers: [...(deployment.providers ?? []), ...(provider ? [provider] : [])],
    packages: [
      ...Object.entries(packageLock?.packages ?? {}).map(([name, version]) => ({ name, version })),
      ...(deployment.packages ?? []),
    ],
  };
}

export function renderOpenCodeV1ConfigForCycle(
  preparation: Pick<ConfigPreparationResult, "model"> &
    Partial<
      Pick<ConfigPreparationResult, "openCodeMcpServers" | "allowedTools" | "optionalMcpServers">
    >,
  providerId: string,
  deployment: OpenCodeV1DeploymentConfig = {},
  projectConfig: OpenCodeProjectConfiguration = { settings: {}, files: [] },
  vertexAllowedModels: readonly string[] = [],
): RenderedOpenCodeV1Config {
  const resolvedProviderId = deployment.providerId ?? providerId;
  const normalizedDeployment = normalizeDeploymentConfig(deployment);
  const resolvedModel = deployment.model ?? preparation.model;
  const rendered = renderOpenCodeV1Config({
    ...normalizedDeployment,
    model: resolvedModel,
    providerId: resolvedProviderId,
    smallModel:
      deployment.smallModel ??
      resolveDefaultSmallModel(
        resolvedProviderId,
        resolvedModel,
        normalizedDeployment.providers ?? [],
        vertexAllowedModels,
      ),
    mcpServers: preparation.openCodeMcpServers,
    allowedTools: preparation.allowedTools ?? [],
    optionalMcpServers: preparation.optionalMcpServers ?? [],
  });
  return validateOpenCodeProjectConfig(rendered, projectConfig);
}

const BUILTIN_TOOLS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "lsp",
  "doom_loop",
  "skill",
] as const;

const CLAUDE_TOOL_TO_OPENCODE: Readonly<Record<string, string>> = {
  Edit: "edit",
  Write: "edit",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  Bash: "bash",
  LSP: "lsp",
  Skill: "skill",
  Task: "task",
  TodoWrite: "todowrite",
  Question: "question",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  List: "list",
};

/** Render one deterministic, fail-closed OpenCode V1 configuration. */
export function renderOpenCodeV1Config(input: OpenCodeV1ConfigInput): RenderedOpenCodeV1Config {
  const model = normalizeModel(input.model, input.providerId);
  const providers = normalizeProviders(input.providers ?? []);
  const packageLock = normalizePackageLock(input.packages ?? [], input.plugins ?? [], providers);
  const requiredEnvironment = new Set<string>();
  const providerOutput = renderProviders(providers, model, packageLock, requiredEnvironment);
  const mcp = renderMcpServers(input.mcpServers ?? {});
  const permission = renderPermissions(
    input.allowedTools ?? [],
    Object.keys(mcp),
    input.optionalMcpServers ?? [],
    validateAdditionalDirectories(input.additionalDirectories),
  );
  const plugin = renderPlugins(input.plugins ?? [], packageLock, requiredEnvironment);

  const config: Record<string, JsonValue> = {
    $schema: OPENCODE_CONFIG_SCHEMA,
    share: "disabled",
    autoupdate: false,
    lsp: false,
    model: model.value,
    enabled_providers: [model.providerId],
    ...(input.smallModel === undefined
      ? {}
      : { small_model: normalizeModel(input.smallModel, model.providerId).value }),
    ...(providerOutput === undefined ? {} : { provider: providerOutput }),
    ...(plugin.length === 0 ? {} : { plugin }),
    ...(Object.keys(mcp).length === 0 ? {} : { mcp }),
    permission,
  };

  const stable = stableJson(config);
  return {
    config: deepFreeze(config),
    json: `${stable}\n`,
    profileConfig: deepFreeze({}),
    enforcementJson: renderOpenCodeEnforcementConfig(config, {}),
    hash: createHash("sha256").update(stable, "utf8").digest("hex"),
    packageLock: deepFreeze(packageLock),
    effectiveModel: Object.freeze({
      providerID: model.providerId,
      modelID: model.modelId,
      value: model.value,
    }),
    requiredEnvironment: Object.freeze([...requiredEnvironment].sort()),
    projectFiles: Object.freeze([]),
  };
}

export function hashOpenCodeConfig(config: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(stableJson(config)).digest("hex");
}

/** Write the generated opencode.json and build-consumable package lock. */
export async function writeOpenCodeConfig(
  directory: string,
  rendered: RenderedOpenCodeV1Config,
): Promise<OpenCodeConfigFiles> {
  directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "instance-opencode.json");
  const globalConfigDirectory = join(directory, "xdg-config", "opencode");
  const globalConfigPath = join(globalConfigDirectory, "opencode.json");
  const packageLockPath = join(directory, "opencode-packages.lock.json");
  await rm(globalConfigDirectory, { recursive: true, force: true });
  await mkdir(globalConfigDirectory, { recursive: true });

  for (const file of rendered.projectFiles) {
    assertSafeStagedPath(file.path);
    const path = join(globalConfigDirectory, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, "utf8");
  }

  const profileConfig: Record<string, JsonValue> = {
    $schema: OPENCODE_CONFIG_SCHEMA,
    ...rendered.profileConfig,
  };
  if (Array.isArray(profileConfig.instructions)) {
    profileConfig.instructions = profileConfig.instructions.map((instruction) =>
      typeof instruction === "string" && instruction.startsWith("./")
        ? join(globalConfigDirectory, instruction.slice(2))
        : instruction,
    );
  }
  await Promise.all([
    writeFile(globalConfigPath, rendered.json, "utf8"),
    // Native permission objects are ordered rules, including wildcard tool names.
    // Sorting profile keys would silently change last-match evaluation before the hook.
    writeFile(configPath, `${JSON.stringify(profileConfig)}\n`, "utf8"),
    writeFile(packageLockPath, `${stableJson(rendered.packageLock)}\n`, "utf8"),
  ]);
  return {
    configPath,
    globalConfigPath,
    globalConfigDirectory,
    packageLockPath,
  };
}

const SECRET_KEY =
  /(?:api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)/i;

function validateOpenCodeProjectConfig(
  rendered: RenderedOpenCodeV1Config,
  projectConfig: OpenCodeProjectConfiguration,
): RenderedOpenCodeV1Config {
  const files = validateProjectFiles(projectConfig.files);
  const config = { ...rendered.config };
  const settings = projectConfig.settings;
  for (const [key, value] of Object.entries(settings)) {
    if (key === "$schema") {
      if (value !== OPENCODE_CONFIG_SCHEMA) {
        throw new OpenCodeConfigValidationError(["instance $schema is unsupported"]);
      }
      continue;
    }
    if (!OPEN_CODE_INSTANCE_SETTING_KEYS.has(key)) {
      throw new OpenCodeConfigValidationError([
        `instance opencode.json field '${key}' is unsupported or coordinator-controlled`,
      ]);
    }
    validateNoInstanceReferences(value, `opencode.json.${key}`);
  }

  const generatedMcp = asRecord(config.mcp);
  const rawMcp = asRecord(settings.mcp);
  if (settings.mcp !== undefined && !rawMcp) {
    throw new OpenCodeConfigValidationError(["instance mcp must be an object"]);
  }
  const configuredMcp = rawMcp ? { ...rawMcp } : undefined;
  for (const [name, server] of Object.entries(configuredMcp ?? {})) {
    if (generatedMcp?.[name] !== undefined) {
      throw new OpenCodeConfigValidationError([
        `instance mcp.${name} conflicts with coordinator-generated MCP configuration`,
      ]);
    }
    if (configuredMcp) configuredMcp[name] = renderInstanceMcpConfig(name, server);
  }

  if (settings.plugin !== undefined) {
    if (
      !Array.isArray(settings.plugin) ||
      settings.plugin.some((plugin) => typeof plugin !== "string")
    ) {
      throw new OpenCodeConfigValidationError([
        "instance plugin must be an array of pinned package names",
      ]);
    }
    settings.plugin.forEach((plugin, index) => {
      if (typeof plugin !== "string") return;
      const pinned = pinPackageReference(plugin, rendered.packageLock, `instance plugin[${index}]`);
      if (plugin !== pinned) {
        throw new OpenCodeConfigValidationError([
          `instance plugin[${index}] must use pinned package '${pinned}'`,
        ]);
      }
    });
  }

  const profileConfig: Record<string, JsonValue> = { ...settings };
  if (configuredMcp) profileConfig.mcp = configuredMcp;
  if (settings.instructions !== undefined) {
    profileConfig.instructions = normalizeOpenCodeInstructionPaths(settings.instructions, files);
  }

  const deniedPermissions =
    settings.permission === undefined
      ? []
      : validateDenyOnlyPermissions(settings.permission, "opencode.json.permission");
  const disabledTools =
    settings.tools === undefined
      ? {}
      : normalizeDisabledTools(settings.tools, "opencode.json.tools");
  if (
    Array.isArray(settings.disabled_providers) &&
    settings.disabled_providers.includes(rendered.effectiveModel.providerID)
  ) {
    throw new OpenCodeConfigValidationError([
      `instance disabled_providers cannot disable selected provider '${rendered.effectiveModel.providerID}'`,
    ]);
  }

  const enforcementJson = renderOpenCodeEnforcementConfig(config, {
    deniedPermissions,
    tools: disabledTools,
    disabledProviders: profileConfig.disabled_providers,
    mcp: configuredMcp,
  });
  const hash = createHash("sha256").update(stableJson(config), "utf8");
  // Permission order is semantic: reordered profile rules must invalidate reuse.
  hash.update("\0").update(JSON.stringify(profileConfig), "utf8");
  for (const file of files) {
    hash.update("\0").update(file.path, "utf8").update("\0").update(file.content, "utf8");
  }
  return {
    ...rendered,
    profileConfig: deepFreeze(profileConfig),
    enforcementJson,
    hash: hash.digest("hex"),
    projectFiles: Object.freeze(files),
  };
}

function renderOpenCodeEnforcementConfig(
  config: Record<string, JsonValue>,
  restrictions: {
    deniedPermissions?: readonly string[];
    tools?: Record<string, JsonValue>;
    disabledProviders?: JsonValue;
    mcp?: Record<string, JsonValue>;
  },
): string {
  const enforced: Record<string, JsonValue> = {};
  for (const key of [
    "share",
    "autoupdate",
    "lsp",
    "model",
    "small_model",
    "enabled_providers",
    "provider",
    "mcp",
    "permission",
  ]) {
    if (config[key] !== undefined) enforced[key] = config[key] as JsonValue;
  }
  if (enforced.small_model === undefined && typeof config.model === "string") {
    enforced.small_model = config.model;
  }
  if (restrictions.mcp) {
    enforced.mcp = { ...(asRecord(enforced.mcp) ?? {}), ...restrictions.mcp };
  }
  const permission = { ...(asRecord(enforced.permission) ?? {}) };
  for (const key of restrictions.deniedPermissions ?? []) permission[key] = "deny";
  const tools = restrictions.tools ?? {};
  for (const key of Object.keys(tools)) permission[key] = "deny";
  enforced.permission = permission;
  if (Object.keys(tools).length > 0) enforced.tools = tools;
  enforced.disabled_providers = restrictions.disabledProviders ?? [];
  return `${stableJson(enforced)}\n`;
}

function validateProjectFiles(files: readonly OpenCodeProjectFile[]): OpenCodeProjectFile[] {
  const seen = new Set<string>();
  return files.map(({ path, content }) => {
    assertSafeStagedPath(path);
    if (seen.has(path)) {
      throw new OpenCodeConfigValidationError([`duplicate instance file '${path}'`]);
    }
    if (typeof content !== "string") {
      throw new OpenCodeConfigValidationError([`instance file '${path}' must be text`]);
    }
    seen.add(path);
    return Object.freeze({ path, content });
  });
}

function assertSafeStagedPath(path: string): void {
  if (!isSafeOpenCodeProjectFilePath(path)) {
    throw new OpenCodeConfigValidationError([`instance file path '${path}' is not allowed`]);
  }
}

function validateDenyOnlyPermissions(value: JsonValue, path: string): string[] {
  const permissions = asRecord(value);
  if (!permissions) throw new OpenCodeConfigValidationError([`${path} must be an object`]);
  const denied: string[] = [];
  for (const [key, action] of Object.entries(permissions)) {
    if (action === "deny") {
      denied.push(key);
      continue;
    }
    const rules = asRecord(action);
    if (
      rules &&
      Object.values(rules).length > 0 &&
      Object.values(rules).every((rule) => rule === "deny")
    ) {
      denied.push(key);
      continue;
    }
    throw new OpenCodeConfigValidationError([
      `${path}.${key} may only add deny-only tool restrictions`,
    ]);
  }
  return denied;
}

function normalizeDisabledTools(value: JsonValue, path: string): Record<string, JsonValue> {
  const tools = asRecord(value);
  if (!tools) throw new OpenCodeConfigValidationError([`${path} must be an object`]);
  const disabled: Record<string, JsonValue> = {};
  for (const [name, enabled] of Object.entries(tools)) {
    if (enabled !== false) {
      throw new OpenCodeConfigValidationError([`${path}.${name} may only disable tools`]);
    }
    disabled[name] = false;
  }
  return disabled;
}

function validateNoInstanceReferences(value: unknown, path: string): void {
  if (typeof value === "string") {
    const allowsMcpUrl = /^opencode\.json\.mcp\.[^.]+\.url$/.test(path);
    const normalized = normalizeEnvString(value, path);
    const references = parseEnvironmentReferences(normalized, path);
    const key = path.split(".").at(-1) ?? "";
    if (SECRET_KEY.test(key) && references.length === 0) {
      throw new OpenCodeConfigValidationError([
        `${path} cannot contain literal credentials; reference credentials through validated runtime config`,
      ]);
    }
    const hasEnvironmentOrFileReference = /\{(?:env|file):|\$\{[A-Za-z_]/.test(value);
    if (hasEnvironmentOrFileReference && (!allowsMcpUrl || /\{file:/i.test(value))) {
      throw new OpenCodeConfigValidationError([
        `${path} cannot use environment or file references`,
      ]);
    }
    if (allowsMcpUrl) {
      for (const environment of references) assertMcpUrlEnvironment(environment, path);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      validateNoInstanceReferences(entry, `${path}[${index}]`);
    });
    return;
  }
  const object = asRecord(value);
  if (object) {
    for (const [key, entry] of Object.entries(object)) {
      validateNoInstanceReferences(entry, `${path}.${key}`);
    }
  }
}

/** Adapt native MCP syntax to the existing transport/security renderer. */
function renderInstanceMcpConfig(name: string, value: JsonValue): JsonValue {
  const config = asRecord(value);
  if (!config) throw new OpenCodeConfigValidationError([`mcp.${name} must be an object`]);
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new OpenCodeConfigValidationError([`mcp.${name}.enabled must be boolean`]);
  }
  const options = { alwaysLoad: config.enabled, timeout: config.timeout };
  let server: McpServerConfig;
  let allowed: string[];
  if (config.type === "local") {
    allowed = ["type", "command", "environment", "enabled", "timeout"];
    if (!Array.isArray(config.command) || config.command.length === 0) {
      throw new OpenCodeConfigValidationError([
        `mcp.${name}.command must be a non-empty string array`,
      ]);
    }
    server = {
      ...options,
      type: "stdio",
      command: config.command[0],
      args: config.command.slice(1),
      env: instanceMcpStringMap(config.environment, `mcp.${name}.environment`),
    } as McpServerConfig;
  } else if (config.type === "remote") {
    allowed = ["type", "url", "headers", "enabled", "timeout"];
    server = {
      ...options,
      type: "http",
      url: config.url,
      headers: instanceMcpStringMap(config.headers, `mcp.${name}.headers`),
    } as McpServerConfig;
  } else {
    throw new OpenCodeConfigValidationError([`mcp.${name}.type must be local or remote`]);
  }
  const unexpected = Object.keys(config).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new OpenCodeConfigValidationError([`mcp.${name}.${unexpected} is unsupported`]);
  }
  return renderMcpServers({ [name]: server })[name];
}

function instanceMcpStringMap(
  value: JsonValue | undefined,
  path: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const values = asObject(value);
  if (!values || Object.values(values).some((value) => typeof value !== "string")) {
    throw new OpenCodeConfigValidationError([`${path} values must be strings`]);
  }
  return values as Record<string, string>;
}

function asRecord(value: unknown): Record<string, JsonValue> | undefined {
  return asObject(value) as Record<string, JsonValue> | undefined;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeModel(
  rawModel: string,
  providerId: string | undefined,
): { providerId: string; modelId: string; value: string } {
  if (typeof rawModel !== "string" || rawModel.trim() === "") {
    throw new OpenCodeConfigValidationError(["model must be a non-empty string"]);
  }
  const model = rawModel.trim();
  const separator = model.indexOf("/");
  if (separator > 0 && separator < model.length - 1) {
    const parsedProvider = model.slice(0, separator);
    const modelId = model.slice(separator + 1);
    if (providerId !== undefined && providerId !== parsedProvider) {
      throw new OpenCodeConfigValidationError([
        `providerId '${providerId}' conflicts with model provider '${parsedProvider}'`,
      ]);
    }
    return { providerId: parsedProvider, modelId, value: model };
  }
  if (!providerId || providerId.trim() === "") {
    throw new OpenCodeConfigValidationError([
      `bare model '${model}' requires a deployment provider id`,
    ]);
  }
  const normalizedProvider = providerId.trim();
  return {
    providerId: normalizedProvider,
    modelId: model,
    value: `${normalizedProvider}/${model}`,
  };
}

function normalizeProviders(values: readonly OpenCodeProviderConfig[]): OpenCodeProviderConfig[] {
  const byId = new Map<string, OpenCodeProviderConfig>();
  for (const provider of values) {
    if (!provider || typeof provider.id !== "string" || provider.id.trim() === "") {
      throw new OpenCodeConfigValidationError(["provider id must be a non-empty string"]);
    }
    const id = provider.id.trim();
    if (byId.has(id)) {
      throw new OpenCodeConfigValidationError([`provider '${id}' is declared more than once`]);
    }
    byId.set(id, { ...provider, id });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function renderProviders(
  providers: readonly OpenCodeProviderConfig[],
  model: { providerId: string; modelId: string },
  packageLock: OpenCodePackageLock,
  requiredEnvironment: Set<string>,
): Record<string, JsonValue> | undefined {
  if (providers.length === 0) return undefined;
  const output: Record<string, JsonValue> = {};
  for (const provider of providers) {
    const entry: Record<string, JsonValue> = {};
    if (provider.id === "vertex") {
      if (provider.npm !== undefined) {
        throw new OpenCodeConfigValidationError(["provider.vertex.npm is coordinator-managed"]);
      }
      entry.npm = VERTEX_PROXY_PROVIDER_MODULE_URL;
    } else if (provider.npm !== undefined) {
      entry.npm = pinPackageReference(
        provider.npm,
        packageLock,
        `provider.${provider.id}.npm`,
        true,
      );
    }
    if (provider.name !== undefined) {
      const path = `provider.${provider.id}.name`;
      entry.name = normalizeProviderString(requireNonEmpty(provider.name, path), path);
    }
    if (provider.options !== undefined) {
      entry.options = normalizeJsonObject(
        provider.options,
        `provider.${provider.id}.options`,
        requiredEnvironment,
      );
    }
    const models: Record<string, JsonValue> = {};
    for (const [modelId, modelConfig] of sortedEntries(provider.models ?? {})) {
      models[requireNonEmpty(modelId, `provider.${provider.id}.models`)] = renderModelConfig(
        modelConfig,
        `provider.${provider.id}.models.${modelId}`,
        requiredEnvironment,
      );
    }
    if (provider.id === model.providerId && models[model.modelId] === undefined) {
      models[model.modelId] = { name: model.modelId };
    }
    if (Object.keys(models).length > 0) entry.models = models;
    output[provider.id] = entry;
  }
  return output;
}

function renderModelConfig(
  model: OpenCodeModelConfig,
  path: string,
  requiredEnvironment: Set<string>,
): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  if (model.name !== undefined) {
    const namePath = `${path}.name`;
    output.name = normalizeProviderString(requireNonEmpty(model.name, namePath), namePath);
  }
  if (model.reasoning !== undefined) {
    if (typeof model.reasoning !== "boolean") {
      throw new OpenCodeConfigValidationError([`${path}.reasoning must be a boolean`]);
    }
    output.reasoning = model.reasoning;
  }
  if (model.limit !== undefined) {
    output.limit = {
      context: positiveInteger(model.limit.context, `${path}.limit.context`),
      output: positiveInteger(model.limit.output, `${path}.limit.output`),
    };
  }
  if (model.options !== undefined) {
    output.options = normalizeJsonObject(model.options, `${path}.options`, requiredEnvironment);
  }
  return output;
}

function renderMcpServers(
  servers: Readonly<Record<string, McpServerConfig>>,
): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const [name, server] of sortedEntries(servers)) {
    const options = {
      enabled: server.alwaysLoad !== false,
      ...(server.timeout === undefined
        ? {}
        : { timeout: positiveInteger(server.timeout, `mcp.${name}.timeout`) }),
    };
    if ("command" in server) {
      if (server.type !== undefined && server.type !== "stdio") {
        throw new OpenCodeConfigValidationError([
          `mcp.${name}.type must be stdio when command is provided`,
        ]);
      }
      const command = [server.command, ...(server.args ?? [])];
      if (command.some((part) => typeof part !== "string" || part.length === 0)) {
        throw new OpenCodeConfigValidationError([
          `mcp.${name}.command must contain non-empty strings`,
        ]);
      }
      output[name] = {
        type: "local",
        command,
        ...(server.env === undefined
          ? {}
          : {
              environment: normalizeJsonObject(
                server.env,
                `mcp.${name}.env`,
                undefined,
                rejectMcpEnvironmentReference,
              ),
            }),
        ...options,
      };
      continue;
    }

    if (server.type !== "http" && server.type !== "sse") {
      throw new OpenCodeConfigValidationError([
        `mcp.${name}.type must be http or sse when url is provided`,
      ]);
    }
    const url = normalizeEnvString(
      requireNonEmpty(server.url, `mcp.${name}.url`),
      `mcp.${name}.url`,
      assertMcpUrlEnvironment,
    );
    assertHttpUrlTemplate(url, `mcp.${name}.url`);
    output[name] = {
      type: "remote",
      url,
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
      ...options,
    };
  }
  return output;
}

function renderPermissions(
  allowedTools: readonly string[],
  configuredMcpServers: readonly string[],
  optionalMcpServers: readonly string[],
  additionalDirectories: readonly string[],
): Record<string, JsonValue> {
  const permissions: Record<string, JsonValue> = {};
  const configured = new Set(configuredMcpServers);
  const optional = new Set(optionalMcpServers);
  for (const server of [...configuredMcpServers].sort()) {
    permissions[`${server}_*`] = "deny";
  }
  const mcpPermissionSources = new Map<string, string>();

  for (const tool of allowedTools) {
    const mcp = parseClaudeMcpTool(tool);
    if (mcp) {
      if (!configured.has(mcp.server)) {
        if (optional.has(mcp.server)) continue;
        throw new OpenCodeConfigValidationError([
          `allowed MCP tool '${tool}' references unconfigured server '${mcp.server}'`,
        ]);
      }
      const key = `${mcp.server}_${mcp.tool}`;
      const source = `${mcp.server}/${mcp.tool}`;
      const previousSource = mcpPermissionSources.get(key);
      if (previousSource !== undefined && previousSource !== source) {
        throw new OpenCodeConfigValidationError([
          `MCP permission key '${key}' collides for '${previousSource}' and '${source}'`,
        ]);
      }
      mcpPermissionSources.set(key, source);
      permissions[key] = "allow";
      continue;
    }

    const bashPattern = tool.match(/^Bash\((.*)\)$/s);
    if (bashPattern) {
      const pattern = bashPattern[1];
      if (!pattern)
        throw new OpenCodeConfigValidationError(["Bash permission pattern cannot be empty"]);
      const existing = permissions.bash;
      const rules = (asObject(existing) as Record<string, JsonValue> | undefined) ?? {
        "*": "deny",
      };
      rules[pattern] = "allow";
      permissions.bash = rules;
      continue;
    }

    const mapped = CLAUDE_TOOL_TO_OPENCODE[tool];
    if (!mapped) {
      throw new OpenCodeConfigValidationError([
        `allowed tool '${tool}' cannot be mapped to an OpenCode permission`,
      ]);
    }
    permissions[mapped] = "allow";
  }

  for (const tool of BUILTIN_TOOLS) {
    if (permissions[tool] === undefined) permissions[tool] = "deny";
  }
  if (additionalDirectories.length > 0) {
    const directories: Record<string, JsonValue> = { "*": "deny" };
    for (const directory of additionalDirectories) {
      directories[`${directory}/*`] = "allow";
    }
    permissions.external_directory = directories;
  }
  return permissions;
}

/** Literal, canonical POSIX paths only: permission keys must never contain native globs/refs. */
export function validateAdditionalDirectories(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new OpenCodeConfigValidationError([
      "additionalDirectories must be an array of absolute paths",
    ]);
  }
  for (const directory of value) {
    if (
      typeof directory !== "string" ||
      !posix.isAbsolute(directory) ||
      directory === "/" ||
      posix.normalize(directory) !== directory ||
      /[\\*?[\]{}$~\p{Cc}\p{Cf}]/u.test(directory) ||
      directory
        .split("/")
        .slice(1)
        .some((segment) => !segment || segment.trim() !== segment)
    ) {
      throw new OpenCodeConfigValidationError([
        "additionalDirectories must contain canonical absolute non-root paths without wildcards, traversal, controls, or references",
      ]);
    }
  }
  return [...new Set(value as string[])].sort();
}

function parseClaudeMcpTool(tool: string): { server: string; tool: string } | undefined {
  const match = /^mcp__(.+)__(.+)$/.exec(tool);
  if (!match) return undefined;
  return { server: match[1], tool: match[2] };
}

function renderPlugins(
  plugins: readonly OpenCodePluginConfig[],
  packageLock: OpenCodePackageLock,
  requiredEnvironment: Set<string>,
): JsonValue[] {
  return plugins
    .map((plugin, index) => {
      const spec = pinPackageReference(plugin.name, packageLock, `plugin[${index}]`);
      if (plugin.options === undefined) return spec;
      return [
        spec,
        normalizeJsonObject(plugin.options, `plugin[${index}].options`, requiredEnvironment),
      ] as JsonValue;
    })
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function requireNonEmpty(value: string, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OpenCodeConfigValidationError([`${path} must be a non-empty string`]);
  }
  return value;
}

function normalizeProviderString(value: string, path: string): string {
  normalizeEnvString(value, path, (environment, referencePath) =>
    assertProviderEnvironment(environment, referencePath, false),
  );
  return value;
}

function positiveInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new OpenCodeConfigValidationError([`${path} must be a positive safe integer`]);
  }
  return value;
}
