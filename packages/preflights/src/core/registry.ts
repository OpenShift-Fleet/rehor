import { z } from "zod";
import type { PreflightDefinition, PreflightRunContext } from "./preflight.js";
import type { PreflightExecutionResult } from "./results.js";

/**
 * A preflight as stored in a registry: the typed definition with the input
 * schema and `run` params type-erased to `unknown` so heterogeneous
 * preflights share one registry. Params were already parsed against
 * `input` during configuration validation.
 */
export interface Preflight {
  /** Stable preflight id, e.g. `gh-pr-status`. */
  readonly id: string;
  /** Zod object schema for the preflight's inputs. */
  readonly input: z.ZodObject;
  run(ctx: PreflightRunContext, params: unknown): Promise<PreflightExecutionResult>;
}

/**
 * Define a preflight for registration. Validates the id and that the input
 * schema is a Zod object schema (the `with:` map contract); throws on
 * violation — a central-author error, never a configuration error.
 */
export function definePreflight<S extends z.ZodObject>(
  definition: PreflightDefinition<S>,
): Preflight {
  if (typeof definition.id !== "string" || definition.id.length === 0) {
    throw new Error("preflight id must be a non-empty string");
  }
  if (!(definition.input instanceof z.ZodObject)) {
    throw new Error(`preflight "${definition.id}" input must be a Zod object schema`);
  }
  return {
    id: definition.id,
    input: definition.input,
    run: (ctx, params) => definition.run(ctx, params as z.infer<S>),
  };
}

/** Registry mapping preflight ids to preflights; consumed by the dispatcher. */
export interface PreflightRegistry {
  /**
   * Look up a preflight by id. Unknown ids return `undefined` — callers fail
   * closed on the miss.
   */
  get(id: string): Preflight | undefined;
  has(id: string): boolean;
  /** All registered ids, sorted for deterministic iteration. */
  ids(): readonly string[];
}

/**
 * Build a registry from preflights. Throws on duplicate ids — a central-author
 * error caught at registry construction, never at agent dispatch time.
 */
export function createPreflightRegistry(preflights: readonly Preflight[]): PreflightRegistry {
  const byId = new Map<string, Preflight>();
  for (const preflight of preflights) {
    if (typeof preflight.id !== "string" || preflight.id.length === 0) {
      throw new Error("preflight id must be a non-empty string");
    }
    if (byId.has(preflight.id)) {
      throw new Error(`duplicate preflight id "${preflight.id}"`);
    }
    byId.set(preflight.id, preflight);
  }
  return {
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
    ids: () => [...byId.keys()].sort(),
  };
}
