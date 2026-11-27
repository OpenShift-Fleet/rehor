import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgentProfiles } from "../dist/agent-profiles.js";
import { PreflightConfigurationError } from "../dist/preflight-diagnostics.js";
import { mergeProfileEnvironment, sandboxEnvironment } from "../dist/runtime-environment.js";

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
    sandboxEnv: {},
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
  await writeFile(config, "workflow: onboarding\nimage: {repository: registry.example/team/name}\npreflight:\n  env:\n    BOT_PASSWORD: forbidden\n");
  await assert.rejects(discoverAgentProfiles(root));
});

test("top-level env supplies preflight identity and sandbox runtime", async (t) => {
  const { root, config } = await fixture(t);
  await writeFile(config, `workflow: onboarding
image: {repository: registry.example/team/name}
env:
  BOT_INSTANCE_ID: test-agent
  BOT_LABEL: test-label
  BOT_IMPLEMENTATION_LABEL: implementation-bot
  BOT_TEAM_FIELD_ID: customfield_10001
  BOT_EXECUTION_ENGINE: coordinator
  BOT_MEMORY_URL: https://untrusted.example/mcp
`);
  const [profile] = await discoverAgentProfiles(root);
  const host = { BOT_INSTANCE_ID: "host-agent", BOT_MEMORY_URL: "https://memory.example/mcp" };
  const expected = { BOT_INSTANCE_ID: "test-agent", BOT_LABEL: "test-label", BOT_IMPLEMENTATION_LABEL: "implementation-bot", BOT_TEAM_FIELD_ID: "customfield_10001", BOT_EXECUTION_ENGINE: "coordinator", BOT_MEMORY_URL: host.BOT_MEMORY_URL };
  assert.deepEqual(mergeProfileEnvironment(host, profile.preflightEnv), expected);
  assert.deepEqual(sandboxEnvironment(host, profile.preflightEnv), expected);
});

test("top-level and legacy environment forms cannot be combined", async (t) => {
  const { root, config } = await fixture(t);
  await writeFile(config, `workflow: onboarding
image: {repository: registry.example/team/name}
env: {BOT_INSTANCE_ID: test-agent}
preflight: {env: {BOT_INSTANCE_ID: test-agent}}
`);
  await assert.rejects(discoverAgentProfiles(root), /either env or preflight\.env/);
});

test("legacy preflight.env and top-level env produce the same settings unit", async (t) => {
  const { root, config } = await fixture(t);
  await writeFile(config, "workflow: onboarding\nimage: {repository: registry.example/team/name}\npreflight:\n  env:\n    BOT_LABEL: team-label\n    BOT_MAX_PRS: '5'\n");
  const legacy = (await discoverAgentProfiles(root))[0].preflightEnv;
  await writeFile(config, "workflow: onboarding\nimage: {repository: registry.example/team/name}\nenv:\n  BOT_LABEL: team-label\n  BOT_MAX_PRS: '5'\n");
  const topLevel = (await discoverAgentProfiles(root))[0].preflightEnv;
  assert.deepEqual(legacy, topLevel);
  assert.deepEqual(legacy, { BOT_LABEL: "team-label", BOT_MAX_PRS: "5" });
});

test("top-level env fails closed for secrets, operational settings and malformed values", async (t) => {
  const { root, config } = await fixture(t);
  const base = "workflow: onboarding\nimage: {repository: registry.example/team/name}\n";
  for (const entry of [
    "env: null", "env: []", "env: string", "env: {BOT_LABEL: 5}",
    'env: {BOT_LABEL: ""}', "env: {BOT_TOKEN: forbidden}", "env: {BOT_API_KEY: forbidden}",
    "env: {HTTP_PROXY: attacker}", "env: {JIRA_MCP_URL: attacker}",
    "env: {EXECUTOR_ADDR: attacker}", "env: {REHOR_INPUT_SOURCE: attacker}",
  ]) {
    await writeFile(config, `${base}${entry}\n`);
    await assert.rejects(discoverAgentProfiles(root), undefined, entry);
  }
});

test("instance preflight settings cannot override operational environment", async (t) => {
  const { root, config } = await fixture(t);
  for (const name of ["PATH", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "JIRA_MCP_URL", "EXECUTOR_ADDR"]) {
    await writeFile(config, `workflow: onboarding\nimage: {repository: registry.example/team/name}\npreflight:\n  env:\n    ${name}: attacker-controlled\n`);
    await assert.rejects(discoverAgentProfiles(root), undefined, `instance env must not accept ${name}`);
  }
});

test("reads sandbox env shorthand alongside preflight env in one instance.yaml", async (t) => {
  const { root, config } = await fixture(t);
  await writeFile(config, `workflow: onboarding
image: { repository: registry.example/team/name }
preflight:
  env:
    BOT_INSTANCE_ID: test-agent
    BOT_LABEL: test-label
sandbox:
  env:
    SLACK_WEBHOOK_URL: "\${{ secret('slack-webhook', 'url') }}"
    SOME_STATIC_FLAG: plain value
    BOT_TEAM_TOKEN: "\${{ secret('team', 'token') }}"
`);
  const [profile] = await discoverAgentProfiles(root);
  assert.deepEqual(profile.preflightEnv, { BOT_INSTANCE_ID: "test-agent", BOT_LABEL: "test-label" });
  assert.deepEqual(profile.sandboxEnv, {
    SLACK_WEBHOOK_URL: "${{ secret('slack-webhook', 'url') }}",
    SOME_STATIC_FLAG: "plain value",
    BOT_TEAM_TOKEN: "${{ secret('team', 'token') }}",
  });
});

test("sandbox env rejects operational, runtime-owned, and malformed entries", async (t) => {
  const { root, config } = await fixture(t);
  const image = "image: { repository: registry.example/team/name }\n";
  for (const yaml of [
    "sandbox:\n  env:\n    PATH: /attacker\n",
    "sandbox:\n  env:\n    HOME: /attacker\n",
    "sandbox:\n  env:\n    TMPDIR: /attacker\n",
    "sandbox:\n  env:\n    XDG_CONFIG_HOME: /attacker\n",
    "sandbox:\n  env:\n    JIRA_MCP_URL: https://evil.example\n",
    "sandbox:\n  env:\n    EXECUTOR_ADDR: evil:9090\n",
    "sandbox:\n  env:\n    HTTP_PROXY: http://evil\n",
    "sandbox:\n  env:\n    BOT_LABEL: belongs-in-preflight\n",
    "sandbox:\n  env:\n    BOT_MEMORY_URL: https://evil.example/mcp\n",
    "sandbox:\n  env:\n    REHOR_MODEL_PROXY_URL: https://evil.example/v1\n",
    "sandbox:\n  env:\n    REHOR_INPUT_FILE: /attacker\n",
    "sandbox:\n  env:\n    OPENCODE_CONFIG: /attacker\n",
    "sandbox:\n  env:\n    lowercase: value\n",
    'sandbox:\n  env:\n    EMPTY: ""\n',
    "sandbox:\n  env:\n    NUMBER: 7\n",
    "sandbox:\n  env: [list]\n",
    "sandbox:\n  extra: true\n",
    "sandbox: []\n",
  ]) {
    await writeFile(config, `workflow: onboarding\n${image}${yaml}`);
    await assert.rejects(discoverAgentProfiles(root), undefined, `instance sandbox env must not accept: ${yaml.trim()}`);
  }
  await writeFile(config, `workflow: onboarding\n${image}`);
  assert.deepEqual((await discoverAgentProfiles(root))[0].sandboxEnv, {});
});

test("reads sandbox egress as the sole key and omits it when absent or empty", async (t) => {
  const { root, config } = await fixture(t);
  await writeFile(config, `workflow: onboarding
image: { repository: registry.example/team/name }
sandbox:
  egress:
    - host: downloads.example.com
      port: 443
`);
  const [profile] = await discoverAgentProfiles(root);
  assert.deepEqual(profile.sandboxEnv, {});
  assert.deepEqual(profile.sandboxEgress, [{ host: "downloads.example.com", port: 443 }]);
  await writeFile(config, `workflow: onboarding
image: { repository: registry.example/team/name }
sandbox:
  egress: []
`);
  const [empty] = await discoverAgentProfiles(root);
  assert.deepEqual(empty.sandboxEnv, {});
  assert.equal("sandboxEgress" in empty, false);
  await writeFile(config, onboarding);
  assert.equal("sandboxEgress" in (await discoverAgentProfiles(root))[0], false);
});

test("reads sandbox env and egress together in one declaration", async (t) => {
  const { root, config } = await fixture(t);
  await writeFile(config, `workflow: onboarding
image: { repository: registry.example/team/name }
sandbox:
  env:
    SOME_STATIC_FLAG: plain value
  egress:
    - host: downloads.example.com
      port: 443
`);
  const [profile] = await discoverAgentProfiles(root);
  assert.deepEqual(profile.sandboxEnv, { SOME_STATIC_FLAG: "plain value" });
  assert.deepEqual(profile.sandboxEgress, [{ host: "downloads.example.com", port: 443 }]);
});

test("sandbox egress rejects malformed destinations and raw policy fields", async (t) => {
  const { root, config } = await fixture(t);
  const image = "image: { repository: registry.example/team/name }\n";
  for (const yaml of [
    "sandbox:\n  egress: downloads.example.com\n",
    "sandbox:\n  egress:\n    - host: downloads.example.com\n",
    "sandbox:\n  egress:\n    - host: downloads.example.com\n      port: 8443\n",
    "sandbox:\n  egress:\n    - host: downloads.example.com\n      port: 80\n",
    "sandbox:\n  egress:\n    - host: downloads.example.com\n      port: 443\n      protocol: https\n",
    "sandbox:\n  egress:\n    - host: downloads.example.com\n      port: 443\n      tls: SKIP\n",
    "sandbox:\n  egress:\n    - host: downloads.example.com\n      port: 443\n      enforcement: ENFORCE\n",
    "sandbox:\n  egress:\n    - host: downloads.example.com\n      port: 443\n    - host: downloads.example.com\n      port: 443\n",
    "sandbox:\n  egress:\n    - host: 192.0.2.1\n      port: 443\n",
    "sandbox:\n  egress:\n    - host: localhost\n      port: 443\n",
    "sandbox:\n  egress: null\n",
    "sandbox:\n  egress:\n    - null\n",
    "sandbox:\n  env:\n    SOME_STATIC_FLAG: plain value\n  egress:\n    - host: downloads.example.com\n      port: 80\n",
  ]) {
    await writeFile(config, `workflow: onboarding\n${image}${yaml}`);
    await assert.rejects(discoverAgentProfiles(root), undefined, `instance sandbox egress must not accept: ${yaml.trim()}`);
  }
});

test("sandbox shape still rejects empty, null, raw policy, and unknown keys", async (t) => {
  const { root, config } = await fixture(t);
  const image = "image: { repository: registry.example/team/name }\n";
  for (const yaml of [
    "sandbox: {}\n",
    "sandbox:\n",
    "sandbox: null\n",
    "sandbox:\n  policy:\n    networkPolicies: {}\n",
    "sandbox:\n  egress:\n    - host: downloads.example.com\n      port: 443\n  policy: true\n",
    "sandbox:\n  env:\n    SOME_STATIC_FLAG: plain value\n  extra: true\n",
  ]) {
    await writeFile(config, `workflow: onboarding\n${image}${yaml}`);
    await assert.rejects(discoverAgentProfiles(root), undefined, `instance sandbox must not accept: ${yaml.trim()}`);
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

test("parses a declared schedule and omits the key when absent", async (t) => {
  const { root, realRoot, config } = await fixture(t);
  await writeFile(config, `workflow: onboarding
image: { repository: registry.example/team/name }
schedule:
  triggers:
    - timezone: Europe/Prague
      start: "0 8 * * 1-5"
      end: "0 18 * * 1-5"
    - timezone: UTC
      start: "0 22 * * *"
      end: "0 6 * * *"
`);
  const [profile] = await discoverAgentProfiles(root);
  const agent = join(realRoot, "instance", "rehor-onboarding-config", "agent");
  const bot = join(realRoot, "dev-bot");
  assert.deepEqual(profile, {
    name: "rehor-onboarding-config", configPath: join(agent, "instance.yaml"),
    botRoot: bot, instanceDir: agent, workflow: "onboarding",
    workflowDir: join(bot, "presets", "workflows", "onboarding"),
    image: { repository: "registry.example/team/name", tag: "latest", reference: "registry.example/team/name:latest" },
    preflightEnv: {},
    sandboxEnv: {},
    schedule: {
      triggers: [
        { timezone: "Europe/Prague", start: "0 8 * * 1-5", end: "0 18 * * 1-5" },
        { timezone: "UTC", start: "0 22 * * *", end: "0 6 * * *" },
      ],
    },
  });
  await writeFile(config, onboarding);
  assert.equal("schedule" in (await discoverAgentProfiles(root))[0], false);
});

test("malformed schedules fail discovery instead of being silently dropped", async (t) => {
  const { root, config } = await fixture(t);
  const image = "image: { repository: registry.example/team/name }\n";
  for (const yaml of [
    `workflow: onboarding\n${image}schedule: 7\n`,
    `workflow: onboarding\n${image}schedule:\n`,
    `workflow: onboarding\n${image}schedule: { triggers: [] }\n`,
    `workflow: onboarding\n${image}schedule:\n  triggers: 7\n`,
    `workflow: onboarding\n${image}schedule:\n  triggers:\n    - 42\n`,
    `workflow: onboarding\n${image}schedule:\n  triggers:\n    - timezone: Europe/Prague\n`,
    `workflow: onboarding\n${image}schedule:\n  triggers:\n    - timezone: Europe/Prague\n      start: "0 8 * * *"\n`,
    `workflow: onboarding\n${image}schedule:\n  triggers:\n    - timezone: 5\n      start: "0 8 * * *"\n      end: "0 18 * * *"\n`,
    `workflow: onboarding\n${image}schedule:\n  triggers:\n    - timezone: Europe/Prague\n      start: "0 8 * * *"\n      end: "0 8 * * *"\n`,
    `workflow: onboarding\n${image}schedule:\n  triggers:\n    - timezone: Europe/Prague\n      start: "0 8 * * *"\n      end: "0 18 * * *"\n      desiredReplicas: 1\n`,
    `workflow: onboarding\n${image}schedule:\n  desiredReplicas: 1\n  triggers:\n    - timezone: Europe/Prague\n      start: "0 8 * * *"\n      end: "0 18 * * *"\n`,
    `workflow: onboarding\n${image}schedule:\n  triggers:\n    - timezone: Not/AZone\n      start: "0 8 * * *"\n      end: "0 18 * * *"\n`,
    `workflow: onboarding\n${image}schedule:\n  triggers:\n    - timezone: Europe/Prague\n      start: "61 8 * * *"\n      end: "0 18 * * *"\n`,
    `workflow: onboarding\n${image}schedule:\n  triggers:\n    - timezone: Europe/Prague\n      start: "* * * * * *"\n      end: "0 18 * * *"\n`,
    `workflow: onboarding\n${image}schedule:\n  triggers:\n    - timezone: Europe/Prague\n      start: "0 8 * *"\n      end: "0 18 * * *"\n`,
  ]) {
    await writeFile(config, yaml);
    await assert.rejects(discoverAgentProfiles(root), undefined, yaml);
  }
});

test("malformed schedules throw a typed configuration failure with diagnostics", async (t) => {
  const { root, config } = await fixture(t);
  const image = "image: { repository: registry.example/team/name }\n";
  const cases = [
    [`workflow: onboarding\n${image}schedule: 7\n`, "rehor-onboarding-config: schedule: Invalid input: expected object with a triggers list (got 7)", [
      { path: "schedule", code: "invalid_type", message: "Invalid input: expected object with a triggers list", received: "7" },
    ]],
    [`workflow: onboarding\n${image}schedule: { triggers: [] }\n`, "rehor-onboarding-config: schedule.triggers: Too small: expected array to have >=1 items (got array (0 items))", [
      { path: "schedule.triggers", code: "too_small", message: "Too small: expected array to have >=1 items", received: "array (0 items)" },
    ]],
    [`workflow: onboarding\n${image}schedule:\n  triggers:\n    - timezone: Europe/Prague\n      start: "0 8 * * *"\n      end: "0 8 * * *"\n`, 'rehor-onboarding-config: schedule.triggers[0]: Invalid input: start and end must differ (got "0 8 * * *")', [
      { path: "schedule.triggers[0]", code: "custom", message: "Invalid input: start and end must differ", received: '"0 8 * * *"' },
    ]],
    [`workflow: onboarding\n${image}schedule:\n  triggers:\n    - timezone: Not/AZone\n      start: "0 8 * * *"\n      end: "0 18 * * *"\n`, 'rehor-onboarding-config: schedule.triggers[0].timezone: Invalid timezone (got "Not/AZone")', [
      { path: "schedule.triggers[0].timezone", code: "custom", message: "Invalid timezone", received: '"Not/AZone"' },
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
