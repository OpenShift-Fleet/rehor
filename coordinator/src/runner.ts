import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { CompatibilitySink, PreflightCycleInput } from "./adapters/compatibility";
import { FileCycleAdmission } from "./adapters/file-admission";
import { PythonCoordinatorBridge } from "./bridges/python";
import type { CoordinatorResult } from "./coordinator";
import type { PreparedCycleInput } from "./cycle-input";
import { prepareCycleInput } from "./cycle-input";
import type { RehorRun, RepositorySnapshot, TaskIdentity } from "./domain/run";
import { sha256Hash } from "./instructions";
import { type CoordinatorLoopResult, LoopErrorPhase, runCoordinatorLoop } from "./loop";
import type { CompatibilityWriters } from "./ports/compatibility";
import type { PythonBridge } from "./ports/python-bridge";
import type { McpServerConfig } from "./ports/runtime-config";
import { LegacyCompatibilityProjection } from "./projections/compatibility";
import {
  createDefaultRuntimeRegistry,
  createOpenCodeV1RuntimeFactory,
  executeSelectedRun,
  type RuntimeFactoryRegistry,
} from "./runtime-factory";
import type {
  OpenCodeProviderConfig,
  OpenCodeSupervisorOptions,
  OpenCodeV1DeploymentConfig,
} from "./runtimes/opencode-v1";
import { renderOpenCodeV1ConfigForCycle } from "./runtimes/opencode-v1/config";
import { CycleDecision, CycleScheduler, consumeSleepSignal, sleep } from "./scheduler";

const execFileAsync = promisify(execFile);

export interface RunBuildOptions {
  scriptDir: string;
  instanceId: string;
  label: string;
  workspacePath?: string;
  repository?: string;
  snapshot?: RepositorySnapshot;
  task?: TaskIdentity | null;
  policyVersion?: string;
  reasoningEffort?: string;
}

export interface RuntimeRegistryOptions {
  workspaceRoot: string;
  openCodeDeployment?: OpenCodeV1DeploymentConfig;
  openCodeCommand?: string;
  openCodeExpectedVersion?: string | RegExp;
  openCodeWorkspaceOwnerUid?: number;
  environment?: NodeJS.ProcessEnv;
}

export interface CoordinatorRunnerOptions {
  scriptDir: string;
  label: string;
  instanceId: string;
  dataDirectory: string;
  lockPath: string;
  sleepSignalPath: string;
  writers: CompatibilityWriters;
  compatibility?: Pick<CompatibilitySink, "writePreflightCycle">;
  bridge?: PythonBridge;
  pythonExecutable?: string;
  pythonCwd?: string;
  workspaceRoot?: string;
  openCodeDeployment?: OpenCodeV1DeploymentConfig;
  openCodeCommand?: string;
  openCodeExpectedVersion?: string | RegExp;
  openCodeWorkspaceOwnerUid?: number;
  environment?: NodeJS.ProcessEnv;
  policyVersion?: string;
  initialIntervalSeconds?: number;
  initialIdleIntervalSeconds?: number;
  maxPreflightBackoffSeconds?: number;
  maxCycles?: number;
  once?: boolean;
  signal?: AbortSignal;
  shutdownSignal?: AbortSignal;
  onReady?: () => void;
  onError?: (error: unknown, phase: LoopErrorPhase) => void | Promise<void>;
}

export async function buildRehorRun(
  prepared: PreparedCycleInput,
  options: RunBuildOptions,
): Promise<RehorRun> {
  if (!prepared.prompt) throw new Error("cannot build a run without a prepared prompt");
  const workspacePath = await realpath(options.workspacePath ?? options.scriptDir).catch(
    () => options.workspacePath ?? options.scriptDir,
  );
  const repository =
    options.repository ??
    (await gitValue(workspacePath, ["remote", "get-url", "origin"])) ??
    workspacePath;
  const snapshot = options.snapshot ?? (await inspectSnapshot(workspacePath));

  return {
    schemaVersion: "1",
    runId: randomUUID(),
    attemptId: randomUUID(),
    instanceId: options.instanceId,
    label: options.label,
    workflowId: prepared.config.workflow,
    prompt: prepared.prompt,
    task: options.task ?? null,
    worktree: { path: workspacePath, repository: redactRepository(repository), snapshot },
    instructionHash: prepared.instructionHash,
    configHash: prepared.configHash,
    policyHash: sha256Hash(options.policyVersion ?? "rehor-coordinator-policy-v1"),
    runtimeId: prepared.config.runtimeId,
    provider: {
      id: prepared.config.providerId,
      requestedModel: prepared.config.model,
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: options.reasoningEffort }),
    },
    limits: {
      timeoutMs: Math.max(1, Math.floor(prepared.config.cycleTimeoutSeconds * 1000)),
      maxTurns: prepared.config.maxTurns,
    },
    preflightPayloadRef: prepared.preflightPayloadRef,
  };
}

export function validateOpenCodeDeployment(
  prepared: PreparedCycleInput,
  deployment: OpenCodeV1DeploymentConfig = {},
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (prepared.config.runtimeId !== "opencode-v1") return;
  if (deployment.providerId !== undefined && deployment.providerId !== prepared.config.providerId) {
    throw new Error(
      `OpenCode deployment provider '${deployment.providerId}' does not match prepared provider '${prepared.config.providerId}'`,
    );
  }
  if (deployment.model !== undefined && deployment.model !== prepared.config.model) {
    throw new Error(
      `OpenCode deployment model '${deployment.model}' does not match prepared model '${prepared.config.model}'`,
    );
  }
  const providers = [
    ...(deployment.provider === undefined ? [] : [deployment.provider]),
    ...(deployment.providers ?? []),
  ];
  const selectedProvider = providers.find((provider) => provider.id === prepared.config.providerId);
  if (selectedProvider === undefined) {
    throw new Error(
      `OpenCode deployment does not declare prepared provider '${prepared.config.providerId}'`,
    );
  }
  if (selectedProvider.id === "rehor-openai-chat") {
    const modelId = prepared.config.model.slice(prepared.config.model.lastIndexOf("/") + 1);
    if (selectedProvider.models?.[modelId] === undefined) {
      throw new Error(
        `OpenCode deployment provider '${selectedProvider.id}' does not declare prepared model '${modelId}'`,
      );
    }
  }
  if (selectedProvider.id === "rehor-openai" || selectedProvider.id === "rehor-openai-chat") {
    validateOpenAIGatewayConfig(selectedProvider, environment);
  }
  renderOpenCodeV1ConfigForCycle(prepared.config, prepared.config.providerId, deployment);
}

function validateOpenAIGatewayConfig(
  provider: OpenCodeProviderConfig,
  environment: NodeJS.ProcessEnv,
): void {
  const baseURL = provider.options?.baseURL;
  if (typeof baseURL !== "string" || !baseURL.trim()) {
    throw new Error(`OpenCode deployment provider '${provider.id}' requires a gateway URL`);
  }
  const gatewayEnvironment = exactEnvironmentReference(baseURL.trim());
  const gatewayValue = gatewayEnvironment ? environment[gatewayEnvironment] : baseURL;
  if (!gatewayValue?.trim()) {
    throw new Error(
      `OpenCode deployment provider '${provider.id}' requires gateway URL environment variable '${gatewayEnvironment}'`,
    );
  }

  let parsedGateway: URL;
  try {
    parsedGateway = new URL(gatewayValue.trim());
  } catch {
    throw new Error(`OpenCode deployment provider '${provider.id}' has an invalid gateway URL`);
  }
  if (
    parsedGateway.protocol !== "http:" ||
    !parsedGateway.hostname ||
    parsedGateway.port !== "8450" ||
    parsedGateway.pathname !== "/v1" ||
    parsedGateway.username ||
    parsedGateway.password ||
    parsedGateway.search ||
    parsedGateway.hash
  ) {
    throw new Error(
      `OpenCode deployment provider '${provider.id}' gateway URL must be http://<proxy-host>:8450/v1`,
    );
  }

  const tokenEnvironment = exactEnvironmentReference(provider.options?.apiKey);
  if (!tokenEnvironment) {
    throw new Error(
      `OpenCode deployment provider '${provider.id}' apiKey must reference the bot-to-proxy token environment`,
    );
  }
  if (!environment[tokenEnvironment]?.trim()) {
    throw new Error(
      `OpenCode deployment provider '${provider.id}' requires bot-to-proxy token environment '${tokenEnvironment}'`,
    );
  }
}

function exactEnvironmentReference(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(?:\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(value);
  return match?.[1] ?? match?.[2];
}

export function createRuntimeRegistryForCycle(
  prepared: PreparedCycleInput,
  options: RuntimeRegistryOptions,
): RuntimeFactoryRegistry {
  const deployment = options.openCodeDeployment ?? {};
  const environment = options.environment ?? process.env;
  const registry = createDefaultRuntimeRegistry({
    env: environment,
    mcpServers: resolveMcpServers(
      prepared.config.mcpServers ?? prepared.config.openCodeMcpServers ?? {},
      environment,
    ),
    allowedTools: prepared.config.allowedTools ?? [],
  });
  validateOpenCodeDeployment(prepared, deployment, environment);
  if (prepared.config.runtimeId !== "opencode-v1") return registry;

  const server: OpenCodeSupervisorOptions = {
    workspaceRoot: options.workspaceRoot,
    ...(options.openCodeCommand === undefined ? {} : { command: options.openCodeCommand }),
    ...(options.openCodeExpectedVersion === undefined
      ? {}
      : { expectedVersion: options.openCodeExpectedVersion }),
    ...(options.openCodeWorkspaceOwnerUid === undefined
      ? {}
      : { workspaceOwnerUid: options.openCodeWorkspaceOwnerUid }),
  };
  registry.register(
    createOpenCodeV1RuntimeFactory({
      base: options.environment,
      config: deployment,
      server,
    }),
  );
  return registry;
}

export async function runCoordinator(
  options: CoordinatorRunnerOptions,
): Promise<CoordinatorLoopResult<CoordinatorResult>> {
  const bridge =
    options.bridge ??
    new PythonCoordinatorBridge({
      executable: options.pythonExecutable,
      cwd: options.pythonCwd ?? options.scriptDir,
    });
  const scheduler = new CycleScheduler({
    intervalMs: secondsToMs(options.initialIntervalSeconds ?? 300, "initialIntervalSeconds"),
    idleIntervalMs: secondsToMs(
      options.initialIdleIntervalSeconds ?? 300,
      "initialIdleIntervalSeconds",
    ),
    ...(options.maxPreflightBackoffSeconds === undefined
      ? {}
      : {
          maxPreflightBackoffMs: secondsToMs(
            options.maxPreflightBackoffSeconds,
            "maxPreflightBackoffSeconds",
          ),
        }),
  });
  const projection = new LegacyCompatibilityProjection(options.writers);
  const workspaceRoot = options.workspaceRoot ?? options.scriptDir;
  const environment = options.environment ?? process.env;

  return runCoordinatorLoop<CoordinatorResult>({
    admission: new FileCycleAdmission(options.lockPath),
    scheduler,
    prepare: async (signal) => {
      const prepared = await prepareCycleInput(bridge, {
        scriptDir: options.scriptDir,
        label: options.label,
        instanceId: options.instanceId,
        signal,
      });
      scheduler.updateIntervals({
        intervalMs: secondsToMs(prepared.config.intervalSeconds, "intervalSeconds"),
        idleIntervalMs: secondsToMs(prepared.config.idleIntervalSeconds, "idleIntervalSeconds"),
      });
      return prepared;
    },
    run: async (prepared, signal) => {
      const run = await buildRehorRun(prepared, {
        scriptDir: options.scriptDir,
        instanceId: options.instanceId,
        label: options.label,
        workspacePath: options.scriptDir,
        policyVersion: options.policyVersion,
      });
      const registry = createRuntimeRegistryForCycle(prepared, {
        workspaceRoot,
        openCodeDeployment: options.openCodeDeployment,
        openCodeCommand: options.openCodeCommand,
        openCodeExpectedVersion: options.openCodeExpectedVersion,
        openCodeWorkspaceOwnerUid: options.openCodeWorkspaceOwnerUid,
        environment,
      });
      try {
        return await executeSelectedRun(registry, { runtimeId: run.runtimeId ?? "claude" }, run, {
          signal,
          projection,
          preparedConfig: prepared.config,
        });
      } finally {
        await bridge.cleanupBetweenCycles?.({ scriptDir: options.scriptDir }, signal);
      }
    },
    sleepSignal: () => consumeSleepSignal(options.sleepSignalPath),
    sleep: options.once ? async () => undefined : sleep,
    maxCycles: options.maxCycles ?? (options.once ? 1 : undefined),
    signal: options.signal,
    shutdownSignal: options.shutdownSignal,
    onDecision: async (plan, prepared, signal) => {
      options.onReady?.();
      if (plan.decision === CycleDecision.Run) {
        if (prepared?.preflight?.action === "start") {
          await bridge.idlePreflightStart?.(
            { scriptDir: options.scriptDir, instanceId: options.instanceId },
            signal,
          );
        }
        return;
      }
      const preflight = prepared?.preflight;
      if (plan.decision === CycleDecision.Idle && prepared) {
        await bridge.idlePreflightSkip?.(
          {
            scriptDir: options.scriptDir,
            instanceId: options.instanceId,
            idleCycleLimit: prepared.config.idleCycleLimit,
            cooldownSeconds: prepared.config.idleReminderCooldownSeconds,
          },
          signal,
        );
      }
      const input: PreflightCycleInput = {
        instanceId: options.instanceId,
        state: plan.decision === CycleDecision.Idle ? "idle" : "error",
        transcript: preflight?.transcript ?? "",
        inputPrompt: preflight?.transcript ?? "",
      };
      await options.compatibility?.writePreflightCycle(input);
      await bridge.cleanupBetweenCycles?.({ scriptDir: options.scriptDir }, signal);
      await options.writers.metrics?.observe({
        name: "devbot_preflight_consecutive_errors",
        value: plan.consecutivePreflightErrors,
        labels: { label: options.label },
      });
    },
    onError: async (error, phase) => {
      await options.writers.status?.write({
        state: "error",
        message:
          phase === LoopErrorPhase.Prepare
            ? "Preflight failed — check bot.log"
            : "Coordinator failed — check bot.log",
        instanceId: options.instanceId,
      });
      await options.writers.metrics?.observe({
        name: "devbot_coordinator_errors_total",
        value: 1,
        labels: { label: options.label, phase },
      });
      await options.onError?.(error, phase);
    },
  });
}

async function inspectSnapshot(path: string): Promise<RepositorySnapshot> {
  const [ref, commitSha, status] = await Promise.all([
    gitValue(path, ["symbolic-ref", "--short", "HEAD"]),
    gitValue(path, ["rev-parse", "HEAD"]),
    gitValue(path, ["status", "--porcelain", "--untracked-files=all"]),
  ]);
  return {
    ref: ref ?? "unknown",
    commitSha: commitSha ?? "unknown",
    dirty: status === undefined || status.length > 0,
  };
}

async function gitValue(path: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["-C", path, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const value = String(result.stdout).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function redactRepository(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/\/[^/@]+@/, "//");
  }
}

function resolveMcpServers(
  servers: Readonly<Record<string, McpServerConfig>>,
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, McpServerConfig>> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      if ("command" in server) {
        return [
          name,
          {
            ...server,
            command: resolveReference(server.command, environment, `${name}.command`),
            ...(server.args === undefined
              ? {}
              : {
                  args: server.args.map((value, index) =>
                    resolveReference(value, environment, `${name}.args[${index}]`),
                  ),
                }),
            ...(server.env === undefined
              ? {}
              : { env: resolveRecord(server.env, environment, `${name}.env`) }),
          },
        ];
      }
      return [
        name,
        {
          ...server,
          url: resolveReference(server.url, environment, `${name}.url`),
          ...(server.headers === undefined
            ? {}
            : { headers: resolveRecord(server.headers, environment, `${name}.headers`) }),
        },
      ];
    }),
  );
}

function resolveRecord(
  values: Readonly<Record<string, string>>,
  environment: NodeJS.ProcessEnv,
  path: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      resolveReference(value, environment, `${path}.${key}`),
    ]),
  );
}

function resolveReference(value: string, environment: NodeJS.ProcessEnv, path: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, dollarName, envName) => {
      const name = dollarName ?? envName;
      const resolved = environment[name];
      if (resolved === undefined)
        throw new Error(`missing environment variable ${name} for MCP ${path}`);
      return resolved;
    },
  );
}

function secondsToMs(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be non-negative`);
  const milliseconds = value * 1000;
  if (!Number.isSafeInteger(milliseconds)) throw new RangeError(`${name} is too large`);
  return milliseconds;
}
