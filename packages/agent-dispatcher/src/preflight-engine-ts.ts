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
import { preflightConfigurationDiagnostics, type PreflightDiagnostic } from "./preflight-diagnostics.js";
import { createPreflightTransport, PreflightDeadlineError } from "./preflight-transport.js";

/**
 * A start carries the agent prompt; skip/error carry a transcript. Per-entry
 * results carry ids, statuses, and content for the cycle report.
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
  | { action: "skip" | "error"; transcript: string; scripts: WorkPreflightScriptResult[]; reason?: "configuration" | "execution"; diagnostics?: PreflightDiagnostic[] };

/**
 * The dispatcher runs reviewed `@rehor/preflights` implementations against
 * declarative configuration from the config repository.
 *
 * Aggregation: any `start` among non-errored entries → start, all `skip` → skip, all
 * `error` → error; errored entries are excluded from the decision so one
 * broken integration cannot block work another preflight found.
 * The prompt is assembled from `start` results only — skip/error
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
  /** Per-entry execution budget; defaults to 120 seconds. */
  entryTimeoutMs?: number;
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

export type PreflightWiringField = "BOT_INSTANCE_ID" | "BOT_MEMORY_URL" | "memory credential";

/** Validate without including configuration values in diagnostics. */
export function validateRequiredPreflightWiring(instanceId: unknown, baseUrl: unknown, token: unknown):
  | { ok: true; wiring: Pick<TsPreflightWiring, "instanceId" | "memory"> }
  | { ok: false; field: PreflightWiringField; message: string } {
  if (typeof instanceId !== "string" || !instanceId.trim()) return { ok: false, field: "BOT_INSTANCE_ID", message: missingInstanceId };
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return { ok: false, field: "BOT_MEMORY_URL", message: missingMemoryUrl };
  if (typeof token !== "string" || !token.trim()) return { ok: false, field: "memory credential", message: missingMemoryToken };
  return { ok: true, wiring: { instanceId, memory: { baseUrl, token } } };
}

/**
 * Run the TS preflight engine for one profile. Never throws for
 * configuration or execution problems — every failure is an `error`
 * `WorkPreflightResult` whose transcript is prefixed with the instance
 * identity (profile name, plus the config repository when supplied).
 */
export async function runTsPreflight(options: TsPreflightOptions): Promise<WorkPreflightResult> {
  const registry = options.registry ?? populatedRegistry;
  const profile = options.profile;
  const identity = options.repositoryUrl ? `${profile.name} (${options.repositoryUrl})` : profile.name;
  const failure = (transcript: string, reason: "configuration" | "execution"): Extract<WorkPreflightResult, { transcript: string }> =>
    ({ action: "error", transcript: `${identity}: ${transcript}`, scripts: [], reason });

  const wiring = validateRequiredPreflightWiring(options.wiring?.instanceId, options.wiring?.memory?.baseUrl, options.wiring?.memory?.token);
  if (!wiring.ok) return failure(wiring.message, "configuration");

  // Entry resolution: an explicit `preflights:` list replaces the default
  // set; an omitted field inherits the workflow's central default. Neither
  // present is a configuration error; an explicit empty list is a deliberate
  // "no preflights" declaration.
  const declared: readonly unknown[] | undefined = profile.preflights ?? workflowDefaults[profile.workflow];
  if (declared === undefined) {
    const message = noPreflightsMessage(profile.workflow);
    return {
      ...failure(message, "configuration"),
      diagnostics: [{ path: "preflights", code: "missing_preflights", message, received: "undefined" }],
    };
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
    return { ...failure(transcript, "configuration"), diagnostics: preflightConfigurationDiagnostics(declared, registry) };
  }

  const entryTimeoutMs = options.entryTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(entryTimeoutMs) || entryTimeoutMs <= 0 || entryTimeoutMs > 2_147_483_647) {
    return failure("Preflight entry timeout must be a positive bounded integer", "configuration");
  }

  // One run context per invocation, shared by all entries: task/capacity
  // fetches happen once per run and per-run bookkeeping state accumulates.
  const proxy = options.wiring.proxyBaseUrl;
  let context;
  let transport;
  try {
    transport = createPreflightTransport({
      memoryBaseUrl: wiring.wiring.memory.baseUrl,
      token: wiring.wiring.memory.token,
      ...(proxy !== undefined ? { proxyBaseUrl: proxy } : {}),
    });
    context = createPreflightRunContext({
      instanceId: wiring.wiring.instanceId,
      memory: { ...wiring.wiring.memory, fetch: transport.memoryFetch },
      ...(proxy ? { jira: { baseUrl: proxy, fetch: transport.gatewayFetch }, proxy: { baseUrl: proxy, fetch: transport.gatewayFetch } } : {}),
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
      outcome = await transport.runEntry(() => preflight.run(context, entry.params), options.signal, entryTimeoutMs);
    } catch (error) {
      // A thrown preflight is an execution error of that entry only; the
      // exception detail (URLs, upstream messages) never enters the result.
      outcome = { status: "error", content: error instanceof PreflightDeadlineError
        ? `${entry.id} timed out after ${entryTimeoutMs}ms`
        : `${entry.id} failed to execute` };
    }
    results.push({ name: entry.id, status: outcome.status, content: outcome.content });
  }
  if (options.signal?.aborted) {
    return { action: "error", transcript: `${identity}: Preflight cancelled`, scripts: results, reason: "execution" };
  }

  // Aggregation:
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
