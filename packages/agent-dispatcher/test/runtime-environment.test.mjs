import test from "node:test";
import assert from "node:assert/strict";
import { mergeProfileEnvironment, sandboxEnvironment } from "../dist/runtime-environment.js";

test("sandbox gateway routing is isolated from host preflight and profile memory overrides", () => {
  const host = { PATH: "/bin", BOT_MEMORY_URL: "https://memory.example/mcp", JIRA_MCP_URL: "http://jira.internal/mcp", EXECUTOR_ADDR: "executor.internal:9090", BOT_LABEL: "host" };
  const profile = { BOT_MEMORY_URL: "https://evil.example/mcp", BOT_LABEL: "profile" };
  const preflight = mergeProfileEnvironment(host, profile);
  assert.deepEqual(preflight, { ...host, BOT_LABEL: "profile" });
  const sandbox = sandboxEnvironment(host, profile, new URL("https://gateway.example:8443/"));
  assert.deepEqual(sandbox, { BOT_MEMORY_URL: host.BOT_MEMORY_URL, JIRA_MCP_URL: "https://gateway.example:8443/jira/mcp", EXECUTOR_ADDR: host.EXECUTOR_ADDR, EXECUTOR_HTTP_URL: "https://gateway.example:8443/executor/execute", GH_RELEASE_UPLOAD_URL: "https://gateway.example:8443/screenshots/upload", BOT_LABEL: "profile" });
  assert.equal(sandbox.BOT_MEMORY_TOKEN, undefined);
  assert.equal(sandbox.EXECUTOR_TOKEN, undefined);
  assert.equal(host.JIRA_MCP_URL, "http://jira.internal/mcp");
  assert.deepEqual(sandboxEnvironment(host, profile), { BOT_MEMORY_URL: host.BOT_MEMORY_URL, JIRA_MCP_URL: host.JIRA_MCP_URL, EXECUTOR_ADDR: host.EXECUTOR_ADDR, BOT_LABEL: "profile" });
  assert.equal(mergeProfileEnvironment({}, profile).BOT_MEMORY_URL, undefined);
  assert.equal(sandboxEnvironment({}, profile).BOT_MEMORY_URL, undefined);
});

test("rendered instance sandbox env is delivered under deployment-owned coordinates", () => {
  const host = { PATH: "/bin", BOT_MEMORY_URL: "https://memory.example/mcp", BOT_LABEL: "host" };
  const profile = { BOT_LABEL: "profile" };
  const sandboxEnv = { SLACK_WEBHOOK_URL: "https://hooks.example/XYZ", SOME_STATIC_FLAG: "plain" };
  const gateway = new URL("https://gateway.example:8443/");
  const modelProxy = new URL("https://model.example/v1");
  const sandbox = sandboxEnvironment(host, profile, gateway, modelProxy, sandboxEnv);
  assert.equal(sandbox.SLACK_WEBHOOK_URL, "https://hooks.example/XYZ");
  assert.equal(sandbox.SOME_STATIC_FLAG, "plain");
  assert.equal(sandbox.BOT_MEMORY_URL, host.BOT_MEMORY_URL);
  assert.equal(sandbox.PATH, undefined);
  assert.deepEqual(sandboxEnvironment(host, profile, undefined, undefined, sandboxEnv), {
    BOT_MEMORY_URL: host.BOT_MEMORY_URL,
    BOT_LABEL: "profile",
    SLACK_WEBHOOK_URL: "https://hooks.example/XYZ",
    SOME_STATIC_FLAG: "plain",
  });
  // Deployment-owned service coordinates are assigned after the instance
  // merge, so a hostile sandboxEnv value cannot redirect them even if name
  // validation were bypassed.
  const hostile = sandboxEnvironment(host, profile, gateway, modelProxy, {
    REHOR_MODEL_PROXY_URL: "https://evil.example/v1",
    JIRA_MCP_URL: "https://evil.example/mcp",
    EXECUTOR_HTTP_URL: "https://evil.example/executor/execute",
  });
  assert.equal(hostile.REHOR_MODEL_PROXY_URL, "https://model.example/v1");
  assert.equal(hostile.JIRA_MCP_URL, "https://gateway.example:8443/jira/mcp");
  assert.equal(hostile.EXECUTOR_HTTP_URL, "https://gateway.example:8443/executor/execute");
});
