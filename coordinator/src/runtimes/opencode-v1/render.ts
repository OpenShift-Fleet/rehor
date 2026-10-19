import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ConfigPreparationResult } from "../../ports/python-bridge";
import type { McpServerConfig } from "../../ports/runtime-config";
import { asObject, sortedEntries, stableJson } from "../shared";
import {
  assertHttpUrlTemplate,
  assertMcpUrlEnvironment,
  assertProviderEnvironment,
  normalizeEnvString,
  normalizeJsonObject,
  rejectMcpEnvironmentReference,
} from "./env-refs";
import { normalizePackageLock, pinPackageReference } from "./packages";
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
): RenderedOpenCodeV1Config {
  return renderOpenCodeV1Config({
    ...normalizeDeploymentConfig(deployment),
    model: deployment.model ?? preparation.model,
    providerId: deployment.providerId ?? providerId,
    mcpServers: preparation.openCodeMcpServers,
    allowedTools: preparation.allowedTools ?? [],
    optionalMcpServers: preparation.optionalMcpServers ?? [],
  });
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
    hash: createHash("sha256").update(stable, "utf8").digest("hex"),
    packageLock: deepFreeze(packageLock),
    effectiveModel: Object.freeze({
      providerID: model.providerId,
      modelID: model.modelId,
      value: model.value,
    }),
    requiredEnvironment: Object.freeze([...requiredEnvironment].sort()),
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
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "opencode.json");
  const packageLockPath = join(directory, "opencode-packages.lock.json");
  await Promise.all([
    writeFile(configPath, rendered.json, "utf8"),
    writeFile(packageLockPath, `${stableJson(rendered.packageLock)}\n`, "utf8"),
  ]);
  return { configPath, packageLockPath };
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
    if (provider.npm !== undefined) {
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
  return permissions;
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
