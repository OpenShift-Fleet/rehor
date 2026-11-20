/**
 * Jenkins client for the watchduty preflights — the TypeScript port of the
 * `triage-jenkins` skill's data-fetching layer.
 *
 * The two corporate CSB Jenkins instances are read without credentials (the
 * Python layer fetched with plain urllib and `CERT_NONE` for the self-signed
 * corporate CA), so the default transport is `node:https` with certificate
 * verification disabled. Transport failures never throw: they accumulate in
 * `errors` (URL + reason) and the affected fetch resolves `null`, exactly
 * like the Python layer — the preflight decides what an unreachable
 * instance means (skip, partial data, or error).
 */
import { get as httpsGet } from "node:https";

/** One Jenkins instance: base URL plus the job-path prefix. */
export interface JenkinsInstance {
  readonly url: string;
  readonly prefix: string;
}

export interface JenkinsInstances {
  readonly qe: JenkinsInstance;
  readonly idp: JenkinsInstance;
}

/**
 * Injectable transport for fixture-based tests: returns the response body,
 * or `null` on any failure (the client records the URL itself).
 */
export type JenkinsRequest = (url: string, timeoutMs: number) => Promise<string | null>;

export interface JenkinsClientConfig {
  /**
   * Instances to query. Required: production wiring supplies these through
   * rendered deployment configuration (secret rendering), never through
   * engine constants — use {@link STUB_JENKINS_INSTANCES} for local
   * development only.
   */
  readonly instances: JenkinsInstances;
  /** Job names served by the `idp` instance; every other job uses `qe`. */
  readonly idpJobs?: readonly string[];
  /** Injectable transport; defaults to `node:https` with TLS verification off. */
  readonly request?: JenkinsRequest;
  /** JSON fetch timeout in milliseconds; defaults to 10 s. */
  readonly timeoutMs?: number;
  /** Console-log fetch timeout in milliseconds; defaults to 15 s. */
  readonly textTimeoutMs?: number;
}

export interface JenkinsBuild {
  readonly number: number;
  readonly result: string | null;
  readonly timestamp?: number;
  readonly duration?: number;
}

export interface JenkinsJob {
  readonly name: string;
  readonly color?: string;
  readonly instance: "qe" | "idp";
  readonly builds: readonly JenkinsBuild[];
  readonly lastBuild?: { readonly number?: number };
  readonly lastFailedBuild?: { readonly number?: number };
}

export interface JenkinsStage {
  readonly name: string;
  readonly status: string;
  readonly duration_s: number;
}

export interface JenkinsFailureSummary {
  readonly failed_tests: readonly string[];
  readonly counts: string | null;
}

export interface JenkinsBuildDetail {
  readonly build: number;
  readonly stages: readonly JenkinsStage[];
  readonly failure_summary?: JenkinsFailureSummary;
  readonly log_tail?: string;
}

export interface JenkinsJobsReport {
  readonly jobs: readonly JenkinsJob[];
  readonly errors?: readonly string[];
}

export interface JenkinsClient {
  /** Configured instances — report links and diagnostics use their URLs. */
  readonly instances: JenkinsInstances;
  /**
   * Every job on every configured instance with its last `nBuilds` builds.
   * `null` when no instance answered — the Python "both instances
   * unreachable" case.
   */
  getAllJobs(nBuilds?: number): Promise<JenkinsJobsReport | null>;
  /** One job's build history, or `null` when the fetch failed. */
  getJobBuilds(job: string, nBuilds?: number): Promise<JenkinsJob | null>;
  /** Stage list plus parsed failure summary (or log tail) for one build. */
  getBuildDetail(job: string, buildNum: number): Promise<JenkinsBuildDetail>;
  /** Which instance serves a job name (`idp` for the configured set). */
  instanceForJob(job: string): "qe" | "idp";
  /** Accumulated transport failures: `url request_failed` / `url json_error`. */
  readonly errors: readonly string[];
}

/**
 * Stub endpoints for local development and fixture wiring only — the
 * `.invalid` TLD guarantees they can never reach a real host. Production
 * wiring renders the real instance URLs from deployment configuration.
 */
export const STUB_JENKINS_INSTANCES: JenkinsInstances = {
  qe: { url: "https://jenkins-qe.example.invalid", prefix: "/job/ccx" },
  idp: { url: "https://jenkins-idp.example.invalid", prefix: "" },
};

const DEFAULT_IDP_JOBS: readonly string[] = [
  "internal-pipeline-tests-prod",
  "internal-pipeline-tests-stage",
  "internal-pipeline-test-rules-version-prod",
  "internal-pipeline-test-rules-version-stage",
  "ccx-load-test-stage",
];

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TEXT_TIMEOUT_MS = 15_000;

/**
 * Default transport: HTTPS GET with certificate verification disabled —
 * the corporate CSB Jenkins serves a self-signed certificate and the Python
 * layer connected with `CERT_NONE`. Only configured instance URLs are ever
 * requested; the disabled verification never applies to any other client.
 */
function insecureGet(url: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const request = httpsGet(
      url,
      { timeout: timeoutMs, rejectUnauthorized: false },
      (response) => {
        if (response.statusCode !== undefined && (response.statusCode < 200 || response.statusCode >= 300)) {
          response.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => resolve(null));
  });
}

/** Untyped wire records: Jenkins answers are normalized defensively. */
type Wire = Record<string, unknown>;

function wireJobs(value: Wire | null): Wire[] {
  if (value === null) return [];
  return Array.isArray(value.jobs) ? value.jobs.filter((job): job is Wire => typeof job === "object" && job !== null) : [];
}

function wireBuilds(job: Wire): Wire[] {
  return Array.isArray(job.builds)
    ? job.builds.filter((build): build is Wire => typeof build === "object" && build !== null)
    : [];
}

function normalizeBuild(build: Wire): JenkinsBuild {
  return {
    number: typeof build.number === "number" ? build.number : -1,
    result: typeof build.result === "string" ? build.result : null,
    ...(typeof build.timestamp === "number" ? { timestamp: build.timestamp } : {}),
    ...(typeof build.duration === "number" ? { duration: build.duration } : {}),
  };
}

function normalizeNumberRef(value: unknown): { readonly number?: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const number = (value as Wire).number;
  return typeof number === "number" ? { number } : undefined;
}

function normalizeJob(job: Wire, instance: "qe" | "idp"): JenkinsJob {
  return {
    name: typeof job.name === "string" ? job.name : "",
    ...(typeof job.color === "string" ? { color: job.color } : {}),
    instance,
    builds: wireBuilds(job).map(normalizeBuild),
    lastBuild: normalizeNumberRef(job.lastBuild),
    lastFailedBuild: normalizeNumberRef(job.lastFailedBuild),
  };
}

export function createJenkinsClient(config: JenkinsClientConfig): JenkinsClient {
  if (config.instances === undefined || typeof config.instances !== "object") {
    throw new Error("jenkins client requires configured instances (rendered deployment config)");
  }
  const instances = config.instances;
  const idpJobs = new Set(config.idpJobs ?? DEFAULT_IDP_JOBS);
  const request = config.request ?? insecureGet;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const textTimeoutMs = config.textTimeoutMs ?? DEFAULT_TEXT_TIMEOUT_MS;
  const errors: string[] = [];

  function base(instance: "qe" | "idp"): string {
    const conf = instances[instance];
    return `${conf.url}${conf.prefix}`;
  }

  function jobUrl(instance: "qe" | "idp", job: string): string {
    return `${base(instance)}/job/${job}`;
  }

  function instanceOf(job: string): "qe" | "idp" {
    return idpJobs.has(job) ? "idp" : "qe";
  }

  async function fetchJson<T extends Wire>(url: string, timeout: number): Promise<T | null> {
    const body = await request(url, timeout);
    if (body === null) {
      errors.push(`${url} request_failed`);
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed !== "object" || parsed === null) {
        errors.push(`${url} json_error`);
        return null;
      }
      return parsed as T;
    } catch {
      errors.push(`${url} json_error`);
      return null;
    }
  }

  function buildsTree(nBuilds: number): string {
    const fields = "number,result,timestamp,duration";
    return `jobs[name,color,lastBuild[number],lastFailedBuild[number],builds[${fields}]{0,${nBuilds}}]`;
  }

  function jobTree(nBuilds: number): string {
    const fields = "number,result,timestamp,duration";
    return `name,color,lastBuild[number],lastFailedBuild[number],builds[${fields}]{0,${nBuilds}}]`;
  }

  return {
    instances,
    errors,
    instanceForJob: instanceOf,
    async getAllJobs(nBuilds = 7) {
      const allJobs: JenkinsJob[] = [];
      for (const instance of ["qe", "idp"] as const) {
        const data = await fetchJson<Wire>(
          `${base(instance)}/api/json?tree=${encodeURIComponent(buildsTree(nBuilds))}`,
          timeoutMs,
        );
        for (const job of wireJobs(data)) {
          allJobs.push(normalizeJob(job, instance));
        }
      }
      return allJobs.length > 0 ? { jobs: allJobs } : null;
    },
    async getJobBuilds(job, nBuilds = 7) {
      const instance = instanceOf(job);
      const data = await fetchJson<Wire>(
        `${jobUrl(instance, job)}/api/json?tree=${encodeURIComponent(jobTree(nBuilds))}`,
        timeoutMs,
      );
      if (data === null) return null;
      return normalizeJob(data, instance);
    },
    async getBuildDetail(job, buildNum) {
      const instance = instanceOf(job);
      const url = jobUrl(instance, job);
      const stages: JenkinsStage[] = [];

      const stagesData = await fetchJson<Wire>(`${url}/${buildNum}/wfapi/describe`, timeoutMs);
      if (stagesData !== null && Array.isArray(stagesData.stages)) {
        for (const stage of stagesData.stages) {
          if (typeof stage !== "object" || stage === null) continue;
          const wireStage = stage as Wire;
          stages.push({
            name: typeof wireStage.name === "string" ? wireStage.name : "",
            status: typeof wireStage.status === "string" ? wireStage.status : "",
            duration_s:
              typeof wireStage.durationMillis === "number"
                ? Math.round(wireStage.durationMillis / 1000)
                : 0,
          });
        }
      }

      let failureSummary: JenkinsFailureSummary | undefined;
      let logTail: string | undefined;
      const log = await request(`${url}/${buildNum}/consoleText`, textTimeoutMs);
      if (log === null) {
        errors.push(`${url}/${buildNum}/consoleText request_failed`);
      } else if (log !== "") {
        const failedTests: string[] = [];
        let counts: string | null = null;
        let inSummary = false;
        for (const line of log.split("\n")) {
          if (line.includes("short test summary info")) {
            inSummary = true;
            continue;
          }
          if (inSummary) {
            if (line.startsWith("=") && (line.includes("passed") || line.includes("failed"))) {
              counts = line.trim().replace(/^=+/, "").replace(/=+$/, "").trim();
              break;
            }
            if (line.startsWith("FAILED ")) failedTests.push(line.trim());
          }
        }
        if (failedTests.length > 0 || counts !== null) {
          failureSummary = { failed_tests: failedTests, counts };
        } else {
          logTail = log.trim().split("\n").slice(-50).join("\n");
        }
      }
      return {
        build: buildNum,
        stages,
        ...(failureSummary === undefined ? {} : { failure_summary: failureSummary }),
        ...(logTail === undefined ? {} : { log_tail: logTail }),
      };
    },
  };
}

/** Structural check used by the run-context wiring. */
export function isJenkinsClient(value: unknown): value is JenkinsClient {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.getAllJobs === "function" &&
    typeof candidate.getJobBuilds === "function" &&
    typeof candidate.getBuildDetail === "function"
  );
}
