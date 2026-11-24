/** Dispatcher side of the cluster-wide per-agent session mutex (REHOR-218).
 *
 * The memory server exposes a dumb lock REST API under /api/locks on the
 * configured memory URL; this module owns the lifecycle around it: acquire
 * before a session, renew at one third of the TTL while the session runs,
 * and release once the session settles. Only fixed identifiers (lock key,
 * holder, token) travel in requests; never session content or prompts. */

export type SessionLockAcquisition =
  | { status: "acquired"; token: string; expiresAt: string }
  | { status: "contended"; holder: string | null }
  | { status: "error" };

export type SessionLockClient = {
  /** Lease the lock or report the current holder; never throws. */
  acquire(key: string, holder: string, ttlMs: number): Promise<SessionLockAcquisition>;
  /** Extend a held lease; false on any failure, mismatch, or rejection. */
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Best-effort release; false on any failure or rejection. Never throws. */
  release(key: string, token: string): Promise<boolean>;
};

export type SessionLockLog = (event: string, status: "success" | "failure", data?: Record<string, unknown>) => void;

export function createSessionLockClient(options: {
  /** Base memory-server URL (authConfig.memoryUrl). */
  url: URL;
  /** Mints the bearer token for each request. */
  mint: () => Promise<string>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}): SessionLockClient {
  const doFetch = options.fetchImpl ?? fetch;
  // POST one JSON document with a freshly minted bearer token. Minting,
  // network, and response-body failures never throw: an unparsable body
  // still carries its status, and transport failures resolve to undefined
  // so callers map them to their error states.
  const post = async (path: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown } | undefined> => {
    try {
      const token = await options.mint();
      const response = await doFetch(new URL(path, options.url), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let json: unknown = null;
      try { json = await response.json(); } catch { /* Status still decides. */ }
      return { status: response.status, json };
    } catch {
      return undefined;
    }
  };
  return {
    async acquire(key, holder, ttlMs) {
      const response = await post("/api/locks/acquire", { key, holder, ttl_seconds: Math.ceil(ttlMs / 1000) });
      if (!response) return { status: "error" };
      if (response.status === 409) {
        const body = response.json as { holder?: unknown } | null;
        return { status: "contended", holder: typeof body?.holder === "string" && body.holder ? body.holder : null };
      }
      if (response.status !== 200) return { status: "error" };
      const body = response.json as { acquired?: unknown; lock_token?: unknown; expires_at?: unknown } | null;
      if (body?.acquired !== true || typeof body.lock_token !== "string" || !body.lock_token) return { status: "error" };
      return { status: "acquired", token: body.lock_token, expiresAt: typeof body.expires_at === "string" ? body.expires_at : "" };
    },
    async renew(key, token, ttlMs) {
      const response = await post("/api/locks/renew", { key, lock_token: token, ttl_seconds: Math.ceil(ttlMs / 1000) });
      if (!response || response.status !== 200) return false;
      return (response.json as { renewed?: unknown } | null)?.renewed === true;
    },
    async release(key, token) {
      const response = await post("/api/locks/release", { key, lock_token: token });
      if (!response || response.status !== 200) return false;
      return (response.json as { released?: unknown } | null)?.released === true;
    },
  };
}

/** Run `run` while holding the per-agent session lock.
 *
 * Acquisition outcomes map to "contended" (another replica owns the agent;
 * normal multi-replica operation) or "error" (fail closed: no session is
 * created). While `run` is in flight the lease renews at one third of the
 * TTL. A failed renewal is logged once and never aborts the session:
 * killing a running sandbox mid-flight is worse than a possibly-shared
 * lock, and the TTL bounds how stale that state can become. The acquisition
 * token is handed to `run` so durable bookkeeping (session registry) can
 * reference the exact lease. The timer is cleared and the lock released in a
 * finally block once `run` settles, so drain-driven completions release their
 * locks on rollout; hard kills are covered by TTL expiry instead. */
export async function withSessionLock<T>(options: {
  lock: SessionLockClient;
  key: string;
  holder: string;
  ttlMs: number;
  log: SessionLockLog;
  run: (lockToken: string) => Promise<T>;
}): Promise<{ status: "contended" | "error" } | { status: "ran"; result: T }> {
  const acquisition = await options.lock.acquire(options.key, options.holder, options.ttlMs);
  if (acquisition.status === "contended") {
    // Contention is normal operation, not a failure; the current holder is
    // included for debugging only.
    options.log("sandbox.lock", "success", { contended: true, holder: acquisition.holder });
    return { status: "contended" };
  }
  if (acquisition.status === "error") {
    options.log("sandbox.lock", "failure", { category: "internal" });
    return { status: "error" };
  }
  let renewFailureLogged = false;
  const timer = setInterval(() => {
    void options.lock.renew(options.key, acquisition.token, options.ttlMs).then((renewed) => {
      if (renewed || renewFailureLogged) return;
      renewFailureLogged = true;
      options.log("sandbox.lock", "failure", { renew: true });
    });
  }, Math.max(1, Math.floor(options.ttlMs / 3)));
  // The renew timer must not keep the process alive during drain.
  timer.unref?.();
  try {
    const result = await options.run(acquisition.token);
    return { status: "ran", result };
  } finally {
    clearInterval(timer);
    try {
      const released = await options.lock.release(options.key, acquisition.token);
      if (!released) options.log("sandbox.lock", "failure", { release: true });
    } catch {
      options.log("sandbox.lock", "failure", { release: true });
    }
  }
}
