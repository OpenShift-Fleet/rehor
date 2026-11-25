import { z } from "zod";
import type { PreflightExecutionResult } from "../../core/results.js";
import { appendFetchEvidence, totalFetchFailureError } from "../../shared/failure-policy.js";
import { defineGitHubPreflight } from "../../shared/github.js";
import type { MemoryServerClient, MemoryTask } from "../../shared/memory-server.js";
import { ACTIVE_TASK_STATUSES, MemoryAuthRejectedError } from "../../shared/memory-server.js";
import {
  discoverFailingRenovatePrs,
  formatPrLine,
  RENOVATE_AUTHOR_LOGINS,
  RENOVATE_TASK_KEY_PREFIX,
} from "../renovate-common/index.js";

/**
 * `renovate-discover` — the port of the Renovate workflow's
 * `01-renovate-discover.py`: find open Renovate PRs with CI failures and no
 * merge conflict, and surface the ones that are not already tracked.
 *
 * Discovery is the only preflight that creates new work. It reads the task
 * list first (the shared run-context cache also serves the status
 * preflight) so it can tell new PRs from active, paused, and terminal
 * tasks. If the task API is unavailable, it skips instead of guessing:
 * treating a tracked or paused PR as new would duplicate work. Authentication
 * rejections still surface as an execution error, matching the shared
 * memory-server client.
 *
 * Capacity: entries that need a new slot (new PRs and re-activated terminal
 * tasks) are withheld at capacity. Paused `transient:*` retries are already
 * committed in-flight work and proceed regardless of capacity. The active
 * count comes from the already-fetched task list, deliberately not from a
 * separate capacity call whose failure could look like free capacity.
 */

export const RENOVATE_DISCOVER_INPUT = z.strictObject({
  /** External-key prefix of this workflow's tasks. */
  task_key_prefix: z.string().trim().min(1).default(RENOVATE_TASK_KEY_PREFIX),
  /**
   * Restrict discovery to these project-repos keys. Unset scans every repo
   * in the instance map; non-GitHub and unresolvable entries are skipped.
   */
  repo_keys: z.array(z.string().trim().min(1)).min(1).optional(),
  /** GitHub logins treated as Renovate authors. */
  bot_logins: z
    .array(z.string().trim().min(1))
    .min(1)
    .default([...RENOVATE_AUTHOR_LOGINS]),
  /** Active-task capacity; the Python workflow's constant was 10. */
  max_active: z.number().int().positive().default(10),
});

export type RenovateDiscoverParams = z.infer<typeof RENOVATE_DISCOVER_INPUT>;

/** Fetch the task list, skipping (not erroring) on a non-auth outage. */
async function tasksOrSkip(memory: MemoryServerClient): Promise<readonly MemoryTask[] | null> {
  try {
    return await memory.getTasks();
  } catch (error) {
    if (error instanceof MemoryAuthRejectedError) throw error;
    return null;
  }
}

/** The Python workflow's task-API-unavailable skip. */
const TASK_API_SKIP =
  "Renovate discovery: task API unavailable — skipping to avoid treating tracked work as new";

export const renovateDiscover = defineGitHubPreflight({
  id: "renovate-discover",
  input: RENOVATE_DISCOVER_INPUT,
  run: async (deps, params): Promise<PreflightExecutionResult> => {
    const tasks = await tasksOrSkip(deps.memory);
    if (tasks === null) {
      return { status: "skip", content: TASK_API_SKIP };
    }

    const repos = deps.repos;
    const repoKeys = params.repo_keys ?? Object.keys(repos);
    if (repoKeys.length === 0) {
      return {
        status: "skip",
        content: "Renovate discovery: no repos in project-repos.json",
      };
    }

    const discovery = await discoverFailingRenovatePrs(deps.github, {
      repos,
      tasks,
      taskKeyPrefix: params.task_key_prefix,
      botLogins: params.bot_logins,
      repoKeys,
    });

    const listingOutage = totalFetchFailureError(discovery.listings, {
      system: "GitHub",
      noun: "open-PR listing",
      route: deps.github.route,
    });
    if (listingOutage !== null) throw listingOutage;
    const detailOutage = totalFetchFailureError(discovery.details, {
      system: "GitHub",
      noun: "PR",
      route: deps.github.route,
    });
    if (detailOutage !== null) throw detailOutage;

    const evidence = [
      [discovery.listings, "PR listing"],
      [discovery.details, "PR"],
    ] as const;

    const totalFailing = discovery.autoFix.length + discovery.tracked.length;
    if (totalFailing === 0) {
      return {
        status: "skip",
        content: appendFetchEvidence("Renovate discovery: no failing Renovate PRs", evidence),
      };
    }

    if (discovery.autoFix.length === 0) {
      return {
        status: "skip",
        content: appendFetchEvidence(
          `Renovate discovery: ${discovery.tracked.length} failing PR(s) already tracked (see GH PR Status)`,
          evidence,
        ),
      };
    }

    const needsSlot = discovery.autoFix.filter((entry) => entry.existing_status !== "paused");
    const freeResume = discovery.autoFix.filter((entry) => entry.existing_status === "paused");
    if (needsSlot.length > 0 && freeResume.length === 0) {
      const active = tasks.filter((task) =>
        ACTIVE_TASK_STATUSES.includes(task.status ?? ""),
      ).length;
      if (active >= params.max_active) {
        return {
          status: "skip",
          content: appendFetchEvidence(
            `Renovate discovery: at capacity (${active}/${params.max_active}) — ` +
              `${needsSlot.length} PR(s) pending; will retry when a slot opens`,
            evidence,
          ),
        };
      }
    }

    const lines = [`## Renovate Discovery (${totalFailing} failing PRs)`, ""];
    if (discovery.autoFix.length > 0) {
      lines.push(`### AUTO-FIX (${discovery.autoFix.length})`);
      for (const entry of discovery.autoFix) {
        lines.push(formatPrLine(entry));
        lines.push("");
      }
    }
    if (discovery.tracked.length > 0) {
      lines.push(`### Already tracked (see GH PR Status below) (${discovery.tracked.length})`);
      for (const entry of discovery.tracked) {
        lines.push(`  ${entry.task_key} PR ${entry.upstream}#${entry.number} [${entry.issue_str}]`);
      }
      lines.push("");
    }

    return {
      status: "start",
      content: appendFetchEvidence(lines.join("\n").trimEnd(), evidence),
    };
  },
});
