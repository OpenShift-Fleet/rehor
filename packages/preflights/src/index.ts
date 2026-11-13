/**
 * Public API of `@rehor/preflights`.
 *
 * - The core contract: preflight definitions, the registry, `instance.yaml`
 *   entry validation, execution results, and the workflow default sets.
 * - The run-context type and its factory, for the dispatcher (REHOR-259).
 *
 * Everything else under `src/shared/` (HTTP, memory-server, and Jira
 * clients; formatting and helper modules) is internal: preflight
 * implementations inside this package import them directly, external
 * consumers do not. Preflight ids are registered in `src/preflights/`.
 */

// --- core contract ---

export type { WorkflowDefaultsValidationResult } from "./core/defaults.js";
export { requiredInputNames, validateWorkflowDefaults, workflowDefaults } from "./core/defaults.js";
export type { LiteralValue, PreflightEntry } from "./core/entry.js";
export {
  literalValueSchema,
  objectEntrySchema,
  preflightEntrySchema,
  shorthandEntrySchema,
} from "./core/entry.js";

export type { PreflightDefinition } from "./core/preflight.js";

export type { Preflight, PreflightRegistry } from "./core/registry.js";
export { createPreflightRegistry, definePreflight } from "./core/registry.js";

export type {
  InvalidPreflightEntry,
  PreflightErrorResult,
  PreflightExecutionResult,
  PreflightSkipResult,
  PreflightStartResult,
} from "./core/results.js";

export type { ConfigValidationResult, ResolvedPreflightEntry } from "./core/validate.js";
export { validateConfig } from "./core/validate.js";

// --- run context (the one shared type re-exported; dispatcher-facing) ---

export type {
  JiraWiring,
  MemoryServerWiring,
  PreflightRunContext,
  PreflightRunContextOptions,
  PreflightRunState,
  ProxyRouteConfig,
  ProxyWiring,
} from "./shared/run-context.js";
export { createPreflightRunContext } from "./shared/run-context.js";
