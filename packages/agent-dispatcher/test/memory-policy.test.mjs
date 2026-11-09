import test from "node:test";
import assert from "node:assert/strict";
import { NetworkEnforcementMode, NetworkTlsMode } from "@nvidia/openshell-sdk/raw";
import { createMemoryPolicy } from "../dist/memory-policy.js";

const memoryUrl = () => new URL("https://memory.example.test/health");
const modelProxyUrl = () => new URL("https://model-gateway.example.test/v1");

test("policy without a model proxy URL stays memory-health only", () => {
  const policy = createMemoryPolicy(memoryUrl(), "provider-name-1");
  assert.deepEqual(Object.keys(policy.networkPolicies), ["memory_health"]);
  assert.equal(policy.networkPolicies.model_proxy, undefined);
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
