import { type CoordinatorOptions, type CoordinatorResult, executeRun } from "./coordinator";
import { parseRehorRun, type RehorRun } from "./domain";
import type { AgentRuntime } from "./ports/agent-runtime";

export const DEFAULT_RUNTIME_ID = "claude";

export interface RuntimeSelection {
  /** Adapter/runtime identifier, independent from run.provider.id. */
  runtimeId: string;
}

export interface RuntimeFactoryContext {
  run: RehorRun;
  selection: RuntimeSelection;
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

  async create(selection: RuntimeSelection, run: RehorRun): Promise<AgentRuntime> {
    const factory = this.factories.get(selection.runtimeId);
    if (!factory) {
      const available = this.runtimeIds.length > 0 ? this.runtimeIds.join(", ") : "none";
      throw new RuntimeFactoryError(
        `no runtime factory registered for '${selection.runtimeId}' (available: ${available})`,
      );
    }
    const runtime = await factory.create({ run, selection });
    if (!runtime)
      throw new RuntimeFactoryError(`runtime factory returned no runtime: ${selection.runtimeId}`);
    return runtime;
  }
}

export function resolveRuntimeSelection(runtimeId?: string | null): RuntimeSelection {
  const resolved = runtimeId?.trim() || DEFAULT_RUNTIME_ID;
  if (!/^[a-z][a-z0-9-]*$/.test(resolved)) {
    throw new RuntimeFactoryError(`invalid runtimeId: '${resolved}'`);
  }
  return { runtimeId: resolved };
}

/** Select an adapter, then run it through the same coordinator lifecycle. */
export async function executeSelectedRun(
  registry: RuntimeFactoryRegistry,
  selection: RuntimeSelection,
  input: RehorRun,
  options: CoordinatorOptions = {},
): Promise<CoordinatorResult> {
  const run = parseRehorRun(input);
  const runtime = await registry.create(selection, run);
  return executeRun(runtime, run, options);
}
