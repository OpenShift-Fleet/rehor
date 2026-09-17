import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const ENVIRONMENT_ALLOWLIST = [
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "NODE_OPTIONS",
  "OPENCODE_CONFIG_CONTENT",
] as const;

export const DEFAULT_NO_PROXY_HOSTS = [
  "127.0.0.1",
  "localhost",
  "devbot-proxy",
  "proxy",
  "model-gateway",
  "memory-server",
  "jira-proxy",
  "jira-mcp",
] as const;

export interface ProxyEnvironment {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string | readonly string[];
}

export interface OpenCodeEnvironmentOptions {
  /** Sanitized runner environment. It is copied, never read by the child implicitly. */
  base?: NodeJS.ProcessEnv;
  proxy?: ProxyEnvironment;
  /** Explicitly permitted variables needed by a provider or an MCP server. */
  passthrough?: readonly string[];
  noProxyHosts?: readonly string[];
}

export type OpenCodeFetch = (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Builds the environment used by both the OpenCode child and its runner client.
 *
 * Proxy names are copied deliberately, including their lowercase aliases. This
 * avoids relying on a pod's ambient proxy configuration while preserving proxy
 * use for external registry/catalog traffic. Loopback and service hosts always
 * bypass the proxy.
 */
export function buildOpenCodeEnvironment(
  options: OpenCodeEnvironmentOptions = {},
): Record<string, string> {
  const base = options.base ?? process.env;
  const environment: Record<string, string> = {};

  for (const name of ENVIRONMENT_ALLOWLIST) copyIfPresent(environment, base, name);
  for (const name of options.passthrough ?? []) copyIfPresent(environment, base, name);

  const proxy = options.proxy ?? {
    httpProxy: base.HTTP_PROXY ?? base.http_proxy,
    httpsProxy: base.HTTPS_PROXY ?? base.https_proxy,
    noProxy: base.NO_PROXY ?? base.no_proxy,
  };
  setProxyAlias(environment, "HTTP_PROXY", "http_proxy", proxy.httpProxy);
  setProxyAlias(environment, "HTTPS_PROXY", "https_proxy", proxy.httpsProxy);

  const inheritedNoProxy = normalizeHosts(proxy.noProxy);
  const noProxyHosts = [
    ...DEFAULT_NO_PROXY_HOSTS,
    ...(options.noProxyHosts ?? []),
    ...inheritedNoProxy,
  ];
  const noProxy = [...new Set(noProxyHosts.filter(Boolean))].join(",");
  environment.NO_PROXY = noProxy;
  environment.no_proxy = noProxy;

  return environment;
}

function copyIfPresent(
  target: Record<string, string>,
  source: NodeJS.ProcessEnv,
  name: string,
): void {
  const value = source[name];
  if (value !== undefined) target[name] = value;
}

function setProxyAlias(
  target: Record<string, string>,
  upper: string,
  lower: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    delete target[upper];
    delete target[lower];
    return;
  }
  target[upper] = value;
  target[lower] = value;
}

function normalizeHosts(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return value.split(",").map((host) => host.trim());
  return [...value].map((host) => host.trim());
}

/**
 * Wraps fetch with the same explicit proxy contract used by the OpenCode
 * child. OpenCode's server is loopback-only, so an absent loopback NO_PROXY
 * entry fails before a request can fall back to ambient Bun/Node proxy
 * variables. The default returned fetch uses node:http/node:https directly,
 * so an ambient or proxy-aware global fetch cannot intercept loopback traffic.
 * An injected `directFetch` is a test/transport hook and must have the same
 * direct-loopback contract.
 */
export function createOpenCodeFetch(
  environment: Readonly<Record<string, string>>,
  directFetch: OpenCodeFetch = directLoopbackFetch,
): OpenCodeFetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const hostname = new URL(request.url).hostname;
    const noProxy = environment.NO_PROXY ?? environment.no_proxy ?? "";
    if (!noProxy.split(",").some((entry) => matchesNoProxy(hostname, entry.trim()))) {
      throw new Error(`OpenCode URL ${hostname} is absent from explicit NO_PROXY configuration`);
    }
    if (!isLoopbackHostname(hostname)) {
      throw new Error(`OpenCode URL ${hostname} is not a loopback address`);
    }
    return directFetch(request);
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

async function directLoopbackFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported OpenCode URL protocol ${url.protocol}`);
  }
  const body =
    request.body === null || request.method === "GET" || request.method === "HEAD"
      ? undefined
      : Buffer.from(await request.arrayBuffer());
  if (request.signal.aborted) throw requestAbortReason(request.signal);

  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise<Response>((resolve, reject) => {
    let responseStarted = false;
    let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let response: import("node:http").IncomingMessage | undefined;
    let clientRequest: ReturnType<typeof httpRequest> | undefined;
    const onAbort = (): void => {
      const error = requestAbortReason(request.signal);
      clientRequest?.destroy(error);
      response?.destroy(error);
      if (responseController) responseController.error(error);
      if (!responseStarted) reject(error);
    };
    clientRequest = transport(
      {
        hostname,
        port: url.port ? Number(url.port) : undefined,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
      },
      (incomingResponse) => {
        response = incomingResponse;
        responseStarted = true;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incomingResponse.headers)) {
          if (value !== undefined) {
            responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
        }
        const responseBody = new ReadableStream<Uint8Array>({
          start(controller) {
            responseController = controller;
            incomingResponse.on("data", (chunk: Buffer | string) =>
              controller.enqueue(
                typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk),
              ),
            );
            incomingResponse.on("end", () => {
              request.signal.removeEventListener("abort", onAbort);
              controller.close();
            });
            incomingResponse.on("error", (error) => controller.error(error));
          },
          cancel() {
            incomingResponse.destroy();
          },
        });
        try {
          const status = response.statusCode ?? 500;
          if (status === 204 || status === 205 || status === 304) {
            incomingResponse.resume();
            request.signal.removeEventListener("abort", onAbort);
            resolve(
              new Response(null, {
                status,
                statusText: response.statusMessage,
                headers: responseHeaders,
              }),
            );
            return;
          }
          resolve(
            new Response(responseBody, {
              status,
              statusText: response.statusMessage,
              headers: responseHeaders,
            }),
          );
        } catch (error) {
          response.destroy();
          reject(error);
        }
      },
    );
    clientRequest.on("error", (error) => {
      if (!responseStarted) reject(error);
      else responseController?.error(error);
    });
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    if (body) clientRequest.write(body);
    clientRequest.end();
  });
}

function requestAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === "string" ? signal.reason : "OpenCode request aborted");
}

function matchesNoProxy(hostname: string, entry: string): boolean {
  if (!entry) return false;
  if (entry === "*") return true;
  const normalized = entry.toLowerCase();
  const value = hostname.toLowerCase();
  return normalized.startsWith(".")
    ? value.endsWith(normalized)
    : value === normalized || value.endsWith(`.${normalized}`);
}
