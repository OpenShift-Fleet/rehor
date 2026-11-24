import type { GhPrData } from "../../shared/github.js";
import { isNewer } from "../../shared/time.js";

/**
 * PR classification — the port of the Python `classify_gh`. Pure: takes the
 * PR data (already normalized to the `gh pr view --json` shape by the
 * GitHub client) and the task's `last_addressed`, returns the state and the
 * issue strings the bucket classification reads.
 *
 * Reviews submitted before `last_addressed` are ignored — the bot already
 * handled them in a prior cycle.
 */

/** Result of classifying one PR. */
export interface GhClassification {
  /** PR state: `OPEN`, `MERGED`, `CLOSED`, … (never missing — `UNKNOWN`). */
  readonly state: string;
  /**
   * Issue strings: `merged`, `closed`, `conflict`,
   * `ci_fail:<names>`, `konflux_urls:<urls>`, `review:<author>`,
   * `review_comment:<author>`.
   */
  readonly issues: readonly string[];
}

export function classifyGh(pr: GhPrData, lastAddressed = ""): GhClassification {
  const state = pr.state ?? "UNKNOWN";
  if (state === "MERGED") {
    return { state, issues: ["merged"] };
  }
  if (state === "CLOSED") {
    return { state, issues: ["closed"] };
  }
  const issues: string[] = [];
  if (pr.mergeable === "CONFLICTING") {
    issues.push("conflict");
  }
  const checks = pr.statusCheckRollup ?? [];
  const failedChecks = checks.filter((check) => check.conclusion === "FAILURE");
  if (failedChecks.length > 0) {
    issues.push(`ci_fail:${failedChecks.map((check) => check.name ?? "?").join(",")}`);
    const konfluxUrls = failedChecks
      .map((check) => check.detailsUrl ?? "")
      .filter((detailsUrl) => detailsUrl.includes("pipelinerun"));
    if (konfluxUrls.length > 0) {
      issues.push(`konflux_urls:${konfluxUrls.join(";")}`);
    }
  }
  for (const review of pr.reviews ?? []) {
    const reviewState = review.state ?? "";
    const submitted = review.submittedAt ?? "";
    if (lastAddressed !== "" && submitted !== "" && !isNewer(submitted, lastAddressed)) {
      continue;
    }
    const author = review.author?.login ?? "?";
    if (reviewState === "CHANGES_REQUESTED") {
      issues.push(`review:${author}`);
    } else if (reviewState === "COMMENTED" && (review.body ?? "").trim().length > 20) {
      issues.push(`review_comment:${author}`);
    }
  }
  return { state, issues };
}
