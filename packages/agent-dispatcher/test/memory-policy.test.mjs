import test from "node:test";
import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { NetworkEnforcementMode, NetworkTlsMode, SandboxPolicySchema } from "@nvidia/openshell-sdk/raw";
import { createMemoryPolicy } from "../dist/memory-policy.js";

const memoryUrl = () => new URL("https://memory.example.test/health");
const modelProxyUrl = () => new URL("https://model-gateway.example.test/v1");
const serviceGatewayUrl = () => new URL("https://service-gateway.example.test:8454");

test("policy without a model proxy URL stays memory-health only", () => {
  const policy = createMemoryPolicy(memoryUrl(), "provider-name-1");
  assert.deepEqual(Object.keys(policy.networkPolicies), ["memory_health"]);
  assert.equal(policy.networkPolicies.model_proxy, undefined);
  assert.equal(policy.networkPolicies.service_gateway_git, undefined);
});

test("policy with a model proxy URL adds the exact model-proxy rule", () => {
  const policy = createMemoryPolicy(memoryUrl(), "provider-name-1", { kind: "legacy" }, modelProxyUrl());
  assert.deepEqual(Object.keys(policy.networkPolicies), ["memory_health", "model_proxy"]);
  assert.deepEqual(policy.networkPolicies.model_proxy, {
    name: "model-proxy",
    endpoints: [{
      host: "model-gateway.example.test",
      port: 443,
      protocol: "rest",
      tls: NetworkTlsMode.UNSPECIFIED,
      enforcement: NetworkEnforcementMode.ENFORCE,
      path: "/v1/**",
      rules: [
        { allow: { method: "GET", path: "/v1/models" } },
        { allow: { method: "POST", path: "/v1/chat/completions" } },
        { allow: { method: "POST", path: "/v1/responses" } },
      ],
      credentialBinding: { provider: "provider-name-1" },
    }],
    binaries: [{ path: "/opt/opencode/bin/opencode" }, { path: "/usr/local/bin/node" }],
  });
  const memory = policy.networkPolicies.memory_health;
  assert.equal(memory.name, "memory-health");
  assert.deepEqual(memory.endpoints[0].rules, [{ allow: { method: "GET", path: "/health" } }]);
  assert.deepEqual(memory.binaries, [{ path: "/usr/bin/python3.12" }]);
});

test("model proxy endpoint keeps an explicit port and the same provider binding", () => {
  const policy = createMemoryPolicy(memoryUrl(), "provider-name-1", { kind: "legacy" }, new URL("https://model-gateway.example.test:8452/v1"));
  assert.equal(policy.networkPolicies.model_proxy.endpoints[0].port, 8452);
  assert.deepEqual(policy.networkPolicies.model_proxy.endpoints[0].credentialBinding, { provider: "provider-name-1" });
});

test("invalid model proxy URLs fail closed like memory URLs", () => {
  for (const value of [
    "http://model-gateway.example.test/v1",
    "https://model-gateway.example.test",
    "https://model-gateway.example.test/",
    "https://model-gateway.example.test/v1/",
    "https://model-gateway.example.test/api",
    "https://user:pass@model-gateway.example.test/v1",
    "https://model-gateway.example.test/v1?model=x",
    "https://model-gateway.example.test/v1#section",
    "https://model-gateway.example.test/v1?",
    "https://model-gateway.example.test/v1#",
    "https://model-gateway.example.test/v1?#",
    "https://model_gateway.example.test/v1",
  ]) {
    assert.throws(
      () => createMemoryPolicy(memoryUrl(), "provider-name-1", { kind: "legacy" }, new URL(value)),
      { message: "Invalid model proxy policy configuration" },
      value,
    );
  }
});

test("memory URL validation is still enforced with a model proxy URL", () => {  for (const value of [
    "http://memory.example.test/health",
    "https://memory.example.test/",
    "https://memory.example.test/other",
    "https://user:pass@memory.example.test/health",
    "https://memory.example.test/health?query=x",
  ]) {
    assert.throws(
      () => createMemoryPolicy(new URL(value), "provider-name-1", { kind: "legacy" }, modelProxyUrl()),
      { message: "Invalid memory policy configuration" },
      value,
    );
  }
});

test("empty options preserve default policies and filesystem layouts exactly", () => {
  for (const runtime of [{ kind: "legacy" }, { kind: "private", source: "/opt/rehor/runtime", parent: "/tmp/runtime" }]) {
    for (const model of [undefined, modelProxyUrl()]) {
      const original = createMemoryPolicy(memoryUrl(), "provider-name-1", runtime, model);
      assert.deepEqual(createMemoryPolicy(memoryUrl(), "provider-name-1", runtime, model, {}), original);
      assert.deepEqual(createMemoryPolicy(memoryUrl(), "provider-name-1", runtime, model, { memoryRuntime: false }), original);
    }
  }
});

test("runtime services use exact paths, methods, binaries, origins and provider binding", () => {
  const policy = createMemoryPolicy(new URL("https://memory.example.test:8443/health"), "provider-name-1", { kind: "legacy" }, modelProxyUrl(), {
    memoryRuntime: true, serviceGatewayUrl: serviceGatewayUrl(),
  });
  assert.deepEqual(Object.keys(policy.networkPolicies), ["memory_health", "memory_runtime", "service_gateway_jira", "service_gateway_executor", "service_gateway_git", "model_proxy"]);
  const expected = {
    memory_runtime: {
      host: "memory.example.test", port: 8443,
      binaries: ["/usr/bin/python3.12", "/usr/local/bin/node", "/opt/opencode/bin/opencode"],
      routes: { "/mcp": ["GET", "POST", "DELETE"], "/api/tasks": ["GET"], "/api/bot-status": ["POST"], "/api/costs": ["POST"], "/api/cycle-runs": ["POST"] },
    },
    service_gateway_jira: {
      host: "service-gateway.example.test", port: 8454,
      binaries: ["/usr/bin/python3.12", "/usr/local/bin/node", "/opt/opencode/bin/opencode"],
      routes: { "/jira/mcp": ["GET", "POST", "DELETE"] },
    },
    service_gateway_executor: {
      host: "service-gateway.example.test", port: 8454,
      binaries: ["/usr/local/bin/executor-client", "/usr/local/bin/gh", "/usr/local/bin/glab", "/usr/local/bin/gpg"],
      routes: { "/executor/execute": ["POST"] },
    },
    service_gateway_git: {
      host: "service-gateway.example.test", port: 8454,
      binaries: ["/usr/libexec/git-core/git-remote-https", "/usr/libexec/git-core/git-remote-http"],
      routes: { "/git/**": ["GET", "POST"] },
    },
  };
  for (const [name, spec] of Object.entries(expected)) {
    const rule = policy.networkPolicies[name];
    assert.deepEqual(rule.binaries, spec.binaries.map((path) => ({ path })));
    assert.equal(rule.endpoints.length, Object.keys(spec.routes).length);
    for (const endpoint of rule.endpoints) {
      assert.equal(endpoint.host, spec.host);
      assert.equal(endpoint.port, spec.port);
      assert.equal(endpoint.protocol, "rest");
      assert.equal(endpoint.tls, NetworkTlsMode.UNSPECIFIED);
      assert.equal(endpoint.enforcement, NetworkEnforcementMode.ENFORCE);
      assert.deepEqual(endpoint.credentialBinding, { provider: "provider-name-1" });
      assert.ok(Object.hasOwn(spec.routes, endpoint.path), `unexpected path ${endpoint.path}`);
      assert.deepEqual(endpoint.rules, spec.routes[endpoint.path].map((method) => ({ allow: { method, path: endpoint.path } })));
    }
  }
  assert.deepEqual(policy.networkPolicies.memory_health.endpoints[0].rules, [{ allow: { method: "GET", path: "/health" } }]);
});

test("runtime options are independent and reject non-admitted methods and paths", () => {
  const options = [{ memoryRuntime: true }, { serviceGatewayUrl: serviceGatewayUrl() }];
  for (const option of options) {
    const policy = createMemoryPolicy(memoryUrl(), "provider-name-1", undefined, undefined, option);
    const keys = Object.keys(policy.networkPolicies);
    assert.equal(keys.includes("memory_runtime"), option.memoryRuntime === true);
    assert.equal(keys.includes("service_gateway_jira"), option.serviceGatewayUrl !== undefined);
    assert.equal(keys.includes("service_gateway_executor"), option.serviceGatewayUrl !== undefined);
    assert.equal(keys.includes("service_gateway_git"), option.serviceGatewayUrl !== undefined);
  }
  const policy = createMemoryPolicy(memoryUrl(), "provider-name-1", undefined, undefined, { memoryRuntime: true, serviceGatewayUrl: serviceGatewayUrl() });
  const admits = (name, method, path) => policy.networkPolicies[name].endpoints.some((endpoint) =>
    endpoint.path === path && endpoint.rules.some((rule) => rule.allow.method === method && rule.allow.path === path));
  for (const [name, method, path] of [
    ["memory_runtime", "PUT", "/mcp"], ["memory_runtime", "POST", "/mcp/extra"],
    ["memory_runtime", "POST", "/api/tasks"], ["memory_runtime", "GET", "/api/costs"],
    ["memory_runtime", "PATCH", "/api/instances/one/idle"], ["memory_runtime", "GET", "/api/tasks/one"],
    ["service_gateway_jira", "PUT", "/jira/mcp"], ["service_gateway_jira", "POST", "/jira/mcp/extra"],
    ["service_gateway_executor", "GET", "/executor/execute"], ["service_gateway_executor", "DELETE", "/executor/execute"],
    ["service_gateway_executor", "POST", "/executor/execute/extra"], ["service_gateway_executor", "POST", "/jira/mcp"],
  ]) assert.equal(admits(name, method, path), false, `${name} must reject ${method} ${path}`);
});

test("effective-policy comparison retains every opted-in credential-bound endpoint", () => {
  const policy = createMemoryPolicy(memoryUrl(), "provider-name-1", undefined, undefined, { memoryRuntime: true, serviceGatewayUrl: serviceGatewayUrl() });
  const expected = create(SandboxPolicySchema, policy);
  for (const [name, count] of [["memory_health", 1], ["memory_runtime", 5], ["service_gateway_jira", 1], ["service_gateway_executor", 1], ["service_gateway_git", 1]]) {
    assert.equal(expected.networkPolicies[name].endpoints.length, count);
    for (const endpoint of expected.networkPolicies[name].endpoints) {
      assert.equal(endpoint.credentialBinding?.provider, "provider-name-1");
      assert.equal(endpoint.providerCredentialed, false);
    }
  }
});

test("Git policy admits only GET and POST under the gateway Git subtree", () => {
  const policy = createMemoryPolicy(memoryUrl(), "provider-name-1", undefined, undefined, { serviceGatewayUrl: new URL("https://gateway.example.test") });
  const git = policy.networkPolicies.service_gateway_git;
  const endpoint = git.endpoints[0];
  assert.equal(endpoint.port, 443);
  // This exercises the declared /git/** contract, not OpenShell's glob engine.
  const admits = (method, path) => endpoint.path === "/git/**" && path.startsWith("/git/")
    && endpoint.rules.some((rule) => rule.allow.path === "/git/**" && rule.allow.method === method);
  for (const [method, path] of [["GET", "/git/github.com/o/r.git/info/refs"], ["POST", "/git/github.com/o/r.git/git-upload-pack"], ["POST", "/git/github.com/o/r.git/git-receive-pack"]]) {
    assert.equal(admits(method, path), true, `${method} ${path}`);
  }
  for (const [method, path] of [["PUT", "/git/github.com/o/r.git"], ["DELETE", "/git/github.com/o/r.git"], ["GET", "/git"], ["GET", "/gitlab/repo"], ["POST", "/executor/execute"], ["GET", "/jira/mcp"], ["POST", "/v1/responses"]]) {
    assert.equal(admits(method, path), false, `${method} ${path}`);
  }
  assert.deepEqual(git.binaries, [{ path: "/usr/libexec/git-core/git-remote-https" }, { path: "/usr/libexec/git-core/git-remote-http" }]);
  for (const binary of ["/usr/bin/git", "/usr/bin/curl", "/usr/local/bin/node", "/usr/libexec/git-core/git-upload-pack"]) {
    assert.equal(git.binaries.some(({ path }) => path === binary), false, binary);
  }
});

test("service gateway accepts only non-colliding HTTPS origins", () => {
  for (const value of [
    "http://gateway.example.test", "https://user:pass@gateway.example.test", "https://gateway.example.test/path",
    "https://gateway.example.test/?query=x", "https://gateway.example.test/#fragment",
    "https://gateway.example.test/?", "https://gateway.example.test/#", "https://gateway_example.test",
    "https://-gateway.example.test", "https://gateway.example.test:0", "https://memory.example.test",
    "https://memory.example.test:443/", "https://model-gateway.example.test",
  ]) {
    assert.throws(() => createMemoryPolicy(memoryUrl(), "provider-name-1", undefined, modelProxyUrl(), { serviceGatewayUrl: new URL(value) }),
      { message: "Invalid service gateway policy configuration" }, value);
  }
  for (const value of ["https://gateway.example.test", "https://gateway.example.test/", "https://memory.example.test:8443"]) {
    assert.doesNotThrow(() => createMemoryPolicy(memoryUrl(), "provider-name-1", undefined, modelProxyUrl(), { serviceGatewayUrl: new URL(value) }), value);
  }
  for (const value of ["https://memory.example.test/health?", "https://memory.example.test/health#"]) {
    assert.throws(() => createMemoryPolicy(new URL(value), "provider-name-1", undefined, undefined, { memoryRuntime: true }),
      { message: "Invalid memory policy configuration" });
  }
});

test("admitted routes cover every default deployment provider request path", async () => {
  const { readFile } = await import("node:fs/promises");
  const config = JSON.parse(
    await readFile(new URL("../../../coordinator/opencode-deployment.default.json", import.meta.url), "utf8"),
  );
  // Request path each OpenCode provider package sends to the model gateway.
  // An unknown package fails this test so a new provider forces a conscious
  // decision about which route the sandbox policy must admit.
  const packageRequestPaths = {
    "@opencode/ai/providers/openai/responses": { method: "POST", path: "/v1/responses" },
    "@opencode/ai/providers/openai-compatible": { method: "POST", path: "/v1/chat/completions" },
  };
  const policy = createMemoryPolicy(memoryUrl(), "provider-name-1", { kind: "legacy" }, modelProxyUrl());
  const allowed = policy.networkPolicies.model_proxy.endpoints[0].rules.map((rule) => rule.allow);
  const gatewayProviders = (config.providers ?? []).filter(
    (provider) => provider.settings?.baseURL === "{env:REHOR_MODEL_PROXY_URL}",
  );
  assert.ok(gatewayProviders.length > 0, "default deployment must declare model-gateway providers");
  for (const provider of gatewayProviders) {
    const expected = packageRequestPaths[provider.package];
    if (!expected) {
      assert.fail(`map provider package '${provider.package}' to its model-gateway request path in this test`);
    }
    assert.ok(
      allowed.some((rule) => rule.method === expected.method && rule.path === expected.path),
      `provider '${provider.id}' sends ${expected.method} ${expected.path}, which the model-proxy rule must admit`,
    );
  }
});
