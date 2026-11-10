import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { NetworkEnforcementMode, NetworkTlsMode } from "@nvidia/openshell-sdk/raw";
import {
  createPublicEgressRule,
  EXCLUDED_SQUID_PORTS,
  GATEWAY_ONLY_DESTINATIONS,
  PUBLIC_EGRESS_DESTINATIONS,
  publicEgressRuleKey,
  withPublicEgress,
} from "../dist/egress-policy.js";
import { readPublicEgressEnabled } from "../dist/config.js";
import { createMemoryPolicy } from "../dist/memory-policy.js";

const memoryUrl = () => new URL("https://memory.example.test/health");

/** All host patterns the compiled rule grants, indexed for lookups. */
function ruleHosts() {
  const rule = createPublicEgressRule();
  return { rule, hosts: new Set(rule.endpoints.map((endpoint) => endpoint.host)) };
}

test("public egress rule is static and deterministic", () => {
  // Zero-arity by construction: no team, instance, profile, or environment
  // input can parameterize the rule.
  assert.equal(createPublicEgressRule.length, 0);
  const before = createPublicEgressRule();
  process.env.REHOR_TEAM_EGRESS_HOSTS = "evil.example.test";
  process.env.AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED = "true";
  const after = createPublicEgressRule();
  delete process.env.REHOR_TEAM_EGRESS_HOSTS;
  delete process.env.AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED;
  assert.deepEqual(after, before);
  assert.deepEqual(createPublicEgressRule(), before);
});

test("every public egress endpoint is raw-tunnel L4-only HTTPS 443, enforced, and credential-free", () => {
  const { rule, hosts } = ruleHosts();
  assert.ok(rule.endpoints.length > 0);
  for (const endpoint of rule.endpoints) {
    assert.equal(endpoint.port, 443, endpoint.host);
    assert.equal(endpoint.protocol, "", endpoint.host);
    // Security invariant: raw L4 tunnel, no supervisor TLS interception,
    // no credential binding. SKIP disables supervisor interception, not
    // client TLS verification.
    assert.equal(endpoint.tls, NetworkTlsMode.SKIP, `${endpoint.host} must skip supervisor TLS interception`);
    assert.equal(endpoint.enforcement, NetworkEnforcementMode.ENFORCE, endpoint.host);
    // Vendor credentials are never injected through this rule.
    assert.equal(endpoint.credentialBinding, undefined, endpoint.host);
    assert.deepEqual(endpoint.rules ?? [], [], endpoint.host);
    assert.ok(!endpoint.path, `${endpoint.host} must not scope an L7 path`);
    assert.deepEqual(endpoint.allowedIps ?? [], [], endpoint.host);
  }
  assert.ok(!hosts.has(""), "no hostless/any-host endpoint");
  assert.ok(!hosts.has("*"), "no catch-all host");
  // The hub rules keep their provider-bound, TLS-inspected shape; public
  // egress must never relax or copy it.
  const memoryPolicy = createMemoryPolicy(memoryUrl(), "provider-name-1");
  for (const hubRule of Object.values(memoryPolicy.networkPolicies)) {
    for (const endpoint of hubRule.endpoints) {
      assert.equal(endpoint.tls, NetworkTlsMode.UNSPECIFIED);
      assert.ok(endpoint.credentialBinding);
    }
  }
});

test("host patterns preserve Squid exact versus leading-dot subdomain semantics", () => {
  const { rule, hosts } = ruleHosts();
  for (const destination of PUBLIC_EGRESS_DESTINATIONS) {
    const { host, match } = destination;
    if (match === "exact") {
      assert.ok(hosts.has(host), `${host} must have an exact endpoint`);
      assert.ok(!hosts.has(`**.${host}`), `${host} is exact-only in Squid; a subdomain pattern would broaden it`);
    } else {
      // Squid ".domain" covers the domain itself plus subdomains at any
      // depth; only exact + recursive "**." reproduces that without
      // broadening. Single-label "*" would miss deeper subdomains.
      assert.ok(hosts.has(host), `${host} must have an exact endpoint`);
      assert.ok(hosts.has(`**.${host}`), `${host} must have a recursive subdomain endpoint`);
      assert.ok(!hosts.has(`*.${host}`), `${host} must not use the single-label wildcard`);
    }
  }
  // No wildcard outside the reviewed "**.<domain>" form: no TLD wildcards,
  // no mid-label wildcards, no invented patterns.
  for (const host of hosts) {
    if (host.includes("*")) {
      assert.match(host, /^\*\*\.([a-z0-9-]+\.)+[a-z0-9-]+$/, `unexpected wildcard shape: ${host}`);
      assert.ok(host.split(".").length > 2, `TLD wildcard is not allowed: ${host}`);
    } else {
      assert.match(host, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `unexpected host: ${host}`);
    }
  }
  assert.equal(new Set(rule.endpoints.map((endpoint) => endpoint.host)).size, rule.endpoints.length, "duplicate endpoints");
});

test("binaries are the reviewed system toolset from Dockerfile.runner and presets", () => {
  const { rule } = ruleHosts();
  const paths = rule.binaries.map((binary) => binary.path);
  // Grounded in Dockerfile.runner (dnf/pip/COPY) and the env presets
  // (NVM_DIR=/usr/local/nvm, GOENV_ROOT=/usr/local/goenv,
  // PYENV_ROOT=/usr/local/pyenv, container-scan tarball install).
  const expected = [
    "/usr/bin/git",
    "/usr/bin/curl",
    "/usr/bin/python3.12",
    "/usr/local/bin/uv",
    "/usr/local/bin/node",
    "/usr/local/bin/grype",
    "/usr/local/nvm/versions/node/*/bin/node",
    "/usr/local/goenv/versions/*/bin/go",
    "/usr/local/pyenv/versions/*/bin/python",
  ];
  assert.deepEqual([...paths].sort(), [...expected].sort());
  for (const path of paths) {
    assert.ok(path.startsWith("/"), `absolute path required: ${path}`);
    assert.ok(!path.includes(".."), `no traversal: ${path}`);
    if (path.includes("*")) {
      // Globs are only permitted as the single version-label segment under
      // the fixed root-owned preset roots; nothing writable is globbed.
      assert.match(
        path,
        /^\/usr\/local\/(nvm\/versions\/node|goenv\/versions|pyenv\/versions)\/\*\/bin\/(node|go|python)$/,
        `unexpected glob shape: ${path}`,
      );
    }
  }
  // Writable sandbox locations must never be executable-glob grants.
  for (const path of paths) {
    assert.ok(!path.startsWith("/tmp") && !path.startsWith("/home/botuser"), `writable location granted: ${path}`);
  }
  // Browser binary limitation: the Playwright Chromium executable lives at a
  // version-dynamic path; it is flagged rather than wildcarded, so it must
  // not appear in any form.
  for (const path of paths) {
    assert.ok(!path.includes("pw-browsers") && !path.includes("chromium"), `browser binary granted: ${path}`);
  }
});

test("public egress flag is global, opt-in, and fail-closed", () => {
  assert.equal(readPublicEgressEnabled({}), false);
  assert.equal(readPublicEgressEnabled({ AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED: undefined }), false);
  assert.equal(readPublicEgressEnabled({ AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED: "false" }), false);
  assert.equal(readPublicEgressEnabled({ AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED: "true" }), true);
  for (const value of ["", " ", "1", "0", "TRUE", "yes", "on"]) {
    assert.throws(
      () => readPublicEgressEnabled({ AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED: value }),
      /AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED/,
      JSON.stringify(value),
    );
  }
});

test("merge is central: disabled policies are untouched, enabled policies gain the reserved rule", () => {
  const base = createMemoryPolicy(memoryUrl(), "provider-name-1");
  const disabled = withPublicEgress(base, false);
  assert.equal(disabled, base, "disabled merge must not copy or alter the policy");
  const enabled = withPublicEgress(base, true);
  assert.notEqual(enabled, base);
  assert.deepEqual(Object.keys(enabled.networkPolicies), ["memory_health", publicEgressRuleKey()]);
  assert.deepEqual(enabled.networkPolicies.memory_health, base.networkPolicies.memory_health);
  assert.deepEqual(enabled.networkPolicies[publicEgressRuleKey()], createPublicEgressRule());
  assert.throws(() => withPublicEgress(enabled, true), /reserved/);
});

test("Squid allowlist parity: every allowed domain is either granted or a documented gateway-only exclusion", async () => {
  const squid = await readFile(new URL("../../../proxy/squid.conf", import.meta.url), "utf8");
  const domains = [...squid.matchAll(/^acl allowed_domains dstdomain (\S+)$/gm)].map((match) => match[1]);
  assert.ok(domains.length > 0, "proxy/squid.conf allowlist not found or empty");

  const direct = new Map(PUBLIC_EGRESS_DESTINATIONS.map((destination) => [destination.host, destination]));
  const gatewayOnly = new Map(GATEWAY_ONLY_DESTINATIONS.map((destination) => [destination.host, destination]));
  for (const entry of domains) {
    const leadingDot = entry.startsWith(".");
    const host = leadingDot ? entry.slice(1) : entry;
    const match = leadingDot ? "domain-and-subdomains" : "exact";
    const destination = direct.get(host) ?? gatewayOnly.get(host);
    assert.ok(destination, `Squid domain '${entry}' is neither granted nor documented as gateway-only`);
    assert.equal(destination.match, match, `Squid semantics of '${entry}' must be preserved`);
  }
  // Reverse direction: the policy grants nothing the Squid allowlist did not.
  for (const destination of PUBLIC_EGRESS_DESTINATIONS) {
    const squidForm = destination.match === "domain-and-subdomains" ? `.${destination.host}` : destination.host;
    assert.ok(domains.includes(squidForm), `policy grants '${destination.host}', which Squid does not allow`);
  }
  // Every gateway-only exclusion is justified by the Squid allowlist too.
  for (const destination of GATEWAY_ONLY_DESTINATIONS) {
    const squidForm = destination.match === "domain-and-subdomains" ? `.${destination.host}` : destination.host;
    assert.ok(domains.includes(squidForm), `gateway-only exclusion '${destination.host}' is not a Squid entry`);
  }
  // The googleapis.com carve-out: the authenticated domain stays on the
  // gateway while its public storage subdomain remains a direct download.
  assert.ok(gatewayOnly.has("googleapis.com"));
  assert.ok(direct.has("storage.googleapis.com"));
});

test("Squid port parity: 443 only, with SSH 22 and HTTP 80 as documented exclusions", async () => {
  const squid = await readFile(new URL("../../../proxy/squid.conf", import.meta.url), "utf8");
  const ports = [...squid.matchAll(/^acl (?:SSL_ports|Safe_ports) port (\d+)$/gm)].map((match) => Number(match[1]));
  assert.ok(ports.includes(443), "Squid allows 443");
  const { rule } = ruleHosts();
  const policyPorts = new Set(rule.endpoints.map((endpoint) => endpoint.port));
  assert.deepEqual([...policyPorts], [443], "policy grants HTTPS 443 only");
  const excluded = new Map(EXCLUDED_SQUID_PORTS.map((entry) => [entry.port, entry.reason]));
  for (const port of new Set(ports)) {
    if (port === 443) continue;
    assert.ok(excluded.has(port), `Squid port ${port} must be a documented exclusion`);
    assert.ok(typeof excluded.get(port) === "string" && excluded.get(port).length > 0);
  }
});
