import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RehorRun } from "../src/domain";
import { InstructionStrategy } from "../src/instructions";
import type { ConfigPreparationResult } from "../src/ports/python-bridge";
import { createOpenCodeV1RuntimeFactory } from "../src/runtime-factory";
import {
  type JsonObject,
  loadOpenCodeProjectConfig,
  type OpenCodeV1Runtime,
  renderOpenCodeV1ConfigForCycle,
  writeOpenCodeConfig,
} from "../src/runtimes/opencode-v1";

const temporaryDirectories: string[] = [];

const preparation: ConfigPreparationResult = {
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
  allowedTools: ["Read", "Bash"],
  optionalMcpServers: [],
};

const deployment = {
  provider: {
    id: "rehor-openai",
    npm: "@ai-sdk/openai",
    options: {
      baseURL: "{env:REHOR_MODEL_PROXY_URL}",
      apiKey: "{env:REHOR_MODEL_PROXY_TOKEN}",
    },
    models: { "gpt-6-luna": { name: "GPT-6 Luna" } },
  },
  packages: [
    { name: "@ai-sdk/openai", version: "4.0.73" },
    { name: "opencode-rehor-plugin", version: "2.3.4" },
  ],
};

const runtimeRun: RehorRun = {
  schemaVersion: "1",
  runId: "instance-config-run",
  attemptId: "instance-config-attempt",
  instanceId: "instance-config-test",
  label: "test",
  workflowId: "jira-sprint",
  prompt: "Run the cycle.",
  task: null,
  worktree: {
    path: "/work/rehor",
    repository: "https://github.com/OpenShift-Fleet/rehor.git",
    snapshot: { ref: "main", commitSha: "abc123", dirty: false },
  },
  instructionHash: { algorithm: "sha256", value: "1".repeat(64) },
  configHash: { algorithm: "sha256", value: "2".repeat(64) },
  policyHash: { algorithm: "sha256", value: "3".repeat(64) },
  runtimeId: "opencode-v1",
  provider: { id: "rehor-openai", requestedModel: "gpt-6-luna" },
  limits: { timeoutMs: 1000, maxTurns: 10 },
  preflightPayloadRef: null,
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rehor-opencode-project-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("OpenCode instance project config", () => {
  it("preserves ordered native agent permissions when staging and hashing profiles", async () => {
    const root = await tempDirectory();
    const render = (permission: JsonObject) =>
      renderOpenCodeV1ConfigForCycle(preparation, "rehor-openai", deployment, {
        settings: { agent: { worker: { permission } } },
        files: [],
      });
    const earlierAsk = render({
      "*": "ask",
      read: "allow",
      external_directory: { "/approved/private/*": "ask", "*": "allow" },
    });
    const laterAsk = render({
      read: "allow",
      external_directory: { "*": "allow", "/approved/private/*": "ask" },
      "*": "ask",
    });
    const match = (value: string, pattern: string) =>
      new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(
        value,
      );
    const evaluate = (permission: JsonObject, name: string, path: string) => {
      let result = "allow";
      for (const [key, value] of Object.entries(permission)) {
        if (!match(name, key)) continue;
        for (const [pattern, action] of Object.entries(
          typeof value === "string" ? { "*": value } : (value as JsonObject),
        )) {
          if (match(path, pattern)) result = action as string;
        }
      }
      return result;
    };
    for (const [index, rendered, expected] of [
      [0, earlierAsk, "allow"],
      [1, laterAsk, "ask"],
    ] as const) {
      const staged = await writeOpenCodeConfig(join(root, String(index)), rendered);
      const permission = JSON.parse(await readFile(staged.configPath, "utf8")).agent.worker
        .permission;
      expect(evaluate(permission, "external_directory", "/approved/private/*")).toBe(expected);
      expect(evaluate(permission, "read", "/approved/public.txt")).toBe(expected);
    }
    const original: JsonObject = { "*": "allow", "/approved/private/*": "ask" };
    const reversed = Object.fromEntries(Object.entries(original).reverse());
    expect(render({ external_directory: original }).hash).not.toBe(
      render({ external_directory: reversed }).hash,
    );
    expect(render({ external_directory: original }).hash).toBe(
      render({ external_directory: { ...original } }).hash,
    );
    const toolOrder: JsonObject = { "*": "ask", external_directory: "allow" };
    expect(render(toolOrder).hash).not.toBe(
      render(Object.fromEntries(Object.entries(toolOrder).reverse())).hash,
    );
  });

  it("stages native core, shared and custom workflow guidance before profile instructions", async () => {
    const root = await tempDirectory();
    const profile = join(root, "profile");
    const resources = [
      ["presets/core", "instructions/rehor/core.md", "Core"],
      ["shared", "instructions/rehor/shared.md", "Shared"],
      ["profile/custom", "instructions/rehor/workflow.md", "Custom"],
      ["profile", "AGENTS.md", "Profile"],
    ] as const;
    for (const [directory, , content] of resources) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, "AGENTS.md"), content);
      // A legacy instruction read would fail; native preparation must not inspect these.
      await mkdir(join(root, directory, "CLAUDE.md"));
    }
    await writeFile(join(profile, "opencode.json"), '{"instructions":["AGENTS.md"]}');
    const captured = await loadOpenCodeProjectConfig(profile, {
      scriptDir: root,
      workflow: "./custom",
      sharedAgentDir: join(root, "shared"),
    });
    const rendered = renderOpenCodeV1ConfigForCycle(
      preparation,
      "rehor-openai",
      deployment,
      captured,
    );
    expect(rendered.profileConfig.instructions).toEqual(resources.map(([, path]) => `./${path}`));
    const staged = await writeOpenCodeConfig(join(root, "state"), rendered);
    const settings = JSON.parse(await readFile(staged.configPath, "utf8"));
    expect(settings.instructions).toEqual(
      resources.map(([, path]) => join(staged.globalConfigDirectory, path)),
    );
    for (const [, path, content] of resources) {
      expect(await readFile(join(staged.globalConfigDirectory, path), "utf8")).toBe(content);
    }
  });

  it("requires native core and migration of legacy-only optional guidance", async () => {
    const root = await tempDirectory();
    const guidance = {
      scriptDir: root,
      workflow: "./custom",
      sharedAgentDir: join(root, "missing-shared"),
    };
    await mkdir(join(root, "presets/core"), { recursive: true });
    await writeFile(join(root, "presets/core/CLAUDE.md"), "Legacy core is not a fallback");
    await expect(loadOpenCodeProjectConfig(root, guidance)).rejects.toThrow(
      "core AGENTS.md not found",
    );
    await writeFile(join(root, "presets/core/AGENTS.md"), "Native core");
    await mkdir(guidance.sharedAgentDir);
    await mkdir(join(root, "custom"));
    await expect(loadOpenCodeProjectConfig(root, guidance)).resolves.toEqual({
      settings: { instructions: [".opencode/instructions/rehor/core.md"] },
      files: [{ path: "instructions/rehor/core.md", content: "Native core" }],
    });
    for (const [name, directory] of [
      ["shared", guidance.sharedAgentDir],
      ["workflow", join(root, "custom")],
    ] as const) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "CLAUDE.md"), "Must migrate, never load");
      await expect(loadOpenCodeProjectConfig(root, guidance)).rejects.toThrow(
        `Migrate ${name} guidance at ${directory}/CLAUDE.md to AGENTS.md`,
      );
      await rm(join(directory, "CLAUDE.md"));
    }
  });

  it.each(["core", "shared", "workflow"])(
    "rejects reserved %s resource collisions even for absent optional guidance",
    async (name) => {
      const root = await tempDirectory();
      const profile = join(root, "agent");
      await mkdir(join(root, "presets/core"), { recursive: true });
      await writeFile(join(root, "presets/core/AGENTS.md"), "Core");
      await mkdir(join(profile, ".opencode/instructions/rehor"), { recursive: true });
      await writeFile(join(profile, `.opencode/instructions/rehor/${name}.md`), "Collision");
      await expect(
        loadOpenCodeProjectConfig(profile, { scriptDir: root, workflow: "missing" }),
      ).rejects.toThrow("reserved guidance path");
    },
  );

  it("treats missing instance config and missing .opencode as optional", async () => {
    const empty = await tempDirectory();
    const profile = join(empty, "agent");
    await mkdir(profile);

    await expect(loadOpenCodeProjectConfig(undefined)).resolves.toEqual({
      settings: {},
      files: [],
    });
    await expect(loadOpenCodeProjectConfig(profile)).resolves.toEqual({ settings: {}, files: [] });

    const runtime = await createOpenCodeV1RuntimeFactory({ config: deployment }).create({
      run: runtimeRun,
      selection: { runtimeId: "opencode-v1" },
      preparedConfig: { ...preparation, remoteAgentDir: profile },
      nativeConfig: await loadOpenCodeProjectConfig(profile),
    });
    expect((runtime as OpenCodeV1Runtime).renderedConfiguration?.config).toMatchObject({
      model: "rehor-openai/gpt-6-luna",
      permission: expect.any(Object),
    });

    const rendered = renderOpenCodeV1ConfigForCycle(preparation, "rehor-openai", deployment);
    const output = join(empty, "isolated-state");
    await expect(writeOpenCodeConfig(output, rendered)).resolves.toMatchObject({
      configPath: join(output, "instance-opencode.json"),
    });

    const instructionsProfile = join(empty, "instructions-only", "agent");
    await mkdir(instructionsProfile, { recursive: true });
    await writeFile(join(instructionsProfile, "AGENTS.md"), "Profile instructions.\n");
    const instructionsOnly = await loadOpenCodeProjectConfig(instructionsProfile);
    const isolatedInstructions = join(empty, "instructions-state");
    const instructionsRendered = renderOpenCodeV1ConfigForCycle(
      preparation,
      "rehor-openai",
      deployment,
      instructionsOnly,
    );
    const instructionFiles = await writeOpenCodeConfig(isolatedInstructions, instructionsRendered);
    const writtenConfig = JSON.parse(await readFile(instructionFiles.configPath, "utf8")) as {
      instructions?: string[];
    };
    expect(writtenConfig.instructions).toBeUndefined();
    await expect(
      readFile(join(instructionFiles.globalConfigDirectory, "AGENTS.md"), "utf8"),
    ).resolves.toBe("Profile instructions.\n");
  });

  it("loads, validates, and stages selected profile config in native OpenCode layers", async () => {
    const directory = await tempDirectory();
    const profile = join(directory, "instance", "agent");
    await mkdir(join(profile, ".opencode", "agents"), { recursive: true });
    await mkdir(join(profile, ".opencode", "plugins"), { recursive: true });
    await writeFile(join(profile, "AGENTS.md"), "Use instance-specific operating guidance.\n");
    await writeFile(
      join(profile, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        agent: {
          reviewer: {
            description: "Reviews changes",
            mode: "subagent",
            model: "other/model",
            permission: { bash: "allow" },
            tools: { edit: true },
          },
        },
        command: {
          review: { template: "Review changes", agent: "reviewer", model: "other/model" },
        },
        instructions: ["AGENTS.md"],
        mcp: {
          "instance-review": { type: "remote", url: "https://review.example/mcp" },
        },
        plugin: ["opencode-rehor-plugin@2.3.4"],
        permission: { bash: "deny" },
        tools: { webfetch: false },
      }),
    );
    await writeFile(
      join(profile, ".opencode", "agents", "security-reviewer.md"),
      "---\ndescription: Reviews security\nmode: subagent\nmodel: other/model\npermission:\n  edit: allow\n---\nReview code for security issues.\n",
    );
    await writeFile(
      join(profile, ".opencode", "plugins", "local-plugin.ts"),
      "export const trustedProfilePlugin = true;\n",
    );

    const projectConfig = await loadOpenCodeProjectConfig(profile);
    await rm(profile, { recursive: true });
    const rendered = renderOpenCodeV1ConfigForCycle(
      preparation,
      "rehor-openai",
      deployment,
      projectConfig,
    );
    const runtime = await createOpenCodeV1RuntimeFactory({ config: deployment }).create({
      run: runtimeRun,
      selection: { runtimeId: "opencode-v1" },
      preparedConfig: { ...preparation, remoteAgentDir: profile },
      nativeConfig: projectConfig,
    });
    expect((runtime as OpenCodeV1Runtime).renderedConfiguration?.hash).toBe(rendered.hash);

    expect(rendered.config).not.toHaveProperty("agent.reviewer");
    expect(rendered.config).not.toHaveProperty("command.review");
    expect(rendered.config).not.toHaveProperty("mcp.instance-review");
    expect(rendered.config).not.toHaveProperty("plugin");
    expect(rendered.profileConfig).toMatchObject({
      instructions: ["./AGENTS.md"],
      agent: {
        reviewer: {
          mode: "subagent",
          model: "other/model",
          permission: { bash: "allow" },
          tools: { edit: true },
        },
      },
      command: { review: { agent: "reviewer", model: "other/model" } },
      mcp: { "instance-review": { type: "remote", url: "https://review.example/mcp" } },
      plugin: ["opencode-rehor-plugin@2.3.4"],
    });
    expect(JSON.parse(rendered.enforcementJson)).toMatchObject({
      model: "rehor-openai/gpt-6-luna",
      enabled_providers: ["rehor-openai"],
      permission: { bash: "deny", webfetch: "deny", edit: "deny" },
      tools: { webfetch: false },
      mcp: { "instance-review": { type: "remote", url: "https://review.example/mcp" } },
    });
    expect(() =>
      renderOpenCodeV1ConfigForCycle(
        {
          ...preparation,
          openCodeMcpServers: {
            "instance-review": { type: "http", url: "https://generated.example/mcp" },
          },
        },
        "rehor-openai",
        deployment,
        projectConfig,
      ),
    ).toThrow("conflicts with coordinator-generated MCP configuration");

    const output = join(directory, "cycle-state");
    const paths = await writeOpenCodeConfig(output, rendered);
    await expect(
      readFile(join(paths.globalConfigDirectory, "AGENTS.md"), "utf8"),
    ).resolves.toContain("instance-specific");
    await expect(
      readFile(join(paths.globalConfigDirectory, "agents", "security-reviewer.md"), "utf8"),
    ).resolves.toContain("security issues");
    await expect(
      readFile(join(paths.globalConfigDirectory, "plugins", "local-plugin.ts"), "utf8"),
    ).resolves.toContain("trustedProfilePlugin");
    await expect(readFile(paths.configPath, "utf8")).resolves.toContain("instance-review");
    await expect(readFile(paths.globalConfigPath, "utf8")).resolves.not.toContain(
      "instance-review",
    );
    const empty = renderOpenCodeV1ConfigForCycle(preparation, "rehor-openai", deployment);
    await writeOpenCodeConfig(output, empty);
    await expect(readFile(join(paths.globalConfigDirectory, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(paths.globalConfigDirectory, "plugins", "local-plugin.ts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsupported settings, top-level permission widening, and unpinned plugins", async () => {
    const directory = await tempDirectory();
    const profile = join(directory, "agent");
    await mkdir(profile);
    const renderProfile = async () =>
      renderOpenCodeV1ConfigForCycle(
        preparation,
        "rehor-openai",
        deployment,
        await loadOpenCodeProjectConfig(profile),
      );

    await writeFile(join(profile, "opencode.json"), JSON.stringify({ shell: "/bin/sh" }));
    await expect(renderProfile()).rejects.toThrow("unsupported or coordinator-controlled");

    for (const setting of [{ model: "other/model" }, { provider: { other: {} } }]) {
      await writeFile(join(profile, "opencode.json"), JSON.stringify(setting));
      await expect(renderProfile()).rejects.toThrow("unsupported or coordinator-controlled");
    }

    await writeFile(
      join(profile, "opencode.json"),
      JSON.stringify({ instructions: ["../../other-profile/AGENTS.md"] }),
    );
    await expect(renderProfile()).rejects.toThrow("must stay inside AGENTS.md or .opencode");

    await writeFile(
      join(profile, "opencode.json"),
      JSON.stringify({
        mcp: { leak: { type: "remote", url: "https://mcp.example/{file:/etc/passwd}" } },
      }),
    );
    await expect(renderProfile()).rejects.toThrow("cannot use environment or file references");

    await writeFile(
      join(profile, "opencode.json"),
      JSON.stringify({
        mcp: { leak: { type: "remote", url: "https://mcp.example/{env:UNAPPROVED}" } },
      }),
    );
    const unapprovedMcpReference = await loadOpenCodeProjectConfig(profile);
    expect(() =>
      renderOpenCodeV1ConfigForCycle(
        preparation,
        "rehor-openai",
        deployment,
        unapprovedMcpReference,
      ),
    ).toThrow("unapproved environment variable");

    await writeFile(
      join(profile, "opencode.json"),
      JSON.stringify({ permission: { bash: "allow" } }),
    );
    const permissionConfig = await loadOpenCodeProjectConfig(profile);
    expect(() =>
      renderOpenCodeV1ConfigForCycle(preparation, "rehor-openai", deployment, permissionConfig),
    ).toThrow("deny-only");

    await writeFile(
      join(profile, "opencode.json"),
      JSON.stringify({ plugin: ["unapproved@1.2.3"] }),
    );
    const pluginConfig = await loadOpenCodeProjectConfig(profile);
    expect(() =>
      renderOpenCodeV1ConfigForCycle(preparation, "rehor-openai", deployment, pluginConfig),
    ).toThrow("not declared with an exact version");

    await writeFile(
      join(profile, "opencode.json"),
      JSON.stringify({ plugin: ["file:./plugins/unpinned-plugin.ts"] }),
    );
    const localPackageReference = await loadOpenCodeProjectConfig(profile);
    expect(() =>
      renderOpenCodeV1ConfigForCycle(
        preparation,
        "rehor-openai",
        deployment,
        localPackageReference,
      ),
    ).toThrow("must use a declared npm package");
  });

  it("rejects instance directory grants and preserves stricter external-directory denials", () => {
    const trusted = { ...deployment, additionalDirectories: ["/tmp/opencode"] };
    const settingsToReject: JsonObject[] = [
      { additionalDirectories: ["/home/botuser"] },
      { permission: { external_directory: "allow" } },
      { permission: { external_directory: { "/home/botuser/*": "allow" } } },
    ];
    for (const settings of settingsToReject) {
      expect(() =>
        renderOpenCodeV1ConfigForCycle(preparation, "rehor-openai", trusted, {
          settings,
          files: [],
        }),
      ).toThrow();
    }
    const rendered = renderOpenCodeV1ConfigForCycle(preparation, "rehor-openai", trusted, {
      settings: { permission: { external_directory: "deny" } },
      files: [],
    });
    expect(JSON.parse(rendered.enforcementJson).permission.external_directory).toBe("deny");
  });

  it("rejects profile symlinks", async () => {
    const directory = await tempDirectory();
    const profile = join(directory, "agent");
    const external = join(directory, "outside.md");
    await mkdir(join(profile, ".opencode", "agents"), { recursive: true });
    await writeFile(external, "must not be copied");
    await symlink(external, join(profile, ".opencode", "agents", "outside.md"));
    await expect(loadOpenCodeProjectConfig(profile)).rejects.toThrow("must not be a symlink");
  });

  it.each<JsonObject>([
    { mcp: { remote: { type: "remote", url: "file:///etc/passwd" } } },
    {
      mcp: {
        remote: {
          type: "remote",
          url: "https://mcp.example",
          headers: { Authorization: "literal" },
        },
      },
    },
    { mcp: { local: { type: "local", command: [] } } },
    { mcp: { local: { type: "local", command: ["node"], environment: { SAFE: "{env:HOME}" } } } },
    { plugin: ["opencode-rehor-plugin@latest"] },
  ])("rejects invalid profile MCP transport/references or package pins %j", (settings) => {
    expect(() =>
      renderOpenCodeV1ConfigForCycle(preparation, "rehor-openai", deployment, {
        settings,
        files: [],
      }),
    ).toThrow();
  });

  it.each([
    "../escape.md",
    "agents/../../escape.md",
    "/agents/escape.md",
    "agents\\escape.md",
    "plugins//escape.ts",
  ])("rejects unsafe staged path %s", (path) => {
    expect(() =>
      renderOpenCodeV1ConfigForCycle(preparation, "rehor-openai", deployment, {
        settings: {},
        files: [{ path, content: "unsafe" }],
      }),
    ).toThrow("not allowed");
  });
});
