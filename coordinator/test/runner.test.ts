import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { createCompatibilitySink } from "../src/adapters/compatibility";
import type { CoordinatorResult } from "../src/coordinator";
import type { PreparedCycleInput } from "../src/cycle-input";
import { InstructionStrategy } from "../src/instructions";
import { PreflightAction } from "../src/ports/python-bridge";
import {
  buildRehorRun,
  createRuntimeRegistryForCycle,
  runCoordinator,
  validateOpenCodeDeployment,
} from "../src/runner";
import * as runtimeFactory from "../src/runtime-factory";
import type { OpenCodeV1DeploymentConfig } from "../src/runtimes/opencode-v1";

afterEach(() => {
  vi.restoreAllMocks();
  queryMock.mockReset();
});

const prepared: PreparedCycleInput = {
  config: {
    model: "gpt-6-luna",
    runtimeId: "opencode-v1",
    providerId: "rehor-openai",
    maxTurns: 17,
    intervalSeconds: 30,
    idleIntervalSeconds: 45,
    cycleTimeoutSeconds: 120,
    idleReminderCooldownSeconds: 3600,
    workflow: "jira-sprint",
    source: "test",
    envs: [],
    activeEnvs: [],
    claudeMdStrategy: InstructionStrategy.Append,
    idleCycleLimit: 4,
    remoteAgentDir: null,
    sharedAgentDir: null,
    claudeMdPath: "/tmp/CLAUDE.md",
    mcpServers: {},
    openCodeMcpServers: {},
    allowedTools: ["Read", "Bash"],
    optionalMcpServers: [],
  },
  instructions: {
    content: "instructions",
    hash: { algorithm: "sha256", value: "1".repeat(64) },
    layers: [],
  },
  preflight: null,
  prompt: "Run one cycle.",
  instructionHash: { algorithm: "sha256", value: "1".repeat(64) },
  configHash: { algorithm: "sha256", value: "2".repeat(64) },
  preflightPayloadRef: null,
};

const deployment: OpenCodeV1DeploymentConfig = {
  providers: [
    {
      id: "rehor-openai",
      npm: "@ai-sdk/openai",
      options: {
        apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}",
        baseURL: "{env:REHOR_MODEL_PROXY_URL}",
      },
      models: { "gpt-6-luna": { name: "GPT-6 Luna", reasoning: true } },
    },
    {
      id: "rehor-openai-chat",
      npm: "@ai-sdk/openai-compatible",
      options: {
        apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}",
        baseURL: "{env:REHOR_MODEL_PROXY_URL}",
      },
      models: { "gpt-4o": { name: "GPT-4o", limit: { context: 128_000, output: 16_384 } } },
    },
  ],
  packages: [
    { name: "@ai-sdk/openai", version: "4.0.73" },
    { name: "@ai-sdk/openai-compatible", version: "3.0.54" },
  ],
};

const proxyEnvironment = {
  REHOR_MODEL_PROXY_URL: "http://proxy:8450/v1",
  REHOR_MODEL_PROXY_TOKEN: "test-proxy-token",
};

describe("production runner boundary", () => {
  it("builds a provider-neutral run from prepared Python input", async () => {
    const run = await buildRehorRun(prepared, {
      scriptDir: "/work/rehor",
      instanceId: "instance-1",
      label: "hcc-ai-framework",
      repository: "https://github.com/example/rehor.git",
      snapshot: { ref: "refs/heads/main", commitSha: "abc123", dirty: true },
      policyVersion: "policy-test",
    });

    expect(run).toMatchObject({
      schemaVersion: "1",
      instanceId: "instance-1",
      label: "hcc-ai-framework",
      workflowId: "jira-sprint",
      runtimeId: "opencode-v1",
      provider: { id: "rehor-openai", requestedModel: "gpt-6-luna" },
      limits: { timeoutMs: 120_000, maxTurns: 17 },
      worktree: {
        path: "/work/rehor",
        repository: "https://github.com/example/rehor.git",
        snapshot: { ref: "refs/heads/main", commitSha: "abc123", dirty: true },
      },
    });
    expect(run.runId).not.toBe(run.attemptId);
    expect(run.policyHash).toEqual({
      algorithm: "sha256",
      value: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("fails closed when OpenCode deployment provider drifts from prepared provider", () => {
    expect(() =>
      validateOpenCodeDeployment(prepared, {
        ...deployment,
        providers: deployment.providers?.map((provider) =>
          provider.id === "rehor-openai" ? { ...provider, id: "other-provider" } : provider,
        ),
      }),
    ).toThrow("does not declare prepared provider 'rehor-openai'");
  });

  it("requires Chat Completions models to be declared by the selected provider", () => {
    const chatRun = {
      ...prepared,
      config: { ...prepared.config, model: "gpt-6-luna", providerId: "rehor-openai-chat" },
    };
    expect(() => validateOpenCodeDeployment(chatRun, deployment)).toThrow(
      "OpenCode deployment provider 'rehor-openai-chat' does not declare prepared model 'gpt-6-luna'",
    );

    expect(() =>
      validateOpenCodeDeployment(
        { ...chatRun, config: { ...chatRun.config, model: "gpt-4o" } },
        deployment,
        proxyEnvironment,
      ),
    ).not.toThrow();
  });

  it("registers both runtime adapters without changing the Claude default", () => {
    const registry = createRuntimeRegistryForCycle(prepared, {
      workspaceRoot: "/work",
      openCodeDeployment: deployment,
      openCodeCommand: "/usr/local/bin/opencode",
      openCodeExpectedVersion: "1.18.29",
      environment: { PATH: "/usr/bin", ...proxyEnvironment },
    });

    expect(registry.runtimeIds).toEqual(["claude", "opencode-v1"]);
  });

  it("keeps the legacy Claude registry Claude-only", () => {
    const registry = createRuntimeRegistryForCycle(
      {
        ...prepared,
        config: {
          ...prepared.config,
          model: "claude-3-7-sonnet",
          runtimeId: "claude",
          providerId: "vertex",
        },
      },
      { workspaceRoot: "/work", environment: { PATH: "/usr/bin" } },
    );

    expect(registry.runtimeIds).toEqual(["claude"]);
  });

  it("forwards Git config and records legacy preflight metrics before a runtime attempt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-runner-"));
    const metrics: unknown[] = [];
    const runtimeEnvironment: NodeJS.ProcessEnv = { ...proxyEnvironment };
    const createRegistry = vi.spyOn(runtimeFactory, "createDefaultRuntimeRegistry");
    vi.spyOn(runtimeFactory, "executeConfiguredRun").mockRejectedValue(
      new Error("runtime unavailable"),
    );
    const gitConfigGlobal = join(directory, ".gitconfig");
    const bridge = {
      prepareConfig: async () => ({
        ...prepared.config,
        claudeMdPath: join(directory, "CLAUDE.md"),
        gitConfigGlobal,
        claudeMdStrategy: InstructionStrategy.Ignore,
      }),
      preflight: async () => ({
        action: PreflightAction.Start,
        prompt: "work found",
        transcript: "work found",
        scripts: [],
      }),
      cleanupBetweenCycles: async () => undefined,
    };

    const result = await runCoordinator({
      scriptDir: resolve(process.cwd(), ".."),
      label: "hcc-ai-framework",
      instanceId: "instance-1",
      dataDirectory: directory,
      lockPath: join(directory, ".lock"),
      sleepSignalPath: join(directory, "cycle-sleep.json"),
      bridge,
      environment: runtimeEnvironment,
      openCodeDeployment: deployment,
      writers: {
        metrics: {
          observe: (point) => {
            metrics.push(point);
          },
        },
      },
      once: true,
      initialIntervalSeconds: 0,
      initialIdleIntervalSeconds: 0,
    });

    expect(result.failures).toBe(1);
    expect(runtimeEnvironment.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(createRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ GIT_CONFIG_GLOBAL: gitConfigGlobal }),
      }),
    );
    expect(metrics).toContainEqual(
      expect.objectContaining({
        name: "devbot_preflight_outcome_total",
        type: "counter",
        value: 1,
        labels: { label: "hcc-ai-framework", action: "start" },
      }),
    );
    expect(metrics).toContainEqual(
      expect.objectContaining({
        name: "devbot_preflight_consecutive_errors",
        type: "gauge",
        value: 0,
        labels: { label: "hcc-ai-framework" },
      }),
    );
  });

  it("counts a failed CoordinatorResult as a run failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-runner-"));
    const execute = vi.spyOn(runtimeFactory, "executeConfiguredRun").mockResolvedValue({
      error: new Error("projection failed"),
      terminal: { payload: { state: "completed" } },
    } as CoordinatorResult);
    const bridge = {
      prepareConfig: async () => ({
        ...prepared.config,
        model: "claude-opus-4-6",
        runtimeId: "claude",
        providerId: "vertex",
        claudeMdPath: join(directory, "CLAUDE.md"),
        claudeMdStrategy: InstructionStrategy.Ignore,
      }),
      preflight: async () => ({
        action: PreflightAction.Start,
        prompt: "work found",
        transcript: "work found",
        scripts: [],
      }),
      cleanupBetweenCycles: async () => undefined,
    };

    try {
      const result = await runCoordinator({
        scriptDir: resolve(process.cwd(), ".."),
        label: "hcc-ai-framework",
        instanceId: "instance-1",
        dataDirectory: directory,
        lockPath: join(directory, ".lock"),
        sleepSignalPath: join(directory, "cycle-sleep.json"),
        bridge,
        writers: {},
        once: true,
        initialIntervalSeconds: 0,
        initialIdleIntervalSeconds: 0,
      });

      expect(result).toMatchObject({ stopReason: "max_cycles", failures: 1, results: [] });
    } finally {
      execute.mockRestore();
    }
  });

  it("rejects an undeclared OpenCode provider during preparation, before any attempt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-runner-"));
    const execute = vi.spyOn(runtimeFactory, "executeConfiguredRun");
    const phases: string[] = [];
    const bridge = {
      prepareConfig: async () => ({
        ...prepared.config,
        model: "claude-sonnet-4-6",
        providerId: "vertex",
        claudeMdPath: join(directory, "CLAUDE.md"),
        claudeMdStrategy: InstructionStrategy.Ignore,
      }),
      preflight: async () => ({
        action: PreflightAction.Start,
        prompt: "work found",
        transcript: "work found",
        scripts: [],
      }),
      cleanupBetweenCycles: async () => ({ diskFreeMb: 2048 }),
    };

    const result = await runCoordinator({
      scriptDir: resolve(process.cwd(), ".."),
      label: "hcc-ai-framework",
      instanceId: "instance-1",
      dataDirectory: directory,
      lockPath: join(directory, ".lock"),
      sleepSignalPath: join(directory, "cycle-sleep.json"),
      bridge,
      openCodeDeployment: deployment,
      environment: { ...proxyEnvironment },
      writers: {},
      onError: (_error, phase) => {
        phases.push(phase);
      },
      once: true,
      initialIntervalSeconds: 0,
      initialIdleIntervalSeconds: 0,
    });

    expect(result).toMatchObject({ stopReason: "max_cycles", failures: 1 });
    expect(phases).toEqual(["prepare"]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("exports the disk reading and keeps a successful run when cleanup fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-runner-"));
    const metrics: Array<{ name: string; value: number }> = [];
    vi.spyOn(runtimeFactory, "executeConfiguredRun").mockResolvedValue({
      terminal: { payload: { state: "completed" } },
    } as CoordinatorResult);
    let cleanups = 0;
    const bridge = {
      prepareConfig: async () => ({
        ...prepared.config,
        model: "claude-opus-4-6",
        runtimeId: "claude",
        providerId: "vertex",
        claudeMdPath: join(directory, "CLAUDE.md"),
        claudeMdStrategy: InstructionStrategy.Ignore,
      }),
      preflight: async () => ({
        action: PreflightAction.Start,
        prompt: "work found",
        transcript: "work found",
        scripts: [],
      }),
      cleanupBetweenCycles: async () => {
        cleanups += 1;
        throw new Error("bridge crashed");
      },
    };

    const result = await runCoordinator({
      scriptDir: resolve(process.cwd(), ".."),
      label: "hcc-ai-framework",
      instanceId: "instance-1",
      dataDirectory: directory,
      lockPath: join(directory, ".lock"),
      sleepSignalPath: join(directory, "cycle-sleep.json"),
      bridge,
      writers: {
        metrics: {
          observe: (point) => {
            metrics.push(point);
          },
        },
      },
      once: true,
      initialIntervalSeconds: 0,
      initialIdleIntervalSeconds: 0,
    });

    expect(cleanups).toBe(1);
    expect(result).toMatchObject({ stopReason: "max_cycles", failures: 0 });
    expect(result.results).toHaveLength(1);
    expect(metrics).toContainEqual(
      expect.objectContaining({
        name: "devbot_coordinator_errors_total",
        labels: { label: "hcc-ai-framework", phase: "cleanup" },
      }),
    );
  });

  it("gives the Claude rollback runtime the per-cycle MCP servers and tool list", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-runner-"));
    let sdkOptions: Record<string, unknown> | undefined;
    queryMock.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      sdkOptions = options;
      const messages = (async function* (): AsyncGenerator<unknown> {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Rolled back cycle finished",
          num_turns: 1,
          duration_ms: 5,
          session_id: "session-rollback",
          uuid: "sdk-result",
        };
      })();
      return Object.assign(messages, { close: vi.fn() });
    });
    const bridge = {
      prepareConfig: async () => ({
        ...prepared.config,
        model: "claude-sonnet-4-6",
        runtimeId: "claude",
        providerId: "vertex",
        claudeMdPath: join(directory, "CLAUDE.md"),
        claudeMdStrategy: InstructionStrategy.Ignore,
        mcpServers: {
          "mcp-atlassian": {
            type: "http" as const,
            // Python hands over both reference syntaxes; split so Biome accepts the literal.
            url: "$" + "{JIRA_MCP_URL}",
            headers: { Authorization: "Bearer {env:JIRA_MCP_TOKEN}" },
          },
          "bot-memory": { command: "memory-mcp", args: ["--port", "$" + "{MEMORY_PORT}"] },
        },
        allowedTools: ["Read", "Bash", "mcp__mcp-atlassian__*"],
      }),
      preflight: async () => ({
        action: PreflightAction.Start,
        prompt: "work found",
        transcript: "work found",
        scripts: [],
      }),
      cleanupBetweenCycles: async () => undefined,
    };

    const result = await runCoordinator({
      scriptDir: resolve(process.cwd(), ".."),
      label: "hcc-ai-framework",
      instanceId: "instance-1",
      dataDirectory: directory,
      lockPath: join(directory, ".lock"),
      sleepSignalPath: join(directory, "cycle-sleep.json"),
      bridge,
      environment: {
        PATH: "/usr/bin",
        JIRA_MCP_URL: "https://jira.example/mcp",
        JIRA_MCP_TOKEN: "jira-token",
        MEMORY_PORT: "8080",
      },
      writers: {},
      once: true,
      initialIntervalSeconds: 0,
      initialIdleIntervalSeconds: 0,
    });

    expect(result).toMatchObject({ stopReason: "max_cycles", failures: 0 });
    expect(queryMock).toHaveBeenCalledOnce();
    expect(sdkOptions?.mcpServers).toEqual({
      "mcp-atlassian": {
        type: "http",
        url: "https://jira.example/mcp",
        headers: { Authorization: "Bearer jira-token" },
      },
      "bot-memory": { command: "memory-mcp", args: ["--port", "8080"] },
    });
    expect(sdkOptions?.allowedTools).toEqual(["Read", "Bash", "mcp__mcp-atlassian__*"]);
  });

  it("runs one prepared preflight cycle without starting a runtime on skip", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-runner-"));
    const events: string[] = [];
    const bridge = {
      runScheduledMaintenance: async () => {
        events.push("maintenance");
      },
      prepareConfig: async () => {
        events.push("prepare");
        return {
          ...prepared.config,
          claudeMdPath: join(directory, "CLAUDE.md"),
          claudeMdStrategy: InstructionStrategy.Ignore,
        };
      },
      preflight: async () => ({
        action: PreflightAction.Skip,
        prompt: "",
        transcript: "No work found",
        scripts: [],
      }),
      idlePreflightSkip: async () => {
        events.push("idle-skip");
      },
      cleanupBetweenCycles: async () => {
        events.push("cleanup");
        return { diskFreeMb: 1024 };
      },
    };
    const compatibility = createCompatibilitySink({
      dataDirectory: directory,
      compressTranscript: async (text) => Buffer.from(text),
    });

    const result = await runCoordinator({
      scriptDir: resolve(process.cwd(), ".."),
      label: "hcc-ai-framework",
      instanceId: "instance-1",
      dataDirectory: directory,
      lockPath: join(directory, ".lock"),
      sleepSignalPath: join(directory, "cycle-sleep.json"),
      bridge,
      writers: compatibility.writers,
      compatibility,
      openCodeDeployment: deployment,
      environment: { ...proxyEnvironment },
      once: true,
      initialIntervalSeconds: 0,
      initialIdleIntervalSeconds: 0,
    });

    expect(result.stopReason).toBe("max_cycles");
    expect(result.cycles).toBe(1);
    expect(result.results).toHaveLength(0);
    expect(events).toEqual(["maintenance", "prepare", "idle-skip", "cleanup"]);
    const output = compatibility.metricStore.render();
    expect(output).toContain("devbot_disk_free_mb 1024");
    expect(output).toContain('devbot_work_type_total{label="hcc-ai-framework",work_type="idle"} 1');
  });
});
