import { getTaskPrs } from "../../shared/format.js";
import { createGitHubClient } from "../../shared/github.js";
import { isPreflightHttpError } from "../../shared/http.js";
import type { JiraClient, JiraIssue } from "../../shared/jira.js";
import type { MemoryTask } from "../../shared/memory-server.js";
import type { ProjectReposMap } from "../../shared/repos.js";
import { upstreamRepo } from "../../shared/repos.js";
import type { ProxyWiring } from "../../shared/run-context.js";
import { isNewer } from "../../shared/time.js";
import { createGitlabClient } from "../gl-mr-status/gitlab.js";
import { isRecord, issueLabels, issueStatusName } from "../jira-common/shapes.js";

/**
 * Onboarding phase helpers — the port of the phase-advancement half of
 * `onboarding_preflight.py`: blocked detection, the onboarding step label,
 * phase sub-ticket checks, and PR/MR merge detection for the auto-advance
 * steps.
 */

export const BLOCKED_LABEL = "onboarding:blocked";

/**
 * Stable message when a merge check is needed but the run has no auth-proxy
 * route to reach GitHub/GitLab through — an execution error, never a silent
 * "not merged".
 */
export const ONBOARDING_PROXY_NOT_WIRED =
  "onboarding: PR/MR merge check requires the auth proxy route, which is not wired for this run (missing proxy base URL)";

/** Onboarding step → phase sub-ticket key in task metadata. */
const STEP_TO_PHASE: Readonly<Record<string, string>> = {
  "scaffolding-pr": "phase1",
  "konflux-mr": "phase2",
  "app-interface-mr": "phase3",
};

/** Steps whose PR/MR merge advances the onboarding phase. */
export const AUTO_ADVANCE_STEPS: readonly string[] = [
  "scaffolding-pr",
  "konflux-mr",
  "app-interface-mr",
];

/** True when the issue carries the blocked label (needs Rehor team intervention). */
export function isBlocked(issue: JiraIssue | null): boolean {
  return issue !== null && issueLabels(issue).includes(BLOCKED_LABEL);
}

/** The `onboarding:<step>` label of an issue, ignoring the blocked label. */
export function getOnboardingLabel(issue: JiraIssue | null): string | null {
  if (issue === null) return null;
  for (const label of issueLabels(issue)) {
    if (label.startsWith("onboarding:") && label !== BLOCKED_LABEL) {
      return label;
    }
  }
  return null;
}

/**
 * True when any comment is newer than `lastAddressed` — the onboarding
 * variant of feedback detection (no structured-marker filter; with no
 * last_addressed, any comment counts).
 */
export function hasNewOnboardingFeedback(
  comments: readonly Record<string, unknown>[],
  lastAddressed: string,
): boolean {
  if (comments.length === 0) return false;
  if (lastAddressed === "") return true;
  return comments.some((comment) => isNewer(comment.created || comment.t || "", lastAddressed));
}

/**
 * True when the phase sub-ticket for `step` is already Done — the merge was
 * handled in a prior cycle. The Python fetch tolerated a missing issue
 * (returned false); the REST client fails closed, so a broken phase-ticket
 * fetch surfaces as an execution error.
 */
export async function phaseTicketDone(
  task: MemoryTask,
  step: string,
  jira: JiraClient,
): Promise<boolean> {
  const phaseKey = STEP_TO_PHASE[step];
  if (phaseKey === undefined) return false;
  const metadata = isRecord(task.metadata) ? task.metadata : {};
  const phaseTickets = metadata.phase_tickets;
  const ticketKey = isRecord(phaseTickets) ? phaseTickets[phaseKey] : undefined;
  if (typeof ticketKey !== "string" || ticketKey === "") return false;
  const issue = await jira.getIssue(ticketKey, { fields: ["status"] });
  const name = issueStatusName(issue).toLowerCase();
  return name === "done" || name === "closed" || name === "resolved";
}

/** Injectable PR/MR merge check: (host, upstream org/repo, number) → merged. */
export type PrMergeCheck = (
  host: "github" | "gitlab",
  upstreamPath: string,
  number: number,
) => Promise<boolean>;

export interface OnboardingPhaseDeps {
  readonly jira: JiraClient;
  readonly repos: ProjectReposMap;
  /** Injectable merge check; defaults to the proxy-routed client check. */
  readonly isPrMerged?: PrMergeCheck;
}

/**
 * True when the PR/MR for the current phase step has been merged. The phase
 * sub-ticket is the source of truth (already Done → handled in a prior
 * cycle); only the most recent PR/MR matching the step's host is checked, to
 * avoid false positives from earlier phases' merged PRs/MRs.
 */
export async function anyPrMrMerged(
  task: MemoryTask,
  step: string,
  deps: OnboardingPhaseDeps,
): Promise<boolean> {
  if (await phaseTicketDone(task, step, deps.jira)) return false;

  const prs = getTaskPrs(task, deps.repos);
  if (prs.length === 0) return false;

  const candidates =
    step === "scaffolding-pr"
      ? prs.filter((pr) => (pr.host ?? "github") === "github")
      : prs.filter((pr) => pr.host === "gitlab");
  if (candidates.length === 0) return false;

  const target = candidates[candidates.length - 1];
  // Anything not exactly "github" takes the GitLab path, like the Python branch.
  const host = target.host === "gitlab" ? "gitlab" : "github";
  const number = target.number;
  const repo = target.repo ?? "";
  if (number === undefined || number === 0 || repo === "") return false;

  const { upstreamPath } = upstreamRepo(repo, deps.repos);
  if (upstreamPath === "") return false;

  const check = deps.isPrMerged;
  if (check === undefined) {
    // A merge check is needed but no route (and no injected check) exists —
    // an explicit error, never a silent "not merged".
    throw new Error(ONBOARDING_PROXY_NOT_WIRED);
  }
  return await check(host, upstreamPath, number);
}

/**
 * The default merge check — the package's own GitHub and GitLab clients
 * composed from the run's auth-proxy route, replacing the Python `gh`/`glab`
 * CLI subprocesses: the GitHub leg reads the GraphQL PR state (`MERGED`),
 * the GitLab leg the MR state (`merged`) through the proxy's `/gitlab` path
 * prefix — never the host directly, never PATH-resolvable CLIs or their
 * ambient credentials. Both clients keep the Python subprocess timeout
 * budget (15 s per request).
 *
 * Failure policy (spike: an unavailable route is a preflight execution
 * error, never a silent skip):
 *
 * - A 404, or a PR the API confirms missing, is advisory not-merged — the
 *   Python `try/except` parity for a deleted or mis-referenced PR/MR. The
 *   merge check is advisory (the phase sub-ticket is the source of truth),
 *   and per-item 404s are common, so one unfetchable PR must not abort the
 *   whole onboarding run. A proxy route the proxy does not serve answers
 *   404 identically to a missing item; that ambiguity is accepted here
 *   because the entirely unwired route is rejected up front (see
 *   {@link ONBOARDING_PROXY_NOT_WIRED}) and the phase sub-ticket still
 *   advances the phase when the merge check degrades.
 * - Everything else — auth rejection (401/403), rate limiting (429),
 *   upstream 5xx, network and timeout failures — propagates as an
 *   execution error: a shared outage must not masquerade as a healthy
 *   "waiting for PR/MR merge".
 */
export function createProxyPrMergeCheck(proxy: ProxyWiring): PrMergeCheck {
  const config = typeof proxy === "string" ? { baseUrl: proxy } : proxy;
  const github = createGitHubClient(config);
  const gitlab = createGitlabClient(config);
  return async (host, upstreamPath, number) => {
    try {
      if (host === "github") {
        const pr = await github.getPr(upstreamPath, number);
        return pr !== null && pr.state === "MERGED";
      }
      const mr = await gitlab.getMergeRequest(upstreamPath, number);
      return mr.state === "merged";
    } catch (error) {
      if (isPreflightHttpError(error) && error.status === 404) {
        // Per-item 404: the PR/MR itself is gone — advisory not-merged.
        return false;
      }
      // Auth, rate limit, upstream 5xx, or transport failure — a shared
      // outage, an execution error rather than a healthy "not merged".
      throw error;
    }
  };
}

/** Format an onboarding candidate — the Python `_fmt_candidate`. */
export function fmtOnboardingCandidate(issue: JiraIssue): string {
  const key = issue.key ?? "?";
  const fields = isRecord(issue.fields) ? issue.fields : {};
  const summary = fields.summary ?? "?";
  const status = isRecord(fields.status) ? String(fields.status.name ?? "?") : "?";
  const labels = Array.isArray(fields.labels) ? fields.labels.map(String).join(", ") : "";
  return `  ${key} [${status}] ${summary} (labels: ${labels})`;
}
