import type { InstructionStrategy } from "../instructions";
import type { McpServerConfig } from "./runtime-config";

export enum PreflightAction {
  Start = "start",
  Skip = "skip",
  Error = "error",
}

const SUPPORTED_PREFLIGHT_ACTIONS = Object.values(PreflightAction);

export function isPreflightAction(value: unknown): value is PreflightAction {
  return (
    typeof value === "string" && SUPPORTED_PREFLIGHT_ACTIONS.includes(value as PreflightAction)
  );
}

export type PreflightScriptStatus = PreflightAction;

export interface PreflightScriptResult {
  name: string;
  status: PreflightScriptStatus;
  content: string;
}

export interface PreflightResult {
  action: PreflightAction;
  prompt: string;
  transcript: string;
  scripts: readonly PreflightScriptResult[];
}

export interface PreflightRequest {
  scriptDir: string;
  workflow: string;
  remoteAgentDir?: string | null;
  instanceId?: string | null;
}

export interface ConfigPreparationRequest {
  scriptDir: string;
  label: string;
}

export interface ConfigPreparationResult {
  model: string;
  maxTurns: number;
  intervalSeconds: number;
  idleIntervalSeconds: number;
  cycleTimeoutSeconds: number;
  idleReminderCooldownSeconds: number;
  workflow: string;
  source: string;
  envs: readonly string[] | null;
  activeEnvs: readonly string[];
  claudeMdStrategy: InstructionStrategy;
  idleCycleLimit: number;
  remoteAgentDir: string | null;
  sharedAgentDir: string | null;
  claudeMdPath: string;
  /** MCP servers for the legacy Claude adapter: resolved values, no project servers. */
  mcpServers: Readonly<Record<string, McpServerConfig>>;
  /** Explicit OpenCode view: reference-only values, including project servers. */
  openCodeMcpServers: Readonly<Record<string, McpServerConfig>>;
  /** Same allowed tool list used by the legacy Claude runner. */
  allowedTools?: readonly string[];
  /** Persona-specific MCP servers that may be absent from a cycle. */
  optionalMcpServers?: readonly string[];
}

/** Stable boundary for the existing Python preflight/config implementation. */
export interface PythonBridge {
  preflight(input: PreflightRequest, signal?: AbortSignal): Promise<PreflightResult | null>;
  prepareConfig(
    input: ConfigPreparationRequest,
    signal?: AbortSignal,
  ): Promise<ConfigPreparationResult>;
}
