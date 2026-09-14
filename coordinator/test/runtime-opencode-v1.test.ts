import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Event as OpenCodeEvent, OpencodeClient } from "@opencode-ai/sdk";
import { describe, expect, it } from "vitest";
import { parseRehorEvent, type RehorEvent, type RehorRun } from "../src/domain";
import {
  appendBoundedOpenCodeOutput,
  buildOpenCodeEnvironment,
  HttpOpenCodeReadiness,
  hashOpenCodeConfig,
  type OpenCodeClientFactory,
  OpenCodeReadinessError,
  type OpenCodeServerController,
  type OpenCodeServerInfo,
  OpenCodeServerSupervisor,
  type OpenCodeSpawn,
  OpenCodeV1Runtime,
} from "../src/runtimes/opencode-v1";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1234;
  killedWith?: NodeJS.Signals;

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal;
    this.emit("exit", null, signal ?? "SIGTERM");
    this.emit("close", null, signal ?? "SIGTERM");
    return true;
  }
}

const runtimeRun: RehorRun = {
  schemaVersion: "1",
  runId: "run-opencode",
  attemptId: "attempt-opencode",
  instanceId: "instance-opencode",
  label: "test",
  workflowId: "test-workflow",
  prompt: "Say hello",
  task: null,
  worktree: {
    path: "/worktree",
    repository: "https://example.invalid/rehor",
    snapshot: { ref: "refs/heads/test", commitSha: "commit", dirty: false },
  },
  instructionHash: { algorithm: "sha256", value: "1".repeat(64) },
  configHash: { algorithm: "sha256", value: "2".repeat(64) },
  policyHash: { algorithm: "sha256", value: "3".repeat(64) },
  provider: { id: "rehor-openai", requestedModel: "rehor-openai/gpt-5.6-luna" },
  limits: { timeoutMs: 5_000, maxTurns: 10 },
  preflightPayloadRef: null,
};

function asOpenCodeEvent(value: unknown): OpenCodeEvent {
  return value as OpenCodeEvent;
}

async function* streamEvents(
  events: OpenCodeEvent[],
  error?: Error,
): AsyncGenerator<OpenCodeEvent> {
  yield* events;
  if (error) throw error;
}

interface FakeRuntimeOptions {
  events: OpenCodeEvent[];
  streamError?: Error;
  messages?: unknown[];
  sessionStatus?: Record<string, unknown>;
  omitConfigHash?: boolean;
  deleteError?: Error;
  abortError?: Error;
}

interface FactoryCall {
  server: OpenCodeServerInfo;
  directory: string;
  environment: Readonly<Record<string, string>>;
}

function fakeRuntime(options: FakeRuntimeOptions) {
  const calls = {
    abort: 0,
    delete: 0,
    messages: 0,
    stop: 0,
    pathGet: [] as unknown[],
    subscribe: [] as unknown[],
    create: [] as unknown[],
    prompt: [] as unknown[],
    messageRequests: [] as unknown[],
    statusRequests: [] as unknown[],
    abortRequests: [] as unknown[],
    deleteRequests: [] as unknown[],
    factory: [] as FactoryCall[],
  };
  const server: OpenCodeServerInfo = {
    baseUrl: "http://127.0.0.1:41236",
    hostname: "127.0.0.1",
    port: 41236,
    healthy: true,
    version: "1.18.29",
    ...(options.omitConfigHash ? {} : { configHash: runtimeRun.configHash.value }),
    capabilities: ["sse", "sessions"],
  };
  let activeServer: OpenCodeServerInfo | undefined;
  const crashController = new AbortController();
  const supervisor: OpenCodeServerController = {
    crashSignal: crashController.signal,
    get info() {
      return activeServer;
    },
    crashError: undefined,
    async start() {
      activeServer = server;
      return server;
    },
    async stop() {
      calls.stop += 1;
      activeServer = undefined;
    },
  };
  const client = {
    path: {
      get: async (request: unknown) => {
        calls.pathGet.push(request);
        return { data: { directory: runtimeRun.worktree.path } };
      },
    },
    event: {
      subscribe: async (request: unknown) => {
        calls.subscribe.push(request);
        return { stream: streamEvents(options.events, options.streamError) };
      },
    },
    session: {
      create: async (request: unknown) => {
        calls.create.push(request);
        return { data: { id: "session-opencode" } };
      },
      promptAsync: async (request: unknown) => {
        calls.prompt.push(request);
        return { data: {} };
      },
      messages: async (request: unknown) => {
        calls.messages += 1;
        calls.messageRequests.push(request);
        return { data: options.messages ?? [] };
      },
      status: async (request: unknown) => {
        calls.statusRequests.push(request);
        return {
          data: options.sessionStatus ?? { "session-opencode": { type: "busy" } },
        };
      },
      abort: async (request: unknown) => {
        calls.abort += 1;
        calls.abortRequests.push(request);
        if (options.abortError) throw options.abortError;
        return { data: {} };
      },
      delete: async (request: unknown) => {
        calls.delete += 1;
        calls.deleteRequests.push(request);
        if (options.deleteError) throw options.deleteError;
        return { data: {} };
      },
    },
  } as unknown as OpencodeClient;
  const clientFactory: OpenCodeClientFactory = (server, directory, environment) => {
    calls.factory.push({ server, directory, environment });
    return client;
  };
  const runtime = new OpenCodeV1Runtime({ supervisor, clientFactory });
  return { calls, runtime };
}

async function collect(events: AsyncIterable<RehorEvent>): Promise<RehorEvent[]> {
  const collected: RehorEvent[] = [];
  for await (const event of events) collected.push(event);
  for (const event of collected) {
    const parsed = parseRehorEvent(event);
    expect(parsed).toMatchObject({
      runId: runtimeRun.runId,
      attemptId: runtimeRun.attemptId,
      provider: runtimeRun.provider.id,
      workspace: {
        worktreePath: runtimeRun.worktree.path,
        repository: runtimeRun.worktree.repository,
        snapshot: runtimeRun.worktree.snapshot.commitSha,
      },
    });
  }
  expect(collected.filter((event) => event.kind === "terminal")).toHaveLength(1);
  expect(collected.at(-1)?.kind).toBe("terminal");
  const sequences = collected.map((event) => event.sequence);
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
  return collected;
}

describe("OpenCode environment", () => {
  it("copies only explicit runtime variables and makes proxy routing deterministic", () => {
    const environment = buildOpenCodeEnvironment({
      base: {
        PATH: "/bin",
        HOME: "/home/bot",
        HTTP_PROXY: "http://proxy:3128",
        HTTPS_PROXY: "http://proxy:3128",
        NO_PROXY: "memory-server,proxy",
        SECRET_TOKEN: "must-not-leak",
        REHOR_MODEL_PROXY_TOKEN: "explicitly-allowed",
      },
      passthrough: ["REHOR_MODEL_PROXY_TOKEN"],
      noProxyHosts: ["model-gateway"],
    });

    expect(environment).toMatchObject({
      PATH: "/bin",
      HOME: "/home/bot",
      HTTP_PROXY: "http://proxy:3128",
      http_proxy: "http://proxy:3128",
      HTTPS_PROXY: "http://proxy:3128",
      https_proxy: "http://proxy:3128",
      REHOR_MODEL_PROXY_TOKEN: "explicitly-allowed",
    });
    expect(environment.NO_PROXY).toContain("127.0.0.1");
    expect(environment.NO_PROXY).toContain("model-gateway");
    expect(environment.no_proxy).toBe(environment.NO_PROXY);
    expect(environment.SECRET_TOKEN).toBeUndefined();
  });

  it("preserves external proxy use while adding required internal bypasses", () => {
    const environment = buildOpenCodeEnvironment({
      base: { HTTP_PROXY: "http://proxy:3128", http_proxy: "http://proxy:3128" },
    });

    expect(environment.NO_PROXY.split(",")).toEqual(
      expect.arrayContaining([
        "127.0.0.1",
        "localhost",
        "devbot-proxy",
        "proxy",
        "model-gateway",
        "memory-server",
        "jira-proxy",
        "jira-mcp",
      ]),
    );
    expect(environment.HTTP_PROXY).toBe("http://proxy:3128");
  });
});

describe("OpenCode readiness", () => {
  it("requires healthy version and worktree path responses", async () => {
    const requests: string[] = [];
    const readiness = new HttpOpenCodeReadiness(async (request) => {
      requests.push(String(request));
      if (String(request).includes("/global/health")) {
        return new Response(JSON.stringify({ healthy: true, version: "1.18.29" }), { status: 200 });
      }
      return new Response(JSON.stringify({ directory: "/worktree" }), { status: 200 });
    });

    await expect(
      readiness.check("http://127.0.0.1:4096", "/worktree", new AbortController().signal),
    ).resolves.toEqual({ healthy: true, version: "1.18.29" });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("directory=%2Fworktree");
  });

  it("fails clearly when health is not ready", async () => {
    const readiness = new HttpOpenCodeReadiness(
      async () =>
        new Response(JSON.stringify({ healthy: false, version: "1.18.29" }), { status: 200 }),
    );

    await expect(
      readiness.check("http://127.0.0.1:4096", "/worktree", new AbortController().signal),
    ).rejects.toThrow(OpenCodeReadinessError);
  });
});

describe("OpenCode runtime", () => {
  it("normalizes a completed session and cleans up the session and server", async () => {
    const { calls, runtime } = fakeRuntime({
      omitConfigHash: true,
      events: [
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "message-1",
              sessionID: "session-opencode",
              role: "assistant",
              time: { created: 1 },
              modelID: "gpt-5.6-luna",
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-opencode",
              messageID: "message-1",
              type: "text",
              text: "hello",
            },
          },
        }),
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });

    await expect(runtime.start(new AbortController().signal)).resolves.toMatchObject({
      runtimeId: "opencode-v1",
      streaming: true,
    });
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(calls.factory).toHaveLength(1);
    expect(calls.factory[0]).toMatchObject({
      server: { baseUrl: "http://127.0.0.1:41236" },
      directory: runtimeRun.worktree.path,
    });
    expect(calls.factory[0]?.environment).toEqual(runtime.environment);
    expect(calls.pathGet[0]).toMatchObject({
      query: { directory: runtimeRun.worktree.path },
      responseStyle: "data",
      throwOnError: true,
    });
    expect(calls.subscribe[0]).toMatchObject({
      query: { directory: runtimeRun.worktree.path },
      signal: expect.any(AbortSignal),
      sseMaxRetryAttempts: 0,
    });
    expect(calls.create[0]).toMatchObject({
      query: { directory: runtimeRun.worktree.path },
      body: { title: `Rehor ${runtimeRun.runId}` },
      signal: expect.any(AbortSignal),
      responseStyle: "data",
      throwOnError: true,
    });
    expect(calls.prompt[0]).toMatchObject({
      path: { id: "session-opencode" },
      query: { directory: runtimeRun.worktree.path },
      body: {
        model: { providerID: "rehor-openai", modelID: "gpt-5.6-luna" },
        parts: [{ type: "text", text: runtimeRun.prompt }],
      },
      signal: expect.any(AbortSignal),
      responseStyle: "data",
      throwOnError: true,
    });
    const runSignal = (calls.subscribe[0] as { signal: AbortSignal }).signal;
    expect((calls.create[0] as { signal: AbortSignal }).signal).toBe(runSignal);
    expect((calls.prompt[0] as { signal: AbortSignal }).signal).toBe(runSignal);
    expect(runSignal.aborted).toBe(false);
    expect(calls.deleteRequests[0]).toMatchObject({
      path: { id: "session-opencode" },
      query: { directory: runtimeRun.worktree.path },
      responseStyle: "data",
      throwOnError: true,
    });
    expect(events.map((event) => event.kind)).toEqual(["run", "model", "model", "run", "terminal"]);
    expect(events.at(-1)?.payload).toMatchObject({ state: "completed", resultText: "hello" });
    expect(calls).toMatchObject({ abort: 0, delete: 1, messages: 0, stop: 1 });
  });

  it("fails the run when completed-session cleanup reports an SDK error", async () => {
    const { runtime } = fakeRuntime({
      deleteError: new Error("delete rejected"),
      events: [
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(events.find((event) => event.kind === "error")?.payload).toMatchObject({
      message: "delete rejected",
    });
    expect(events.at(-1)?.payload).toMatchObject({ state: "failed" });
  });

  it("counts each assistant message once, not each update or step", async () => {
    const message = {
      id: "assistant-message",
      sessionID: "session-opencode",
      role: "assistant",
      modelID: "gpt-5.6-luna",
    };
    const { runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({ type: "message.updated", properties: { info: message } }),
        asOpenCodeEvent({ type: "message.updated", properties: { info: message } }),
        asOpenCodeEvent({
          type: "message.part.updated",
          properties: {
            part: {
              id: "step-finish",
              messageID: "assistant-message",
              sessionID: "session-opencode",
              type: "step-finish",
              reason: "stop",
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: { ...message, time: { created: 1, completed: 2 } },
          },
        }),
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: { ...message, time: { created: 1, completed: 2 } },
          },
        }),
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(events.at(-1)?.payload).toMatchObject({ state: "completed", turns: 1 });
  });

  it("allows the maxTurns-th completed response to reach session idle", async () => {
    const { calls, runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "assistant-message",
              sessionID: "session-opencode",
              role: "assistant",
              modelID: "gpt-5.6-luna",
              time: { created: 1, completed: 2 },
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.part.updated",
          properties: {
            part: {
              id: "answer-part",
              messageID: "assistant-message",
              sessionID: "session-opencode",
              type: "text",
              text: "answer",
            },
          },
        }),
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    const run = { ...runtimeRun, limits: { ...runtimeRun.limits, maxTurns: 1 } };
    const events = await collect(runtime.run(run, new AbortController().signal));

    expect(events.at(-1)?.payload).toMatchObject({ state: "completed", turns: 1 });
    expect(calls.abort).toBe(0);
  });

  it("interrupts a new turn after maxTurns is reached", async () => {
    const { calls, runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "first-message",
              sessionID: "session-opencode",
              role: "assistant",
              modelID: "gpt-5.6-luna",
              time: { created: 1, completed: 2 },
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "second-message",
              sessionID: "session-opencode",
              role: "assistant",
              modelID: "gpt-5.6-luna",
              time: { created: 3 },
            },
          },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    const run = { ...runtimeRun, limits: { ...runtimeRun.limits, maxTurns: 1 } };
    const events = await collect(runtime.run(run, new AbortController().signal));

    expect(events.map((event) => event.kind)).toEqual(["run", "model", "persistence", "terminal"]);
    expect(events.at(-1)?.payload).toMatchObject({
      state: "timed_out",
      reason: "max_turns",
      turns: 1,
    });
    expect(calls.abort).toBe(1);
    expect(calls.abortRequests[0]).toMatchObject({
      path: { id: "session-opencode" },
      query: { directory: runtimeRun.worktree.path },
      responseStyle: "data",
      throwOnError: true,
    });
  });

  it("interrupts a step-start new turn after maxTurns is reached", async () => {
    const { calls, runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "first-message",
              sessionID: "session-opencode",
              role: "assistant",
              modelID: "gpt-5.6-luna",
              time: { created: 1, completed: 2 },
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.part.updated",
          properties: {
            part: {
              id: "second-step",
              messageID: "second-message",
              sessionID: "session-opencode",
              type: "step-start",
            },
          },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    const run = { ...runtimeRun, limits: { ...runtimeRun.limits, maxTurns: 1 } };
    const events = await collect(runtime.run(run, new AbortController().signal));

    expect(events.map((event) => event.kind)).toEqual(["run", "model", "persistence", "terminal"]);
    expect(events.at(-1)?.payload).toMatchObject({
      state: "timed_out",
      reason: "max_turns",
      turns: 1,
    });
    expect(calls.abort).toBe(1);
  });

  it("keeps user prompts and reasoning out of terminal result text", async () => {
    const { runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: { id: "user-message", sessionID: "session-opencode", role: "user" },
          },
        }),
        asOpenCodeEvent({
          type: "message.part.updated",
          properties: {
            part: {
              id: "user-part",
              messageID: "user-message",
              sessionID: "session-opencode",
              type: "text",
              text: "secret prompt",
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: { id: "assistant-message", sessionID: "session-opencode", role: "assistant" },
          },
        }),
        asOpenCodeEvent({
          type: "message.part.updated",
          properties: {
            part: {
              id: "reasoning-part",
              messageID: "assistant-message",
              sessionID: "session-opencode",
              type: "reasoning",
              text: "private reasoning",
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.part.updated",
          properties: {
            part: {
              id: "answer-part",
              messageID: "assistant-message",
              sessionID: "session-opencode",
              type: "text",
              text: "answer",
            },
          },
        }),
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(events.at(-1)?.payload).toMatchObject({ state: "completed", resultText: "answer" });
    expect(JSON.stringify(events)).not.toContain("secret prompt");
    expect(JSON.stringify(events.at(-1)?.payload)).not.toContain("private reasoning");
  });

  it("reconciles a disconnected stream from authoritative session messages", async () => {
    const { calls, runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "message-1",
              sessionID: "session-opencode",
              role: "assistant",
              time: { created: 1 },
              modelID: "gpt-5.6-luna",
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.part.updated",
          properties: {
            part: {
              id: "part-1",
              sessionID: "session-opencode",
              messageID: "message-1",
              type: "text",
              text: "hello",
            },
          },
        }),
      ],
      streamError: new Error("SSE disconnected"),
      sessionStatus: {},
      messages: [
        {
          info: {
            id: "message-1",
            sessionID: "session-opencode",
            role: "assistant",
            time: { created: 1, completed: 2 },
            modelID: "gpt-5.6-luna",
            finish: "stop",
            tokens: {
              input: 10,
              output: 2,
              reasoning: 1,
              cache: { read: 0, write: 0 },
            },
            cost: 0.01,
          },
          parts: [
            {
              id: "part-1",
              sessionID: "session-opencode",
              messageID: "message-1",
              type: "text",
              text: "hello",
            },
          ],
        },
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(calls.messages).toBe(1);
    expect(calls.messageRequests[0]).toMatchObject({
      path: { id: "session-opencode" },
      query: { directory: runtimeRun.worktree.path, limit: 100 },
      signal: expect.any(AbortSignal),
      responseStyle: "data",
      throwOnError: true,
    });
    expect(calls.statusRequests[0]).toMatchObject({
      query: { directory: runtimeRun.worktree.path },
      signal: expect.any(AbortSignal),
      responseStyle: "data",
      throwOnError: true,
    });
    expect(events.map((event) => event.kind)).toEqual([
      "run",
      "model",
      "model",
      "usage",
      "terminal",
    ]);
    expect(events.at(-1)?.payload).toMatchObject({ state: "completed", resultText: "hello" });
    const usage = events.find((event) => event.kind === "usage");
    expect(usage).toBeDefined();
    expect(usage?.model).toBe("gpt-5.6-luna");
    expect(usage?.payload).toMatchObject({
      requestedModel: "rehor-openai/gpt-5.6-luna",
      returnedModel: "gpt-5.6-luna",
      tokenCounts: { input: 10, output: 2, reasoning: 1 },
      final: true,
    });
    expect(usage?.parentEventId).toBe(events.find((event) => event.kind === "model")?.eventId);
    expect(events.some((event) => event.kind === "persistence")).toBe(false);
    expect(calls).toMatchObject({ abort: 0, delete: 1, stop: 1 });
  });

  it("emits cumulative usage so later projections retain earlier root and child turns", async () => {
    const { runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "root-message",
              sessionID: "session-opencode",
              role: "assistant",
              providerID: "rehor-openai",
              modelID: "gpt-5.6-luna",
              time: { created: 1, completed: 2 },
              tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
              cost: 0.01,
            },
          },
        }),
        asOpenCodeEvent({
          type: "session.created",
          properties: { info: { id: "child-session", parentID: "session-opencode" } },
        }),
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "child-message",
              sessionID: "child-session",
              role: "assistant",
              providerID: "rehor-openai",
              modelID: "gpt-5.6-luna",
              time: { created: 3, completed: 4 },
              tokens: { input: 5, output: 3, reasoning: 2, cache: { read: 1, write: 2 } },
              cost: 0.02,
            },
          },
        }),
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));
    const usageEvents = events.filter((event) => event.kind === "usage");

    expect(usageEvents).toHaveLength(2);
    expect(usageEvents.at(-1)?.payload).toMatchObject({
      requestedModel: "rehor-openai/gpt-5.6-luna",
      tokenCounts: { input: 15, output: 5, reasoning: 3, cacheRead: 1, cacheWrite: 2 },
      cost: { amount: 0.03, currency: "USD", source: "provider" },
      final: true,
    });
  });

  it("keeps cumulative usage in separate projection buckets for child models", async () => {
    const { runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "root-message",
              sessionID: "session-opencode",
              role: "assistant",
              providerID: "rehor-openai",
              modelID: "gpt-5.6-luna",
              time: { created: 1, completed: 2 },
              tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
              cost: 0.01,
            },
          },
        }),
        asOpenCodeEvent({
          type: "session.created",
          properties: { info: { id: "child-session", parentID: "session-opencode" } },
        }),
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "child-message",
              sessionID: "child-session",
              role: "assistant",
              providerID: "rehor-openai",
              modelID: "gpt-5.6-mini",
              time: { created: 3, completed: 4 },
              tokens: { input: 5, output: 3, reasoning: 2, cache: { read: 1, write: 2 } },
              cost: 0.02,
            },
          },
        }),
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));
    const usageEvents = events.filter((event) => event.kind === "usage");

    expect(usageEvents.map((event) => event.payload.requestedModel)).toEqual([
      "rehor-openai/gpt-5.6-luna",
      "rehor-openai/gpt-5.6-mini",
    ]);
    expect(usageEvents.at(-1)?.payload).toMatchObject({
      returnedModel: "gpt-5.6-mini",
      tokenCounts: { input: 5, output: 3, reasoning: 2, cacheRead: 1, cacheWrite: 2 },
      cost: { amount: 0.02, currency: "USD", source: "provider" },
      final: true,
    });
  });

  it("does not reconcile idle without a completed terminal assistant as success", async () => {
    const { calls, runtime } = fakeRuntime({
      events: [],
      streamError: new Error("SSE disconnected"),
      sessionStatus: {},
      messages: [
        {
          info: {
            id: "user-message",
            sessionID: "session-opencode",
            role: "user",
            time: { created: 1 },
          },
          parts: [],
        },
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(events.at(-1)?.payload).toMatchObject({ state: "interrupted" });
    expect(events.some((event) => event.kind === "persistence")).toBe(true);
    expect(calls.abort).toBe(1);
  });

  it("does not reconcile a completed tool-call turn as terminal success", async () => {
    const { runtime } = fakeRuntime({
      events: [],
      streamError: new Error("SSE disconnected"),
      sessionStatus: {},
      messages: [
        {
          info: {
            id: "message-1",
            sessionID: "session-opencode",
            role: "assistant",
            modelID: "gpt-5.6-luna",
            finish: "tool-calls",
            time: { created: 1, completed: 2 },
          },
          parts: [],
        },
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(events.at(-1)?.payload).toMatchObject({ state: "interrupted" });
  });

  it("does not complete from a finished message while the root session remains busy", async () => {
    const { runtime } = fakeRuntime({
      events: [],
      streamError: new Error("SSE disconnected"),
      sessionStatus: { "session-opencode": { type: "busy" } },
      messages: [
        {
          info: {
            id: "message-1",
            sessionID: "session-opencode",
            role: "assistant",
            time: { created: 1, completed: 2 },
            modelID: "gpt-5.6-luna",
            finish: "stop",
          },
          parts: [],
        },
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(events.at(-1)?.payload).toMatchObject({ state: "interrupted" });
  });

  it("tracks child sessions without letting child idle complete the root run", async () => {
    const { runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "session.created",
          properties: { info: { id: "child-session", parentID: "session-opencode" } },
        }),
        asOpenCodeEvent({
          type: "session.status",
          properties: { sessionID: "child-session", status: { type: "idle" } },
        }),
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "child-message",
              sessionID: "child-session",
              role: "assistant",
              modelID: "gpt-5.6-luna",
              time: { created: 1, completed: 2 },
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.part.updated",
          properties: {
            part: {
              id: "child-part",
              messageID: "child-message",
              sessionID: "child-session",
              type: "text",
              text: "child",
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "root-message",
              sessionID: "session-opencode",
              role: "assistant",
              modelID: "gpt-5.6-luna",
              time: { created: 1, completed: 2 },
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.part.updated",
          properties: {
            part: {
              id: "root-part",
              messageID: "root-message",
              sessionID: "session-opencode",
              type: "text",
              text: "root",
            },
          },
        }),
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(events.some((event) => event.runtimeSessionRef === "child-session")).toBe(true);
    expect(events.at(-1)?.payload).toMatchObject({ state: "completed", resultText: "root" });
    expect(events.at(-1)?.payload).toMatchObject({ turns: 2 });
  });

  it("marks an unreconciled stream loss interrupted and persists partial state", async () => {
    const { calls, runtime } = fakeRuntime({
      events: [],
      streamError: new Error("SSE disconnected"),
      messages: [],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(events.map((event) => event.kind)).toEqual(["run", "persistence", "error", "terminal"]);
    expect(events.find((event) => event.kind === "terminal")?.payload).toMatchObject({
      state: "interrupted",
    });
    expect(events.find((event) => event.kind === "persistence")?.payload).toMatchObject({
      action: "partial-state",
      state: "persisted",
    });
    expect(calls).toMatchObject({ abort: 1, delete: 1, messages: 1, stop: 1 });
  });

  it("retains a bounded diagnostic for unknown session events", async () => {
    const { runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "runtime.future.v2",
          properties: { sessionID: "session-opencode", secret: "must-not-leak" },
        }),
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));
    const diagnostic = events.find((event) => event.kind === "runtime-exit");

    expect(diagnostic?.payload).toEqual({ state: "unknown_event", eventType: "runtime.future.v2" });
    expect(JSON.stringify(diagnostic)).not.toContain("must-not-leak");
  });
});

describe("OpenCode process supervisor", () => {
  it("bounds startup diagnostics while waiting for the server URL", () => {
    const output = appendBoundedOpenCodeOutput("prefix", "diagnostic output ".repeat(2_000));

    expect(output).toHaveLength(16_384);
    expect(output).toBe(("prefix" + "diagnostic output ".repeat(2_000)).slice(-16_384));
  });

  it("starts one loopback server with explicit cwd and environment, then reaps it", async () => {
    const child = new FakeChild();
    const config = { z: 1, nested: { b: true, a: "stable" } };
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let spawnCall:
      | { command: string; args: readonly string[]; options: Parameters<OpenCodeSpawn>[2] }
      | undefined;
    const spawnProcess: OpenCodeSpawn = (command, args, options) => {
      spawnCall = { command, args, options };
      queueMicrotask(() => {
        child.stdout.write("diagnostic output ".repeat(2_000));
        child.stderr.write("diagnostic output ".repeat(2_000));
        child.stdout.write("opencode server listening on http://127.0.0.1:41234\n");
      });
      return child as never;
    };
    const supervisor = new OpenCodeServerSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41234,
      base: { PATH: "/bin", HTTP_PROXY: "http://proxy:3128" },
      config,
      expectedConfigHash: hashOpenCodeConfig({ nested: { a: "stable", b: true }, z: 1 }),
      requiredCapabilities: ["sse", "sessions"],
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        child.kill(signal);
      },
      spawnProcess,
      readiness: {
        check: async () => ({
          healthy: true,
          version: "1.18.29",
          capabilities: ["sse", "sessions"],
        }),
      },
    });

    const info = await supervisor.start("/worktree", new AbortController().signal);
    expect(info).toMatchObject({
      baseUrl: "http://127.0.0.1:41234",
      version: "1.18.29",
      hostname: "127.0.0.1",
      port: 41234,
      configHash: hashOpenCodeConfig(config),
      capabilities: ["sse", "sessions"],
    });
    expect(child.stdout.listenerCount("data")).toBe(1);
    expect(child.stderr.listenerCount("data")).toBe(1);

    expect(spawnCall).toMatchObject({
      command: "/usr/local/bin/opencode-test",
      args: ["serve", "--hostname=127.0.0.1", "--port=41234"],
      options: {
        cwd: "/worktree",
        detached: true,
        env: expect.objectContaining({
          HTTP_PROXY: "http://proxy:3128",
          NO_PROXY: expect.stringContaining("127.0.0.1"),
        }),
      },
    });

    await supervisor.stop();
    expect(child.killedWith).toBe("SIGTERM");
    expect(signals).toEqual([{ pid: -1234, signal: "SIGTERM" }]);
    expect(supervisor.info).toBeUndefined();
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });

  it("aborts and signals the process group when the server crashes", async () => {
    const child = new FakeChild();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const supervisor = new OpenCodeServerSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41237,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        child.kill(signal);
      },
      spawnProcess: (_command, _args, _options) => {
        queueMicrotask(() =>
          child.stdout.write("opencode server listening on http://127.0.0.1:41237\n"),
        );
        return child as never;
      },
      readiness: { check: async () => ({ healthy: true, version: "1.18.29" }) },
    });

    await supervisor.start("/worktree", new AbortController().signal);
    child.emit("exit", 1, null);

    expect(supervisor.crashSignal.aborted).toBe(true);
    expect(supervisor.crashError?.message).toContain("exited unexpectedly");
    await supervisor.stop();
    expect(signals).toEqual([
      { pid: -1234, signal: "SIGTERM" },
      { pid: -1234, signal: "SIGTERM" },
    ]);
  });

  it("rejects a relative binary path before spawning a child", () => {
    expect(() => new OpenCodeServerSupervisor({ command: "opencode" })).toThrow(
      "OpenCode binary path must be absolute",
    );
  });

  it("rejects an unverified config hash before spawning a child", async () => {
    let spawned = false;
    const supervisor = new OpenCodeServerSupervisor({
      command: "/usr/local/bin/opencode-test",
      config: { mode: "safe" },
      expectedConfigHash: "0".repeat(64),
      spawnProcess: () => {
        spawned = true;
        return new FakeChild() as never;
      },
    });

    await expect(supervisor.start("/worktree", new AbortController().signal)).rejects.toThrow(
      "does not match expected",
    );
    expect(spawned).toBe(false);
  });

  it("rejects missing server capabilities during readiness admission", async () => {
    const child = new FakeChild();
    const supervisor = new OpenCodeServerSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41235,
      requiredCapabilities: ["sse"],
      spawnProcess: (_command, _args, _options) => {
        queueMicrotask(() =>
          child.stdout.write("opencode server listening on http://127.0.0.1:41235\n"),
        );
        return child as never;
      },
      readiness: { check: async () => ({ healthy: true, version: "1.18.29" }) },
    });

    await expect(supervisor.start("/worktree", new AbortController().signal)).rejects.toThrow(
      "missing capabilities: sse",
    );
  });

  it("rejects a non-loopback bind before spawning a child", () => {
    expect(() => new OpenCodeServerSupervisor({ hostname: "0.0.0.0" })).toThrow(
      "OpenCode server hostname must be loopback",
    );
  });
});
