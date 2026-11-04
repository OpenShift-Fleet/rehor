import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { DeletionOutcome, ProviderReadinessState, ProviderProfileSchema, SandboxPhase, SandboxPolicySchema, SandboxRestartPolicy } from "@nvidia/openshell-sdk/raw";
import { SandboxSession } from "../dist/sandbox-session.js";
import { INPUT_ENVIRONMENT, INPUT_FILE_PATH, MAX_INPUT_BYTES } from "../dist/input-envelope.js";

const prompt = "sensitive prepared prompt 🦊";
const token = "synthetic-secret-never-workload";
const decision = { action: "start", prompt, scripts: [{ name: "one.mjs", status: "start", content: "private script output" }] };
const image = "registry.example.test/team/runner:latest";
const absent = () => { throw new ConnectError("private error", Code.NotFound); };

function fixture(options = {}) {
  const calls = [];
  let workspace, sandbox, provider, profile, suppliedPolicy;
  const raw = {
    async createWorkspace(request) {
      workspace = { metadata: { id: randomUUID(), name: request.name, labels: request.labels } };
      return { workspace };
    },
    async getWorkspace() { return workspace ? { workspace } : absent(); },
    async listWorkspaceMembers() { return { members: [] }; },
    async importProviderProfiles(request) {
      profile = create(ProviderProfileSchema, { ...request.profiles[0].profile, scope: "workspace", source: "user", resourceVersion: 1n });
      return { imported: true, profiles: [profile], diagnostics: [] };
    },
    async getProviderProfile() { return profile ? { profile } : absent(); },
    async createProvider(request) {
      provider = { metadata: { id: randomUUID(), name: request.provider.metadata.name, workspace: workspace.metadata.name, resourceVersion: 1n }, type: profile.id, profileWorkspace: workspace.metadata.name };
      return { provider };
    },
    async getProvider() { return provider ? { provider } : absent(); },
    async createSandbox(request) {
      sandbox = { metadata: { id: randomUUID(), name: request.name, labels: request.labels, workspace: workspace.metadata.name }, status: { phase: SandboxPhase.READY } };
      suppliedPolicy = create(SandboxPolicySchema, structuredClone(request.spec.policy));
      for (const rule of Object.values(suppliedPolicy.networkPolicies)) for (const endpoint of rule.endpoints) endpoint.providerCredentialed = true;
      // Model Gateway's additive runtime filesystem/default policy enrichment,
      // not an unrealistic verbatim echo of the requested policy.
      suppliedPolicy.filesystem.readOnly.push("/usr", "/lib", "/etc", "/proc", "/dev/urandom");
      suppliedPolicy.filesystem.readWrite.push("/dev/null");
      suppliedPolicy.networkPolicies.platform_default = create(SandboxPolicySchema, {
        networkPolicies: { platform_default: { name: "platform-default" } },
      }).networkPolicies.platform_default;
      options.enrichPolicy?.(suppliedPolicy);
      if (options.ambiguousCreate) throw new ConnectError("private create error", Code.Unavailable);
      return { sandbox };
    },
    async getSandbox() { return sandbox ? { sandbox } : absent(); },
    async getSandboxConfig() { return { configurationAdmitted: true, policy: suppliedPolicy, providerAttachmentEpoch: 1n, configRevision: 1n, policyHash: "hash", providerEnvRevision: 1n }; },
    async getSandboxProviderStatus() {
      const revision = { attachmentEpoch: 1n, configRevision: 1n, policyHash: "hash", providerEnvRevision: 1n };
      return { status: { state: ProviderReadinessState.READY, receipt: { desired: { ...revision, sandboxId: sandbox.metadata.id, providerId: provider.metadata.id, providerResourceVersion: 1n } }, observed: { ...revision, credentialsInstalled: true, policyActive: true, launchEnvironmentInstalled: true } } };
    },
    async *execSandbox(request, callOptions) {
      if (request.command[0] === "/usr/bin/bash") {
        yield { payload: { case: "stdout", value: { data: Buffer.from(prompt) } } };
        yield { payload: { case: "stderr", value: { data: Buffer.from(token) } } };
        if (options.runnerError) throw new ConnectError(`private ${token}`, Code.PermissionDenied);
        if (options.cancel) {
          options.cancel.abort();
          callOptions.signal.throwIfAborted();
        }
        if (options.missingExit) return;
      }
      yield { payload: { case: "exit", value: { exitCode: request.command[0] === "/usr/bin/bash" ? (options.exit ?? 0) : (options.writeExit ?? 0) } } };
    },
    async deleteSandbox() {
      if (options.cleanupError) throw new ConnectError(`private ${token}`, Code.Unavailable);
      const sandboxId = sandbox.metadata.id;
      sandbox = undefined;
      return { sandboxId, outcome: DeletionOutcome.COMPLETED };
    },
    async listSandboxes() { return { sandboxes: sandbox ? [sandbox] : [] }; },
    async deleteProvider() { assert.equal(sandbox, undefined); provider = undefined; return {}; },
    async deleteProviderProfile() { assert.equal(sandbox, undefined); profile = undefined; return {}; },
    async listProviders() { return { providers: provider ? [provider] : [] }; },
    async listProviderProfiles() { return { profiles: profile ? [profile] : [] }; },
    async deleteWorkspace() { assert.equal(sandbox, undefined); workspace = undefined; return {}; },
  };
  for (const [name, method] of Object.entries(raw)) raw[name] = (request, callOptions) => {
    calls.push({ name, request, options: callOptions });
    return method(request, callOptions);
  };
  let minted = 0;
  const memory = { url: new URL("https://memory.example.test/health"), credentialProvider: { async mint() { minted++; return { token, expiresAt: Date.now() + 600_000 }; } } };
  return { raw, calls, memory, session: new SandboxSession(raw, memory), minted: () => minted };
}

test("safe stdin writer then exact runner with per-exec pointers, unique request IDs, no payload leaks", async () => {
  const f = fixture();
  const environment = { BOT_MEMORY_URL: "http://existing-memory.test/mcp", REHOR_INPUT_SOURCE: "wrong", REHOR_INPUT_FILE: "wrong", WORKFLOW: "onboarding" };
  const result = await f.session.run(image, decision, environment);
  assert.equal(result.outcome, "passed");
  assert.equal(result.completion, "gone");
  assert.equal(result.cleanup, "deleted");
  assert.equal(f.minted(), 1);
  const execs = f.calls.filter((call) => call.name === "execSandbox");
  assert.equal(execs.length, 2);
  const [writer, runner] = execs;
  assert.equal(writer.request.command[0], "/usr/bin/python3.12");
  for (const expected of ["os.O_EXCL", "os.O_NOFOLLOW", "0o600", "os.fstat", "stream.read() != data", INPUT_FILE_PATH]) assert.ok(writer.request.command[2].includes(expected));
  assert.equal(JSON.parse(writer.request.stdin.toString()).prompt, prompt);
  assert.equal(writer.request.requestId, result.writeRequestId);
  assert.deepEqual(runner.request.command, ["/usr/bin/bash", "/home/botuser/app/entrypoint.sh"]);
  assert.deepEqual(runner.request.environment, { ...environment, ...INPUT_ENVIRONMENT });
  assert.equal(runner.request.environment.BOT_MEMORY_URL, environment.BOT_MEMORY_URL);
  assert.equal(runner.request.workdir, "/home/botuser/app");
  assert.equal(runner.request.noLoginShell, true);
  assert.equal(runner.request.requestId, result.runnerRequestId);
  assert.notEqual(result.runnerRequestId, result.writeRequestId);
  assert.equal(runner.request.executionTimeout, undefined);
  assert.equal(runner.options.timeoutMs, undefined);
  const spec = f.calls.find((call) => call.name === "createSandbox").request.spec;
  assert.equal(spec.restartPolicy, SandboxRestartPolicy.NEVER);
  assert.equal(spec.command.join(" ").includes("1200"), false);
  assert.equal(JSON.stringify(spec).includes(prompt), false);
  assert.equal(JSON.stringify(result).includes(prompt), false);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(runner.request).includes(token), false);
  assert.equal(environment.REHOR_INPUT_SOURCE, "wrong");
  const provider = f.calls.find((call) => call.name === "createProvider").request.provider;
  assert.equal(provider.credentials.BOT_MEMORY_TOKEN, token);
  for (const call of f.calls.filter((call) => call.name !== "execSandbox")) {
    assert.ok(call.options.timeoutMs > 0, `${call.name} missing RPC deadline`);
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test("empty, oversized and non-start decisions never allocate or mint", async () => {
  for (const value of [{ ...decision, prompt: " \t\n" }, { ...decision, prompt: "🦊".repeat(MAX_INPUT_BYTES) }, { action: "skip", transcript: prompt, scripts: [] }, { action: "error", transcript: prompt, scripts: [] }]) {
    const f = fixture();
    const result = await f.session.run(image, value, {});
    assert.equal(result.completion, "not-created");
    assert.equal(f.calls.length, 0);
    assert.equal(f.minted(), 0);
  }
});

test("default policy remains constrained HTTPS health-only, not inferred runner egress", async () => {
  const f = fixture();
  const result = await new SandboxSession(f.raw, f.memory).run(image, decision, {});
  assert.equal(result.completion, "gone");
  const policy = f.calls.find((call) => call.name === "createSandbox").request.spec.policy;
  assert.deepEqual(Object.keys(policy.networkPolicies), ["memory_health"]);
  const rule = policy.networkPolicies.memory_health;
  assert.equal(rule.endpoints[0].host, "memory.example.test");
  assert.deepEqual(rule.endpoints[0].rules, [{ allow: { method: "GET", path: "/health" } }]);
  assert.deepEqual(rule.binaries, [{ path: "/usr/bin/python3.12" }]);
  assert.deepEqual(policy.filesystem.readOnly, ["/home/botuser/app"]);
  assert.deepEqual(policy.filesystem.readWrite, ["/home/botuser/repos", "/home/botuser/data", "/tmp"]);
  assert.equal(f.calls.filter((call) => call.name === "execSandbox").length, 2);
});

test("canonical unqualified profile image dispatches under additive Gateway policy", async () => {
  const f = fixture({ enrichPolicy: (policy) => policy.filesystem.readWrite.push("/home/botuser/app-cache") });
  const result = await f.session.run("onboarding:latest", decision, {});
  assert.equal(result.outcome, "passed");
  assert.equal(result.completion, "gone");
  assert.equal(f.calls.find((call) => call.name === "createSandbox").request.spec.template.image, "onboarding:latest");
  assert.equal(f.calls.filter((call) => call.name === "execSandbox").length, 2);
});

test("supplied credential-rule drift fails before writer or runner", async () => {
  for (const enrichPolicy of [
    (policy) => { policy.networkPolicies.memory_health.endpoints[0].rules[0].allow.path = "/**"; },
    (policy) => { policy.networkPolicies.memory_health.endpoints[0].credentialBinding.provider = "someone-else"; },
    (policy) => { policy.networkPolicies.memory_health.endpoints[0].providerCredentialed = false; },
    (policy) => { delete policy.networkPolicies.memory_health; },
  ]) {
    const f = fixture({ enrichPolicy });
    const result = await f.session.run(image, decision, {});
    assert.equal(result.outcome, "unknown");
    assert.equal(result.stage, "readiness");
    assert.equal(result.completion, "gone");
    assert.equal(f.calls.some((call) => call.name === "execSandbox"), false);
  }
});

test("effective filesystem rejects app writes/ancestors/globs and missing supplied constraints", async () => {
  const mutations = [
    ...["/", "/home", "/home/botuser", "/home/botuser/app", "/home/botuser/app/state", "/home/botuser/app/", "/tmp/../home/botuser", "/home/*", "/home/botuser/ap?", "/**"].map((path) => (policy) => policy.filesystem.readWrite.push(path)),
    (policy) => { policy.filesystem.includeWorkdir = true; },
    (policy) => { policy.filesystem.readOnly = policy.filesystem.readOnly.filter((path) => path !== "/home/botuser/app"); },
    (policy) => { policy.filesystem.readWrite = policy.filesystem.readWrite.filter((path) => path !== "/home/botuser/data"); },
  ];
  for (const enrichPolicy of mutations) {
    const f = fixture({ enrichPolicy });
    const result = await f.session.run(image, decision, {});
    assert.equal(result.outcome, "unknown");
    assert.equal(result.stage, "readiness");
    assert.equal(f.calls.some((call) => call.name === "execSandbox"), false);
  }
});

test("runner nonzero fails; missing exit/transport errors remain unknown", async () => {
  for (const [options, outcome, category] of [[{ exit: 2 }, "failed", undefined], [{ missingExit: true }, "unknown", "other"], [{ runnerError: true }, "unknown", "permission_denied"]]) {
    const f = fixture(options);
    const result = await f.session.run(image, decision, {});
    assert.equal(result.outcome, outcome);
    assert.equal(result.errorCode, category);
    assert.equal(result.completion, "gone");
    assert.equal(f.calls.filter((call) => call.name === "execSandbox").length, 2);
  }
});

test("writer failure prevents runner launch", async () => {
  const f = fixture({ writeExit: 1 });
  const result = await f.session.run(image, decision, {});
  assert.equal(result.outcome, "failed");
  assert.equal(f.calls.filter((call) => call.name === "execSandbox").length, 1);
});

test("ambiguous sandbox delete retains unknown completion and dependent resources", async () => {
  const f = fixture({ cleanupError: true });
  const result = await f.session.run(image, decision, {});
  assert.equal(result.completion, "unknown");
  assert.equal(result.cleanup, "unknown");
  assert.equal(result.errorCode, "unavailable");
  assert.equal(f.calls.some((call) => ["deleteProvider", "deleteProviderProfile", "deleteWorkspace"].includes(call.name)), false);
});

test("ambiguous create recovered by deterministic name and owned identity; never retried", async () => {
  const f = fixture({ ambiguousCreate: true });
  const result = await f.session.run(image, decision, {});
  assert.equal(result.outcome, "unknown");
  assert.equal(result.completion, "gone");
  assert.equal(result.errorCode, "unavailable");
  assert.equal(f.calls.filter((call) => call.name === "createSandbox").length, 1);
  assert.equal(f.calls.filter((call) => call.name === "execSandbox").length, 0);
});

test("runner cancellation still performs independently bounded cleanup", async () => {
  const cancel = new AbortController();
  const f = fixture({ cancel });
  const result = await f.session.run(image, decision, {}, cancel.signal);
  assert.equal(result.errorCode, "cancelled");
  assert.equal(result.completion, "gone");
  assert.equal(f.calls.find((call) => call.name === "deleteSandbox").options.signal.aborted, false);
});

test("ownership drift blocks sandbox and dependent deletion", async () => {
  const f = fixture();
  const original = f.raw.getSandbox;
  let reads = 0;
  f.raw.getSandbox = async (...args) => {
    const response = await original(...args);
    if (++reads > 1) response.sandbox.metadata.labels = { "rehor-session": "someone-else" };
    return response;
  };
  const result = await f.session.run(image, decision, {});
  assert.equal(result.completion, "unknown");
  assert.equal(result.cleanup, "unknown");
  assert.equal(f.calls.some((call) => ["deleteSandbox", "deleteProvider", "deleteProviderProfile", "deleteWorkspace"].includes(call.name)), false);
});

test("malformed cleanup response is not proof of absence", async () => {
  const f = fixture();
  const original = f.raw.getSandbox;
  let reads = 0;
  f.raw.getSandbox = (...args) => ++reads > 1 ? Promise.resolve({}) : original(...args);
  const result = await f.session.run(image, decision, {});
  assert.equal(result.completion, "unknown");
  assert.equal(f.calls.some((call) => call.name === "deleteProvider"), false);
});
