import type { FetchLike, HttpClient, QueryValue } from "./http.js";
import { createHttpClient, PreflightHttpError } from "./http.js";
import type { PreflightRunState } from "./run-context.js";
import { isoDateUtc } from "./time.js";

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

/**
 * Options for {@link MemoryServerClient.getTaskByKey} — the exact,
 * deterministic key lookup the daily/weekly pacing gates need (unlike
 * {@link MemoryServerClient.getTasks}, which excludes archived tasks and
 * caps at the newest 50).
 */
export interface TaskKeyLookupOptions {
  /**
   * Match only tasks with this `source_type`. The server's task identity is
   * `(external_key, source_type)` — the same key can exist once per source.
   * Leave unset to match any source (the gate keys are agent-created and
   * their source type is not guaranteed).
   */
  readonly sourceType?: string;
  /**
   * Restrict the lookup to the configured instance (`instance_id` query).
   * Default false: task rows created through `task_add` carry an
   * LLM-supplied `instance_id` that is frequently absent, and a NULL
   * instance is server-wide (it counts toward every instance's capacity),
   * so an instance-scoped lookup can miss the gate task and re-start
   * finished work. Opt in only when the gate tasks are known to be created
   * with a matching instance id.
   */
  readonly scopeByInstance?: boolean;
}

/**
 * Options for {@link MemoryServerClient.getActiveTasks}.
 */
export interface ActiveTaskFetchOptions {
  /**
   * Also select active tasks with no `instance_id` at all — the
   * historical rows the instance-scoped query misses (task rows created
   * before instance attribution existed, or with the attribution lost).
   * When true, the fetch queries the GLOBAL status-filtered listing
   * (no `instance_id` query parameter) and filters client-side: a row
   * counts when its `instance_id` equals the configured instance or is
   * truly unassigned. An empty-string `instance_id` is NOT unassigned —
   * it names something, just not this instance — so such rows stay
   * excluded exactly like every other foreign instance.
   *
   * Ownership of an unattributed row is ambiguous; the caller is
   * responsible for constraining what it admits (the quality feedback
   * preflight requires a matching configured repository). The broader
   * fetch is cached separately from the instance-scoped one — the two
   * scopes never serve each other's results — and the configured
   * instance is still required, because the client-side attribution
   * filter has nothing to compare against without it.
   */
  readonly includeUnattributed?: boolean;
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
  /**
   * Exact lookup of one task by `external_key`, across every status
   * (archived included) and independent of the listing pagination cap,
   * via a client-side match over the paginated `/api/tasks` listing (the
   * API offers no server-side `external_key`/`source_type` filtering).
   * Pages fetched by one lookup are reused by every other lookup on the
   * same client within the same scope (global vs instance), so scans
   * over many keys paginate the listing once, not once per key. Resolves
   * `undefined` when the key is absent from the scanned pages; every
   * fetch, auth, or protocol failure throws (fail closed — an
   * unreachable answer must never be mistaken for "no task yet").
   */
  getTaskByKey(
    externalKey: string,
    options?: TaskKeyLookupOptions,
  ): Promise<MemoryTask | undefined>;
  /**
   * The instance's active tasks (`in_progress`, `pr_open`, `pr_changes`),
   * each status fetched through its own fully paginated
   * `GET /api/tasks?status=…&instance_id=…` scan — unlike
   * {@link getTasks}, whose single all-status page caps at the newest 50
   * and can hide older active tasks behind done ones. Cached per run like
   * the other fetches; every fetch, auth, or protocol failure throws
   * (fail closed — an unreachable answer must never be mistaken for "no
   * active work").
   *
   * Requires a configured `instanceId`. By default the fetch is
   * instance-scoped: historical task rows whose `instance_id` is missing
   * or names another instance are not selected. With
   * `{includeUnattributed: true}` the scan reads the GLOBAL
   * status-filtered listing instead and keeps, client-side, only rows
   * attributed to the configured instance or truly unassigned
   * (null/undefined — an empty string is not unassigned); rows naming
   * other instances stay excluded. Rows repeated across the per-status
   * scans (a status transition racing the fetch) collapse by their
   * `(source_type, external_key)` identity. See
   * {@link ActiveTaskFetchOptions} for the ownership ambiguity the
   * caller must constrain.
   */
  getActiveTasks(options?: ActiveTaskFetchOptions): Promise<readonly MemoryTask[]>;
  /**
   * Memory entries carrying `tag`, bounded by `limit` (default 100) — the
   * REST `/api/memories` listing the watchduty and mintmaker cleanups scan
   * for tracked-work bookkeeping. Every fetch, auth, or protocol failure
   * throws (fail closed).
   */
  listMemories(tag: string, limit?: number): Promise<readonly MemoryRecord[]>;
  /**
   * Delete one memory entry by id — the cleanup path for recovered Jenkins
   * jobs and merged bot PRs. Throws on failure; callers that treat cleanup
   * as best-effort catch per entry.
   */
  deleteMemory(id: string | number): Promise<void>;
  /**
   * Archive one task by `external_key` (the REST soft delete). Throws on
   * failure; callers that treat cleanup as best-effort catch per entry.
   */
  archiveTask(externalKey: string): Promise<void>;
}

/** One memory entry as the REST `/api/memories` listing returns it. */
export interface MemoryRecord {
  readonly id: string | number;
  readonly content: string;
  readonly tags: readonly string[];
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
/**
 * Upper bound of pages scanned by one exact-key lookup (50 tasks per page —
 * 10 000 tasks). A pathological server must produce an error, not an
 * unbounded scan or a false "absent".
 */
const TASK_LOOKUP_MAX_PAGES = 200;
/**
 * Upper bound of pages scanned per status by one active-task fetch (50
 * tasks per page — 10 000 tasks per status). A pathological server must
 * produce an error, not an unbounded scan.
 */
const ACTIVE_TASKS_MAX_PAGES = 200;

/** Run-state cache key of the instance-scoped active-task fetch. */
const ACTIVE_TASKS_STATE_KEY = "active_tasks";
/** Run-state cache key of the unattributed-including active-task fetch. */
const ACTIVE_TASKS_UNATTRIBUTED_STATE_KEY = "active_tasks_unattributed";

/** Task statuses the preflights treat as active (the Python active filter). */
export const ACTIVE_TASK_STATUSES: readonly string[] = ["in_progress", "pr_open", "pr_changes"];

interface TasksResponse {
  readonly items?: readonly MemoryTask[];
  readonly total?: number;
}

interface MemoriesResponse {
  readonly items?: readonly MemoryRecord[];
}

/** One successfully fetched listing page, shared across key lookups. */
interface CachedPage {
  readonly items: readonly MemoryTask[];
  readonly total: number | undefined;
}

/**
 * Per-scope page cache for exact-key lookups: resolved pages plus the
 * in-flight page requests concurrent lookups share instead of duplicating.
 */
interface PageCache {
  readonly pages: Map<number, CachedPage>;
  readonly inFlight: Map<number, Promise<CachedPage>>;
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

/**
 * Deterministic task keys — the cross-run pacing gate that replaced the
 * Python cycle-sleep. The daily key of a task prefix: `${prefix}-${UTC
 * date}`, stable across every run of the same UTC day.
 */
export function dailyTaskKey(prefix: string, now: Date): string {
  return `${prefix}-${isoDateUtc(now)}`;
}

/** The first task whose external key equals `key`, when one exists. */
export function findTaskByKey(tasks: readonly MemoryTask[], key: string): MemoryTask | undefined {
  return tasks.find((task) => task?.external_key === key);
}

/**
 * Collapse rows that repeat one task identity — `(source_type,
 * external_key)`, the server's uniqueness pair. A task that transitions
 * status while the per-status scans of one active-task fetch are in
 * flight (or shifts between offset pages) can surface in two buckets;
 * the first occurrence wins. Rows without a string `external_key` have
 * no identity to compare and are never collapsed.
 */
export function dedupeByTaskIdentity(tasks: readonly MemoryTask[]): MemoryTask[] {
  const seen = new Set<string>();
  const unique: MemoryTask[] = [];
  for (const task of tasks) {
    const externalKey = task?.external_key;
    if (typeof externalKey !== "string") {
      unique.push(task);
      continue;
    }
    const sourceType = task?.source_type;
    const signature = JSON.stringify([
      typeof sourceType === "string" ? sourceType : null,
      externalKey,
    ]);
    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(task);
  }
  return unique;
}

/**
 * Count active tasks (status in {@link ACTIVE_TASK_STATUSES}) whose
 * external key starts with `${prefix}:` — the per-item tasks the agent
 * creates — or equals the daily key.
 */
export function countActiveTasksWithPrefix(
  tasks: readonly MemoryTask[],
  prefix: string,
  includeKey: string,
): number {
  return tasks.filter(
    (task) =>
      ACTIVE_TASK_STATUSES.includes(task?.status ?? "") &&
      (task?.external_key?.startsWith(`${prefix}:`) || task?.external_key === includeKey),
  ).length;
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
  let activeTasksInFlight: Promise<readonly MemoryTask[]> | undefined;
  let activeTasksUnattributedInFlight: Promise<readonly MemoryTask[]> | undefined;
  const taskKeyLookups = new Map<string, Promise<MemoryTask | undefined>>();
  /**
   * Page caches keyed by scope: `""` for the global listing, the
   * `instance_id` value for an instance-scoped listing. Separate caches
   * per scope prevent cross-instance contamination — a global lookup must
   * never be answered from instance-scoped pages or the reverse.
   */
  const pageCaches = new Map<string, PageCache>();

  function getOrCreatePageCache(scopeKey: string): PageCache {
    let cache = pageCaches.get(scopeKey);
    if (cache === undefined) {
      cache = { pages: new Map(), inFlight: new Map() };
      pageCaches.set(scopeKey, cache);
    }
    return cache;
  }

  const tasksQuery = (excludeStatus: readonly string[]): Record<string, QueryValue> => {
    const query: Record<string, QueryValue> = { exclude_status: excludeStatus, limit: TASKS_LIMIT };
    if (config.instanceId) query.instance_id = config.instanceId;
    return query;
  };

  /**
   * Query of one active-status page. The server applies a single
   * `status` value (unlike `exclude_status`, where only the first value
   * counts), so the status filtering is trusted, not re-checked
   * client-side. The unattributed-including fetch omits `instance_id`:
   * it reads the global per-status listing and splits own vs unassigned
   * rows client-side afterwards.
   */
  const activeTasksQuery = (
    status: string,
    offset: number,
    includeUnattributed: boolean,
  ): Record<string, QueryValue> => {
    const query: Record<string, QueryValue> = { status, limit: TASKS_LIMIT, offset };
    if (!includeUnattributed && config.instanceId) query.instance_id = config.instanceId;
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
    const active = items.filter((task) => ACTIVE_TASK_STATUSES.includes(task?.status ?? "")).length;
    const capacity = { active, max: CAPACITY_MAX };
    state?.set("capacity", capacity);
    return capacity;
  }

  /**
   * Active tasks: one fully paginated scan per active status
   * (`in_progress`, `pr_open`, `pr_changes`), each page
   * `GET /api/tasks?status=…&limit=50&offset=…`. This is the retrieval
   * the feedback preflights need: `getTasks` returns only the newest 50
   * tasks of all statuses, so done tasks can hide an older active task,
   * while these status-scoped queries select every active task however
   * deep it sits in its status's listing.
   *
   * Two scopes share this scan. The default instance-scoped mode adds
   * `instance_id` to every query: historical rows whose `instance_id` is
   * NULL or foreign are not selected — the original, reported
   * limitation. The `includeUnattributed` mode reads the GLOBAL
   * status-filtered listing (no `instance_id` query) and filters
   * client-side instead: a row counts when its `instance_id` equals the
   * configured instance or is truly unassigned (null/undefined — an
   * empty string names something and stays excluded, like every other
   * foreign instance). Ownership of an unattributed row is ambiguous;
   * constraining what the caller does with it is the caller's job. Both
   * modes require a configured instance (the method's guard) — the
   * client-side attribution filter has nothing to compare against
   * without one, and the fetch refuses to run rather than guess.
   */
  async function fetchActiveTasks(includeUnattributed: boolean): Promise<readonly MemoryTask[]> {
    const collected: MemoryTask[] = [];
    for (const status of ACTIVE_TASK_STATUSES) {
      let offset = 0;
      let seen = 0;
      let exhausted = false;
      for (let page = 0; page < ACTIVE_TASKS_MAX_PAGES; page += 1) {
        let data: TasksResponse;
        try {
          data = await http.getJson<TasksResponse>("/api/tasks", {
            query: activeTasksQuery(status, offset, includeUnattributed),
          });
        } catch (error) {
          throw authReject(error);
        }
        // A malformed page is fatal: treating it as empty could hide a
        // live active task behind a protocol glitch.
        if (!Array.isArray(data?.items)) {
          throw new Error(
            `memory-server active-task fetch (status ${status}): /api/tasks page at offset ${offset} returned no items array`,
          );
        }
        collected.push(...data.items);
        seen += data.items.length;
        offset += data.items.length;
        const total = typeof data?.total === "number" ? data.total : undefined;
        if (
          data.items.length === 0 ||
          data.items.length < TASKS_LIMIT ||
          (total !== undefined && seen >= total)
        ) {
          exhausted = true;
          break;
        }
      }
      if (!exhausted) {
        throw new Error(
          `memory-server active-task fetch (status ${status}): exceeded ${ACTIVE_TASKS_MAX_PAGES} pages without exhausting the listing`,
        );
      }
    }
    // The unattributed-including scan read global pages: apply the
    // attribution split the instance_id query would have made
    // server-side.
    const scoped = includeUnattributed ? collected.filter(isOwnOrUnassigned) : collected;
    // A status transition racing the per-status scans can surface one
    // task in two buckets; identity is (source_type, external_key).
    const unique = dedupeByTaskIdentity(scoped);
    state?.set(
      includeUnattributed ? ACTIVE_TASKS_UNATTRIBUTED_STATE_KEY : ACTIVE_TASKS_STATE_KEY,
      unique,
    );
    return unique;
  }

  /**
   * A row the unattributed-including scan admits: attributed to the
   * configured instance, or truly unassigned. An empty-string
   * `instance_id` is deliberately NOT unassigned — it names something,
   * just not this instance.
   */
  const isOwnOrUnassigned = (task: MemoryTask): boolean => {
    const instanceId = task?.instance_id;
    return instanceId === null || instanceId === undefined || instanceId === config.instanceId;
  };

  /**
   * Exact `external_key` lookup over `GET /api/tasks` — the only REST
   * surface the memory server offers for tasks (there is no GET-by-key
   * route and no server-side `external_key`/`source_type` filtering). The
   * match — including the optional source-type filter — is client-side,
   * and the scan pages through the whole listing (`offset` until `total`
   * or an exhausted page). No `exclude_status` is sent, so archived tasks
   * are visible. The scan stops at the first match; only an exhausted
   * result set resolves `undefined`.
   *
   * Page sharing: successfully fetched pages are cached on the client
   * (per run) and scoped by query — the global listing and each
   * instance-scoped listing have separate caches. Concurrent lookups in
   * the same scope share in-flight page requests instead of issuing
   * duplicates. Failed requests are never cached, so a retry refetches.
   * This is what makes per-finding scans viable: many different keys pay
   * for the pagination once, not once per key.
   *
   * Cost and races: the first lookup in a scope walks the full listing
   * page by page (up to {@link TASK_LOOKUP_MAX_PAGES} pages), and each
   * page is a snapshot taken at a different time — a task created or
   * moved while the scan is in flight (or after its pages were cached)
   * can shift past the scanned offset window and look absent.
   * `undefined` therefore means "absent from the scanned (possibly
   * cached) pages", not a guaranteed exact absence under concurrent
   * writes.
   */
  async function fetchTaskByKey(
    externalKey: string,
    options: TaskKeyLookupOptions | undefined,
  ): Promise<MemoryTask | undefined> {
    const sourceType = options?.sourceType;
    const instanceScoped =
      options?.scopeByInstance === true &&
      config.instanceId !== undefined &&
      config.instanceId !== "";
    const matches = (task: MemoryTask): boolean =>
      task?.external_key === externalKey &&
      (sourceType === undefined || task?.source_type === sourceType);
    const cache = getOrCreatePageCache(instanceScoped ? (config.instanceId as string) : "");

    const fetchPage = async (offset: number): Promise<CachedPage> => {
      const query: Record<string, QueryValue> = { limit: TASKS_LIMIT, offset };
      if (instanceScoped) query.instance_id = config.instanceId;
      let data: TasksResponse;
      try {
        data = await http.getJson<TasksResponse>("/api/tasks", { query });
      } catch (error) {
        throw authReject(error);
      }
      // A malformed page is fatal: treating it as empty could turn a live
      // gate task into a false "absent" and restart finished work.
      if (!Array.isArray(data?.items)) {
        throw new Error(
          `memory-server task lookup for "${externalKey}": /api/tasks page at offset ${offset} returned no items array`,
        );
      }
      return { items: data.items, total: typeof data?.total === "number" ? data.total : undefined };
    };

    // One request per offset per scope: served from cache when resolved,
    // shared while in flight. Only successful pages are cached.
    const getPage = (offset: number): Promise<CachedPage> => {
      const cached = cache.pages.get(offset);
      if (cached !== undefined) return Promise.resolve(cached);
      const inFlight = cache.inFlight.get(offset);
      if (inFlight !== undefined) return inFlight;
      const request = fetchPage(offset).then(
        (page) => {
          cache.pages.set(offset, page);
          cache.inFlight.delete(offset);
          return page;
        },
        (error: unknown) => {
          cache.inFlight.delete(offset);
          throw error;
        },
      );
      cache.inFlight.set(offset, request);
      return request;
    };

    let offset = 0;
    let seen = 0;
    for (let page = 0; page < TASK_LOOKUP_MAX_PAGES; page += 1) {
      const { items, total } = await getPage(offset);
      if (items.length === 0) return undefined;
      const match = items.find(matches);
      if (match !== undefined) return match;
      seen += items.length;
      offset += items.length;
      if (total !== undefined && seen >= total) return undefined;
      if (items.length < TASKS_LIMIT) return undefined;
    }
    throw new Error(
      `memory-server task lookup for "${externalKey}": exceeded ${TASK_LOOKUP_MAX_PAGES} pages without resolving the key`,
    );
  }

  function taskKeyLookupSignature(
    externalKey: string,
    options: TaskKeyLookupOptions | undefined,
  ): string {
    return JSON.stringify([
      options?.scopeByInstance === true ? (config.instanceId ?? null) : null,
      options?.sourceType ?? null,
      externalKey,
    ]);
  }

  /**
   * Memory listing + the two write-path cleanups. These bypass the per-run
   * caches: cleanup must observe current server state, and deletes must
   * always reach the server.
   */
  async function listMemories(tag: string, limit = 100): Promise<readonly MemoryRecord[]> {
    let data: MemoriesResponse;
    try {
      data = await http.getJson<MemoriesResponse>("/api/memories", {
        query: { tag, limit },
      });
    } catch (error) {
      throw authReject(error);
    }
    return Array.isArray(data?.items) ? [...data.items] : [];
  }

  async function deleteMemory(id: string | number): Promise<void> {
    try {
      await http.delete<unknown>(`/api/memories/${encodeURIComponent(String(id))}`);
    } catch (error) {
      throw authReject(error);
    }
  }

  async function archiveTask(externalKey: string): Promise<void> {
    try {
      await http.delete<unknown>(`/api/tasks/${encodeURIComponent(externalKey)}`);
    } catch (error) {
      throw authReject(error);
    }
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
    getTaskByKey(
      externalKey: string,
      options?: TaskKeyLookupOptions,
    ): Promise<MemoryTask | undefined> {
      if (typeof externalKey !== "string" || externalKey === "") {
        return Promise.reject(new Error("getTaskByKey requires a non-empty externalKey"));
      }
      const signature = taskKeyLookupSignature(externalKey, options);
      const inFlight = taskKeyLookups.get(signature);
      if (inFlight !== undefined) return inFlight;
      const lookup = fetchTaskByKey(externalKey, options).catch((error: unknown) => {
        // A failed lookup is never cached — the next call retries, like
        // the tasks/capacity fetches.
        taskKeyLookups.delete(signature);
        throw error;
      });
      taskKeyLookups.set(signature, lookup);
      return lookup;
    },
    getActiveTasks(options?: ActiveTaskFetchOptions): Promise<readonly MemoryTask[]> {
      // Both scopes attribute rows against the configured instance —
      // without one the fetch refuses to run rather than silently
      // querying a listing it cannot attribute (see fetchActiveTasks:
      // the unattributed-including mode needs the instance id for its
      // client-side filter just as much as the scoped query does).
      if (config.instanceId === undefined || config.instanceId === "") {
        return Promise.reject(
          new Error(
            options?.includeUnattributed === true
              ? "getActiveTasks requires a configured instanceId; the unattributed-including fetch cannot attribute global rows without one"
              : "getActiveTasks requires a configured instanceId; refusing to broaden the instance-scoped active-task fetch to the global listing",
          ),
        );
      }
      if (options?.includeUnattributed === true) {
        const cached = state?.get(ACTIVE_TASKS_UNATTRIBUTED_STATE_KEY);
        if (cached !== undefined) return Promise.resolve(cached as readonly MemoryTask[]);
        activeTasksUnattributedInFlight ??= fetchActiveTasks(true).catch((error: unknown) => {
          activeTasksUnattributedInFlight = undefined;
          throw error;
        });
        return activeTasksUnattributedInFlight;
      }
      const cached = state?.get(ACTIVE_TASKS_STATE_KEY);
      if (cached !== undefined) return Promise.resolve(cached as readonly MemoryTask[]);
      activeTasksInFlight ??= fetchActiveTasks(false).catch((error: unknown) => {
        activeTasksInFlight = undefined;
        throw error;
      });
      return activeTasksInFlight;
    },
    listMemories,
    deleteMemory,
    archiveTask,
  };
}

function authReject(error: unknown): unknown {
  if (error instanceof PreflightHttpError && (error.status === 401 || error.status === 403)) {
    return new MemoryAuthRejectedError(error);
  }
  return error;
}
