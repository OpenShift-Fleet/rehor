import { Agent, fetch } from "undici";

export type HttpRequest = {
  url: URL;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  ca?: Buffer;
};

export type HttpResponse = { status: number; body: string };
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

// Carries whether a request failed to connect or timed out, so callers can
// categorize network failures without message parsing.
export class HttpRequestError extends Error {
  constructor(message: string, readonly failure: "network" | "timeout") {
    super(message);
  }
}

// No redirects, retries, response headers, or network error details are exposed.
export const httpsRequest: HttpClient = async (options) => {
  if (options.url.protocol !== "https:") throw new Error("HTTPS required");
  // A dedicated agent per request pins the CA (the in-cluster API server's,
  // for TokenRequest) to exactly this connection, forces certificate
  // verification regardless of NODE_TLS_REJECT_UNAUTHORIZED, and never
  // shares or reuses sockets with other requests.
  const dispatcher = new Agent({ connect: { ca: options.ca, rejectUnauthorized: true } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const failure = () => new HttpRequestError(controller.signal.aborted ? "HTTPS request timed out" : "HTTPS request failed", controller.signal.aborted ? "timeout" : "network");
  try {
    let response;
    try {
      response = await fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        redirect: "manual",
        signal: controller.signal,
        dispatcher,
      });
    } catch {
      throw failure();
    }
    if (options.method === "GET") {
      const status = response.status;
      // Preflight needs only the status. Cancel the body to close the
      // connection rather than draining it.
      void response.body?.cancel().catch(() => {});
      return { status, body: "" };
    }
    let body = "";
    try {
      body = await response.text();
    } catch {
      throw failure();
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    void dispatcher.close().catch(() => {});
  }
};
