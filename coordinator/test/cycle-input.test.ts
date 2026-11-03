import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assembleInstructions,
  buildCyclePrompt,
  type ConfigPreparationResult,
  InstructionStrategy,
  PreflightAction,
  type PreflightResult,
  type PythonBridge,
  PythonCoordinatorBridge,
  prepareCycleInput,
} from "../src";

const repositoryRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

const config: ConfigPreparationResult = {
  model: "test-model",
  runtimeId: "claude",
  providerId: "vertex",
  budgetUsd: 5,
  intervalSeconds: 300,
  idleIntervalSeconds: 300,
  cycleTimeoutSeconds: 1800,
  idleReminderCooldownSeconds: 172800,
  workflow: "test-workflow",
  source: "test",
  envs: null,
  activeEnvs: [],
  claudeMdStrategy: InstructionStrategy.Append,
  idleCycleLimit: 0,
  remoteAgentDir: null,
  sharedAgentDir: null,
  claudeMdPath: "/tmp/CLAUDE.md",
  mcpServers: {},
  openCodeMcpServers: {},
};

function preflight(action: PreflightResult["action"]): PreflightResult {
  return {
    action,
    prompt: action === PreflightAction.Start ? "work found" : "",
    transcript: action === PreflightAction.Skip ? "nothing to do" : "",
    scripts: [{ name: "01-test.py", status: action, content: "content" }],
  };
}

class FakeBridge implements PythonBridge {
  constructor(
    private readonly result: PreflightResult | null,
    private readonly configOverrides: Partial<ConfigPreparationResult> = {},
  ) {}

  async prepareConfig(input: { scriptDir: string }): Promise<ConfigPreparationResult> {
    return {
      ...config,
      ...this.configOverrides,
      claudeMdPath: join(input.scriptDir, "CLAUDE.md"),
    };
  }

  async preflight(): Promise<PreflightResult | null> {
    return this.result;
  }
}

async function createCycleRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rehor-cycle-"));
  await mkdir(join(root, "presets", "core"), { recursive: true });
  await mkdir(join(root, "presets", "workflows", "test-workflow"), { recursive: true });
  await writeFile(join(root, "presets", "core", "CLAUDE.md"), "[core]");
  await writeFile(join(root, "presets", "core", "AGENTS.md"), "[native core]");
  await writeFile(join(root, "presets", "workflows", "test-workflow", "CLAUDE.md"), "[workflow]");
  await writeFile(
    join(root, "presets", "workflows", "test-workflow", "AGENTS.md"),
    "[native workflow]",
  );
  return root;
}

describe("instruction assembly", () => {
  it.each(["jira-sprint", "jira-kanban", "onboarding"])(
    "preserves Claude assembly through canonical preset aliases for %s",
    async (workflow) => {
      for (const directory of ["presets/core", `presets/workflows/${workflow}`]) {
        const canonical = join(repositoryRoot, directory, "AGENTS.md");
        const alias = join(repositoryRoot, directory, "CLAUDE.md");
        expect(await readFile(alias, "utf8")).toBe(await readFile(canonical, "utf8"));
      }
      const assembled = await assembleInstructions({ scriptDir: repositoryRoot, workflow });
      expect(assembled.content).toBe(
        (await readFile(join(repositoryRoot, "presets/core/AGENTS.md"), "utf8")) +
          (await readFile(join(repositoryRoot, `presets/workflows/${workflow}/AGENTS.md`), "utf8")),
      );
    },
  );

  it("preserves core, shared, workflow, and instance order", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehor-instructions-"));
    await mkdir(join(root, "presets", "core"), { recursive: true });
    await mkdir(join(root, "presets", "workflows", "test-workflow"), { recursive: true });
    await mkdir(join(root, "shared"), { recursive: true });
    await mkdir(join(root, "instance"), { recursive: true });
    await writeFile(join(root, "presets", "core", "CLAUDE.md"), "[core]");
    await writeFile(join(root, "presets", "workflows", "test-workflow", "CLAUDE.md"), "[workflow]");
    await writeFile(join(root, "shared", "CLAUDE.md"), "[shared]");
    await writeFile(join(root, "instance", "CLAUDE.md"), "[instance]");

    const result = await assembleInstructions({
      scriptDir: root,
      workflow: "test-workflow",
      strategy: InstructionStrategy.Append,
      remoteAgentDir: join(root, "instance"),
      sharedAgentDir: join(root, "shared"),
    });

    expect(result.content).toBe("[core][shared][workflow][instance]");
    expect(result.layers.map(({ name }) => name)).toEqual([
      "core",
      "shared",
      "workflow",
      "instance",
    ]);
    expect(result.hash.algorithm).toBe("sha256");
    expect(result.hash.value).toHaveLength(64);
  });

  it("uses instance instructions instead of workflow with replace", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehor-instructions-"));
    await mkdir(join(root, "presets", "core"), { recursive: true });
    await mkdir(join(root, "presets", "workflows", "test-workflow"), { recursive: true });
    await mkdir(join(root, "instance"), { recursive: true });
    await writeFile(join(root, "presets", "core", "CLAUDE.md"), "[core]");
    await writeFile(join(root, "presets", "workflows", "test-workflow", "CLAUDE.md"), "[workflow]");
    await writeFile(join(root, "instance", "CLAUDE.md"), "[instance]");

    const result = await assembleInstructions({
      scriptDir: root,
      workflow: "test-workflow",
      strategy: InstructionStrategy.Replace,
      remoteAgentDir: join(root, "instance"),
    });

    expect(result.content).toBe("[core][instance]");
  });
});

describe("cycle preparation", () => {
  it("does not produce a runtime prompt for preflight skip", async () => {
    const root = await createCycleRoot();
    const result = await prepareCycleInput(new FakeBridge(preflight(PreflightAction.Skip)), {
      scriptDir: root,
      label: "hcc-ai-framework",
      instanceId: "instance-1",
    });

    expect(result.preflight?.action).toBe("skip");
    expect(result.prompt).toBeUndefined();
    expect(result.preflightPayloadRef).toBeNull();
  });

  it("builds prompt and audit reference for preflight start", async () => {
    const root = await createCycleRoot();
    const result = await prepareCycleInput(new FakeBridge(preflight(PreflightAction.Start)), {
      scriptDir: root,
      label: "hcc-ai-framework",
      instanceId: "instance-1",
    });

    expect(result.prompt).toContain("## Pre-flight Data");
    expect(result.prompt).toContain("work found");
    expect(result.preflightPayloadRef).toMatch(/^preflight:\/\/sha256\/[a-f0-9]{64}$/);
  });

  it("persists instructionHash content when strategy overrides Python config", async () => {
    const root = await createCycleRoot();
    const instanceDir = join(root, "instance");
    await mkdir(instanceDir, { recursive: true });
    await writeFile(join(instanceDir, "CLAUDE.md"), "[instance]");
    const bridge: PythonBridge = {
      prepareConfig: async () => ({
        ...config,
        claudeMdStrategy: InstructionStrategy.Append,
        remoteAgentDir: instanceDir,
        claudeMdPath: join(root, "CLAUDE.md"),
      }),
      preflight: async () => preflight(PreflightAction.Start),
    };

    const result = await prepareCycleInput(bridge, {
      scriptDir: root,
      label: "hcc-ai-framework",
      strategy: InstructionStrategy.Replace,
    });

    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("[core][instance]");
    expect(result.instructionHash.value).toBe(result.instructions?.hash.value);
  });

  it("switches Claude to native snapshots, removes managed output, and preserves project guidance", async () => {
    const root = await createCycleRoot();
    const workflow = join(root, "presets", "workflows", "test-workflow", "AGENTS.md");
    const profile = join(root, "profile");
    await mkdir(join(profile, ".opencode", "plugins"), { recursive: true });
    await writeFile(join(profile, "AGENTS.md"), "Native profile guidance.");
    await writeFile(join(profile, "opencode.json"), '{"snapshots":false,"default_agent":"build"}');
    await mkdir(join(root, "repos/project"), { recursive: true });
    const projectClaude = join(root, "repos/project/CLAUDE.md");
    await writeFile(projectClaude, "Project-owned CLAUDE instructions.\n");
    await writeFile(join(root, "AGENTS.md"), "Project-owned AGENTS instructions.");
    const bridge = new FakeBridge(preflight(PreflightAction.Start), {
      runtimeId: "opencode",
      remoteAgentDir: profile,
      sharedAgentDir: join(root, "missing-shared"),
    });
    const options = {
      scriptDir: root,
      label: "hcc-ai-framework",
    };
    await prepareCycleInput(new FakeBridge(null), options);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("[core][workflow]");
    const result = await prepareCycleInput(bridge, options);
    for (const strategy of Object.values(InstructionStrategy)) {
      const repeated = await prepareCycleInput(
        new FakeBridge(null, {
          runtimeId: "opencode",
          remoteAgentDir: profile,
          claudeMdStrategy: strategy,
        }),
        { ...options, strategy },
      );
      expect(repeated.instructionHash).toEqual(result.instructionHash);
      expect(repeated.configHash).toEqual(result.configHash);
    }

    await expect(readFile(join(root, "CLAUDE.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(projectClaude, "utf8")).toBe("Project-owned CLAUDE instructions.\n");
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(
      "Project-owned AGENTS instructions.",
    );
    expect(result.instructions).toBeUndefined();
    expect(result.config.runtimeId).toBe("opencode");
    expect(result.nativeConfig?.files).toEqual([
      { path: "AGENTS.md", content: "Native profile guidance." },
      { path: "instructions/rehor/core.md", content: "[native core]" },
      { path: "instructions/rehor/workflow.md", content: "[native workflow]" },
    ]);
    expect(result.prompt).toContain("native OpenCode instructions and AGENTS.md");
    expect(result.prompt).not.toContain("CLAUDE.md");

    await writeFile(join(profile, "opencode.json"), '{"default_agent":"build","snapshots":false}');
    expect((await prepareCycleInput(bridge, options)).instructionHash).toEqual(
      result.instructionHash,
    );
    let previous = result;
    for (const [path, content] of [
      [join(profile, "AGENTS.md"), "Changed native instructions."],
      [join(profile, "opencode.json"), '{"snapshots":true}'],
      [join(profile, ".opencode/plugins/local.ts"), "export const plugin = true;"],
      [join(root, "presets/core/AGENTS.md"), "Changed native core."],
      [workflow, "Changed native workflow."],
    ] as const) {
      await writeFile(path, content);
      const changed = await prepareCycleInput(bridge, options);
      expect(changed.instructionHash).not.toEqual(previous.instructionHash);
      expect(changed.configHash).not.toEqual(previous.configHash);
      previous = changed;
    }
    for (const path of [
      join(root, "presets/core/CLAUDE.md"),
      join(root, "presets/workflows/test-workflow/CLAUDE.md"),
      join(profile, "CLAUDE.md"),
    ]) {
      await writeFile(path, "Changed legacy guidance.");
    }
    expect((await prepareCycleInput(bridge, options)).instructionHash).toEqual(
      previous.instructionHash,
    );
  });

  it("includes MCP servers and allowed tools in configHash", async () => {
    const root = await createCycleRoot();
    const options = {
      scriptDir: root,
      label: "hcc-ai-framework",
      instanceId: "instance-1",
    };
    const baseline = await prepareCycleInput(
      new FakeBridge(preflight(PreflightAction.Start)),
      options,
    );
    const mcpChanged = await prepareCycleInput(
      new FakeBridge(preflight(PreflightAction.Start), {
        openCodeMcpServers: {
          "mcp-example": { type: "http", url: "http://mcp.example" },
        },
      }),
      options,
    );
    const toolsChanged = await prepareCycleInput(
      new FakeBridge(preflight(PreflightAction.Start), { allowedTools: ["Bash"] }),
      options,
    );
    const optionalMcpChanged = await prepareCycleInput(
      new FakeBridge(preflight(PreflightAction.Start), {
        optionalMcpServers: ["optional-persona-mcp"],
      }),
      options,
    );
    const runtimeChanged = await prepareCycleInput(
      new FakeBridge(preflight(PreflightAction.Start), { runtimeId: "opencode" }),
      options,
    );
    const providerChanged = await prepareCycleInput(
      new FakeBridge(preflight(PreflightAction.Start), { providerId: "rehor-openai" }),
      options,
    );

    expect(mcpChanged.configHash.value).not.toBe(baseline.configHash.value);
    expect(toolsChanged.configHash.value).not.toBe(baseline.configHash.value);
    expect(optionalMcpChanged.configHash.value).not.toBe(baseline.configHash.value);
    expect(runtimeChanged.configHash.value).not.toBe(baseline.configHash.value);
    expect(providerChanged.configHash.value).not.toBe(baseline.configHash.value);
  });

  it("keeps the current no-preflight triage prompt", () => {
    expect(buildCyclePrompt({ label: "hcc-ai-framework" })).toContain(
      "Start by invoking the /triage skill",
    );
  });
});

describe("Python preflight bridge", () => {
  it("executes the existing Python preflight protocol", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehor-python-bridge-"));
    const workflowDir = join(root, "presets", "workflows", "test-workflow", "preflight");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, "01-test.py"),
      'import json; print(json.dumps({"status": "start", "content": "bridge work"}))\n',
    );

    const bridge = new PythonCoordinatorBridge({ cwd: repositoryRoot });
    const result = await bridge.preflight({ scriptDir: root, workflow: "test-workflow" });

    expect(result?.action).toBe("start");
    expect(result?.prompt).toContain("bridge work");
    expect(result?.scripts).toEqual([
      { name: "01-test.py", status: "start", content: "bridge work" },
    ]);
  });

  it("rejects config preparation without a dedicated OpenCode MCP view", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehor-python-config-required-"));
    const executable = join(root, "bridge-fixture");
    const response = {
      protocolVersion: 1,
      ok: true,
      result: {
        model: "test-model",
        runtimeId: "opencode",
        providerId: "rehor-openai",
        budgetUsd: 5,
        intervalSeconds: 300,
        idleIntervalSeconds: 300,
        cycleTimeoutSeconds: 1_800,
        idleReminderCooldownSeconds: 1_728_000,
        workflow: "test-workflow",
        source: "test",
        envs: null,
        activeEnvs: [],
        claudeMdStrategy: "append",
        idleCycleLimit: 0,
        remoteAgentDir: null,
        sharedAgentDir: null,
        claudeMdPath: join(root, "CLAUDE.md"),
        mcpServers: {},
        allowedTools: [],
        optionalMcpServers: [],
      },
    };
    await writeFile(
      executable,
      `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.stdout.write(${JSON.stringify(JSON.stringify(response))}));\n`,
      { mode: 0o755 },
    );

    const bridge = new PythonCoordinatorBridge({ executable, cwd: root });
    await expect(bridge.prepareConfig({ scriptDir: root, label: "test-label" })).rejects.toThrow(
      "config.openCodeMcpServers is required",
    );
  });

  it("defaults budgetUsd to 5 when config preparation omits it", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehor-python-budget-default-"));
    const executable = join(root, "bridge-fixture");
    const response = {
      protocolVersion: 1,
      ok: true,
      result: {
        model: "test-model",
        runtimeId: "opencode",
        providerId: "rehor-openai",
        intervalSeconds: 300,
        idleIntervalSeconds: 300,
        cycleTimeoutSeconds: 1_800,
        idleReminderCooldownSeconds: 1_728_000,
        workflow: "test-workflow",
        source: "test",
        envs: null,
        activeEnvs: [],
        claudeMdStrategy: "append",
        idleCycleLimit: 0,
        remoteAgentDir: null,
        sharedAgentDir: null,
        claudeMdPath: join(root, "CLAUDE.md"),
        mcpServers: {},
        openCodeMcpServers: {},
        allowedTools: [],
        optionalMcpServers: [],
      },
    };
    await writeFile(
      executable,
      `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.stdout.write(${JSON.stringify(JSON.stringify(response))}));\n`,
      { mode: 0o755 },
    );

    const bridge = new PythonCoordinatorBridge({ executable, cwd: root });
    const prepared = await bridge.prepareConfig({ scriptDir: root, label: "test-label" });

    expect(prepared.budgetUsd).toBe(5);
  });

  it("parses MCP transports and allowed tools from config preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehor-python-config-"));
    const executable = join(root, "bridge-fixture");
    const response = {
      protocolVersion: 1,
      ok: true,
      result: {
        model: "test-model",
        runtimeId: "opencode",
        providerId: "rehor-openai",
        budgetUsd: 5,
        intervalSeconds: 300,
        idleIntervalSeconds: 300,
        cycleTimeoutSeconds: 1_800,
        idleReminderCooldownSeconds: 1_728_000,
        workflow: "test-workflow",
        source: "test",
        envs: null,
        activeEnvs: ["github"],
        claudeMdStrategy: "append",
        idleCycleLimit: 0,
        remoteAgentDir: null,
        sharedAgentDir: null,
        claudeMdPath: join(root, "CLAUDE.md"),
        gitConfigGlobal: join(root, ".gitconfig"),
        mcpServers: {
          "stdio-server": {
            command: "node",
            args: ["server.js"],
            env: { TOKEN: "secret" },
            timeout: 250,
            alwaysLoad: true,
          },
          "http-server": {
            type: "http",
            url: "http://mcp.example",
            headers: { Authorization: "Bearer token" },
            timeout: 500,
            alwaysLoad: false,
          },
          "sse-server": { type: "sse", url: "https://mcp.example/events" },
        },
        openCodeMcpServers: {
          "project-server": { type: "http", url: "$" + "{JIRA_MCP_URL}" },
        },
        allowedTools: ["Bash", "mcp__mcp-atlassian__jira_get_issue"],
        optionalMcpServers: ["hcc-patternfly-data-view"],
      },
    };
    await writeFile(
      executable,
      `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.stdout.write(${JSON.stringify(JSON.stringify(response))}));\n`,
      { mode: 0o755 },
    );

    const bridge = new PythonCoordinatorBridge({ executable, cwd: root });
    const result = await bridge.prepareConfig({ scriptDir: root, label: "test-label" });

    expect(result.mcpServers).toEqual(response.result.mcpServers);
    expect(result.openCodeMcpServers).toEqual(response.result.openCodeMcpServers);
    expect(result.runtimeId).toBe("opencode");
    expect(result.providerId).toBe("rehor-openai");
    expect(result.gitConfigGlobal).toBe(response.result.gitConfigGlobal);
    expect(result.allowedTools).toEqual(response.result.allowedTools);
    expect(result.optionalMcpServers).toEqual(response.result.optionalMcpServers);
  });
});
