import type { ContentHash } from "./domain/run";
import {
  type AssembledInstructions,
  assembleInstructions,
  buildCyclePrompt,
  type InstructionStrategy,
  sha256Hash,
} from "./instructions";
import type {
  ConfigPreparationResult,
  PreflightRequest,
  PreflightResult,
  PythonBridge,
} from "./ports/python-bridge";

export interface PrepareCycleInputOptions {
  scriptDir: string;
  label: string;
  instanceId?: string | null;
  strategy?: InstructionStrategy;
  signal?: AbortSignal;
}

export interface PreparedCycleInput {
  config: ConfigPreparationResult;
  instructions: AssembledInstructions;
  preflight: PreflightResult | null;
  prompt?: string;
  instructionHash: ContentHash;
  configHash: ContentHash;
  preflightPayloadRef: string | null;
}

/**
 * Prepare one cycle without starting an agent runtime.
 *
 * Config sync and preflight stay in Python for compatibility. Instruction
 * assembly and prompt construction are deterministic TypeScript operations.
 */
export async function prepareCycleInput(
  bridge: PythonBridge,
  options: PrepareCycleInputOptions,
): Promise<PreparedCycleInput> {
  const config = await bridge.prepareConfig(
    { scriptDir: options.scriptDir, label: options.label },
    options.signal,
  );
  const instructions = await assembleInstructions({
    scriptDir: options.scriptDir,
    workflow: config.workflow,
    strategy: options.strategy ?? config.claudeMdStrategy,
    remoteAgentDir: config.remoteAgentDir,
    sharedAgentDir: config.sharedAgentDir,
  });

  const preflightRequest: PreflightRequest = {
    scriptDir: options.scriptDir,
    workflow: config.workflow,
    remoteAgentDir: config.remoteAgentDir,
    instanceId: options.instanceId,
  };
  const preflight = await bridge.preflight(preflightRequest, options.signal);
  const prompt =
    preflight === null || preflight.action === "start"
      ? buildCyclePrompt({
          label: options.label,
          instanceId: options.instanceId,
          preflightPrompt: preflight?.prompt,
        })
      : undefined;

  const preflightPayloadRef =
    preflight?.action === "start"
      ? `preflight://sha256/${sha256Hash(JSON.stringify(preflight)).value}`
      : null;
  const configHash = sha256Hash(
    JSON.stringify({
      model: config.model,
      maxTurns: config.maxTurns,
      intervalSeconds: config.intervalSeconds,
      idleIntervalSeconds: config.idleIntervalSeconds,
      cycleTimeoutSeconds: config.cycleTimeoutSeconds,
      idleReminderCooldownSeconds: config.idleReminderCooldownSeconds,
      workflow: config.workflow,
      source: config.source,
      envs: config.envs,
      activeEnvs: config.activeEnvs,
      claudeMdStrategy: config.claudeMdStrategy,
      idleCycleLimit: config.idleCycleLimit,
      instructionHash: instructions.hash.value,
    }),
  );

  return {
    config,
    instructions,
    preflight,
    ...(prompt === undefined ? {} : { prompt }),
    instructionHash: instructions.hash,
    configHash,
    preflightPayloadRef,
  };
}
