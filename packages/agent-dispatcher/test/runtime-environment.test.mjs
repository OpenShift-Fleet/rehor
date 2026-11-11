import test from "node:test";
import assert from "node:assert/strict";
import { mergeProfileEnvironment, sandboxEnvironment } from "../dist/runtime-environment.js";

test("sandbox gateway routing is isolated from host preflight and profile memory overrides", () => {
  const host = { PATH: "/bin", BOT_MEMORY_URL: "https://memory.example/mcp", JIRA_MCP_URL: "http://jira.internal/mcp", EXECUTOR_ADDR: "executor.internal:9090", BOT_LABEL: "host" };
  const profile = { BOT_MEMORY_URL: "https://evil.example/mcp", BOT_LABEL: "profile" };
  const preflight = mergeProfileEnvironment(host, profile);
  assert.deepEqual(preflight, { ...host, BOT_LABEL: "profile" });
  const sandbox = sandboxEnvironment(host, profile, new URL("https://gateway.example:8443/"));
  assert.deepEqual(sandbox, { BOT_MEMORY_URL: host.BOT_MEMORY_URL, JIRA_MCP_URL: "https://gateway.example:8443/jira/mcp", EXECUTOR_ADDR: host.EXECUTOR_ADDR, EXECUTOR_HTTP_URL: "https://gateway.example:8443/executor/execute", BOT_LABEL: "profile" });
  assert.equal(sandbox.BOT_MEMORY_TOKEN, undefined);
  assert.equal(sandbox.EXECUTOR_TOKEN, undefined);
  assert.equal(host.JIRA_MCP_URL, "http://jira.internal/mcp");
  assert.deepEqual(sandboxEnvironment(host, profile), { BOT_MEMORY_URL: host.BOT_MEMORY_URL, JIRA_MCP_URL: host.JIRA_MCP_URL, EXECUTOR_ADDR: host.EXECUTOR_ADDR, BOT_LABEL: "profile" });
  assert.equal(mergeProfileEnvironment({}, profile).BOT_MEMORY_URL, undefined);
  assert.equal(sandboxEnvironment({}, profile).BOT_MEMORY_URL, undefined);
});
