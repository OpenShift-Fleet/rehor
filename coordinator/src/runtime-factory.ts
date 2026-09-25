import { type CoordinatorOptions, type CoordinatorResult, executeRun } from "./coordinator";
import { parseRehorRun, type RehorRun } from "./domain";
import type { AgentRuntime } from "./ports/agent-runtime";
import type { ConfigPreparationResult } from "./ports/python-bridge";
import {
  type ClaudeAgentRuntimeOptions,
  createClaudeAgentRuntimeFactory,
} from "./runtimes/claude-agent";
import {
  type OpenCodeV1DeploymentConfig,
  OpenCodeV1Runtime,
  type OpenCodeV1RuntimeOptions,
  renderOpenCodeV1Config,
  renderOpenCodeV1ConfigForCycle,
} from "./runtimes/opencode-v1";

export const DEFAULT_RUNTIME_ID = "claude";

export interface RuntimeSelection {
  /** Adapter/runtime identifier, independent from run.provider.id. */
  runtimeId: string;
}

export interface RuntimeFactoryContext {
  run: RehorRun;
  selection: RuntimeSelection;
  /** Python-prepared cycle policy and reference-only OpenCode MCP view. */
  preparedConfig?: ConfigPreparationResult;
}

/** Factory boundary for provider-specific runtime adapters. */
export interface AgentRuntimeFactory {
  readonly runtimeId: string;
  create(context: RuntimeFactoryContext): AgentRuntime | Promise<AgentRuntime>;
}

export class RuntimeFactoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeFactoryError";
  }
}

/** Registry that resolves one runtime adapter for one normalized run. */
export class RuntimeFactoryRegistry {
  private readonly factories = new Map<string, AgentRuntimeFactory>();

  constructor(factories: readonly AgentRuntimeFactory[] = []) {
    for (const factory of factories) this.register(factory);
  }

  register(factory: AgentRuntimeFactory): this {
    if (!factory.runtimeId) throw new RuntimeFactoryError("runtime factory must have a runtimeId");
    if (this.factories.has(factory.runtimeId)) {
      throw new RuntimeFactoryError(`runtime factory already registered: ${factory.runtimeId}`);
    }
    this.factories.set(factory.runtimeId, factory);
    return this;
  }

  has(runtimeId: string): boolean {
    return this.factories.has(runtimeId);
  }

  get runtimeIds(): readonly string[] {
    return [...this.factories.keys()];
  }

  async create(
    selection: RuntimeSelection,
    run: RehorRun,
    preparedConfig?: ConfigPreparationResult,
  ): Promise<AgentRuntime> {
    const factory = this.factories.get(selection.runtimeId);
    if (!factory) {
      const available = this.runtimeIds.length > 0 ? this.runtimeIds.join(", ") : "none";
      throw new RuntimeFactoryError(
        `no runtime factory registered for '${selection.runtimeId}' (available: ${available})`,
      );
    }
    const runtime = await factory.create({ run, selection, preparedConfig });
    if (!runtime)
      throw new RuntimeFactoryError(`runtime factory returned no runtime: ${selection.runtimeId}`);
    return runtime;
  }
}

/** Builds the production registry for the current Claude/Vertex runtime path. */
export function createDefaultRuntimeRegistry(
  claudeOptions: ClaudeAgentRuntimeOptions = {},
): RuntimeFactoryRegistry {
  return new RuntimeFactoryRegistry([createClaudeAgentRuntimeFactory(claudeOptions)]);
}

/** Registers OpenCode without changing the default production runtime selection. */
export type OpenCodeV1RuntimeFactoryOptions = Omit<
  OpenCodeV1RuntimeOptions,
  "renderedConfig" | "renderError"
> & {
  config?: OpenCodeV1DeploymentConfig;
};

export function createOpenCodeV1RuntimeFactory(
  options: OpenCodeV1RuntimeFactoryOptions = {},
): AgentRuntimeFactory {
  return {
    runtimeId: "opencode-v1",
    create(context) {
      const configured = options.config ?? {};
      let renderedConfig: ReturnType<typeof renderOpenCodeV1Config> | undefined;
      let renderError: unknown;
      try {
        renderedConfig = context.preparedConfig
          ? renderOpenCodeV1ConfigForCycle(
              context.preparedConfig,
              context.run.provider.id,
              configured,
            )
          : renderOpenCodeV1Config({
              ...configured,
              model: configured.model ?? context.run.provider.requestedModel,
              providerId: configured.providerId ?? context.run.provider.id,
            });
      } catch (error) {
        renderError = error;
      }

      const { config: _config, ...runtimeOptions } = options;
      return new OpenCodeV1Runtime({
        ...runtimeOptions,
        renderedConfig,
        renderError,
      });
    },
  };
}

export function resolveRuntimeSelection(runtimeId?: string | null): RuntimeSelection {
  const resolved = runtimeId?.trim() || DEFAULT_RUNTIME_ID;
  if (!/^[a-z][a-z0-9-]*$/.test(resolved)) {
    throw new RuntimeFactoryError(`invalid runtimeId: '${resolved}'`);
  }
  return { runtimeId: resolved };
}

export type RuntimeExecutionOptions = CoordinatorOptions & {
  /** Cycle preparation to apply when constructing the selected runtime. */
  preparedConfig?: ConfigPreparationResult;
};

/** Select an adapter, then run it through the same coordinator lifecycle. */
export async function executeSelectedRun(
  registry: RuntimeFactoryRegistry,
  selection: RuntimeSelection,
  input: RehorRun,
  options: RuntimeExecutionOptions = {},
): Promise<CoordinatorResult> {
  const run = parseRehorRun(input);
  const { preparedConfig, ...coordinatorOptions } = options;
  const runtime = await registry.create(selection, run, preparedConfig);
  return executeRun(runtime, run, coordinatorOptions);
}
