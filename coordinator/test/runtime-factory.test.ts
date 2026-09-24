import { describe, expect, it, vi } from "vitest";

import {
  type ConfigPreparationResult,
  createDefaultRuntimeRegistry,
  createOpenCodeV1RuntimeFactory,
  executeSelectedRun,
  InstructionStrategy,
  type RehorEvent,
  type RehorRun,
  RuntimeFactoryError,
  RuntimeFactoryRegistry,
  resolveRuntimeSelection,
} from "../src";
import type { OpenCodeServerController, OpenCodeV1Runtime } from "../src/runtimes/opencode-v1";
import { FakeAgentRuntime } from "../src/testing/fake-agent-runtime";

const run: RehorRun = {
  schemaVersion: "1",
  runId: "run-factory",
  attemptId: "attempt-factory",
  instanceId: "instance-01",
  label: "hcc-ai-framework",
  workflowId: "jira-sprint",
  prompt: "Run the cycle.",
  task: null,
  worktree: {
    path: "/work/rehor",
    repository: "https://github.com/OpenShift-Fleet/rehor.git",
    snapshot: { ref: "refs/heads/rehor-139", commitSha: "abc123", dirty: false },
  },
  instructionHash: { algorithm: "sha256", value: "1".repeat(64) },
  configHash: { algorithm: "sha256", value: "2".repeat(64) },
  policyHash: { algorithm: "sha256", value: "3".repeat(64) },
  provider: { id: "vertex", requestedModel: "claude-opus-4-6" },
  limits: { timeoutMs: 100, maxTurns: 20 },
  preflightPayloadRef: null,
};

const preparedConfig: ConfigPreparationResult = {
  model: "prepared-model",
  maxTurns: 10,
  intervalSeconds: 60,
  idleIntervalSeconds: 60,
  cycleTimeoutSeconds: 1_800,
  idleReminderCooldownSeconds: 3_600,
  workflow: "jira-sprint",
  source: "test",
  envs: null,
  activeEnvs: ["browser"],
  claudeMdStrategy: InstructionStrategy.Append,
  idleCycleLimit: 0,
  remoteAgentDir: null,
  sharedAgentDir: null,
  claudeMdPath: "/tmp/CLAUDE.md",
  mcpServers: {},
  openCodeMcpServers: {
    "prepared-server": { type: "http", url: "http://prepared.example/mcp" },
  },
  allowedTools: ["Read"],
  optionalMcpServers: ["optional-persona-mcp"],
};

function event(sequence: number, terminal = false): RehorEvent {
  return {
    schemaVersion: "1",
    eventId: terminal ? "terminal-factory" : "run-factory-event",
    runId: run.runId,
    attemptId: run.attemptId,
    sequence,
    occurredAt: "2026-09-07T12:00:00.000Z",
    kind: terminal ? "terminal" : "run",
    workspace: {
      worktreePath: run.worktree.path,
      repository: run.worktree.repository,
      snapshot: run.worktree.snapshot.commitSha,
    },
    provider: run.provider.id,
    model: run.provider.requestedModel,
    policyVersion: "policy-1",
    payload: terminal ? { state: "completed", resultText: "done", turns: 1 } : { state: "started" },
  } as RehorEvent;
}

describe("runtime selection", () => {
  it("defaults to the current Claude runtime and accepts named runtimes", () => {
    expect(resolveRuntimeSelection()).toEqual({ runtimeId: "claude" });
    expect(resolveRuntimeSelection("opencode")).toEqual({ runtimeId: "opencode" });
    expect(() => resolveRuntimeSelection("bad runtime")).toThrow(RuntimeFactoryError);
  });

  it("provides an explicit OpenCode factory without changing the default registry", async () => {
    const registry = new RuntimeFactoryRegistry([createOpenCodeV1RuntimeFactory()]);

    const runtime = await registry.create({ runtimeId: "opencode-v1" }, run);

    expect(registry.runtimeIds).toEqual(["opencode-v1"]);
    await expect(runtime.start(new AbortController().signal)).resolves.toMatchObject({
      runtimeId: "opencode-v1",
    });
    await runtime.stop();
    expect(resolveRuntimeSelection()).toEqual({ runtimeId: "claude" });
    expect(createDefaultRuntimeRegistry().runtimeIds).toEqual(["claude"]);
  });

  it("rejects invalid prepared OpenCode policy before starting the supervisor", async () => {
    const supervisor: OpenCodeServerController = {
      crashSignal: new AbortController().signal,
      get info() {
        return undefined;
      },
      get crashError() {
        return undefined;
      },
      start: vi.fn(async () => {
        throw new Error("supervisor should not start for invalid configuration");
      }),
      stop: vi.fn(async () => undefined),
    };
    const registry = new RuntimeFactoryRegistry([
      createOpenCodeV1RuntimeFactory({
        supervisor: () => supervisor,
        config: {},
      }),
    ]);

    const result = await executeSelectedRun(registry, { runtimeId: "opencode-v1" }, run, {
      preparedConfig: { ...preparedConfig, allowedTools: ["UnknownTool"] },
    });

    expect(result.events.at(-1)?.payload).toMatchObject({ state: "failed" });
    expect(supervisor.start).not.toHaveBeenCalled();
  });

  it("fills configured OpenCode model with the selected run provider", async () => {
    let injectedConfig: unknown;
    const supervisor: OpenCodeServerController = {
      crashSignal: new AbortController().signal,
      get info() {
        return undefined;
      },
      get crashError() {
        return undefined;
      },
      start: vi.fn(async () => {
        throw new Error("stop after configuration capture");
      }),
      stop: vi.fn(async () => undefined),
    };
    const registry = new RuntimeFactoryRegistry([
      createOpenCodeV1RuntimeFactory({
        supervisor: (renderedConfig) => {
          injectedConfig = renderedConfig;
          return supervisor;
        },
        config: { model: "factory-model" },
      }),
    ]);

    const runtime = await registry.create({ runtimeId: "opencode-v1" }, run);
    expect((runtime as OpenCodeV1Runtime).renderedConfiguration?.config).toMatchObject({
      model: "vertex/factory-model",
      enabled_providers: ["vertex"],
    });
    expect(injectedConfig).toBe((runtime as OpenCodeV1Runtime).renderedConfiguration);
  });

  it("renders Python-prepared MCP policy into the OpenCode snapshot", async () => {
    const registry = new RuntimeFactoryRegistry([
      createOpenCodeV1RuntimeFactory({
        config: { model: "deployment-model" },
      }),
    ]);

    const runtime = await registry.create({ runtimeId: "opencode-v1" }, run, preparedConfig);
    const rendered = (runtime as OpenCodeV1Runtime).renderedConfiguration;

    expect(rendered?.config).toMatchObject({
      model: "vertex/deployment-model",
      mcp: {
        "prepared-server": {
          type: "remote",
          url: "http://prepared.example/mcp",
        },
      },
      permission: { read: "allow" },
    });
    expect(rendered?.config).not.toHaveProperty("mcp.stale-server");
  });

  it("registers and resolves factories without coupling to providers", async () => {
    const contexts: string[] = [];
    const runtime = new FakeAgentRuntime();
    const registry = new RuntimeFactoryRegistry([
      {
        runtimeId: "opencode",
        create(context) {
          contexts.push(`${context.selection.runtimeId}:${context.run.provider.id}`);
          return runtime;
        },
      },
    ]);

    expect(registry.has("opencode")).toBe(true);
    expect(registry.runtimeIds).toEqual(["opencode"]);
    expect(await registry.create({ runtimeId: "opencode" }, run)).toBe(runtime);
    expect(contexts).toEqual(["opencode:vertex"]);
    expect(() => registry.register({ runtimeId: "opencode", create: () => runtime })).toThrow(
      "already registered",
    );
  });

  it("reports unknown runtime IDs with available adapters", async () => {
    const registry = new RuntimeFactoryRegistry([
      { runtimeId: "claude", create: () => new FakeAgentRuntime() },
    ]);

    await expect(registry.create({ runtimeId: "opencode" }, run)).rejects.toThrow(
      "available: claude",
    );
  });

  it("runs a selected adapter through the coordinator lifecycle", async () => {
    let createdFor: string | undefined;
    const registry = new RuntimeFactoryRegistry([
      {
        runtimeId: "claude",
        create(context) {
          createdFor = context.run.runId;
          return new FakeAgentRuntime({ events: [event(1), event(2, true)] });
        },
      },
    ]);

    const result = await executeSelectedRun(registry, { runtimeId: "claude" }, run);

    expect(createdFor).toBe("run-factory");
    expect(result.terminal.payload.state).toBe("completed");
  });
});
