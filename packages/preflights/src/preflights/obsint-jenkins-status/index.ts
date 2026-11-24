import { z } from "zod";
import { definePreflight } from "../../core/registry.js";
import type { PreflightExecutionResult } from "../../core/results.js";
import type { JenkinsBuildDetail, JenkinsClient, JenkinsJob } from "../../shared/jenkins.js";
import type { MemoryServerClient } from "../../shared/memory-server.js";
import type { PreflightRunContext } from "../../shared/run-context.js";
import type { SlackClient } from "../../shared/slack.js";
import { executionErrorResult } from "../jira-common/errors.js";
import { appendWarnings, errorMessage } from "../obsint-common/warnings.js";
import {
  type ClassifiedJobs,
  classifyJobs,
  computeCurrentSignature,
  hashContent,
  jenkinsBuildUrl,
  slimJob,
} from "./classify.js";

/**
 * `obsint-jenkins-status` — the port of the watchduty preflight
 * `01-jenkins-status.py` (Jenkins CI triage before the AI session).
 *
 * Fetches every job of both configured Jenkins instances with its last 10
 * builds (the Python invoked the `triage-jenkins` skill without arguments,
 * whose all-jobs default is 10 builds), classifies them deterministically
 * (disabled/building exclusions, prod-before-stage priority, failure
 * patterns), and cleans up recovered jobs:
 *
 * - both instances unreachable / no jobs -> skip
 * - all eligible jobs healthy -> skip (tracked tasks archived, memories deleted)
 * - failing jobs, all tracked with unchanged error signatures -> skip plus a
 *   compact Slack report sent directly from the preflight (zero tokens)
 * - new failing jobs or a changed error signature -> start (AI classifies)
 *
 * Behavior parity with the Python script, with the deliberate adaptations
 * the engine requires:
 *
 * - Jenkins data comes from the run context's Jenkins client
 *   (`ctx.jenkins`) instead of the `triage-jenkins` skill subprocess; the
 *   build-detail fetch and the report links use the client's configured
 *   instance endpoints (the Python hardcoded its `JENKINS_URLS` constants).
 * - Tracked tasks come from the memory client's task listing filtered to
 *   `source_type === "scheduled"` (the Python `/api/tasks` query with
 *   `limit=100`). The engine listing caps at the newest 50 tasks, so a
 *   scheduled task pushed past the newest 50 by newer rows is invisible
 *   here — same client contract every preflight shares.
 * - Stored signatures come from `memory.listMemories("watchduty")` filtered
 *   to `watchduty:jenkins:<job>` tags, hashed with the same 12-char md5
 *   prefix.
 * - The Python caught task/memory listing failures and degraded to empty
 *   (fetch_tracked_tasks / fetch_stored_signatures returned `{}` on any
 *   exception, so an unreachable memory server looked like "nothing
 *   tracked" and could start duplicate sessions). The engine clients throw
 *   on failure, and this port lets that propagate to an `error` result —
 *   fail closed per the engine client philosophy.
 * - Per-entry cleanup failures (archiving one task, deleting one memory)
 *   are caught and continue, surfaced as `WARN:` lines in the result
 *   content — the Python printed them to stderr.
 * - The compact Slack report goes through the run context's Slack client;
 *   an unwired client or a failed send degrades the report to
 *   "Slack skipped (no webhook)" exactly like the Python, never an error.
 */

export const OBSINT_JENKINS_STATUS_INPUT = z.strictObject({});

export type ObsintJenkinsStatusParams = z.infer<typeof OBSINT_JENKINS_STATUS_INPUT>;

/** Dependencies of the ported `main()` flow, injectable for tests. */
export interface ObsintJenkinsStatusDeps {
  readonly jenkins: JenkinsClient;
  readonly memory: MemoryServerClient;
  readonly slack?: SlackClient;
}

/** The Python invoked the all-jobs skill mode, whose default is 10 builds. */
const N_BUILDS = 10;

/** The 12-char md5 prefix marker tag namespace the watchduty agent writes. */
const JENKINS_TAG_PREFIX = "watchduty:jenkins:";

export async function runObsintJenkinsStatus(
  deps: ObsintJenkinsStatusDeps,
): Promise<PreflightExecutionResult> {
  const { jenkins, memory } = deps;
  const data = await jenkins.getAllJobs(N_BUILDS);
  if (data === null) {
    return {
      status: "skip",
      content: "Pre-flight: both Jenkins instances unreachable. Skipping cycle.",
    };
  }
  // Snapshot the transport errors the all-jobs fetch accumulated; later
  // build-detail fetches append to the live array, like the Python's
  // already-serialized report did not.
  const errors = [...jenkins.errors];

  const classified = classifyJobs(data.jobs);
  if (classified === null) {
    return {
      status: "skip",
      content: "Pre-flight: no jobs returned from Jenkins. Skipping cycle.",
    };
  }

  const warnings: string[] = [];

  if (!classified.hasFailures) {
    const tracked = await fetchTrackedScheduledTasks(memory);
    if (tracked.size > 0) {
      // All jobs healthy — every tracked task is stale.
      await cleanupRecoveredJobs(memory, tracked, new Set(), warnings);
    }
    const totalOk = classified.recovering.length + classified.healthy.length;
    return {
      status: "skip",
      content: appendWarnings(
        `Pre-flight: all ${totalOk} eligible Jenkins jobs are healthy. Skipping cycle.`,
        warnings,
      ),
    };
  }

  const tracked = await fetchTrackedScheduledTasks(memory);
  const failingNames = new Set(classified.headFailing.map((job) => job.name));
  const recovered = await cleanupRecoveredJobs(memory, tracked, failingNames, warnings);

  const trackedJobs = new Set([...tracked.keys()].filter((repo) => !recovered.includes(repo)));
  const newFailures = new Set([...failingNames].filter((name) => !trackedJobs.has(name)));

  if (newFailures.size === 0) {
    const storedSignatures = await fetchStoredSignatures(memory);
    const changedJobs: string[] = [];
    const fetchedDetails = new Map<string, JenkinsBuildDetail>();

    for (const job of classified.headFailing) {
      const name = job.name;
      const stored = storedSignatures.get(name);
      if (stored === undefined) {
        changedJobs.push(name);
        continue;
      }
      const detail = await fetchBuildDetailForJob(jenkins, job);
      const currentSignature = computeCurrentSignature(job, detail);
      if (currentSignature !== stored) {
        changedJobs.push(name);
        if (detail !== undefined) {
          fetchedDetails.set(name, detail);
        }
      }
    }

    if (changedJobs.length === 0) {
      const sent = await sendCompactSlack(deps, classified, false);
      const statusMsg = sent ? "compact Slack sent" : "Slack skipped (no webhook)";
      return {
        status: "skip",
        content: appendWarnings(
          `Pre-flight: ${classified.headFailing.length} failing (all tracked, same errors), ` +
            `${classified.recovering.length} recovering, ${classified.healthy.length} healthy. ${statusMsg}.`,
          warnings,
        ),
      };
    }

    const jobsToAnalyze = classified.headFailing.filter((job) => changedJobs.includes(job.name));
    const stillTracked = classified.headFailing
      .filter((job) => !changedJobs.includes(job.name))
      .map((job) => job.name);

    const header =
      `Pre-flight: ${jobsToAnalyze.length} failing with CHANGED errors, ${stillTracked.length} ` +
      `tracked (same error), ${classified.recovering.length} recovering, ${classified.healthy.length} healthy.\n` +
      "Error signature changed for these jobs — re-analyze and update memory.\n" +
      "Patterns pre-classified. Only fetch individual build details when analyzing a failure.\n\n";

    const output = {
      failing: jobsToAnalyze.map((job) => slimJob(job, fetchedDetails.get(job.name))),
      tracked_failing_jobs: stillTracked,
      tracked_failing_count: stillTracked.length,
      recovering_jobs: classified.recovering,
      recovering_count: classified.recovering.length,
      healthy_jobs: classified.healthy,
      healthy_count: classified.healthy.length,
      skipped: classified.skipped,
      errors,
    };
    return {
      status: "start",
      content: appendWarnings(header + JSON.stringify(output, null, 2), warnings),
    };
  }

  const newFailing = classified.headFailing.filter((job) => newFailures.has(job.name));
  const trackedFailing = classified.headFailing
    .filter((job) => !newFailures.has(job.name))
    .map((job) => job.name);

  const header =
    `Pre-flight: ${newFailing.length} NEW failing, ${trackedFailing.length} already tracked, ` +
    `${classified.recovering.length} recovering, ${classified.healthy.length} healthy.\n` +
    "Patterns pre-classified. Only fetch individual build details when analyzing a failure.\n\n";

  const output = {
    failing: newFailing.map((job) => slimJob(job)),
    tracked_failing_jobs: trackedFailing,
    tracked_failing_count: trackedFailing.length,
    recovering_jobs: classified.recovering,
    recovering_count: classified.recovering.length,
    healthy_jobs: classified.healthy,
    healthy_count: classified.healthy.length,
    skipped: classified.skipped,
    errors,
  };
  return {
    status: "start",
    content: appendWarnings(header + JSON.stringify(output, null, 2), warnings),
  };
}

/**
 * The Python `fetch_tracked_tasks`: `{repo: external_key}` for scheduled
 * tasks. The engine listing excludes archived tasks and caps at the newest
 * 50 (the Python capped at 100) — the shared client contract.
 */
async function fetchTrackedScheduledTasks(
  memory: MemoryServerClient,
): Promise<Map<string, string>> {
  const tasks = await memory.getTasks();
  const tracked = new Map<string, string>();
  for (const task of tasks) {
    const repo = task.repo;
    const externalKey = task.external_key;
    if (typeof repo === "string" && repo !== "" && task.source_type === "scheduled") {
      if (typeof externalKey === "string" && externalKey !== "") {
        tracked.set(repo, externalKey);
      }
    }
  }
  return tracked;
}

/**
 * The Python `cleanup_recovered_jobs`: archive the task and delete the
 * `watchduty:jenkins:<job>` memories of every tracked job that is no longer
 * failing. Per-entry failures are caught and continue as warnings.
 */
async function cleanupRecoveredJobs(
  memory: MemoryServerClient,
  tracked: ReadonlyMap<string, string>,
  failingNames: ReadonlySet<string>,
  warnings: string[],
): Promise<string[]> {
  const recovered: string[] = [];
  for (const [repo, externalKey] of tracked) {
    if (failingNames.has(repo)) continue;
    try {
      await memory.archiveTask(externalKey);
    } catch (error) {
      warnings.push(`could not archive task ${externalKey}: ${errorMessage(error)}`);
    }
    try {
      const records = await memory.listMemories(`${JENKINS_TAG_PREFIX}${repo}`, 10);
      for (const record of records) {
        try {
          await memory.deleteMemory(record.id);
        } catch (error) {
          warnings.push(`could not delete memory ${record.id} for ${repo}: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      warnings.push(`could not delete memory for ${repo}: ${errorMessage(error)}`);
    }
    recovered.push(repo);
  }
  return recovered;
}

/**
 * The Python `fetch_stored_signatures`: `{job_name: signature_hash}` from
 * memory entries tagged `watchduty:jenkins:<job_name>`. The listing itself
 * fails closed (see the header adaptations).
 */
async function fetchStoredSignatures(memory: MemoryServerClient): Promise<Map<string, string>> {
  const signatures = new Map<string, string>();
  const records = await memory.listMemories("watchduty", 100);
  for (const record of records) {
    for (const tag of record.tags) {
      if (tag.startsWith(JENKINS_TAG_PREFIX)) {
        signatures.set(tag.slice(JENKINS_TAG_PREFIX.length), hashContent(record.content));
        break;
      }
    }
  }
  return signatures;
}

/**
 * The Python `fetch_build_detail_for_job`: fetch the failure detail of the
 * latest failed build (the engine client resolves the instance and never
 * returns null — transport failures land in `errors` and the detail stays
 * empty, which the signature computation treats as no detail).
 */
async function fetchBuildDetailForJob(
  jenkins: JenkinsClient,
  job: JenkinsJob,
): Promise<JenkinsBuildDetail | undefined> {
  const builds = job.builds;
  if (builds.length === 0 || builds[0].result !== "FAILURE") {
    return undefined;
  }
  return await jenkins.getBuildDetail(job.name, builds[0].number);
}

/**
 * The Python `send_compact_slack`: one compact report straight to the
 * webhook (zero AI tokens). An unwired client or a failed send resolves
 * false — the report degrades, never errors.
 */
async function sendCompactSlack(
  deps: ObsintJenkinsStatusDeps,
  classified: ClassifiedJobs,
  changedJobs: boolean,
): Promise<boolean> {
  const lines: string[] = [
    changedJobs
      ? "🚨 *CCX Jenkins Watchduty Report*"
      : "🚨 *CCX Jenkins Watchduty Report (no change)*",
    "",
  ];

  if (classified.headFailing.length > 0) {
    if (changedJobs) {
      lines.push(`🔴 *Failing (${classified.headFailing.length}):*`);
    } else {
      lines.push(`🔴 *Failing (${classified.headFailing.length}) — no change since last report:*`);
    }
    for (const job of classified.headFailing) {
      const buildNumber = job.lastFailedBuild?.number;
      const url = jenkinsBuildUrl(deps.jenkins.instances, job);
      lines.push(
        `- <${url}|${job.name}> — last failed #${typeof buildNumber === "number" ? buildNumber : ""}`,
      );
    }
  }

  if (classified.recovering.length > 0) {
    lines.push(`🟡 Recovering (${classified.recovering.length})`);
  }
  if (classified.healthy.length > 0) {
    lines.push(`🟢 Healthy (${classified.healthy.length})`);
  }
  const building = classified.skipped.filter((entry) => entry.reason === "building");
  if (building.length > 0) {
    lines.push(`🛠️ Building (${building.length})`);
  }

  if (deps.slack === undefined) {
    return false;
  }
  return await deps.slack.send(lines.join("\n"));
}

export const obsintJenkinsStatus = definePreflight({
  id: "obsint-jenkins-status",
  input: OBSINT_JENKINS_STATUS_INPUT,
  run: async (ctx: PreflightRunContext): Promise<PreflightExecutionResult> => {
    if (ctx.jenkins === undefined) {
      return {
        status: "error",
        content:
          "obsint-jenkins-status requires a wired Jenkins client (deployment configuration must render the instance endpoints)",
      };
    }
    return runObsintJenkinsStatus({
      jenkins: ctx.jenkins,
      memory: ctx.memory,
      slack: ctx.slack,
    }).catch(executionErrorResult);
  },
});
