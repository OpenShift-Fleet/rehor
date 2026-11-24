import type { z } from "zod";
import type { PreflightExecutionResult } from "./results.js";

/**
 * The run-context contract core depends on: the per-run identity every
 * preflight receives. The full run context — memory-server client and shared
 * per-run state — extends this in `shared/run-context.ts` and is what the
 * dispatcher passes to `run` at runtime. Core stays free of client
 * dependencies; preflight implementations type `ctx` with the full context
 * (method parameters are checked bivariantly, so the richer parameter type
 * is accepted here).
 */
export interface PreflightRunContext {
  /** Id of the agent instance the preflight runs for. */
  readonly instanceId: string;
}

/**
 * A preflight definition as authored centrally: a stable string `id`, a Zod
 * object schema for its inputs, and a `run` function. `z.infer` derives the
 * typed params, so the schema is the single source of truth.
 */
export interface PreflightDefinition<S extends z.ZodObject> {
  /** Stable preflight id, e.g. `gh-pr-status`. */
  readonly id: string;
  /**
   * Zod object schema for the preflight's inputs. Use `z.strictObject` (or
   * `z.object(...).strict()`) so unknown parameter names fail closed.
   */
  readonly input: S;
  run(ctx: PreflightRunContext, params: z.infer<S>): Promise<PreflightExecutionResult>;
}
