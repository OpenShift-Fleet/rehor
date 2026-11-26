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

export interface IdlePreflightSkipRequest {
  scriptDir: string;
  instanceId: string;
  idleCycleLimit: number;
  cooldownSeconds: number;
}

export interface IdlePreflightStartRequest {
  scriptDir: string;
  instanceId: string;
}

export interface CleanupBetweenCyclesRequest {
  scriptDir: string;
}

export interface ScheduledMaintenanceRequest {
  scriptDir: string;
}

export interface CleanupBetweenCyclesResult {
  /** Free disk space after cleanup, when Python could measure it. */
  diskFreeMb: number | null;
}

export interface ConfigPreparationResult {
  model: string;
  /** Adapter/runtime selected by the instance for the future coordinator. */
  runtimeId: string;
  /** Provider route selected independently from the runtime adapter. */
  providerId: string;
  /** Per-cycle-run USD cost budget enforced by the coordinator. */
  budgetUsd: number;
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
  /** Generated Git identity, signing, and proxy configuration path from Python setup. */
  gitConfigGlobal?: string | null;
  /** MCP servers for the legacy Claude adapter: resolved values, no project servers. */
  mcpServers: Readonly<Record<string, McpServerConfig>>;
  /** Explicit OpenCode view: reference-only values, including project servers. */
  openCodeMcpServers: Readonly<Record<string, McpServerConfig>>;
  /** Same allowed tool list used by the legacy Claude runner. */
  allowedTools?: readonly string[];
  /** Persona-specific MCP servers that may be absent from a cycle. */
  optionalMcpServers?: readonly string[];
  /**
   * Variable names the selected agent's workflow/env-preset manifests and
   * profile `env` (or legacy `preflight.env`) category declare for the child.
   * Names only — values are never carried by the bridge result; the
   * coordinator reads them from its own process environment.
   */
  declaredEnvVars?: readonly string[];
  /**
   * Variable names the selected profile declares in `sandbox.env` (the
   * dispatcher's tier-2 render channel). Names only, like declaredEnvVars.
   */
  declaredSandboxEnvVars?: readonly string[];
  /**
   * Validated nonsecret literal values from the selected profile's `env`
   * (or legacy `preflight.env`) category, applied as a fallback when a
   * declared name is absent from the runner environment. Sandbox secret
   * references never appear here.
   */
  declaredEnvLiterals?: Readonly<Record<string, string>>;
}

/** Stable boundary for the existing Python preflight/config implementation. */
export interface PythonBridge {
  preflight(input: PreflightRequest, signal?: AbortSignal): Promise<PreflightResult | null>;
  prepareConfig(
    input: ConfigPreparationRequest,
    signal?: AbortSignal,
  ): Promise<ConfigPreparationResult>;
  /** Optional maintenance hooks preserve Python idle/cleanup behavior during migration. */
  runScheduledMaintenance?(input: ScheduledMaintenanceRequest, signal?: AbortSignal): Promise<void>;
  idlePreflightSkip?(input: IdlePreflightSkipRequest, signal?: AbortSignal): Promise<void>;
  idlePreflightStart?(input: IdlePreflightStartRequest, signal?: AbortSignal): Promise<void>;
  cleanupBetweenCycles?(
    input: CleanupBetweenCyclesRequest,
    signal?: AbortSignal,
  ): Promise<CleanupBetweenCyclesResult | undefined>;
}
