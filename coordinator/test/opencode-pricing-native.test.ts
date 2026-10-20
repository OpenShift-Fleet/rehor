import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event as OpenCodeEvent } from "@opencode-ai/sdk";
import { expect, it } from "vitest";
import { createEventFactory, parseRehorRun, type Usage } from "../src/domain";
import {
  createNormalizationContext,
  normalizeOpenCodeEvent,
} from "../src/runtimes/opencode-v1/normalizer";
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

/** Small protocol fixtures exercise the real bundled/native SDKs, not a fake provider. */
function mockStream(provider: string, model: string): string {
  const event = (type: string, fields: Record<string, unknown> = {}) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  if (provider === "vertex") {
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
  }
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
      model: "gpt-6-luna",
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
    `data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4.1",
      choices,
      usage,
    })}\n\n`;
  return (
    chunk([{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }]) +
    chunk([{ index: 0, delta: {}, finish_reason: "stop" }]) +
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

// Opt-in smoke against the pinned native executable. The only model endpoint is
// this credential-free loopback mock; no provider API or paid inference is used.
it.skipIf(!process.env.REHOR_TEST_OPENCODE_BINARY).each(cases)(
  "prices native $provider/$model step tokens from a loopback mock",
  async (testCase) => {
    const binary = process.env.REHOR_TEST_OPENCODE_BINARY;
    if (!binary) throw new Error("REHOR_TEST_OPENCODE_BINARY required");
    expect(
      spawnSync(binary, ["--version"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      }).stdout.trim(),
    ).toBe("1.18.29");
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
      res.end(mockStream(testCase.provider, testCase.model));
    });
    // Exercise the production adapter's fixed proxy port, not a relaxed test adapter.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(testCase.provider === "vertex" ? 8443 : 0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock address missing");
    try {
      // Build first: use the real renderer and the packaged file:// Vertex adapter.
      const { loadOpenCodeDeploymentConfig, renderOpenCodeV1ConfigForCycle } = (await import(
        new URL("../dist/index.js", import.meta.url).href
      )) as typeof import("../src");
      const rendered = renderOpenCodeV1ConfigForCycle(
        { model: testCase.model },
        testCase.provider,
        await loadOpenCodeDeploymentConfig(),
        undefined,
        [testCase.model],
      );
      const config = { ...rendered.config, snapshot: false };
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          binary,
          ["run", "--format", "json", "--title", "Offline pricing smoke", "--pure", "Say hello"],
          {
            cwd: home,
            env: {
              PATH: process.env.PATH,
              HOME: home,
              XDG_CONFIG_HOME: join(home, "config"),
              XDG_DATA_HOME: join(home, "data"),
              XDG_CACHE_HOME: join(home, "cache"),
              XDG_STATE_HOME: join(home, "state"),
              OPENCODE_TEST_HOME: home,
              OPENCODE_AUTH_CONTENT: "{}",
              OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
              OPENCODE_DISABLE_MODELS_FETCH: "1",
              OPENCODE_DISABLE_AUTOUPDATE: "1",
              OPENCODE_DISABLE_PROJECT_CONFIG: "1",
              OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
              OPENCODE_PURE: "1",
              REHOR_VERTEX_PROXY_URL: `http://127.0.0.1:${address.port}`,
              REHOR_MODEL_PROXY_URL: `http://127.0.0.1:${address.port}/v1`,
              REHOR_MODEL_PROXY_TOKEN: "mock",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`native smoke timed out: ${stderr}`));
        }, 20000);
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout));
        });
      });
      const steps = output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "step_finish");
      expect(requests).toHaveLength(1);
      if (testCase.provider === "vertex") {
        expect(requests[0]).toMatchObject({
          path: `/v1/projects/dummy-project/locations/dummy-region/publishers/anthropic/models/${testCase.model}:streamRawPredict`,
          authorization: "Bearer rehor-proxy-placeholder",
          body: { anthropic_version: "vertex-2023-10-16", stream: true },
        });
      } else {
        expect(requests[0]?.path).toBe(
          testCase.provider === "rehor-openai" ? "/v1/responses" : "/v1/chat/completions",
        );
      }
      expect(steps).toHaveLength(1);
      const part = steps[0].part;
      expect(part.cost).toBe(0); // Native custom-provider pricing is missing.
      expect(part.tokens).toMatchObject({
        input: testCase.input,
        output: testCase.output,
        reasoning: testCase.reasoning,
        cache: { read: testCase.read, write: testCase.write },
      });
      const model = `${testCase.provider}/${testCase.model}`;
      const run = {
        ...parseRehorRun(runFixture),
        provider: { id: testCase.provider, requestedModel: model },
      };
      const factory = createEventFactory(run, "native-smoke");
      const context = createNormalizationContext(part.sessionID, model);
      normalizeOpenCodeEvent(
        {
          type: "message.updated",
          properties: {
            info: {
              id: part.messageID,
              sessionID: part.sessionID,
              role: "assistant",
              providerID: testCase.provider,
              modelID: testCase.model,
              time: { completed: 1 },
              cost: 0,
            },
          },
        } as unknown as OpenCodeEvent,
        factory,
        context,
      );
      const normalized = normalizeOpenCodeEvent(
        { type: "message.part.updated", properties: { part } } as OpenCodeEvent,
        factory,
        context,
      );
      const usage = normalized.events.find((event) => event.kind === "usage")?.payload as
        | Usage
        | undefined;
      expect(usage).toMatchObject({
        estimated: true,
        incomplete: false,
        tokenCounts: { cacheWrite: testCase.write },
      });
      expect(usage?.cost?.amount).toBeCloseTo(testCase.amount, 10);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  30000,
);
