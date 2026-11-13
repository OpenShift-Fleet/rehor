import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgentProfiles } from "../dist/agent-profiles.js";
import { PreflightConfigurationError } from "../dist/preflight-diagnostics.js";

// Existing onboarding profile, plus the required image field.
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
    mkdir(join(bot, "presets", "workflows", "onboarding"), { recursive: true }),
  ]);
  await writeFile(join(agent, "instance.yaml"), onboarding);
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
    image: { repository: "registry.example/team/name", tag: "latest", reference: "registry.example/team/name:latest" },
    preflightEnv: {},
  });
  assert.equal("preflights" in profile, false);
});

test("maps multiple agents, explicit image tag and safe remote-relative workflow", async (t) => {
  const { root, agent, realRoot } = await fixture(t);
  const second = join(root, "instance", "second", "agent");
  await mkdir(join(second, "custom", "workflow"), { recursive: true });
  await writeFile(join(second, "instance.yaml"), "workflow: ./custom/workflow\nimage: { repository: 'registry.example:5000/team/name', tag: 'v1.2' }\n");
  const profiles = await discoverAgentProfiles(root);
  assert.deepEqual(profiles.map((p) => p.name), ["rehor-onboarding-config", "second"]);
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

test("instance preflight settings cannot override operational environment", async (t) => {
  const { root, config } = await fixture(t);
  for (const name of ["PATH", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "JIRA_MCP_URL", "EXECUTOR_ADDR"]) {
    await writeFile(config, `workflow: onboarding\nimage: {repository: registry.example/team/name}\npreflight:\n  env:\n    ${name}: attacker-controlled\n`);
    await assert.rejects(discoverAgentProfiles(root), undefined, `instance env must not accept ${name}`);
  }
});

test("parses declared preflights strictly: shorthand, parameterized, empty, omitted", async (t) => {
  const { root, config } = await fixture(t);
  await writeFile(config, `workflow: onboarding
image: { repository: registry.example/team/name }
preflights:
  - jira-triage
  - id: jira-kanban
    with:
      project: REHOR
      label: rehor-pilot
      statuses: [New, Backlog]
  - gh-pr-status
`);
  const [profile] = await discoverAgentProfiles(root);
  assert.deepEqual(profile.preflights, [
    "jira-triage",
    { id: "jira-kanban", with: { project: "REHOR", label: "rehor-pilot", statuses: ["New", "Backlog"] } },
    "gh-pr-status",
  ]);
  await writeFile(config, "workflow: onboarding\nimage: { repository: registry.example/team/name }\npreflights: []\n");
  assert.deepEqual((await discoverAgentProfiles(root))[0].preflights, []);
  await writeFile(config, onboarding);
  assert.equal("preflights" in (await discoverAgentProfiles(root))[0], false);
});

test("malformed preflights fail discovery instead of being silently dropped", async (t) => {
  const { root, config } = await fixture(t);
  const image = "image: { repository: registry.example/team/name }\n";
  for (const yaml of [
    `workflow: onboarding\n${image}preflights: jira-triage\n`,
    `workflow: onboarding\n${image}preflights: { id: jira-triage }\n`,
    `workflow: onboarding\n${image}preflights:\n  - 42\n`,
    `workflow: onboarding\n${image}preflights:\n  - null\n`,
    `workflow: onboarding\n${image}preflights:\n  - ""\n`,
    `workflow: onboarding\n${image}preflights:\n  - id: ""\n`,
    `workflow: onboarding\n${image}preflights:\n  - id: jira-triage\n    extra: true\n`,
    `workflow: onboarding\n${image}preflights:\n  - id: jira-triage\n    with: 7\n`,
    `workflow: onboarding\n${image}preflights:\n  - id: jira-triage\n    with:\n      label: { nested: object }\n`,
    `workflow: onboarding\n${image}preflights:\n  - id: jira-triage\n    with:\n      label: null\n`,
  ]) {
    await writeFile(config, yaml);
    await assert.rejects(discoverAgentProfiles(root), undefined, yaml);
  }
});

test("malformed preflights name the instance, entry, parameter, and reason", async (t) => {
  const { root, config } = await fixture(t);
  const image = "image: { repository: registry.example/team/name }\n";
  const cases = [
    [`workflow: onboarding\n${image}preflights: jira-triage\n`, 'rehor-onboarding-config: preflights must be a list of preflight entries (got "jira-triage")'],
    [`workflow: onboarding\n${image}preflights: 7\n`, "rehor-onboarding-config: preflights must be a list of preflight entries (got 7)"],
    [`workflow: onboarding\n${image}preflights:\n  - 42\n`, "rehor-onboarding-config: preflights[0]: Invalid input: expected object, received number (got 42)"],
    [`workflow: onboarding\n${image}preflights:\n  - ""\n`, 'rehor-onboarding-config: preflights[0]: Too small: expected string to have >=1 characters (got "")'],
    [`workflow: onboarding\n${image}preflights:\n  - id: 5\n`, "rehor-onboarding-config: preflights[0].id: Invalid input: expected string, received number (got 5)"],
    [`workflow: onboarding\n${image}preflights:\n  - id: x\n    extra: true\n`, 'rehor-onboarding-config: preflights[0]: Unrecognized key: "extra" (got object)'],
    [`workflow: onboarding\n${image}preflights:\n  - id: x\n    with: 7\n`, "rehor-onboarding-config: preflights[0].with: Invalid input: expected record, received number (got 7)"],
    [`workflow: onboarding\n${image}preflights:\n  - id: x\n    with:\n      label: { nested: object }\n`, "rehor-onboarding-config: preflights[0].with.label: Invalid input: expected one of string, number, boolean, array (got object)"],
    // Every failing entry is reported, not just the first.
    [`workflow: onboarding\n${image}preflights:\n  - id: x\n    extra: true\n  - 42\n`, 'rehor-onboarding-config: preflights[0]: Unrecognized key: "extra" (got object)\nrehor-onboarding-config: preflights[1]: Invalid input: expected object, received number (got 42)'],
  ];
  for (const [yaml, message] of cases) {
    await writeFile(config, yaml);
    await assert.rejects(discoverAgentProfiles(root), { message }, yaml);
  }
});

test("malformed preflights throw a typed configuration failure with diagnostics", async (t) => {
  const { root, config } = await fixture(t);
  const image = "image: { repository: registry.example/team/name }\n";
  const cases = [
    [`workflow: onboarding\n${image}preflights:\n  - id: 5\n`, "rehor-onboarding-config: preflights[0].id: Invalid input: expected string, received number (got 5)", [
      { path: "preflights[0].id", code: "invalid_type", message: "Invalid input: expected string, received number", received: "5" },
    ]],
    [`workflow: onboarding\n${image}preflights: 7\n`, "rehor-onboarding-config: preflights must be a list of preflight entries (got 7)", [
      { path: "preflights", code: "invalid_type", message: "preflights must be a list of preflight entries", received: "7" },
    ]],
    [`workflow: onboarding\n${image}preflights:\n  - id: x\n    with:\n      label: { nested: object }\n`, "rehor-onboarding-config: preflights[0].with.label: Invalid input: expected one of string, number, boolean, array (got object)", [
      { path: "preflights[0].with.label", code: "invalid_union", message: "Invalid input: expected one of string, number, boolean, array", received: "object" },
    ]],
  ];
  for (const [yaml, message, diagnostics] of cases) {
    await writeFile(config, yaml);
    await assert.rejects(discoverAgentProfiles(root), (error) => {
      assert.ok(error instanceof PreflightConfigurationError, yaml);
      assert.equal(error.profile, "rehor-onboarding-config");
      assert.equal(error.message, message);
      assert.deepEqual(error.diagnostics, diagnostics);
      return true;
    }, yaml);
  }
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

test("fails closed for absent workflow, missing submodule, and incomplete second profile", async (t) => {
  const f = await fixture(t);
  await writeFile(f.config, onboarding.replace("workflow: onboarding", "workflow: missing"));
  await assert.rejects(discoverAgentProfiles(f.root));
  await writeFile(f.config, onboarding);
  const second = join(f.root, "instance", "second", "agent");
  await mkdir(second, { recursive: true });
  await assert.rejects(discoverAgentProfiles(f.root));
  await writeFile(join(second, "instance.yaml"), "workflow: onboarding\n");
  await assert.rejects(discoverAgentProfiles(f.root));
  await rm(f.bot, { recursive: true });
  await assert.rejects(discoverAgentProfiles(f.root));
});

test("rejects symlink escapes for checkout paths, config, and workflows", async (t) => {
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
  const workflow = join(f.bot, "presets", "workflows", "onboarding");
  await rm(workflow, { recursive: true });
  await symlink(join(outside, "workflow"), workflow);
  await assert.rejects(discoverAgentProfiles(f.root));
  await rm(f.bot, { recursive: true });
  await symlink(outside, f.bot);
  await assert.rejects(discoverAgentProfiles(f.root));
});
