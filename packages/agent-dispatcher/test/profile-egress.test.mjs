import test from "node:test";
import assert from "node:assert/strict";
import { Code, ConnectError } from "@connectrpc/connect";
import { NetworkEnforcementMode, NetworkTlsMode } from "@nvidia/openshell-sdk/raw";
import {
  createPublicEgressRule,
  GATEWAY_ONLY_DESTINATIONS,
  PUBLIC_EGRESS_DESTINATIONS,
  withProfileEgress,
  withPublicEgress,
} from "../dist/egress-policy.js";
import { parseSandboxEgress } from "../dist/profile-egress.js";
import { PROFILE_EGRESS_APPROVALS } from "../dist/profile-egress-approvals.js";
import { createMemoryPolicy } from "../dist/memory-policy.js";

/** REHOR-285 policy-layer unit tests: withProfileEgress and parseSandboxEgress.
 * Discovery (agent-profiles) and SandboxSession behavior have their own test
 * files; this file stays at the policy contract. All hosts are synthetic
 * .example.com names and 93.184.215.14 is a documentation IPv4 pin, so no
 * test resolves or dials anything.
 *
 * Audit follow-up (REHOR-285): the supervisor's exact-host resolver mode
 * accepts private DNS answers for a declared hostname, so an approval must
 * pin exact public IPv4 addresses. Pins render as /32 and are the only
 * allowedIps a profile rule ever carries; every other endpoint field stays
 * identical to the central public rule, and the profile rule is appended to
 * — never a replacement for — the mandatory core policies. */

const repository = "https://github.com/example/instances.git";
const profile = "synthetic";
const host = "api.example.com";
const pin = "93.184.215.14";
const approval = { repository, profile, host, allowedIps: [pin] };
const context = (requests = [{ host, port: 443 }]) => ({ repository, profile, requests });
const basePolicy = () => createMemoryPolicy(new URL("https://memory.example.test/health"), "provider-name-1");
const connectError = (code, message) => (error) => error instanceof ConnectError && error.code === code && (!message || message.test(error.message));
const permissionDenied = connectError(Code.PermissionDenied);
const invalidArgument = connectError(Code.InvalidArgument);

test("absent or empty profile identity leaves the policy untouched", () => {
  const base = basePolicy();
  for (const enabled of [true, false]) {
    assert.equal(withProfileEgress(base, enabled, undefined, [approval]), base);
    // An empty request list is not an error and never trips the disabled flag.
    assert.equal(withProfileEgress(base, enabled, context([]), [approval]), base);
  }
});

test("an approved request appends a pinned, credential-free L4 rule over the reviewed binaries", () => {
  const centralRule = createPublicEgressRule();
  const centralDestinations = structuredClone(PUBLIC_EGRESS_DESTINATIONS);
  const gatewayOnlyDestinations = structuredClone(GATEWAY_ONLY_DESTINATIONS);
  const base = withPublicEgress(basePolicy(), true);
  const policy = withProfileEgress(base, true, context(), [approval]);

  // Append-only: the core policies keep their exact content and order, and
  // the profile rule is one added key.
  assert.deepEqual(Object.keys(policy.networkPolicies), ["memory_health", "public_egress", "profile_egress"]);
  assert.deepEqual(policy.networkPolicies.memory_health, base.networkPolicies.memory_health);
  assert.deepEqual(policy.networkPolicies.public_egress, centralRule);
  assert.deepEqual(Object.keys(base.networkPolicies), ["memory_health", "public_egress"], "base policy must not be mutated");

  const rule = policy.networkPolicies.profile_egress;
  assert.equal(rule.name, "profile-egress");
  // Exactly the reviewed system toolset of the central public rule.
  assert.deepEqual(rule.binaries, centralRule.binaries);
  assert.equal(rule.endpoints.length, 1);
  const [endpoint] = rule.endpoints;
  assert.equal(endpoint.host, host);
  assert.equal(endpoint.port, 443);
  assert.equal(endpoint.protocol, "");
  assert.equal(endpoint.tls, NetworkTlsMode.SKIP);
  assert.equal(endpoint.enforcement, NetworkEnforcementMode.ENFORCE);
  // No credential transport and no L7 scoping: raw L4 tunnel only.
  assert.equal(endpoint.credentialBinding, undefined);
  assert.deepEqual(endpoint.rules ?? [], []);
  assert.ok(!endpoint.path);
  // Audit pin: exact public IPv4 addresses rendered as /32.
  assert.deepEqual(endpoint.allowedIps, [`${pin}/32`]);

  // The central classification is untouched by profile input.
  assert.deepEqual(PUBLIC_EGRESS_DESTINATIONS, centralDestinations);
  assert.deepEqual(GATEWAY_ONLY_DESTINATIONS, gatewayOnlyDestinations);
  assert.deepEqual(createPublicEgressRule(), centralRule);
});

test("multiple approved requests render sorted endpoints with their own deduplicated pins", () => {
  const policy = withProfileEgress(basePolicy(), true, context([
    { host: "b.example.com", port: 443 },
    { host: "a.example.com", port: 443 },
  ]), [
    { repository, profile, host: "a.example.com", allowedIps: ["1.1.1.1"] },
    { repository, profile, host: "b.example.com", allowedIps: ["9.9.9.9", "1.1.1.1", "9.9.9.9"] },
  ]);
  const endpoints = policy.networkPolicies.profile_egress.endpoints;
  assert.deepEqual(endpoints.map(({ host: endpointHost }) => endpointHost), ["a.example.com", "b.example.com"]);
  assert.deepEqual(endpoints[0].allowedIps, ["1.1.1.1/32"]);
  assert.deepEqual(endpoints[1].allowedIps, ["1.1.1.1/32", "9.9.9.9/32"]);
});

test("approvals bind the exact repository, profile, and host exactly once", async (t) => {
  // Production ships no approved destinations; grants are added only after
  // platform review with validated runtime enforcement.
  assert.deepEqual(PROFILE_EGRESS_APPROVALS, []);
  for (const [name, contextValue, approvals] of [
    ["no approvals at all", context(), []],
    ["repository URL without the exact .git suffix", { ...context(), repository: repository.slice(0, -4) }, [approval]],
    ["different repository", { ...context(), repository: "https://github.com/other/instances.git" }, [approval]],
    ["different profile", { ...context(), profile: "different" }, [approval]],
    ["profile name case difference", { ...context(), profile: "Synthetic" }, [approval]],
    ["unapproved host", context([{ host: "other.example.com", port: 443 }]), [approval]],
    ["approval scoped to another repository", context(), [{ ...approval, repository: "https://github.com/other/instances.git" }]],
    ["approval scoped to another profile", context(), [{ ...approval, profile: "other" }]],
    ["ambiguous duplicate approvals", context(), [approval, { ...approval, allowedIps: ["1.1.1.1"] }]],
  ]) {
    await t.test(name, () => {
      assert.throws(() => withProfileEgress(basePolicy(), true, contextValue, approvals), permissionDenied);
    });
  }
});

test("destinations that would overlap or replace existing policy are denied", async (t) => {
  const approvedFor = (approvedHost) => ({ repository, profile, host: approvedHost, allowedIps: [pin] });
  for (const [name, run, message] of [
    ["reserved profile_egress rule key", () => withProfileEgress(withProfileEgress(basePolicy(), true, context(), [approval]), true, context(), [approval]), /reserved/],
    // The memory rule dials 8443; the request targets 443. Port difference
    // must not open a second path to a credential-bound service host.
    ["protected memory service host at a different port", () => withProfileEgress(createMemoryPolicy(new URL("https://memory.example.com:8443/health"), "provider-name-1"), true, context([{ host: "memory.example.com", port: 443 }]), [approvedFor("memory.example.com")]), /not permitted/],
    ["central wildcard overlap (**.github.com)", () => withProfileEgress(withPublicEgress(basePolicy(), true), true, context([{ host: "api.github.com", port: 443 }]), [approvedFor("api.github.com")]), /not permitted/],
    ["central wildcard overlap at depth (**.npmjs.org)", () => withProfileEgress(withPublicEgress(basePolicy(), true), true, context([{ host: "registry.npmjs.org", port: 443 }]), [approvedFor("registry.npmjs.org")]), /not permitted/],
    ["central exact-host overlap (pypi.org)", () => withProfileEgress(withPublicEgress(basePolicy(), true), true, context([{ host: "pypi.org", port: 443 }]), [approvedFor("pypi.org")]), /not permitted/],
    // An unrecognized wildcard shape in any existing rule must fail closed
    // rather than assume disjointness.
    ["unknown wildcard syntax in existing policy fails closed", () => withProfileEgress({
      ...basePolicy(),
      networkPolicies: { ...basePolicy().networkPolicies, legacy: { name: "legacy", endpoints: [{ host: "*.hub.example.com", port: 443 }] } },
    }, true, context(), [approval]), /not permitted/],
    ["gateway-only domain (atlassian.net)", () => withProfileEgress(basePolicy(), true, context([{ host: "atlassian.net", port: 443 }]), [approvedFor("atlassian.net")]), /not permitted/],
    ["gateway-only subdomain (vertexai.googleapis.com)", () => withProfileEgress(basePolicy(), true, context([{ host: "vertexai.googleapis.com", port: 443 }]), [approvedFor("vertexai.googleapis.com")]), /not permitted/],
  ]) {
    await t.test(name, () => assert.throws(run, connectError(Code.PermissionDenied, message)));
  }
});

test("profile egress is denied while the central deployment flag is off", () => {
  assert.throws(() => withProfileEgress(basePolicy(), false, context(), [approval]), connectError(Code.PermissionDenied, /disabled/));
});

test("malformed sandbox.egress requests fail as invalid input", async (t) => {
  for (const [name, requests] of [
    ["missing requests array", undefined],
    ["non-array requests", "api.example.com"],
    ["wildcard host", [{ host: "*.example.com", port: 443 }]],
    ["invalid port", [{ host, port: 80 }]],
    ["duplicate destination", [{ host, port: 443 }, { host, port: 443 }]],
  ]) {
    await t.test(name, () => {
      assert.throws(() => withProfileEgress(basePolicy(), true, { repository, profile, requests }, [approval]), invalidArgument);
    });
  }
});

test("approvals must pin between one and sixteen exact public IPv4 addresses", async (t) => {
  for (const [name, allowedIps, message] of [
    ["missing pins", undefined, /public IPv4 pins/],
    ["empty pins", [], /public IPv4 pins/],
    ["more than sixteen pins", Array.from({ length: 17 }, (_, index) => `1.0.0.${index + 1}`), /public IPv4 pins/],
    ["private pin", ["10.0.0.1"], /Invalid profile egress IPv4 pin/],
    ["CGNAT pin", ["100.64.0.1"], /Invalid profile egress IPv4 pin/],
    ["loopback pin", ["127.0.0.1"], /Invalid profile egress IPv4 pin/],
    ["link-local pin", ["169.254.169.254"], /Invalid profile egress IPv4 pin/],
    ["documentation-range pin", ["203.0.113.10"], /Invalid profile egress IPv4 pin/],
    ["benchmark-range pin", ["198.18.0.1"], /Invalid profile egress IPv4 pin/],
    ["multicast pin", ["224.0.0.1"], /Invalid profile egress IPv4 pin/],
    ["reserved pin", ["240.0.0.1"], /Invalid profile egress IPv4 pin/],
    ["this-network pin", ["0.0.0.1"], /Invalid profile egress IPv4 pin/],
    ["IPv6 pin", ["2001:db8::1"], /Invalid profile egress IPv4 pin/],
    ["IPv6 link-local pin", ["fe80::1"], /Invalid profile egress IPv4 pin/],
    ["CIDR pin", [`${pin}/32`], /Invalid profile egress IPv4 pin/],
    ["non-string pin", [null], /Invalid profile egress IPv4 pin/],
    ["valid pin mixed with a private pin", [pin, "10.0.0.1"], /Invalid profile egress IPv4 pin/],
    ["valid pin mixed with an IPv6 pin", [pin, "fe80::1"], /Invalid profile egress IPv4 pin/],
  ]) {
    await t.test(name, () => {
      assert.throws(() => withProfileEgress(basePolicy(), true, context(), [{ ...approval, allowedIps }]), connectError(Code.PermissionDenied, message));
    });
  }
  // Sixteen distinct public pins are the documented maximum.
  const sixteen = Array.from({ length: 16 }, (_, index) => `1.0.0.${index + 1}`);
  const policy = withProfileEgress(basePolicy(), true, context(), [{ ...approval, allowedIps: sixteen }]);
  assert.deepEqual(policy.networkPolicies.profile_egress.endpoints[0].allowedIps, sixteen.map((ip) => `${ip}/32`).sort());
});

test("parseSandboxEgress accepts exact public hostnames on port 443 only", () => {
  assert.deepEqual(parseSandboxEgress(undefined), []);
  assert.deepEqual(parseSandboxEgress([]), []);
  const requests = [{ host: "api.example.com", port: 443 }, { host: "cdn.example.com", port: 443 }];
  assert.deepEqual(parseSandboxEgress(requests), requests);
  const maximum = Array.from({ length: 32 }, (_, index) => ({ host: `h${index}.example.com`, port: 443 }));
  assert.equal(parseSandboxEgress(maximum).length, 32);
});

test("parseSandboxEgress rejects representative malformed destinations", async (t) => {
  const entry = (malformedHost) => [{ host: malformedHost, port: 443 }];
  const hostname = /host must be an exact lowercase public DNS hostname/;
  for (const [name, value, message] of [
    ["non-array object", { host, port: 443 }, /must be a list/],
    ["non-array string", host, /must be a list/],
    ["null", null, /must be a list/],
    ["more than 32 destinations", Array.from({ length: 33 }, (_, index) => ({ host: `h${index}.example.com`, port: 443 })), /at most 32/],
    ["null entry", [null], /must contain only host and port/],
    ["array entry", [[host, 443]], /must contain only host and port/],
    ["string entry", [host], /must contain only host and port/],
    ["missing host", [{ port: 443 }], /must contain only host and port/],
    ["missing port", [{ host }], /must contain only host and port/],
    ["extra protocol field", [{ host, port: 443, protocol: "" }], /must contain only host and port/],
    ["extra raw field", [{ host, port: 443, raw: "synthetic" }], /must contain only host and port/],
    ["port 80", [{ host, port: 80 }], /port must be 443/],
    ["port 8443", [{ host, port: 8443 }], /port must be 443/],
    ["out-of-range port", [{ host, port: 65536 }], /port must be 443/],
    ["string port", [{ host, port: "443" }], /port must be 443/],
    ["private IPv4 literal host", entry("10.0.0.1"), hostname],
    ["link-local IPv4 literal host", entry("169.254.169.254"), hostname],
    ["public IPv4 literal host", entry(pin), hostname],
    ["IPv6 literal host", entry("2001:db8::1"), hostname],
    ["leading wildcard host", entry("*.example.com"), hostname],
    ["recursive wildcard host", entry("**.example.com"), hostname],
    ["mid-label wildcard host", entry("api.*.example.com"), hostname],
    ["numeric alternate IPv4 host (shorthand)", entry("127.1"), hostname],
    ["numeric alternate IPv4 host (hex label)", entry("0x5d.1.2.3"), hostname],
    ["uppercase host", entry("API.example.com"), hostname],
    ["trailing-dot host", entry("api.example.com."), hostname],
    ["single-label host", entry("example"), hostname],
    ["local-suffixed host", entry("api.example.internal"), hostname],
    ["test-suffixed host", entry("api.example.test"), hostname],
    ["localhost-suffixed host", entry("api.localhost"), hostname],
    ["punycode-labeled host", entry("xn--igkeit.example.com"), hostname],
    ["underscore-labeled host", entry("my_api.example.com"), hostname],
    ["host over 253 characters", [{ host: `${"a".repeat(250)}.example.com`, port: 443 }], hostname],
    ["duplicate destinations", [{ host, port: 443 }, { host, port: 443 }], /duplicates a destination/],
  ]) {
    await t.test(name, () => assert.throws(() => parseSandboxEgress(value), message));
  }
});
