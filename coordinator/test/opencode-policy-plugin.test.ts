import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Exit, Queue, Scope, Stream } from "effect";
import { expect, it, vi } from "vitest";
import { renderOpenCodePolicyPlugin } from "../src/runtimes/opencode/policy-plugin";
import { renderOpenCodeExternalDirectoryPolicies } from "../src/runtimes/opencode/render";

it.each([
  [undefined, undefined],
  ["", ""],
  ['/shell/"config', "/persistent/data"],
  [undefined, ""],
  ["", undefined],
])(
  "restores shell XDG config %j and data %j and strips runner config/auth only",
  async (config, data) => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-policy-"));
    try {
      const path = join(directory, "policy.mjs");
      await writeFile(
        path,
        renderOpenCodePolicyPlugin(config, "deny", data).replace(
          'from "effect"',
          `from ${JSON.stringify(import.meta.resolve("effect"))}`,
        ),
      );
      const { default: plugin } = await import(/* @vite-ignore */ pathToFileURL(path).href);
      expect(plugin.id).toBe("rehor-policy");
      expect(Object.keys(plugin).sort()).toEqual(["effect", "id"]);
      const registrations: {
        name: string;
        callback: (event: { env: Record<string, string> }) => Effect.Effect<void>;
      }[] = [];
      // Effect comes from the native host; no configured package or agent transform.
      const scope = Effect.runSync(Scope.make());
      await Effect.runPromise(
        plugin
          .effect({
            shell: {
              hook: (
                name: string,
                callback: (event: { env: Record<string, string> }) => Effect.Effect<void>,
              ) =>
                Effect.sync(() => {
                  registrations.push({ name, callback });
                }),
            },
            tool: { hook: () => Effect.void, transform: () => Effect.void },
            event: { subscribe: () => Stream.empty },
          })
          .pipe(Scope.provide(scope)),
      );
      expect(registrations.map(({ name }) => name)).toEqual(["create.before"]);
      const env: Record<string, string> = {
        XDG_CONFIG_HOME: "/isolated/config",
        XDG_DATA_HOME: "/isolated/data",
        HOME: "/shell/home",
        XDG_CACHE_HOME: "/persistent/cache",
        XDG_STATE_HOME: "/persistent/state",
        EXECUTOR_ADDR: "127.0.0.1:50551",
        BOT_JIRA_EMAIL: "fixture@example.invalid",
        BOT_INSTANCE_ID: "fixture-instance",
        BOT_MEMORY_URL: "http://127.0.0.1:8080",
        OPENCODE_CONFIG: "/runner/opencode.json",
        OPENCODE_CONFIG_CONTENT: '{"permissions":["synthetic-enforcement"]}',
        OPENCODE_CONFIG_DIR: "/runner/config",
        OPENCODE_TEST_HOME: "/runner/home",
        OPENCODE_DB: "/runner/opencode.db",
        OPENCODE_AUTH_CONTENT: '{"synthetic":"credential"}',
        OPENCODE_PASSWORD: "synthetic-password",
        OPENCODE_SERVER_PASSWORD: "synthetic-server-password",
        OPENCODE_TERMINAL: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      };
      const serverEnv = { ...env };
      await Effect.runPromise(registrations[0].callback({ env }));
      for (const name of [
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_CONTENT",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_TEST_HOME",
        "OPENCODE_DB",
        "OPENCODE_AUTH_CONTENT",
        "OPENCODE_PASSWORD",
        "OPENCODE_SERVER_PASSWORD",
      ]) {
        expect(env).not.toHaveProperty(name);
        expect(serverEnv).toHaveProperty(name);
      }
      expect(Object.hasOwn(env, "XDG_CONFIG_HOME")).toBe(config !== undefined);
      expect(Object.hasOwn(env, "XDG_DATA_HOME")).toBe(data !== undefined);
      expect(env.XDG_CONFIG_HOME).toBe(config);
      expect(env.XDG_DATA_HOME).toBe(data);
      expect(env).toMatchObject({
        HOME: "/shell/home",
        XDG_CACHE_HOME: "/persistent/cache",
        XDG_STATE_HOME: "/persistent/state",
        EXECUTOR_ADDR: "127.0.0.1:50551",
        BOT_JIRA_EMAIL: "fixture@example.invalid",
        BOT_INSTANCE_ID: "fixture-instance",
        BOT_MEMORY_URL: "http://127.0.0.1:8080",
        OPENCODE_TERMINAL: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      });
      await Effect.runPromise(Scope.close(scope, Exit.void));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("renders a deny-only policy ceiling with literal deployment exceptions", () => {
  expect(
    renderOpenCodeExternalDirectoryPolicies([
      { action: "external_directory", resource: "*", effect: "deny" },
      { action: "external_directory", resource: "/tmp/approved/*", effect: "allow" },
      { action: "external_directory", resource: "/tmp/approved/private/*", effect: "allow" },
    ]),
  ).toEqual([
    { action: "tool.use", resource: "external_directory:*", effect: "deny" },
    { action: "tool.use", resource: "external_directory:/tmp/approved/*", effect: "allow" },
    { action: "tool.use", resource: "external_directory:/tmp/approved/private/*", effect: "allow" },
  ]);
  for (const boundary of [
    [],
    [{ action: "external_directory", resource: "*", effect: "deny" }],
  ] as const) {
    expect(renderOpenCodeExternalDirectoryPolicies(boundary)).toEqual([
      { action: "tool.use", resource: "external_directory:*", effect: "deny" },
    ]);
  }
});

it.each([
  "allow",
  "ask",
  null,
  {},
  { "*": "allow" },
  [{ action: "external_directory", resource: "/tmp/*/private/*", effect: "allow" }],
  [{ action: "external_directory", resource: "/tmp/../escape/*", effect: "allow" }],
  [{ action: "external_directory", resource: "/*", effect: "allow" }],
  [{ action: "external_directory", resource: "/tmp/approved/*", effect: "ask" }],
  [{ action: "external_directory", resource: "/tmp/approved", effect: "allow" }],
])("rejects malformed or widened policy boundary %j", (boundary) => {
  expect(() => renderOpenCodeExternalDirectoryPolicies(boundary as never)).toThrow();
});

type EvidenceResult = {
  content?: string | Record<string, unknown>[];
  output?: unknown;
  metadata?: Record<string, unknown>;
};
type EvidenceContext = {
  sessionID: string;
  messageID: string;
  id: string;
  signal: AbortSignal;
  progress: (value: unknown) => Promise<void>;
};
type EvidenceTool<Input = Record<string, unknown>> = {
  id: string;
  options?: { codemode: boolean };
  execute: (input: Input, context: EvidenceContext) => Promise<EvidenceResult>;
};
type NativeEvidenceContext = Omit<EvidenceContext, "progress"> & {
  progress: (value: unknown) => Effect.Effect<void>;
};
type NativeEvidenceTool = Omit<EvidenceTool, "execute"> & {
  execute: (
    input: unknown,
    context: NativeEvidenceContext,
  ) => Effect.Effect<EvidenceResult, unknown>;
};
type HookEvent = EvidenceContext & {
  tool: string;
  input: unknown;
  status?: string;
  result?: EvidenceResult;
  error?: unknown;
};
type ToolEditor = {
  list: () => NativeEvidenceTool[];
  update: (id: string, update: (tool: NativeEvidenceTool) => void) => void;
};

async function bridgeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "opencode-code-mode-bridge-"));
  const path = join(directory, "plugin.mjs");
  await writeFile(
    path,
    renderOpenCodePolicyPlugin(undefined, undefined).replace(
      'from "effect"',
      `from ${JSON.stringify(import.meta.resolve("effect"))}`,
    ),
  );
  const { default: plugin } = await import(/* @vite-ignore */ pathToFileURL(path).href);
  const hooks = new Map<string, (event: HookEvent) => Effect.Effect<void>>();
  const events = Effect.runSync(Queue.unbounded<{ type: string; data: { sessionID: string } }>());
  let transform: (editor: ToolEditor) => void = () => {};
  const transformRegistration = vi.fn((callback: typeof transform) =>
    Effect.sync(() => {
      transform = callback;
    }),
  );
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(
    plugin
      .effect({
        shell: { hook: () => Effect.void },
        tool: {
          hook: (name: string, callback: (event: HookEvent) => Effect.Effect<void>) =>
            Effect.sync(() => {
              hooks.set(name, callback);
            }),
          transform: transformRegistration,
        },
        event: {
          subscribe: () => Stream.fromQueue(events),
        },
      })
      .pipe(Scope.provide(scope)),
  );
  const context = (sessionID = "root", messageID = "message", id = "outer") => ({
    sessionID,
    messageID,
    id,
    signal: new AbortController().signal,
    progress: vi.fn(async (_value: unknown) => {}),
  });
  const hook = (name: string, event: HookEvent) => hooks.get(name)?.(event) ?? Effect.void;
  const wrap = <Input>(originals: EvidenceTool<Input>[]) => {
    const tools: NativeEvidenceTool[] = originals.map((tool) => ({
      ...tool,
      execute: (input, ctx) =>
        Effect.tryPromise({
          try: () =>
            tool.execute(input as Input, {
              ...ctx,
              progress: (value) => Effect.runPromise(ctx.progress(value)),
            }),
          catch: (error) => error,
        }),
    }));
    const executors = tools.map((tool) => tool.execute);
    transform({
      list: () => tools,
      update: (id, update) => {
        const tool = tools.find((item) => item.id === id);
        if (tool) update(tool);
      },
    });
    for (const [index, tool] of tools.entries()) {
      if (tool.options?.codemode === false) expect(tool.execute).toBe(executors[index]);
    }
    return tools;
  };
  const call = (
    tool: NativeEvidenceTool,
    input: unknown,
    ctx: EvidenceContext,
    validation: {
      decode?: (value: unknown) => Effect.Effect<unknown, unknown>;
      output?: (value: EvidenceResult) => Effect.Effect<EvidenceResult, unknown>;
    } = {},
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const event = { ...ctx, tool: tool.id, input };
        yield* hook("execute.before", event);
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const decoded = validation.decode ? yield* validation.decode(input) : input;
            const result = yield* tool.execute(decoded, {
              ...ctx,
              progress: (value) => Effect.promise(() => ctx.progress(value)),
            });
            return validation.output ? yield* validation.output(result) : result;
          }),
        );
        if (Exit.isFailure(exit)) {
          yield* hook("execute.after", {
            ...event,
            status: "error",
            error: Cause.squash(exit.cause),
          });
          return yield* Effect.failCause(exit.cause);
        }
        yield* hook("execute.after", { ...event, status: "completed", result: exit.value });
        return exit.value;
      }),
    );
  return {
    context,
    wrap,
    call,
    notifyEvent: (type: string, sessionID: string) =>
      Effect.runPromise(Queue.offer(events, { type, data: { sessionID } })),
    transformRegistration,
    begin: (ctx: EvidenceContext) =>
      Effect.runPromise(hook("execute.before", { ...ctx, tool: "execute", input: {} })),
    beginNested: (ctx: EvidenceContext) =>
      Effect.runPromise(hook("execute.before", { ...ctx, tool: "unfinished", input: {} })),
    fail: (ctx: EvidenceContext, error: unknown) =>
      Effect.runPromiseExit(
        Effect.gen(function* () {
          const event = { ...ctx, tool: "execute", input: {}, status: "error", error };
          yield* hook("execute.after", event);
          expect(event.error).toBe(error);
          return yield* Effect.fail(error);
        }),
      ),
    end: async (ctx: EvidenceContext, metadata: Record<string, unknown> = {}) => {
      const result = { content: "filtered", metadata };
      await Effect.runPromise(
        hook("execute.after", {
          ...ctx,
          tool: "execute",
          input: {},
          status: "completed",
          result,
        }),
      );
      return result;
    },
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("records parallel repeated calls in start order with distinct stable IDs and unfiltered results", async () => {
  const fixture = await bridgeFixture();
  try {
    const releases = new Map<number, () => void>();
    const original = vi.fn(async (input: Record<string, unknown>) => {
      await new Promise<void>((resolve) => releases.set(Number(input.index), resolve));
      return {
        content: "human-readable result",
        output: { id: Number(input.index) + 100, external_key: input.external_key },
      };
    });
    const [tool] = fixture.wrap([{ id: "bot-memory_task_add", execute: original }]);
    const ctx = fixture.context();
    await fixture.begin(ctx);
    const pending = [0, 1].map((index) =>
      fixture.call(tool, { index, external_key: "SYNTHETIC-200" }, ctx),
    );
    await vi.waitFor(() => expect(releases.size).toBe(2));
    releases.get(1)?.();
    await pending[1];
    releases.get(0)?.();
    await pending[0];
    const native = { toolCalls: [{ tool: "fetch", status: "completed" }], error: true };
    const final = await fixture.end(ctx, native);
    expect(final.metadata).toMatchObject(native);
    expect(final.metadata.rehorCodeMode).toEqual({
      calls: [0, 1].map((index) => ({
        id: `root:message:outer:nested:${index}`,
        name: "bot-memory_task_add",
        input: { index, external_key: "SYNTHETIC-200" },
        status: "completed",
        content: [
          { type: "text", text: "human-readable result" },
          {
            type: "text",
            text: JSON.stringify({ id: index + 100, external_key: "SYNTHETIC-200" }),
          },
        ],
      })),
    });
    const progress = ctx.progress.mock.calls.map(([value]) => value);
    expect(progress).toHaveLength(6);
    expect(progress[0]).toMatchObject({
      rehorCodeMode: {
        calls: expect.arrayContaining([expect.objectContaining({ status: "running" })]),
      },
    });
    expect(progress.at(-1)).toEqual({ rehorCodeMode: final.metadata.rehorCodeMode });
    // Earlier replacements are immutable despite subsequent completion updates.
    expect(progress[0]).not.toEqual(progress.at(-1));
    expect(original).toHaveBeenCalledTimes(2);
  } finally {
    await fixture.close();
  }
});

const failureCases: [string, () => unknown, string, boolean][] = [
  // Malformed values are defensive coverage beyond native Tool.Error's schema.
  ["string", () => "original string", "original string", false],
  ["undefined", () => undefined, "undefined", false],
  ["null", () => null, "null", false],
  ["number", () => 7, "7", false],
  ["boolean", () => false, "false", false],
  ["symbol", () => Symbol("original"), "Symbol(original)", false],
  [
    "object",
    () => ({ message: "original object", metadata: { native: true } }),
    "original object",
    true,
  ],
  ["Error", () => new Error("original Error"), "original Error", true],
  ["frozen Error", () => Object.freeze(new Error("immutable Error")), "immutable Error", false],
  [
    "frozen object",
    () => Object.freeze({ message: "immutable object" }),
    "immutable object",
    false,
  ],
  [
    "non-extensible Error",
    () => Object.preventExtensions(new Error("closed Error")),
    "closed Error",
    false,
  ],
  [
    "read-only metadata",
    () => Object.defineProperty(new Error("read-only"), "metadata", { value: {} }),
    "read-only",
    false,
  ],
  [
    "throwing accessor",
    () =>
      Object.defineProperty({}, "metadata", {
        get() {
          throw new Error("metadata unavailable");
        },
      }),
    "[object Object]",
    false,
  ],
  ["unprintable object", () => Object.create(null), "Tool failed", true],
];
it.each(failureCases)(
  "preserves %s failure, final evidence fallback and cleanup",
  async (_name, create, text, attached) => {
    const fixture = await bridgeFixture();
    try {
      const error = create();
      const [tool] = fixture.wrap([
        {
          id: "fixture_failure",
          execute: async () => {
            throw error;
          },
        },
      ]);
      const ctx = fixture.context();
      await fixture.begin(ctx);
      await fixture.call(tool, {}, ctx).catch(() => {});
      // Simulate a nested call interrupted before its after hook. The fallback
      // must publish the final settlement, not merely reuse earlier progress.
      await fixture.beginNested(ctx);
      const exit = await fixture.fail(ctx, error);
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) throw new Error("Expected original failure");
      expect(Cause.squash(exit.cause)).toBe(error);
      const evidence = {
        calls: [
          expect.objectContaining({ name: "fixture_failure", status: "error", error: text }),
          expect.objectContaining({
            name: "unfinished",
            status: "error",
            error: "Code Mode call interrupted",
          }),
        ],
      };
      if (attached) {
        expect(error).toHaveProperty("metadata.rehorCodeMode", evidence);
        if (_name === "object") expect(error).toHaveProperty("metadata.native", true);
      } else {
        expect(ctx.progress.mock.calls.at(-1)?.[0]).toEqual({ rehorCodeMode: evidence });
      }
      const published = ctx.progress.mock.calls.length;
      await fixture.call(tool, {}, ctx).catch(() => {});
      expect(ctx.progress.mock.calls).toHaveLength(published);
      expect((await fixture.end(ctx)).metadata).not.toHaveProperty("rehorCodeMode");
      await fixture.begin(ctx);
      expect((await fixture.end(ctx)).metadata.rehorCodeMode).toEqual({ calls: [] });
    } finally {
      await fixture.close();
    }
  },
);

it("keeps original outer failure when final fallback progress fails", async () => {
  const fixture = await bridgeFixture();
  try {
    const [tool] = fixture.wrap([
      { id: "fixture_lookup", execute: async () => ({ content: "captured" }) },
    ]);
    const ctx = fixture.context();
    await fixture.begin(ctx);
    await fixture.call(tool, {}, ctx);
    ctx.progress.mockRejectedValue(new Error("final progress unavailable"));
    const exit = await fixture.fail(ctx, "original failure");
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe("original failure");
    expect((await fixture.end(ctx)).metadata).not.toHaveProperty("rehorCodeMode");
  } finally {
    await fixture.close();
  }
});

it.each([null, 7, "same", true])(
  "correlates identical scalar %j when second succeeds before first executor fails",
  async (input) => {
    const fixture = await bridgeFixture();
    try {
      const releases: (() => void)[] = [];
      let ordinal = 0;
      const failure = new Error("first executor failed");
      const [tool] = fixture.wrap([
        {
          id: "fixture_scalar",
          execute: async (_input: unknown) => {
            const index = ordinal++;
            await new Promise<void>((resolve) => {
              releases[index] = resolve;
            });
            if (index === 0) throw failure;
            return { content: "second result", output: { id: 201 } };
          },
        },
      ]);
      const ctx = fixture.context();
      await fixture.begin(ctx);
      const first = fixture.call(tool, input, ctx);
      const firstFailure = expect(first).rejects.toBe(failure);
      const second = fixture.call(tool, input, ctx);
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      releases[1]();
      await second;
      releases[0]();
      await firstFailure;
      const final = await fixture.end(ctx);
      expect(final.metadata.rehorCodeMode).toEqual({
        calls: [
          {
            id: "root:message:outer:nested:0",
            name: "fixture_scalar",
            input,
            status: "error",
            error: failure.message,
          },
          {
            id: "root:message:outer:nested:1",
            name: "fixture_scalar",
            input,
            status: "completed",
            content: [
              { type: "text", text: "second result" },
              { type: "text", text: '{"id":201}' },
            ],
          },
        ],
      });
      expect(ctx.progress.mock.calls.at(-1)?.[0]).toEqual({
        rehorCodeMode: final.metadata.rehorCodeMode,
      });
    } finally {
      await fixture.close();
    }
  },
);

it.each(["decode failure", "decoded clones", "output failure"] as const)(
  "retains invocation identity across async %s with identical raw inputs",
  async (mode) => {
    const fixture = await bridgeFixture();
    try {
      const input = { value: "shared" };
      const releases: (() => void)[] = [];
      let decodeOrdinal = 0;
      const execute = vi.fn(async (decoded: { invocation: number }) => {
        if (mode === "decoded clones" && decoded.invocation === 0)
          throw new Error("first decoded invocation failed");
        return { output: { id: decoded.invocation + 200 } };
      });
      const [tool] = fixture.wrap([{ id: "fixture_clones", execute }]);
      const decode = () => {
        const index = decodeOrdinal++;
        return Effect.gen(function* () {
          if (mode !== "output failure") {
            yield* Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  releases[index] = resolve;
                }),
            );
          }
          if (mode === "decode failure" && index === 0)
            return yield* Effect.fail(new Error("first input validation failed"));
          return { ...input, invocation: index };
        });
      };
      const output = (value: EvidenceResult) =>
        Effect.gen(function* () {
          if (mode === "output failure") {
            const index = (value.output as { id: number }).id - 200;
            yield* Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  releases[index] = resolve;
                }),
            );
            if (index === 0) return yield* Effect.fail(new Error("first output validation failed"));
          }
          return value;
        });
      const ctx = fixture.context();
      await fixture.begin(ctx);
      const first = fixture.call(tool, input, ctx, { decode, output });
      const firstFailure = expect(first).rejects.toThrow(/first/);
      const second = fixture.call(tool, input, ctx, { decode, output });
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      releases[1]();
      await second;
      releases[0]();
      await firstFailure;
      const final = await fixture.end(ctx);
      expect(final.metadata.rehorCodeMode).toMatchObject({
        calls: [
          {
            id: "root:message:outer:nested:0",
            input,
            status: "error",
            error: expect.stringMatching(/first/),
          },
          {
            id: "root:message:outer:nested:1",
            input,
            status: "completed",
            content: [{ type: "text", text: '{"id":201}' }],
          },
        ],
      });
      expect(execute).toHaveBeenCalledTimes(mode === "decode failure" ? 1 : 2);
      expect(input).toEqual({ value: "shared" });
      expect(ctx.progress.mock.calls.at(-1)?.[0]).toEqual({
        rehorCodeMode: final.metadata.rehorCodeMode,
      });
    } finally {
      await fixture.close();
    }
  },
);

it("isolates root/child and direct calls, replays one transform, preserves denial and native error results", async () => {
  const fixture = await bridgeFixture();
  try {
    const denial = new Error("native permission denied");
    const execute = vi.fn(async (input: Record<string, unknown>) => {
      if (input.denied) throw denial;
      return { content: "unfiltered", metadata: { error: input.failed === true } };
    });
    const originals = [{ id: "fixture_lookup", execute }];
    fixture.wrap(originals);
    const [tool] = fixture.wrap(originals);
    expect(fixture.transformRegistration).toHaveBeenCalledTimes(1);
    const root = fixture.context();
    const child = fixture.context("child");
    await Promise.all([fixture.begin(root), fixture.begin(child)]);
    await expect(fixture.call(tool, { denied: true }, root)).rejects.toBe(denial);
    await fixture.call(tool, { failed: true }, root);
    await fixture.call(tool, {}, child);
    const rootFinal = await fixture.end(root);
    const childFinal = await fixture.end(child);
    expect(rootFinal.metadata.rehorCodeMode).toMatchObject({
      calls: [
        { id: "root:message:outer:nested:0", status: "error", error: denial.message },
        { id: "root:message:outer:nested:1", status: "error", content: expect.any(Array) },
      ],
    });
    expect(childFinal.metadata.rehorCodeMode).toMatchObject({
      calls: [{ id: "child:message:outer:nested:0", status: "completed" }],
    });
    const before = root.progress.mock.calls.length;
    await fixture.call(tool, {}, root);
    expect(root.progress.mock.calls).toHaveLength(before);
    expect(execute).toHaveBeenCalledTimes(4);
    // A later execute reusing a call ID starts a fresh accumulator after cleanup.
    await fixture.begin(root);
    expect((await fixture.end(root)).metadata.rehorCodeMode).toEqual({ calls: [] });
  } finally {
    await fixture.close();
  }
});

it("keeps direct registrations intact and falls back to hooks for tools added after the transform", async () => {
  const fixture = await bridgeFixture();
  try {
    const execute = vi.fn(async () => ({ content: "native text" }));
    const [direct] = fixture.wrap([{ id: "read", options: { codemode: false }, execute }]);
    expect(direct.options).toEqual({ codemode: false });
    const ctx = fixture.context();
    await fixture.begin(ctx);
    // A late registry source still has execute.before/after, even if not wrapped.
    await fixture.call(
      { id: "late_lookup", execute: () => Effect.succeed({ content: "native text" }) },
      { query: "task" },
      ctx,
    );
    expect((await fixture.end(ctx)).metadata.rehorCodeMode).toMatchObject({
      calls: [{ name: "late_lookup", input: { query: "task" }, status: "completed" }],
    });
  } finally {
    await fixture.close();
  }
});

it("preserves cancellation identity and does not let evidence/progress failures replace tool outcomes", async () => {
  const fixture = await bridgeFixture();
  try {
    const reason = new Error("cancelled");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const execute = vi.fn(async (input: Record<string, unknown>, ctx: EvidenceContext) => {
      if (input.cancel) {
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
        });
      }
      return { output: circular };
    });
    const [tool] = fixture.wrap([{ id: "fixture_lookup", execute }]);
    const ctx = fixture.context();
    ctx.progress.mockRejectedValue(new Error("progress unavailable"));
    await fixture.begin(ctx);
    await expect(fixture.call(tool, {}, ctx)).resolves.toEqual({ output: circular });
    const controller = new AbortController();
    const cancelled = fixture.call(tool, { cancel: true }, { ...ctx, signal: controller.signal });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    expect((await fixture.end(ctx)).metadata.rehorCodeMode).toMatchObject({
      calls: [{ status: "completed" }, { status: "error", error: "cancelled" }],
    });
  } finally {
    await fixture.close();
  }
});

it("settles success only after native output validation and releases interrupted session state", async () => {
  const fixture = await bridgeFixture();
  try {
    const [tool] = fixture.wrap([
      { id: "fixture_lookup", execute: async () => ({ output: "invalid native output" }) },
    ]);
    const root = fixture.context();
    const child = fixture.context("child");
    await fixture.begin(root);
    await fixture.begin(child);
    const input = { query: "task" };
    await expect(
      fixture.call(tool, input, root, {
        output: () =>
          Effect.gen(function* () {
            for (const [value] of root.progress.mock.calls) {
              expect(JSON.stringify(value)).not.toContain('"completed"');
            }
            return yield* Effect.fail(new Error("Native output schema rejected result"));
          }),
      }),
    ).rejects.toThrow("Native output schema rejected result");
    expect((await fixture.end(root)).metadata.rehorCodeMode).toMatchObject({
      calls: [{ status: "error", error: "Native output schema rejected result" }],
    });
    await fixture.begin(root);
    await fixture.notifyEvent("session.execution.interrupted", root.sessionID);
    // Let the subscription consume the terminal before simulating another call.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const progress = root.progress.mock.calls.length;
    await fixture.call(tool, {}, root);
    expect(root.progress.mock.calls).toHaveLength(progress);
    expect((await fixture.end(root)).metadata).not.toHaveProperty("rehorCodeMode");
    await fixture.call(tool, {}, child);
    expect((await fixture.end(child)).metadata.rehorCodeMode).toMatchObject({
      calls: [{ status: "completed" }],
    });
  } finally {
    await fixture.close();
  }
});
