import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { PrometheusMetricStore } from "../src/adapters/compatibility";
import { CoordinatorHealthServer } from "../src/adapters/health";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("test server did not receive a TCP address");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

describe("coordinator health server", () => {
  it("serves health, readiness, and Prometheus metrics endpoints", async () => {
    const metrics = new PrometheusMetricStore();
    await metrics.observe({
      type: "counter",
      name: "rehor_cycles_total",
      labels: { status: "ok" },
      value: 1,
    });
    const server = new CoordinatorHealthServer({
      port: await freePort(),
      host: "127.0.0.1",
      metrics,
    });
    await server.start();
    const port = server.port;
    if (port === undefined) throw new Error("health server did not start");

    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: "ok" });

      const notReady = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(notReady.status).toBe(503);
      expect(await notReady.json()).toEqual({ ready: false });

      server.setReady(true);
      const ready = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ ready: true });

      const response = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('rehor_cycles_total{status="ok"} 1');
    } finally {
      await server.close();
    }
  });
});
