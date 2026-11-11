import { createHash } from "node:crypto";
import { discoverAgentProfiles } from "./agent-profiles.js";
import type { AgentProfile } from "./agent-profiles.js";
import { parseConfigRepositories, syncConfigRepositories } from "./config-repositories.js";
import type { SessionCompletion, SessionDispatcher } from "./dispatch-sessions.js";
import { runWorkPreflight, type WorkPreflightResult } from "./work-preflight.js";
import { preparePreflightRuntime } from "./preflight-runtime.js";
import { mergeProfileEnvironment } from "./runtime-environment.js";
export type DispatcherCycleDependencies = {
  parseRepositories: typeof parseConfigRepositories;
  syncRepositories: typeof syncConfigRepositories;
  discoverProfiles: typeof discoverAgentProfiles;
  preflight: typeof runWorkPreflight;
  prepareRuntime: typeof preparePreflightRuntime;
};

export type DispatcherCycleOptions = {
  repositoriesJson: string;
  cacheRoot: string;
  /** Complete caller-supplied environment, or a per-profile environment resolver. */
  env: NodeJS.ProcessEnv | ((profile: AgentProfile) => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>);
  dispatcher: SessionDispatcher;
  launch: (profile: AgentProfile, prompt: string, decision: Extract<WorkPreflightResult, { action: "start" }>) => Promise<SessionCompletion>;
  /**
   * Mints the short-lived memory credential forwarded to preflight scripts as
   * BOT_MEMORY_TOKEN. Called once per cycle; a minting failure fails every
   * profile in the cycle rather than silently dropping authentication.
   */
  memoryCredential?: () => Promise<string>;
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

// Per-agent check cooldowns. Sessions and preflights run per agent; each
// agent's private runtime state (preparePreflightRuntime) means one agent's
// preflight never blocks another's.
const lastChecks = new WeakMap<SessionDispatcher, Map<string, number>>();
const intervalMs = 5 * 60_000;

/** Stable, opaque ID; length-safe encoding avoids repository/profile collisions. */
function agentId(repositoryUrl: string, profileName: string): string {
  return createHash("sha256").update(JSON.stringify([repositoryUrl, profileName])).digest("hex");
}

/**
 * Execute one dispatcher cycle. Only statuses and opaque IDs leave this function;
 * script output, prompts, paths, environment and exception details do not.
 * Session completion is deliberately not awaited. As with SessionDispatcher,
 * reservations are process-local and unknown outcomes stay reserved.
 */
export async function runDispatcherCycle(options: DispatcherCycleOptions): Promise<DispatcherCycleResult> {
  const deps: DispatcherCycleDependencies = {
    parseRepositories: parseConfigRepositories,
    syncRepositories: syncConfigRepositories,
    discoverProfiles: discoverAgentProfiles,
    preflight: runWorkPreflight,
    prepareRuntime: preparePreflightRuntime,
    ...options.dependencies,
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
          // The instance environment cannot override the minted credential:
          // secret-named BOT_ variables are rejected during discovery.
          const env = mergeProfileEnvironment({ ...inherited, ...(memoryToken === undefined ? {} : { BOT_MEMORY_TOKEN: memoryToken }) }, profile.preflightEnv);
          const runtime = await deps.prepareRuntime(profile);
          let decision;
          try {
            decision = await deps.preflight({
              botRoot: runtime.botRoot,
              workflow: profile.workflow,
              instanceDir: profile.instanceDir,
              // Scripts and their imports must resolve inside the private
              // runtime, never the synced checkout.
              preflightDirs: runtime.preflightDirs,
              env,
              signal: options.signal,
            });
          } finally {
            await runtime.dispose();
          }
          if (options.signal?.aborted) return "shutdown" as const;
          const dispatched = options.dispatcher.dispatch(id, decision, (prompt) => {
            if (decision.action !== "start") return "not-created";
            return options.launch(profile, prompt, decision);
          });
          if (dispatched.status === "started") {
            // Defensive even if a future dispatcher implementation rejects completion.
            void dispatched.completion.catch(() => {});
          }
          return dispatched.status;
        })();
        profileResults.push({ agentId: id, status });
      } catch {
        profileResults.push({ agentId: id, status: "error" });
      }
    }
  }
  return { status: "complete", repositories: results };
}
