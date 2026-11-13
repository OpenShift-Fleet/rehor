import type { PreflightRegistry } from "../core/registry.js";
import { createPreflightRegistry } from "../core/registry.js";
import { ghPrStatus } from "./gh-pr-status/index.js";

/**
 * Audit-boundary barrel for preflight implementations. Every preflight gets
 * its own directory under `src/preflights/` and exactly one registration
 * line here — enterprise integrations and their credential use are reviewed
 * centrally through this file. External-system wiring reaches the
 * preflights through the run context (`proxy` route, `jira` client,
 * `repos` map), never through this registry.
 */
export function createPopulatedRegistry(): PreflightRegistry {
  return createPreflightRegistry([ghPrStatus]);
}
