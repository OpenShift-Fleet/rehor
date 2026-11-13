import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPreflightRunContext,
  validateConfig,
  workflowDefaults,
  type PreflightExecutionResult,
  type PreflightRegistry,
  type PreflightRunContextOptions,
} from "@rehor/preflights";
import { createPopulatedRegistry } from "@rehor/preflights/preflights";
import type { AgentProfile } from "./agent-profiles.js";

/**
 * The work-preflight result contract (REHOR-259), kept shape-identical to the
 * removed Python runner's protocol so the decision flows into
 * `buildInputEnvelope` and the dispatcher cycle unchanged: a start carries
 * the agent prompt, a skip/error carries a transcript, and the per-entry
 * script results carry ids, statuses, and content for the cycle report.
 * Error results additionally carry a `reason`: `configuration` failures
 * (invalid `preflights:`, missing wiring) never heal by retrying, while
 * `execution` failures (network, upstream API) may.
 */
export type WorkPreflightScriptResult = {
  name: string;
  status: "start" | "skip" | "error";
  content: string;
};

export type WorkPreflightResult =
  | { action: "no-scripts"; scripts: [] }
  | { action: "start"; prompt: string; scripts: WorkPreflightScriptResult[] }
  | { action: "skip" | "error"; transcript: string; scripts: WorkPreflightScriptResult[]; reason?: "configuration" | "execution" };

/**
 * TS preflight execution engine (REHOR-259) — the dispatcher's only preflight
 * path. Preflight logic comes from the reviewed `@rehor/preflights` workspace
 * package instead of Python scripts executed out of synced config
 * repositories: the config repository supplies declarative `preflights:`
 * data, never executed code, removing that arbitrary-code-execution surface.
 *
 * Aggregation keeps the semantics of the removed Python multi-script runner:
 * any `start` among non-errored entries → start, all `skip` → skip, all
 * `error` → error; errored entries are excluded from the decision so one
 * broken integration cannot block work another preflight found. One
 * deliberate difference from the Python protocol (the settled spike
 * decision): the prompt is assembled from `start` results only — skip/error
 * content stays in the per-entry script results for the cycle report and
 * never enters the agent prompt.
 */

/**
 * The instance project-repos map the run context accepts. The package keeps
 * `ProjectReposMap` internal (not part of its public exports); this is its
 * structural equivalent, derived from the exported run-context options.
 */
export type ProjectReposMap = NonNullable<PreflightRunContextOptions["repos"]>;
type ProjectRepoEntry = ProjectReposMap[string];

/** Dispatcher-side wiring the engine needs per run. */
export type TsPreflightWiring = {
  /** Instance identity for memory-server task filtering (BOT_INSTANCE_ID). */
  instanceId: string;
  /** Memory-server route and the per-cycle minted bearer token. */
  memory: { baseUrl: string; token: string };
  /**
   * Services-gateway base URL: the single authenticated route whose
   * `/jira`, `/github`, and `/gitlab` path prefixes carry external-system
   * preflight traffic (credential injection happens on the upstream leg).
   * Absent wiring surfaces as an execution error inside the preflights that
   * need it — never a silent skip, never an invented URL.
   */
  proxyBaseUrl?: string;
  /** Instance project-repos.json map when present; absent means no resolution. */
  repos?: ProjectReposMap;
};

export type TsPreflightOptions = {
  /** The agent profile; carries the declared `preflights:` and the workflow. */
  profile: AgentProfile;
  wiring: TsPreflightWiring;
  /**
   * Config-repository URL of the checkout the profile was discovered in.
   * Threaded in by the cycle so error results name their owner:
   * `<profile name> (<repository url>)`. Fixed identifier only — the URL is
   * credential-free by config validation.
   */
  repositoryUrl?: string;
  /** Injectable for tests; defaults to the populated registry. */
  registry?: PreflightRegistry;
  signal?: AbortSignal;
};

/**
 * The reviewed registry every run defaults to: all preflight implementations
 * registered centrally in `@rehor/preflights`. Constructed once at module
 * load — the package ships in the same image, so there is nothing to defer.
 */
const populatedRegistry: PreflightRegistry = createPopulatedRegistry();

/** Stable fail-closed messages; no URLs, tokens, or exception detail beyond
 * the fixed instance/repository identifiers threaded in by the caller. */
const noPreflightsMessage = (workflow: string): string =>
  `No preflights configured: the profile declares no preflights and workflow "${workflow}" has no registered default set`;
const missingInstanceId = "Preflight engine requires an instance identity (BOT_INSTANCE_ID)";
const missingMemoryUrl = "Preflight engine requires BOT_MEMORY_URL";
const missingMemoryToken = "Preflight engine requires a minted memory credential";

/**
 * Run the TS preflight engine for one profile. Never throws for
 * configuration or execution problems — every failure is an `error`
 * `WorkPreflightResult` whose transcript is prefixed with the instance
 * identity (profile name, plus the config repository when the caller
 * supplied one), surfaced to the agent owner through cycle reporting and
 * lifecycle logs.
 */
export async function runTsPreflight(options: TsPreflightOptions): Promise<WorkPreflightResult> {
  const registry = options.registry ?? populatedRegistry;
  const profile = options.profile;
  const identity = options.repositoryUrl ? `${profile.name} (${options.repositoryUrl})` : profile.name;
  const failure = (transcript: string, reason: "configuration" | "execution"): WorkPreflightResult =>
    ({ action: "error", transcript: `${identity}: ${transcript}`, scripts: [], reason });

  // Entry resolution: an explicit `preflights:` list replaces the default
  // set; an omitted field inherits the workflow's central default. Neither
  // present is a configuration error — the engine itself is the scripts, so
  // "nothing to run" is never a valid silent state (an explicit empty list
  // remains a deliberate "no preflights" declaration). Agents relying on the
  // removed Python path without a `preflights:` field fail loudly here until
  // their config repositories declare preflights (REHOR-232 tracks the
  // fleet).
  const declared: readonly unknown[] | undefined = profile.preflights ?? workflowDefaults[profile.workflow];
  if (declared === undefined) {
    return failure(noPreflightsMessage(profile.workflow), "configuration");
  }
  if (declared.length === 0) {
    return { action: "no-scripts", scripts: [] };
  }

  // Fail-closed configuration validation before anything executes: no entry
  // runs unless every entry validates, and the stable per-entry messages are
  // the owner-facing feedback.
  const validation = validateConfig(declared, registry);
  if (!validation.ok) {
    const transcript = validation.invalid.map((entry) => entry.messages.join("\n")).join("\n");
    return failure(transcript, "configuration");
  }

  // Wiring checks: the memory-server route, the minted credential, and the
  // instance identity are dispatcher-owned. Missing values are errors with
  // stable messages, never unauthenticated or unfiltered requests.
  if (!options.wiring.instanceId?.trim()) {
    return failure(missingInstanceId, "configuration");
  }
  if (!options.wiring.memory?.baseUrl?.trim()) {
    return failure(missingMemoryUrl, "configuration");
  }
  if (!options.wiring.memory.token) {
    return failure(missingMemoryToken, "configuration");
  }

  // One run context per invocation, shared by all entries: task/capacity
  // fetches happen once per run and per-run bookkeeping state (the state-file
  // replacement) accumulates across entries.
  const proxy = options.wiring.proxyBaseUrl;
  let context;
  try {
    context = createPreflightRunContext({
      instanceId: options.wiring.instanceId,
      memory: { baseUrl: options.wiring.memory.baseUrl, token: options.wiring.memory.token },
      ...(proxy ? { jira: { baseUrl: proxy }, proxy } : {}),
      ...(options.wiring.repos ? { repos: options.wiring.repos } : {}),
    });
  } catch {
    return failure("Preflight run context could not be created", "configuration");
  }

  const results: WorkPreflightScriptResult[] = [];
  for (const entry of validation.entries) {
    if (options.signal?.aborted) break;
    const preflight = registry.get(entry.id);
    if (preflight === undefined) {
      return failure(`${entry.id}: unknown preflight id`, "configuration");
    }
    let outcome: PreflightExecutionResult;
    try {
      outcome = await preflight.run(context, entry.params);
    } catch {
      // A thrown preflight is an execution error of that entry only; the
      // exception detail (URLs, upstream messages) never enters the result.
      outcome = { status: "error", content: `${entry.id} failed to execute` };
    }
    results.push({ name: entry.id, status: outcome.status, content: outcome.content });
  }
  if (options.signal?.aborted) {
    return { action: "error", transcript: `${identity}: Preflight cancelled`, scripts: results, reason: "execution" };
  }

  // Aggregation, mirroring the removed Python multi-script semantics:
  // errored entries are excluded from the decision so one broken integration
  // cannot block work another preflight found; all-errored is an error.
  const ok = results.filter((result) => result.status !== "error");
  if (!ok.length) {
    const transcript = results.map((result) => result.content).filter(Boolean).join("\n\n");
    return { action: "error", transcript: `${identity}: ${transcript}`, scripts: results, reason: "execution" };
  }
  if (ok.some((result) => result.status === "start")) {
    // The prompt carries start content only; skip and error content stays in
    // the per-entry script results for the cycle report.
    const prompt = ok.filter((result) => result.status === "start").map((result) => result.content).filter(Boolean).join("\n\n");
    return { action: "start", prompt, scripts: results };
  }
  const summary = results
    .filter((result) => result.status === "error")
    .map((error) => `[PREFLIGHT ERROR] ${error.name}: ${Array.from(error.content).slice(0, 200).join("")}`)
    .join("\n");
  const content = ok.map((result) => result.content).filter(Boolean).join("\n\n");
  const combined = summary ? (content ? `${summary}\n\n${content}` : summary) : content;
  return { action: "skip", transcript: combined, scripts: results };
}

/**
 * Load the instance `project-repos.json` map. Absent → undefined (omit the
 * wiring); unreadable → throws (a cycle error, like a failed repository
 * sync); present but unparseable or not an object → `{}`, the same
 * degrade-to-empty semantics as the package's own loader.
 */
export async function loadInstanceRepos(instanceDir: string): Promise<ProjectReposMap | undefined> {
  let text: string;
  try {
    text = await readFile(join(instanceDir, "project-repos.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseInstanceRepos(text);
}

function parseInstanceRepos(text: string): ProjectReposMap {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  const repos: Record<string, ProjectRepoEntry> = {};
  for (const [key, value] of Object.entries(data)) {
    // Own data property, immune to the `__proto__` setter trap: a key named
    // `__proto__` in the JSON stays plain data, exactly like the package's
    // own parser.
    Object.defineProperty(repos, key, {
      value: typeof value === "object" && value !== null && !Array.isArray(value) ? value : {},
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return repos;
}
