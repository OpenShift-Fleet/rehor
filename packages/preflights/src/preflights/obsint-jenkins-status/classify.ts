import { createHash } from "node:crypto";
import type { JenkinsBuildDetail, JenkinsInstances, JenkinsJob } from "../../shared/jenkins.js";

/**
 * Classification helpers of the `obsint-jenkins-status` preflight — the port
 * of the Python `01-jenkins-status.py` deterministic filter layer
 * (`classify_jobs`, `classify_pattern`, `slim_job`, and the error-signature
 * fingerprint). No AI involved: priority ordering, failure-pattern naming,
 * and signature hashing run before any session starts.
 */

/** A job excluded from analysis — the Python `skipped` entries. */
export interface SkippedJob {
  readonly name: string;
  readonly reason: string;
}

/** The `classify_jobs` result buckets. */
export interface ClassifiedJobs {
  /** Full job records whose latest build failed, priority-sorted. */
  readonly headFailing: readonly JenkinsJob[];
  /** Names of eligible jobs with older failures but a healthy head build. */
  readonly recovering: readonly string[];
  /** Names of eligible jobs without any recent failure. */
  readonly healthy: readonly string[];
  /** Excluded jobs (disabled or currently building). */
  readonly skipped: readonly SkippedJob[];
  readonly hasFailures: boolean;
}

/** Priority: prod before stage, failing before healthy (the Python ranking). */
function priorityOf(headFailing: boolean, isProd: boolean, failCount: number): number {
  if (headFailing && isProd) return 0;
  if (headFailing) return 1;
  if (failCount > 0 && isProd) return 2;
  if (failCount > 0) return 3;
  if (isProd) return 4;
  return 5;
}

/**
 * The Python `classify_jobs`: exclude disabled and building jobs, rank the
 * rest (prod before stage, failing before healthy), and split them into the
 * head-failing / recovering / healthy buckets. `null` when no jobs were
 * returned at all — the Python `None` tuple.
 */
export function classifyJobs(jobs: readonly JenkinsJob[]): ClassifiedJobs | null {
  if (jobs.length === 0) return null;

  const skipped: SkippedJob[] = [];
  const eligible: {
    readonly job: JenkinsJob;
    readonly priority: number;
    readonly failCount: number;
    readonly headFailing: boolean;
  }[] = [];

  for (const job of jobs) {
    const name = job.name;
    const color = job.color ?? "";
    if (color.includes("disabled")) {
      skipped.push({ name, reason: "disabled" });
      continue;
    }
    const builds = job.builds;
    if (builds.length > 0 && builds[0].result === null) {
      skipped.push({ name, reason: "building" });
      continue;
    }
    const recentResults = builds.slice(0, 7).map((build) => build.result);
    const failCount = recentResults.filter((result) => result === "FAILURE").length;
    const headFailing = recentResults.length > 0 && recentResults[0] === "FAILURE";
    const isProd = name.includes("prod") && !name.includes("stage");
    eligible.push({ job, priority: priorityOf(headFailing, isProd, failCount), failCount, headFailing });
  }

  // Stable sort, like Python's `sort(key=...)`.
  eligible.sort((a, b) => a.priority - b.priority);

  return {
    headFailing: eligible.filter((entry) => entry.headFailing).map((entry) => entry.job),
    recovering: eligible
      .filter((entry) => !entry.headFailing && entry.failCount > 0)
      .map((entry) => entry.job.name),
    healthy: eligible
      .filter((entry) => !entry.headFailing && entry.failCount === 0)
      .map((entry) => entry.job.name),
    skipped,
    hasFailures: eligible.some((entry) => entry.headFailing),
  };
}

/** The Python `classify_pattern` result — one named failure pattern. */
export interface FailurePattern {
  readonly pattern: string;
  readonly transitions?: number;
  readonly first_fail_build?: number | null;
  readonly consec_fails?: number;
  readonly sequence?: string;
}

function resultLetter(result: string | null): string {
  if (result === "FAILURE") return "F";
  if (result === "SUCCESS") return "S";
  return "?";
}

/**
 * The Python `classify_pattern`: name the failure pattern from the last 7
 * build results — healthy, isolated-blip, recovering, flapping (>= 3 result
 * transitions), or consecutive-fail.
 */
export function classifyPattern(job: JenkinsJob): FailurePattern {
  const builds = job.builds;
  if (builds.length === 0) {
    return { pattern: "unknown" };
  }

  const results = builds.slice(0, 7).map((build) => build.result);
  const head = results[0];

  if (results.every((result) => result === "SUCCESS")) {
    return { pattern: "healthy" };
  }

  const sequence = results.map(resultLetter).join("-");

  if (head === "SUCCESS") {
    const failCount = results.filter((result) => result === "FAILURE").length;
    if (failCount === 1) {
      return { pattern: "isolated-blip", sequence };
    }
    return { pattern: "recovering", sequence };
  }

  let consecFails = 0;
  let firstFailBuild: number | null = null;
  for (const build of builds.slice(0, 7)) {
    if (build.result === "FAILURE") {
      consecFails += 1;
      firstFailBuild = build.number;
    } else {
      break;
    }
  }

  let transitions = 0;
  for (let index = 1; index < results.length; index += 1) {
    if (results[index] !== null && results[index - 1] !== null && results[index] !== results[index - 1]) {
      transitions += 1;
    }
  }

  if (transitions >= 3) {
    return {
      pattern: "flapping",
      transitions,
      first_fail_build: firstFailBuild,
      consec_fails: consecFails,
      sequence,
    };
  }
  return {
    pattern: "consecutive-fail",
    first_fail_build: firstFailBuild,
    consec_fails: consecFails,
    sequence,
  };
}

/** The Python `_hash_content`: stable 12-char md5 prefix of a text. */
export function hashContent(text: string): string {
  return createHash("md5").update(text).digest("hex").slice(0, 12);
}

/**
 * The Python `compute_current_signature`: fingerprint the latest failed
 * build's error pattern — result plus failing stages, failed tests, counts,
 * or a log-tail digest (only without a failure summary) — hashed with
 * {@link hashContent}. Empty when the job has no builds.
 */
export function computeCurrentSignature(job: JenkinsJob, detail?: JenkinsBuildDetail): string {
  const builds = job.builds;
  if (builds.length === 0) return "";

  const latest = builds[0];
  const parts: string[] = [`result:${latest.result ?? "UNKNOWN"}`];

  if (detail !== undefined) {
    const failedStages = detail.stages
      .filter((stage) => stage.status !== "SUCCESS")
      .map((stage) => stage.name)
      .sort();
    if (failedStages.length > 0) {
      parts.push(`stages:${failedStages.join(",")}`);
    }
    const summary = detail.failure_summary;
    if (summary !== undefined) {
      const tests = [...summary.failed_tests].sort();
      if (tests.length > 0) {
        parts.push(`tests:${tests.join(",")}`);
      }
      if (summary.counts !== null && summary.counts !== "") {
        parts.push(`counts:${summary.counts}`);
      }
    }
    const logTail = detail.log_tail;
    if (logTail !== undefined && logTail !== "" && summary === undefined) {
      const tailLines = logTail
        .trim()
        .split("\n")
        .slice(-5)
        .map((line) => line.trim())
        .filter((line) => line !== "");
      parts.push(`tail:${tailLines.join("|")}`);
    }
  }

  return hashContent(parts.join("|"));
}

/**
 * The Python `slim_job`: strip a job to the fields the AI needs — name,
 * instance, pre-classified pattern, build numbers for detail fetches, and
 * the fetched detail when present. Strips the builds array, timestamps,
 * durations, and color.
 */
export function slimJob(job: JenkinsJob, detail?: JenkinsBuildDetail): Record<string, unknown> {
  const slim: Record<string, unknown> = {
    name: job.name,
    instance: job.instance,
  };
  Object.assign(slim, classifyPattern(job));

  const lastFailedNumber = job.lastFailedBuild?.number;
  if (typeof lastFailedNumber === "number" && lastFailedNumber !== 0) {
    slim.latest_fail_build = lastFailedNumber;
  }

  const failedBuilds = job.builds
    .slice(0, 7)
    .filter((build) => build.result === "FAILURE")
    .map((build) => build.number);
  if (failedBuilds.length > 0) {
    slim.failed_builds = failedBuilds;
  }

  if (detail !== undefined) {
    slim.detail = detail;
  }
  return slim;
}

/**
 * The Python `_jenkins_url`: link to the job's latest failed build. The
 * Python hardcoded its `JENKINS_URLS` constants; the port builds the same
 * `/job/<name>/<build>/` suffix on the wired instance endpoints.
 */
export function jenkinsBuildUrl(instances: JenkinsInstances, job: JenkinsJob): string {
  const instance = job.instance === "idp" ? instances.idp : instances.qe;
  const buildNumber = job.lastFailedBuild?.number;
  return `${instance.url}${instance.prefix}/job/${job.name}/${typeof buildNumber === "number" ? buildNumber : ""}/`;
}
