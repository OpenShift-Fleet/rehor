import { z } from "zod";
import type { Preflight } from "../../core/registry.js";
import { definePreflight } from "../../core/registry.js";
import type { PreflightExecutionResult } from "../../core/results.js";
import {
  FetchTracker,
  failureEvidenceLines,
  totalFetchFailureError,
} from "../../shared/failure-policy.js";
import { fmtComments, fmtTaskHeader, getTaskPrs, isBotAuthor } from "../../shared/format.js";
import type { MemoryServerClient, MemoryTask } from "../../shared/memory-server.js";
import type { ProjectReposMap } from "../../shared/repos.js";
import { upstreamRepo } from "../../shared/repos.js";
import type { PreflightRunContext, PreflightRunState } from "../../shared/run-context.js";
import { isNewer } from "../../shared/time.js";
import type { GitlabClient, GlMergeRequest, GlMrNote } from "./gitlab.js";
import { createGitlabClient } from "./gitlab.js";

export type { GitlabClient, GitlabClientConfig, GlMergeRequest, GlMrNote } from "./gitlab.js";

/**
 * `gl-mr-status` — the TypeScript port of `presets/shared/preflight/
 * gl_mr_status.py`. Checks the GitLab MRs of the instance's active tasks
 * (state, pipelines, conflicts, unresolved threads, notes) and classifies
 * them into the same buckets as gh-pr-status: merged / closed / ci_fail /
 * conflict / feedback / clean. Actionable buckets produce a `start` result
 * with Markdown for the agent prompt; everything clean produces a `skip`.
 *
 * Behavior parity with the Python script, with two deliberate adaptations:
 *
 * - The Python `main(suppress_terminal_if_addressed=...)` flag (set by the
 *   onboarding workflow) is an input parameter with a `false` default, so
 *   the preflight keeps no required inputs and stays valid in workflow
 *   default sets.
 * - Per-MR fetch failures skip that MR (the Python glab wrappers degraded
 *   to `None`/`[]`), and per-MR note failures degrade to no notes — but
 *   only as *isolated* failures, per the shared failure policy
 *   (`shared/failure-policy.ts`): when every attempted fetch of a class
 *   failed (MR details or notes), the run escalates to an `error` result
 *   naming the required route — an unavailable route, an
 *   auth/rate-limit/5xx outage, or a network failure is never a silent
 *   skip. Tolerated failures are recorded as evidence in the result
 *   content.
 *
 * Active-task correlation runs through the shared memory-server client on
 * the run context (task and capacity fetches cached per run), and the
 * per-run state keeps the Python state-file bookkeeping keys (`gl_mr`,
 * `has_actionable`). GitLab is reached through the auth-proxy route wired
 * on the run context, exactly like gh-pr-status: the client is built from
 * `ctx.proxy` (base URL + `/gitlab` path prefix) inside `run()`, and an
 * unwired route is an `error` result, never a silent skip.
 */

/** Task statuses whose MRs are checked; same list as the capacity filter. */
const ACTIVE_STATUSES: readonly string[] = ["in_progress", "pr_open", "pr_changes"];

export const GL_MR_STATUS_INPUT = z.strictObject({
  /**
   * Suppress merged/closed buckets for tasks already addressed without new
   * feedback (the onboarding workflow's `main(suppress_terminal_if_addressed=True)`).
   */
  suppress_terminal_if_addressed: z.boolean().default(false),
});

export type GlMrStatusParams = z.infer<typeof GL_MR_STATUS_INPUT>;

/** One MR as classified for a task — the Python `mr_results` entry. */
export interface GlMrPr {
  readonly repo: string;
  readonly num: number;
  readonly host: "gitlab";
  readonly state: string;
  readonly issues: readonly string[];
  readonly data: GlMergeRequest;
}

/** A task enriched with its GitLab MRs — the Python `enrich_gl` result. */
export interface EnrichedGlTask {
  readonly task: MemoryTask;
  readonly prs: readonly GlMrPr[];
  readonly mrNotes: readonly GlMrNote[];
  readonly issues: readonly string[];
}

/** The input shape of the feedback/session checks. */
export interface GlFeedbackInput {
  readonly task: MemoryTask;
  readonly mrNotes: readonly GlMrNote[];
}

/** Result of classifying one MR — the Python `classify_gl` tuple. */
export interface GlClassification {
  readonly state: string;
  readonly issues: readonly string[];
}

/** The six buckets `main()` sorted enriched tasks into. */
export interface GlMrBuckets {
  readonly merged: readonly EnrichedGlTask[];
  readonly closed: readonly EnrichedGlTask[];
  readonly ciFail: readonly EnrichedGlTask[];
  readonly conflict: readonly EnrichedGlTask[];
  readonly feedback: readonly EnrichedGlTask[];
  readonly clean: readonly EnrichedGlTask[];
}

/** Dependencies of the ported `main()` flow, injectable for tests. */
export interface GlMrStatusDeps {
  readonly memory: MemoryServerClient;
  readonly state: PreflightRunState;
  readonly gitlab: GitlabClient;
  /** Instance repo map for bare repo-name resolution; defaults to empty. */
  readonly repos?: ProjectReposMap;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Classify a GitLab MR into `(state, issues)` — the Python `classify_gl`. */
export function classifyGl(mr: GlMergeRequest): GlClassification {
  const state = typeof mr.state === "string" ? mr.state : "unknown";
  if (state === "merged") {
    return { state: "MERGED", issues: ["merged"] };
  }
  if (state === "closed") {
    return { state: "CLOSED", issues: ["closed"] };
  }
  const issues: string[] = [];
  if (mr.has_conflicts) {
    issues.push("conflict");
  }
  const pipeline: Record<string, unknown> = isRecord(mr.head_pipeline) ? mr.head_pipeline : {};
  if (pipeline.status === "failed") {
    issues.push("ci_fail");
  }
  // Key absent defaults to resolved; a null value counts as unresolved
  // (the Python `.get(key, True)` + `not` behavior, bug-for-bug).
  const resolved = "blocking_discussions_resolved" in mr ? mr.blocking_discussions_resolved : true;
  if (!resolved) {
    issues.push("unresolved_threads");
  }
  return { state: state.toUpperCase(), issues };
}

/** True when a non-bot MR note is newer than the task's `last_addressed`. */
export function hasNewFeedback(enriched: GlFeedbackInput): boolean {
  const lastAddressed = enriched.task.last_addressed;
  for (const note of enriched.mrNotes) {
    if (isBotAuthor(note.a)) continue;
    if (!lastAddressed || isNewer(note.t, lastAddressed)) return true;
  }
  return false;
}

/** Whether an addressed CI failure needs another agent session. */
export function ciFailureNeedsSession(enriched: GlFeedbackInput): boolean {
  return !enriched.task.last_addressed || hasNewFeedback(enriched);
}

/**
 * Sort enriched tasks into the six buckets — the classification loop of the
 * Python `main()`. Exposed for tests and reused by the run flow.
 */
export function bucketGlMrStatuses(
  enrichedTasks: readonly EnrichedGlTask[],
  suppressTerminalIfAddressed: boolean,
): GlMrBuckets {
  const merged: EnrichedGlTask[] = [];
  const closed: EnrichedGlTask[] = [];
  const ciFail: EnrichedGlTask[] = [];
  const conflict: EnrichedGlTask[] = [];
  const feedback: EnrichedGlTask[] = [];
  const clean: EnrichedGlTask[] = [];
  for (const enriched of enrichedTasks) {
    const issues = enriched.issues;
    if (issues.includes("merged")) {
      if (isTerminalSuppressed(enriched, suppressTerminalIfAddressed)) clean.push(enriched);
      else merged.push(enriched);
    } else if (issues.includes("closed")) {
      if (isTerminalSuppressed(enriched, suppressTerminalIfAddressed)) clean.push(enriched);
      else closed.push(enriched);
    } else if (issues.some((issue) => issue.startsWith("ci_fail"))) {
      const ciOnly = issues.every((issue) => issue.startsWith("ci_fail"));
      if (ciOnly && !ciFailureNeedsSession(enriched)) clean.push(enriched);
      else ciFail.push(enriched);
    } else if (issues.includes("conflict")) {
      conflict.push(enriched);
    } else if (issues.includes("unresolved_threads") || hasNewFeedback(enriched)) {
      feedback.push(enriched);
    } else {
      clean.push(enriched);
    }
  }
  return { merged, closed, ciFail, conflict, feedback, clean };
}

/** `suppress and last_addressed and not has_new_feedback(e)` from `main()`. */
function isTerminalSuppressed(enriched: EnrichedGlTask, suppress: boolean): boolean {
  return Boolean(suppress && enriched.task.last_addressed) && !hasNewFeedback(enriched);
}

/** Format a task with its GL MR details — the Python `fmt_task`. */
function fmtTask(enriched: EnrichedGlTask): string {
  const lines = fmtTaskHeader(enriched.task);
  for (const mr of enriched.prs) {
    const issueStr = mr.issues.length > 0 ? mr.issues.join(",") : "clean";
    lines.push(`  MR ${mr.repo}!${mr.num} (gitlab) state=${mr.state} [${issueStr}]`);
  }
  if (enriched.mrNotes.length > 0) {
    const lastAddressed = enriched.task.last_addressed;
    lines.push(fmtComments(enriched.mrNotes, "mr_notes", lastAddressed));
  }
  return lines.join("\n");
}

/** Per-run GitLab fetch bookkeeping for the failure policy. */
interface GitlabFetchTrackers {
  /** MR detail fetches (one per existing, resolvable MR of the active tasks). */
  readonly items: FetchTracker;
  /** Note fetches (one per successfully fetched MR). */
  readonly notes: FetchTracker;
}

/**
 * Enrich one task with its GitLab MRs — the Python `enrich_gl`. Returns
 * null when the task has no (fetchable) GitLab MRs. Per the shared failure
 * policy: an MR fetch failure skips that MR and is tallied — tolerated
 * while other MRs still fetch (isolated, item-specific), escalated by the
 * run flow when nothing could be fetched. A notes fetch failure skips that
 * MR's notes and is tallied the same way — the Python `gl_mr_notes`
 * wrapper degraded to `[]`, but a run where every fetched MR's notes
 * failed is a systematic outage the run flow escalates instead of silently
 * erasing all feedback.
 */
async function enrichGl(
  task: MemoryTask,
  gitlab: GitlabClient,
  repos: ProjectReposMap,
  trackers: GitlabFetchTrackers,
): Promise<EnrichedGlTask | null> {
  const prsInfo = getTaskPrs(task, repos);
  const glMrs = prsInfo.filter((pr) => pr?.host === "gitlab");
  if (glMrs.length === 0) return null;

  const mrResults: GlMrPr[] = [];
  const mrNotes: GlMrNote[] = [];
  const allIssues: string[] = [];
  const taskRepo = typeof task.repo === "string" ? task.repo : "";

  for (const pr of glMrs) {
    const mrRepo = typeof pr?.repo === "string" ? pr.repo : taskRepo;
    const mrNum = pr?.number;
    if (!mrNum) continue;
    const { upstreamPath } = upstreamRepo(mrRepo, repos);
    if (upstreamPath === "") continue;
    const item = `${upstreamPath}!${mrNum}`;
    let data: GlMergeRequest;
    try {
      data = await gitlab.getMergeRequest(upstreamPath, mrNum);
    } catch (error) {
      trackers.items.recordFailure(item, error);
      continue;
    }
    trackers.items.recordSuccess();
    const { state, issues } = classifyGl(data);
    mrResults.push({ repo: mrRepo, num: mrNum, host: "gitlab", state, issues, data });
    allIssues.push(...issues);
    try {
      mrNotes.push(...(await gitlab.listMergeRequestNotes(upstreamPath, mrNum)));
      trackers.notes.recordSuccess();
    } catch (error) {
      // Isolated notes failure: degrade to no notes for this MR (the
      // Python gl_mr_notes wrapper parity). A run where every fetched
      // MR's notes failed is escalated by the run flow — never a silent
      // erasure of all feedback.
      trackers.notes.recordFailure(item, error);
    }
  }

  if (mrResults.length === 0) return null;
  return { task, prs: mrResults, mrNotes, issues: allIssues };
}

/**
 * The ported `main()` flow: fetch tasks and capacity through the shared
 * memory-server client, enrich active tasks' GitLab MRs, classify into
 * buckets, save the run state, and return the protocol result.
 */
export async function runGlMrStatus(
  deps: GlMrStatusDeps,
  params: GlMrStatusParams,
): Promise<PreflightExecutionResult> {
  const [tasks, capacity] = await Promise.all([deps.memory.getTasks(), deps.memory.getCapacity()]);
  const active = tasks.filter((task) => ACTIVE_STATUSES.includes(task?.status ?? ""));
  if (active.length === 0) {
    return {
      status: "skip",
      content: `GL MR status: no active tasks (capacity ${capacity.active}/${capacity.max})`,
    };
  }

  const repos = deps.repos ?? {};
  const trackers: GitlabFetchTrackers = {
    items: new FetchTracker(),
    notes: new FetchTracker(),
  };
  const enrichedTasks: EnrichedGlTask[] = [];
  for (const task of active) {
    const enriched = await enrichGl(task, deps.gitlab, repos, trackers);
    if (enriched !== null) {
      enrichedTasks.push(enriched);
    }
  }

  // The failure policy: a total inability to fetch the attempted MRs —
  // auth (401/403), rate limit (429), upstream 5xx, network/timeout, or
  // the 404 of a route the proxy does not serve — is an execution error
  // naming the required route, never a silent "no MRs to check" skip. The
  // same holds when every fetched MR's notes failed: feedback would be
  // silently erased. Isolated failures are tolerated and recorded below.
  const itemOutage = totalFetchFailureError(trackers.items, {
    system: "GitLab",
    noun: "MR",
    route: deps.gitlab.route,
  });
  if (itemOutage !== null) {
    throw itemOutage;
  }
  const noteOutage = totalFetchFailureError(trackers.notes, {
    system: "GitLab",
    noun: "MR note",
    route: deps.gitlab.route,
  });
  if (noteOutage !== null) {
    throw noteOutage;
  }

  if (enrichedTasks.length === 0) {
    return {
      status: "skip",
      content: `GL MR status: no GL MRs to check (${active.length} active tasks)`,
    };
  }

  const buckets = bucketGlMrStatuses(enrichedTasks, params.suppress_terminal_if_addressed);

  const lines: string[] = [`## GL MR Status (${enrichedTasks.length} MRs checked)`, ""];
  let actionable = 0;
  const sections: readonly (readonly [string, readonly EnrichedGlTask[]])[] = [
    ["MERGED", buckets.merged],
    ["CLOSED", buckets.closed],
    ["CI FAILING", buckets.ciFail],
    ["CONFLICTS", buckets.conflict],
    ["FEEDBACK", buckets.feedback],
  ];
  for (const [label, bucket] of sections) {
    if (bucket.length === 0) continue;
    lines.push(`### ${label} (${bucket.length})`);
    for (const enriched of bucket) {
      lines.push(fmtTask(enriched));
      lines.push("");
    }
    actionable += bucket.length;
  }
  if (buckets.clean.length > 0) {
    lines.push(`### CLEAN (${buckets.clean.length})`);
    for (const enriched of buckets.clean) {
      const task = enriched.task;
      lines.push(`  ${task.external_key ?? "?"} [${task.status ?? "?"}] ${task.repo ?? "?"}`);
    }
    lines.push("");
  }
  const failureLines = [
    ...failureEvidenceLines(trackers.items, "MR"),
    ...failureEvidenceLines(trackers.notes, "MR notes"),
  ];
  if (failureLines.length > 0) {
    // Isolated fetch failures are evidence, not actionable buckets: the
    // skipped MR (or its notes) could not be checked this run.
    lines.push(`### UNFETCHABLE (${failureLines.length})`);
    lines.push(...failureLines);
    lines.push("");
  }

  // The Python state-file bookkeeping, on the per-run context state.
  const prevActionable = Boolean(deps.state.get("has_actionable"));
  deps.state.set("gl_mr", {
    merged: buckets.merged.length,
    closed: buckets.closed.length,
    ci_fail: buckets.ciFail.length,
    conflicts: buckets.conflict.length,
    feedback: buckets.feedback.length,
    clean: buckets.clean.length,
  });
  deps.state.set("has_actionable", prevActionable || actionable > 0);

  const content = lines.join("\n");
  return actionable > 0 ? { status: "start", content } : { status: "skip", content };
}

/** The registered preflight. Wires the run context into the flow: the
 * GitLab client is built from the run's auth-proxy route, the repo map
 * resolves bare repo names, and any failure — including an unwired proxy
 * route — surfaces as an `error` result, never a silent skip. */
export const glMrStatus: Preflight = definePreflight({
  id: "gl-mr-status",
  input: GL_MR_STATUS_INPUT,
  run: async (
    ctx: PreflightRunContext,
    params: GlMrStatusParams,
  ): Promise<PreflightExecutionResult> => {
    if (ctx.proxy === undefined) {
      return {
        status: "error",
        content:
          "gl-mr-status: auth proxy route is not wired for this run (missing proxy base URL)",
      };
    }
    try {
      return await runGlMrStatus(
        {
          memory: ctx.memory,
          state: ctx.state,
          gitlab: createGitlabClient(
            typeof ctx.proxy === "string" ? { baseUrl: ctx.proxy } : ctx.proxy,
          ),
          repos: ctx.repos ?? {},
        },
        params,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "error", content: `gl-mr-status: ${message}` };
    }
  },
});
