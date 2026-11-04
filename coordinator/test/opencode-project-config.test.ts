import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadOpenCodeProjectConfig } from "../src/runtimes/opencode/project-config";
import { renderOpenCodeConfigForCycle, writeOpenCodeConfig } from "../src/runtimes/opencode/render";
import type { JsonObject } from "../src/runtimes/opencode/types";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function temp() {
  const path = await mkdtemp(join(tmpdir(), "native-profile-"));
  directories.push(path);
  return path;
}
const render = (settings: JsonObject, files: { path: string; content: string }[] = []) =>
  renderOpenCodeConfigForCycle(
    { model: "model", allowedTools: ["Read", "Bash"] },
    "provider",
    { additionalDirectories: ["/approved"], packages: [{ name: "plugin", version: "1.2.3" }] },
    { settings, files },
  );

it("stages native core/shared/workflow guidance in order plus profile instructions", async () => {
  const root = await temp();
  for (const layer of ["presets/core", "shared", "profile/custom", "profile"]) {
    await mkdir(join(root, layer), { recursive: true });
    await writeFile(join(root, layer, "AGENTS.md"), layer);
  }
  await writeFile(
    join(root, "profile/opencode.json"),
    JSON.stringify({ instructions: ["AGENTS.md"] }),
  );
  const profile = await loadOpenCodeProjectConfig(join(root, "profile"), {
    scriptDir: root,
    sharedAgentDir: join(root, "shared"),
    workflow: "./custom",
  });
  const rendered = render(profile.settings, [...profile.files]);
  const paths = await writeOpenCodeConfig(join(root, "state"), rendered);
  expect(JSON.parse(await readFile(paths.configPath, "utf8")).instructions).toEqual(
    [
      "instructions/rehor/core.md",
      "instructions/rehor/shared.md",
      "instructions/rehor/workflow.md",
      "AGENTS.md",
    ].map((path) => join(paths.globalConfigDirectory, path)),
  );
});

it("requires AGENTS.md instead of falling back to CLAUDE.md", async () => {
  const root = await temp();
  await mkdir(join(root, "presets/core"), { recursive: true });
  await writeFile(join(root, "presets/core/CLAUDE.md"), "legacy");
  await expect(
    loadOpenCodeProjectConfig(root, { scriptDir: root, workflow: "missing" }),
  ).rejects.toThrow("core AGENTS.md not found");
});

it("stages native agents/commands/plugins/MCP and preserves ordered permissions in hashes", async () => {
  const permissions = [
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "private/*", effect: "deny" },
  ];
  const settings: JsonObject = {
    agents: { reviewer: { mode: "subagent", system: "Review", permissions } },
    commands: { review: { template: "Review", subagent: true } },
    plugins: [{ package: "plugin@1.2.3", options: { enabled: true } }],
    permissions: [{ action: "shell", resource: "git push *", effect: "deny" }],
    mcp: {
      servers: {
        docs: {
          type: "remote",
          url: "https://docs.example/mcp",
          disabled: true,
          timeout: { catalog: 1000, execution: 2000 },
        },
      },
    },
  };
  const first = render(settings);
  const second = render({
    ...settings,
    agents: {
      reviewer: { mode: "subagent", system: "Review", permissions: [...permissions].reverse() },
    },
  });
  expect(first.hash).not.toBe(second.hash);
  expect(first.profileConfig.agents).toEqual(settings.agents);
  expect(JSON.parse(first.enforcementJson).mcp.servers.docs.disabled).toBe(true);
  expect(JSON.parse(first.enforcementJson).permissions.at(-1)).toEqual({
    action: "shell",
    resource: "git push *",
    effect: "deny",
  });
  const root = await temp();
  const paths = await writeOpenCodeConfig(root, first);
  expect(JSON.parse(await readFile(paths.configPath, "utf8")).agents.reviewer.permissions).toEqual(
    permissions,
  );
});

it("keeps profile external deny in authoritative global ceiling", async () => {
  const rendered = render({
    permissions: [{ action: "external_directory", resource: "*", effect: "deny" }],
  });
  expect((rendered.config.policies as JsonObject[]).at(-1)).toEqual({
    action: "tool.use",
    resource: "external_directory:*",
    effect: "deny",
  });
  const paths = await writeOpenCodeConfig(await temp(), rendered);
  expect(JSON.parse(await readFile(paths.globalConfigPath, "utf8")).policies.at(-1).effect).toBe(
    "deny",
  );
});

it.each<JsonObject>([
  { experimental: { subagent_depth: 0 } },
  { experimental: { subagent_depth: 2, todo: false } },
  { experimental: { todo: true } },
])("accepts only native experimental settings %j", (settings) => {
  expect(render(settings).profileConfig.experimental).toEqual(settings.experimental);
  expect(JSON.parse(render(settings).enforcementJson).experimental).toEqual(settings.experimental);
});

it.each<JsonObject>([
  { agent: {} },
  { command: {} },
  { plugin: [] },
  { permission: {} },
  { subagent_depth: 1 },
  { snapshot: false },
  { tools: {} },
  { disabled_providers: [] },
  { experimental: { subagent_depth: -1 } },
  { experimental: { todo: "true" } },
  { experimental: { policies: [] } },
  { compaction: { tail_turns: 5 } },
  { compaction: { prune: false } },
  { permissions: [{ action: "shell", resource: "*", effect: "allow" }] },
  { agents: { worker: { permission: { bash: "deny" } } } },
  {
    agents: {
      worker: { mode: "broken", permissions: [{ action: "read", resource: "*", effect: "deny" }] },
    },
  },
  { agents: { worker: { steps: 0 } } },
  { agents: { worker: { disabled: "false" } } },
  { agents: { worker: { request: { headers: { Example: 12 } } } } },
  { agents: { worker: { model: "bare-model" } } },
  { agents: { worker: { permissions: [{ action: "bash", resource: "*", effect: "deny" }] } } },
  { commands: { review: { template: "Review", subtask: true } } },
  { mcp: { legacy: { type: "remote", url: "https://example" } } },
  { mcp: { servers: { docs: { type: "remote", url: "https://example", enabled: true } } } },
  { mcp: { servers: { docs: { type: "remote", url: "https://example", codemode: "true" } } } },
  { mcp: { servers: { docs: { type: "remote", url: "https://example", timeout: 10 } } } },
  { plugins: ["plugin@latest"] },
  { plugins: ["file:///tmp/plugin"] },
])("rejects legacy, widening or malformed profile %j", (settings) => {
  expect(() => render(settings)).toThrow();
});

it.each<JsonObject>([
  { instructions: ["../../escape.md"] },
  { agents: { worker: { system: "{file:/etc/passwd}" } } },
  { mcp: { servers: { docs: { type: "remote", url: "https://example/{env:GH_TOKEN}" } } } },
  {
    mcp: {
      servers: {
        docs: { type: "remote", url: "https://example", headers: { Authorization: "literal" } },
      },
    },
  },
  { mcp: { servers: { docs: { type: "local", command: [] } } } },
])("retains profile reference/transport safety %j", (settings) => {
  expect(() => render(settings)).toThrow();
});

it("snapshots profile files, removes stale staged files and rejects symlinks", async () => {
  const root = await temp();
  const profile = join(root, "profile");
  await mkdir(join(profile, ".opencode/agents"), { recursive: true });
  await writeFile(join(profile, "AGENTS.md"), "profile guidance");
  await writeFile(
    join(profile, ".opencode/agents/reviewer.md"),
    "---\nmode: subagent\n---\nReview",
  );
  const captured = await loadOpenCodeProjectConfig(profile);
  const staged = await writeOpenCodeConfig(
    join(root, "state"),
    render(captured.settings, [...captured.files]),
  );
  expect(
    await readFile(join(staged.globalConfigDirectory, "agents/reviewer.md"), "utf8"),
  ).toContain("Review");
  await writeOpenCodeConfig(join(root, "state"), render({}));
  await expect(
    readFile(join(staged.globalConfigDirectory, "agents/reviewer.md")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await symlink(join(profile, "AGENTS.md"), join(profile, ".opencode/agents/link.md"));
  await expect(loadOpenCodeProjectConfig(profile)).rejects.toThrow("must not be a symlink");
});

it("skips generated Python bytecode artifacts in staged skill directories", async () => {
  const root = await temp();
  await mkdir(join(root, ".opencode/skills/triage-jenkins/__pycache__"), {
    recursive: true,
  });
  await writeFile(join(root, ".opencode/skills/triage-jenkins/SKILL.md"), "# Triage\n");
  await writeFile(join(root, ".opencode/skills/triage-jenkins/triage_jenkins.py"), "print()\n");
  await writeFile(
    join(root, ".opencode/skills/triage-jenkins/__pycache__/triage_jenkins.cpython-312.pyc"),
    Buffer.from([0x0a, 0x0d, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0xe3]),
  );
  await writeFile(join(root, ".opencode/skills/legacy.pyc"), Buffer.from([0x00, 0x01, 0x02]));
  await writeFile(join(root, ".opencode/skills/legacy.pyo"), Buffer.from([0x00, 0x01, 0x02]));
  const captured = await loadOpenCodeProjectConfig(root);
  expect(captured.files.map((file) => file.path)).toEqual([
    "skills/triage-jenkins/SKILL.md",
    "skills/triage-jenkins/triage_jenkins.py",
  ]);
});

it.each([
  "../escape",
  "/agents/escape",
  "agents/../../escape",
  "agents\\escape",
  "plugins//escape",
  "agent/legacy.md",
  "modes/legacy.md",
  "plugin/legacy.ts",
  "skill/legacy/SKILL.md",
])("rejects unsafe staged path %s", (path) => {
  expect(() => render({}, [{ path, content: "bad" }])).toThrow();
});
