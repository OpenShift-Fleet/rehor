import { randomUUID } from "node:crypto";
import type { PreflightRunContext as RunContextContract } from "../core/preflight.js";
import type { FetchLike } from "./http.js";
import type { JenkinsClient, JenkinsClientConfig } from "./jenkins.js";
import { createJenkinsClient, isJenkinsClient } from "./jenkins.js";
import type { JiraClient, JiraClientConfig } from "./jira.js";
import { createJiraClient } from "./jira.js";
import type { MemoryServerClient, MemoryServerClientConfig } from "./memory-server.js";
import { createMemoryServerClient } from "./memory-server.js";
import type { ProjectReposMap } from "./repos.js";
import type { SlackClient, SlackClientConfig } from "./slack.js";
import { createSlackClient, isSlackClient } from "./slack.js";
import type { PersistentStateConfig, PersistentStateStore } from "./state.js";
import { createPersistentStateStore, isPersistentStateStore } from "./state.js";
import { nonBlank } from "./strings.js";

/**
 * Per-run shared state — the in-memory replacement of the Python
 * inter-script state file (`data/preflight-state.json`). Same behavior, no
 * file: memory-server task and capacity fetches cache under the `tasks` and
 * `capacity` keys (one fetch per run, shared by every preflight in it), and
 * preflights keep their own bookkeeping keys the way the Python scripts used
 * `save_state`/`load_state` (e.g. `jira`, `has_actionable`). State lives for
 * one run only — the runner cleared the file between runs, so nothing is
 * persisted here either.
 */
export interface PreflightRunState {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  snapshot(): Readonly<Record<string, unknown>>;
}

export function createRunState(initial?: Readonly<Record<string, unknown>>): PreflightRunState {
  const store = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    get: (key) => store.get(key),
    set: (key, value) => {
      store.set(key, value);
    },
    has: (key) => store.has(key),
    snapshot: () => Object.fromEntries(store),
  };
}

/**
 * The auth-proxy route preflights require for external-system access: the
 * single route the package declares (the proxy base URL), optionally with an
 * injectable fetch for fixture-based tests. External-system clients compose
 * it with their per-system path prefix (`/github`, `/jira`, `/gitlab`); the
 * proxy injects credentials on the upstream leg, so no auth options exist
 * here.
 */
export interface ProxyRouteConfig {
  /** Proxy base URL, e.g. `https://proxy.example/devbot-proxy`. */
  readonly baseUrl: string;
  /** Injectable fetch for fixture-based tests. */
  readonly fetch?: FetchLike;
}

/** Proxy-route wiring: the base URL alone, or a config object with a fetch. */
export type ProxyWiring = string | ProxyRouteConfig;

/**
 * What `preflight.run(ctx, params)` receives: the per-run identity, the
 * shared memory-server client, the Jira REST client (wired by the
 * dispatcher for runs that include jira preflights), the instance
 * project-repos map, and the per-run shared state. Extends the core
 * run-context contract; this is the one shared type re-exported through the
 * public API.
 */
export interface PreflightRunContext extends RunContextContract {
  /** Unique id of this preflight run; used for logging, not semantics. */
  readonly runId: string;
  /** Memory-server client with task/capacity fetches cached per run. */
  readonly memory: MemoryServerClient;
  /** Jira REST client when wired; jira preflights error without one. */
  readonly jira?: JiraClient;
  /**
   * The auth-proxy route for external-system clients (`/github`, `/jira`,
   * `/gitlab` prefixes compose on top of its base URL). Preflights that need
   * an external system treat an absent route as an execution error — never
   * a silent skip. The dispatcher wires the proxy base URL (REHOR-259).
   */
  readonly proxy?: ProxyWiring;
  /**
   * The instance's `project-repos.json` map for repo-name resolution (bare
   * repo names → upstream org/repo and git host). Defaults to an empty map
   * (no repo resolution) when the dispatcher does not supply one.
   */
  readonly repos: ProjectReposMap;
  /** Per-run shared state (the state-file replacement). */
  readonly state: PreflightRunState;
  /**
   * Slack webhook client when wired. Webhook URLs are credentials supplied
   * by dispatcher-side deployment configuration only — never preflight
   * parameters or profiles. Preflights that notify treat an unwired client
   * as a degraded report, not an error.
   */
  readonly slack?: SlackClient;
  /**
   * Jenkins client when wired. Instance endpoints arrive through rendered
   * deployment configuration (secret rendering), never engine constants;
   * the client reads those hosts without credentials. Watchduty
   * preflights treat an unwired client as an execution error.
   */
  readonly jenkins?: JenkinsClient;
  /**
   * Persistent cross-run state (throttle timestamps, weekly markers) when
   * wired; one store per agent instance. Preflights that self-throttle
   * treat an unwired store as an execution error — an unpersisted
   * throttle marker would re-run throttled work every cycle.
   */
  readonly persistentState?: PersistentStateStore;
  /**
   * The deployment-provided bot Jira identity (BOT_JIRA_EMAIL): the
   * default for the `email` input of jira preflights whose entries do not
   * declare one. A non-secret identity, never a credential — the Jira
   * gateway injects authentication on the upstream leg, unchanged. An
   * explicit `with.email` declaration always wins; absent wiring leaves
   * those preflights on unassigned-only search.
   */
  readonly jiraEmail?: string;
  /**
   * The instance's approved non-secret settings from its `env:` (or legacy
   * `preflight.env:`) block, delivered as one unit: the dispatcher
   * validated eligibility before wiring, so preflights read any permitted
   * `BOT_*` setting without a dedicated wiring field. Not process.env,
   * sandbox.env, secret references, or resolved credentials — those never
   * merge in. Absent or empty means the instance declares no settings.
   */
  readonly instanceEnv: Readonly<Record<string, string>>;
}

/** Either an already-built client or the config to build one for this run. */
export type MemoryServerWiring = MemoryServerClient | MemoryServerClientConfig;

/** Either an already-built Jira client or the config to build one for this run. */
export type JiraWiring = JiraClient | JiraClientConfig;

/** Either an already-built Jenkins client or the config to build one for this run. */
export type JenkinsWiring = JenkinsClient | JenkinsClientConfig;

/** Either an already-built Slack client or the config to build one for this run. */
export type SlackWiring = SlackClient | SlackClientConfig;

/** Either an already-built persistent state store or the config to build one for this run. */
export type PersistentStateWiring = PersistentStateStore | PersistentStateConfig;

export interface PreflightRunContextOptions {
  readonly instanceId: string;
  /** Per-run identity; defaults to a generated UUID. */
  readonly runId?: string;
  readonly memory: MemoryServerWiring;
  /** Auth-proxy route for external-system clients; see {@link PreflightRunContext.proxy}. */
  readonly proxy?: ProxyWiring;
  /** Jira REST client or its config; the jira preflights require one. */
  readonly jira?: JiraWiring;
  /** Jenkins client or its config; the watchduty preflights require one. */
  readonly jenkins?: JenkinsWiring;
  /** Slack webhook client or its config; reporting preflights degrade without one. */
  readonly slack?: SlackWiring;
  /**
   * Persistent per-instance state store or its config. A config-built
   * store is namespaced to this context's instance id.
   */
  readonly persistentState?: PersistentStateWiring;
  /**
   * Deployment-provided bot Jira identity (BOT_JIRA_EMAIL); see
   * {@link PreflightRunContext.jiraEmail}. Blank values are treated as
   * absent, like the Python env read.
   */
  readonly jiraEmail?: string;
  /** Instance's approved non-secret settings; see {@link PreflightRunContext.instanceEnv}. */
  readonly instanceEnv?: Readonly<Record<string, string>>;
  /** Instance project-repos map; defaults to `{}` (no repo resolution). */
  readonly repos?: ProjectReposMap;
}

/**
 * Build the run context the dispatcher hands to every preflight in one run
 * (REHOR-259 wires the real configuration). A client built from config is
 * wired to the context's shared state so all preflights in the run share one
 * tasks/capacity fetch, and the context's instance id flows into the
 * `instance_id` query unless the config names its own. The Jira client and
 * the project-repos map carry the dispatcher-side wiring the jira preflights
 * need (proxy route and instance repos).
 */
export function createPreflightRunContext(
  options: PreflightRunContextOptions,
): PreflightRunContext {
  if (typeof options.instanceId !== "string" || options.instanceId.trim() === "") {
    throw new Error("run context requires a non-empty instanceId");
  }
  const state = createRunState();
  const memory = isMemoryServerClient(options.memory)
    ? options.memory
    : createMemoryServerClient({
        ...options.memory,
        instanceId: options.memory.instanceId ?? options.instanceId,
        state,
      });
  const jira =
    options.jira === undefined
      ? undefined
      : isJiraClient(options.jira)
        ? options.jira
        : createJiraClient(options.jira);
  const jenkins =
    options.jenkins === undefined
      ? undefined
      : isJenkinsClient(options.jenkins)
        ? options.jenkins
        : createJenkinsClient(options.jenkins);
  const slack =
    options.slack === undefined
      ? undefined
      : isSlackClient(options.slack)
        ? options.slack
        : createSlackClient(options.slack);
  const persistentState =
    options.persistentState === undefined
      ? undefined
      : isPersistentStateStore(options.persistentState)
        ? options.persistentState
        : createPersistentStateStore({
            ...options.persistentState,
            instanceId: options.persistentState.instanceId ?? options.instanceId,
          });
  const jiraEmail =
    options.jiraEmail !== undefined && nonBlank(options.jiraEmail) ? options.jiraEmail : undefined;
  return {
    instanceId: options.instanceId,
    runId: options.runId ?? randomUUID(),
    memory,
    jira,
    jenkins,
    slack,
    persistentState,
    ...(jiraEmail !== undefined ? { jiraEmail } : {}),
    instanceEnv: freezeInstanceEnv(options.instanceEnv),
    proxy: options.proxy,
    repos: options.repos ?? {},
    state,
  };
}

/** Copy and freeze the instance env unit so neither the caller nor a
 * preflight can mutate what the run shares. Eligibility (non-secret
 * `BOT_*` names) was validated by the dispatcher before wiring; this is
 * shape defense only, never a second allowlist. */
function freezeInstanceEnv(
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("run context requires instanceEnv to be an object");
  }
  return Object.freeze({ ...value });
}

function isMemoryServerClient(value: unknown): value is MemoryServerClient {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.getTasks === "function" && typeof candidate.getCapacity === "function";
}

function isJiraClient(value: unknown): value is JiraClient {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.searchIssues === "function" && typeof candidate.getIssue === "function";
}
