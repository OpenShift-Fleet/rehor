export type PreflightAction = "start" | "skip" | "error";
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
  claudeMdStrategy: "replace" | "append" | "ignore";
  idleCycleLimit: number;
  remoteAgentDir: string | null;
  sharedAgentDir: string | null;
  claudeMdPath: string;
}

/** Stable boundary for the existing Python preflight/config implementation. */
export interface PythonBridge {
  preflight(input: PreflightRequest, signal?: AbortSignal): Promise<PreflightResult | null>;
  prepareConfig(
    input: ConfigPreparationRequest,
    signal?: AbortSignal,
  ): Promise<ConfigPreparationResult>;
}
