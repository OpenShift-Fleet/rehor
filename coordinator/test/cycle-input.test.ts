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
  maxTurns: 10,
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
  constructor(private readonly result: PreflightResult | null) {}

  async prepareConfig(input: { scriptDir: string }): Promise<ConfigPreparationResult> {
    return { ...config, claudeMdPath: join(input.scriptDir, "CLAUDE.md") };
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
  await writeFile(join(root, "presets", "workflows", "test-workflow", "CLAUDE.md"), "[workflow]");
  return root;
}

describe("instruction assembly", () => {
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
    expect(result.instructionHash.value).toBe(result.instructions.hash.value);
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
});
