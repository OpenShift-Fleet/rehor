import { z } from "zod";
import type { PreflightExecutionResult } from "../../core/results.js";
import { defineGitHubPreflight } from "../../shared/github.js";
import { fmtGhTask, runGhPrStatus } from "../gh-pr-status/index.js";
import {
  collectPausedRenovateFeedback,
  enrichRenovateTask,
  RENOVATE_TASK_KEY_PREFIX,
} from "../renovate-common/index.js";

/**
 * `renovate-pr-status` — the port of the Renovate workflow's
 * `02-gh-pr-status.py`, the workflow-specific wrapper around the shared
 * `gh-pr-status` checks.
 *
 * Differences from the generic `gh-pr-status`:
 *
 * 1. CI failures always retry, even when the task was already addressed —
 *    a partially fixed CI run must get another session.
 * 2. A conflict on the Renovate PR alone is suppressed: Renovate rebases on
 *    its own. A fix-PR conflict stays visible (the bot must rebase it), and
 *    a Renovate-only conflict with new human feedback keeps the task.
 * 3. Once `metadata.fix_pr` exists, CI, conflicts, reviews, and comments
 *    come from the fix PR; the Renovate PR still drives MERGED/CLOSED.
 * 4. Paused tasks with new human feedback are promoted into a
 *    `### BLOCKED FEEDBACK` section (Priority 1), excluding terminal
 *    Renovate PRs.
 *
 * Active tasks remain the generic six-bucket view. The preflight starts when
 * there is any actionable active task or blocked feedback; otherwise it
 * skips, so the dispatcher creates no session for a quiet cycle.
 */

export const RENOVATE_PR_STATUS_INPUT = z.strictObject({
  /** External-key prefix of this workflow's tasks. */
  task_key_prefix: z.string().trim().min(1).default(RENOVATE_TASK_KEY_PREFIX),
});

export type RenovatePrStatusParams = z.infer<typeof RENOVATE_PR_STATUS_INPUT>;

export const renovatePrStatus = defineGitHubPreflight({
  id: "renovate-pr-status",
  input: RENOVATE_PR_STATUS_INPUT,
  run: async (deps, params): Promise<PreflightExecutionResult> => {
    const active = await runGhPrStatus(deps, {
      taskKeyPrefix: params.task_key_prefix,
      enrichTask: enrichRenovateTask,
      // Partial CI fixes must get another session; ignore last_addressed.
      ciFailureNeedsSession: () => true,
    });

    const tasks = await deps.memory.getTasks();
    const blockedFeedback = await collectPausedRenovateFeedback(
      tasks,
      deps.github,
      deps.repos,
      params.task_key_prefix,
    );
    if (blockedFeedback.length === 0) {
      return active;
    }

    const lines = [
      `### BLOCKED FEEDBACK (${blockedFeedback.length})`,
      "(Previously paused tasks with new human comments — treat as P1)",
      "",
    ];
    for (const enriched of blockedFeedback) {
      lines.push(fmtGhTask(enriched));
      lines.push("");
    }
    const blocked = lines.join("\n").trimEnd();
    return {
      status: "start",
      content: `${blocked}\n\n${active.content}`,
    };
  },
});
