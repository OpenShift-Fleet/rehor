import { AsyncLocalStorage } from "node:async_hooks";
import type { ProxyRouteConfig } from "@rehor/preflights";

type PreflightFetch = NonNullable<ProxyRouteConfig["fetch"]>;

type EntryScope = {
  signal: AbortSignal;
  active: Set<Promise<unknown>>;
};

export class PreflightDeadlineError extends Error {
  constructor() {
    super("Preflight entry deadline exceeded");
    this.name = "PreflightDeadlineError";
  }
}

/** Authenticated, cancellable transports shared by one run context. */
export function createPreflightTransport(options: {
  memoryBaseUrl: string;
  token: string;
  proxyBaseUrl?: string;
}) {
  const entries = new AsyncLocalStorage<EntryScope>();
  const memoryBase = parseBase(options.memoryBaseUrl);
  const memoryPath = memoryBase.pathname.replace(/\/+$/, "").replace(/\/mcp$/, "");
  const proxyBase = options.proxyBaseUrl === undefined ? undefined : parseBase(options.proxyBaseUrl);

  function scopedFetch(base: URL, paths: readonly string[]): PreflightFetch {
    return (rawUrl, init) => {
      const scope = entries.getStore();
      if (scope === undefined) return Promise.reject(new Error("Preflight request requires an active entry"));
      const request = (async () => {
        const signal = init.signal === undefined ? scope.signal : AbortSignal.any([scope.signal, init.signal]);
        signal.throwIfAborted();
        const url = new URL(rawUrl);
        if (url.origin !== base.origin || url.username || url.password || url.hash ||
          !paths.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))) {
          throw new Error("Preflight request must stay on its configured route");
        }
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${options.token}`);
        // Native redirect following would bypass the route check. SDKs that
        // validate redirect hops themselves can continue using manual mode.
        const response = await fetch(url, {
          ...init,
          headers,
          signal,
          redirect: init.redirect === "manual" ? "manual" : "error",
        });
        // Keep response consumption inside the entry scope, including error
        // bodies and SDK pagination responses. Aborting drains the body too.
        const body = await response.arrayBuffer();
        signal.throwIfAborted();
        const buffered = new Response(response.body === null ? null : body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        Object.defineProperty(buffered, "url", { value: response.url });
        return buffered;
      })();
      scope.active.add(request);
      void request.then(() => scope.active.delete(request), () => scope.active.delete(request));
      return request;
    };
  }

  return {
    memoryFetch: scopedFetch(memoryBase, [`${memoryPath}/api/tasks`]),
    gatewayFetch: proxyBase === undefined ? undefined : scopedFetch(proxyBase,
      ["jira", "github", "gitlab"].map((route) => `${proxyBase.pathname.replace(/\/+$/, "")}/${route}`)),
    async runEntry<T>(operation: () => Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
      const controller = new AbortController();
      const entrySignal = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]);
      const scope: EntryScope = { signal: entrySignal, active: new Set() };
      const timer = setTimeout(() => controller.abort(new PreflightDeadlineError()), timeoutMs);
      let onAbort: (() => void) | undefined;
      try {
        entrySignal.throwIfAborted();
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(entrySignal.reason);
          entrySignal.addEventListener("abort", onAbort, { once: true });
        });
        return await Promise.race([entries.run(scope, async () => operation()), aborted]);
      } finally {
        clearTimeout(timer);
        if (onAbort) entrySignal.removeEventListener("abort", onAbort);
        // Closing the scope also covers parallel requests left by a failed
        // operation. Late continuations retain this closed scope, never the
        // next entry's signal, so they cannot launch additional requests.
        controller.abort();
        while (scope.active.size) await Promise.allSettled([...scope.active]);
      }
    },
  };
}

function parseBase(raw: string): URL {
  const url = new URL(raw);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
    throw new Error("Preflight base URL must be a credential-free HTTP route");
  }
  return url;
}
