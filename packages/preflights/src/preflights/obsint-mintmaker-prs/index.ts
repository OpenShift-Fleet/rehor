import { z } from "zod";
import { definePreflight } from "../../core/registry.js";
import type { PreflightExecutionResult } from "../../core/results.js";
import type { GitHubClient } from "../../shared/github.js";
import { createGitHubClient } from "../../shared/github.js";
import type { MemoryRecord, MemoryServerClient } from "../../shared/memory-server.js";
import type { PreflightRunContext } from "../../shared/run-context.js";
import type { PersistentStateStore } from "../../shared/state.js";
import { executionErrorResult } from "../jira-common/errors.js";
import { appendWarnings, errorMessage } from "../obsint-common/warnings.js";
import { parseCsvRecords } from "./csv.js";

/**
 * `obsint-mintmaker-prs` — the port of the watchduty preflight
 * `02-mintmaker-prs.py` (failing MintMaker/Konflux PR triage).
 *
 * Reads the daily open-prs.csv report from the processing-tools repo
 * (generated at 4AM UTC by GitHub Actions) and filters for bot PRs.
 * Self-throttles the CSV triage to once every 8 hours.
 *
 * Cleanup (zero tokens) runs every cycle BEFORE the throttle check:
 * queries the memory server for tracked `mintmaker:*` entries, checks each
 * tracked PR's state, and archives tasks / removes memory entries for
 * merged or closed PRs.
 *
 * Exit conditions:
 * - last run < throttle window ago -> skip (cleanup still ran)
 * - report fetch fails (404) -> skip (run time saved)
 * - no bot PRs in report -> skip
 * - bot PRs found -> start (agent triages)
 *
 * Behavior parity with the Python script, with the deliberate adaptations
 * the engine requires:
 *
 * - The Python constants (`THROTTLE_HOURS`, `REPORT_REPO`, `REPORT_PATH`,
 *   `BOT_AUTHORS`) become input parameters with the same defaults.
 * - The CSV report and the PR-state checks go through the engine's
 *   GitHub client on the auth-proxy route instead of the `gh` CLI. The
 *   Python hardcoded the `RedHatInsights/` org for PR-state checks; the
 *   port derives the org from `report_repo`'s owner (the default is
 *   `RedHatInsights`, so default behavior is unchanged). A PR-state fetch
 *   that definitively 404s (client resolves null) skips the entry silently
 *   like the failed `gh` call did; a transport failure is caught per entry
 *   and continues as a `WARN:` line.
 * - The 8-hour throttle timestamp lives in the run context's persistent
 *   state store under `obsint-mintmaker-prs:last-run` (epoch milliseconds)
 *   instead of the `BOT_DATA_DIR` state file.
 * - The Python caught the tracked-memories listing failure and degraded to
 *   an empty list; the engine client throws, and this port lets that
 *   propagate to an `error` result — fail closed per the engine client
 *   philosophy.
 * - Successful cleanup was logged to stderr only; the port appends one
 *   `Cleaned up N merged/closed PR(s)` line to the result content so the
 *   cycle report shows it.
 */

export const OBSINT_MINTMAKER_INPUT = z.strictObject({
  /** CSV triage throttle (the Python `THROTTLE_HOURS`). */
  throttle_hours: z.number().int().min(1).default(8),
  /** Repository publishing the daily open-PRs CSV report. */
  report_repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "report_repo must look like owner/repo")
    .default("RedHatInsights/processing-tools"),
  /** Path of the CSV report inside `report_repo`. */
  report_path: z.string().default("open_mr_pr/github/open-prs.csv"),
  /** CSV `author` values counted as bot PRs (the Python `BOT_AUTHORS` set). */
  bot_authors: z.array(z.string()).default(["app/red-hat-konflux", "app/dependabot"]),
});

export type ObsintMintmakerParams = z.infer<typeof OBSINT_MINTMAKER_INPUT>;

/** Persistent-state key of the throttle timestamp (epoch milliseconds). */
export const MINTMAKER_LAST_RUN_KEY = "obsint-mintmaker-prs:last-run";

/** The tracked-PR tag namespace the agent's mintmaker sessions write. */
const MINTMAKER_TAG_PREFIX = "mintmaker:";

/** Dependencies of the ported `main()` flow, injectable for tests. */
export interface ObsintMintmakerDeps {
  readonly memory: MemoryServerClient;
  readonly github: GitHubClient;
  readonly persistentState: PersistentStateStore;
  /** Injectable clock so tests can fix the throttle window. */
  readonly now?: () => Date;
}

export async function runObsintMintmakerPrs(
  deps: ObsintMintmakerDeps,
  params: ObsintMintmakerParams,
): Promise<PreflightExecutionResult> {
  const now = deps.now?.() ?? new Date();
  const warnings: string[] = [];
  const org = params.report_repo.split("/")[0] ?? "";

  // Cleanup runs every cycle (hourly) — task slots are limited. Runs before
  // the throttle check, like the Python.
  const cleaned = await cleanupMergedPrs(deps, org, warnings);
  const cleanedLine = cleaned > 0 ? `\nCleaned up ${cleaned} merged/closed PR(s)` : "";

  const lastRun = await deps.persistentState.get<number>(MINTMAKER_LAST_RUN_KEY);
  if (typeof lastRun === "number" && now.getTime() - lastRun < params.throttle_hours * 3_600_000) {
    return {
      status: "skip",
      content: appendWarnings(
        `Mintmaker scan throttled (last run < ${params.throttle_hours}h ago)${cleanedLine}`,
        warnings,
      ),
    };
  }

  const csvText = await deps.github.getFileContents(params.report_repo, params.report_path);
  if (csvText === null) {
    await deps.persistentState.set(MINTMAKER_LAST_RUN_KEY, now.getTime());
    return {
      status: "skip",
      content: appendWarnings(`Could not fetch PR CSV report${cleanedLine}`, warnings),
    };
  }

  const botPrs = parseCsvRecords(csvText).filter((record) =>
    params.bot_authors.includes(record.author ?? ""),
  );
  await deps.persistentState.set(MINTMAKER_LAST_RUN_KEY, now.getTime());

  if (botPrs.length === 0) {
    return {
      status: "skip",
      content: appendWarnings(
        `No open MintMaker/Konflux PRs in daily report${cleanedLine}`,
        warnings,
      ),
    };
  }

  const failing = botPrs.filter((pr) => pr.ci_status === "failed");
  const passing = botPrs.filter((pr) => pr.ci_status !== "failed");
  const reportName = params.report_repo.split("/")[1] ?? params.report_repo;

  const lines: string[] = [
    `## MintMaker PR Triage — ${botPrs.length} open PR(s) (${failing.length} failing, ${passing.length} passing)`,
    "",
  ];
  lines.push(`Source: ${reportName} daily CSV report (generated 4AM UTC)`);

  if (failing.length > 0) {
    lines.push("");
    lines.push("### Failing CI");
    for (const pr of failing) {
      lines.push(formatPr(pr));
      lines.push("");
    }
  }
  if (passing.length > 0) {
    lines.push("### Passing CI (may need review or already merged)");
    for (const pr of passing) {
      lines.push(formatPr(pr));
      lines.push("");
    }
  }

  return {
    status: "start",
    content: appendWarnings(lines.join("\n") + cleanedLine, warnings),
  };
}

/** The Python `_format_pr`: one PR block of the triage report. */
function formatPr(pr: Record<string, string>): string {
  const lines = [`${pr.repo}#${pr.pr_id} by ${pr.author}`];
  lines.push(`  title: ${pr.title}`);
  lines.push(`  url: ${pr.url}`);
  lines.push(`  created: ${(pr.date_created ?? "").slice(0, 10)}`);
  lines.push(`  ci_status: ${pr.ci_status || "unknown"}`);
  return lines.join("\n");
}

/** One tracked PR decoded from a `mintmaker:<repo>#<pr>` tag. */
interface TrackedMintmakerEntry {
  readonly id: MemoryRecord["id"];
  readonly repo: string;
  readonly prNumber: number;
}

/**
 * The Python `_fetch_tracked_mintmaker_memories`: tracked PRs decoded from
 * memory entries tagged `mintmaker:<repo>#<pr>`. The listing itself fails
 * closed (see the header adaptations).
 */
async function fetchTrackedMintmakerEntries(
  memory: MemoryServerClient,
): Promise<TrackedMintmakerEntry[]> {
  const tracked: TrackedMintmakerEntry[] = [];
  const records = await memory.listMemories("mintmaker", 100);
  for (const record of records) {
    for (const tag of record.tags) {
      if (!tag.startsWith(MINTMAKER_TAG_PREFIX)) continue;
      const rest = tag.slice(MINTMAKER_TAG_PREFIX.length);
      const separator = rest.lastIndexOf("#");
      if (separator !== -1) {
        const repo = rest.slice(0, separator);
        const prNumber = Number(rest.slice(separator + 1));
        // A tag without a bare repo and a numeric PR number could never
        // resolve to a PR; the failed `gh` call skipped it silently.
        if (repo !== "" && Number.isInteger(prNumber)) {
          tracked.push({ id: record.id, repo, prNumber });
        }
      }
      break;
    }
  }
  return tracked;
}

/**
 * The Python `cleanup_merged_prs`: check every tracked PR's state and clean
 * up (archive task + delete memory) the merged/closed ones. Per-entry PR
 * check, archive, and delete failures are caught and continue as warnings.
 */
async function cleanupMergedPrs(
  deps: ObsintMintmakerDeps,
  org: string,
  warnings: string[],
): Promise<number> {
  const tracked = await fetchTrackedMintmakerEntries(deps.memory);
  let cleaned = 0;
  for (const entry of tracked) {
    let state: string | null = null;
    try {
      const pr = await deps.github.getPr(`${org}/${entry.repo}`, entry.prNumber);
      state = pr?.state ?? null;
    } catch (error) {
      warnings.push(
        `could not check PR state for ${org}/${entry.repo}#${entry.prNumber}: ${errorMessage(error)}`,
      );
      continue;
    }
    if (state !== "MERGED" && state !== "CLOSED") continue;

    const externalKey = `${MINTMAKER_TAG_PREFIX}${entry.repo}#${entry.prNumber}`;
    try {
      await deps.memory.archiveTask(externalKey);
    } catch (error) {
      warnings.push(`could not archive task ${externalKey}: ${errorMessage(error)}`);
    }
    try {
      await deps.memory.deleteMemory(entry.id);
    } catch (error) {
      warnings.push(`could not delete memory ${entry.id}: ${errorMessage(error)}`);
    }
    cleaned += 1;
  }
  return cleaned;
}

export const obsintMintmakerPrs = definePreflight({
  id: "obsint-mintmaker-prs",
  input: OBSINT_MINTMAKER_INPUT,
  run: async (
    ctx: PreflightRunContext,
    params: ObsintMintmakerParams,
  ): Promise<PreflightExecutionResult> => {
    if (ctx.proxy === undefined) {
      return {
        status: "error",
        content:
          "obsint-mintmaker-prs: auth proxy route is not wired for this run (missing proxy base URL)",
      };
    }
    if (ctx.persistentState === undefined) {
      return {
        status: "error",
        content:
          "obsint-mintmaker-prs requires a wired persistent state store (an unpersisted throttle marker would re-run the scan every cycle)",
      };
    }
    return runObsintMintmakerPrs(
      {
        memory: ctx.memory,
        github: createGitHubClient(
          typeof ctx.proxy === "string" ? { baseUrl: ctx.proxy } : ctx.proxy,
        ),
        persistentState: ctx.persistentState,
      },
      params,
    ).catch(executionErrorResult);
  },
});
