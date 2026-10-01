import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadOpenCodeDeploymentConfig, renderOpenCodeV1ConfigForCycle } from "../src";
import type { PreparedCycleInput } from "../src/cycle-input";
import { InstructionStrategy } from "../src/instructions";
import { validateOpenCodeDeployment } from "../src/runner";

const temporaryDirectories: string[] = [];

const prepared: PreparedCycleInput = {
  config: {
    model: "gpt-6-luna",
    runtimeId: "opencode-v1",
    providerId: "rehor-openai",
    maxTurns: 10,
    intervalSeconds: 60,
    idleIntervalSeconds: 60,
    cycleTimeoutSeconds: 1800,
    idleReminderCooldownSeconds: 3600,
    workflow: "jira-sprint",
    source: "test",
    envs: [],
    activeEnvs: [],
    claudeMdStrategy: InstructionStrategy.Ignore,
    idleCycleLimit: 0,
    remoteAgentDir: null,
    sharedAgentDir: null,
    claudeMdPath: "/tmp/CLAUDE.md",
    mcpServers: {},
    openCodeMcpServers: {},
    allowedTools: [],
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

const gatewayEnvironment = {
  REHOR_MODEL_PROXY_URL: "http://proxy:8450/v1",
  REHOR_MODEL_PROXY_TOKEN: "test-proxy-token",
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("OpenCode deployment defaults", () => {
  it("loads shared model-free providers and renders the global default and instance override", async () => {
    const deployment = await loadOpenCodeDeploymentConfig(undefined);

    expect(deployment).not.toHaveProperty("model");
    expect(deployment.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rehor-openai",
          options: {
            apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}",
            baseURL: "{env:REHOR_MODEL_PROXY_URL}",
          },
        }),
        expect.objectContaining({
          id: "rehor-openai-chat",
          models: expect.objectContaining({ "gpt-4.1": expect.any(Object) }),
        }),
      ]),
    );

    const defaultRendered = renderOpenCodeV1ConfigForCycle(
      prepared.config,
      prepared.config.providerId,
      deployment,
    );
    expect(defaultRendered.config.model).toBe("rehor-openai/gpt-6-luna");
    expect(defaultRendered.requiredEnvironment).toEqual([
      "REHOR_MODEL_PROXY_TOKEN",
      "REHOR_MODEL_PROXY_URL",
    ]);
    expect(() =>
      validateOpenCodeDeployment(prepared, deployment, gatewayEnvironment),
    ).not.toThrow();

    const instanceOverride = {
      ...prepared.config,
      model: "gpt-4.1",
      providerId: "rehor-openai-chat",
    };
    const overrideRendered = renderOpenCodeV1ConfigForCycle(
      instanceOverride,
      instanceOverride.providerId,
      deployment,
    );
    expect(overrideRendered.config.model).toBe("rehor-openai-chat/gpt-4.1");
    expect(() =>
      validateOpenCodeDeployment(
        { ...prepared, config: instanceOverride },
        deployment,
        gatewayEnvironment,
      ),
    ).not.toThrow();
    expect(deployment).not.toHaveProperty("model");
  });

  it("keeps REHOR_OPENCODE_DEPLOYMENT_CONFIG as an explicit file override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-opencode-config-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "deployment.json");
    await writeFile(path, JSON.stringify({ providers: [{ id: "instance-provider" }] }));

    await expect(loadOpenCodeDeploymentConfig(path)).resolves.toEqual({
      providers: [{ id: "instance-provider" }],
    });
  });

  it("rejects a missing or invalid gateway before starting OpenCode", async () => {
    const deployment = await loadOpenCodeDeploymentConfig(undefined);

    expect(() => validateOpenCodeDeployment(prepared, deployment, {})).toThrow(
      "REHOR_MODEL_PROXY_URL",
    );
    expect(() =>
      validateOpenCodeDeployment(prepared, deployment, {
        REHOR_MODEL_PROXY_URL: "http://proxy:8450/v1",
      }),
    ).toThrow("REHOR_MODEL_PROXY_TOKEN");
    expect(() =>
      validateOpenCodeDeployment(prepared, deployment, {
        ...gatewayEnvironment,
        REHOR_MODEL_PROXY_URL: "not a URL",
      }),
    ).toThrow("gateway URL");
  });
});
