import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinatorExitCode } from "../src/cli-result";
import { type CoordinatorResult, executeRun, RuntimeCleanupError } from "../src/coordinator";
import { providerDiagnostic } from "../src/diagnostics";
import { createEventFactory, type RehorEvent, type RehorRun } from "../src/domain";
import { InstructionStrategy } from "../src/instructions";
import { createStructuredLogger } from "../src/log";
import { PreflightAction } from "../src/ports/python-bridge";
import { runCoordinator } from "../src/runner";
import * as runtimeFactory from "../src/runtime-factory";
import {
  OpenCodeRuntime,
  type OpenCodeServerController,
  renderOpenCodeConfig,
} from "../src/runtimes/opencode";
import { OpenCodeProcessLeakError } from "../src/runtimes/opencode/process-leak-error";
import { FakeAgentRuntime } from "../src/testing/fake-agent-runtime";

const run: RehorRun = {
  schemaVersion: "1",
  runId: "cleanup-run",
  attemptId: "cleanup-attempt",
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
  provider: { id: "test-provider", requestedModel: "test-provider/test-model" },
  limits: { timeoutMs: 5000, budgetUsd: 5 },
  preflightPayloadRef: null,
};

const secret = "opaque-sensitive-cleanup-payload";
type WorkOutcome = "completed" | "failed" | "wait";

function runtime(
  outcome: WorkOutcome,
  failCleanup: boolean,
  onPrompt?: () => void,
  supervisorFailure?: Error,
): OpenCodeRuntime {
  const supervisor: OpenCodeServerController = {
    crashSignal: new AbortController().signal,
    info: undefined,
    crashError: undefined,
    async start() {
      return {
        baseUrl: "http://127.0.0.1:41236",
        hostname: "127.0.0.1",
        port: 41236,
        directory: "/worktree",
        healthy: true,
        version: "2.1.2",
        capabilities: { persistentPty: true },
      };
    },
    async stop() {
      if (supervisorFailure) throw supervisorFailure;
    },
  };
  const client = {
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next(): Promise<IteratorResult<OpenCodeEvent>> {
              if (index++ === 0) {
                return {
                  done: false,
                  value: {
                    id: "connected",
                    type: "server.connected",
                    created: 1,
                    data: {},
                  } as OpenCodeEvent,
                };
              }
              if (outcome === "wait") return new Promise(() => {});
              return {
                done: false,
                value: {
                  id: "result",
                  type:
                    outcome === "completed"
                      ? "session.execution.succeeded"
                      : "session.execution.failed",
                  created: 2,
                  data: { sessionID: "root", error: { message: "work failed" } },
                } as OpenCodeEvent,
              };
            },
            async return() {
              return { done: true as const, value: undefined };
            },
          };
        },
      }),
    },
    plugin: { list: async () => ({ data: [{ id: "rehor-policy", state: { status: "active" } }] }) },
    session: {
      create: async () => ({ id: "root" }),
      prompt: async () => {
        onPrompt?.();
      },
      interrupt: async () => {
        if (failCleanup) throw new Error(`EPERM ${secret}`);
      },
      remove: async () => {},
    },
  } as unknown as OpenCodeClient;
  return new OpenCodeRuntime({
    supervisor: () => supervisor,
    clientFactory: () => client,
    renderedConfig: renderOpenCodeConfig({
      model: run.provider.requestedModel,
      providerId: run.provider.id,
    }),
    cleanupTimeoutMs: 100,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("runtime cleanup reporting", () => {
  it("preserves only the classified cleanup diagnostic when stop succeeds", async () => {
    const result = await executeRun(runtime("completed", true), run);
    expect(result.terminal.payload.state).toBe("completed");
    expect(result.error).toBeInstanceOf(RuntimeCleanupError);
    const error = result.error as RuntimeCleanupError;
    expect(error.previousFailures).toEqual([]);
    expect(providerDiagnostic(error)).toBe("permission denied");
    expect(String(error.cause)).not.toContain(secret);
    expect(providerDiagnostic(error)).not.toContain(secret);
  });

  it("classifies untrusted cleanup messages instead of retaining their payload", async () => {
    const createEvent = createEventFactory(run, "test");
    const fake = new FakeAgentRuntime({
      events: [
        createEvent("cleanup", { state: "failed", message: `EPERM ${secret}` }),
        createEvent("terminal", { state: "completed" }),
      ],
    });
    const result = await executeRun(fake, run);
    const error = result.error as RuntimeCleanupError;
    expect(providerDiagnostic(error)).toBe("permission denied");
    expect(String(error.cause)).not.toContain(secret);
    expect(error.previousFailures).toEqual([]);
  });

  it("suppresses unclassified cleanup payloads in the fallback cause", async () => {
    const createEvent = createEventFactory(run, "test");
    const fake = new FakeAgentRuntime({
      events: [
        createEvent("cleanup", { state: "failed", message: secret }),
        createEvent("terminal", { state: "completed" }),
      ],
    });
    const result = await executeRun(fake, run);
    const error = result.error as RuntimeCleanupError;
    expect(providerDiagnostic(error)).toBe("unclassified runtime error (payload suppressed)");
    expect(String(error.cause)).not.toContain(secret);
  });

  it("retains a real stop error over the cleanup diagnostic", async () => {
    const createEvent = createEventFactory(run, "test");
    const stopError = new Error("stop failed");
    const fake = new FakeAgentRuntime({
      events: [
        createEvent("cleanup", { state: "failed", message: `EPERM ${secret}` }),
        createEvent("terminal", { state: "completed" }),
      ],
    });
    fake.stop = async () => {
      throw stopError;
    };
    const result = await executeRun(fake, run);
    expect(result.terminal.payload.state).toBe("completed");
    const error = result.error as RuntimeCleanupError;
    expect(error.cause).toBe(stopError);
    expect(error.previousFailures).toEqual([stopError]);
  });

  it("does not replace work or stop failures with the cleanup diagnostic", async () => {
    const createEvent = createEventFactory(run, "test");
    const workError = new Error("work failed");
    const stopError = new Error("stop failed");
    const fake = new FakeAgentRuntime({
      events: [
        createEvent("cleanup", { state: "failed", message: `EPERM ${secret}` }),
        createEvent("terminal", { state: "failed" }),
      ],
      error: workError,
    });
    fake.stop = async () => {
      throw stopError;
    };
    const result = await executeRun(fake, run);
    expect(result.terminal.payload.state).toBe("failed");
    const error = result.error as RuntimeCleanupError;
    expect(error.cause).toBe(workError);
    expect(error.previousFailures).toEqual([workError, stopError]);
  });

  it.each(["completed", "failed"] as const)(
    "surfaces cleanup failure without changing %s work",
    async (outcome) => {
      const projected: RehorEvent[] = [];
      const result = await executeRun(runtime(outcome, true), run, {
        projection: {
          onEvent: (event) => {
            projected.push(event);
          },
        },
      });
      expect(result.terminal.payload.state).toBe(outcome);
      expect(result.error).toBeInstanceOf(RuntimeCleanupError);
      expect(result.events.filter((event) => event.kind === "cleanup")).toEqual([
        expect.objectContaining({
          payload: { state: "failed", message: expect.stringContaining("permission denied") },
        }),
      ]);
      expect(projected).toEqual(result.events);
      expect(JSON.stringify(result.events)).not.toContain(secret);
      expect(String(result.error)).not.toContain(secret);
      if (outcome === "failed")
        expect(result.events.some((event) => event.kind === "error")).toBe(true);
    },
  );

  it.each([false, true])(
    "keeps cancellation distinct with cleanup failure=%s",
    async (failCleanup) => {
      const controller = new AbortController();
      const result = await executeRun(
        runtime("wait", failCleanup, () => controller.abort("cancelled by caller")),
        run,
        { signal: controller.signal },
      );
      expect(result.terminal.payload.state).toBe("cancelled");
      expect(result.terminal.payload.reason).toBe("cancelled by caller");
      expect(result.error instanceof RuntimeCleanupError).toBe(failCleanup);
      expect(result.events.some((event) => event.kind === "cleanup")).toBe(failCleanup);
      expect(JSON.stringify(result.events)).not.toContain(secret);
    },
  );

  it("retains an independent coordinator failure alongside cleanup failure", async () => {
    const original = new Error("projection failed");
    const result = await executeRun(runtime("completed", true), run, {
      projection: {
        onEvent: (event) => {
          if (event.kind === "cleanup") throw original;
        },
      },
    });
    expect(result.error).toBeInstanceOf(RuntimeCleanupError);
    expect((result.error as RuntimeCleanupError).previousFailures).toContain(original);
    expect((result.error as RuntimeCleanupError).cause).toBe(original);
  });

  it("retains process leak classification when earlier cleanup also failed", async () => {
    const leak = new OpenCodeProcessLeakError(`EPERM ${secret}`);
    const result = await executeRun(runtime("completed", true, undefined, leak), run);
    expect(result.terminal.payload).toMatchObject({ state: "completed", resourceLeak: true });
    expect(result.events.find((event) => event.kind === "cleanup")?.payload).toMatchObject({
      state: "failed",
      resourceLeak: true,
    });
    expect((result.error as RuntimeCleanupError).previousFailures).toContain(leak);
    expect(JSON.stringify(result.events)).not.toContain(secret);
  });

  it("surfaces supervisor stop failure while shutdown drains the runtime", async () => {
    const shutdown = new AbortController();
    const leak = new OpenCodeProcessLeakError(`EPERM ${secret}`);
    const result = await executeRun(
      runtime("wait", false, () => shutdown.abort("operator shutdown"), leak),
      run,
      { shutdownSignal: shutdown.signal },
    );
    expect(result.terminal.payload).toMatchObject({
      state: "interrupted",
      reason: "operator shutdown",
      resourceLeak: true,
    });
    expect(result.events.find((event) => event.kind === "cleanup")?.payload).toMatchObject({
      state: "failed",
      resourceLeak: true,
    });
    expect(result.error).toBeInstanceOf(RuntimeCleanupError);
    expect((result.error as RuntimeCleanupError).previousFailures).toContain(leak);
    expect(JSON.stringify(result.events)).not.toContain(secret);
  });

  it("leaves successful work without cleanup failure successful", async () => {
    const result = await executeRun(runtime("completed", false), run);
    expect(result.terminal.payload.state).toBe("completed");
    expect(result.error).toBeUndefined();
  });

  it("wraps a stop failure after completed work without losing the original error", async () => {
    const original = new Error("stop failed");
    const createEvent = createEventFactory(run, "test");
    const fake = new FakeAgentRuntime({
      events: [createEvent("terminal", { state: "completed" })],
    });
    fake.stop = async () => {
      throw original;
    };
    const result = await executeRun(fake, run);
    expect(result.terminal.payload.state).toBe("completed");
    expect(result.error).toBeInstanceOf(RuntimeCleanupError);
    expect((result.error as RuntimeCleanupError).cause).toBe(original);
    expect((result.error as RuntimeCleanupError).previousFailures).toEqual([original]);
  });

  it("counts a stop rejection even when its value is undefined", async () => {
    const createEvent = createEventFactory(run, "test");
    const fake = new FakeAgentRuntime({
      events: [createEvent("terminal", { state: "completed" })],
    });
    fake.stop = async () => Promise.reject(undefined);
    const result = await executeRun(fake, run);
    expect(result.terminal.payload.state).toBe("completed");
    expect(result.error).toBeInstanceOf(RuntimeCleanupError);
    expect((result.error as RuntimeCleanupError).previousFailures).toEqual([undefined]);
  });

  it.each([
    "completed",
    "failed",
    "failed-clean",
    "cancelled",
    "shutdown",
    "shutdown-stop",
    "shutdown-failed-stop",
    "cancelled-clean",
    "shutdown-clean",
    "clean",
    "housekeeping",
  ] as const)(
    "runner records %s appropriately and --once uses its real exit-code policy",
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), "rehor-cleanup-reporting-"));
      const controller = new AbortController();
      const records: string[] = [];
      const errorPhases: string[] = [];
      const workError = new Error("original work failed");
      const stopError = new Error("stop failed");
      let observedResult: CoordinatorResult | undefined;
      const logger = createStructuredLogger({ write: (line) => records.push(line) });
      vi.spyOn(runtimeFactory, "executeConfiguredRun").mockImplementation(
        async (_registry, input, options) => {
          if (scenario === "shutdown-failed-stop") {
            const fake = new FakeAgentRuntime({ error: workError });
            fake.stop = async () => {
              controller.abort("shutdown during stop");
              throw stopError;
            };
            observedResult = await executeRun(fake, input, options);
            return observedResult;
          }
          if (scenario === "shutdown-stop") {
            const fake = new FakeAgentRuntime();
            const start = fake.start.bind(fake);
            fake.start = async (signal) => {
              const capabilities = await start(signal);
              controller.abort("stopped before streaming");
              return capabilities;
            };
            fake.stop = async () => {
              throw new Error("stop failed");
            };
            return executeRun(fake, input, options);
          }
          const aborted = scenario.startsWith("cancelled") || scenario.startsWith("shutdown");
          const work = aborted ? "wait" : scenario.startsWith("failed") ? "failed" : "completed";
          const failCleanup = !scenario.endsWith("clean") && scenario !== "housekeeping";
          return executeRun(
            runtime(work, failCleanup, () => {
              if (aborted) controller.abort("stopped by caller");
            }),
            input,
            options,
          );
        },
      );
      const bridge = {
        prepareConfig: async () => ({
          model: "claude-opus-4-6",
          runtimeId: "claude",
          providerId: "vertex",
          budgetUsd: 5,
          intervalSeconds: 0,
          idleIntervalSeconds: 0,
          cycleTimeoutSeconds: 120,
          idleReminderCooldownSeconds: 3600,
          workflow: "test",
          source: "test",
          envs: [],
          activeEnvs: [],
          claudeMdStrategy: InstructionStrategy.Ignore,
          idleCycleLimit: 4,
          remoteAgentDir: null,
          sharedAgentDir: null,
          claudeMdPath: join(directory, "CLAUDE.md"),
          mcpServers: {},
          openCodeMcpServers: {},
          allowedTools: [],
          optionalMcpServers: [],
        }),
        preflight: async () => ({
          action: PreflightAction.Start,
          prompt: "work",
          transcript: "work",
          scripts: [],
        }),
        cleanupBetweenCycles: async () => {
          if (scenario === "housekeeping") throw new Error("housekeeping failed");
          return undefined;
        },
      };
      const result = await runCoordinator({
        logger,
        scriptDir: resolve(process.cwd(), ".."),
        label: "test",
        instanceId: "instance",
        dataDirectory: directory,
        lockPath: join(directory, ".lock"),
        sleepSignalPath: join(directory, "sleep.json"),
        bridge,
        writers: {},
        once: true,
        ...(scenario.startsWith("shutdown")
          ? { shutdownSignal: controller.signal }
          : { signal: controller.signal }),
        initialIntervalSeconds: 0,
        initialIdleIntervalSeconds: 0,
        onError: (_error, phase) => {
          errorPhases.push(phase);
        },
      });
      const failed =
        scenario.startsWith("failed") ||
        (!scenario.endsWith("clean") && scenario !== "housekeeping");
      expect(result.failures).toBe(failed ? 1 : 0);
      expect(coordinatorExitCode(result, true)).toBe(failed ? 1 : 0);
      expect(errorPhases).toEqual(
        failed ? ["run"] : scenario === "housekeeping" ? ["cleanup"] : [],
      );
      expect(records.join("\n")).not.toContain(secret);
      if (scenario.startsWith("cancelled")) expect(result.stopReason).toBe("cancelled");
      if (scenario.startsWith("shutdown")) expect(result.stopReason).toBe("shutdown");
      if (scenario === "shutdown-failed-stop") {
        expect(observedResult?.terminal.payload).toMatchObject({
          state: "failed",
          reason: workError.message,
        });
        expect(observedResult?.events.some((event) => event.kind === "cleanup")).toBe(false);
        expect(observedResult?.error).toBeInstanceOf(RuntimeCleanupError);
        const error = observedResult?.error;
        if (!(error instanceof RuntimeCleanupError)) throw new Error("missing cleanup error");
        expect(error.cause).toBe(workError);
        expect(error.previousFailures).toEqual([workError, stopError]);
      }
    },
  );
});
