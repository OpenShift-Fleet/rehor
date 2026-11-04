import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode, type OpenCodeEvent } from "@opencode/client";
import { expect, it } from "vitest";

// Build first: this tests the shipped renderer and adapter, including aisdk: dispatch.
it.skipIf(!process.env.REHOR_TEST_OPENCODE_BINARY)(
  "loads the rendered V2 Vertex factory and streams inference through loopback without ADC",
  async () => {
    const binary = process.env.REHOR_TEST_OPENCODE_BINARY;
    if (!binary) throw new Error("REHOR_TEST_OPENCODE_BINARY required");
    expect(spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe(
      "opencode v2.1.2",
    );
    const { renderOpenCodeConfig } = (await import(
      /* @vite-ignore */ new URL("../dist/index.js", import.meta.url).href
    )) as typeof import("../src/index");
    const model = "claude-sonnet-4-6";
    const home = await mkdtemp(join(tmpdir(), "rehor-vertex-native-"));
    const requests: { path: string; authorization?: string; body: unknown }[] = [];
    const event = (type: string, fields: Record<string, unknown> = {}) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body: JSON.parse(body),
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          event("message_start", {
            message: {
              id: "msg_mock",
              role: "assistant",
              model,
              content: [],
              usage: {
                input_tokens: 1000,
                cache_read_input_tokens: 2000,
                cache_creation_input_tokens: 3000,
              },
            },
          }),
          event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
          event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello" } }),
          event("content_block_stop", { index: 0 }),
          event("message_delta", {
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 100 },
          }),
          event("message_stop"),
        ].join(""),
      );
    });
    const rendered = renderOpenCodeConfig({
      providerId: "vertex",
      model,
      smallModel: `vertex/${model}`,
      providers: [
        {
          id: "vertex",
          settings: { baseURL: "http://127.0.0.1:8443" },
          models: { [model]: { limit: { context: 200000, output: 32000 } } },
        },
      ],
    });
    expect(rendered.config.providers).toMatchObject({
      vertex: { package: `aisdk:${new URL("../dist/vertex-provider.js", import.meta.url).href}` },
    });
    const configPath = join(home, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify({
        ...rendered.config,
        update: "disable",
        snapshots: false,
        share: "disabled",
        lsp: false,
      }),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(8443, "127.0.0.1", resolve);
    });
    const password = randomBytes(32).toString("hex");
    const child = spawn(binary, ["serve", "--stdio", "--hostname=127.0.0.1", "--port=0"], {
      cwd: home,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"),
        XDG_STATE_HOME: join(home, "state"),
        OPENCODE_PASSWORD: password,
        OPENCODE_DB: join(home, "opencode.db"),
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_PROJECT_DISABLE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_FFF: "1",
        GOOGLE_APPLICATION_CREDENTIALS: join(home, "nonexistent-adc.json"),
        GOOGLE_VERTEX_PROJECT: "must-not-use-project",
        GOOGLE_VERTEX_LOCATION: "must-not-use-location",
        NPM_CONFIG_OFFLINE: "true",
        npm_config_offline: "true",
      },
    });
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
    const controller = new AbortController();
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
          for (const line of output.split("\n")) {
            try {
              const info = JSON.parse(line);
              if (typeof info.url === "string") resolve(info.url);
            } catch {
              /* Partial line. */
            }
          }
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`Native startup failed: ${diagnostics}`)));
      });
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(18000)]);
      const client = OpenCode.make({
        baseUrl: url,
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
      });
      const iterator = client.event.subscribe({ signal })[Symbol.asyncIterator]();
      await iterator.next();
      const session = await client.session.create(
        {
          title: "Vertex factory smoke",
          location: { directory: home },
          model: { providerID: "vertex", id: model },
        },
        { signal },
      );
      await client.session.prompt({ sessionID: session.id, text: "Say hello" }, { signal });
      const observed: OpenCodeEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new Error("Native stream ended before completion");
        const event = next.value;
        if (!("sessionID" in event.data) || event.data.sessionID !== session.id) continue;
        observed.push(event);
        if (event.type === "session.execution.failed") throw new Error(JSON.stringify(event));
        if (event.type === "session.execution.succeeded") break;
      }
      expect(requests).toEqual([
        expect.objectContaining({
          path: `/v1/projects/dummy-project/locations/dummy-region/publishers/anthropic/models/${model}:streamRawPredict`,
          authorization: "Bearer rehor-proxy-placeholder",
          body: expect.objectContaining({ anthropic_version: "vertex-2023-10-16", stream: true }),
        }),
      ]);
      expect(observed.find((event) => event.type === "session.step.ended")?.data).toMatchObject({
        tokens: { input: 1000, output: 100, cache: { read: 2000, write: 3000 } },
      });
      expect(
        JSON.stringify(await client.message.list({ sessionID: session.id }, { signal })),
      ).toContain("hello");
      controller.abort();
      await iterator.return?.();
    } finally {
      controller.abort();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      clearTimeout(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
