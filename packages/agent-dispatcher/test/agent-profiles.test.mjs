import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgentProfiles } from "../dist/agent-profiles.js";

// Existing onboarding profile, plus the new required image field.
const onboarding = `workflow: onboarding
source: jira
# Native OpenCode runtime, launched by BOT_EXECUTION_ENGINE=coordinator.
# Loads core/workflow AGENTS.md plus this profile's agent/AGENTS.md natively.
# Provider adapter and medium (normal) reasoning effort: ../opencode-deployment.json.
runtime: opencode-v1
provider: rehor-openai
model: gpt-6.1-sol
envs:
  # Keep sentinel for install-envs.sh (build) and entrypoint.sh (runtime):
  # empty envs currently skips installation but runs all runtime preset entrypoints.
  - _none
image:
  repository: registry.example/team/name # comments are YAML, not part of value
`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agent-profiles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bot = join(root, "dev-bot");
  const agent = join(root, "instance", "rehor-onboarding-config", "agent");
  await Promise.all([
    mkdir(agent, { recursive: true }),
    mkdir(join(bot, "presets", "workflows", "onboarding", "preflight"), { recursive: true }),
    mkdir(join(bot, "presets", "shared", "preflight"), { recursive: true }),
    mkdir(join(bot, ".claude", "skills"), { recursive: true }),
  ]);
  await writeFile(join(agent, "instance.yaml"), onboarding);
  await writeFile(join(bot, "presets", "workflows", "onboarding", "preflight", "01-work.py"), "pass\n");
  // macOS tmpdir may have a /var -> /private/var alias.
  const realRoot = await realpath(root);
  return { root, realRoot, bot, agent, config: join(agent, "instance.yaml") };
}

test("maps onboarding layout, YAML comments and default image tag", async (t) => {
  const { root, realRoot } = await fixture(t);
  const [profile] = await discoverAgentProfiles(root);
  const agent = join(realRoot, "instance", "rehor-onboarding-config", "agent");
  const bot = join(realRoot, "dev-bot");
  assert.deepEqual(profile, {
    name: "rehor-onboarding-config", configPath: join(agent, "instance.yaml"),
    botRoot: bot, instanceDir: agent, workflow: "onboarding",
    workflowDir: join(bot, "presets", "workflows", "onboarding"),
    workflowPreflightDir: join(bot, "presets", "workflows", "onboarding", "preflight"),
    instancePreflightDir: undefined,
    image: { repository: "registry.example/team/name", tag: "latest", reference: "registry.example/team/name:latest" },
    preflightEnv: {},
  });
});

test("maps multiple agents, explicit image tag and safe remote-relative workflow", async (t) => {
  const { root, agent, realRoot } = await fixture(t);
  await mkdir(join(agent, "preflight"));
  const second = join(root, "instance", "second", "agent");
  await mkdir(join(second, "custom", "workflow", "preflight"), { recursive: true });
  await writeFile(join(second, "instance.yaml"), "workflow: ./custom/workflow\nimage: { repository: 'registry.example:5000/team/name', tag: 'v1.2' }\n");
  const profiles = await discoverAgentProfiles(root);
  assert.deepEqual(profiles.map((p) => p.name), ["rehor-onboarding-config", "second"]);
  assert.equal(profiles[0].instancePreflightDir, join(realRoot, "instance", "rehor-onboarding-config", "agent", "preflight"));
  assert.equal(profiles[1].workflow, "./custom/workflow");
  assert.equal(profiles[1].workflowDir, join(realRoot, "instance", "second", "agent", "custom", "workflow"));
  assert.equal(profiles[1].image.reference, "registry.example:5000/team/name:v1.2");
});

test("reads non-secret per-agent preflight settings and rejects credential fields", async (t) => {
  const { root, config } = await fixture(t);
  await writeFile(config, "workflow: onboarding\nimage: {repository: registry.example/team/name}\npreflight:\n  env:\n    BOT_INSTANCE_ID: test-agent\n    BOT_LABEL: test-label\n");
  assert.deepEqual((await discoverAgentProfiles(root))[0].preflightEnv, { BOT_INSTANCE_ID: "test-agent", BOT_LABEL: "test-label" });
  await writeFile(config, "workflow: onboarding\nimage: {repository: registry.example/team/name}\npreflight:\n  env:\n    BOT_TOKEN: forbidden\n");
  await assert.rejects(discoverAgentProfiles(root));
});

test("rejects missing or malformed workflow and image, traversal, and injection", async (t) => {
  const { root, config } = await fixture(t);
  const image = "image: { repository: registry.example/team/name }\n";
  for (const yaml of [
    onboarding.replace(/image:[\s\S]*$/, ""),
    image,
    `workflow: onboarding\nworkflow: onboarding\n${image}`,
    `workflow: [onboarding\n${image}`,
    ...["../onboarding", "./../outside", "./x/../../outside", "onboarding/../../outside", "/tmp/x", "onboarding;echo", "./x/$HOME"].map((wf) => `workflow: '${wf}'\n${image}`),
    ...["../x", "registry.example/team/../name", "registry.example/team/name:tag", "registry.example/team/$(id)", "https://registry.example/team/name", "Registry.example/team/name", "registry.example:99999/team/name"].map((repo) => `workflow: onboarding\nimage: { repository: '${repo}' }\n`),
    ...["", "../bad", "v1;id", "$(id)", ".bad"].map((tag) => `workflow: onboarding\nimage: { repository: registry.example/team/name, tag: '${tag}' }\n`),
    "workflow: onboarding\nimage: { repository: registry.example/team/name, tags: latest }\n",
    "workflow: onboarding\nimage: { repository: registry.example/team/name, tag: null }\n",
  ]) {
    await writeFile(config, yaml);
    await assert.rejects(discoverAgentProfiles(root), undefined, yaml);
  }
});

test("fails closed for absent workflow, submodule, Python dependencies, and incomplete second profile", async (t) => {
  const f = await fixture(t);
  await writeFile(f.config, onboarding.replace("workflow: onboarding", "workflow: missing"));
  await assert.rejects(discoverAgentProfiles(f.root));
  await writeFile(f.config, onboarding);
  const second = join(f.root, "instance", "second", "agent");
  await mkdir(second, { recursive: true });
  await assert.rejects(discoverAgentProfiles(f.root));
  await writeFile(join(second, "instance.yaml"), "workflow: onboarding\n");
  await assert.rejects(discoverAgentProfiles(f.root));
  await rm(second, { recursive: true });
  await rm(join(f.bot, ".claude", "skills"), { recursive: true });
  await assert.rejects(discoverAgentProfiles(f.root));
  await rm(f.bot, { recursive: true });
  await assert.rejects(discoverAgentProfiles(f.root));
});

test("rejects symlink escapes for checkout paths, config, workflows and scripts", async (t) => {
  const f = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "agent-profiles-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "instance.yaml"), await readFile(f.config));
  await rm(f.config);
  await symlink(join(outside, "instance.yaml"), f.config);
  await assert.rejects(discoverAgentProfiles(f.root));
  await rm(f.config);
  await writeFile(f.config, onboarding.replace("workflow: onboarding", "workflow: ./custom"));
  await symlink(outside, join(f.agent, "custom"));
  await assert.rejects(discoverAgentProfiles(f.root));
  await rm(join(f.agent, "custom"));
  await writeFile(f.config, onboarding);
  const script = join(f.bot, "presets", "workflows", "onboarding", "preflight", "01-work.py");
  await rm(script);
  await writeFile(join(outside, "script.py"), "pass\n");
  await symlink(join(outside, "script.py"), script);
  await assert.rejects(discoverAgentProfiles(f.root));
  await rm(script);
  await symlink(outside, join(f.agent, "preflight"));
  await assert.rejects(discoverAgentProfiles(f.root));
  await rm(join(f.agent, "preflight"));
  const shared = join(f.bot, "presets", "shared", "preflight");
  await rm(shared, { recursive: true });
  await symlink(outside, shared);
  await assert.rejects(discoverAgentProfiles(f.root));
  await rm(f.bot, { recursive: true });
  await symlink(outside, f.bot);
  await assert.rejects(discoverAgentProfiles(f.root));
});
