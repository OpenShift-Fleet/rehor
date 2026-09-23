import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createCompatibilitySink } from "../src/adapters/compatibility";
import type { PreparedCycleInput } from "../src/cycle-input";
import { InstructionStrategy } from "../src/instructions";
import { PreflightAction } from "../src/ports/python-bridge";
import {
  buildRehorRun,
  createRuntimeRegistryForCycle,
  runCoordinator,
  validateOpenCodeDeployment,
} from "../src/runner";
import type { OpenCodeV1DeploymentConfig } from "../src/runtimes/opencode-v1";

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
      options: { apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}" },
      models: { "gpt-6-luna": { name: "GPT-6 Luna", reasoning: true } },
    },
    {
      id: "rehor-openai-chat",
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}" },
      models: { "gpt-4o": { name: "GPT-4o", limit: { context: 128_000, output: 16_384 } } },
    },
  ],
  packages: [
    { name: "@ai-sdk/openai", version: "4.0.73" },
    { name: "@ai-sdk/openai-compatible", version: "3.0.54" },
  ],
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
      ),
    ).not.toThrow();
  });

  it("registers both runtime adapters without changing the Claude default", () => {
    const registry = createRuntimeRegistryForCycle(prepared, {
      workspaceRoot: "/work",
      openCodeDeployment: deployment,
      openCodeCommand: "/usr/local/bin/opencode",
      openCodeExpectedVersion: "1.18.29",
      environment: { PATH: "/usr/bin" },
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

  it("runs one prepared preflight cycle without starting a runtime on skip", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-runner-"));
    const events: string[] = [];
    const bridge = {
      prepareConfig: async () => ({
        ...prepared.config,
        claudeMdPath: join(directory, "CLAUDE.md"),
        claudeMdStrategy: InstructionStrategy.Ignore,
      }),
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
      once: true,
      initialIntervalSeconds: 0,
      initialIdleIntervalSeconds: 0,
    });

    expect(result.stopReason).toBe("max_cycles");
    expect(result.cycles).toBe(1);
    expect(result.results).toHaveLength(0);
    expect(events).toEqual(["idle-skip", "cleanup"]);
  });
});
