import type { PreflightErrorResult } from "../../core/results.js";

/** Stable message when a jira preflight runs without a wired jira client. */
export const JIRA_CLIENT_NOT_WIRED = "jira client not wired in the run context";

/**
 * Map any execution failure to an `error` result. The Python runner caught
 * every script crash and reported `{"status": "error"}`; here each preflight
 * maps its own failures (Jira/memory HTTP errors, timeouts, auth rejections)
 * so a broken integration is an error — never a silent skip.
 */
export function executionErrorResult(error: unknown): PreflightErrorResult {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "error", content: message };
}
