import type { McpServerConfig } from "../../ports/runtime-config";

export const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json" as const;
export const OPENCODE_PACKAGE_LOCK_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface OpenCodeModelConfig {
  name?: string;
  modelID?: string;
  limit?: { context: number; output: number };
  settings?: Readonly<Record<string, JsonValue>>;
  capabilities?: {
    tools?: boolean;
    input?: string[];
    output?: string[];
    temperature?: boolean;
    reasoning?: {
      supported: boolean;
      toggle?: boolean;
      effort?: string[];
      budget?: { min?: number; max?: number };
    };
  };
}

export interface OpenCodeProviderConfig {
  id: string;
  package?: string;
  name?: string;
  settings?: Readonly<Record<string, JsonValue>>;
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
  /** Build declarations; V2's bundled native provider versions belong to the pinned binary. */
  readonly packages: Readonly<Record<string, string>>;
}

/** Runtime-owned input. No OpenCode SDK types cross this boundary. */
export interface OpenCodeConfigInput {
  /** Either `provider/model` or a model ID paired with `providerId`. */
  model: string;
  providerId?: string;
  providers?: readonly OpenCodeProviderConfig[];
  mcpServers?: Readonly<Record<string, McpServerConfig>>;
  allowedTools?: readonly string[];
  /** MCP servers whose grants may be omitted when persona configuration excludes them. */
  optionalMcpServers?: readonly string[];
  plugins?: readonly OpenCodePluginConfig[];
  packages?: readonly OpenCodePackage[];
  /** Rehor utility-model selection; rendered only as native agents.title.model. */
  smallModel?: string;
  /** Trusted deployment grants outside the run worktree; not a filesystem sandbox. */
  additionalDirectories?: readonly string[];
}

/** Deployment-owned fields that are merged with one prepared cycle. */
export type OpenCodeDeploymentConfig = Omit<
  OpenCodeConfigInput,
  "model" | "providerId" | "mcpServers" | "allowedTools" | "optionalMcpServers"
> & {
  model?: string;
  providerId?: string;
};

export interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export interface EffectiveOpenCodeModel {
  readonly providerID: string;
  readonly modelID: string;
  readonly value: string;
}

export interface RenderedOpenCodeConfig {
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly json: string;
  /** Validated GitOps profile settings staged as OPENCODE_CONFIG. */
  readonly profileConfig: Readonly<Record<string, JsonValue>>;
  /** Runner-owned final layer; external-directory policies must also be staged globally. */
  readonly enforcementJson: string;
  readonly hash: string;
  readonly packageLock: OpenCodePackageLock;
  readonly effectiveModel: EffectiveOpenCodeModel;
  /** Agent environment variables required by trusted provider/plugin config; never MCP refs. */
  requiredEnvironment: readonly string[];
  /** Validated profile files staged under isolated global OpenCode resource paths. */
  readonly projectFiles: readonly { readonly path: string; readonly content: string }[];
}

export interface OpenCodeConfigFiles {
  configPath: string;
  globalConfigPath: string;
  globalConfigDirectory: string;
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
