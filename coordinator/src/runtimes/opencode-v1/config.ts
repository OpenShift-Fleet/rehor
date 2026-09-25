import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ConfigPreparationResult } from "../../ports/python-bridge";
import type { McpServerConfig } from "../../ports/runtime-config";
import { stableJson } from "../shared";
import {
  OPENCODE_BLOCKED_PASSTHROUGH,
  OPENCODE_BLOCKED_PASSTHROUGH_PREFIXES,
  OPENCODE_MCP_URL_ENVIRONMENT,
  OPENCODE_PROVIDER_ENVIRONMENT_ALLOWLIST,
} from "./environment";

export const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json" as const;
export const OPENCODE_PACKAGE_LOCK_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface OpenCodeModelConfig {
  name?: string;
  options?: Readonly<Record<string, JsonValue>>;
}

export interface OpenCodeProviderConfig {
  id: string;
  npm?: string;
  name?: string;
  options?: Readonly<Record<string, JsonValue>>;
  models?: Readonly<Record<string, OpenCodeModelConfig>>;
}

export interface OpenCodePluginConfig {
  name: string;
  version: string;
  options?: Readonly<Record<string, JsonValue>>;
}

export interface OpenCodePackage {
  name: string;
  version: string;
}

export interface OpenCodePackageLock {
  readonly lockfileVersion: typeof OPENCODE_PACKAGE_LOCK_VERSION;
  readonly packages: Readonly<Record<string, string>>;
}

/** Runtime-owned input. No OpenCode SDK types cross this boundary. */
export interface OpenCodeV1ConfigInput {
  /** Either `provider/model` or a model ID paired with `providerId`. */
  model: string;
  providerId?: string;
  providers?: readonly OpenCodeProviderConfig[];
  /** Convenience form for a single deployment provider. */
  provider?: OpenCodeProviderConfig;
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
  allowedTools?: readonly string[];
  /** MCP servers whose grants may be omitted when persona configuration excludes them. */
  optionalMcpServers?: readonly string[];
  plugins?: readonly OpenCodePluginConfig[];
  packages?: readonly OpenCodePackage[];
  /** Additional package declarations supplied by the packaging contract. */
  packageLock?: OpenCodePackageLock;
  smallModel?: string;
}

/** Deployment-owned fields that are merged with one prepared cycle. */
export type OpenCodeV1DeploymentConfig = Omit<
  OpenCodeV1ConfigInput,
  "model" | "providerId" | "mcpServers" | "allowedTools" | "optionalMcpServers"
> & {
  model?: string;
  providerId?: string;
};

/** Build renderer input from the provider-neutral Python preparation result. */
export function renderOpenCodeV1ConfigForCycle(
  preparation: Pick<
    ConfigPreparationResult,
    "model" | "mcpServers" | "openCodeMcpServers" | "allowedTools" | "optionalMcpServers"
  >,
  providerId: string,
  deployment: OpenCodeV1DeploymentConfig = {},
): RenderedOpenCodeV1Config {
  return renderOpenCodeV1Config({
    ...deployment,
    model: deployment.model ?? preparation.model,
    providerId: deployment.providerId ?? providerId,
    mcpServers: preparation.openCodeMcpServers,
    allowedTools: preparation.allowedTools ?? [],
    optionalMcpServers: preparation.optionalMcpServers ?? [],
  });
}

export interface RenderedOpenCodeV1Config {
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly json: string;
  readonly hash: string;
  readonly packageLock: OpenCodePackageLock;
  /** Agent environment variables required by trusted provider/plugin config; never MCP refs. */
  requiredEnvironment: readonly string[];
}

export interface OpenCodeConfigFiles {
  configPath: string;
  packageLockPath: string;
}

export class OpenCodeConfigValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`OpenCode configuration validation failed: ${issues.join("; ")}`);
    this.name = "OpenCodeConfigValidationError";
    this.issues = issues;
  }
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

const SECRET_KEY =
  /(?:api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)/i;
const ENV_REFERENCE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
const BRACED_ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BLOCKED_PASSTHROUGH_ENVIRONMENTS: ReadonlySet<string> = new Set(OPENCODE_BLOCKED_PASSTHROUGH);
const PROVIDER_ENVIRONMENT_ALLOWLIST: ReadonlySet<string> = new Set(
  OPENCODE_PROVIDER_ENVIRONMENT_ALLOWLIST,
);
/** Render one deterministic, fail-closed OpenCode V1 configuration. */
export function renderOpenCodeV1Config(input: OpenCodeV1ConfigInput): RenderedOpenCodeV1Config {
  const model = normalizeModel(input.model, input.providerId ?? input.provider?.id);
  const providers = normalizeProviders(input);
  const packageLock = normalizePackageLock(
    input.packages ?? [],
    input.packageLock,
    input.plugins ?? [],
    providers,
  );
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

  validateOpenCodeV1Config(config, packageLock);
  const json = `${stableJson(config)}\n`;
  return {
    config: deepFreeze(config),
    json,
    hash: createHash("sha256").update(stableJson(config), "utf8").digest("hex"),
    packageLock: deepFreeze(packageLock),
    requiredEnvironment: Object.freeze([...requiredEnvironment].sort()),
  };
}

/** Validate a rendered config and every package reference it contains. */
export function validateOpenCodeV1Config(
  config: Record<string, unknown>,
  packageLock: OpenCodePackageLock,
): void {
  validatePackageLock(packageLock);
  const issues: string[] = [];
  if (config.$schema !== OPENCODE_CONFIG_SCHEMA) {
    issues.push(`$schema must be ${OPENCODE_CONFIG_SCHEMA}`);
  }
  if (config.share !== "disabled") issues.push("share must be disabled");
  if (config.autoupdate !== false) issues.push("autoupdate must be false");
  if (config.lsp !== false) issues.push("lsp must be false");

  const model = config.model;
  if (typeof model !== "string" || !model.includes("/")) {
    issues.push("model must use provider/model form");
  }

  const enabled = config.enabled_providers;
  if (
    !Array.isArray(enabled) ||
    enabled.length === 0 ||
    enabled.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    issues.push("enabled_providers must contain at least one provider ID");
  }

  const providers = asRecord(config.provider);
  if (providers) {
    for (const [providerId, value] of Object.entries(providers)) {
      const provider = asRecord(value);
      if (!provider) {
        issues.push(`provider.${providerId} must be an object`);
        continue;
      }
      const npm = provider.npm;
      if (npm !== undefined)
        validatePackageReference(npm, packageLock, `provider.${providerId}.npm`, issues);
      validateNoLiteralSecrets(provider, `provider.${providerId}`, issues);
    }
  }

  const plugins = config.plugin;
  if (plugins !== undefined) {
    if (!Array.isArray(plugins)) issues.push("plugin must be an array");
    else {
      plugins.forEach((value, index) => {
        const spec = Array.isArray(value) ? value[0] : value;
        if (typeof spec !== "string") issues.push(`plugin[${index}] must be a package spec`);
        else validatePackageReference(spec, packageLock, `plugin[${index}]`, issues);
      });
    }
  }

  const mcp = asRecord(config.mcp);
  if (mcp) {
    for (const [name, value] of Object.entries(mcp)) validateMcpConfig(name, value, issues);
  }

  const permission = asRecord(config.permission);
  if (!permission) issues.push("permission must be an object");
  else validatePermissions(permission, issues);

  if (issues.length > 0) throw new OpenCodeConfigValidationError(issues);
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

function normalizeProviders(input: OpenCodeV1ConfigInput): OpenCodeProviderConfig[] {
  const values = [...(input.providers ?? [])];
  if (input.provider) values.push(input.provider);
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

function normalizePackageLock(
  packages: readonly OpenCodePackage[],
  supplied: OpenCodePackageLock | undefined,
  plugins: readonly OpenCodePluginConfig[],
  providers: readonly OpenCodeProviderConfig[],
): OpenCodePackageLock {
  const values = new Map<string, string>();
  for (const [name, version] of Object.entries(supplied?.packages ?? {})) {
    addPackage(values, name, version, "packageLock");
  }
  for (const item of packages) addPackage(values, item.name, item.version, "packages");
  for (const plugin of plugins) {
    const packageReference = parsePackageReference(plugin.name);
    if (packageReference === undefined) {
      throw new OpenCodeConfigValidationError([
        `plugins must use a declared npm package, got '${plugin.name}'`,
      ]);
    }
    addPackage(values, packageReference.name, plugin.version, "plugins");
  }
  for (const provider of providers) {
    if (provider.npm === undefined) continue;
    const packageReference = parsePackageReference(provider.npm);
    if (packageReference?.version !== undefined) {
      addPackage(
        values,
        packageReference.name,
        packageReference.version,
        `provider.${provider.id}.npm`,
      );
    }
  }
  return {
    lockfileVersion: OPENCODE_PACKAGE_LOCK_VERSION,
    packages: Object.fromEntries(
      [...values.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function addPackage(
  values: Map<string, string>,
  name: string,
  version: string,
  path: string,
): void {
  if (!isPackageName(name))
    throw new OpenCodeConfigValidationError([`${path} contains invalid package '${name}'`]);
  if (!EXACT_VERSION.test(version)) {
    throw new OpenCodeConfigValidationError([
      `${path}.${name} must use an exact version, got '${version}'`,
    ]);
  }
  const existing = values.get(name);
  if (existing !== undefined && existing !== version) {
    throw new OpenCodeConfigValidationError([
      `package '${name}' has conflicting pinned versions '${existing}' and '${version}'`,
    ]);
  }
  values.set(name, version);
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
      const packageSpec = pinPackageReference(
        provider.npm,
        packageLock,
        `provider.${provider.id}.npm`,
      );
      entry.npm = packageSpec;
    }
    if (provider.name !== undefined)
      entry.name = requireNonEmpty(provider.name, `provider.${provider.id}.name`);
    if (provider.options !== undefined) {
      entry.options = normalizeJsonObject(
        provider.options,
        `provider.${provider.id}.options`,
        requiredEnvironment,
      );
    }
    const models: Record<string, JsonValue> = {};
    for (const [modelId, modelConfig] of Object.entries(provider.models ?? {}).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
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
  if (model.name !== undefined) output.name = requireNonEmpty(model.name, `${path}.name`);
  if (model.options !== undefined) {
    output.options = normalizeJsonObject(model.options, `${path}.options`, requiredEnvironment);
  }
  return output;
}

function renderMcpServers(
  servers: Readonly<Record<string, McpServerConfig>>,
): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const [name, server] of Object.entries(servers).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const enabled = server.alwaysLoad !== false;
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
              environment: normalizeStringRecord(
                server.env,
                `mcp.${name}.env`,
                undefined,
                rejectMcpEnvironmentReference,
              ),
            }),
        enabled,
        ...(server.timeout === undefined
          ? {}
          : { timeout: positiveInteger(server.timeout, `mcp.${name}.timeout`) }),
      };
      continue;
    }

    if (server.type !== "http" && server.type !== "sse") {
      throw new OpenCodeConfigValidationError([
        `mcp.${name}.type must be http or sse when url is provided`,
      ]);
    }
    const url = normalizeEnvironmentReference(requireNonEmpty(server.url, `mcp.${name}.url`));
    for (const environment of parseEnvironmentReferences(url)) {
      assertMcpUrlEnvironment(environment, `mcp.${name}.url`);
    }
    assertHttpUrlTemplate(url, `mcp.${name}.url`);
    output[name] = {
      type: "remote",
      url,
      ...(server.headers === undefined
        ? {}
        : {
            headers: normalizeStringRecord(
              server.headers,
              `mcp.${name}.headers`,
              undefined,
              rejectMcpEnvironmentReference,
            ),
          }),
      enabled,
      ...(server.timeout === undefined
        ? {}
        : { timeout: positiveInteger(server.timeout, `mcp.${name}.timeout`) }),
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
      const rules = asRecord(existing) ?? { "*": "deny" };
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
  const server = match[1];
  const name = match[2];
  if (!server || !name) {
    throw new OpenCodeConfigValidationError([`MCP tool '${tool}' has an invalid server/tool name`]);
  }
  return { server, tool: name === "*" ? "*" : name };
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

function pinPackageReference(
  rawSpec: string,
  packageLock: OpenCodePackageLock,
  path: string,
): string {
  const parsed = parsePackageReference(rawSpec);
  if (parsed === undefined) {
    throw new OpenCodeConfigValidationError([
      `${path} must use a declared npm package, got '${rawSpec}'`,
    ]);
  }
  const pinned = packageLock.packages[parsed.name];
  if (pinned === undefined) {
    throw new OpenCodeConfigValidationError([
      `package '${parsed.name}' is not declared with an exact version for ${path}`,
    ]);
  }
  if (parsed.version !== undefined && parsed.version !== pinned) {
    throw new OpenCodeConfigValidationError([
      `${path} pins '${parsed.name}@${parsed.version}' but package lock has '${pinned}'`,
    ]);
  }
  return `${parsed.name}@${pinned}`;
}

function validatePackageReference(
  rawSpec: unknown,
  packageLock: OpenCodePackageLock,
  path: string,
  issues: string[],
): void {
  if (typeof rawSpec !== "string") {
    issues.push(`${path} must be a string`);
    return;
  }
  const parsed = parsePackageReference(rawSpec);
  if (parsed === undefined) {
    issues.push(`${path} must use a declared npm package`);
    return;
  }
  const pinned = packageLock.packages[parsed.name];
  if (pinned === undefined) {
    issues.push(`package '${parsed.name}' referenced by ${path} is not in the package lock`);
  } else if (parsed.version !== pinned) {
    issues.push(`${path} must use pinned package '${parsed.name}@${pinned}'`);
  }
}

function parsePackageReference(rawSpec: string): { name: string; version?: string } | undefined {
  const spec = rawSpec.startsWith("npm:") ? rawSpec.slice("npm:".length) : rawSpec;
  if (spec.startsWith("file:") || spec.startsWith(".") || spec.startsWith("/")) return undefined;
  if (spec.startsWith("@")) {
    const separator = spec.indexOf("@", 1);
    if (separator < 0) return { name: spec };
    return { name: spec.slice(0, separator), version: spec.slice(separator + 1) };
  }
  const separator = spec.indexOf("@");
  if (separator < 0) return { name: spec };
  return { name: spec.slice(0, separator), version: spec.slice(separator + 1) };
}

type EnvironmentReferenceValidator = (name: string, path: string) => void;

function normalizeJsonObject(
  input: Readonly<Record<string, JsonValue>>,
  path: string,
  requiredEnvironment: Set<string> | undefined,
  validateEnvironment: EnvironmentReferenceValidator = assertProviderEnvironment,
): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    output[key] = normalizeJsonValue(
      value,
      `${path}.${key}`,
      requiredEnvironment,
      key,
      validateEnvironment,
    );
  }
  return output;
}

function normalizeJsonValue(
  value: JsonValue,
  path: string,
  requiredEnvironment: Set<string> | undefined,
  key: string,
  validateEnvironment: EnvironmentReferenceValidator = assertProviderEnvironment,
): JsonValue {
  if (typeof value === "string") {
    const normalized = normalizeEnvironmentReference(value);
    const environments = parseEnvironmentReferences(normalized);
    for (const environment of environments) {
      validateEnvironment(environment, path);
      requiredEnvironment?.add(environment);
    }
    if (SECRET_KEY.test(key) && environments.length === 0) {
      throw new OpenCodeConfigValidationError([
        `${path} must use an OpenCode environment reference`,
      ]);
    }
    return normalized;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeJsonValue(entry, `${path}[${index}]`, requiredEnvironment, key, validateEnvironment),
    );
  }
  const object = asRecord(value);
  if (object) return normalizeJsonObject(object, path, requiredEnvironment, validateEnvironment);
  return value;
}

function normalizeStringRecord(
  input: Readonly<Record<string, string>>,
  path: string,
  requiredEnvironment: Set<string> | undefined,
  validateEnvironment: EnvironmentReferenceValidator = assertProviderEnvironment,
): Record<string, JsonValue> {
  const values: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    values[key] = normalizeJsonValue(
      value,
      `${path}.${key}`,
      requiredEnvironment,
      key,
      validateEnvironment,
    );
  }
  return values;
}

function isCoordinatorControlledEnvironment(name: string): boolean {
  return OPENCODE_BLOCKED_PASSTHROUGH_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function assertProviderEnvironment(name: string, path: string): void {
  if (isCoordinatorControlledEnvironment(name)) {
    throw new OpenCodeConfigValidationError([
      `${path} cannot reference a coordinator-controlled environment variable`,
    ]);
  }
  if (BLOCKED_PASSTHROUGH_ENVIRONMENTS.has(name)) {
    throw new OpenCodeConfigValidationError([
      `${path} cannot reference a blocked OpenCode environment variable '${name}'`,
    ]);
  }
  if (!PROVIDER_ENVIRONMENT_ALLOWLIST.has(name)) {
    throw new OpenCodeConfigValidationError([
      `${path} cannot reference an unapproved OpenCode environment variable '${name}'`,
    ]);
  }
}

function assertMcpUrlEnvironment(name: string, path: string): void {
  if (name !== OPENCODE_MCP_URL_ENVIRONMENT) {
    throw new OpenCodeConfigValidationError([
      `${path} cannot reference an unapproved environment variable '${name}'`,
    ]);
  }
}

function rejectMcpEnvironmentReference(name: string, path: string): void {
  throw new OpenCodeConfigValidationError([
    `${path} cannot reference an environment variable '${name}'`,
  ]);
}

function normalizeEnvironmentReference(value: string): string {
  return value.replace(BRACED_ENV_REFERENCE, "{env:$1}");
}

function parseEnvironmentReferences(value: string): string[] {
  return [...value.matchAll(ENV_REFERENCE)].map((match) => match[1]);
}

function validateNoLiteralSecrets(value: JsonValue, path: string, issues: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      validateNoLiteralSecrets(entry, `${path}[${index}]`, issues);
    });
    return;
  }
  const object = asRecord(value);
  if (!object) return;
  for (const [key, entry] of Object.entries(object)) {
    if (typeof entry === "string") {
      const environments = parseEnvironmentReferences(entry);
      if (environments.some(isCoordinatorControlledEnvironment)) {
        issues.push(`${path}.${key} references a coordinator-controlled environment variable`);
      } else if (environments.some((name) => BLOCKED_PASSTHROUGH_ENVIRONMENTS.has(name))) {
        issues.push(`${path}.${key} references a blocked OpenCode environment variable`);
      }
      if (SECRET_KEY.test(key) && environments.length === 0) {
        issues.push(`${path}.${key} must use an OpenCode environment reference`);
      }
    }
    validateNoLiteralSecrets(entry, `${path}.${key}`, issues);
  }
}

function validateMcpConfig(name: string, value: unknown, issues: string[]): void {
  const config = asRecord(value);
  if (!config) {
    issues.push(`mcp.${name} must be an object`);
    return;
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    issues.push(`mcp.${name}.enabled must be boolean`);
  }
  if (config.type === "local") {
    if (
      !Array.isArray(config.command) ||
      config.command.some((part) => typeof part !== "string" || part.length === 0)
    ) {
      issues.push(`mcp.${name}.command must be a non-empty string array`);
    }
    if (config.environment !== undefined) {
      validateNoMcpEnvironmentReferences(config.environment, `mcp.${name}.environment`, issues);
    }
  } else if (config.type === "remote") {
    if (typeof config.url !== "string") issues.push(`mcp.${name}.url must be a string`);
    else {
      const url = normalizeEnvironmentReference(config.url);
      for (const environment of parseEnvironmentReferences(url)) {
        if (environment !== OPENCODE_MCP_URL_ENVIRONMENT) {
          issues.push(
            `mcp.${name}.url cannot reference an unapproved environment variable '${environment}'`,
          );
        }
      }
      try {
        assertHttpUrlTemplate(url, `mcp.${name}.url`);
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (config.headers !== undefined) {
      validateNoMcpEnvironmentReferences(config.headers, `mcp.${name}.headers`, issues);
    }
  } else {
    issues.push(`mcp.${name}.type must be local or remote`);
  }
  if (
    config.timeout !== undefined &&
    (typeof config.timeout !== "number" ||
      !Number.isSafeInteger(config.timeout) ||
      config.timeout <= 0)
  ) {
    issues.push(`mcp.${name}.timeout must be a positive safe integer`);
  }
  validateNoLiteralSecrets(config, `mcp.${name}`, issues);
}

function validateNoMcpEnvironmentReferences(value: unknown, path: string, issues: string[]): void {
  if (typeof value === "string") {
    for (const environment of parseEnvironmentReferences(normalizeEnvironmentReference(value))) {
      issues.push(`${path} cannot reference an environment variable '${environment}'`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      validateNoMcpEnvironmentReferences(entry, `${path}[${index}]`, issues);
    });
    return;
  }
  const object = asRecord(value);
  if (!object) return;
  for (const [key, entry] of Object.entries(object)) {
    validateNoMcpEnvironmentReferences(entry, `${path}.${key}`, issues);
  }
}

function validatePermissions(permission: Record<string, unknown>, issues: string[]): void {
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      if (!isPermissionAction(value))
        issues.push(`permission.${key} has invalid action '${value}'`);
      continue;
    }
    const rules = asRecord(value);
    if (!rules) {
      issues.push(`permission.${key} must be ask, allow, deny, or an object of rules`);
      continue;
    }
    for (const [pattern, action] of Object.entries(rules)) {
      if (!isPermissionAction(action))
        issues.push(`permission.${key}.${pattern} has invalid action '${action}'`);
    }
  }
}

function isPermissionAction(value: unknown): value is "ask" | "allow" | "deny" {
  return value === "ask" || value === "allow" || value === "deny";
}

function validatePackageLock(packageLock: OpenCodePackageLock): void {
  const issues: string[] = [];
  if (packageLock.lockfileVersion !== OPENCODE_PACKAGE_LOCK_VERSION) {
    issues.push("package lock version is unsupported");
  }
  for (const [name, version] of Object.entries(packageLock.packages)) {
    if (!isPackageName(name)) issues.push(`package lock contains invalid package '${name}'`);
    if (!EXACT_VERSION.test(version)) issues.push(`package lock ${name} is not pinned exactly`);
  }
  if (issues.length > 0) throw new OpenCodeConfigValidationError(issues);
}

function isPackageName(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    (value.startsWith("@")
      ? /^@[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(value)
      : /^[a-zA-Z0-9._-]+$/.test(value))
  );
}

function requireNonEmpty(value: string, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OpenCodeConfigValidationError([`${path} must be a non-empty string`]);
  }
  return value;
}

function positiveInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new OpenCodeConfigValidationError([`${path} must be a positive safe integer`]);
  }
  return value;
}

function assertHttpUrlTemplate(value: string, path: string): void {
  const environments = parseEnvironmentReferences(value);
  if (environments.length > 0) {
    if (value === `{env:${environments[0]}}` && environments.length === 1) return;
    value = value.replace(/\{env:[^}]+\}/g, "env-placeholder");
  }
  assertHttpUrl(value, path);
  const url = new URL(value);
  for (const [key, entry] of url.searchParams.entries()) {
    if (SECRET_KEY.test(key) && !entry.includes("env-placeholder")) {
      throw new OpenCodeConfigValidationError([
        `${path} contains a literal credential query parameter`,
      ]);
    }
  }
}

function assertHttpUrl(value: string, path: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenCodeConfigValidationError([`${path} must be an absolute HTTP(S) URL`]);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OpenCodeConfigValidationError([`${path} must use HTTP(S)`]);
  }
  if (url.username || url.password) {
    throw new OpenCodeConfigValidationError([`${path} must not contain credentials`]);
  }
}

function asRecord(value: unknown): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}
