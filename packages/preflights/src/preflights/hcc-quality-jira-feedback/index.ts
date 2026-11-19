import { z } from "zod";
import { definePreflight } from "../../core/registry.js";
import type { PreflightExecutionResult } from "../../core/results.js";
import { isBotAuthor } from "../../shared/format.js";
import type { JiraClient, JiraComment, JiraIssue } from "../../shared/jira.js";
import type { MemoryServerClient, MemoryTask } from "../../shared/memory-server.js";
import type { ProjectReposMap } from "../../shared/repos.js";
import type { PreflightRunContext, PreflightRunState } from "../../shared/run-context.js";
import type { LocalScheduleWindow } from "../../shared/schedule.js";
import { isWithinLocalWindow } from "../../shared/schedule.js";
import { nonBlank } from "../../shared/strings.js";
import { isNewer } from "../../shared/time.js";
import { executionErrorResult, JIRA_CLIENT_NOT_WIRED } from "../jira-common/errors.js";
import { isRecord, issueComments, taskMetadata } from "../jira-common/shapes.js";
import { fmtJira, selectPromptComments } from "../jira-common/triage.js";

/**
 * `hcc-quality-jira-feedback` — the Jira feedback channel for the quality
 * workflow's ongoing tasks.
 *
 * The two quality scans (`hcc-merged-pr-violations`,
 * `hcc-test-anti-pattern-scan`) only discover new findings; once a finding
 * becomes a tracked task (`merge-violation:{repo}:{pr}` or
 * `test-scan:{repo}:{date}`), human feedback on its Jira issue had no
 * preflight to pick it up — the scans' per-finding gating deliberately
 * leaves ongoing tasks alone. This preflight closes that gap, and only
 * that gap: it never discovers new findings and never retries stale work.
 *
 * Task identity, and why `jira-triage` cannot do this: the quality
 * workflow stores the real Jira issue key in `metadata.jira_key`, while
 * the task's `external_key` is the finding identity (repo/pr or
 * repo/date) — not a Jira key. The jira triage family treats
 * `external_key` as the Jira key, so it would query Jira with
 * `merge-violation:my-repo:123` and find nothing. This preflight reads
 * the linked key from the metadata and never fabricates a link from the
 * `external_key`; a tracked task without a usable `metadata.jira_key` is
 * reported as such (a named skip reason), not as an unrelated error.
 *
 * Task selection: the shared memory client's
 * `getActiveTasks({includeUnattributed: true})` — one fully paginated
 * `status` query per active status (`in_progress`, `pr_open`,
 * `pr_changes`), read from the global per-status listing and filtered
 * client-side to rows attributed to the run's instance or truly
 * unassigned. The plain `getTasks()` listing caps at the newest 50 tasks
 * of all statuses, which can hide an older active quality task behind
 * done ones; the status-scoped scan selects it however deep it sits.
 * Done and paused tasks are not selected by those queries at all —
 * respected by construction, their issues are never fetched.
 *
 * Unattributed legacy rows (no `instance_id` — the original quality
 * workflow's tasks) are admitted under the user-approved constraint:
 * their `external_key` must match a quality prefix AND name, in its
 * deterministic `${prefix}:${repo}:${suffix}` form, a repository that is
 * exactly configured in the instance's project-repos map with a
 * resolvable upstream; a populated `task.repo` must agree with that key.
 * Rows naming other instances stay excluded no matter what they carry,
 * an empty-string `instance_id` is not "unassigned", a missing or empty
 * repo map selects nothing (no broadening), and a malformed key cannot
 * name a repo at all. Ownership of an unattributed row is ambiguous —
 * the configured-repo match is the proxy that keeps this instance from
 * acting on another instance's work. Instance-attributed quality tasks
 * keep the original selection (prefix only), so they are selected even
 * when the repo map is missing.
 *
 * Schedule: the quality instance is historically KEDA-restricted to
 * Mon–Fri 09:00–23:00 Europe/Prague, and feedback follows the same
 * window — checked first, before any fetch, through the shared DST-aware
 * schedule helper.
 *
 * Fail policy (the jira family's, not the scan family's FetchTracker
 * tolerance): any memory or Jira fetch failure is an execution `error` —
 * for a feedback check, tolerating a failed fetch would silently skip
 * the very feedback this preflight exists to surface.
 */

/**
 * The quality instance's active window: Mon–Fri 09:00–23:00
 * Europe/Prague (the historical KEDA schedule of the whole instance).
 * Start inclusive, end exclusive, DST-aware through the shared helper.
 */
const ACTIVE_WINDOW: LocalScheduleWindow = {
  days: [0, 1, 2, 3, 4],
  startHour: 9,
  endHour: 23,
  timeZone: "Europe/Prague",
};

const OUT_OF_WINDOW_CONTENT =
  "Outside the quality instance active window (Mon-Fri 09:00-23:00 Europe/Prague)";

export const HCC_QUALITY_JIRA_FEEDBACK_INPUT = z.strictObject({
  /**
   * External-key prefixes of the quality workflow's per-finding tasks
   * (`merge-violation:{repo}:{pr}`, `test-scan:{repo}:{date}`). A task
   * counts as tracked when its key starts with `${prefix}:` — the colon
   * keeps the `${prefix}-${date}` daily scan-marker tasks out: those are
   * pacing gates, not work, and carry no Jira link.
   */
  task_prefixes: z
    .array(z.string().refine(nonBlank, { message: "task prefix must not be blank" }))
    .min(1)
    .default(["merge-violation", "test-scan"]),
});

export type HccQualityJiraFeedbackParams = z.infer<typeof HCC_QUALITY_JIRA_FEEDBACK_INPUT>;

/** Dependencies of the feedback flow, injectable for tests. */
export interface HccQualityJiraFeedbackDeps {
  readonly memory: MemoryServerClient;
  readonly jira: JiraClient;
  /** Per-run shared state; `has_actionable` accumulates like jira-triage's. */
  readonly state?: PreflightRunState;
  /** Injectable clock so tests can fix the weekday and the hour. */
  readonly now?: () => Date;
  /**
   * The instance's project-repos map (`ctx.repos`): the ownership gate
   * for unattributed legacy tasks. An unattributed task is only
   * selected when its key names a key of this map with a resolvable
   * upstream; an absent map (or an empty one) selects no unattributed
   * task — fail closed, never a broadening. Instance-attributed tasks
   * are selected without it, as before.
   */
  readonly repos?: ProjectReposMap;
}

/**
 * Fields requested for a tracked task's Jira issue — what `fmtJira`
 * renders (status, labels, issue links) plus summary context. Comments
 * come from the paginated comment endpoint; the client merges them into
 * `fields.comment.comments` and filters a requested `comment` field out
 * of the issue GET.
 */
const FEEDBACK_ISSUE_FIELDS: readonly string[] = [
  "summary",
  "status",
  "labels",
  "issuelinks",
  "updated",
];

/**
 * The structured bot-comment markers of the jira triage family — the
 * same three as `jira-common/triage.ts` (`### `, `| `, `PR:`), which
 * keeps its predicate module-private. Duplicated here on purpose; if
 * the shared set ever changes, this must follow.
 */
const STRUCTURED_BOT_MARKERS: readonly string[] = ["### ", "| ", "PR:"];

function hasStructuredBotMarkers(body: string): boolean {
  return STRUCTURED_BOT_MARKERS.some((marker) => body.includes(marker));
}

/**
 * A Jira comment author's display name — the package's existing Jira
 * author normalization (`shared/format.ts` `authorOf`,
 * `jira-common/candidates.ts`): the REST author record's `displayName`,
 * `"?"` when absent or not a record, a plain string passed through.
 */
function jiraCommentAuthorName(comment: JiraComment): string {
  const author = comment.author;
  if (isRecord(author)) return String(author.displayName ?? "?");
  return author === undefined ? "?" : String(author);
}

/**
 * True when a comment counts as new human feedback: newer than
 * `lastAddressed`, without the structured bot markers, and not authored
 * by an obvious bot account.
 *
 * This is the jira triage family's detection (`hasNewJiraFeedback` in
 * `jira-common/triage.ts`: time window plus marker absence — it does
 * not look at authors at all) with one addition directed by review: the
 * gh-pr-status author normalization (`isBotAuthor` on the display name)
 * also excludes obvious machine accounts, which the marker filter alone
 * would misread as human feedback. It is a heuristic, not robust human
 * filtering: bot accounts with human-looking persona names — the
 * instance's own Jira user among them — are indistinguishable from
 * humans by these signals, so a marker-less comment from such an
 * account still counts as feedback (pinned by tests). Correctness also
 * rests on the agent stamping `last_addressed` when it addresses
 * feedback.
 */
export function isHumanFeedbackTrigger(comment: JiraComment, lastAddressed: string): boolean {
  return (
    isNewer(comment.created ?? "", lastAddressed) &&
    !hasStructuredBotMarkers(comment.body ?? "") &&
    !isBotAuthor(jiraCommentAuthorName(comment))
  );
}

/** A tracked quality task with new feedback, ready to render. */
interface QualityFeedbackEntry {
  readonly task: MemoryTask;
  /** The Jira issue key read from `metadata.jira_key`. */
  readonly jiraKey: string;
  readonly jira: JiraIssue;
  /** The bounded prompt selection of the issue's comments. */
  readonly jiraComments: readonly JiraComment[];
}

/** True when a task's `external_key` starts with `${prefix}:` for any prefix. */
function isTrackedQualityTask(task: MemoryTask, prefixes: readonly string[]): boolean {
  const key = task.external_key;
  if (typeof key !== "string") return false;
  return prefixes.some((prefix) => key.startsWith(`${prefix}:`));
}

/**
 * True when the row carries no instance attribution at all (null or
 * undefined `instance_id`). Everything else in the
 * `includeUnattributed` fetch result is attributed to the configured
 * instance by the client's filter — rows naming other instances and
 * empty-string attributions never reach this flow.
 */
function isUnattributedTask(task: MemoryTask): boolean {
  const instanceId = task.instance_id;
  return instanceId === null || instanceId === undefined;
}

/**
 * The repository segment of a deterministic per-finding key
 * `${prefix}:${repo}:${suffix}` — exactly three non-empty
 * colon-separated parts, the repo being the second. Null for anything
 * else: a malformed key names no repo, so an unattributed task carrying
 * it cannot be attributed to a configured repository and is not
 * selected.
 */
function externalKeyRepo(key: string): string | null {
  const parts = key.split(":");
  if (parts.length !== 3) return null;
  if (parts[0] === "" || parts[1] === "" || parts[2] === "") return null;
  return parts[1];
}

/**
 * True when `repo` is a configured repository of this instance: an
 * exact own key of the project-repos map whose entry is a resolvable
 * repo (a non-blank `upstream` — the same resolvability the scans gate
 * on, so a repo the scans would never touch never admits a task).
 * Metadata keys the real map carries besides repositories — `_config`
 * and friends, entries without an upstream — never count, and an absent
 * or empty map counts nowhere: no broadening.
 */
function isConfiguredRepo(repos: ProjectReposMap, repo: string): boolean {
  if (!Object.hasOwn(repos, repo)) return false;
  const upstream = repos[repo]?.upstream;
  return typeof upstream === "string" && upstream.trim() !== "";
}

/**
 * Selection of one active task. Instance-attributed rows keep the
 * original rule — a quality prefix, nothing more (the instance-scoped
 * half of the fetch already vouched for them, and they stay selected
 * even without a repo map). Unattributed legacy rows must
 * additionally name a configured repository in their deterministic key
 * and, when the row's `repo` field is populated, agree with it; a wrong
 * repo, an unconfigured repo, a malformed key, or a missing repo map
 * all mean the task is not this instance's work.
 */
function isSelectedQualityTask(
  task: MemoryTask,
  prefixes: readonly string[],
  repos: ProjectReposMap,
): boolean {
  if (!isTrackedQualityTask(task, prefixes)) return false;
  if (!isUnattributedTask(task)) return true;
  const key = task.external_key;
  if (typeof key !== "string") return false;
  const repo = externalKeyRepo(key);
  if (repo === null || !isConfiguredRepo(repos, repo)) return false;
  const taskRepo = task.repo;
  if (taskRepo !== undefined && taskRepo !== null && taskRepo !== "" && taskRepo !== repo) {
    return false;
  }
  return true;
}

/**
 * The Jira issue key of a tracked task: `metadata.jira_key` when it is a
 * non-blank string, else null. Null is a data condition the caller
 * reports by name — never an error, and never repaired by substituting
 * the `external_key` (that is not a Jira key for these tasks).
 */
function trackedTaskJiraKey(task: MemoryTask): string | null {
  const key = taskMetadata(task).jira_key;
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  return trimmed === "" ? null : trimmed;
}

/** `has_actionable` accumulates across the preflights of one run. */
function setActionable(state: PreflightRunState | undefined, actionable: boolean): void {
  if (state === undefined) return;
  const previous = state.get("has_actionable");
  state.set("has_actionable", previous === true || actionable);
}

/**
 * The feedback flow: window gate, tracked-task selection, per-task Jira
 * fetch and feedback classification, then `start` with the existing
 * task's identity or `skip` with the per-task summary.
 */
export async function runHccQualityJiraFeedback(
  deps: HccQualityJiraFeedbackDeps,
  params: HccQualityJiraFeedbackParams,
): Promise<PreflightExecutionResult> {
  const now = deps.now?.() ?? new Date();

  // The instance's historical active window — checked before any fetch,
  // so off-hours cycles cost nothing.
  if (!isWithinLocalWindow(now, ACTIVE_WINDOW)) {
    return { status: "skip", content: OUT_OF_WINDOW_CONTENT };
  }

  // Active tasks of the run's instance plus — the user-approved legacy
  // pickup — truly unattributed rows, read from the global per-status
  // listing and attribution-filtered client-side by the memory client.
  // Every returned task is one of the three active statuses, so done and
  // paused tasks are respected by construction (never returned, never
  // fetched). The repo-map constraint on the unattributed half is
  // applied below; without it an unattributed row is never selected.
  const tasks = await deps.memory.getActiveTasks({ includeUnattributed: true });
  const tracked = tasks.filter((task) =>
    isSelectedQualityTask(task, params.task_prefixes, deps.repos ?? {}),
  );

  const feedback: QualityFeedbackEntry[] = [];
  const clean: string[] = [];
  const unlinked: string[] = [];

  for (const task of tracked) {
    const jiraKey = trackedTaskJiraKey(task);
    if (jiraKey === null) {
      // Missing/invalid link metadata is a named condition on the task,
      // not an execution error and not a fabricated link.
      unlinked.push(
        `${task.external_key ?? "?"} (metadata.jira_key missing or not a nonblank string)`,
      );
      continue;
    }
    // Any fetch failure propagates: a Jira outage must surface as an
    // error, never as a silent "no feedback" skip.
    const jira = await deps.jira.getIssueWithComments(jiraKey, { fields: FEEDBACK_ISSUE_FIELDS });
    const comments = issueComments(jira);
    const lastAddressed = task.last_addressed ?? "";
    const isTrigger = (comment: JiraComment): boolean =>
      isHumanFeedbackTrigger(comment, lastAddressed);
    // Without last_addressed nothing can be "new" — the jira triage
    // family's semantics, kept here.
    if (lastAddressed !== "" && comments.some(isTrigger)) {
      feedback.push({
        task,
        jiraKey,
        jira,
        jiraComments: selectPromptComments(comments, lastAddressed, isTrigger),
      });
    } else {
      clean.push(`${task.external_key ?? "?"} → ${jiraKey}`);
    }
  }

  if (feedback.length === 0) {
    setActionable(deps.state, false);
    return { status: "skip", content: skipSummary(tracked, clean, unlinked, params.task_prefixes) };
  }

  const lines: string[] = [
    `# Quality Task Jira Feedback (${feedback.length})`,
    "",
    "New human Jira feedback on existing tracked quality tasks. These tasks",
    "are already tracked — handle the existing task (task_get by Task ID,",
    "task_update to stamp last_addressed once the feedback is addressed) and",
    "answer on the Jira issue named by the Jira key. Do not create a new",
    "task for this feedback, and handle it before starting new scans.",
    "",
    "high:",
  ];
  for (const entry of feedback) {
    lines.push(`  - ${entry.task.external_key ?? "?"} → Jira ${entry.jiraKey}`);
  }
  lines.push("", `### JIRA FEEDBACK (${feedback.length})`, "");
  for (const entry of feedback) {
    lines.push(`- Task ID: ${entry.task.external_key ?? "?"}`);
    lines.push(`- Jira key: ${entry.jiraKey}`);
    lines.push("");
    lines.push(fmtJira(entry.task, entry.jira, entry.jiraComments));
    lines.push("");
  }

  setActionable(deps.state, true);
  return { status: "start", content: lines.join("\n") };
}

/** The skip content: what was checked and why nothing started. */
function skipSummary(
  tracked: readonly MemoryTask[],
  clean: readonly string[],
  unlinked: readonly string[],
  prefixes: readonly string[],
): string {
  const prefixList = prefixes.map((prefix) => `${prefix}:`).join(", ");
  const lines = [
    tracked.length === 0
      ? `No active quality tasks (prefixes: ${prefixList})`
      : `No new human Jira feedback on ${tracked.length} active quality task(s) (prefixes: ${prefixList})`,
  ];
  for (const item of clean) {
    lines.push(`  clean: ${item}`);
  }
  for (const item of unlinked) {
    lines.push(
      `  no jira_key: ${item} — Jira link not fabricated, store metadata.jira_key via task_update`,
    );
  }
  // Done and paused tasks are not listed here by design: the
  // status-scoped active-task fetch never returns them, so there is
  // nothing to report beyond their absence from the active set.
  return lines.join("\n");
}

/**
 * The registered preflight: the run context's Jira client and
 * memory-server client wired into the flow; any failure — including an
 * unwired Jira client — surfaces as an `error` result, never a silent
 * skip.
 */
export const hccQualityJiraFeedback = definePreflight({
  id: "hcc-quality-jira-feedback",
  input: HCC_QUALITY_JIRA_FEEDBACK_INPUT,
  run: (ctx: PreflightRunContext, params) =>
    runRegisteredQualityJiraFeedback(ctx, params).catch(executionErrorResult),
});

async function runRegisteredQualityJiraFeedback(
  ctx: PreflightRunContext,
  params: HccQualityJiraFeedbackParams,
): Promise<PreflightExecutionResult> {
  if (ctx.jira === undefined) {
    return { status: "error", content: JIRA_CLIENT_NOT_WIRED };
  }
  return runHccQualityJiraFeedback(
    { memory: ctx.memory, jira: ctx.jira, state: ctx.state, repos: ctx.repos },
    params,
  );
}
