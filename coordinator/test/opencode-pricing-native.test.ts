import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode, type OpenCodeEvent } from "@opencode/client";
import { expect, it } from "vitest";
import { createEventFactory, parseRehorRun, type Usage } from "../src/domain";
import {
  createNormalizationContext,
  normalizeOpenCodeEvent,
} from "../src/runtimes/opencode/normalizer";
import { reconcileSession } from "../src/runtimes/opencode/reconcile";
import runFixture from "./fixtures/rehor-run.v1.json";

const cases = [
  {
    provider: "rehor-openai-chat",
    model: "gpt-4.1",
    input: 200,
    output: 80,
    reasoning: 20,
    read: 800,
    write: 0,
    amount: 0.0016,
    failed: false,
  },
  {
    provider: "rehor-openai-chat",
    model: "gpt-4.1",
    input: 200,
    output: 80,
    reasoning: 20,
    read: 800,
    write: 0,
    amount: 0.0016,
    failed: true,
  },
  {
    provider: "rehor-openai",
    model: "gpt-6-luna",
    input: 200,
    output: 80,
    reasoning: 20,
    read: 800,
    write: 0,
    amount: 0.000078,
  },
  {
    provider: "vertex",
    model: "claude-sonnet-4-6",
    input: 1000,
    output: 100,
    reasoning: 50,
    read: 2000,
    write: 3000,
    amount: 0.0171,
  },
  {
    provider: "vertex",
    model: "claude-haiku-4-5",
    input: 1000,
    output: 100,
    reasoning: 50,
    read: 2000,
    write: 3000,
    amount: 0.0057,
  },
] as const;

/** Protocol fixtures exercise the real native provider SDKs via loopback only. */
function mockStream(provider: string, model: string, failed = false): string {
  const event = (type: string, fields: Record<string, unknown> = {}) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  if (provider === "vertex")
    return [
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
      event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      event("content_block_delta", {
        index: 0,
        delta: { type: "thinking_delta", thinking: "think" },
      }),
      event("content_block_delta", {
        index: 0,
        delta: { type: "signature_delta", signature: "mock-signature" },
      }),
      event("content_block_stop", { index: 0 }),
      event("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
      event("content_block_delta", { index: 1, delta: { type: "text_delta", text: "hello" } }),
      event("content_block_stop", { index: 1 }),
      event("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 150, output_tokens_details: { thinking_tokens: 50 } },
      }),
      event("message_stop"),
    ].join("");
  if (provider === "rehor-openai") {
    const item = {
      type: "message",
      id: "msg_mock",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    };
    const response = {
      id: "resp_mock",
      object: "response",
      created_at: 1,
      model,
      status: "completed",
      output: [item],
      incomplete_details: null,
      usage: {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 800 },
        output_tokens: 100,
        output_tokens_details: { reasoning_tokens: 20 },
        total_tokens: 1100,
      },
    };
    return [
      event("response.created", { response: { ...response, status: "in_progress", output: [] } }),
      event("response.output_item.added", {
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      }),
      event("response.output_text.delta", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: "hello",
      }),
      event("response.output_item.done", { output_index: 0, item }),
      event("response.completed", { response }),
    ].join("");
  }
  const chunk = (choices: unknown[], usage?: unknown) =>
    `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, model, choices, usage })}\n\n`;
  return (
    chunk([{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }]) +
    chunk([{ index: 0, delta: {}, finish_reason: failed ? "content_filter" : "stop" }]) +
    chunk([], {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      prompt_tokens_details: { cached_tokens: 800 },
      completion_tokens_details: { reasoning_tokens: 20 },
    }) +
    "data: [DONE]\n\n"
  );
}

// Build first for the shipped renderer and aisdk:file:// Vertex adapter. The execution pin is
// independent of pricing.json's intentionally retained catalog provenance.
it.skipIf(!process.env.REHOR_TEST_OPENCODE_BINARY).each(cases)(
  "prices native V2 $provider/$model events and reconciles persisted messages",
  async (testCase) => {
    const binary = process.env.REHOR_TEST_OPENCODE_BINARY;
    if (!binary) throw new Error("REHOR_TEST_OPENCODE_BINARY required");
    expect(
      spawnSync(binary, ["--version"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      }).stdout.trim(),
    ).toBe("opencode v2.1.2");
    const { renderOpenCodeConfig } = (await import(
      /* @vite-ignore */ new URL("../dist/index.js", import.meta.url).href
    )) as typeof import("../src/index");
    const home = await mkdtemp(join(tmpdir(), "rehor-pricing-smoke-"));
    const requests: { path: string; authorization?: string; body: Record<string, unknown> }[] = [];
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
        mockStream(testCase.provider, testCase.model, "failed" in testCase && testCase.failed),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(testCase.provider === "vertex" ? 8443 : 0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock address missing");
    const password = randomBytes(32).toString("hex");
    const vertex = testCase.provider === "vertex";
    const requestedModel = `${testCase.provider}/${testCase.model}`;
    const rendered = renderOpenCodeConfig({
      providerId: testCase.provider,
      model: testCase.model,
      smallModel: requestedModel,
      providers: [
        {
          id: testCase.provider,
          ...(vertex
            ? {}
            : {
                package:
                  testCase.provider === "rehor-openai"
                    ? "@opencode/ai/providers/openai/responses"
                    : "@opencode/ai/providers/openai-compatible",
              }),
          settings: {
            baseURL: `http://127.0.0.1:${address.port}${vertex ? "" : "/v1"}`,
            ...(vertex ? {} : { apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}" }),
          },
          models: {
            [testCase.model]: {
              name: testCase.model,
              limit: { context: 200000, output: 32000 },
              capabilities: { reasoning: { supported: true } },
            },
          },
        },
      ],
    });
    if (vertex)
      expect(rendered.config.providers).toMatchObject({
        vertex: { package: `aisdk:${new URL("../dist/vertex-provider.js", import.meta.url).href}` },
      });
    const configPath = join(home, "opencode.json");
    await writeFile(configPath, rendered.json);
    const child = spawn(
      binary,
      ["serve", "--stdio", "--hostname=127.0.0.1", "--port=0", "--print-logs", "--log-level=debug"],
      {
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
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_FFF: "1",
          OPENCODE_CONFIG_PROJECT_DISABLE: "1",
          OPENCODE_CONFIG: configPath,
          REHOR_MODEL_PROXY_TOKEN: "mock",
        },
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
    const streamController = new AbortController();
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
        child.once("exit", () => reject(new Error(`native startup failed: ${stderr}`)));
      });
      const client = OpenCode.make({
        baseUrl: url,
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
      });
      const signal = AbortSignal.timeout(18000);
      await expect
        .poll(
          async () =>
            JSON.stringify(
              await client.provider.list({ location: { directory: home } }, { signal }),
            ),
          { timeout: 5000 },
        )
        .toContain(testCase.provider);
      const iterator = client.event
        .subscribe({ signal: AbortSignal.any([signal, streamController.signal]) })
        [Symbol.asyncIterator]();
      await iterator.next();
      const session = await client.session.create(
        {
          title: "Offline pricing smoke",
          location: { directory: home },
          model: { providerID: testCase.provider, id: testCase.model },
        },
        { signal },
      );
      const run = {
        ...parseRehorRun(runFixture),
        provider: { id: testCase.provider, requestedModel },
      };
      const factory = createEventFactory(run, "native-smoke");
      const context = createNormalizationContext(session.id, requestedModel);
      const observed: OpenCodeEvent[] = [];
      const expectedOutcome = "failed" in testCase && testCase.failed ? "failed" : "completed";
      const normalizedEvents = [];
      let usage: Usage | undefined;
      await client.session.prompt({ sessionID: session.id, text: "Say hello" }, { signal });
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new Error("native stream ended before terminal execution");
        const event = next.value;
        if (!("sessionID" in event.data) || event.data.sessionID !== session.id) continue;
        observed.push(event);
        const normalized = normalizeOpenCodeEvent(event, factory, context);
        normalizedEvents.push(...normalized.events);
        const update = normalized.events.find((event) => event.kind === "usage")?.payload as
          | Usage
          | undefined;
        usage = update ?? usage;
        if (normalized.outcome) {
          expect(normalized.outcome, JSON.stringify(observed)).toBe(expectedOutcome);
          break;
        }
      }
      expect(requests).toHaveLength(1);
      if (vertex)
        expect(requests[0]).toMatchObject({
          path: `/v1/projects/dummy-project/locations/dummy-region/publishers/anthropic/models/${testCase.model}:streamRawPredict`,
          authorization: "Bearer rehor-proxy-placeholder",
          body: { anthropic_version: "vertex-2023-10-16", stream: true },
        });
      else
        expect(requests[0]?.path).toBe(
          testCase.provider === "rehor-openai" ? "/v1/responses" : "/v1/chat/completions",
        );
      const steps = observed.filter(
        (event) =>
          event.type ===
          (expectedOutcome === "failed" ? "session.step.failed" : "session.step.ended"),
      );
      expect(steps).toHaveLength(1);
      expect(steps[0]?.data).toMatchObject({
        cost: 0,
        tokens: {
          input: testCase.input,
          output: testCase.output,
          reasoning: testCase.reasoning,
          cache: { read: testCase.read, write: testCase.write },
        },
      });
      expect(usage).toMatchObject({
        estimated: true,
        incomplete: false,
        cost: { source: "estimated" },
        tokenCounts: { cacheWrite: testCase.write },
      });
      expect(usage?.cost?.amount).toBeCloseTo(testCase.amount, 10);
      expect(normalizedEvents.map((event) => event.sequence)).toEqual(
        [...normalizedEvents.map((event) => event.sequence)].sort((a, b) => a - b),
      );
      const usageEvent = normalizedEvents.find((event) => event.kind === "usage");
      expect(usageEvent?.payload).toMatchObject({ partial: true, final: false, incomplete: true });
      expect(usageEvent?.parentEventId).toBe(
        normalizedEvents.find((event) => event.kind === "model")?.eventId,
      );
      expect([...context.resultTextParts.values()].join("")).toBe("hello");
      // Fresh context proves recovery needs neither SSE history nor session.log.
      const recovered = await reconcileSession(
        { client, sessionId: session.id, directory: home, controller: new AbortController() },
        factory,
        createNormalizationContext(session.id, requestedModel),
        3000,
        100,
      );
      expect(
        recovered,
        JSON.stringify(
          await client.message.list(
            { sessionID: session.id, limit: 100, order: "desc" },
            { signal },
          ),
        ),
      ).toMatchObject({ outcome: expectedOutcome, turns: 1, resultText: "hello" });
      expect(
        (recovered.events.filter((event) => event.kind === "usage").at(-1)?.payload as Usage)?.cost
          ?.amount,
      ).toBeCloseTo(testCase.amount, 10);

      // Missing-provider failure must survive reconciliation without an assistant.
      const failed = await client.session.create(
        {
          title: "Offline failure smoke",
          location: { directory: home },
          model: { providerID: "missing-provider", id: "none" },
        },
        { signal },
      );
      await client.session.prompt(
        { sessionID: failed.id, text: "No upstream request possible" },
        { signal },
      );
      for (;;) {
        const next = await iterator.next();
        if (next.done) throw new Error("failure stream ended");
        if (
          next.value.type === "session.execution.failed" &&
          next.value.data.sessionID === failed.id
        )
          break;
      }
      const recoveredFailure = await reconcileSession(
        { client, sessionId: failed.id, controller: new AbortController() },
        factory,
        createNormalizationContext(failed.id, requestedModel),
        3000,
        100,
      );
      expect(recoveredFailure).toMatchObject({ outcome: "failed", turns: 0 });
      expect(recoveredFailure.reason).toContain("missing-provider");
      streamController.abort();
      await iterator.return?.();
    } finally {
      streamController.abort();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      clearTimeout(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
