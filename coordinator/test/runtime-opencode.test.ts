import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  OpenCode,
  type OpenCodeClient,
  type OpenCodeEvent,
  type SessionInfo,
} from "@opencode/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeRun, LegacyCompatibilityProjection } from "../src";
import { runtimeErrorDetails } from "../src/diagnostics";
import { parseRehorEvent, type RehorEvent, type RehorRun } from "../src/domain";
import { createStructuredLogger, type Logger } from "../src/log";
import {
  appendBoundedOpenCodeOutput,
  assertNoSystemManagedOpenCodeConfig,
  buildOpenCodeEnvironment,
  createOpenCodeFetch,
  HttpOpenCodeReadiness,
  hashOpenCodeConfig,
  type JsonValue,
  loadOpenCodeProjectConfig,
  type OpenCodeClientFactory,
  type OpenCodeConfigInput,
  OpenCodeReadinessError,
  OpenCodeRuntime,
  type OpenCodeServerController,
  type OpenCodeServerInfo,
  OpenCodeServerSupervisor,
  type OpenCodeSpawn,
  type RenderedOpenCodeConfig,
  renderOpenCodeConfig,
  renderOpenCodeConfigForCycle,
} from "../src/runtimes/opencode";
import { OPENCODE_OPERATIONAL_ENVIRONMENT_ALLOWLIST } from "../src/runtimes/opencode/environment";
import { renderOpenCodePolicyPlugin } from "../src/runtimes/opencode/policy-plugin";
import { boundedOperation } from "../src/runtimes/shared";

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});

const ROOT = "session-opencode";
const MODEL = { providerID: "rehor-openai", id: "gpt-5.6-luna" };
const TOKENS = { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } };
const TEST_WORKSPACE = process.cwd();
const TEST_COMMAND = "/usr/local/bin/opencode-test";
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
  limits: { timeoutMs: 5000, maxTurns: 10 },
  preflightPayloadRef: null,
};

// Fixtures are actual V2 event envelopes, not translated V1 SDK records.
let sequence = 0;
function event(type: string, data: Record<string, unknown>, created = ++sequence): OpenCodeEvent {
  return { id: `evt-${++sequence}`, type, created, data } as OpenCodeEvent;
}
function started(id = "assistant-1", sessionID = ROOT, model = MODEL) {
  return event("session.step.started", {
    sessionID,
    assistantMessageID: id,
    agent: "build",
    model,
    started: 1,
  });
}
function ended(id = "assistant-1", sessionID = ROOT, cost = 0.01) {
  return event("session.step.ended", {
    sessionID,
    assistantMessageID: id,
    finish: "stop",
    cost,
    tokens: TOKENS,
  });
}
function text(text: string, sessionID = ROOT, assistantMessageID = "assistant-1", ordinal = 0) {
  return event("session.text.ended", { sessionID, assistantMessageID, ordinal, text });
}
function succeeded(sessionID = ROOT) {
  return event("session.execution.succeeded", { sessionID });
}
function assistant(id = "assistant-1", value = "hello", model = MODEL) {
  return {
    id,
    type: "assistant",
    agent: "build",
    model,
    time: { created: 1, completed: 2 },
    content: [{ type: "text", text: value }],
    finish: "stop",
    cost: 0.01,
    tokens: TOKENS,
  };
}
function idle(outcome = "succeeded", error?: unknown) {
  return { id: "idle-1", type: "idle", outcome, time: { created: 3 }, ...(error ? { error } : {}) };
}
function sessionInfo(overrides: Record<string, unknown> = {}): SessionInfo {
  return {
    id: ROOT,
    projectID: "project",
    model: MODEL,
    location: { directory: "/worktree" },
    cost: 0,
    tokens: TOKENS,
    time: { created: 1, updated: 1 },
    ...overrides,
  } as SessionInfo;
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  killedWith?: NodeJS.Signals;
  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal;
    this.emit("exit", null, signal ?? "SIGTERM");
    this.emit("close", null, signal ?? "SIGTERM");
    return true;
  }
}
interface FakeServerOptions {
  version?: string;
  directory?: (requested: string) => string;
  healthStatus?: () => number;
  advertiseDelayMs?: number;
  block?: boolean;
  onHealth?: () => void;
}
function infoBody(version = "2.1.2") {
  return { version, pid: 123, urls: ["http://127.0.0.1:41236"], paths: { tmp: "/tmp/opencode" } };
}
function stubReadinessFetch(options: FakeServerOptions = {}): AbortSignal[] {
  const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal) signals.push(signal);
    if (url.pathname === "/api/info") {
      options.onHealth?.();
      if (options.block)
        return new Promise<Response>((_, reject) => {
          const abort = () => reject(signal?.reason ?? new Error("readiness aborted"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      return Response.json(infoBody(options.version), { status: options.healthStatus?.() ?? 200 });
    }
    const requested = url.searchParams.get("location[directory]") ?? "";
    return Response.json({ directory: options.directory?.(requested) ?? requested });
  });
  return signals;
}
function spawnFakeOpenCodeServer(
  child: FakeChild,
  options: FakeServerOptions = {},
): ReturnType<OpenCodeSpawn> {
  stubReadinessFetch(options);
  const announce = () => child.stdout.write('{"url":"http://127.0.0.1:41236"}\n');
  if (options.advertiseDelayMs) setTimeout(announce, options.advertiseDelayMs);
  else queueMicrotask(announce);
  return child as never;
}

interface FakeRuntimeOptions {
  events?: OpenCodeEvent[];
  logger?: Logger;
  serverDirectory?: string;
  streamError?: Error;
  messages?: unknown[];
  messagesBySession?: Record<string, unknown[]>;
  info?: SessionInfo;
  active?: Record<string, unknown>;
  children?: SessionInfo[];
  plugins?: unknown[];
  pluginError?: Error;
  pluginGate?: Promise<unknown>;
  createError?: Error;
  createGate?: Promise<unknown>;
  promptError?: Error;
  promptGate?: Promise<unknown>;
  interruptError?: Error;
  interruptGate?: Promise<unknown>;
  deleteError?: Error;
  deleteGate?: Promise<unknown>;
  streamReturnGate?: Promise<unknown>;
  streamNextGate?: Promise<unknown>;
  connectionEvent?: OpenCodeEvent | null;
  crashError?: Error;
  config?: Omit<OpenCodeConfigInput, "model"> & { model?: string };
  cleanupTimeoutMs?: number;
  requestTimeoutMs?: number;
  reconciliationTimeoutMs?: number;
}
type RequestCall = { input: Record<string, unknown>; signal?: AbortSignal };
function fakeRuntime(options: FakeRuntimeOptions = {}) {
  const calls = {
    start: 0,
    stop: 0,
    streamStarts: [] as number[],
    returns: 0,
    subscribe: [] as { signal?: AbortSignal }[],
    plugin: [] as RequestCall[],
    create: [] as RequestCall[],
    prompt: [] as RequestCall[],
    interrupt: [] as RequestCall[],
    remove: [] as RequestCall[],
    messages: [] as RequestCall[],
    active: [] as { signal?: AbortSignal }[],
    get: [] as RequestCall[],
    children: [] as RequestCall[],
    factory: [] as { server: OpenCodeServerInfo; directory: string; environment: unknown }[],
  };
  const capture = (list: RequestCall[], input: unknown, request?: { signal?: AbortSignal }) => {
    list.push({ input: input as Record<string, unknown>, signal: request?.signal });
  };
  const server: OpenCodeServerInfo = {
    baseUrl: "http://127.0.0.1:41236",
    hostname: "127.0.0.1",
    port: 41236,
    directory: options.serverDirectory ?? "/worktree",
    healthy: true,
    version: "2.1.2",
    password: "synthetic-private-password",
    capabilities: { persistentPty: true },
  };
  let activeServer: OpenCodeServerInfo | undefined;
  const crashController = new AbortController();
  const supervisor: OpenCodeServerController = {
    crashSignal: crashController.signal,
    get info() {
      return activeServer;
    },
    get crashError() {
      return crashController.signal.aborted ? crashController.signal.reason : undefined;
    },
    async start() {
      calls.start++;
      activeServer = server;
      return server;
    },
    async stop() {
      calls.stop++;
      activeServer = undefined;
    },
  };
  const client = {
    event: {
      subscribe: (request: { signal?: AbortSignal }) => {
        calls.subscribe.push(request);
        // Deliberately a plain AsyncIterator: SDK doesn't promise AsyncGenerator.
        return {
          [Symbol.asyncIterator]() {
            let index = -1;
            return {
              async next(): Promise<IteratorResult<OpenCodeEvent>> {
                if (index === -1) {
                  calls.streamStarts.push(calls.create.length);
                  index++;
                  await options.streamNextGate;
                  if (options.connectionEvent === null) return { done: true, value: undefined };
                  return {
                    done: false,
                    value: options.connectionEvent ?? event("server.connected", {}),
                  };
                }
                const next = options.events?.[index++];
                if (next) return { done: false, value: next };
                if (options.crashError) crashController.abort(options.crashError);
                if (options.streamError) throw options.streamError;
                return { done: true, value: undefined };
              },
              async return() {
                calls.returns++;
                await options.streamReturnGate;
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      },
    },
    plugin: {
      list: async (input: unknown, request: { signal?: AbortSignal }) => {
        capture(calls.plugin, input, request);
        await options.pluginGate;
        if (options.pluginError) throw options.pluginError;
        return {
          data: options.plugins ?? [{ id: "rehor-policy", state: { status: "active" } }],
          location: { directory: server.directory },
        };
      },
    },
    session: {
      create: async (input: unknown, request: { signal?: AbortSignal }) => {
        capture(calls.create, input, request);
        await options.createGate;
        if (options.createError) throw options.createError;
        return sessionInfo();
      },
      prompt: async (input: unknown, request: { signal?: AbortSignal }) => {
        capture(calls.prompt, input, request);
        await options.promptGate;
        if (options.promptError) throw options.promptError;
        return {
          id: "prompt-1",
          sessionID: ROOT,
          type: "user",
          payload: { text: runtimeRun.prompt },
          delivery: "steer",
          time: { created: 1 },
        };
      },
      interrupt: async (input: unknown, request: { signal?: AbortSignal }) => {
        assertLiveSignal(request);
        capture(calls.interrupt, input, request);
        await options.interruptGate;
        if (options.interruptError) throw options.interruptError;
        return { interrupted: true };
      },
      remove: async (input: unknown, request: { signal?: AbortSignal }) => {
        assertLiveSignal(request);
        capture(calls.remove, input, request);
        await options.deleteGate;
        if (options.deleteError) throw options.deleteError;
      },
      get: async (input: unknown, request: { signal?: AbortSignal }) => {
        capture(calls.get, input, request);
        return options.info ?? sessionInfo();
      },
      active: async (request: { signal?: AbortSignal }) => {
        calls.active.push(request);
        return options.active ?? { [ROOT]: { type: "running" } };
      },
      list: async (input: unknown, request: { signal?: AbortSignal }) => {
        capture(calls.children, input, request);
        return {
          data:
            options.children?.filter(
              (child) => child.parentID === (input as { parentID?: string }).parentID,
            ) ?? [],
          cursor: {},
        };
      },
    },
    message: {
      list: async (input: { sessionID: string }, request: { signal?: AbortSignal }) => {
        capture(calls.messages, input, request);
        return {
          data: options.messagesBySession?.[input.sessionID] ?? options.messages ?? [],
          cursor: {},
        };
      },
    },
  } as unknown as OpenCodeClient;
  const clientFactory: OpenCodeClientFactory = (server, directory, environment) => {
    calls.factory.push({ server, directory, environment });
    return client;
  };
  let renderedConfig: RenderedOpenCodeConfig | undefined;
  let renderError: unknown;
  try {
    const config = options.config ?? {};
    renderedConfig = renderOpenCodeConfig({
      ...config,
      model: config.model ?? runtimeRun.provider.requestedModel,
      providerId: config.providerId ?? runtimeRun.provider.id,
    });
  } catch (error) {
    renderError = error;
  }
  const runtime = new OpenCodeRuntime({
    logger: options.logger,
    supervisor: () => supervisor,
    clientFactory,
    renderedConfig,
    renderError,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
    reconciliationTimeoutMs: options.reconciliationTimeoutMs,
  });
  return { calls, runtime, crashController, supervisor, client };
}
function assertLiveSignal(request: { signal?: AbortSignal }) {
  if (!request.signal || request.signal.aborted) throw new Error("cleanup request was pre-aborted");
}
async function collect(events: AsyncIterable<RehorEvent>) {
  const result: RehorEvent[] = [];
  for await (const value of events) result.push(value);
  for (const value of result)
    expect(parseRehorEvent(value)).toMatchObject({
      runId: runtimeRun.runId,
      attemptId: runtimeRun.attemptId,
      provider: runtimeRun.provider.id,
      workspace: {
        worktreePath: runtimeRun.worktree.path,
        repository: runtimeRun.worktree.repository,
        snapshot: "commit",
      },
    });
  expect(result.filter((value) => value.kind === "terminal")).toHaveLength(1);
  expect(result.at(-1)?.kind).toBe("terminal");
  expect(result.map((value) => value.sequence)).toEqual(result.map((_, index) => index + 1));
  return result;
}
async function run(options: FakeRuntimeOptions = {}, input = runtimeRun) {
  const fake = fakeRuntime(options);
  await fake.runtime.start(new AbortController().signal);
  const events = await collect(fake.runtime.run(input, new AbortController().signal));
  return { ...fake, events };
}
async function waitForCondition(condition: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("test condition was not reached");
}
function createTestSupervisor(
  options: ConstructorParameters<typeof OpenCodeServerSupervisor>[0] = {},
) {
  return new OpenCodeServerSupervisor({
    workspaceRoot: TEST_WORKSPACE,
    command: TEST_COMMAND,
    shutdownTimeoutMs: 20,
    killVerificationTimeoutMs: 20,
    ...options,
  });
}
function nodeScriptSupervisor(
  source: string,
  options: ConstructorParameters<typeof OpenCodeServerSupervisor>[0] = {},
) {
  const leader: { current?: ReturnType<typeof spawn> } = {};
  return {
    leader,
    supervisor: createTestSupervisor({
      ...options,
      spawnProcess: (_command, _args, spawnOptions) => {
        leader.current = spawn(process.execPath, ["-e", source], spawnOptions);
        return leader.current;
      },
    }),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("bounded operations", () => {
  it("preserves the original deadline error", async () => {
    const error = new Error("known");
    await expect(
      boundedOperation(
        () => new Promise<never>(() => undefined),
        new AbortController().signal,
        Date.now() - 1,
        "operation",
        error,
      ),
    ).rejects.toBe(error);
  });
  it("does not start work when cancellation wins before its microtask", async () => {
    const controller = new AbortController();
    const operation = vi.fn();
    const pending = boundedOperation(operation, controller.signal, undefined, "operation");
    controller.abort("cancelled");
    await expect(pending).rejects.toThrow("cancelled");
    expect(operation).not.toHaveBeenCalled();
  });
});

const operational = {
  BOT_BOARD_ID: "42",
  BOT_BOARD_NAME: "Synthetic board",
  BOT_CONFIG_PATH: "/synthetic/config",
  BOT_INSTANCE_ID: "instance-7",
  BOT_JIRA_EMAIL: "bot@example.invalid",
  BOT_MEMORY_URL: "http://memory-server:8080",
  EXECUTOR_ADDR: "127.0.0.1:50551",
  GH_RELEASE_UPLOAD_URL: "http://proxy:8446/upload",
  GH_USER_NAME: "synthetic-github-bot",
  GL_USER_NAME: "synthetic-gitlab-bot",
  SLACK_NOTIFY_MODE: "batch",
  SLACK_WEBHOOK_URL: "http://127.0.0.1:18080/synthetic-webhook",
};
const blocked = [
  "GH_TOKEN",
  "OPENAI_API_KEY",
  "JIRA_API_TOKEN",
  "JIRA_MCP_TOKEN",
  "JIRA_USERNAME",
  "SLACK_OTHER_CREDENTIAL",
  "BOT_SECRET_TOKEN",
  "EXECUTOR_TOKEN",
  "UNKNOWN_AMBIENT",
];
describe("OpenCode environment", () => {
  it("copies only explicit runtime variables and preserves deterministic proxy routing", () => {
    const base = Object.freeze({
      PATH: "/bin",
      HOME: "/home/bot",
      GIT_CONFIG_GLOBAL: "/home/bot/.gitconfig",
      HTTP_PROXY: "http://proxy:3128",
      HTTPS_PROXY: "http://proxy:3128",
      NO_PROXY: "memory-server,proxy",
      REHOR_MODEL_PROXY_URL: "http://proxy:8450/v1",
      REHOR_MODEL_PROXY_TOKEN: "explicitly-allowed",
      REHOR_VERTEX_PROXY_URL: "http://proxy:8443",
      GOOGLE_APPLICATION_CREDENTIALS: "/secret",
      SECRET_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      DATABASE_URL: "secret",
      OPENCODE_CONFIG: "/ambient/config",
      OPENCODE_CONFIG_CONTENT: "ambient",
      OPENCODE_CONFIG_DIR: "/ambient",
      OPENCODE_PERMISSION: "ambient",
      OPENCODE_PASSWORD: "ambient",
      NODE_OPTIONS: "--require=/tmp/preload.cjs",
      NPM_CONFIG_REGISTRY: "https://example.invalid",
    });
    const environment = buildOpenCodeEnvironment({
      base,
      passthrough: Object.keys(base),
      noProxyHosts: ["model-gateway"],
    });
    expect(environment).toMatchObject({
      PATH: "/bin",
      HOME: "/home/bot",
      GIT_CONFIG_GLOBAL: "/home/bot/.gitconfig",
      HTTP_PROXY: base.HTTP_PROXY,
      http_proxy: base.HTTP_PROXY,
      HTTPS_PROXY: base.HTTPS_PROXY,
      https_proxy: base.HTTPS_PROXY,
      REHOR_MODEL_PROXY_URL: base.REHOR_MODEL_PROXY_URL,
      REHOR_MODEL_PROXY_TOKEN: base.REHOR_MODEL_PROXY_TOKEN,
      REHOR_VERTEX_PROXY_URL: base.REHOR_VERTEX_PROXY_URL,
    });
    for (const name of [
      "GOOGLE_APPLICATION_CREDENTIALS",
      "SECRET_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "DATABASE_URL",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_PERMISSION",
      "OPENCODE_PASSWORD",
      "NODE_OPTIONS",
      "NPM_CONFIG_REGISTRY",
    ])
      expect(environment[name]).toBeUndefined();
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
    expect(environment.NO_PROXY).toBe(environment.no_proxy);
  });
  it("copies exactly the operational allowlist without accepting prefix-matched secrets", () => {
    expect(OPENCODE_OPERATIONAL_ENVIRONMENT_ALLOWLIST).toEqual(Object.keys(operational));
    const base = Object.freeze({
      PATH: "/bin",
      ...operational,
      ...Object.fromEntries(blocked.map((name) => [name, "blocked"])),
    });
    const snapshot = { ...base };
    const environment = buildOpenCodeEnvironment({ base, passthrough: Object.keys(base) });
    expect(environment).toMatchObject(operational);
    expect(base).toEqual(snapshot);
    for (const name of blocked) expect(environment[name]).toBeUndefined();
  });
  it("keeps absent operational values absent and does not mutate the base", () => {
    const base = Object.freeze({ PATH: "/bin", HOME: "/home/bot" });
    const environment = buildOpenCodeEnvironment({ base });
    for (const name of OPENCODE_OPERATIONAL_ENVIRONMENT_ALLOWLIST)
      expect(environment[name]).toBeUndefined();
    expect(base).toEqual({ PATH: "/bin", HOME: "/home/bot" });
  });
  it.each(["", "  synthetic value  "])("preserves untrimmed operational value %j", (value) => {
    const base = Object.freeze(
      Object.fromEntries(OPENCODE_OPERATIONAL_ENVIRONMENT_ALLOWLIST.map((name) => [name, value])),
    );
    expect(buildOpenCodeEnvironment({ base })).toMatchObject(base);
  });
  it("derives Vertex proxy routing without leaking credentials", () => {
    const env = buildOpenCodeEnvironment({
      base: {
        PROXY_NAME: "custom-devbot-proxy",
        GOOGLE_APPLICATION_CREDENTIALS: "/secret",
        JIRA_MCP_URL: "http://jira-mcp:8444/mcp",
        GITHUB_TOKEN: "secret",
        JIRA_MCP_TOKEN: "secret",
      },
      passthrough: [
        "REHOR_VERTEX_PROXY_URL",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GITHUB_TOKEN",
        "JIRA_MCP_TOKEN",
      ],
    });
    expect(env.REHOR_VERTEX_PROXY_URL).toBe("http://custom-devbot-proxy:8443");
    expect(env.NO_PROXY).toContain("custom-devbot-proxy");
    expect(env.JIRA_MCP_URL).toBe("http://jira-mcp:8444/mcp");
    for (const name of ["GOOGLE_APPLICATION_CREDENTIALS", "GITHUB_TOKEN", "JIRA_MCP_TOKEN"])
      expect(env[name]).toBeUndefined();
  });
  it("rejects Node environment proxy mode", () => {
    const previous = process.env.NODE_USE_ENV_PROXY;
    process.env.NODE_USE_ENV_PROXY = "1";
    try {
      expect(() => createOpenCodeFetch()).toThrow("NODE_USE_ENV_PROXY=1");
    } finally {
      if (previous === undefined) delete process.env.NODE_USE_ENV_PROXY;
      else process.env.NODE_USE_ENV_PROXY = previous;
    }
  });
});

describe("OpenCode V2 readiness and real SDK transport", () => {
  it("authenticates both server info and location requests", async () => {
    const requests: { url: URL; headers: Headers }[] = [];
    const readiness = new HttpOpenCodeReadiness(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({ url, headers: request.headers });
      return Response.json(
        url.pathname === "/api/info"
          ? { ...infoBody(), capabilities: { persistentPty: true } }
          : { directory: "/worktree" },
      );
    });
    await expect(
      readiness.check(
        "http://127.0.0.1:4096",
        "/worktree",
        new AbortController().signal,
        "private",
      ),
    ).resolves.toEqual({ healthy: true, version: "2.1.2", capabilities: { persistentPty: true } });
    expect(requests.map((x) => x.url.pathname)).toEqual(["/api/info", "/api/location"]);
    expect(requests[1]?.url.searchParams.get("location[directory]")).toBe("/worktree");
    for (const request of requests)
      expect(request.headers.get("authorization")).toBe(
        `Basic ${Buffer.from("opencode:private").toString("base64")}`,
      );
  });
  it.each(["/api/info", "/api/location"])(
    "classifies non-ready HTTP responses from %s",
    async (path) => {
      for (const status of [401, 403, 500, 502, 503, 504]) {
        const readiness = new HttpOpenCodeReadiness(async (input) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          return Response.json(infoBody(), { status: url.pathname === path ? status : 200 });
        });
        await expect(
          readiness.check("http://127.0.0.1:4096", "/worktree", new AbortController().signal),
        ).rejects.toMatchObject({ deterministic: status === 401 || status === 403 });
      }
    },
  );
  it.each([
    {},
    { ...infoBody(), version: "" },
    { ...infoBody(), pid: 0 },
    { ...infoBody(), paths: {} },
    { ...infoBody(), capabilities: [] },
  ])("rejects malformed server info %j", async (body) => {
    const readiness = new HttpOpenCodeReadiness(async () => Response.json(body));
    await expect(
      readiness.check("http://127.0.0.1:4096", "/worktree", new AbortController().signal),
    ).rejects.toBeInstanceOf(OpenCodeReadinessError);
  });
  it("accepts symlinked worktrees but rejects another canonical directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-readiness-"));
    const alias = `${root}-link`;
    await symlink(root, alias);
    try {
      const readiness = new HttpOpenCodeReadiness(async (input) =>
        Response.json(
          (input instanceof Request ? input.url : String(input)).includes("/api/info")
            ? infoBody()
            : { directory: root },
        ),
      );
      await expect(
        readiness.check("http://127.0.0.1:4096", alias, new AbortController().signal),
      ).resolves.toMatchObject({ version: "2.1.2" });
      await expect(
        readiness.check("http://127.0.0.1:4096", "/other", new AbortController().signal),
      ).rejects.toMatchObject({ deterministic: true });
    } finally {
      await rm(alias, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects non-loopback URLs before injected transport", async () => {
    const transport = vi.fn();
    const readiness = new HttpOpenCodeReadiness(transport);
    await expect(
      readiness.check("http://model-gateway:4096", "/worktree", new AbortController().signal),
    ).rejects.toThrow("not a loopback address");
    expect(transport).not.toHaveBeenCalled();
  });
  it("uses actual SDK flat prompt payload, authorization and unwrapped inbox response", async () => {
    const received: unknown[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      received.push({
        path: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: {
            id: "input",
            sessionID: ROOT,
            type: "user",
            payload: { text: "hello" },
            delivery: "steer",
            time: { created: 1 },
          },
        }),
      );
    });
    try {
      const port = await listen(server);
      const client = OpenCode.make({
        baseUrl: `http://127.0.0.1:${port}`,
        fetch: createOpenCodeFetch(),
        headers: { authorization: "Basic synthetic" },
      });
      await expect(
        client.session.prompt({ sessionID: ROOT, text: "hello" }),
      ).resolves.toMatchObject({ id: "input", type: "user", payload: { text: "hello" } });
      expect(received).toEqual([
        {
          path: `/api/session/${ROOT}/prompt`,
          authorization: "Basic synthetic",
          body: { text: "hello" },
        },
      ]);
    } finally {
      await close(server);
    }
  });
});
function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("missing port"));
      else resolve(address.port);
    });
  });
}
function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("OpenCode V2 runtime lifecycle", () => {
  it("primes a plain iterator, validates policy, creates the scoped model session and cleans up", async () => {
    const fake = fakeRuntime({
      serverDirectory: "/canonical-worktree",
      events: [started(), text("hello"), ended(), succeeded()],
    });
    await expect(fake.runtime.start(new AbortController().signal)).resolves.toMatchObject({
      runtimeId: "opencode",
      runtimeVersion: "2.1.2",
      streaming: true,
    });
    const events = await collect(fake.runtime.run(runtimeRun, new AbortController().signal));
    expect(fake.calls.streamStarts).toEqual([0]);
    expect(fake.calls.factory[0]?.directory).toBe("/canonical-worktree");
    expect(fake.calls.factory[0]?.environment).toEqual(fake.runtime.environment);
    expect(fake.calls.subscribe[0]).toEqual({ signal: expect.any(AbortSignal) });
    expect(fake.calls.plugin[0]?.input).toEqual({ location: { directory: "/canonical-worktree" } });
    expect(fake.calls.create[0]?.input).toEqual({
      title: `Rehor ${runtimeRun.runId}`,
      location: { directory: "/canonical-worktree" },
      model: MODEL,
    });
    expect(fake.calls.prompt[0]?.input).toEqual({ sessionID: ROOT, text: runtimeRun.prompt });
    expect(fake.calls.interrupt[0]?.input).toEqual({ sessionID: ROOT, resume: false });
    expect(fake.calls.remove[0]?.input).toEqual({ sessionID: ROOT });
    for (const request of [
      ...fake.calls.create,
      ...fake.calls.prompt,
      ...fake.calls.interrupt,
      ...fake.calls.remove,
    ]) {
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.signal?.aborted).toBe(false);
    }
    expect(fake.calls.create[0]?.signal).not.toBe(fake.calls.subscribe[0]?.signal);
    expect(fake.calls.returns).toBe(1);
    expect(fake.calls.stop).toBe(1);
    expect(fake.calls.messages).toHaveLength(0);
    expect(events.at(-1)?.payload).toMatchObject({
      state: "completed",
      resultText: "hello",
      turns: 1,
    });
  });
  it.each([
    { plugins: [] },
    {
      plugins: [{ id: "rehor-policy", state: { status: "failed", error: "private-plugin-body" } }],
    },
    { plugins: [{ id: "other", state: { status: "active" } }] },
    {
      plugins: [
        { id: "rehor-policy", state: { status: "active" } },
        { id: "rehor-policy", state: { status: "failed" } },
      ],
    },
  ])(
    "does not admit any prompt when required policy inventory is inactive: %j",
    async ({ plugins }) => {
      const { calls, events } = await run({ plugins, events: [succeeded()], requestTimeoutMs: 20 });
      expect(calls.create).toHaveLength(0);
      expect(calls.prompt).toHaveLength(0);
      expect(calls.messages).toHaveLength(0);
      expect(calls.stop).toBe(1);
      expect(calls.returns).toBe(1);
      expect(events.at(-1)?.payload).toMatchObject({
        state: "failed",
        reason: expect.stringContaining("rehor-policy is not active"),
      });
      expect(JSON.stringify(events)).not.toContain("private-plugin-body");
    },
  );
  it("does not admit prompts after policy inventory request failure", async () => {
    const { calls, events } = await run({ pluginError: new Error("inventory failed") });
    expect(calls.prompt).toHaveLength(0);
    expect(calls.create).toHaveLength(0);
    expect(calls.stop).toBe(1);
    expect(events.at(-1)?.payload.state).toBe("failed");
  });
  it("waits for asynchronous policy activation without admitting a prompt early", async () => {
    const fake = fakeRuntime({ events: [succeeded()], requestTimeoutMs: 500 });
    const inventory = vi.spyOn(fake.client.plugin, "list");
    inventory.mockImplementationOnce(async () => {
      expect(fake.calls.create).toHaveLength(0);
      expect(fake.calls.prompt).toHaveLength(0);
      return { location: { directory: "/worktree" }, data: [] };
    });
    await fake.runtime.start(new AbortController().signal);
    const events = await collect(fake.runtime.run(runtimeRun, new AbortController().signal));
    expect(inventory).toHaveBeenCalledTimes(2);
    expect(fake.calls.prompt).toHaveLength(1);
    expect(events.at(-1)?.payload.state).toBe("completed");
  });
  it.each(["pluginGate", "createGate", "streamNextGate"] as const)(
    "bounds stalled setup operation %s",
    async (gate) => {
      const start = Date.now();
      const { calls, events } = await run({
        [gate]: new Promise(() => undefined),
        requestTimeoutMs: 20,
        cleanupTimeoutMs: 20,
      });
      expect(Date.now() - start).toBeLessThan(500);
      expect(calls.prompt).toHaveLength(0);
      expect(calls.stop).toBe(1);
      expect(events.at(-1)?.payload.state).toBe("failed");
    },
  );
  it.each([null, event("session.created", { sessionID: ROOT })])(
    "rejects missing/malformed stream handshake",
    async (connectionEvent) => {
      const { calls, events } = await run({ connectionEvent });
      expect(calls.create).toHaveLength(0);
      expect(calls.stop).toBe(1);
      expect(events.at(-1)?.payload.reason).toContain("server.connected");
    },
  );
  it("rejects invalid rendered config before starting supervisor", async () => {
    const { calls, events } = await run({ config: { allowedTools: ["UnknownTool"] } });
    expect(calls.start).toBe(0);
    expect(calls.factory).toHaveLength(0);
    expect(events.at(-1)?.payload.state).toBe("failed");
  });
  it("uses configured model without changing provider attribution", async () => {
    const model = { providerID: "override-provider", id: "override-model" };
    const { calls, events, runtime } = await run({
      config: {
        model: model.id,
        providerId: model.providerID,
        providers: [
          {
            id: model.providerID,
            package: "aisdk:override-package",
            settings: { apiKey: "$" + "{REHOR_MODEL_PROXY_TOKEN}" },
          },
        ],
        packages: [{ name: "override-package", version: "1.0.0" }],
      },
      events: [started("a", ROOT, model), text("hello", ROOT, "a"), ended("a"), succeeded()],
    });
    expect(calls.create[0]?.input.model).toEqual(model);
    expect(runtime.renderedConfiguration?.hash).toBe(
      hashOpenCodeConfig(runtime.renderedConfiguration?.config ?? {}),
    );
    expect(runtime.renderedConfiguration?.requiredEnvironment).toEqual(["REHOR_MODEL_PROXY_TOKEN"]);
    expect(events.every((value) => value.provider === runtimeRun.provider.id)).toBe(true);
    expect(events.at(-1)?.model).toBe("override-provider/override-model");
    expect(events.find((value) => value.kind === "usage")?.payload.requestedModel).toBe(
      "override-provider/override-model",
    );
  });
  it.each(["permission.asked", "form.created"])(
    "fails headless %s without leaking request data or hanging",
    async (type) => {
      const data =
        type === "permission.asked"
          ? { sessionID: ROOT, id: "request", metadata: { secret: "private-request" } }
          : { form: { sessionID: ROOT, id: "form", title: "private-request" } };
      const { calls, events } = await run({ events: [event(type, data)] });
      expect(events.find((value) => value.kind === "policy")).toBeDefined();
      expect(events.at(-1)?.payload).toMatchObject({
        state: "failed",
        reason: expect.stringContaining("headless mode"),
      });
      expect(JSON.stringify(events)).not.toContain("private-request");
      expect(calls.interrupt).toHaveLength(1);
      expect(calls.remove).toHaveLength(1);
    },
  );
  it("ignores foreign permission and form events", async () => {
    const { events } = await run({
      events: [
        event("permission.asked", { sessionID: "foreign" }),
        event("form.created", { form: { sessionID: "foreign" } }),
        succeeded(),
      ],
    });
    expect(events.filter((value) => value.kind === "policy")).toHaveLength(0);
    expect(events.at(-1)?.payload.state).toBe("completed");
  });
  it("handles child headless requests without waiting for root completion", async () => {
    const { events } = await run({
      events: [
        event("session.created", { sessionID: "child", parentID: ROOT }),
        event("form.created", { form: { sessionID: "child", id: "form" } }),
      ],
    });
    expect(events.at(-1)?.payload.state).toBe("failed");
  });
  it("retains completed result and emits cleanup diagnostics instead of contradictory error", async () => {
    const { events, calls } = await run({
      deleteError: new Error("remove rejected"),
      events: [succeeded()],
    });
    expect(events.at(-1)?.payload.state).toBe("completed");
    expect(events.find((value) => value.kind === "cleanup")?.payload.state).toBe("failed");
    expect(events.find((value) => value.kind === "error")).toBeUndefined();
    expect(calls.stop).toBe(1);
  });
  it("still removes session and stops server after interrupt failure", async () => {
    const { calls, events } = await run({
      interruptError: new Error("interrupt rejected"),
      events: [succeeded()],
    });
    expect(calls.remove).toHaveLength(1);
    expect(calls.stop).toBe(1);
    expect(events.at(-1)?.payload.state).toBe("completed");
    expect(events.find((value) => value.kind === "cleanup")).toBeDefined();
  });
  it.each(["streamReturnGate", "interruptGate", "deleteGate"] as const)(
    "uses one bounded cleanup budget for %s and always stops server",
    async (gate) => {
      const start = Date.now();
      const { calls, events } = await run({
        [gate]: new Promise(() => undefined),
        cleanupTimeoutMs: 20,
        events: [succeeded()],
      });
      expect(Date.now() - start).toBeLessThan(500);
      expect(calls.stop).toBe(1);
      expect(events.at(-1)?.payload.state).toBe("completed");
      expect(events.find((value) => value.kind === "cleanup")).toBeDefined();
    },
  );
  it("passes cancellation to active prompt but uses live cleanup signals", async () => {
    const fake = fakeRuntime({ promptGate: new Promise(() => undefined) });
    const controller = new AbortController();
    await fake.runtime.start(controller.signal);
    const pending = collect(fake.runtime.run(runtimeRun, controller.signal));
    await waitForCondition(() => fake.calls.prompt.length === 1);
    controller.abort("cancelled");
    expect((await pending).at(-1)?.payload.state).toBe("failed");
    expect(fake.calls.prompt[0]?.signal?.aborted).toBe(true);
    for (const request of [...fake.calls.interrupt, ...fake.calls.remove])
      expect(request.signal?.aborted).toBe(false);
    expect(fake.calls.messages).toHaveLength(0);
    expect(fake.calls.stop).toBe(1);
  });
  it("preserves coordinator timeout ownership and cleans up with live signals", async () => {
    const { runtime, calls } = fakeRuntime({ promptGate: new Promise(() => undefined) });
    const result = await executeRun(runtime, {
      ...runtimeRun,
      limits: { ...runtimeRun.limits, timeoutMs: 30 },
    });
    expect(result.terminal.payload.state).toBe("timed_out");
    expect(result.error).toBeUndefined();
    expect(calls.prompt[0]?.signal?.aborted).toBe(true);
    expect(calls.remove[0]?.signal?.aborted).toBe(false);
    expect(calls.stop).toBe(2);
  });
  it("leaves direct-run timeout and maxTurns enforcement to coordinator", async () => {
    const events: OpenCodeEvent[] = [];
    for (let i = 0; i < 3; i++) events.push(started(`a-${i}`), ended(`a-${i}`));
    events.push(succeeded());
    const result = await run(
      { promptGate: new Promise((resolve) => setTimeout(resolve, 20)), events },
      { ...runtimeRun, limits: { timeoutMs: 1, maxTurns: 1 } },
    );
    expect(result.events.at(-1)?.payload).toMatchObject({ state: "completed", turns: 3 });
  });
  it("allows maxTurns-th finished step to reach terminal success", async () => {
    const { runtime } = fakeRuntime({
      events: [started(), text("last answer"), ended(), succeeded()],
    });
    const result = await executeRun(runtime, {
      ...runtimeRun,
      limits: { ...runtimeRun.limits, maxTurns: 1 },
    });
    expect(result.terminal.payload).toMatchObject({
      state: "completed",
      resultText: "last answer",
      turns: 1,
    });
  });
  it("records pending usage before next-turn budget abort without allowing another tool", async () => {
    const costs: unknown[] = [];
    const tool = (type: "called" | "success", messageId: string, id: string) =>
      event(`session.tool.${type}`, {
        sessionID: ROOT,
        assistantMessageID: messageId,
        id,
        executed: true,
        ...(type === "called"
          ? { name: "read", input: { path: "README.md" } }
          : { content: [{ type: "text", text: "file contents" }] }),
      });
    const { runtime, calls } = fakeRuntime({
      events: [
        started("priced"),
        ended("priced", ROOT, 0.25),
        started("tool-step"),
        tool("called", "tool-step", "budget-filling-tool"),
        tool("success", "tool-step", "budget-filling-tool"),
        ended("tool-step", ROOT, 0.5),
        started("unrelated", "unrelated-session"),
        started("budget-blocked"),
        tool("called", "budget-blocked", "over-budget-tool"),
        tool("success", "budget-blocked", "over-budget-tool"),
        ended("budget-blocked", ROOT, 999),
        succeeded(),
      ],
    });
    const projection = new LegacyCompatibilityProjection({
      costs: {
        write: (record) => {
          costs.push(record);
        },
      },
    });
    const result = await executeRun(
      runtime,
      { ...runtimeRun, limits: { ...runtimeRun.limits, maxTurns: 1 } },
      { projection },
    );
    expect(result.terminal.payload).toMatchObject({
      state: "failed",
      reason: "max_turns",
      turns: 2,
    });
    expect(result.error).toBeUndefined();
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ costUsd: 0.75, inputTokens: 20, costIncomplete: true });
    const usages = result.events.filter((value) => value.kind === "usage");
    expect(usages.at(-2)?.payload).toMatchObject({
      final: true,
      incomplete: false,
      cost: { amount: 0.75 },
    });
    const pending = usages.at(-1);
    expect(pending?.payload).toMatchObject({
      final: false,
      partial: true,
      incomplete: true,
      tokenCounts: { input: 20, output: 4, reasoning: 2 },
      cost: { amount: 0.75 },
    });
    const pendingModel = result.events.find(
      (value) => value.kind === "model" && value.payload.messageId === "budget-blocked",
    );
    expect(pendingModel).toBeDefined();
    expect(pending?.parentEventId).toBe(pendingModel?.eventId);
    const turns = result.events.filter(
      (value) => value.kind === "run" && value.payload.state === "turn_started",
    );
    expect(turns).toHaveLength(3);
    expect(pending?.sequence).toBeLessThan(turns.at(-1)?.sequence ?? 0);
    expect(result.events.map((value) => value.sequence)).toEqual(
      result.events.map((_, index) => index + 1),
    );
    expect(
      result.events
        .filter((value) => value.kind === "tool")
        .map((value) => value.payload.toolUseId),
    ).toEqual(["budget-filling-tool", "budget-filling-tool"]);
    expect(result.events.some((value) => value.runtimeSessionRef === "unrelated-session")).toBe(
      false,
    );
    expect(calls.messages).toHaveLength(0);
    expect(calls.interrupt).toHaveLength(1);
  });
  it("reconciles lost prompt response using authoritative V2 messages and outcome", async () => {
    const { calls, events } = await run({
      promptError: new Error("prompt response lost"),
      active: {},
      info: sessionInfo({ outcome: "succeeded", time: { created: 1, updated: 3, idle: 3 } }),
      messages: [assistant(), idle()],
    });
    expect(calls.messages.length).toBeGreaterThan(0);
    expect(calls.get.length).toBeGreaterThan(0);
    expect(events.at(-1)?.payload).toMatchObject({ state: "completed", resultText: "hello" });
    const model = events.find((value) => value.kind === "model");
    const usage = events.find((value) => value.kind === "usage");
    expect(model).toBeDefined();
    expect(usage?.parentEventId).toBe(model?.eventId);
  });
  it("preserves partial text and replaces it from authoritative recovery without double counting", async () => {
    const { events } = await run({
      events: [
        started(),
        event("session.text.delta", {
          sessionID: ROOT,
          assistantMessageID: "assistant-1",
          ordinal: 0,
          delta: "hel",
        }),
      ],
      streamError: new Error("disconnected"),
      active: {},
      info: sessionInfo({ outcome: "succeeded", time: { created: 1, updated: 3, idle: 3 } }),
      messages: [assistant(), idle()],
    });
    expect(events.at(-1)?.payload).toMatchObject({
      state: "completed",
      resultText: "hello",
      turns: 1,
    });
  });
  it.each([
    { active: {}, info: sessionInfo(), messages: [] },
    { active: {}, info: sessionInfo(), messages: [{ ...assistant(), finish: "tool-calls" }] },
    { active: { [ROOT]: { type: "running" } }, info: sessionInfo(), messages: [assistant()] },
  ])(
    "does not infer success from inactive/assistant-only or busy evidence %j",
    async (evidence) => {
      const { events } = await run({ ...evidence, streamError: new Error("disconnected") });
      expect(events.at(-1)?.payload.state).toBe("failed");
      expect(events.find((value) => value.kind === "persistence")?.payload.state).toBe(
        "not_resumable",
      );
    },
  );
  it("reports provider failure without requiring an assistant message", async () => {
    const error = { type: "provider.no-route", message: "Model unavailable" };
    const { events } = await run({
      active: {},
      info: sessionInfo({ outcome: "failed", time: { created: 1, updated: 2, idle: 2 } }),
      messages: [idle("failed", error)],
      streamError: new Error("disconnected"),
    });
    expect(events.at(-1)?.payload).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("Model unavailable"),
    });
  });
  it("signals opencode_crash to coordinator for unreconciled transport loss", async () => {
    const { runtime } = fakeRuntime({ promptError: new Error("response lost"), active: {} });
    const result = await executeRun(runtime, runtimeRun);
    expect(result.terminal.payload).toMatchObject({
      state: "interrupted",
      reason: "opencode_crash",
    });
  });
  it("preserves partial evidence and avoids reconciliation after server crash", async () => {
    const { events, calls } = await run({
      events: [started(), text("partial")],
      crashError: new Error("server crashed"),
    });
    expect(events.at(-1)?.payload).toMatchObject({ state: "failed", resultText: "partial" });
    expect(events.find((value) => value.kind === "persistence")).toBeDefined();
    expect(calls.messages).toHaveLength(0);
    expect(calls.stop).toBe(1);
  });
  it("logs safe diagnostics from V2 event.data with run identity", async () => {
    const records: Record<string, unknown>[] = [];
    const { events } = await run({
      logger: createStructuredLogger({ write: (line) => records.push(JSON.parse(line)) }),
      events: [
        event("session.execution.failed", {
          sessionID: ROOT,
          error: {
            type: "InitError",
            message: "Cannot find package @ai-sdk/openai",
            response: { body: "private-body" },
          },
        }),
      ],
    });
    expect(events.at(-1)?.payload.state).toBe("failed");
    expect(records).toContainEqual(
      expect.objectContaining({
        run_id: runtimeRun.runId,
        attempt_id: runtimeRun.attemptId,
        message: "OpenCode session error",
        diagnostic: expect.stringContaining("module not found"),
      }),
    );
    expect(JSON.stringify(records)).not.toContain("private-body");
    expect(JSON.stringify(records)).not.toContain("synthetic-private-password");
  });
  it("redacts sensitive request failures before terminal persistence", async () => {
    const { events } = await run({ promptError: new Error("Authorization: Bearer private-token") });
    expect(JSON.stringify(events)).not.toContain("private-token");
    expect(events.at(-1)?.payload.state).toBe("failed");
  });
  it("ignores future and foreign events without leaking their payloads", async () => {
    const { events } = await run({
      events: [
        event("runtime.future", { sessionID: ROOT, secret: "must-not-leak" }),
        text("foreign", "foreign"),
        succeeded(),
      ],
    });
    expect(events.find((value) => value.kind === "runtime-exit")).toBeUndefined();
    expect(events.at(-1)?.payload.state).toBe("completed");
    expect(JSON.stringify(events)).not.toContain("must-not-leak");
    expect(events.at(-1)?.payload.resultText).toBeUndefined();
  });
  it("keeps reasoning and child text out of root result, counts steps once", async () => {
    const start = started();
    const finish = ended();
    const { events } = await run({
      events: [
        event("session.created", { sessionID: ROOT }),
        event("session.created", { sessionID: "child", parentID: ROOT }),
        start,
        start,
        event("session.reasoning.ended", {
          sessionID: ROOT,
          assistantMessageID: "assistant-1",
          ordinal: 0,
          text: "private-reasoning",
        }),
        text("root"),
        text("child", "child"),
        finish,
        finish,
        succeeded("child"),
        succeeded(),
      ],
    });
    expect(events.filter((value) => value.payload.state === "child_session_started")).toHaveLength(
      1,
    );
    expect(events.at(-1)?.payload).toMatchObject({
      state: "completed",
      resultText: "root",
      turns: 1,
    });
  });
  it("keeps cumulative usage separate by provider-qualified root/child model", async () => {
    const childModel = { providerID: "child-provider", id: "child-model" };
    const { events } = await run({
      events: [
        event("session.created", { sessionID: "child", parentID: ROOT }),
        started(),
        ended(),
        started("b"),
        ended("b", ROOT, 0.02),
        started("c", "child", childModel),
        ended("c", "child", 0.03),
        succeeded(),
      ],
    });
    const usage = events.filter((value) => value.kind === "usage");
    expect(
      [...usage].reverse().find((value) => value.payload.modelKey === "rehor-openai/gpt-5.6-luna")
        ?.payload,
    ).toMatchObject({
      tokenCounts: { input: 20, output: 4, reasoning: 2, cacheRead: 6, cacheWrite: 8 },
      cost: { amount: 0.03 },
    });
    expect(
      [...usage].reverse().find((value) => value.payload.modelKey === "child-provider/child-model")
        ?.payload,
    ).toMatchObject({ tokenCounts: { input: 10 }, cost: { amount: 0.03 } });
  });
  it("preserves tools, deduplication, timing and legacy work-context projection", async () => {
    const statuses: unknown[] = [];
    const costs: unknown[] = [];
    const cycleRuns: unknown[] = [];
    const input = { external_key: "REHOR-143", repo: "rehor", summary: "Fix OpenCode parity" };
    const resultText = JSON.stringify({ id: 143, external_key: "REHOR-143" });
    const success = event(
      "session.tool.success",
      {
        sessionID: ROOT,
        assistantMessageID: "assistant-1",
        id: "call-1",
        executed: true,
        content: [{ type: "text", text: resultText }],
      },
      30,
    );
    const { runtime } = fakeRuntime({
      events: [
        started(),
        event(
          "session.tool.input.started",
          {
            sessionID: ROOT,
            assistantMessageID: "assistant-1",
            id: "call-1",
            name: "mcp__bot-memory__task_add",
          },
          10,
        ),
        event(
          "session.tool.called",
          {
            sessionID: ROOT,
            assistantMessageID: "assistant-1",
            id: "call-1",
            input,
            executed: true,
          },
          10,
        ),
        success,
        success,
        text("Completed parity work."),
        ended(),
        succeeded(),
      ],
    });
    const projection = new LegacyCompatibilityProjection({
      status: {
        write: (value) => {
          statuses.push(value);
        },
      },
      costs: {
        write: (value) => {
          costs.push(value);
        },
      },
      cycleRuns: {
        write: (value) => {
          cycleRuns.push(value);
        },
      },
    });
    const result = await executeRun(runtime, runtimeRun, { projection });
    const tools = result.events.filter((value) => value.kind === "tool");
    const completed = tools.filter((value) => value.payload.state === "completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({
      name: "mcp__bot-memory__task_add",
      toolName: "mcp__bot-memory__task_add",
      toolUseId: "call-1",
      content: resultText,
      durationMs: 20,
    });
    expect(completed[0]?.payload).not.toHaveProperty("output");
    expect(result.terminal.payload).toMatchObject({
      context: {
        taskId: 143,
        externalKey: "REHOR-143",
        repository: "rehor",
        workType: "new_ticket",
        summary: input.summary,
      },
    });
    expect(statuses).toContainEqual(
      expect.objectContaining({ message: "Tool: mcp__bot-memory__task_add" }),
    );
    expect(costs[0]).toMatchObject({ repository: "rehor", externalKey: "REHOR-143" });
    expect(cycleRuns[0]).toMatchObject({ taskId: 143, cycleType: "task_work" });
  });
});

describe("OpenCode process supervisor", () => {
  it.each([false, true])(
    "sanitizes actual server environment (operational values present: %s)",
    async (present) => {
      const base = Object.freeze({
        PATH: process.env.PATH,
        ...(present ? operational : {}),
        REHOR_MODEL_PROXY_TOKEN: "synthetic-provider-token",
        ...Object.fromEntries(blocked.map((name) => [name, "synthetic-blocked"])),
        OPENCODE_PERMISSION: "ambient",
        OPENCODE_AUTH_CONTENT: "ambient",
        NPM_CONFIG_REGISTRY: "https://example.invalid",
      });
      const snapshot = { ...base };
      const source = `const http = require("node:http"); const server = http.createServer((request, response) => { const url = new URL(request.url, "http://localhost"); response.setHeader("content-type", "application/json"); response.end(JSON.stringify(url.pathname === "/api/info" ? ${JSON.stringify(infoBody())} : url.pathname === "/api/location" ? {directory: process.cwd()} : process.env)); }); server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({url:"http://127.0.0.1:"+server.address().port})));`;
      const { supervisor } = nodeScriptSupervisor(source, {
        base,
        passthrough: [
          "REHOR_MODEL_PROXY_TOKEN",
          ...blocked,
          "OPENCODE_PERMISSION",
          "NPM_CONFIG_REGISTRY",
        ],
        startupTimeoutMs: 5000,
      });
      try {
        const info = await supervisor.start(TEST_WORKSPACE, AbortSignal.timeout(5000));
        const env = await (await fetch(`${info.baseUrl}/environment`)).json();
        for (const [name, value] of Object.entries(operational))
          expect(env[name]).toBe(present ? value : undefined);
        for (const name of [
          ...blocked,
          "OPENCODE_PERMISSION",
          "OPENCODE_AUTH_CONTENT",
          "NPM_CONFIG_REGISTRY",
        ])
          expect(env[name]).toBeUndefined();
        expect(env.REHOR_MODEL_PROXY_TOKEN).toBe("synthetic-provider-token");
        expect(env.NPM_CONFIG_OFFLINE).toBe("true");
        expect(base).toEqual(snapshot);
      } finally {
        await supervisor.stop();
      }
    },
  );
  it("fails closed on Linux managed config", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-managed-"));
    const path = join(root, "opencode.json");
    try {
      await expect(assertNoSystemManagedOpenCodeConfig(path, "linux")).resolves.toBeUndefined();
      await writeFile(path, "{}\n");
      await expect(assertNoSystemManagedOpenCodeConfig(path, "linux")).rejects.toThrow(
        "system-managed config",
      );
      await expect(assertNoSystemManagedOpenCodeConfig(path, "darwin")).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("requires approved workspace root before spawn", async () => {
    const spawnProcess = vi.fn();
    const supervisor = new OpenCodeServerSupervisor({ spawnProcess });
    await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
      "workspace root is required",
    );
    expect(spawnProcess).not.toHaveBeenCalled();
  });
  it("rejects relative worktree before spawn", async () => {
    const spawnProcess = vi.fn();
    const supervisor = createTestSupervisor({ spawnProcess });
    await expect(supervisor.start("relative", new AbortController().signal)).rejects.toThrow(
      "absolute",
    );
    expect(spawnProcess).not.toHaveBeenCalled();
  });
  it("rejects worktree outside approved root", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-root-"));
    const outside = await mkdtemp(join(tmpdir(), "opencode-outside-"));
    const spawnProcess = vi.fn();
    try {
      await expect(
        createTestSupervisor({ workspaceRoot: root, spawnProcess }).start(
          outside,
          new AbortController().signal,
        ),
      ).rejects.toThrow("outside approved workspace root");
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
  it("reports unexpected workspace ownership with safe run identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-owner-"));
    const uid = process.getuid?.() ?? 0;
    const records: Record<string, unknown>[] = [];
    const spawnProcess = vi.fn();
    const supervisor = createTestSupervisor({
      workspaceRoot: root,
      workspaceOwnerUid: uid + 1,
      spawnProcess,
      logger: createStructuredLogger({ write: (line) => records.push(JSON.parse(line)) }).child({
        run_id: "owner-run",
        attempt_id: "owner-attempt",
      }),
    });
    try {
      const error = await supervisor
        .start(root, new AbortController().signal)
        .catch((error) => error);
      expect(error).toBeInstanceOf(OpenCodeReadinessError);
      expect(runtimeErrorDetails(error)).toContain("workspace ownership mismatch");
      expect(records).toContainEqual(
        expect.objectContaining({
          message: "OpenCode workspace ownership mismatch",
          actual_uid: uid,
          expected_uid: uid + 1,
          workspace: await realpath(root),
          run_id: "owner-run",
          attempt_id: "owner-attempt",
        }),
      );
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("uses canonical validated worktree for process and server info", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-canonical-"));
    const worktree = join(root, "worktree");
    const alias = join(root, "alias");
    await mkdir(worktree);
    await symlink(worktree, alias);
    const child = new FakeChild();
    let cwd: unknown;
    const supervisor = createTestSupervisor({
      workspaceRoot: root,
      spawnProcess: (_command, _args, options) => {
        cwd = options.cwd;
        return spawnFakeOpenCodeServer(child);
      },
    });
    try {
      const info = await supervisor.start(alias, new AbortController().signal);
      expect(cwd).toBe(await realpath(worktree));
      expect(info.directory).toBe(cwd);
    } finally {
      await supervisor.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("bounds startup output", () => {
    const text = "diagnostic output ".repeat(2000);
    expect(appendBoundedOpenCodeOutput("prefix", text)).toBe(`prefix${text}`.slice(-16384));
  });
  it("redacts secrets and oversized secret tails while retaining safe dependency diagnostics", async () => {
    const child = new FakeChild();
    const supervisor = createTestSupervisor({
      startupTimeoutMs: 30,
      spawnProcess: () => {
        queueMicrotask(() =>
          child.stderr.write(
            `Authorization: Bearer ${"s".repeat(20000)}\nAuthorization: Bearer ${"t".repeat(3000)}\nERROR ProviderInitError ENOTCACHED @ai-sdk/openai\n`,
          ),
        );
        return child as never;
      },
    });
    const error = await supervisor
      .start(TEST_WORKSPACE, new AbortController().signal)
      .catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toMatch(/Authorization|s{256}|t{256}/);
    expect(error.message).toContain("provider initialization failed");
    expect(error.message).toContain("offline package cache miss");
  });
  it("caps safe startup diagnostic tail", async () => {
    const child = new FakeChild();
    const supervisor = createTestSupervisor({
      startupTimeoutMs: 30,
      spawnProcess: () => {
        queueMicrotask(() => child.stderr.write("ERROR ProviderInitError\n".repeat(1000)));
        return child as never;
      },
    });
    const error = await supervisor
      .start(TEST_WORKSPACE, new AbortController().signal)
      .catch((error) => error);
    const marker = "OpenCode diagnostics (safe tail):\n";
    expect(error.message).toContain(marker);
    expect(error.message.slice(error.message.indexOf(marker) + marker.length)).toHaveLength(2048);
  });
  it.each([true, false])(
    "includes safe diagnostics on startup exit/timeout: exit=%s",
    async (exits) => {
      const child = new FakeChild();
      const supervisor = createTestSupervisor({
        startupTimeoutMs: 30,
        spawnProcess: () => {
          queueMicrotask(() => {
            child.stderr.write(exits ? "fatal startup configuration\n" : "fatal startup timeout\n");
            if (exits) child.emit("exit", 2, null);
          });
          return child as never;
        },
      });
      await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
        exits ? /invalid configuration/ : /startup timeout/,
      );
    },
  );
  it("cancels startup before announcement and detaches listeners", async () => {
    const child = new FakeChild();
    const caller = new AbortController();
    const supervisor = createTestSupervisor({
      spawnProcess: () => {
        queueMicrotask(() => caller.abort(new Error("caller cancelled startup")));
        return child as never;
      },
    });
    await expect(supervisor.start(TEST_WORKSPACE, caller.signal)).rejects.toThrow(
      "caller cancelled startup",
    );
    expect(child.killedWith).toBe("SIGTERM");
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });
  it("does not retry deterministic directory or version mismatch", async () => {
    for (const options of [{ directory: () => "/other" }, { version: "2.1.1" }]) {
      const child = new FakeChild();
      let requests = 0;
      const supervisor = createTestSupervisor({
        startupTimeoutMs: 100,
        spawnProcess: () =>
          spawnFakeOpenCodeServer(child, { ...options, onHealth: () => requests++ }),
      });
      await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
        options.version ? "does not satisfy expected version 2.1.2" : "resolved /other instead of",
      );
      expect(requests).toBe(1);
    }
  });
  describe("readiness retry deadline", () => {
    afterEach(() => vi.mocked(delay).mockRestore());

    function retryHarness(options: FakeServerOptions = {}, startupTimeoutMs = 125) {
      // Vitest's clock does not replace node:timers/promises. Route only these
      // tests' retry delays through its fake, abortable callback timers.
      vi.mocked(delay).mockImplementation(
        (ms, value, options) =>
          new Promise((resolve, reject) => {
            const signal = options?.signal;
            const onAbort = () => {
              clearTimeout(timer);
              reject(signal?.reason);
            };
            const timer = setTimeout(() => {
              signal?.removeEventListener("abort", onAbort);
              resolve(value);
            }, ms);
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          }),
      );
      const child = new FakeChild();
      const probes: number[] = [];
      let onFirstProbe: () => void = () => undefined;
      const firstProbe = new Promise<void>((resolve) => {
        onFirstProbe = resolve;
      });
      const supervisor = createTestSupervisor({
        startupTimeoutMs,
        spawnProcess: () =>
          spawnFakeOpenCodeServer(child, {
            ...options,
            onHealth: () => {
              probes.push(Date.now());
              onFirstProbe();
            },
          }),
      });
      return { child, probes, firstProbe, supervisor };
    }

    it("retries HTTP 500 then accepts HTTP 200 through the supervisor", async () => {
      vi.useFakeTimers();
      let responses = 0;
      const h = retryHarness({ healthStatus: () => (++responses === 1 ? 500 : 200) });
      try {
        const pending = h.supervisor.start(TEST_WORKSPACE, new AbortController().signal);
        await h.firstProbe;
        await vi.advanceTimersByTimeAsync(49);
        expect(h.probes).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toMatchObject({ healthy: true, version: "2.1.2" });
        expect(h.probes).toEqual([h.probes[0], (h.probes[0] as number) + 50]);
      } finally {
        await h.supervisor.stop();
        vi.useRealTimers();
      }
    });

    it("retries repeated HTTP 500 only until the shared startup deadline", async () => {
      vi.useFakeTimers();
      const h = retryHarness({ healthStatus: () => 500 });
      try {
        const pending = h.supervisor
          .start(TEST_WORKSPACE, new AbortController().signal)
          .catch((error: unknown) => error);
        await h.firstProbe;
        const start = Date.now();
        await vi.advanceTimersByTimeAsync(124);
        expect(h.probes).toEqual([start, start + 50, start + 100]);
        expect(h.child.killedWith).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({
          name: "OpenCodeReadinessError",
          message: expect.stringMatching(/readiness failed.*HTTP 500/),
        });
        expect(Date.now() - start).toBe(125);
        expect(h.probes).toEqual([start, start + 50, start + 100]);
        expect(h.supervisor.info).toBeUndefined();
        expect(h.child.killedWith).toBe("SIGTERM");
        expect(h.child.stdout.listenerCount("data")).toBe(0);
      } finally {
        await h.supervisor.stop();
        vi.useRealTimers();
      }
    });

    it.each([401, 403])(
      "fails HTTP %s authentication immediately without retrying",
      async (status) => {
        vi.useFakeTimers();
        const h = retryHarness({ healthStatus: () => status });
        try {
          const start = Date.now();
          await expect(
            h.supervisor.start(TEST_WORKSPACE, new AbortController().signal),
          ).rejects.toMatchObject({
            deterministic: true,
            message: expect.stringContaining(`HTTP ${status}`),
          });
          expect(Date.now()).toBe(start);
          expect(h.probes).toEqual([start]);
          expect(h.child.killedWith).toBe("SIGTERM");
        } finally {
          await h.supervisor.stop();
          vi.useRealTimers();
        }
      },
    );

    it.each([
      ["cancel", false],
      ["crash", false],
      ["cancel", true],
      ["crash", true],
    ] as const)("handles %s without advancing time (in-flight=%s)", async (cause, block) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const h = retryHarness({ healthStatus: () => 500, block });
      try {
        const pending = h.supervisor
          .start(TEST_WORKSPACE, caller.signal)
          .catch((error: unknown) => error);
        await h.firstProbe;
        // Flush the response into the retry delay, or leave the request blocked.
        await vi.advanceTimersByTimeAsync(0);
        const start = Date.now();
        if (cause === "cancel") caller.abort(new Error("caller cancelled readiness"));
        else h.child.emit("exit", 2, null);
        expect(await pending).toMatchObject({
          message: expect.stringContaining(
            cause === "cancel" ? "caller cancelled readiness" : "exited before readiness",
          ),
        });
        expect(Date.now()).toBe(start);
        expect(h.probes).toHaveLength(1);
        expect(h.child.killedWith).toBe("SIGTERM");
        expect(h.child.stdout.listenerCount("data")).toBe(0);
        expect(h.child.stderr.listenerCount("data")).toBe(0);
      } finally {
        await h.supervisor.stop();
        vi.useRealTimers();
      }
    });
  });
  it.each([0, 20])(
    "shares one startup deadline between announcement and readiness (%sms announcement delay)",
    async (delay) => {
      const child = new FakeChild();
      let requests = 0;
      const signals = stubReadinessFetch({ block: true, onHealth: () => requests++ });
      const supervisor = createTestSupervisor({
        startupTimeoutMs: delay + 30,
        spawnProcess: () => {
          const announce = () => child.stdout.write('{"url":"http://127.0.0.1:41236"}\n');
          if (delay) setTimeout(announce, delay);
          else queueMicrotask(announce);
          return child as never;
        },
      });
      const start = Date.now();
      await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
        "readiness failed",
      );
      expect(Date.now() - start).toBeLessThan(200);
      expect(requests).toBe(1);
      expect(signals[0]?.aborted).toBe(true);
    },
  );
  it.each([undefined, "", '/config "x"'])(
    "stages module plugin, isolates data and keeps project resources untouched (config=%j)",
    async (configHome) => {
      const workspace = await mkdtemp(join(tmpdir(), "opencode-config-workspace-"));
      const child = new FakeChild();
      const projectFiles = {
        "AGENTS.md": "Project AGENTS instructions.\n",
        "CLAUDE.md": "Project CLAUDE instructions.\n",
        "opencode.json": '{"agents":{"project":{"description":"Project agent"}}}\n',
        ".opencode/agents/project.md": "Project agent.\n",
        ".claude/skills/local/SKILL.md": "Project skill.\n",
      };
      for (const [path, content] of Object.entries(projectFiles)) {
        await mkdir(dirname(join(workspace, path)), { recursive: true });
        await writeFile(join(workspace, path), content);
      }
      const rendered = renderOpenCodeConfig({
        model: "rehor-openai/gpt-5.6-luna",
        additionalDirectories: ["/tmp/opencode"],
      });
      const suppliedPolicy = { action: "provider.use", resource: "hostile", effect: "deny" };
      const config = {
        ...rendered.config,
        policies: [...(rendered.config.policies as JsonValue[]), suppliedPolicy],
      };
      const renderedConfig = {
        ...rendered,
        config,
        json: `${JSON.stringify(config)}\n`,
        hash: hashOpenCodeConfig(config),
        projectFiles: [
          { path: "AGENTS.md", content: "Profile instructions.\n" },
          { path: "agents/profile.md", content: "Profile agent.\n" },
        ],
      };
      let spawnCall: { args: readonly string[]; options: Parameters<OpenCodeSpawn>[2] } | undefined;
      const base = Object.freeze({
        PATH: "/bin",
        HOME: "/home/bot",
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: "/persistent/data",
        XDG_CACHE_HOME: "/persistent/cache",
        XDG_STATE_HOME: "/persistent/state",
        ...operational,
        ...Object.fromEntries(blocked.map((name) => [name, "must-not-leak"])),
        OPENCODE_PASSWORD: "ambient-password",
        OPENCODE_AUTH_CONTENT: "ambient-auth",
        OPENCODE_PERMISSION: "ambient-permission",
        OPENCODE_TEST_HOME: "/ambient/discovery-home",
      });
      const supervisor = createTestSupervisor({
        workspaceRoot: workspace,
        base,
        renderedConfig,
        passthrough: Object.keys(base),
        spawnProcess: (_command, args, options) => {
          spawnCall = { args, options };
          return spawnFakeOpenCodeServer(child);
        },
      });
      let configPath = "";
      try {
        const info = await supervisor.start(workspace, new AbortController().signal);
        expect(info).toMatchObject({
          version: "2.1.2",
          hostname: "127.0.0.1",
          configHash: renderedConfig.hash,
          password: expect.any(String),
        });
        expect(info.password).not.toBe("ambient-password");
        expect(info.password?.length).toBeGreaterThanOrEqual(32);
        if (!spawnCall) throw new Error("not spawned");
        const env = spawnCall.options.env ?? {};
        expect(spawnCall.args).toEqual([
          "serve",
          "--stdio",
          "--hostname=127.0.0.1",
          "--port=0",
          "--print-logs",
          "--log-level=info",
        ]);
        expect(spawnCall.options).toMatchObject({
          cwd: await realpath(workspace),
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        expect(env).toMatchObject({
          HOME: base.HOME,
          XDG_CONFIG_HOME: expect.stringMatching(/rehor-opencode-.*\/xdg-config$/),
          XDG_DATA_HOME: expect.stringMatching(/rehor-opencode-.*\/xdg-data$/),
          XDG_CACHE_HOME: base.XDG_CACHE_HOME,
          XDG_STATE_HOME: base.XDG_STATE_HOME,
          OPENCODE_PASSWORD: info.password,
          OPENCODE_TEST_HOME: expect.stringMatching(/rehor-opencode-/),
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          NPM_CONFIG_OFFLINE: "true",
          ...operational,
        });
        for (const name of [
          ...blocked,
          "OPENCODE_AUTH_CONTENT",
          "OPENCODE_PERMISSION",
          "OPENCODE_CONFIG_DIR",
          "OPENCODE_DISABLE_PROJECT_CONFIG",
        ])
          expect(env[name]).toBeUndefined();
        configPath = String(env.OPENCODE_CONFIG);
        const state = dirname(configPath);
        expect(env.OPENCODE_TEST_HOME).toBe(state);
        const globalDir = join(state, "xdg-config", "opencode");
        const plugin = join(state, "rehor-policy", "index.js");
        await expect(readFile(plugin, "utf8")).resolves.toBe(
          renderOpenCodePolicyPlugin(
            configHome,
            JSON.parse(rendered.enforcementJson).permissions,
            base.XDG_DATA_HOME,
          ),
        );
        await expect(readFile(join(dirname(plugin), "package.json"), "utf8")).resolves.toBe(
          '{"type":"module"}\n',
        );
        expect(JSON.parse(String(env.OPENCODE_CONFIG_CONTENT)).plugins).toContain(
          pathToFileURL(dirname(plugin)).href,
        );
        const global = JSON.parse(await readFile(join(globalDir, "opencode.json"), "utf8"));
        expect(global.policies).toEqual(
          expect.arrayContaining([
            suppliedPolicy,
            { action: "tool.use", resource: "external_directory:*", effect: "deny" },
            { action: "tool.use", resource: "external_directory:/tmp/opencode/*", effect: "allow" },
          ]),
        );
        await expect(readFile(join(globalDir, "AGENTS.md"), "utf8")).resolves.toBe(
          "Profile instructions.\n",
        );
        await expect(readFile(join(globalDir, "agents/profile.md"), "utf8")).resolves.toBe(
          "Profile agent.\n",
        );
        expect(
          JSON.parse(await readFile(join(state, "opencode-packages.lock.json"), "utf8")),
        ).toEqual(rendered.packageLock);
      } finally {
        await supervisor.stop();
        if (configPath)
          await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        for (const [path, content] of Object.entries(projectFiles))
          await expect(readFile(join(workspace, path), "utf8")).resolves.toBe(content);
        expect(child.stdin.writableEnded).toBe(true);
        expect(child.killedWith).toBe("SIGTERM");
        expect(child.stdout.listenerCount("data")).toBe(0);
        expect(child.stderr.listenerCount("data")).toBe(0);
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
  it("parses complete stdout JSON lines independently of stderr fragments", async () => {
    stubReadinessFetch();
    const child = new FakeChild();
    const supervisor = createTestSupervisor({
      base: {},
      startupTimeoutMs: 100,
      spawnProcess: (_command, _args, options) => {
        for (const name of [
          "HOME",
          "XDG_CACHE_HOME",
          "XDG_STATE_HOME",
          ...OPENCODE_OPERATIONAL_ENVIRONMENT_ALLOWLIST,
        ])
          expect(options.env?.[name]).toBeUndefined();
        expect(options.env?.XDG_DATA_HOME).toMatch(/\/xdg-data$/);
        queueMicrotask(() => {
          child.stdout.write('{"url":"http://127.0.0.1:41');
          child.stderr.write("diagnostic newline\n");
          queueMicrotask(() => child.stdout.write('236"}\n'));
        });
        return child as never;
      },
    });
    try {
      const info = await supervisor.start(TEST_WORKSPACE, new AbortController().signal);
      expect(info.port).toBe(41236);
    } finally {
      await supervisor.stop();
    }
  });
  it.each([
    ["http://127.0.0.1:0", "invalid port 0"],
    ["https://127.0.0.1:41243", "unapproved protocol https:"],
    ["http://example.invalid:41243", "unapproved host"],
    ["invalid", "invalid URL"],
  ])("rejects invalid listener URL %s", async (url, error) => {
    const child = new FakeChild();
    const supervisor = createTestSupervisor({
      startupTimeoutMs: 100,
      spawnProcess: () => {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ url })}\n`));
        return child as never;
      },
    });
    await expect(supervisor.start(TEST_WORKSPACE, new AbortController().signal)).rejects.toThrow(
      error,
    );
  });
  it("returns when SIGTERM descendant exits during shutdown grace", async () => {
    stubReadinessFetch();
    const source = `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e",'process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),400);process.stdout.write("ready");'],{stdio:["ignore","pipe","ignore"]}); child.stdout.once("data",()=>{process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000);console.log(JSON.stringify({url:"http://127.0.0.1:41236"}));});`;
    const { supervisor, leader } = nodeScriptSupervisor(source, {
      startupTimeoutMs: 1000,
      shutdownTimeoutMs: 3000,
      killVerificationTimeoutMs: 1000,
    });
    try {
      await supervisor.start(TEST_WORKSPACE, new AbortController().signal);
      const start = Date.now();
      await supervisor.stop();
      expect(Date.now() - start).toBeLessThan(1500);
      expect(leader.current?.exitCode).toBe(0);
    } finally {
      await supervisor.stop();
    }
  });
  it("kills SIGTERM survivor and verifies process group disappearance", async () => {
    stubReadinessFetch();
    const { supervisor, leader } = nodeScriptSupervisor(
      'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);console.log(JSON.stringify({url:"http://127.0.0.1:41236"}));',
      { startupTimeoutMs: 1000, shutdownTimeoutMs: 30, killVerificationTimeoutMs: 1000 },
    );
    try {
      await supervisor.start(TEST_WORKSPACE, new AbortController().signal);
      await supervisor.stop();
      expect(leader.current?.signalCode).toBe("SIGKILL");
      expect(supervisor.info).toBeUndefined();
    } finally {
      await supervisor.stop();
    }
  });
  it("records crash cause and safe post-readiness dependency diagnostics", async () => {
    const child = new FakeChild();
    const records: Record<string, unknown>[] = [];
    const supervisor = createTestSupervisor({
      logger: createStructuredLogger({ write: (line) => records.push(JSON.parse(line)) }),
      spawnProcess: () => spawnFakeOpenCodeServer(child),
    });
    try {
      const info = await supervisor.start(TEST_WORKSPACE, new AbortController().signal);
      child.stderr.write(
        'timestamp=2026-10-16T09:40:00Z level=ERROR run=run-1 message="stream error" error.error="AI_APICallError: private-canary"\n',
      );
      child.stdout.write(
        'timestamp=2026-10-16T09:40:01Z level=WARN message="dependency" error.error="NpmInstallFailedError @opencode-ai/plugin: cache mode is \'only-if-cached\' but no cached response is available private-plugin-canary"\n',
      );
      child.stderr.write("ERROR ProviderInit");
      child.stderr.write(
        "Error cause=ERR_MODULE_NOT_FOUND Cannot find package @ai-sdk/openai body=private-body\n",
      );
      child.emit("exit", 1, null);
      expect(supervisor.crashSignal.aborted).toBe(true);
      expect(supervisor.crashError?.message).toContain("crashed after startup");
      expect(supervisor.diagnostics).toContain("unclassified runtime error (payload suppressed)");
      expect(supervisor.diagnostics).toContain("offline package cache miss");
      expect(supervisor.diagnostics).toContain("module not found");
      expect(`${JSON.stringify(records)}${supervisor.diagnostics}`).not.toMatch(
        /private-|AI_APICallError|stream error/,
      );
      expect(JSON.stringify(records)).not.toContain(info.password);
    } finally {
      await supervisor.stop();
    }
  });
  it.skipIf(process.platform === "win32")(
    "kills descendant outliving crashed leader and verifies group is gone",
    async () => {
      stubReadinessFetch();
      const directory = await mkdtemp(join(tmpdir(), "opencode-descendant-"));
      const pidPath = join(directory, "descendant.pid");
      const descendant =
        'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);process.stdout.write("ready");';
      const source = `const fs=require("node:fs");const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:["ignore","pipe","ignore"]});child.stdout.once("data",()=>{fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));console.log(JSON.stringify({url:"http://127.0.0.1:41236"}));setTimeout(()=>process.exit(1),500);});`;
      const { supervisor, leader } = nodeScriptSupervisor(source, {
        startupTimeoutMs: 1000,
        shutdownTimeoutMs: 100,
        killVerificationTimeoutMs: 1500,
      });
      try {
        await supervisor.start(TEST_WORKSPACE, new AbortController().signal);
        const pid = Number(await readFile(pidPath, "utf8"));
        await vi.waitFor(() => expect(supervisor.crashSignal.aborted).toBe(true), {
          timeout: 1500,
        });
        expect(leader.current?.exitCode).toBe(1);
        expect(() => process.kill(pid, 0)).not.toThrow();
        const start = Date.now();
        await supervisor.stop();
        expect(Date.now() - start).toBeLessThan(1500);
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        await supervisor.stop().catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("rejects relative executable and non-loopback bind", () => {
    expect(() => new OpenCodeServerSupervisor({ command: "opencode" })).toThrow(
      "binary path must be absolute",
    );
    expect(() => createTestSupervisor({ hostname: "0.0.0.0" })).toThrow(
      "hostname must be loopback",
    );
  });
});

describe("native V2 lifecycle smoke", () => {
  it.skipIf(!process.env.REHOR_TEST_OPENCODE_BINARY)(
    "bounds production supervisor instruction discovery to project and ordered sanitized profile guidance",
    async () => {
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "opencode-instruction-provenance-")),
      );
      const home = join(root, "home");
      const ancestor = join(home, "ambient-parent");
      const worktree = join(ancestor, "project");
      const state = join(root, "private-state");
      const profileDirectory = join(root, "profile");
      const guidance = join(root, "guidance");
      const shared = join(root, "shared");
      const projectMarker = "PROJECT_GUIDANCE_MUST_LOAD";
      const hostile = [
        "HOSTILE_HOME_GUIDANCE_MUST_NOT_LOAD",
        "HOSTILE_ANCESTOR_GUIDANCE_MUST_NOT_LOAD",
      ];
      const ordered = [
        "TRUSTED_CORE_GUIDANCE",
        "TRUSTED_SHARED_GUIDANCE",
        "TRUSTED_WORKFLOW_GUIDANCE",
        "PROFILE_ZETA_GUIDANCE",
        "PROFILE_ALPHA_GUIDANCE",
      ];
      const sources = [
        [join(home, "AGENTS.md"), hostile[0]],
        [join(ancestor, "AGENTS.md"), hostile[1]],
        [join(worktree, "AGENTS.md"), projectMarker],
        [join(guidance, "presets/core/AGENTS.md"), ordered[0]],
        [join(shared, "AGENTS.md"), ordered[1]],
        [join(profileDirectory, "custom/AGENTS.md"), ordered[2]],
        [join(profileDirectory, ".opencode/instructions/zeta.md"), ordered[3]],
        [join(profileDirectory, ".opencode/instructions/alpha.md"), ordered[4]],
      ] as const;
      for (const [path, content] of sources) {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${content}\n`);
      }
      await writeFile(
        join(profileDirectory, "opencode.json"),
        JSON.stringify({
          instructions: [".opencode/instructions/zeta.md", ".opencode/instructions/alpha.md"],
        }),
      );
      const git = spawnSync("git", ["init", "--quiet", worktree], { encoding: "utf8" });
      expect(git.status, git.stderr).toBe(0);
      const requests: { messages: { role: string; content: unknown }[] }[] = [];
      const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        requests.push(JSON.parse(body));
        const chunk = (delta: unknown, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: "instruction-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `${chunk({ role: "assistant", content: "Instruction fixture complete." }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
        );
      });
      let supervisor: OpenCodeServerSupervisor | undefined;
      let childEnvironment: NodeJS.ProcessEnv | undefined;
      try {
        const port = await listen(server);
        const profile = await loadOpenCodeProjectConfig(profileDirectory, {
          scriptDir: guidance,
          sharedAgentDir: shared,
          workflow: "./custom",
        });
        const renderedConfig = renderOpenCodeConfigForCycle(
          { model: "fixture", allowedTools: [] },
          "fixture",
          {
            providers: [
              {
                id: "fixture",
                package: "@opencode/ai/providers/openai-compatible",
                settings: {
                  baseURL: `http://127.0.0.1:${port}/v1`,
                  apiKey: "$" + "{REHOR_MODEL_PROXY_TOKEN}",
                },
              },
            ],
          },
          profile,
        );
        supervisor = new OpenCodeServerSupervisor({
          command: process.env.REHOR_TEST_OPENCODE_BINARY,
          workspaceRoot: worktree,
          stateDirectory: state,
          renderedConfig,
          base: {
            PATH: process.env.PATH,
            HOME: home,
            TMPDIR: root,
            XDG_CONFIG_HOME: join(home, ".config"),
            XDG_DATA_HOME: join(home, ".local/share"),
            XDG_CACHE_HOME: join(root, "cache"),
            XDG_STATE_HOME: join(root, "xdg-state"),
            REHOR_MODEL_PROXY_TOKEN: "synthetic-instruction-token",
            OPENCODE_TEST_HOME: home,
          },
          passthrough: [...renderedConfig.requiredEnvironment, "OPENCODE_TEST_HOME"],
          startupTimeoutMs: 15000,
          shutdownTimeoutMs: 3000,
          // Observe the real production spawn; do not inject discovery flags here.
          spawnProcess: (command, args, options) => {
            childEnvironment = { ...options.env };
            return spawn(command, [...args], options);
          },
        });
        const signal = AbortSignal.timeout(25000);
        const info = await supervisor.start(worktree, signal);
        const client = OpenCode.make({
          baseUrl: info.baseUrl,
          fetch: createOpenCodeFetch(),
          headers: {
            authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`,
          },
        });
        await vi.waitFor(
          async () => {
            expect(
              (await client.plugin.list({ location: { directory: worktree } }, { signal })).data,
            ).toContainEqual(
              expect.objectContaining({ id: "rehor-policy", state: { status: "active" } }),
            );
          },
          { timeout: 5000, interval: 25 },
        );
        let parentID: string | undefined;
        for (const role of ["root", "child"]) {
          const session = await client.session.create(
            {
              title: `Instruction provenance ${role}`,
              ...(parentID ? { parentID } : { location: { directory: worktree } }),
              model: { providerID: "fixture", id: "fixture" },
            },
            { signal },
          );
          await client.session.prompt(
            { sessionID: session.id, text: "Return the fixture response." },
            { signal },
          );
          await client.session.wait({ sessionID: session.id }, { signal });
          expect((await client.session.get({ sessionID: session.id }, { signal })).outcome).toBe(
            "succeeded",
          );
          parentID ??= session.id;
        }
        expect(requests).toHaveLength(2);
        for (const request of requests) {
          const system = JSON.stringify(
            request.messages.filter((message) => message.role === "system"),
          );
          expect(system).toContain(projectMarker);
          for (const marker of hostile) expect(system).not.toContain(marker);
          const indices = ordered.map((marker) => system.indexOf(marker));
          expect(
            indices.every((index) => index >= 0),
            system,
          ).toBe(true);
          expect(indices).toEqual([...indices].sort((a, b) => a - b));
        }
        expect(childEnvironment?.HOME).toBe(home);
        expect(childEnvironment?.OPENCODE_TEST_HOME).toBe(state);
        const staged = JSON.parse(
          await readFile(String(childEnvironment?.OPENCODE_CONFIG), "utf8"),
        );
        expect(staged.instructions).toEqual(
          [
            "instructions/rehor/core.md",
            "instructions/rehor/shared.md",
            "instructions/rehor/workflow.md",
            "instructions/zeta.md",
            "instructions/alpha.md",
          ].map((path) => join(state, "xdg-config/opencode", path)),
        );
      } finally {
        await supervisor?.stop();
        server.closeAllConnections();
        await close(server);
        await rm(root, { recursive: true, force: true });
      }
    },
    40000,
  );
  it.skipIf(!process.env.REHOR_TEST_OPENCODE_BINARY)(
    "runs production client factory and V2 runtime through real policy readiness and terminal cleanup",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "opencode-runtime-"));
      const runtime = new OpenCodeRuntime({
        renderedConfig: renderOpenCodeConfig({
          model: "research-missing/none",
          allowedTools: [],
        }),
        base: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_STATE_HOME: join(root, "state"),
        },
        server: {
          command: process.env.REHOR_TEST_OPENCODE_BINARY,
          workspaceRoot: root,
          startupTimeoutMs: 15000,
          shutdownTimeoutMs: 3000,
        },
        requestTimeoutMs: 5000,
        cleanupTimeoutMs: 3000,
      });
      const events: RehorEvent[] = [];
      try {
        await expect(runtime.start(new AbortController().signal)).resolves.toMatchObject({
          runtimeId: "opencode",
          runtimeVersion: "2.1.2",
        });
        for await (const value of runtime.run(
          { ...runtimeRun, worktree: { ...runtimeRun.worktree, path: root } },
          AbortSignal.timeout(20000),
        ))
          events.push(value);
        expect(events.filter((value) => value.kind === "terminal")).toHaveLength(1);
        expect(events.at(-1)?.payload).toMatchObject({
          state: "failed",
          reason: expect.stringContaining("research-missing/none"),
        });
        expect(events.every((value) => value.policyVersion === "opencode")).toBe(true);
        expect(events.at(-1)?.runtimeSessionRef).toBeTruthy();
        expect(events.find((value) => value.kind === "cleanup")).toBeUndefined();
        expect(events.map((value) => value.sequence)).toEqual(events.map((_, index) => index + 1));
        expect(runtime.serverInfo).toBeUndefined();
      } finally {
        await runtime.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );
  it.skipIf(!process.env.REHOR_TEST_OPENCODE_BINARY)(
    "runs authenticated isolated server, enforces active policy inventory, recovers failure and deletes children",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "opencode-native-"));
      const renderedConfig = renderOpenCodeConfig({
        model: "research-missing/none",
        allowedTools: [],
      });
      const supervisor = new OpenCodeServerSupervisor({
        command: process.env.REHOR_TEST_OPENCODE_BINARY,
        workspaceRoot: root,
        renderedConfig,
        base: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          XDG_CACHE_HOME: join(root, "cache"),
          XDG_STATE_HOME: join(root, "state"),
        },
        startupTimeoutMs: 15000,
        shutdownTimeoutMs: 3000,
      });
      const streamController = new AbortController();
      try {
        const info = await supervisor.start(root, AbortSignal.timeout(15000));
        const client = OpenCode.make({
          baseUrl: info.baseUrl,
          fetch: createOpenCodeFetch(),
          headers: {
            authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`,
          },
        });
        expect((await fetch(`${info.baseUrl}/api/info`)).status).toBe(401);
        expect((await client.server.info()).version).toBe("2.1.2");
        await vi.waitFor(
          async () => {
            const plugins = await client.plugin.list({ location: { directory: info.directory } });
            expect(plugins.data).toContainEqual(
              expect.objectContaining({ id: "rehor-policy", state: { status: "active" } }),
            );
          },
          { timeout: 5000, interval: 25 },
        );
        const iterator = client.event
          .subscribe({ signal: streamController.signal })
          [Symbol.asyncIterator]();
        expect((await iterator.next()).value.type).toBe("server.connected");
        const session = await client.session.create({
          title: "native research",
          location: { directory: info.directory },
          model: { providerID: "research-missing", id: "none" },
        });
        const child = await client.session.create({ parentID: session.id, title: "child" });
        expect(child.parentID).toBe(session.id);
        expect(child.location).toEqual(session.location);
        await client.session.prompt({ sessionID: session.id, text: "No provider route exists" });
        let failure: OpenCodeEvent | undefined;
        const deadline = AbortSignal.timeout(10000);
        while (!failure) {
          const next = await boundedOperation(
            () => iterator.next(),
            deadline,
            undefined,
            "native failure event",
          );
          if (next.done) throw new Error("native stream ended before terminal failure");
          if (
            next.value.type === "session.execution.failed" &&
            next.value.data.sessionID === session.id
          )
            failure = next.value;
        }
        expect((await client.session.get({ sessionID: session.id })).outcome).toBe("failed");
        expect((await client.message.list({ sessionID: session.id })).data).toContainEqual(
          expect.objectContaining({ type: "idle", outcome: "failed" }),
        );
        expect(await client.session.interrupt({ sessionID: session.id, resume: false })).toEqual({
          interrupted: false,
        });
        await client.session.remove({ sessionID: session.id });
        await expect(client.session.get({ sessionID: child.id })).rejects.toMatchObject({
          _tag: "SessionNotFoundError",
        });
        streamController.abort();
        await iterator.return?.();
      } finally {
        streamController.abort();
        await supervisor.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );
});
