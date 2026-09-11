import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ContentHash } from "./domain/run";

const SUPPORTED_INSTRUCTION_STRATEGIES = ["replace", "append", "ignore"] as const;

export type InstructionStrategy = (typeof SUPPORTED_INSTRUCTION_STRATEGIES)[number];
export type InstructionLayerName = "core" | "shared" | "workflow" | "instance";

export interface InstructionAssemblyRequest {
  scriptDir: string;
  workflow: string;
  strategy?: InstructionStrategy;
  remoteAgentDir?: string | null;
  sharedAgentDir?: string | null;
}

export interface InstructionLayer {
  name: InstructionLayerName;
  path: string;
  content: string;
}

export interface AssembledInstructions {
  content: string;
  hash: ContentHash;
  layers: readonly InstructionLayer[];
}

export class InstructionAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstructionAssemblyError";
  }
}

/** Assemble CLAUDE.md with the same layer order as bot/run.py. */
export async function assembleInstructions(
  request: InstructionAssemblyRequest,
): Promise<AssembledInstructions> {
  const scriptDir = resolve(request.scriptDir);
  const strategy = request.strategy ?? "ignore";
  if (!SUPPORTED_INSTRUCTION_STRATEGIES.includes(strategy)) {
    throw new InstructionAssemblyError(`unsupported CLAUDE.md strategy '${strategy}'`);
  }
  const corePath = join(scriptDir, "presets", "core", "CLAUDE.md");
  const core = await requiredFile(corePath, "core CLAUDE.md");
  const layers: InstructionLayer[] = [{ name: "core", path: corePath, content: core }];

  const sharedPath = optionalLayerPath(request.sharedAgentDir, "CLAUDE.md");
  if (sharedPath) {
    const shared = await optionalFile(sharedPath);
    if (shared !== null) layers.push({ name: "shared", path: sharedPath, content: shared });
  }

  const instancePath = optionalLayerPath(request.remoteAgentDir, "CLAUDE.md");
  const instance = instancePath ? await optionalFile(instancePath) : null;
  const workflowDir = resolveWorkflowDir(scriptDir, request.workflow, request.remoteAgentDir);
  const workflowPath = join(workflowDir, "CLAUDE.md");

  if (strategy === "replace" && instancePath && instance !== null) {
    layers.push({ name: "instance", path: instancePath, content: instance });
  } else {
    const workflow = await optionalFile(workflowPath);
    if (workflow !== null) layers.push({ name: "workflow", path: workflowPath, content: workflow });
    if (strategy === "append" && instancePath && instance !== null) {
      layers.push({ name: "instance", path: instancePath, content: instance });
    }
  }

  const content = layers.map(({ content: layer }) => layer).join("");
  return { content, hash: sha256Hash(content), layers };
}

export function resolveWorkflowDir(
  scriptDir: string,
  workflow: string,
  remoteAgentDir?: string | null,
): string {
  if (workflow.startsWith("./")) {
    if (!remoteAgentDir) {
      throw new InstructionAssemblyError(
        `workflow '${workflow}' uses a relative path but no remote config is available`,
      );
    }
    return resolve(remoteAgentDir, workflow.slice(2));
  }
  return resolve(scriptDir, "presets", "workflows", workflow);
}

export function sha256Hash(value: string): ContentHash {
  return { algorithm: "sha256", value: createHash("sha256").update(value, "utf8").digest("hex") };
}

export interface CyclePromptOptions {
  label: string;
  instanceId?: string | null;
  preflightPrompt?: string | null;
}

/** Build the current Python runner prompt without changing workflow wording. */
export function buildCyclePrompt(options: CyclePromptOptions): string {
  const instanceLine = options.instanceId
    ? ` Your instance ID is: ${options.instanceId}. Pass instance_id="${options.instanceId}" to ALL task tool calls (task_list, task_add, task_update, task_check_capacity, bot_status_update).`
    : "";
  const prefix = `Your primary label is: ${options.label}.${instanceLine} Follow the instructions in CLAUDE.md. `;
  const cavemanLine =
    "IMPORTANT: Use ULTRA caveman output for all internal text — " +
    "drop articles, filler, hedging, conjunctions. Abbreviate: DB/auth/config/req/res/fn/impl/env/dep/pkg. " +
    "Arrows for causality (X → Y). One word when one word enough. " +
    "Normal language ONLY for Jira comments, PR descriptions, commit messages.";

  if (options.preflightPrompt) {
    return (
      `${prefix}${cavemanLine}\n\n` +
      "## Pre-flight Data\n\n" +
      "The following data was gathered by pre-flight scripts. " +
      "Do NOT re-fetch task statuses, PR statuses, or Jira comments already shown below. " +
      "Do NOT invoke /triage — triage data is already provided.\n\n" +
      options.preflightPrompt
    );
  }

  return `${prefix}Start by invoking the /triage skill to pre-gather task and PR data. ${cavemanLine}`;
}

async function requiredFile(path: string, description: string): Promise<string> {
  const content = await optionalFile(path);
  if (content === null) throw new InstructionAssemblyError(`${description} not found at ${path}`);
  return content;
}

async function optionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function optionalLayerPath(directory: string | null | undefined, filename: string): string | null {
  return directory ? join(resolve(directory), filename) : null;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
