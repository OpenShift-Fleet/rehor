import { createHash } from "node:crypto";
import { discoverAgentProfiles } from "./agent-profiles.js";
import type { AgentProfile } from "./agent-profiles.js";
import { parseConfigRepositories, syncConfigRepositories } from "./config-repositories.js";
import type { SessionCompletion, SessionDispatcher } from "./dispatch-sessions.js";
import { createLifecycleLogger, isolateLifecycleLogger, type LifecycleLogger } from "./logging.js";
import { loadInstanceRepos, runTsPreflight } from "./preflight-engine-ts.js";
import type { TsPreflightWiring, WorkPreflightResult } from "./preflight-engine-ts.js";
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
  /** Sandbox launch for a start decision; agentId is the opaque per-agent
   * identity the caller may use to key the session mutex lock (REHOR-218). */
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
  // agentId for correlation with cycle results). Transcripts never enter logs.
  const logPreflightError = (profile: string, repository: string, agentId: string, reason: "configuration" | "execution" = "execution"): void => {
    logger.log("preflight.error", "failure", {
      reason,
      profile,
      repository,
      agentId,
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
    } catch {
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
          // Credential minting failure fails the profile rather than running
          // unauthenticated requests that could masquerade as empty results.
          if (memoryToken === null) return "error" as const;
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
          const inherited = typeof options.env === "function" ? await options.env(profile) : options.env;
          const env = mergeProfileEnvironment(inherited, profile.preflightEnv);
          // The TS engine executes the reviewed @rehor/preflights package
          // in-process against the declarative instance.yaml configuration —
          // no scripts are materialized from the synced checkout. Memory
          // wiring reuses the per-cycle minted credential; the instance
          // identity and memory route come from the per-profile environment
          // exactly as the removed Python scripts read them.
          const repos = await loadInstanceRepos(profile.instanceDir);
          const wiring: TsPreflightWiring = {
            instanceId: env.BOT_INSTANCE_ID ?? "",
            memory: { baseUrl: env.BOT_MEMORY_URL ?? "", token: memoryToken ?? "" },
            ...(options.serviceGatewayUrl ? { proxyBaseUrl: options.serviceGatewayUrl.href } : {}),
            ...(repos !== undefined ? { repos } : {}),
          };
          const decision = await deps.preflight({ profile, wiring, signal: options.signal, repositoryUrl: repository.url });
          if (decision.action === "error") {
            logPreflightError(profile.name, repository.url, id, decision.reason);
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
        logPreflightError(profile.name, repository.url, id, "execution");
        profileResults.push({ agentId: id, status: "error" });
      }
    }
  }
  return { status: "complete", repositories: results };
}
