/**
 * Persistent cross-run state — the dispatcher-side replacement of the Python
 * preflights' `BOT_DATA_DIR` files (throttle timestamps, weekly markers,
 * groomed-week bookkeeping).
 *
 * One JSON file per agent instance, named by a hash of the instance id, holds
 * a plain `{key: value}` object. Preflights qualify their own key names
 * (convention: `<preflight-id>:<purpose>`), so entries never collide across
 * preflights, and the store never interprets values. Reads are tolerant — a
 * missing or malformed file reads as empty state, exactly like the Python
 * `try/except → {}` loaders — while writes fail loudly: a state file that
 * cannot be persisted is an execution error of the preflight entry, never a
 * silent loss of a throttle or dedup marker.
 *
 * The store assumes a single writer per instance (the dispatcher runs one
 * cycle per profile at a time); it makes no attempt to coordinate concurrent
 * processes.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Injectable filesystem for fixture-based tests. */
export interface PersistentStateIo {
  mkdir(dir: string, recursive: boolean): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

export interface PersistentStateConfig {
  /** Dispatcher-owned writable directory holding one file per instance. */
  readonly dir: string;
  /**
   * Instance whose state this store owns; names the file. Optional here so
   * run-context wiring can default it to the run's instance id — a
   * standalone store construction still requires it.
   */
  readonly instanceId?: string;
  /** Injectable filesystem; defaults to `node:fs/promises`. */
  readonly io?: PersistentStateIo;
}

export interface PersistentStateStore {
  /** Value stored under `key`, or `undefined`; read failures read as empty. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Persist `value` under `key`; write failures reject. */
  set(key: string, value: unknown): Promise<void>;
  /** Remove `key` (a no-op when absent); write failures reject. */
  delete(key: string): Promise<void>;
  /** Whether `key` is present; read failures read as empty. */
  has(key: string): Promise<boolean>;
}

interface PersistedState {
  readonly [key: string]: unknown;
}

const io: PersistentStateIo = {
  mkdir: (dir, recursive) => mkdir(dir, { recursive }),
  readFile: (path, encoding) => readFile(path, encoding),
  writeFile: (path, data, encoding) => writeFile(path, data, encoding),
};

export function createPersistentStateStore(config: PersistentStateConfig): PersistentStateStore {
  if (typeof config.dir !== "string" || config.dir.trim() === "") {
    throw new Error("persistent state requires a non-empty dir");
  }
  if (typeof config.instanceId !== "string" || config.instanceId.trim() === "") {
    throw new Error("persistent state requires a non-empty instanceId");
  }
  const fs = config.io ?? io;
  const file = join(
    config.dir,
    `${createHash("sha256").update(config.instanceId).digest("hex")}.json`,
  );
  let loaded: Promise<Map<string, unknown>> | undefined;

  function load(): Promise<Map<string, unknown>> {
    loaded ??= fs
      .readFile(file, "utf8")
      .then((text) => {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return new Map<string, unknown>();
        }
        return new Map<string, unknown>(Object.entries(parsed as PersistedState));
      })
      .catch(() => new Map<string, unknown>());
    return loaded;
  }

  async function persist(entries: Map<string, unknown>): Promise<void> {
    await fs.mkdir(config.dir, true);
    await fs.writeFile(file, JSON.stringify(Object.fromEntries(entries)), "utf8");
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      return (await load()).get(key) as T | undefined;
    },
    async set(key, value) {
      const entries = await load();
      entries.set(key, value);
      await persist(entries);
    },
    async delete(key) {
      const entries = await load();
      if (!entries.delete(key)) return;
      await persist(entries);
    },
    async has(key) {
      return (await load()).has(key);
    },
  };
}

/** Structural check used by the run-context wiring. */
export function isPersistentStateStore(value: unknown): value is PersistentStateStore {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.get === "function" && typeof candidate.set === "function";
}
