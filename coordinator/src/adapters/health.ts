import { createServer, type Server } from "node:http";

import type { PrometheusMetricStore } from "./compatibility";

export interface HealthServerOptions {
  host?: string;
  port: number;
  metrics: PrometheusMetricStore;
}

/** Small process-health surface for local Compose and container probes. */
export class CoordinatorHealthServer {
  private readonly server: Server;
  private ready = false;

  constructor(private readonly options: HealthServerOptions) {
    this.server = createServer((request, response) => {
      const path = request.url?.split("?", 1)[0];
      if (path === "/metrics") {
        response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        response.end(options.metrics.render());
        return;
      }
      if (path === "/health" || path === "/healthz") {
        writeJson(response, 200, { status: "ok" });
        return;
      }
      if (path === "/ready" || path === "/readyz") {
        writeJson(response, this.ready ? 200 : 503, { ready: this.ready });
        return;
      }
      response.writeHead(404);
      response.end();
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.port, this.options.host ?? "0.0.0.0");
    });
  }

  setReady(value: boolean): void {
    this.ready = value;
  }

  get port(): number | undefined {
    const address = this.server.address();
    return address !== null && typeof address !== "string" ? address.port : undefined;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function writeJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
