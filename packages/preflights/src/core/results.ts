/**
 * Execution results — the outcome of running a preflight after configuration
 * validation passed. Same semantics as the existing Python preflight protocol
 * (`{"status": "start"|"skip"|"error", "content": "..."}`).
 */

/** The preflight found work; `content` is Markdown for the agent prompt. */
export interface PreflightStartResult {
  readonly status: "start";
  readonly content: string;
}

/** The preflight found no work; `content` is the reason, never prompt material. */
export interface PreflightSkipResult {
  readonly status: "skip";
  readonly content: string;
}

/**
 * The preflight failed to execute (network, timeout, upstream API); `content`
 * is the failure message. Retrying with backoff can heal an error.
 */
export interface PreflightErrorResult {
  readonly status: "error";
  readonly content: string;
}

/** Result of executing one preflight. */
export type PreflightExecutionResult =
  | PreflightStartResult
  | PreflightSkipResult
  | PreflightErrorResult;

/**
 * Pre-execution configuration failure (`invalid`). NOT an execution result:
 * it reports a `preflights:` entry in the agent's `instance.yaml` that failed
 * validation (unknown id, missing required parameter, unknown parameter name,
 * malformed entry). An invalid configuration never heals by retrying — the
 * dispatcher refuses to dispatch the instance and surfaces these stable
 * messages to the agent owner; the configuration is re-evaluated on the next
 * config sync.
 */
export interface InvalidPreflightEntry {
  /** Stable preflight id when one is recoverable from the entry, else null. */
  readonly id: string | null;
  /** Stable per-entry validation messages, e.g. `jira-kanban: missing required parameter "project"`. */
  readonly messages: readonly string[];
}
