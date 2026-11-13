import { createHash } from "node:crypto";
import { discoverAgentProfiles } from "./agent-profiles.js";
import type { AgentProfile } from "./agent-profiles.js";
import { parseConfigRepositories, syncConfigRepositories } from "./config-repositories.js";
import type { SessionCompletion, SessionDispatcher } from "./dispatch-sessions.js";
import { createLifecycleLogger, isolateLifecycleLogger, profileLogValue, repositoryLogValue, type LifecycleLogger } from "./logging.js";
import { isPreflightDiagnostic, PreflightConfigurationError, type PreflightDiagnostic } from "./preflight-diagnostics.js";
import { loadInstanceRepos, runTsPreflight, validateRequiredPreflightWiring } from "./preflight-engine-ts.js";
import type { PreflightWiringField, TsPreflightWiring, WorkPreflightResult } from "./preflight-engine-ts.js";
import { mergeProfileEnvironment } from "./runtime-environment.js";
export type DispatcherCycleDependencies = {
  parseRepositories: typeof parseConfigRepositories;
  syncRepositories: typeof syncConfigRepositories;
  discoverProfiles: typeof discoverAgentProfiles;
  preflight: typeof runTsPreflight;
};

export type DispatcherCycleOptions = {
  repositoriesJson: string;
  cacheRoot: string;
  /** Complete caller-supplied environment, or a per-profile environment resolver. */
  env: NodeJS.ProcessEnv | ((profile: AgentProfile) => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>);
  dispatcher: SessionDispatcher;
  /** Sandbox launch for a start decision; agentId identifies the session mutex. */
  launch: (profile: AgentProfile, agentId: string, prompt: string, decision: Extract<WorkPreflightResult, { action: "start" }>) => Promise<SessionCompletion>;
  /**
   * Mints the short-lived memory credential the preflight engine uses for
   * memory-server task fetches. Called once per cycle; a minting failure
   * fails every profile in the cycle rather than silently dropping
   * authentication.
   */
  memoryCredential?: () => Promise<string>;
  /**
   * Services-gateway base URL: the proxy route whose /jira, /github, and
   * /gitlab path prefixes carry external-system preflight traffic. Absent
   * wiring surfaces as an execution error inside the preflights that need
   * it, never a silent skip.
   */
  serviceGatewayUrl?: URL;
  /**
   * Lifecycle logger for per-profile preflight error reporting; defaults to
   * the process stdout lifecycle logger. Injected for tests.
   */
  logger?: LifecycleLogger;
  dependencies?: Partial<DispatcherCycleDependencies>;
  /** Monotonic milliseconds; injectable for tests. */
  now?: () => number;
  signal?: AbortSignal;
};

export type CycleProfileStatus = {
  agentId: string;
  status: "started" | "busy" | "shutdown" | "skip" | "error" | "no-scripts" | "throttled";
};

export type DispatcherCycleResult =
  | { status: "invalid-config"; repositories: [] }
  | { status: "complete"; repositories: Array<
      | { index: number; status: "sync-error" | "discovery-error" }
      | { index: number; status: "processed"; profiles: CycleProfileStatus[] }
    > };

// Per-agent check cooldowns. Preflight runs are per agent and in-process
// (the TS engine), so one agent's preflight never blocks another's.
const lastChecks = new WeakMap<SessionDispatcher, Map<string, number>>();
const intervalMs = 5 * 60_000;

/** Best-effort per-profile preflight error log; isolated from logger failures. */
const defaultLogger = isolateLifecycleLogger(createLifecycleLogger());

/** Stable, opaque ID; length-safe encoding avoids repository/profile collisions. */
function agentId(repositoryUrl: string, profileName: string): string {
  return createHash("sha256").update(JSON.stringify([repositoryUrl, profileName])).digest("hex");
}

/** Diagnostics that satisfy the logging contract; malformed items are
 * dropped rather than rejecting the record's identity fields. */
function safeDiagnostics(value: unknown): PreflightDiagnostic[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const diagnostics = value.filter(isPreflightDiagnostic);
  return diagnostics.length > 0 ? diagnostics : undefined;
}

/** Engine skip/error results may carry structured configuration
 * diagnostics; read the optional property defensively and keep only
 * well-formed diagnostic objects. */
function decisionDiagnostics(decision: WorkPreflightResult): PreflightDiagnostic[] | undefined {
  if (decision.action !== "skip" && decision.action !== "error") return undefined;
  if (!("diagnostics" in decision)) return undefined;
  return safeDiagnostics(decision.diagnostics);
}

/**
 * Execute one dispatcher cycle. Only statuses and opaque IDs leave this function;
 * preflight output, prompts, paths, environment and exception details do not.
 * Session completion is deliberately not awaited. As with SessionDispatcher,
 * reservations are process-local and unknown outcomes stay reserved.
 */
export async function runDispatcherCycle(options: DispatcherCycleOptions): Promise<DispatcherCycleResult> {
  const deps: DispatcherCycleDependencies = {
    parseRepositories: parseConfigRepositories,
    syncRepositories: syncConfigRepositories,
    discoverProfiles: discoverAgentProfiles,
    preflight: runTsPreflight,
    ...options.dependencies,
  };
  const logger = options.logger ? isolateLifecycleLogger(options.logger) : defaultLogger;
  // A preflight error must identify its owner: fixed identifiers only (the
  // human-meaningful profile name and config repository, plus the opaque
  // agentId for correlation with cycle results). Transcripts never enter
  // logs; configuration diagnostics carry structured declaration-literal
  // detail, and per-entry records name the preflight id only.
  type PreflightErrorDetails = {
    reason: "configuration" | "execution";
    configurationField?: PreflightWiringField;
    diagnostics?: readonly PreflightDiagnostic[];
    preflightId?: string;
  };
  const logPreflightError = (profile: string, repository: string, agentId: string, details: PreflightErrorDetails): void => {
    const safeProfile = profileLogValue(profile);
    const safeRepository = repositoryLogValue(repository);
    logger.log("preflight.error", "failure", {
      reason: details.reason,
      ...(safeProfile !== undefined ? { profile: safeProfile } : {}),
      ...(safeRepository !== undefined ? { repository: safeRepository } : {}),
      agentId,
      ...(details.configurationField !== undefined ? { configurationField: details.configurationField } : {}),
      ...(details.diagnostics !== undefined ? { diagnostics: details.diagnostics } : {}),
      ...(details.preflightId !== undefined ? { preflightId: details.preflightId } : {}),
    });
  };
  // Mint once per cycle so every profile shares one short-lived credential.
  // null marks a minting failure: fail every profile rather than run unauthenticated.
  let memoryToken: string | null | undefined;
  try {
    memoryToken = options.memoryCredential ? await options.memoryCredential() : undefined;
  } catch {
    memoryToken = null;
  }
  let repositories;
  try {
    repositories = deps.parseRepositories(options.repositoriesJson);
  } catch {
    return { status: "invalid-config", repositories: [] };
  }

  const results: Extract<DispatcherCycleResult, { status: "complete" }>["repositories"] = [];
  for (const [index, repository] of repositories.entries()) {
    if (options.signal?.aborted) break;
    let checkout;
    try {
      [checkout] = await deps.syncRepositories(options.cacheRoot, [repository], options.signal);
      if (!checkout) throw new Error("Missing checkout");
    } catch {
      results.push({ index, status: "sync-error" });
      continue;
    }
    let profiles;
    try {
      profiles = await deps.discoverProfiles(checkout.path);
    } catch (error) {
      // A typed preflight-configuration failure carries the profile and the
      // structured issues: log the safe identity and diagnostics before the
      // fail-closed discovery-error result. Unknown errors are never logged.
      if (error instanceof PreflightConfigurationError) {
        const diagnostics = safeDiagnostics(error.diagnostics);
        logPreflightError(error.profile, repository.url, agentId(repository.url, error.profile), {
          reason: "configuration",
          ...(diagnostics !== undefined ? { diagnostics } : {}),
        });
      }
      results.push({ index, status: "discovery-error" });
      continue;
    }
    const profileResults: CycleProfileStatus[] = [];
    results.push({ index, status: "processed", profiles: profileResults });
    for (const profile of profiles) {
      if (options.signal?.aborted) break;
      const id = agentId(repository.url, profile.name);
      try {
        const status = await (async () => {
          if (options.signal?.aborted) return "shutdown" as const;
          const inherited = typeof options.env === "function" ? await options.env(profile) : options.env;
          const env = mergeProfileEnvironment(inherited, profile.preflightEnv);
          const required = validateRequiredPreflightWiring(env.BOT_INSTANCE_ID, env.BOT_MEMORY_URL, memoryToken);
          if (!required.ok) {
            logPreflightError(profile.name, repository.url, id, {
              reason: memoryToken === null && required.field === "memory credential" ? "execution" : "configuration",
              configurationField: required.field,
            });
            return "error" as const;
          }
          if (options.dispatcher.isInFlight(id)) return "busy" as const;
          if (options.signal?.aborted) return "shutdown" as const;
          let checks = lastChecks.get(options.dispatcher);
          if (!checks) {
            checks = new Map();
            lastChecks.set(options.dispatcher, checks);
          }
          const now = (options.now ?? (() => performance.now()))();
          if (!Number.isFinite(now)) throw new Error("Invalid monotonic clock");
          const last = checks.get(id);
          if (last !== undefined && now - last < intervalMs) return "throttled" as const;
          checks.set(id, now);
          const repos = await loadInstanceRepos(profile.instanceDir);
          const wiring: TsPreflightWiring = {
            ...required.wiring,
            ...(options.serviceGatewayUrl ? { proxyBaseUrl: options.serviceGatewayUrl.href } : {}),
            ...(repos !== undefined ? { repos } : {}),
          };
          const decision = await deps.preflight({ profile, wiring, signal: options.signal, repositoryUrl: repository.url });
          // Errored entries are logged independently of the aggregate
          // decision — start, skip, or all-error — with the preflight id
          // only; entry content never enters the record.
          const failedEntries = decision.scripts.filter((script) => script.status === "error");
          for (const script of failedEntries) {
            logPreflightError(profile.name, repository.url, id, { reason: "execution", preflightId: script.name });
          }
          // The aggregate record covers configuration failures (structured
          // diagnostics, once) and error decisions with no entry records;
          // an all-error execution decision is fully described by its
          // per-entry records.
          if (decision.action === "error" && (decision.reason === "configuration" || failedEntries.length === 0)) {
            const diagnostics = decisionDiagnostics(decision);
            logPreflightError(profile.name, repository.url, id, {
              reason: decision.reason ?? "execution",
              ...(diagnostics !== undefined ? { diagnostics } : {}),
            });
          }
          if (options.signal?.aborted) return "shutdown" as const;
          const dispatched = options.dispatcher.dispatch(id, decision, (prompt) => {
            if (decision.action !== "start") return "not-created";
            return options.launch(profile, id, prompt, decision);
          });
          if (dispatched.status === "started") {
            // Defensive even if a future dispatcher implementation rejects completion.
            void dispatched.completion.catch(() => {});
          }
          return dispatched.status;
        })();
        profileResults.push({ agentId: id, status });
      } catch {
        // A thrown preflight or per-profile wiring failure: log the owner
        // identity with the same fixed fields, never the exception detail.
        logPreflightError(profile.name, repository.url, id, { reason: "execution" });
        profileResults.push({ agentId: id, status: "error" });
      }
    }
  }
  return { status: "complete", repositories: results };
}
