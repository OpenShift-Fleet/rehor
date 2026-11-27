import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPreflightRunContext,
  validateConfig,
  validateResolvedParams,
  workflowDefaults,
  type JenkinsInstances,
  type PreflightExecutionResult,
  type PreflightRegistry,
  type PreflightRunContextOptions,
  type SlackWebhookConfig,
} from "@rehor/preflights";
import { createPopulatedRegistry } from "@rehor/preflights/preflights";
import type { AgentProfile } from "./agent-profiles.js";
import { preflightConfigurationDiagnostics, type PreflightDiagnostic } from "./preflight-diagnostics.js";
import { createPreflightTransport, PreflightDeadlineError } from "./preflight-transport.js";
import {
  containsSecretTemplate,
  renderSecretTemplates,
  SecretRenderError,
  type SecretReader,
  type SecretValueLedger,
} from "./secret-rendering.js";

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
  /**
   * Writable directory for persistent cross-run preflight state (throttle
   * timestamps, weekly markers), one JSON file per instance. Absent wiring
   * leaves self-throttling preflights unwired — they fail closed with an
   * execution error rather than re-running throttled work every cycle.
   */
  stateDir?: string;
  /**
   * Slack webhook channels, secret-rendered deployment configuration.
   * Values are credentials: they flow only into the run-context Slack
   * client and never into logs or preflight results. Absent wiring
   * degrades preflight Slack reports — never an error.
   */
  slackWebhooks?: SlackWebhookConfig;
  /**
   * Deployment-provided bot Jira identity (BOT_JIRA_EMAIL): the default
   * for the `email` input of jira preflights whose entries declare none.
   * A non-secret identity — the Jira gateway injects authentication on
   * the upstream leg, unchanged by this wiring. It flows only into the
   * run context, never into logs or results; absent wiring leaves those
   * preflights on unassigned-only candidate search.
   */
  jiraEmail?: string;
  /**
   * The profile's approved non-secret settings (`preflightEnv`), passed
   * through as one unit — never the merged environment, never process.env.
   * Absent wiring means the profile declares no settings.
   */
  instanceEnv?: Readonly<Record<string, string>>;
  /**
   * Jenkins instance endpoints (and optional idp job-name overrides),
   * rendered deployment configuration. The corporate Jenkins hosts need
   * no credentials; absent wiring leaves the watchduty preflights
   * unwired — they fail closed with an execution error.
   */
  jenkins?: { instances: JenkinsInstances; idpJobs?: readonly string[] };
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
  /**
   * Tier-2 Kubernetes Secret reader for `with:` parameters carrying
   * `${{ secret('name','key') }}` references. Read freshly per entry,
   * immediately before that entry executes — never cached across entries,
   * cycles, or the process lifetime. Entries without references never touch
   * it; a referencing entry without a reader fails closed.
   */
  readSecret?: SecretReader;
  /**
   * Private per-dispatch ledger recording the values rendered for preflight
   * entries; the launch path compares sandbox-bound values against it to
   * detect rotation between the preflight reads and sandbox creation. Holds
   * rendered values in dispatcher memory only — it never enters results,
   * logs, diagnostics, or the sandbox envelope.
   */
  secretLedger?: SecretValueLedger;
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
  // A secret-rendering or post-render-validation failure must prevent the
  // whole dispatch even when earlier entries already executed: their results
  // stay in the cycle report, but the aggregate decision is an error. The
  // optional scripts argument carries those accumulated results plus the
  // failing entry's stable message.
  const failure = (transcript: string, reason: "configuration" | "execution", scripts: WorkPreflightScriptResult[] = []): Extract<WorkPreflightResult, { transcript: string }> =>
    ({ action: "error", transcript: `${identity}: ${transcript}`, scripts, reason });

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
  // runs — and no Secret is read — unless every entry validates, and the
  // stable per-entry messages are the owner-facing feedback. Entries whose
  // `with:` values carry secret placeholders (deep detection, matching the
  // renderer) never have their input schema invoked on the declaration: the
  // schema runs exactly once, on the rendered map, so transforms and
  // refinements never observe declaration literals. Phase one still fails
  // closed on entry shape, preflight ids, unknown and missing parameters,
  // reserved keys, and placeholders in fields that can never accept a
  // rendered string.
  const validation = validateConfig(declared, registry, { deferValue: containsSecretTemplate });
  if (!validation.ok) {
    const transcript = validation.invalid.map((entry) => entry.messages.join("\n")).join("\n");
    return { ...failure(transcript, "configuration"), diagnostics: preflightConfigurationDiagnostics(declared, registry, containsSecretTemplate) };
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
      ...(options.wiring.stateDir ? { persistentState: { dir: options.wiring.stateDir } } : {}),
      ...(options.wiring.slackWebhooks ? { slack: { webhooks: options.wiring.slackWebhooks } } : {}),
      ...(options.wiring.jiraEmail !== undefined ? { jiraEmail: options.wiring.jiraEmail } : {}),
      ...(options.wiring.instanceEnv ? { instanceEnv: options.wiring.instanceEnv } : {}),
      ...(options.wiring.jenkins
        ? {
            jenkins: {
              instances: options.wiring.jenkins.instances,
              ...(options.wiring.jenkins.idpJobs ? { idpJobs: options.wiring.jenkins.idpJobs } : {}),
            },
          }
        : {}),
    });
  } catch {
    return failure("Preflight run context could not be created", "configuration");
  }

  const results: WorkPreflightScriptResult[] = [];
  for (const [index, entry] of validation.entries.entries()) {
    if (options.signal?.aborted) break;
    const preflight = registry.get(entry.id);
    if (preflight === undefined) {
      return failure(`${entry.id}: unknown preflight id`, "configuration");
    }
    // The raw declaration literals, aligned with the validated entries: the
    // rendered map is built from them, so schema transforms and defaults run
    // exactly once — on the rendered values, in post-render validation.
    const declaration = declared[index];
    const declaredWith = typeof declaration === "string" ? {} : (declaration as { with?: Record<string, unknown> }).with ?? {};
    // Per-entry secret rendering: read the entry's referenced Secrets
    // immediately before it executes — values may rotate at any time, so
    // nothing is cached across entries, cycles, or the process lifetime, and
    // the per-entry prefetch deduplicates only within this entry.
    let params: Readonly<Record<string, unknown>> = entry.params;
    if (containsSecretTemplate(declaredWith)) {
      const renderFailure = (transcript: string, reason: "configuration" | "execution") =>
        failure(transcript, reason, [...results, { name: entry.id, status: "error" as const, content: transcript }]);
      if (options.readSecret === undefined) {
        return renderFailure("Preflight secret rendering is not configured", "configuration");
      }
      let rendered: unknown;
      try {
        // The production reader bounds every request (five-second hard
        // timeout, one parallel request per distinct Secret name), so this
        // await cannot hang; an abort during a pending read resolves here
        // and the guard below fails fast — runEntry's own throwIfAborted
        // is the backstop that keeps the script from ever executing.
        rendered = await renderSecretTemplates(declaredWith, options.readSecret, options.secretLedger === undefined ? undefined : {
          onResolved: (reference, value) => { options.secretLedger!.observe(index, reference, value); },
        });
      } catch (error) {
        // Fixed-message SecretRenderError only: rendered values, transport
        // detail, and exception text never enter the result.
        const message = error instanceof SecretRenderError ? error.message : "Preflight secret rendering failed";
        const reason = error instanceof SecretRenderError && error.failure === "transport" ? "execution" : "configuration";
        return renderFailure(message, reason);
      }
      // Abort while the reader was pending: never validate or execute the
      // entry; the cancelled result below carries the run's outcome.
      if (options.signal?.aborted) break;
      // Validate the rendered parameter map against the preflight's actual
      // schema before the entry executes; stable per-parameter messages
      // never carry the rendered values.
      const resolved = validateResolvedParams(preflight, rendered as Readonly<Record<string, unknown>>);
      if (!resolved.ok) {
        return renderFailure(resolved.messages.join("\n"), "configuration");
      }
      params = resolved.params;
    }
    let outcome: PreflightExecutionResult;
    try {
      outcome = await transport.runEntry(() => preflight.run(context, params), options.signal, entryTimeoutMs);
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
    // Rotation guard, engine side: bind the start-outcome entries' observed
    // values. Two starts that saw different values for one reference mean a
    // mixed prompt — the dispatch fails closed (execution: transient, the
    // next cycle re-reads fresh). Skip and error observations never bind:
    // their content stays out of the prompt and the input envelope carries
    // script names and statuses only, so they cannot reach the sandbox.
    if (options.secretLedger !== undefined) {
      try {
        options.secretLedger.bindStartEntries(results.flatMap((result, position) => (result.status === "start" ? [position] : [])));
      } catch (error) {
        const message = error instanceof SecretRenderError ? error.message : "Preflight secret values changed during the run";
        return failure(message, "execution", results);
      }
    }
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
