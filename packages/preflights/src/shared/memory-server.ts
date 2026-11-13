import type { FetchLike, HttpClient, QueryValue } from "./http.js";
import { createHttpClient, PreflightHttpError } from "./http.js";
import type { PreflightRunState } from "./run-context.js";

/**
 * Memory-server client — the port of the memory-server half of the Python
 * `common.py` helpers. Bearer-authenticated task and capacity fetching with
 * the inter-script cache semantics: when wired to a run context's shared
 * state, the `tasks` and `capacity` keys are fetched once per run and shared
 * by every preflight in it (the in-memory replacement of
 * `data/preflight-state.json`).
 *
 * Configuration is injected (baseUrl, token, instanceId) — the package never
 * reads environment variables; the dispatcher supplies `BOT_MEMORY_URL` and
 * `BOT_MEMORY_TOKEN` when it wires the run context (REHOR-259).
 */

/** Task record from the memory server `/api/tasks` endpoint. */
export interface MemoryTask {
  readonly external_key?: string;
  readonly status?: string;
  readonly repo?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly last_addressed?: string;
  readonly pr_number?: number;
  readonly paused_reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly artifacts?: readonly Readonly<Record<string, unknown>>[];
  readonly [field: string]: unknown;
}

/** Active-versus-max capacity, as the Python `get_capacity` computed it. */
export interface TaskCapacity {
  readonly active: number;
  readonly max: number;
}

export interface MemoryServerClientConfig {
  /** Memory-server base URL; a trailing `/mcp` suffix is stripped. */
  readonly baseUrl: string;
  /** Bearer token; when set, requests carry `Authorization: Bearer <token>`. */
  readonly token?: string;
  /** Instance filter, appended as `instance_id` when non-empty. */
  readonly instanceId?: string;
  /** Request timeout in milliseconds; defaults to 10 s (the Python default). */
  readonly timeoutMs?: number;
  /** Injectable fetch for fixture-based tests. */
  readonly fetch?: FetchLike;
  /**
   * Shared per-run state used to cache task and capacity fetches. The run
   * context factory wires this; a standalone client caches on its own.
   */
  readonly state?: PreflightRunState;
}

export interface MemoryServerClient {
  getTasks(): Promise<readonly MemoryTask[]>;
  getCapacity(): Promise<TaskCapacity>;
}

/**
 * A 401/403 from the memory server. Authorization failures raise instead of
 * degrading to an empty task list — a rejected request must never be mistaken
 * for "no work" (the Python helper's contract, kept here).
 */
export class MemoryAuthRejectedError extends PreflightHttpError {
  constructor(source: PreflightHttpError) {
    super({
      status: source.status,
      method: source.method,
      url: source.url,
      route: source.route,
      message: `authenticated request rejected (${source.status})`,
    });
    this.name = "MemoryAuthRejectedError";
  }
}

const TASKS_LIMIT = 50;
const CAPACITY_MAX = 10;
const ACTIVE_STATUSES: readonly string[] = ["in_progress", "pr_open", "pr_changes"];

interface TasksResponse {
  readonly items?: readonly MemoryTask[];
}

/**
 * Normalize a memory-server base URL: trim trailing slashes and strip one
 * `/mcp` suffix (deployment configs hand out the MCP endpoint; the REST API
 * lives on the origin).
 */
export function normalizeMemoryBaseUrl(baseUrl: string): string {
  let base = baseUrl.trim().replace(/\/+$/, "");
  if (base.endsWith("/mcp")) {
    base = base.slice(0, -"/mcp".length).replace(/\/+$/, "");
  }
  return base;
}

export function createMemoryServerClient(config: MemoryServerClientConfig): MemoryServerClient {
  const http: HttpClient = createHttpClient({
    baseUrl: normalizeMemoryBaseUrl(config.baseUrl),
    timeoutMs: config.timeoutMs,
    fetch: config.fetch,
    defaultHeaders:
      config.token === undefined || config.token === ""
        ? undefined
        : { Authorization: `Bearer ${config.token}` },
  });
  const state = config.state;
  let tasksInFlight: Promise<readonly MemoryTask[]> | undefined;
  let capacityInFlight: Promise<TaskCapacity> | undefined;

  const tasksQuery = (excludeStatus: readonly string[]): Record<string, QueryValue> => {
    const query: Record<string, QueryValue> = { exclude_status: excludeStatus, limit: TASKS_LIMIT };
    if (config.instanceId) query.instance_id = config.instanceId;
    return query;
  };

  async function fetchTasks(): Promise<readonly MemoryTask[]> {
    let data: TasksResponse;
    try {
      data = await http.getJson<TasksResponse>("/api/tasks", {
        query: tasksQuery(["archived"]),
      });
    } catch (error) {
      throw authReject(error);
    }
    const items = Array.isArray(data?.items) ? [...data.items] : [];
    state?.set("tasks", items);
    return items;
  }

  async function fetchCapacity(): Promise<TaskCapacity> {
    let data: TasksResponse;
    try {
      data = await http.getJson<TasksResponse>("/api/tasks", {
        query: tasksQuery(["archived", "done", "paused"]),
      });
    } catch (error) {
      throw authReject(error);
    }
    // The server applies only the first exclude_status; the active-status
    // filter is client-side, exactly like the Python helper.
    const items = Array.isArray(data?.items) ? data.items : [];
    const active = items.filter((task) => ACTIVE_STATUSES.includes(task?.status ?? "")).length;
    const capacity = { active, max: CAPACITY_MAX };
    state?.set("capacity", capacity);
    return capacity;
  }

  return {
    getTasks(): Promise<readonly MemoryTask[]> {
      const cached = state?.get("tasks");
      if (cached !== undefined) return Promise.resolve(cached as readonly MemoryTask[]);
      tasksInFlight ??= fetchTasks().catch((error: unknown) => {
        tasksInFlight = undefined;
        throw error;
      });
      return tasksInFlight;
    },
    getCapacity(): Promise<TaskCapacity> {
      const cached = state?.get("capacity");
      if (cached !== undefined) return Promise.resolve(cached as TaskCapacity);
      capacityInFlight ??= fetchCapacity().catch((error: unknown) => {
        capacityInFlight = undefined;
        throw error;
      });
      return capacityInFlight;
    },
  };
}

function authReject(error: unknown): unknown {
  if (error instanceof PreflightHttpError && (error.status === 401 || error.status === 403)) {
    return new MemoryAuthRejectedError(error);
  }
  return error;
}
