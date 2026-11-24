import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { preflightEnvironment, runDispatcherLoop } from "../dist/dispatcher-loop.js";

test("loop runs a cycle immediately, reports invalid configuration, and stops on abort", async () => {
  const cycles = [];
  const controller = new AbortController();
  const finished = runDispatcherLoop({
    repositoriesJson: "not-json",
    signal: controller.signal,
    onCycle: (result) => {
      cycles.push(result);
      controller.abort();
    },
  });
  await finished;
  assert.deepEqual(cycles, [{ status: "invalid-config", repositories: [] }]);
});

test("preflight environment forwards only permitted non-secret variables", () => {
  const original = { ...process.env };
  try {
    process.env.BOT_LABEL = "forwarded";
    process.env.BOT_API_TOKEN = "secret-token";
    process.env.JIRA_MCP_URL = "https://jira.example";
    process.env.EXECUTOR_ADDR = "https://executor.example";
    process.env.HTTP_PROXY = "http://proxy.example";
    process.env.UNRELATED_VARIABLE = "blocked";
    for (const name of ["GH_USER_NAME", "GH_USER_EMAIL", "GL_USER_NAME", "GL_USER_EMAIL"]) process.env[name] = name;
    for (const name of ["GH_TOKEN", "GL_USER_EMAIL_SECRET", "GPG_PRIVATE_KEY_B64", "GH_GPG_SIGNING_KEY"]) process.env[name] = "blocked";
    const env = preflightEnvironment();
    assert.equal(env.BOT_LABEL, "forwarded");
    assert.equal(env.JIRA_MCP_URL, "https://jira.example");
    assert.equal(env.EXECUTOR_ADDR, "https://executor.example");
    assert.equal(env.HTTP_PROXY, "http://proxy.example");
    assert.ok(!("BOT_API_TOKEN" in env));
    assert.ok(!("UNRELATED_VARIABLE" in env));
    for (const name of ["GH_USER_NAME", "GH_USER_EMAIL", "GL_USER_NAME", "GL_USER_EMAIL"]) assert.equal(env[name], name);
    for (const name of ["GH_TOKEN", "GL_USER_EMAIL_SECRET", "GPG_PRIVATE_KEY_B64", "GH_GPG_SIGNING_KEY"]) assert.ok(!(name in env));
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(original)) process.env[key] = value;
  }
});

test("dispatcher template uses legacy platform identity secret keys only", () => {
  const template = parse(readFileSync(new URL("../../../deploy/agent-dispatcher-template.yaml", import.meta.url), "utf8"));
  const deployment = template.objects.find((object) => object.kind === "Deployment");
  const env = deployment.spec.template.spec.containers[0].env;
  for (const [name, key] of Object.entries({
    GH_USER_NAME: "bot-gh-username", GH_USER_EMAIL: "bot-email", GL_USER_NAME: "bot-gl-name", GL_USER_EMAIL: "bot-gl-email",
  })) {
    assert.deepEqual(env.find((entry) => entry.name === name).valueFrom.secretKeyRef, { name: "devbot-secrets", key });
  }
});
