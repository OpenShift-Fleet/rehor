import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createOpencodeClient,
  type Event as OpenCodeEvent,
  type OpencodeClient,
} from "@opencode-ai/sdk";
import { describe, expect, it } from "vitest";
import { executeRun, LegacyCompatibilityProjection } from "../src";
import { parseRehorEvent, type RehorEvent, type RehorRun } from "../src/domain";
import {
  appendBoundedOpenCodeOutput,
  buildOpenCodeEnvironment,
  createOpenCodeFetch,
  HttpOpenCodeReadiness,
  hashOpenCodeConfig,
  type OpenCodeClientFactory,
  OpenCodeReadinessError,
  type OpenCodeServerController,
  type OpenCodeServerInfo,
  OpenCodeServerSupervisor,
  type OpenCodeSpawn,
  type OpenCodeV1ConfigInput,
  OpenCodeV1Runtime,
  type RenderedOpenCodeV1Config,
  renderOpenCodeV1Config,
} from "../src/runtimes/opencode-v1";
import { boundedOperation } from "../src/runtimes/shared";

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
  beforeError?: () => void,
  returnGate?: Promise<unknown>,
  beforeStart?: () => void,
): AsyncGenerator<OpenCodeEvent> {
  try {
    beforeStart?.();
    yield asOpenCodeEvent({ type: "server.connected", properties: {} });
    yield* events;
    if (beforeError) beforeError();
    if (error) throw error;
  } finally {
    await returnGate;
  }
}

interface FakeRuntimeOptions {
  events: OpenCodeEvent[];
  serverDirectory?: string;
  streamError?: Error;
  messages?: unknown[];
  sessionStatus?: Record<string, unknown>;
  omitConfigHash?: boolean;
  deleteError?: Error;
  promptError?: Error;
  promptGate?: Promise<unknown>;
  streamReturnGate?: Promise<unknown>;
  deleteGate?: Promise<unknown>;
  cleanupTimeoutMs?: number;
  crashError?: Error;
  config?: Omit<OpenCodeV1ConfigInput, "model"> & { model?: string };
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
    start: 0,
    messages: 0,
    stop: 0,
    pathGet: [] as unknown[],
    subscribe: [] as unknown[],
    streamStarts: [] as number[],
    create: [] as unknown[],
    prompt: [] as unknown[],
    messageRequests: [] as unknown[],
    statusRequests: [] as unknown[],
    deleteRequests: [] as unknown[],
    factory: [] as FactoryCall[],
  };
  const server: OpenCodeServerInfo = {
    baseUrl: "http://127.0.0.1:41236",
    hostname: "127.0.0.1",
    port: 41236,
    directory: options.serverDirectory ?? runtimeRun.worktree.path,
    healthy: true,
    version: "1.18.29",
    ...(options.omitConfigHash ? {} : { configHash: runtimeRun.configHash.value }),
    capabilities: ["sse", "sessions"],
  };
  let activeServer: OpenCodeServerInfo | undefined;
  const crashController = new AbortController();
  let crashError: Error | undefined;
  crashController.signal.addEventListener("abort", () => {
    if (crashController.signal.reason instanceof Error) {
      crashError = crashController.signal.reason;
    }
  });
  const supervisor: OpenCodeServerController = {
    crashSignal: crashController.signal,
    get info() {
      return activeServer;
    },
    get crashError() {
      return crashError;
    },
    async start() {
      calls.start += 1;
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
        return {
          stream: streamEvents(
            options.events,
            options.streamError,
            options.crashError ? () => crashController.abort(options.crashError) : undefined,
            options.streamReturnGate,
            () => calls.streamStarts.push(calls.create.length),
          ),
        };
      },
    },
    session: {
      create: async (request: unknown) => {
        calls.create.push(request);
        return { data: { id: "session-opencode" } };
      },
      promptAsync: async (request: unknown) => {
        calls.prompt.push(request);
        await options.promptGate;
        if (options.promptError) throw options.promptError;
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
        assertCleanupRequestSignal(request);
        calls.abort += 1;
        return { data: {} };
      },
      delete: async (request: unknown) => {
        assertCleanupRequestSignal(request);
        calls.delete += 1;
        calls.deleteRequests.push(request);
        await options.deleteGate;
        if (options.deleteError) throw options.deleteError;
        return { data: {} };
      },
    },
  } as unknown as OpencodeClient;
  const clientFactory: OpenCodeClientFactory = (server, directory, environment) => {
    calls.factory.push({ server, directory, environment });
    return client;
  };
  let renderedConfig: RenderedOpenCodeV1Config | undefined;
  let renderError: unknown;
  try {
    const configured = options.config ?? {};
    renderedConfig = renderOpenCodeV1Config({
      ...configured,
      model: configured.model ?? runtimeRun.provider.requestedModel,
      providerId: configured.providerId ?? runtimeRun.provider.id,
    });
  } catch (error) {
    renderError = error;
  }
  const runtime = new OpenCodeV1Runtime({
    supervisor: () => supervisor,
    clientFactory,
    renderedConfig,
    renderError,
    ...(options.cleanupTimeoutMs === undefined
      ? {}
      : { cleanupTimeoutMs: options.cleanupTimeoutMs }),
  });
  return { calls, runtime, crashController, supervisor };
}

function assertCleanupRequestSignal(request: unknown): void {
  const signal = (request as { signal?: AbortSignal }).signal;
  if (!signal || signal.aborted) throw new Error("cleanup request was pre-aborted");
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
  expect(sequences).toEqual(
    Array.from({ length: sequences.length }, (_unused, index) => index + 1),
  );
  return collected;
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("test condition was not reached");
}

describe("bounded operations", () => {
  it("does not start an operation after cancellation wins before its microtask", async () => {
    const controller = new AbortController();
    let called = false;
    const pending = boundedOperation(
      () => {
        called = true;
        return "must not run";
      },
      controller.signal,
      undefined,
      "test operation",
    );

    controller.abort("cancelled");
    await expect(pending).rejects.toThrow("cancelled");
    expect(called).toBe(false);
  });
});

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
        OPENCODE_CONFIG_CONTENT: "ambient-config-must-not-leak",
        NODE_OPTIONS: "--require=/tmp/preload.cjs",
        NPM_CONFIG_REGISTRY: "https://registry.example.invalid",
        REHOR_MODEL_PROXY_TOKEN: "explicitly-allowed",
        AWS_SECRET_ACCESS_KEY: "must-not-leak",
        DATABASE_URL: "must-not-leak",
      },
      passthrough: [
        "REHOR_MODEL_PROXY_TOKEN",
        "OPENCODE_CONFIG_CONTENT",
        "NPM_CONFIG_REGISTRY",
        "AWS_SECRET_ACCESS_KEY",
        "DATABASE_URL",
      ],
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
    expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(environment.DATABASE_URL).toBeUndefined();
    expect(environment.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(environment.NODE_OPTIONS).toBeUndefined();
    expect(environment.NPM_CONFIG_REGISTRY).toBeUndefined();
  });

  it("keeps MCP endpoint references available without allowing arbitrary MCP variables", () => {
    const environment = buildOpenCodeEnvironment({
      base: {
        JIRA_MCP_URL: "http://jira-mcp:8444/mcp",
        GITHUB_TOKEN: "<REDACTED>",
        JIRA_MCP_TOKEN: "<REDACTED>",
      },
      passthrough: ["GITHUB_TOKEN", "JIRA_MCP_TOKEN"],
    });

    expect(environment.JIRA_MCP_URL).toBe("http://jira-mcp:8444/mcp");
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.JIRA_MCP_TOKEN).toBeUndefined();
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

  it("rejects Node environment proxy mode for the loopback transport", () => {
    const previous = process.env.NODE_USE_ENV_PROXY;
    process.env.NODE_USE_ENV_PROXY = "1";
    try {
      expect(() => createOpenCodeFetch()).toThrow(
        "OpenCode loopback fetch cannot run with NODE_USE_ENV_PROXY=1",
      );
    } finally {
      if (previous === undefined) delete process.env.NODE_USE_ENV_PROXY;
      else process.env.NODE_USE_ENV_PROXY = previous;
    }
  });
});

describe("OpenCode readiness", () => {
  it("requires healthy version and worktree path responses", async () => {
    const requests: string[] = [];
    const readiness = new HttpOpenCodeReadiness(async (request) => {
      const url = request instanceof Request ? request.url : String(request);
      requests.push(url);
      if (url.includes("/global/health")) {
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

  it("accepts a symlinked worktree when the server reports its real path", async () => {
    const realDirectory = await mkdtemp(join(tmpdir(), "opencode-readiness-"));
    const linkedDirectory = `${realDirectory}-link`;
    await symlink(realDirectory, linkedDirectory);
    try {
      const readiness = new HttpOpenCodeReadiness(async (request) => {
        const url = request instanceof Request ? request.url : String(request);
        return url.includes("/global/health")
          ? new Response(JSON.stringify({ healthy: true, version: "1.18.29" }))
          : new Response(JSON.stringify({ directory: realDirectory }));
      });

      await expect(
        readiness.check("http://127.0.0.1:4096", linkedDirectory, new AbortController().signal),
      ).resolves.toMatchObject({ healthy: true, version: "1.18.29" });
    } finally {
      await rm(linkedDirectory, { force: true });
      await rm(realDirectory, { recursive: true, force: true });
    }
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

  it("validates loopback URLs before using an injected direct transport", async () => {
    const requests: string[] = [];
    const readiness = new HttpOpenCodeReadiness(async (request) => {
      const url = request instanceof Request ? request.url : String(request);
      requests.push(url);
      return url.includes("/global/health")
        ? new Response(JSON.stringify({ healthy: true, version: "1.18.29" }))
        : new Response(JSON.stringify({ directory: "/worktree" }));
    });

    await expect(
      readiness.check("http://127.0.0.1:4096", "/worktree", new AbortController().signal),
    ).resolves.toEqual({ healthy: true, version: "1.18.29" });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("directory=%2Fworktree");
  });

  it("rejects non-loopback readiness URLs before transport", async () => {
    let fetchCalls = 0;
    const readiness = new HttpOpenCodeReadiness(async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ healthy: true, version: "1.18.29" }));
    });

    await expect(
      readiness.check("http://model-gateway:4096", "/worktree", new AbortController().signal),
    ).rejects.toThrow("not a loopback address");
    expect(fetchCalls).toBe(0);
  });

  it("accepts a 204 promptAsync response through the actual OpenCode SDK", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const listen = (): Promise<number> =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") reject(new Error("missing test port"));
          else resolve(address.port);
        });
      });
    const close = (): Promise<void> =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );

    try {
      const port = await listen();
      const client = createOpencodeClient({
        baseUrl: `http://127.0.0.1:${port}`,
        fetch: createOpenCodeFetch(),
      });
      const result = await client.session.promptAsync({
        path: { id: "session" },
        query: { directory: "/worktree" },
        body: {
          model: { providerID: "provider", modelID: "model" },
          parts: [{ type: "text", text: "hello" }],
        },
        responseStyle: "data",
        throwOnError: true,
      });

      expect(result).toEqual({});
    } finally {
      await close();
    }
  });

  it("uses direct loopback transport", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ healthy: true, version: "1.18.29" }));
    });
    const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") reject(new Error("missing test port"));
          else resolve(address.port);
        });
      });
    const close = (server: ReturnType<typeof createServer>): Promise<void> =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );

    try {
      const upstreamPort = await listen(upstream);
      const fetch = createOpenCodeFetch();
      const response = await fetch(`http://127.0.0.1:${upstreamPort}/global/health`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ healthy: true, version: "1.18.29" });
    } finally {
      await close(upstream);
    }
  });
});

describe("OpenCode runtime", () => {
  it("uses the supervisor's canonical directory for OpenCode client requests", async () => {
    const { calls, runtime } = fakeRuntime({
      serverDirectory: "/canonical-worktree",
      events: [
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(calls.factory[0]?.directory).toBe("/canonical-worktree");
    expect(calls.subscribe[0]).toMatchObject({ query: { directory: "/canonical-worktree" } });
    expect(calls.create[0]).toMatchObject({ query: { directory: "/canonical-worktree" } });
    expect(calls.prompt[0]).toMatchObject({ query: { directory: "/canonical-worktree" } });
    expect(calls.deleteRequests[0]).toMatchObject({
      query: { directory: "/canonical-worktree" },
    });
  });

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
      runtimeVersion: "1.18.29",
      streaming: true,
    });
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(runtime.renderedConfiguration?.config).toMatchObject({
      model: "rehor-openai/gpt-5.6-luna",
      enabled_providers: ["rehor-openai"],
    });
    expect(runtime.renderedConfiguration?.hash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(calls.factory).toHaveLength(1);
    expect(calls.factory[0]).toMatchObject({
      server: { baseUrl: "http://127.0.0.1:41236" },
      directory: runtimeRun.worktree.path,
    });
    expect(calls.factory[0]?.environment).toEqual(runtime.environment);
    expect(calls.pathGet).toHaveLength(0);
    expect(calls.subscribe[0]).toMatchObject({
      query: { directory: runtimeRun.worktree.path },
      signal: expect.any(AbortSignal),
      sseMaxRetryAttempts: 0,
    });
    expect(calls.streamStarts).toEqual([0]);
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
    expect((calls.create[0] as { signal: AbortSignal }).signal).not.toBe(runSignal);
    expect((calls.prompt[0] as { signal: AbortSignal }).signal).not.toBe(runSignal);
    expect(runSignal.aborted).toBe(false);
    expect((calls.create[0] as { signal: AbortSignal }).signal.aborted).toBe(false);
    expect((calls.prompt[0] as { signal: AbortSignal }).signal.aborted).toBe(false);
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

  it("uses the effective configured model without changing run provider attribution", async () => {
    const { calls, runtime } = fakeRuntime({
      config: {
        model: "override-model",
        providerId: "override-provider",
        providers: [
          {
            id: "override-provider",
            npm: "override-provider-package",
            options: { apiKey: "$" + "{REHOR_MODEL_PROXY_TOKEN}" },
          },
        ],
        packages: [{ name: "override-provider-package", version: "1.0.0" }],
      },
      events: [
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "override-message",
              sessionID: "session-opencode",
              role: "assistant",
              providerID: "override-provider",
              modelID: "override-model",
              time: { created: 1, completed: 2 },
              tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
              cost: 0.01,
            },
          },
        }),
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });

    const result = await executeRun(runtime, runtimeRun);

    expect(result.error).toBeUndefined();
    const configured = runtime.renderedConfiguration?.config;
    expect(configured).toMatchObject({
      model: "override-provider/override-model",
      enabled_providers: ["override-provider"],
    });
    if (!configured) throw new Error("rendered configuration missing");
    expect(runtime.renderedConfiguration?.hash).toBe(hashOpenCodeConfig(configured));
    expect(runtime.renderedConfiguration?.requiredEnvironment).toEqual(["REHOR_MODEL_PROXY_TOKEN"]);
    expect(runtime.renderedConfiguration?.packageLock).toEqual({
      lockfileVersion: 1,
      packages: { "override-provider-package": "1.0.0" },
    });
    expect(calls.prompt[0]).toMatchObject({
      body: {
        model: { providerID: "override-provider", modelID: "override-model" },
      },
    });

    const runAndTerminal = result.events.filter(
      (event) => event.kind === "run" || event.kind === "terminal",
    );
    expect(runAndTerminal.length).toBeGreaterThan(0);
    expect(
      runAndTerminal.every(
        (event) =>
          event.provider === runtimeRun.provider.id &&
          event.model === "override-provider/override-model",
      ),
    ).toBe(true);
    expect(result.events.find((event) => event.kind === "model")).toMatchObject({
      provider: runtimeRun.provider.id,
      model: "override-model",
    });
    expect(result.events.find((event) => event.kind === "usage")).toMatchObject({
      provider: runtimeRun.provider.id,
      model: "override-model",
      payload: { requestedModel: "override-provider/override-model" },
    });
  });

  it("rejects invalid rendered configuration before starting the supervisor", async () => {
    const { calls, runtime } = fakeRuntime({
      config: { allowedTools: ["UnknownTool"] },
      events: [],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(calls.start).toBe(0);
    expect(calls.factory).toHaveLength(0);
    expect(events.at(-1)?.payload).toMatchObject({ state: "failed" });
  });

  it("primes the SSE stream before creating the OpenCode session", async () => {
    const { calls, runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(calls.streamStarts).toEqual([0]);
    expect(calls.create).toHaveLength(1);
  });

  it("does not label the root session-created event as a child session", async () => {
    const { runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "session.created",
          properties: { info: { id: "session-opencode" } },
        }),
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(events).not.toContainEqual(
      expect.objectContaining({ payload: { state: "child_session_started" } }),
    );
    expect(events.at(-1)?.payload).toMatchObject({ state: "completed" });
  });

  it("fails fast on a headless permission request", async () => {
    const { runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "permission.updated",
          properties: { sessionID: "session-opencode", permission: "edit" },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(events.find((event) => event.kind === "policy")?.payload).toMatchObject({
      state: "permission_requested",
    });
    expect(events.find((event) => event.kind === "error")?.payload).toMatchObject({
      message: "OpenCode permission request cannot be handled in headless mode",
    });
    expect(events.at(-1)?.payload).toMatchObject({
      state: "failed",
      reason: "OpenCode permission request cannot be handled in headless mode",
    });
  });

  it("does not duplicate supervisor path readiness in the SDK client", async () => {
    const { calls, runtime } = fakeRuntime({ events: [] });

    await runtime.start(new AbortController().signal);
    await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(calls.pathGet).toHaveLength(0);
  });

  it("normalizes OpenCode tools and preserves legacy work context", async () => {
    const statuses: unknown[] = [];
    const costs: unknown[] = [];
    const cycleRuns: unknown[] = [];
    const { runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "assistant-message",
              sessionID: "session-opencode",
              role: "assistant",
              modelID: "gpt-5.6-luna",
              time: { created: 1 },
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "assistant-message",
              sessionID: "session-opencode",
              role: "assistant",
              modelID: "gpt-5.6-luna",
              time: { created: 1 },
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.part.updated",
          properties: {
            part: {
              id: "tool-part",
              sessionID: "session-opencode",
              messageID: "assistant-message",
              type: "tool",
              tool: "mcp__bot-memory__task_add",
              callID: "call-1",
              state: {
                status: "completed",
                input: {
                  jira_key: "REHOR-143",
                  repo: "rehor",
                  summary: "Fix OpenCode parity",
                },
                output: JSON.stringify({ id: 143, jira_key: "REHOR-143" }),
                title: "task created",
                metadata: {},
                time: { start: 10, end: 30 },
              },
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.part.updated",
          properties: {
            part: {
              id: "tool-part",
              sessionID: "session-opencode",
              messageID: "assistant-message",
              type: "tool",
              tool: "mcp__bot-memory__task_add",
              callID: "call-1",
              state: {
                status: "completed",
                input: {
                  jira_key: "REHOR-143",
                  repo: "rehor",
                  summary: "Fix OpenCode parity",
                },
                output: JSON.stringify({ id: 143, jira_key: "REHOR-143" }),
                title: "task created",
                metadata: {},
                time: { start: 10, end: 30 },
              },
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.part.updated",
          properties: {
            part: {
              id: "answer-part",
              sessionID: "session-opencode",
              messageID: "assistant-message",
              type: "text",
              text: "Completed parity work.",
            },
          },
        }),
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });
    const projection = new LegacyCompatibilityProjection({
      status: {
        write: (record) => {
          statuses.push(record);
        },
      },
      costs: {
        write: (record) => {
          costs.push(record);
        },
      },
      cycleRuns: {
        write: (record) => {
          cycleRuns.push(record);
        },
      },
    });

    const result = await executeRun(runtime, runtimeRun, { projection });
    const toolEvents = result.events.filter((event) => event.kind === "tool");
    const tool = toolEvents[0];

    expect(toolEvents).toHaveLength(1);
    expect(tool?.payload).toMatchObject({
      state: "completed",
      name: "mcp__bot-memory__task_add",
      toolName: "mcp__bot-memory__task_add",
      toolUseId: "call-1",
      content: JSON.stringify({ id: 143, jira_key: "REHOR-143" }),
      durationMs: 20,
    });
    expect(tool?.payload).not.toHaveProperty("tool");
    expect(tool?.payload).not.toHaveProperty("callId");
    expect(tool?.payload).not.toHaveProperty("output");
    expect(result.terminal.payload).toMatchObject({
      context: {
        taskId: 143,
        externalKey: "REHOR-143",
        repository: "rehor",
        workType: "new_ticket",
        summary: "Fix OpenCode parity",
      },
    });
    expect(statuses).toContainEqual(
      expect.objectContaining({ message: "Tool: mcp__bot-memory__task_add" }),
    );
    expect(costs[0]).toMatchObject({
      repository: "rehor",
      workType: "new_ticket",
      summary: "Fix OpenCode parity",
      externalKey: "REHOR-143",
    });
    expect(cycleRuns[0]).toMatchObject({
      taskId: 143,
      cycleType: "task_work",
      progress: {
        repository: "rehor",
        workType: "new_ticket",
        summary: "Fix OpenCode parity",
      },
    });
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
    expect(events.at(-1)?.payload).toMatchObject({ state: "completed" });
  });

  it("bounds a stalled stream return before stopping the server", async () => {
    const streamReturnGate = new Promise<void>(() => undefined);
    const { calls, runtime } = fakeRuntime({
      streamReturnGate,
      cleanupTimeoutMs: 20,
      events: [
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });

    await runtime.start(new AbortController().signal);
    const startedAt = Date.now();
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(events.at(-1)?.payload).toMatchObject({ state: "completed" });
    expect(calls).toMatchObject({ delete: 0, stop: 1 });
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
      reason: "max_turns: maximum turn limit reached",
      turns: 1,
    });
    expect(calls.abort).toBe(0);
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
      reason: "max_turns: maximum turn limit reached",
      turns: 1,
    });
    expect(calls.abort).toBe(0);
  });

  it("reconciles a prompt request whose response is lost after submission", async () => {
    const { calls, runtime } = fakeRuntime({
      events: [],
      promptError: new Error("prompt response lost"),
      sessionStatus: {},
      messages: [
        {
          info: {
            id: "message-1",
            sessionID: "session-opencode",
            role: "assistant",
            modelID: "gpt-5.6-luna",
            time: { created: 1, completed: 2 },
            finish: "stop",
          },
          parts: [
            {
              id: "answer-part",
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
    expect(events.at(-1)?.payload).toMatchObject({
      state: "completed",
      resultText: "hello",
    });
  });

  it("passes external cancellation to an active prompt and still stops the server", async () => {
    const promptGate = new Promise<void>(() => undefined);
    const { calls, runtime } = fakeRuntime({ promptGate, events: [] });
    const signalController = new AbortController();

    await runtime.start(new AbortController().signal);
    const pending = collect(runtime.run(runtimeRun, signalController.signal));
    await waitForCondition(() => calls.prompt.length === 1);
    signalController.abort("cancelled");
    const events = await pending;

    expect(events.at(-1)?.payload).toMatchObject({ state: "cancelled" });
    expect((calls.prompt[0] as { signal: AbortSignal }).signal.aborted).toBe(true);
    expect((calls.deleteRequests[0] as { signal: AbortSignal }).signal.aborted).toBe(false);
    expect(calls).toMatchObject({ abort: 0, delete: 1, stop: 1 });
  });

  it("passes the runtime timeout to an active prompt and still stops the server", async () => {
    const promptGate = new Promise<void>(() => undefined);
    const { calls, runtime } = fakeRuntime({ promptGate, events: [] });

    await runtime.start(new AbortController().signal);
    const pending = collect(
      runtime.run(
        { ...runtimeRun, limits: { ...runtimeRun.limits, timeoutMs: 20 } },
        new AbortController().signal,
      ),
    );
    await waitForCondition(() => calls.prompt.length === 1);
    const events = await pending;
    expect(events.at(-1)?.payload).toMatchObject({ state: "timed_out" });
    expect((calls.prompt[0] as { signal: AbortSignal }).signal.aborted).toBe(true);
    expect((calls.deleteRequests[0] as { signal: AbortSignal }).signal.aborted).toBe(false);
    expect(calls).toMatchObject({ abort: 0, delete: 1, stop: 1 });
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

  it("emits model before usage for an assistant first seen during reconciliation", async () => {
    const { runtime } = fakeRuntime({
      events: [],
      streamError: new Error("SSE disconnected"),
      sessionStatus: {},
      messages: [
        {
          info: {
            id: "reconciled-message",
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
          },
          parts: [],
        },
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(events.map((event) => event.kind)).toEqual(["run", "model", "usage", "terminal"]);
    const model = events.find((event) => event.kind === "model");
    const usage = events.find((event) => event.kind === "usage");
    expect(model).toBeDefined();
    expect(usage?.parentEventId).toBe(model?.eventId);
  });

  it("replaces a live partial text part with authoritative reconciled text", async () => {
    const { runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "message-1",
              sessionID: "session-opencode",
              role: "assistant",
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
              text: "hel",
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
    const modelTexts = events
      .filter((event) => event.kind === "model")
      .map((event) => event.payload.text)
      .filter((text): text is string => typeof text === "string");

    expect(modelTexts).toEqual(["hel", "hello"]);
    expect(events.at(-1)?.payload).toMatchObject({
      state: "completed",
      resultText: "hello",
    });
  });

  it("uses the last root assistant error for live and reconciled outcomes", async () => {
    const live = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "error-message",
              sessionID: "session-opencode",
              role: "assistant",
              error: { data: { message: "provider failed" } },
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "clean-message",
              sessionID: "session-opencode",
              role: "assistant",
              time: { created: 1, completed: 2 },
              finish: "stop",
            },
          },
        }),
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });
    await live.runtime.start(new AbortController().signal);
    const liveEvents = await collect(live.runtime.run(runtimeRun, new AbortController().signal));
    expect(liveEvents.at(-1)?.payload).toMatchObject({ state: "completed" });

    const reconciled = fakeRuntime({
      events: [],
      streamError: new Error("SSE disconnected"),
      sessionStatus: {},
      messages: [
        {
          info: {
            id: "error-message",
            sessionID: "session-opencode",
            role: "assistant",
            error: { data: { message: "provider failed" } },
            time: { created: 1 },
          },
          parts: [],
        },
        {
          info: {
            id: "clean-message",
            sessionID: "session-opencode",
            role: "assistant",
            time: { created: 2, completed: 3 },
            finish: "stop",
          },
          parts: [],
        },
      ],
    });
    await reconciled.runtime.start(new AbortController().signal);
    const reconciledEvents = await collect(
      reconciled.runtime.run(runtimeRun, new AbortController().signal),
    );
    expect(reconciledEvents.at(-1)?.payload).toMatchObject({ state: "completed" });
  });

  it("redacts sensitive provider error text before emitting events", async () => {
    const { runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "session.error",
          properties: {
            sessionID: "session-opencode",
            error: {
              data: {
                message:
                  "Authorization: Bearer provider-secret https://user:password@example.com?token=query-secret",
              },
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
    const serialized = JSON.stringify(events);

    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("password@example.com");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it("redacts sensitive request failures before emitting events", async () => {
    const { runtime } = fakeRuntime({
      events: [],
      promptError: new Error("Authorization: Bearer request-secret"),
      messages: [],
      sessionStatus: {},
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));
    const serialized = JSON.stringify(events);

    expect(serialized).not.toContain("request-secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it("preserves a root session error through reconciliation", async () => {
    const { runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "session.error",
          properties: {
            sessionID: "session-opencode",
            error: { data: { message: "session failed" } },
          },
        }),
      ],
      streamError: new Error("SSE disconnected"),
      sessionStatus: {},
      messages: [
        {
          info: {
            id: "clean-message",
            sessionID: "session-opencode",
            role: "assistant",
            time: { created: 1, completed: 2 },
            finish: "stop",
          },
          parts: [],
        },
      ],
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(events.at(-1)?.payload).toMatchObject({
      state: "failed",
      reason: "session failed",
    });
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
    expect(usageEvents.at(-1)?.model).toBe("gpt-5.6-mini");
    expect(usageEvents.at(-1)?.payload).toMatchObject({
      returnedModel: "gpt-5.6-mini",
      tokenCounts: { input: 5, output: 3, reasoning: 2, cacheRead: 1, cacheWrite: 2 },
      cost: { amount: 0.02, currency: "USD", source: "provider" },
      final: true,
    });
  });

  it("buckets root and child usage by the bare returned model", async () => {
    const costs: unknown[] = [];
    const { runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "root-message",
              sessionID: "session-opencode",
              role: "assistant",
              providerID: "anthropic",
              modelID: "claude-x",
              time: { created: 1, completed: 2 },
              tokens: { input: 10, output: 2, cache: { read: 0, write: 0 } },
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
              providerID: "anthropic",
              modelID: "claude-x",
              time: { created: 3, completed: 4 },
              tokens: { input: 5, output: 3, cache: { read: 1, write: 2 } },
            },
          },
        }),
        asOpenCodeEvent({
          type: "session.idle",
          properties: { sessionID: "session-opencode" },
        }),
      ],
    });
    const run = {
      ...runtimeRun,
      provider: { id: "anthropic", requestedModel: "claude-x" },
    };
    const projection = new LegacyCompatibilityProjection({
      costs: {
        write: (record) => {
          costs.push(record);
        },
      },
    });

    await runtime.start(new AbortController().signal);
    const result = await executeRun(runtime, run, { projection });
    const usage = result.events.filter((event) => event.kind === "usage");

    expect(usage.at(-1)?.model).toBe("claude-x");
    expect(usage.at(-1)?.payload).toMatchObject({
      requestedModel: "anthropic/claude-x",
      returnedModel: "claude-x",
      tokenCounts: { input: 15, output: 5, cacheRead: 1, cacheWrite: 2 },
    });
    expect(costs[0]).toMatchObject({
      inputTokens: 15,
      outputTokens: 5,
    });
    expect((costs[0] as { modelUsage: Record<string, unknown> }).modelUsage).toEqual({
      "claude-x": {
        input_tokens: 15,
        output_tokens: 5,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 2,
      },
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
    expect(calls.abort).toBe(0);
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
    expect(events.at(-1)?.payload).toMatchObject({ turns: 1 });
  });

  it("preserves partial evidence and interrupts when the server crashes", async () => {
    const crash = new Error("server process crashed");
    const { runtime } = fakeRuntime({
      events: [
        asOpenCodeEvent({
          type: "message.updated",
          properties: {
            info: {
              id: "partial-message",
              sessionID: "session-opencode",
              role: "assistant",
              modelID: "gpt-5.6-luna",
            },
          },
        }),
        asOpenCodeEvent({
          type: "message.part.updated",
          properties: {
            part: {
              id: "partial-answer",
              sessionID: "session-opencode",
              messageID: "partial-message",
              type: "text",
              text: "partial answer",
            },
          },
        }),
      ],
      streamError: new Error("SSE closed after crash"),
      crashError: crash,
    });

    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(runtimeRun, new AbortController().signal));

    expect(events.at(-1)?.payload).toMatchObject({
      state: "interrupted",
      resultText: "partial answer",
    });
    expect(events.find((event) => event.kind === "persistence")?.payload).toMatchObject({
      action: "partial-state",
      reason: "server process crashed",
    });
    expect(events.find((event) => event.kind === "error")?.payload).toMatchObject({
      message: "server process crashed",
    });
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
      state: "not_resumable",
    });
    expect(calls).toMatchObject({ abort: 0, delete: 1, messages: 1, stop: 1 });
  });

  it("drops unknown session events instead of emitting runtime-exit", async () => {
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
    expect(events.find((event) => event.kind === "runtime-exit")).toBeUndefined();
    expect(events.at(-1)?.payload).toMatchObject({ state: "completed" });
    expect(JSON.stringify(events)).not.toContain("must-not-leak");
  });
});

const TEST_WORKSPACE = process.cwd();

function createTestSupervisor(
  options: ConstructorParameters<typeof OpenCodeServerSupervisor>[0] = {},
): OpenCodeServerSupervisor {
  return new OpenCodeServerSupervisor({ workspaceRoot: TEST_WORKSPACE, ...options });
}

describe("OpenCode process supervisor", () => {
  it("requires an approved workspace root before spawning a child", async () => {
    let spawned = false;
    const supervisor = new OpenCodeServerSupervisor({
      command: "/usr/local/bin/opencode-test",
      spawnProcess: () => {
        spawned = true;
        return new FakeChild() as never;
      },
    });

    await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
      "workspace root is required",
    );
    expect(spawned).toBe(false);
  });

  it("rejects a relative worktree path before spawning a child", async () => {
    let spawned = false;
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      workspaceRoot: process.cwd(),
      startupTimeoutMs: 20,
      spawnProcess: () => {
        spawned = true;
        return new FakeChild() as never;
      },
    });

    await expect(
      supervisor.start("relative-worktree", new AbortController().signal),
    ).rejects.toThrow("absolute");
    expect(spawned).toBe(false);
  });

  it("rejects a worktree outside the approved workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-root-"));
    const outside = await mkdtemp(join(tmpdir(), "opencode-outside-"));
    let spawned = false;
    try {
      const supervisor = createTestSupervisor({
        command: "/usr/local/bin/opencode-test",
        workspaceRoot: root,
        startupTimeoutMs: 20,
        spawnProcess: () => {
          spawned = true;
          return new FakeChild() as never;
        },
      });

      await expect(supervisor.start(outside, new AbortController().signal)).rejects.toThrow(
        "outside approved workspace root",
      );
      expect(spawned).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a worktree with an unexpected owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-owner-"));
    const ownerUid = typeof process.getuid === "function" ? process.getuid() : 0;
    try {
      const supervisor = createTestSupervisor({
        command: "/usr/local/bin/opencode-test",
        workspaceRoot: root,
        workspaceOwnerUid: ownerUid + 1,
        startupTimeoutMs: 20,
        spawnProcess: () => new FakeChild() as never,
      });

      await expect(supervisor.start(root, new AbortController().signal)).rejects.toThrow(
        "owned by",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the canonical worktree path after validating a symlinked workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-canonical-root-"));
    const worktree = await mkdtemp(join(root, "worktree-"));
    const alias = join(root, "alias");
    await symlink(worktree, alias);
    const child = new FakeChild();
    let spawnCwd: string | undefined;
    try {
      const supervisor = createTestSupervisor({
        command: "/usr/local/bin/opencode-test",
        port: 41252,
        workspaceRoot: root,
        spawnProcess: (_command, _args, options) => {
          spawnCwd = options.cwd as string;
          queueMicrotask(() => child.stdout.write("server listening on http://127.0.0.1:41252\\n"));
          return child as never;
        },
        signalProcess: (_pid, signal) => child.kill(signal),
        readiness: { check: async () => ({ healthy: true, version: "1.18.29" }) },
      });

      const info = await supervisor.start(alias, new AbortController().signal);
      const canonicalWorktree = await realpath(worktree);
      expect(spawnCwd).toBe(canonicalWorktree);
      expect(info.directory).toBe(canonicalWorktree);
      await supervisor.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds startup diagnostics while waiting for the server URL", () => {
    const output = appendBoundedOpenCodeOutput("prefix", "diagnostic output ".repeat(2_000));

    expect(output).toHaveLength(16_384);
    expect(output).toBe(`prefix${"diagnostic output ".repeat(2_000)}`.slice(-16_384));
  });

  it("honors startup abort before registering the listening handler", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      startupTimeoutMs: 20,
      shutdownTimeoutMs: 20,
      killVerificationTimeoutMs: 20,
      allocatePort: async () => {
        controller.abort("cancelled before listening");
        return 41250;
      },
      signalProcess: (_pid, signal) => child.kill(signal),
      spawnProcess: () => child as never,
    });

    await expect(supervisor.start(TEST_WORKSPACE, controller.signal)).rejects.toThrow(
      "cancelled before listening",
    );
  });

  it("redacts secrets from startup diagnostics", async () => {
    const child = new FakeChild();
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41251,
      startupTimeoutMs: 50,
      shutdownTimeoutMs: 20,
      killVerificationTimeoutMs: 20,
      signalProcess: (_pid, signal) => child.kill(signal),
      spawnProcess: () => {
        queueMicrotask(() => child.stderr.write("Authorization: Bearer startup-secret\n"));
        return child as never;
      },
    });

    const error = await supervisor.start(TEST_WORKSPACE, new AbortController().signal).then(
      () => undefined,
      (value: unknown) => (value instanceof Error ? value : new Error(String(value))),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("startup-secret");
    expect((error as Error).message).toContain("[REDACTED]");
  });

  it("does not expose secret tails when startup output truncates redaction context", async () => {
    const child = new FakeChild();
    const captureBoundarySecretTail = "s".repeat(256);
    const diagnosticBoundarySecretTail = "t".repeat(256);
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41253,
      startupTimeoutMs: 50,
      shutdownTimeoutMs: 20,
      killVerificationTimeoutMs: 20,
      signalProcess: (_pid, signal) => child.kill(signal),
      spawnProcess: () => {
        queueMicrotask(() =>
          child.stderr.write(
            `Authorization: Bearer ${"s".repeat(20_000)}\n` +
              `Authorization: Bearer ${"t".repeat(3_000)}\n` +
              "public startup diagnostic\n",
          ),
        );
        return child as never;
      },
    });

    const error = await supervisor.start(TEST_WORKSPACE, new AbortController().signal).then(
      () => undefined,
      (value: unknown) => (value instanceof Error ? value : new Error(String(value))),
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain(captureBoundarySecretTail);
    expect(message).not.toContain(diagnosticBoundarySecretTail);
    expect(message).toContain("public startup diagnostic");
  });

  it("caps startup diagnostics included in startup errors", async () => {
    const child = new FakeChild();
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41248,
      startupTimeoutMs: 50,
      shutdownTimeoutMs: 20,
      killVerificationTimeoutMs: 20,
      signalProcess: (_pid, signal) => child.kill(signal),
      spawnProcess: () => {
        queueMicrotask(() => child.stderr.write("x".repeat(4_096)));
        return child as never;
      },
    });

    const error = await supervisor.start(TEST_WORKSPACE, new AbortController().signal).then(
      () => undefined,
      (value: unknown) => (value instanceof Error ? value : new Error(String(value))),
    );

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    const marker = "OpenCode startup output (tail):\n";
    const markerIndex = message.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(message.slice(markerIndex + marker.length)).toHaveLength(2_048);
  });

  it("includes startup output when the server exits before listening", async () => {
    const child = new FakeChild();
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41244,
      startupTimeoutMs: 100,
      signalProcess: (_pid, signal) => child.kill(signal),
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stderr.write("fatal startup configuration\n");
          child.emit("exit", 2, null);
        });
        return child as never;
      },
    });

    await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
      /fatal startup configuration/,
    );
  });

  it("includes startup output when listening times out", async () => {
    const child = new FakeChild();
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41245,
      startupTimeoutMs: 20,
      shutdownTimeoutMs: 20,
      killVerificationTimeoutMs: 20,
      signalProcess: (_pid, signal) => child.kill(signal),
      spawnProcess: () => {
        queueMicrotask(() => child.stderr.write("fatal startup timeout\n"));
        return child as never;
      },
    });

    await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
      /fatal startup timeout/,
    );
  });

  it("does not retry a deterministic path mismatch", async () => {
    const child = new FakeChild();
    let requests = 0;
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41246,
      startupTimeoutMs: 100,
      signalProcess: (_pid, signal) => child.kill(signal),
      spawnProcess: () => {
        queueMicrotask(() =>
          child.stdout.write("opencode server listening on http://127.0.0.1:41246\n"),
        );
        return child as never;
      },
      readiness: {
        check: async () => {
          requests += 1;
          throw new OpenCodeReadinessError(
            "OpenCode path check resolved /other instead of /worktree",
            true,
          );
        },
      },
    });

    await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
      "resolved /other instead of /worktree",
    );
    expect(requests).toBe(1);
  });

  it("uses one startup deadline for listening and readiness", async () => {
    const child = new FakeChild();
    const signals: AbortSignal[] = [];
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41247,
      startupTimeoutMs: 50,
      shutdownTimeoutMs: 20,
      killVerificationTimeoutMs: 20,
      signalProcess: (_pid, signal) => child.kill(signal),
      spawnProcess: () => {
        setTimeout(
          () => child.stdout.write("opencode server listening on http://127.0.0.1:41247\n"),
          20,
        );
        return child as never;
      },
      readiness: {
        check: async (_baseUrl, _directory, signal) => {
          signals.push(signal);
          return await new Promise<never>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
      },
    });

    const startedAt = Date.now();
    await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
      "readiness failed",
    );
    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(signals).toHaveLength(1);
  });

  it("starts one loopback server with explicit cwd and environment, then reaps it", async () => {
    const child = new FakeChild();
    const config = { z: 1, nested: { b: true, a: "stable" } };
    const packageLock = {
      lockfileVersion: 1 as const,
      packages: { "provider-package": "1.0.0" },
    };
    const renderedConfig = {
      config,
      json: '{"nested":{"a":"stable","b":true},"z":1}\n',
      hash: hashOpenCodeConfig(config),
      packageLock,
      requiredEnvironment: ["REHOR_MODEL_PROXY_TOKEN"],
    };
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
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41234,
      base: {
        PATH: "/bin",
        HTTP_PROXY: "http://proxy:3128",
        REHOR_MODEL_PROXY_TOKEN: "explicitly-allowed",
      },
      requiredCapabilities: ["sse", "sessions"],
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        child.kill(signal);
      },
      spawnProcess,
      readiness: {
        // /global/health on the pinned server exposes only health and version.
        check: async () => ({ healthy: true, version: "1.18.29" }),
      },
      renderedConfig,
    });

    const info = await supervisor.start(TEST_WORKSPACE, new AbortController().signal);
    expect(info).toMatchObject({
      baseUrl: "http://127.0.0.1:41234",
      version: "1.18.29",
      hostname: "127.0.0.1",
      port: 41234,
      configHash: hashOpenCodeConfig(config),
    });
    expect(child.stdout.listenerCount("data")).toBe(1);
    expect(child.stderr.listenerCount("data")).toBe(1);
    if (!spawnCall) throw new Error("OpenCode process was not spawned");
    const configPath = String((spawnCall.options.env as NodeJS.ProcessEnv).OPENCODE_CONFIG);
    const packageLockPath = join(dirname(configPath), "opencode-packages.lock.json");
    await expect(readFile(configPath, "utf8")).resolves.toBe(
      '{"nested":{"a":"stable","b":true},"z":1}\n',
    );
    await expect(readFile(packageLockPath, "utf8")).resolves.toBe(
      '{"lockfileVersion":1,"packages":{"provider-package":"1.0.0"}}\n',
    );

    expect(spawnCall).toMatchObject({
      command: "/usr/local/bin/opencode-test",
      args: ["serve", "--hostname=127.0.0.1", "--port=41234"],
      options: {
        cwd: TEST_WORKSPACE,
        detached: true,
        env: expect.objectContaining({
          HTTP_PROXY: "http://proxy:3128",
          NO_PROXY: expect.stringContaining("127.0.0.1"),
          OPENCODE_CONFIG: expect.stringMatching(/\/opencode\.json$/),
          OPENCODE_CONFIG_DIR: expect.stringMatching(/rehor-opencode-/),
          OPENCODE_DB: expect.stringMatching(/rehor-opencode-.*\/opencode\.db$/),
          OPENCODE_TEST_HOME: expect.stringMatching(/rehor-opencode-/),
          NPM_CONFIG_OFFLINE: "true",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
          OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          REHOR_MODEL_PROXY_TOKEN: "explicitly-allowed",
        }),
      },
    });

    await supervisor.stop();
    expect(child.killedWith).toBe("SIGTERM");
    expect(signals).toEqual([{ pid: -1234, signal: "SIGTERM" }]);
    expect(supervisor.info).toBeUndefined();
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(packageLockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });

  it("aborts an in-flight readiness check when startup deadline expires", async () => {
    const child = new FakeChild();
    const readinessSignals: AbortSignal[] = [];
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41240,
      startupTimeoutMs: 20,
      shutdownTimeoutMs: 20,
      killVerificationTimeoutMs: 20,
      signalProcess: (_pid, signal) => child.kill(signal),
      spawnProcess: (_command, _args, _options) => {
        queueMicrotask(() =>
          child.stdout.write("opencode server listening on http://127.0.0.1:41240\\n"),
        );
        return child as never;
      },
      readiness: {
        check: async (_baseUrl, _directory, signal) => {
          readinessSignals.push(signal);
          return await new Promise<never>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
      },
    });

    await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
      "readiness failed",
    );
    expect(readinessSignals).toHaveLength(1);
    expect(readinessSignals[0].aborted).toBe(true);
  });

  it("rejects a listener announcement on a different loopback port", async () => {
    const child = new FakeChild();
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41241,
      startupTimeoutMs: 100,
      signalProcess: (_pid, signal) => child.kill(signal),
      spawnProcess: (_command, _args, _options) => {
        queueMicrotask(() =>
          child.stdout.write("opencode server listening on http://127.0.0.1:41242\\n"),
        );
        return child as never;
      },
      readiness: { check: async () => ({ healthy: true, version: "1.18.29" }) },
    });

    await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
      "unapproved port 41242; expected 41241",
    );
  });

  it("rejects a non-http listener announcement", async () => {
    const child = new FakeChild();
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41243,
      startupTimeoutMs: 100,
      signalProcess: (_pid, signal) => child.kill(signal),
      spawnProcess: (_command, _args, _options) => {
        queueMicrotask(() =>
          child.stdout.write("opencode server listening on https://127.0.0.1:41243\\n"),
        );
        return child as never;
      },
      readiness: { check: async () => ({ healthy: true, version: "1.18.29" }) },
    });

    await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
      "unapproved protocol https:",
    );
  });

  it("kills a surviving descendant after the leader exits and verifies the group is gone", async () => {
    const child = new FakeChild();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let groupAlive = true;
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41239,
      shutdownTimeoutMs: 20,
      killVerificationTimeoutMs: 50,
      processGroupExists: () => groupAlive,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM") {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        } else {
          groupAlive = false;
        }
      },
      spawnProcess: (_command, _args, _options) => {
        queueMicrotask(() =>
          child.stdout.write("opencode server listening on http://127.0.0.1:41239\n"),
        );
        return child as never;
      },
      readiness: { check: async () => ({ healthy: true, version: "1.18.29" }) },
    });

    await supervisor.start(TEST_WORKSPACE, new AbortController().signal);
    await supervisor.stop();

    expect(signals).toEqual([
      { pid: -1234, signal: "SIGTERM" },
      { pid: -1234, signal: "SIGKILL" },
    ]);
    expect(supervisor.info).toBeUndefined();
  });

  it("aborts and signals the process group when the server crashes", async () => {
    const child = new FakeChild();
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const supervisor = createTestSupervisor({
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

    await supervisor.start(TEST_WORKSPACE, new AbortController().signal);
    child.stderr.write("runtime diagnostic, not startup output\n");
    child.emit("exit", 1, null);

    expect(supervisor.crashSignal.aborted).toBe(true);
    expect(supervisor.crashError?.message).toContain("crashed after startup");
    expect(supervisor.crashError?.message).not.toContain("OpenCode startup output (tail)");
    await supervisor.stop();
    expect(signals).toEqual([{ pid: -1234, signal: "SIGTERM" }]);
  });

  it("rejects a relative binary path before spawning a child", () => {
    expect(() => new OpenCodeServerSupervisor({ command: "opencode" })).toThrow(
      "OpenCode binary path must be absolute",
    );
  });

  it("rejects a server whose health version differs from the pinned runtime", async () => {
    const child = new FakeChild();
    let readinessChecks = 0;
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41238,
      startupTimeoutMs: 100,
      shutdownTimeoutMs: 20,
      killVerificationTimeoutMs: 20,
      spawnProcess: (_command, _args, _options) => {
        queueMicrotask(() =>
          child.stdout.write("opencode server listening on http://127.0.0.1:41238\n"),
        );
        return child as never;
      },
      readiness: {
        check: async () => {
          readinessChecks += 1;
          return { healthy: true, version: "1.18.28" };
        },
      },
    });

    await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
      "does not satisfy expected version 1.18.29",
    );
    expect(readinessChecks).toBe(1);
  });

  it("rejects missing server capabilities during readiness admission", async () => {
    const child = new FakeChild();
    const supervisor = createTestSupervisor({
      command: "/usr/local/bin/opencode-test",
      port: 41235,
      requiredCapabilities: ["unsupported"],
      spawnProcess: (_command, _args, _options) => {
        queueMicrotask(() =>
          child.stdout.write("opencode server listening on http://127.0.0.1:41235\n"),
        );
        return child as never;
      },
      readiness: { check: async () => ({ healthy: true, version: "1.18.29" }) },
    });

    await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
      "missing capabilities: unsupported",
    );
  });

  it("rejects a non-loopback bind before spawning a child", () => {
    expect(() => createTestSupervisor({ hostname: "0.0.0.0" })).toThrow(
      "OpenCode server hostname must be loopback",
    );
  });
});
