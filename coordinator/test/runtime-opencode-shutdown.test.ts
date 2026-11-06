import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import { describe, expect, it, vi } from "vitest";
import { executeRun, RuntimeCleanupError } from "../src/coordinator";
import type { RehorEvent, RehorRun } from "../src/domain";
import {
  OpenCodeProcessLeakError,
  OpenCodeRuntime,
  type OpenCodeServerController,
  renderOpenCodeConfig,
} from "../src/runtimes/opencode";
import { OpenCodeStartupCleanupError } from "../src/runtimes/opencode/process-leak-error";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const run: RehorRun = {
  schemaVersion: "1",
  runId: "shutdown-run",
  attemptId: "shutdown-attempt",
  instanceId: "instance",
  label: "test",
  workflowId: "test",
  prompt: "work",
  task: null,
  worktree: {
    path: "/worktree",
    repository: "https://example.invalid/repo",
    snapshot: { ref: "main", commitSha: "abc", dirty: false },
  },
  instructionHash: { algorithm: "sha256", value: "1".repeat(64) },
  configHash: { algorithm: "sha256", value: "2".repeat(64) },
  policyHash: { algorithm: "sha256", value: "3".repeat(64) },
  provider: { id: "p", requestedModel: "p/m" },
  limits: { timeoutMs: 5000, budgetUsd: 5 },
  preflightPayloadRef: null,
};

function fixture(
  options: {
    priced?: boolean;
    interrupt?: () => Promise<void>;
    startup?: Promise<void>;
    startupError?: Error;
    stopError?: Error;
  } = {},
) {
  const prompted = deferred();
  const starting = deferred();
  const order: string[] = [];
  let alive = false;
  let startupPending = false;
  const supervisor: OpenCodeServerController = {
    info: undefined,
    crashError: undefined,
    crashSignal: new AbortController().signal,
    start: vi.fn(async (_directory: string, signal: AbortSignal) => {
      startupPending = true;
      starting.resolve();
      try {
        await options.startup;
        if (options.startupError) throw options.startupError;
        if (signal.aborted) throw new Error("startup aborted");
        alive = true;
        return {
          baseUrl: "http://127.0.0.1:41236",
          hostname: "127.0.0.1",
          port: 41236,
          directory: "/worktree",
          healthy: true,
          version: "2.1.2",
          capabilities: { persistentPty: true },
        };
      } finally {
        startupPending = false;
      }
    }),
    stop: vi.fn(async () => {
      order.push(startupPending ? "stop during startup" : "stop");
      alive = false;
      if (options.stopError) throw options.stopError;
    }),
  };
  const event = (type: string, data = {}): OpenCodeEvent =>
    ({ id: type, type, created: 1, data }) as OpenCodeEvent;
  const events = [event("server.connected")];
  if (options.priced) {
    events.push(
      event("session.step.started", {
        sessionID: "root",
        assistantMessageID: "assistant",
        agent: "build",
        model: { providerID: "p", id: "m" },
        started: 1,
      }),
      event("session.step.ended", {
        sessionID: "root",
        assistantMessageID: "assistant",
        cost: 1,
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      }),
    );
  }
  const client = {
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next() {
              if (index < events.length) return { done: false, value: events[index++] };
              return new Promise(() => {});
            },
            async return() {
              order.push("stream return");
              return { done: true, value: undefined };
            },
          };
        },
      }),
    },
    plugin: { list: async () => ({ data: [{ id: "rehor-policy", state: { status: "active" } }] }) },
    session: {
      create: async () => ({ id: "root" }),
      prompt: async () => prompted.resolve(),
      interrupt: async () => {
        order.push("interrupt");
        await options.interrupt?.();
        // Model the real client: teardown during a request causes ECONNRESET.
        await Promise.resolve();
        if (!alive) throw new Error("ECONNRESET interrupt");
      },
      remove: async () => {
        order.push("remove");
        await Promise.resolve();
        if (!alive) throw new Error("ECONNRESET remove");
      },
    },
  } as unknown as OpenCodeClient;
  const runtime = new OpenCodeRuntime({
    supervisor: () => supervisor,
    clientFactory: () => client,
    renderedConfig: renderOpenCodeConfig({ model: "p/m", providerId: "p" }),
    cleanupTimeoutMs: 30,
  });
  return { runtime, supervisor, prompted, starting, order };
}

describe("OpenCode shared teardown", () => {
  it("keeps expected cancellation clean and shuts down only after HTTP cleanup", async () => {
    const f = fixture();
    const controller = new AbortController();
    const resultPromise = executeRun(f.runtime, run, { signal: controller.signal });
    await f.prompted.promise;
    controller.abort("cancelled by caller");
    const result = await resultPromise;
    expect(result.terminal.payload.state).toBe("cancelled");
    expect(result.error).toBeUndefined();
    expect(f.order).toEqual(["interrupt", "stream return", "remove", "stop"]);
  });

  it("preserves expected low-budget failure without inventing a cleanup failure", async () => {
    const f = fixture({ priced: true });
    const result = await executeRun(f.runtime, {
      ...run,
      limits: { ...run.limits, budgetUsd: 0.01 },
    });
    expect(result.terminal.payload).toMatchObject({ state: "failed", reason: "budget_exceeded" });
    expect(result.error).toBeUndefined();
    expect(result.events.some((event) => event.kind === "cleanup")).toBe(false);
    expect(f.order).toEqual(["interrupt", "stream return", "remove", "stop"]);
  });

  it("retains a real leak without replacing the budget terminal", async () => {
    const leak = new OpenCodeProcessLeakError();
    const f = fixture({ priced: true, stopError: leak });
    const result = await executeRun(f.runtime, {
      ...run,
      limits: { ...run.limits, budgetUsd: 0.01 },
    });
    expect(result.terminal.payload).toMatchObject({
      state: "failed",
      reason: "budget_exceeded",
      resourceLeak: true,
    });
    expect(result.error).toBeInstanceOf(RuntimeCleanupError);
    expect((result.error as RuntimeCleanupError).previousFailures).toContain(leak);
    expect(f.supervisor.stop).toHaveBeenCalledTimes(1);
  });

  it("concurrent stops join the same in-flight cleanup", async () => {
    const interrupt = deferred();
    const interruptEntered = deferred();
    const f = fixture({
      interrupt: () => {
        interruptEntered.resolve();
        return interrupt.promise;
      },
    });
    await f.runtime.start(new AbortController().signal);
    const events: RehorEvent[] = [];
    const drain = (async () => {
      for await (const event of f.runtime.run(run, new AbortController().signal))
        events.push(event);
    })();
    await f.prompted.promise;
    let settled = 0;
    const stops = [f.runtime.stop(), f.runtime.stop()].map((stop) => stop.then(() => settled++));
    await interruptEntered.promise;
    expect(settled).toBe(0);
    expect(f.supervisor.stop).not.toHaveBeenCalled();
    interrupt.resolve();
    await Promise.all([...stops, drain]);
    expect(settled).toBe(2);
    expect(f.order).toEqual(["interrupt", "stream return", "remove", "stop"]);
    expect(events.some((event) => event.kind === "cleanup")).toBe(false);
    await f.runtime.stop();
    expect(f.supervisor.stop).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("joins cancelled startup with real stop failure=%s", async (failStop) => {
    const startup = deferred();
    const leak = failStop ? new OpenCodeProcessLeakError() : undefined;
    const f = fixture({ startup: startup.promise, stopError: leak });
    const controller = new AbortController();
    const resultPromise = executeRun(f.runtime, run, { signal: controller.signal });
    await f.starting.promise;
    controller.abort("cancel startup");
    const stop = f.runtime.stop().catch((error: unknown) => error);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.supervisor.stop).not.toHaveBeenCalled();
    startup.resolve();
    const result = await resultPromise;
    expect(await stop).toBe(leak);
    expect(result.terminal.payload.state).toBe("cancelled");
    expect(result.error instanceof RuntimeCleanupError).toBe(failStop);
    if (failStop) expect(result.terminal.payload.resourceLeak).toBe(true);
    expect(f.order).toEqual(["stop"]);
  });

  it("stops a generator paused before setup without allowing a later spawn", async () => {
    const f = fixture();
    await f.runtime.start(new AbortController().signal);
    const iterator = f.runtime.run(run, new AbortController().signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.kind).toBe("run");
    await f.runtime.stop();
    while (!(await iterator.next()).done) {
      // Drain the aborted lifecycle after stop has already completed.
    }
    expect(f.supervisor.start).not.toHaveBeenCalled();
    expect(f.supervisor.stop).toHaveBeenCalledTimes(1);
  });

  it.each(["signal", "leak"] as const)(
    "retains startup's first %s shutdown failure when the later stop succeeds",
    async (failure) => {
      const startup = deferred();
      const originalStartup = new Error("startup cancelled");
      const originalCleanup =
        failure === "leak" ? new OpenCodeProcessLeakError() : new Error("kill EPERM");
      const startupError = new OpenCodeStartupCleanupError(originalStartup, originalCleanup);
      const f = fixture({ startup: startup.promise, startupError });
      const controller = new AbortController();
      const resultPromise = executeRun(f.runtime, run, { signal: controller.signal });
      await f.starting.promise;
      controller.abort("cancel startup");
      const stop = f.runtime.stop().catch((error: unknown) => error);
      startup.resolve();
      const result = await resultPromise;
      expect(result.terminal.payload).toMatchObject({
        state: "cancelled",
        reason: "cancel startup",
      });
      expect(result.error).toBeInstanceOf(RuntimeCleanupError);
      expect(await stop).toBe(startupError);
      expect((result.error as RuntimeCleanupError).previousFailures).toContain(startupError);
      expect(startupError.errors).toEqual([originalStartup, originalCleanup]);
      expect(startupError.cause).toBe(originalStartup);
      expect(f.order).toEqual(["stop"]);
      expect(f.supervisor.stop).toHaveResolved();
      expect(result.events.find((event) => event.kind === "cleanup")?.payload.state).toBe("failed");
      if (failure === "leak") expect(result.terminal.payload.resourceLeak).toBe(true);
    },
  );

  it("does not classify an ordinary startup error as a cleanup failure", async () => {
    const f = fixture({ startupError: new Error("ordinary startup failure") });
    const result = await executeRun(f.runtime, run);
    expect(result.terminal.payload).toMatchObject({
      state: "failed",
      reason: "ordinary startup failure",
    });
    expect(result.error).not.toBeInstanceOf(RuntimeCleanupError);
    expect(result.events.some((event) => event.kind === "cleanup")).toBe(false);
    expect(f.order).toEqual(["stop"]);
  });

  it.each(["api", "signal", "leak", "deadline"] as const)(
    "retains genuine %s cleanup failure during cancellation",
    async (failure) => {
      const stopError =
        failure === "leak"
          ? new OpenCodeProcessLeakError()
          : failure === "signal"
            ? new Error("kill EPERM")
            : undefined;
      const f = fixture({
        stopError,
        interrupt:
          failure === "api"
            ? async () => {
                throw new Error("EPERM interrupt");
              }
            : failure === "deadline"
              ? () => new Promise(() => {})
              : undefined,
      });
      const controller = new AbortController();
      const resultPromise = executeRun(f.runtime, run, { signal: controller.signal });
      await f.prompted.promise;
      controller.abort("cancelled by caller");
      const result = await resultPromise;
      expect(result.terminal.payload).toMatchObject({
        state: "cancelled",
        reason: "cancelled by caller",
      });
      expect(result.error).toBeInstanceOf(RuntimeCleanupError);
      expect(result.events.find((event) => event.kind === "cleanup")?.payload.state).toBe("failed");
      expect(f.supervisor.stop).toHaveBeenCalledTimes(1);
      if (failure === "leak") expect(result.terminal.payload.resourceLeak).toBe(true);
      await expect(f.runtime.stop()).rejects.toThrow();
      await expect(f.runtime.stop()).rejects.toThrow();
      expect(f.supervisor.stop).toHaveBeenCalledTimes(1);
    },
  );
});
