import { z } from "zod";
import type { PreflightRegistry } from "./registry.js";

/**
 * Central mapping of shared workflow name → default preflight ids
 * (dispatcher-side data; not workflow content, not baked into the runner
 * image). An agent whose `instance.yaml` omits the `preflights:` field
 * inherits the default set registered for its workflow.
 *
 * The ids are data: the referenced preflights are registered by the
 * dispatcher (REHOR-257/258). Default sets may only reference preflights with
 * no required inputs — a preflight with required inputs (e.g. `jira-sprint`
 * needs `label`) must always be declared explicitly in `instance.yaml`, so an
 * inherited default can never hide a required value the agent cannot supply.
 */
export const workflowDefaults: Record<string, string[]> = {
  "jira-sprint": ["gh-pr-status", "gl-mr-status"],
};

/**
 * Names of a preflight's required (non-optional) input keys: keys whose value
 * cannot be omitted, i.e. parsing `undefined` against the schema fails. Keys
 * with `.optional()` or a `.default()` are not required.
 *
 * Throws when the schema is not a Zod object schema — a central-author error.
 */
export function requiredInputNames(schema: z.ZodType): string[] {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error("requiredInputNames expects a Zod object schema");
  }
  return Object.entries(schema.shape)
    .filter(([, value]) => !value.safeParse(undefined).success)
    .map(([key]) => key);
}

/** Result of checking the central default sets against a registry. */
export type WorkflowDefaultsValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validate that every workflow's default set only references registered
 * preflights with no required inputs. Fails (returns errors, does not throw)
 * on an unknown id or a required-input preflight in a default set — both
 * would make an inherited default impossible to resolve or unsafe to apply.
 */
export function validateWorkflowDefaults(
  registry: PreflightRegistry,
  defaults: Record<string, string[]> = workflowDefaults,
): WorkflowDefaultsValidationResult {
  const errors: string[] = [];
  for (const [workflow, ids] of Object.entries(defaults)) {
    for (const id of ids) {
      const preflight = registry.get(id);
      if (preflight === undefined) {
        errors.push(`${workflow}: default set references unknown preflight id "${id}"`);
        continue;
      }
      const required = requiredInputNames(preflight.input);
      if (required.length > 0) {
        const names = required.map((name) => `"${name}"`).join(", ");
        errors.push(
          `${workflow}: default set includes "${id}" with required input ${names}; ` +
            "defaults may only include preflights with no required inputs",
        );
        continue;
      }
      // No field is individually required, but the schema as a whole may
      // still reject an empty map (for example a root `.refine()` requiring
      // at least one of several optional fields). An inherited default is
      // applied with an empty `with:` map, so such a preflight can never
      // resolve — reject it up front with a stable diagnostic.
      if (!preflight.input.safeParse({}).success) {
        errors.push(
          `${workflow}: default set includes "${id}" whose input schema rejects an empty parameter map; ` +
            "defaults may only include preflights with no required inputs",
        );
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}
