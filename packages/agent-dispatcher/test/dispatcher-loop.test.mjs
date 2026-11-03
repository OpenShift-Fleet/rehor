import test from "node:test";
import assert from "node:assert/strict";
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
    const env = preflightEnvironment();
    assert.equal(env.BOT_LABEL, "forwarded");
    assert.equal(env.JIRA_MCP_URL, "https://jira.example");
    assert.equal(env.EXECUTOR_ADDR, "https://executor.example");
    assert.equal(env.HTTP_PROXY, "http://proxy.example");
    assert.ok(!("BOT_API_TOKEN" in env));
    assert.ok(!("UNRELATED_VARIABLE" in env));
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(original)) process.env[key] = value;
  }
});
