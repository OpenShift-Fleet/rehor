import { rm, writeFile } from "node:fs/promises";

import type { ContentHash } from "./domain/run";
import { isOpenCodeRuntime } from "./domain/runtime-selection";
import {
  type AssembledInstructions,
  assembleInstructions,
  buildCyclePrompt,
  type InstructionStrategy,
  sha256Hash,
} from "./instructions";
import {
  type ConfigPreparationResult,
  PreflightAction,
  type PreflightRequest,
  type PreflightResult,
  type PythonBridge,
} from "./ports/python-bridge";
import {
  loadOpenCodeProjectConfig,
  type OpenCodeProjectConfiguration,
} from "./runtimes/opencode/project-config";
import { stableJson } from "./runtimes/shared";

export interface SandboxCycleInput {
  /** Dispatcher-minted run ID from the delivered envelope. */
  runId: string;
  /** Prepared prompt delivered by the dispatcher; replaces local preflights. */
  prompt: string;
}

export interface PrepareCycleInputOptions {
  scriptDir: string;
  label: string;
  instanceId?: string | null;
  strategy?: InstructionStrategy;
  signal?: AbortSignal;
  /** Dispatcher sandbox input (REHOR-233): consume it without a preflight. */
  sandboxInput?: SandboxCycleInput;
}

export interface PreparedCycleInput {
  config: ConfigPreparationResult;
  instructions?: AssembledInstructions;
  nativeConfig?: OpenCodeProjectConfiguration;
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
  if (options.sandboxInput !== undefined && !isOpenCodeRuntime(config.runtimeId)) {
    throw new Error("Sandbox input requires the OpenCode runtime");
  }
  const nativeConfig = isOpenCodeRuntime(config.runtimeId)
    ? await loadOpenCodeProjectConfig(config.remoteAgentDir, {
        scriptDir: options.scriptDir,
        workflow: config.workflow,
        sharedAgentDir: config.sharedAgentDir,
      })
    : undefined;
  const instructions =
    nativeConfig === undefined
      ? await assembleInstructions({
          scriptDir: options.scriptDir,
          workflow: config.workflow,
          strategy: options.strategy ?? config.claudeMdStrategy,
          remoteAgentDir: config.remoteAgentDir,
          sharedAgentDir: config.sharedAgentDir,
        })
      : undefined;
  const instructionHash = instructions?.hash ?? sha256Hash(stableJson(nativeConfig));
  if (instructions) {
    await writeFile(config.claudeMdPath, instructions.content);
  } else {
    await rm(config.claudeMdPath, { force: true });
  }

  const preflightRequest: PreflightRequest = {
    scriptDir: options.scriptDir,
    workflow: config.workflow,
    remoteAgentDir: config.remoteAgentDir,
    instanceId: options.instanceId,
  };
  // A delivered sandbox prompt replaces the local preflight entirely.
  const preflight =
    options.sandboxInput === undefined
      ? await bridge.preflight(preflightRequest, options.signal)
      : null;
  const prompt =
    options.sandboxInput !== undefined ||
    preflight === null ||
    preflight.action === PreflightAction.Start
      ? buildCyclePrompt({
          label: options.label,
          instanceId: options.instanceId,
          preflightPrompt: options.sandboxInput ? options.sandboxInput.prompt : preflight?.prompt,
          runtimeId: config.runtimeId,
        })
      : undefined;

  const preflightPayloadRef =
    options.sandboxInput !== undefined
      ? `sandbox://run/${options.sandboxInput.runId}`
      : preflight?.action === PreflightAction.Start
        ? `preflight://sha256/${sha256Hash(JSON.stringify(preflight)).value}`
        : null;
  const configHash = sha256Hash(
    JSON.stringify({
      model: config.model,
      runtimeId: config.runtimeId,
      providerId: config.providerId,
      budgetUsd: config.budgetUsd,
      intervalSeconds: config.intervalSeconds,
      idleIntervalSeconds: config.idleIntervalSeconds,
      cycleTimeoutSeconds: config.cycleTimeoutSeconds,
      idleReminderCooldownSeconds: config.idleReminderCooldownSeconds,
      workflow: config.workflow,
      source: config.source,
      envs: config.envs,
      activeEnvs: config.activeEnvs,
      ...(instructions ? { claudeMdStrategy: config.claudeMdStrategy } : {}),
      idleCycleLimit: config.idleCycleLimit,
      mcpServers: config.openCodeMcpServers,
      allowedTools: config.allowedTools ?? [],
      optionalMcpServers: config.optionalMcpServers ?? [],
      instructionHash: instructionHash.value,
    }),
  );

  return {
    config,
    instructions,
    nativeConfig,
    preflight,
    ...(prompt === undefined ? {} : { prompt }),
    instructionHash,
    configHash,
    preflightPayloadRef,
  };
}
