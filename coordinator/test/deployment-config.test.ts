import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadOpenCodeDeploymentConfig, renderOpenCodeConfigForCycle } from "../src";
import type { PreparedCycleInput } from "../src/cycle-input";
import { InstructionStrategy } from "../src/instructions";
import { validateOpenCodeDeployment } from "../src/runner";
import { parseVertexAllowedModels } from "../src/runtimes/opencode/model-defaults";

const temporaryDirectories: string[] = [];

const prepared: PreparedCycleInput = {
  config: {
    model: "gpt-6-luna",
    runtimeId: "opencode",
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
  ANTHROPIC_VERTEX_BASE_URL: "http://proxy:8443",
  VERTEX_ALLOWED_MODELS:
    "claude-sonnet-4-6,claude-opus-4-6,claude-haiku-4-5,claude-haiku-4-5@20251001",
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
          package: "@opencode/ai/providers/openai/responses",
          settings: {
            apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}",
            baseURL: "{env:REHOR_MODEL_PROXY_URL}",
          },
        }),
        expect.objectContaining({
          id: "rehor-openai-chat",
          package: "@opencode/ai/providers/openai-compatible",
          models: expect.objectContaining({ "gpt-4.1": expect.any(Object) }),
        }),
        expect.objectContaining({
          id: "vertex",
          settings: { baseURL: "{env:REHOR_VERTEX_PROXY_URL}" },
          models: expect.objectContaining({ "claude-opus-4-6": expect.any(Object) }),
        }),
      ]),
    );

    const defaultRendered = renderOpenCodeConfigForCycle(
      prepared.config,
      prepared.config.providerId,
      deployment,
    );
    expect(defaultRendered.config.model).toBe("rehor-openai/gpt-6-luna");
    expect(defaultRendered.config.agents).toMatchObject({
      title: { model: "rehor-openai/gpt-6-luna" },
    });
    expect(defaultRendered.requiredEnvironment).toEqual([
      "REHOR_MODEL_PROXY_TOKEN",
      "REHOR_MODEL_PROXY_URL",
      "REHOR_VERTEX_PROXY_URL",
    ]);
    expect(() =>
      validateOpenCodeDeployment(prepared, deployment, gatewayEnvironment),
    ).not.toThrow();

    const instanceOverride = {
      ...prepared.config,
      model: "gpt-4.1",
      providerId: "rehor-openai-chat",
    };
    const overrideRendered = renderOpenCodeConfigForCycle(
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

  it("renders OpenCode Vertex Claude through the proxy without Google credentials", async () => {
    const deployment = await loadOpenCodeDeploymentConfig(undefined);
    const vertexConfig = {
      ...prepared.config,
      model: "claude-opus-4-6",
      providerId: "vertex",
    };
    const rendered = renderOpenCodeConfigForCycle(
      vertexConfig,
      "vertex",
      deployment,
      undefined,
      parseVertexAllowedModels(gatewayEnvironment.VERTEX_ALLOWED_MODELS),
    );

    expect(rendered.config).toMatchObject({
      model: "vertex/claude-opus-4-6",
      agents: { title: { model: "vertex/claude-sonnet-4-6" } },
      policies: expect.arrayContaining([
        { action: "provider.use", resource: "*", effect: "deny" },
        { action: "provider.use", resource: "vertex", effect: "allow" },
      ]),
      providers: {
        vertex: {
          package: expect.stringMatching(/^aisdk:file:.*vertex-provider\.js$/),
          settings: { baseURL: "{env:REHOR_VERTEX_PROXY_URL}" },
          models: expect.objectContaining({
            "claude-opus-4-6": expect.any(Object),
            "claude-sonnet-4-6": expect.any(Object),
            "claude-haiku-4-5@20251001": expect.any(Object),
          }),
        },
      },
    });
    expect(rendered.requiredEnvironment).toContain("REHOR_VERTEX_PROXY_URL");
    expect(rendered.json).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
    expect(() =>
      validateOpenCodeDeployment(
        { ...prepared, config: vertexConfig },
        deployment,
        gatewayEnvironment,
      ),
    ).not.toThrow();
  });

  it("rejects Vertex deployments that bypass proxy URL or use an invalid endpoint", async () => {
    const deployment = await loadOpenCodeDeploymentConfig(undefined);
    const vertexConfig = { ...prepared.config, model: "claude-opus-4-6", providerId: "vertex" };

    expect(() =>
      validateOpenCodeDeployment({ ...prepared, config: vertexConfig }, deployment, {
        ...gatewayEnvironment,
        ANTHROPIC_VERTEX_BASE_URL: "https://aiplatform.googleapis.com",
      }),
    ).toThrow("proxy URL must be http://<proxy-host>:8443");

    const bypassDeployment = {
      ...deployment,
      providers: deployment.providers?.map((provider) =>
        provider.id === "vertex"
          ? { ...provider, settings: { baseURL: "https://aiplatform.googleapis.com" } }
          : provider,
      ),
    };
    expect(() =>
      validateOpenCodeDeployment(
        { ...prepared, config: vertexConfig },
        bypassDeployment,
        gatewayEnvironment,
      ),
    ).toThrow("baseURL must reference REHOR_VERTEX_PROXY_URL");
  });

  it("fails fast when Vertex model selection is outside deployment allowlist", async () => {
    const deployment = await loadOpenCodeDeploymentConfig(undefined);
    const vertexConfig = { ...prepared.config, model: "claude-opus-4-6", providerId: "vertex" };

    expect(() =>
      validateOpenCodeDeployment({ ...prepared, config: vertexConfig }, deployment, {
        ...gatewayEnvironment,
        VERTEX_ALLOWED_MODELS: "claude-sonnet-4-6",
      }),
    ).toThrow("not in VERTEX_ALLOWED_MODELS");
    expect(() =>
      validateOpenCodeDeployment(
        { ...prepared, config: { ...vertexConfig, model: "claude-opus-4-7" } },
        deployment,
        gatewayEnvironment,
      ),
    ).toThrow("does not declare prepared model 'claude-opus-4-7'");
    expect(() =>
      validateOpenCodeDeployment({ ...prepared, config: vertexConfig }, deployment, {
        ...gatewayEnvironment,
        VERTEX_ALLOWED_MODELS: "",
      }),
    ).toThrow("requires VERTEX_ALLOWED_MODELS");
  });

  it("falls back to selected Vertex model when Sonnet is outside the allowlist", async () => {
    const deployment = await loadOpenCodeDeploymentConfig(undefined);
    const vertexConfig = {
      ...prepared.config,
      model: "claude-opus-4-6",
      providerId: "vertex",
    };
    const opusOnlyEnvironment = {
      ...gatewayEnvironment,
      VERTEX_ALLOWED_MODELS: "claude-opus-4-6",
    };
    const rendered = renderOpenCodeConfigForCycle(
      vertexConfig,
      "vertex",
      deployment,
      undefined,
      parseVertexAllowedModels(opusOnlyEnvironment.VERTEX_ALLOWED_MODELS),
    );

    expect(rendered.config.agents).toMatchObject({
      title: { model: "vertex/claude-opus-4-6" },
    });
    expect(() =>
      validateOpenCodeDeployment(
        { ...prepared, config: vertexConfig },
        deployment,
        opusOnlyEnvironment,
      ),
    ).not.toThrow();
  });

  it("rejects an explicitly configured Vertex small model outside the allowlist", async () => {
    const deployment = await loadOpenCodeDeploymentConfig(undefined);
    const vertexConfig = {
      ...prepared.config,
      model: "claude-opus-4-6",
      providerId: "vertex",
    };
    const smallSonnetDeployment = { ...deployment, smallModel: "vertex/claude-sonnet-4-6" };

    expect(() =>
      validateOpenCodeDeployment({ ...prepared, config: vertexConfig }, smallSonnetDeployment, {
        ...gatewayEnvironment,
        VERTEX_ALLOWED_MODELS: "claude-opus-4-6",
      }),
    ).toThrow("small model 'claude-sonnet-4-6' is not in VERTEX_ALLOWED_MODELS");
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

  it("validates supplemental directory grants from deployment files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-opencode-directories-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "deployment.json");
    await writeFile(path, JSON.stringify({ additionalDirectories: ["/tmp/opencode"] }));
    await expect(loadOpenCodeDeploymentConfig(path)).resolves.toEqual({
      additionalDirectories: ["/tmp/opencode"],
    });
    for (const additionalDirectories of [null, "all", ["/"], ["/tmp/*"]]) {
      await writeFile(path, JSON.stringify({ additionalDirectories }));
      await expect(loadOpenCodeDeploymentConfig(path)).rejects.toThrow("additionalDirectories");
    }
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
