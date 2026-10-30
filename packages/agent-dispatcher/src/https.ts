import { request } from "node:https";

export type HttpRequest = {
  url: URL;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  ca?: Buffer;
};

export type HttpResponse = { status: number; body: string };
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

// No redirects, retries, response headers, or network error details are exposed.
export const httpsRequest: HttpClient = async (options) => {
  if (options.url.protocol !== "https:") throw new Error("HTTPS required");
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: HttpResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const client = request(options.url, {
      method: options.method,
      headers: options.headers,
      ca: options.ca,
      rejectUnauthorized: true,
      agent: false,
    }, (response) => {
      response.on("error", () => finish(new Error("HTTPS request failed")));
      response.on("aborted", () => finish(new Error("HTTPS request failed")));
      if (options.method === "GET") {
        // Preflight needs only the status. Close the non-reused connection rather
        // than buffering or draining an untrusted, possibly endless body.
        finish(undefined, { status: response.statusCode ?? 0, body: "" });
        response.destroy();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          finish(new Error("HTTPS response too large"));
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(undefined, {
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    const timer = setTimeout(() => {
      finish(new Error("HTTPS request timed out"));
      client.destroy();
    }, 5_000);
    client.on("error", () => finish(new Error("HTTPS request failed")));
    client.end(options.body);
  });
};
