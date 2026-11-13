import { isPreflightHttpError } from "./http.js";

/**
 * Shared fetch-failure policy for the status preflights (gh-pr-status,
 * gl-mr-status) and the onboarding merge check — the operational reading of
 * the spike constraint that "an unavailable route is a preflight execution
 * error, never a silent skip" (docs/preflight-rework-spike-input.md).
 *
 * ## The policy
 *
 * External items — a task's PRs/MRs, and the comments/notes of the PRs/MRs
 * that were fetched — are checked one by one. Every *attempted* fetch is
 * tallied as succeeded or failed, per class (item fetches separately from
 * comment fetches):
 *
 * - **Isolated failure — tolerated with evidence.** A fetch that fails
 *   while other fetches of the same class succeed is treated as
 *   item-specific: a deleted or mis-referenced PR/MR, a repository the
 *   credential cannot see, one throttled request. The item is skipped, the
 *   failure is recorded, and the successfully fetched work proceeds — a
 *   broken reference must not block actionable work found elsewhere.
 *
 * - **Total failure — execution error naming the route.** When every
 *   attempted fetch of a class failed (attempted > 0, succeeded === 0), the
 *   shared transport cannot be treated as healthy: auth rejection (401/403),
 *   rate limiting (429), upstream failure (5xx), network and timeout
 *   failures (no HTTP status), and a 404-only run (the required route not
 *   served by the proxy) all escalate to an `error` result naming the
 *   required route. When nothing was attempted at all — no PR/MR exists to
 *   fetch — there is no failure and the normal skip applies.
 *
 * ## The auth distinction
 *
 * A 401/403 on *some* items while others succeed is item/repo-scoped (the
 * credential works at the integration level — e.g. a fine-grained token
 * without that one repository); it stays a tolerated isolated failure. A
 * 401/403 with zero successes is an integration auth problem and is never
 * "healthy". The same zero-success rule covers 429/5xx/network/timeout
 * outages and the retained all-404 route escalation.
 *
 * ## Evidence discipline
 *
 * Failure reasons are derived only from the HTTP status or the transport
 * classification plus the item label — never from error messages or
 * response bodies, which may carry upstream detail or credentials.
 */

/** One failed fetch, as evidence: which item, and a safe reason. */
export interface FetchFailure {
  /** Item label, e.g. `org/repo#123` or `team/repo!42`. */
  readonly item: string;
  /** Credential-free reason, e.g. `HTTP 404` or `network or timeout failure`. */
  readonly reason: string;
}

/**
 * Tally of the fetch attempts of one class (PR/MR details, or their
 * comments/notes). Recorded while a run enriches its tasks; evaluated
 * afterwards. A fetch that positively established an item is missing (the
 * API answered, the item does not exist) counts as succeeded — the route
 * is healthy; only requests that could not be completed are failures.
 */
export class FetchTracker {
  private attemptCount = 0;
  private successCount = 0;
  private readonly failureList: FetchFailure[] = [];

  /** Fetches attempted — items that existed and were reached for. */
  get attempted(): number {
    return this.attemptCount;
  }

  /** Fetches that completed (a confirmed-missing item included). */
  get succeeded(): number {
    return this.successCount;
  }

  /** Recorded failures, in attempt order. */
  get failures(): readonly FetchFailure[] {
    return this.failureList;
  }

  recordSuccess(): void {
    this.attemptCount += 1;
    this.successCount += 1;
  }

  recordFailure(item: string, error: unknown): void {
    this.attemptCount += 1;
    this.failureList.push({ item, reason: describeFetchFailure(error) });
  }
}

/**
 * Short, credential-free reason for a fetch failure: the HTTP status, the
 * transport classification, or a generic client error. Never the error
 * message or body.
 */
export function describeFetchFailure(error: unknown): string {
  if (isPreflightHttpError(error)) {
    if (error.status === null) {
      return "network or timeout failure";
    }
    return `HTTP ${error.status}`;
  }
  return "client error";
}

/** How {@link totalFetchFailureError} names the fetch class and its route. */
export interface RouteFailureOptions {
  /** System name for messages, e.g. `GitHub` or `GitLab`. */
  readonly system: string;
  /** Fetch class, e.g. `PR`, `MR`, `PR comment`, or `MR note`. */
  readonly noun: string;
  /** The required route (proxy base URL + path prefix) that was unusable. */
  readonly route: string;
}

/**
 * The total-failure escalation: an `Error` naming the required route when
 * fetches were attempted but none succeeded — a shared transport, auth,
 * rate-limit, or route outage is an execution error, never a silent skip.
 * Null when nothing was attempted or at least one fetch succeeded.
 */
export function totalFetchFailureError(
  tracker: FetchTracker,
  options: RouteFailureOptions,
): Error | null {
  if (tracker.attempted === 0 || tracker.succeeded > 0) {
    return null;
  }
  const fetchWord = tracker.attempted === 1 ? "fetch" : "fetches";
  const reasons = tracker.failures
    .map((failure) => `${failure.item}: ${failure.reason}`)
    .join("; ");
  return new Error(
    `${options.system} route ${options.route} is not usable: ` +
      `${tracker.attempted} ${options.noun} ${fetchWord} attempted, 0 succeeded (${reasons})`,
  );
}

/**
 * Evidence lines for tolerated (isolated) failures, one per line, e.g.
 * `  PR org/repo#9: HTTP 403`. Empty when nothing failed.
 */
export function failureEvidenceLines(tracker: FetchTracker, noun: string): readonly string[] {
  return tracker.failures.map((failure) => `  ${noun} ${failure.item}: ${failure.reason}`);
}
