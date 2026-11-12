import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { DeletionOutcome, NetworkEnforcementMode, NetworkTlsMode, ProviderReadinessState, ProviderProfileSchema, SandboxPhase, SandboxPolicySchema, SandboxRestartPolicy } from "@nvidia/openshell-sdk/raw";
import { SandboxSession } from "../dist/sandbox-session.js";
import { readSandboxRetentionMs } from "../dist/config.js";
import { createPublicEgressRule } from "../dist/egress-policy.js";
import { SessionDispatcher } from "../dist/dispatch-sessions.js";
import { INPUT_ENVIRONMENT, INPUT_FILE_PATH, MAX_INPUT_BYTES } from "../dist/input-envelope.js";
import { readRuntimeLayout } from "../dist/runtime-layout.js";

const prompt = "sensitive prepared prompt 🦊";
const token = "synthetic-secret-never-workload";
const decision = { action: "start", prompt, scripts: [{ name: "one.mjs", status: "start", content: "private script output" }] };
const image = "registry.example.test/team/runner:latest";
const absent = () => { throw new ConnectError("private error", Code.NotFound); };

function fixture(options = {}) {
  const calls = [];
  let workspace, sandbox, provider, profile, suppliedPolicy;
  let sandboxDeleteAttempts = 0;
  let workspaceReads = 0;
  let cleanupStarted = false;
  let workspaceCleanupReadFailures = options.cleanupReadFailures ?? 0;
  let sandboxCleanupReadFailures = options.cleanupSandboxReadFailures ?? 0;
  let configFailures = options.configFailures ?? 0;
  let providerStatusFailures = options.providerStatusFailures ?? 0;
  const raw = {
    async createWorkspace(request) {
      const created = { metadata: { id: randomUUID(), name: request.name, labels: request.labels } };
      if (options.delayedCreate === "workspace") {
        setTimeout(() => { workspace = created; }, 25);
        throw new ConnectError("private create error", Code.Unavailable);
      }
      workspace = created;
      return { workspace };
    },
    async getWorkspace(_request, callOptions) {
      workspaceReads++;
      if (options.slowCleanup && workspaceReads >= 3) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        callOptions.signal.throwIfAborted();
      }
      if (cleanupStarted && !sandbox && workspace && workspaceCleanupReadFailures-- > 0) throw new ConnectError("private read error", Code.Unavailable);
      return workspace ? { workspace } : absent();
    },
    async listWorkspaceMembers() { return { members: [] }; },
    async importProviderProfiles(request) {
      const imported = create(ProviderProfileSchema, { ...request.profiles[0].profile, scope: "workspace", source: "user", resourceVersion: 1n });
      if (options.delayedCreate === "profile") {
        setTimeout(() => { profile = imported; }, 25);
        throw new ConnectError("private create error", Code.Unavailable);
      }
      profile = imported;
      return { imported: true, profiles: [profile], diagnostics: [] };
    },
    async getProviderProfile() { return profile ? { profile } : absent(); },
    async createProvider(request) {
      const created = { metadata: { id: randomUUID(), name: request.provider.metadata.name, workspace: workspace.metadata.name, resourceVersion: 1n }, type: profile.id, profileWorkspace: workspace.metadata.name };
      if (options.delayedCreate === "provider") {
        setTimeout(() => { provider = created; }, 25);
        throw new ConnectError("private create error", Code.Unavailable);
      }
      provider = created;
      return { provider };
    },
    async getProvider() { return provider ? { provider } : absent(); },
    async createSandbox(request) {
      const created = { metadata: { id: randomUUID(), name: request.name, labels: request.labels, workspace: workspace.metadata.name }, status: { phase: SandboxPhase.READY } };
      suppliedPolicy = create(SandboxPolicySchema, structuredClone(request.spec.policy));
      // The gateway marks only credential-bound endpoints; the static public
      // egress endpoints carry no credential binding.
      for (const rule of Object.values(suppliedPolicy.networkPolicies)) for (const endpoint of rule.endpoints) if (endpoint.credentialBinding?.provider) endpoint.providerCredentialed = true;
      // Model Gateway's additive runtime filesystem/default policy enrichment,
      // not an unrealistic verbatim echo of the requested policy.
      suppliedPolicy.filesystem.readOnly.push("/usr", "/lib", "/etc", "/proc", "/dev/urandom");
      suppliedPolicy.filesystem.readWrite.push("/dev/null");
      // Additive Gateway network baseline, accepted only while the central
      // public-egress flag is off; with the flag on, the effective network
      // rule set must match the requested set exactly (no reviewed builtin
      // default exists), so the strict-mode fixture adds none.
      if (!options.publicEgress) {
        suppliedPolicy.networkPolicies.platform_default = create(SandboxPolicySchema, {
          networkPolicies: { platform_default: { name: "platform-default" } },
        }).networkPolicies.platform_default;
      }
      // The real Gateway (>= 0.1.6) attaches a reserved per-provider rule on
      // provider attachment (credential placeholder resolution); strict
      // public-egress mode must tolerate exactly this rule and nothing else.
      const reservedProviderRule = `_provider_${request.spec.providers[0]}`;
      suppliedPolicy.networkPolicies[reservedProviderRule] = create(SandboxPolicySchema, {
        networkPolicies: { [reservedProviderRule]: { name: reservedProviderRule } },
      }).networkPolicies[reservedProviderRule];
      options.enrichPolicy?.(suppliedPolicy);
      if (options.delayedCreate === "sandbox") {
        setTimeout(() => { sandbox = created; }, 25);
        throw new ConnectError("private create error", Code.Unavailable);
      }
      sandbox = created;
      if (options.ambiguousCreate) throw new ConnectError("private create error", Code.Unavailable);
      return { sandbox };
    },
    async getSandbox() {
      if (cleanupStarted && !sandbox && sandboxCleanupReadFailures-- > 0) throw new ConnectError("private sandbox read error", Code.Unavailable);
      return sandbox ? { sandbox } : absent();
    },
    async getSandboxConfig() {
      if (configFailures-- > 0) throw new ConnectError("private config error", Code.Unavailable);
      return { configurationAdmitted: true, policy: suppliedPolicy, providerAttachmentEpoch: 1n, configRevision: 1n, policyHash: "hash", providerEnvRevision: 1n };
    },
    async getSandboxProviderStatus() {
      if (providerStatusFailures-- > 0) throw new ConnectError("private provider status error", Code.DeadlineExceeded);
      const revision = { attachmentEpoch: 1n, configRevision: 1n, policyHash: "hash", providerEnvRevision: 1n };
      return { status: { state: ProviderReadinessState.READY, receipt: { desired: { ...revision, sandboxId: sandbox.metadata.id, providerId: provider.metadata.id, providerResourceVersion: 1n } }, observed: { ...revision, credentialsInstalled: true, policyActive: true, launchEnvironmentInstalled: true } } };
    },
    async *execSandbox(request, callOptions) {
      const isRunner = request.command[0] === "/usr/bin/bash" || request.command[1] === "/opt/rehor/sandbox-bootstrap.py";
      if (isRunner) {
        yield { payload: { case: "stdout", value: { data: Buffer.from(prompt) } } };
        yield { payload: { case: "stderr", value: { data: Buffer.from(token) } } };
        if (options.runnerError) throw new ConnectError(`private ${token}`, Code.PermissionDenied);
        if (options.cancel) {
          options.cancel.abort();
          callOptions.signal.throwIfAborted();
        }
        if (options.missingExit) return;
      }
      yield { payload: { case: "exit", value: { exitCode: isRunner ? (options.exit ?? 0) : (options.writeExit ?? 0) } } };
    },
    async deleteSandbox() {
      cleanupStarted = true;
      if (options.cleanupError) throw new ConnectError(`private ${token}`, Code.Unavailable);
      if (options.transientDelete && sandboxDeleteAttempts++ === 0) throw new ConnectError("private delete error", Code.Unavailable);
      const sandboxId = sandbox.metadata.id;
      sandbox = undefined;
      if (options.transientDeleteAfterCommit && sandboxDeleteAttempts++ === 0) throw new ConnectError("private lost delete response", Code.Unavailable);
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
  return { raw, calls, memory, session: new SandboxSession({ raw, memory, ...(options.cleanupBudgetMs !== undefined ? { cleanupBudgetMs: options.cleanupBudgetMs } : {}), ...(options.modelProxyUrl !== undefined ? { modelProxyUrl: options.modelProxyUrl } : {}), ...(options.publicEgress !== undefined ? { publicEgress: options.publicEgress } : {}), ...(options.sandboxRetentionMs !== undefined ? { sandboxRetentionMs: options.sandboxRetentionMs } : {}), ...(options.onRetention !== undefined ? { onRetention: options.onRetention } : {}) }), minted: () => minted, workspace: () => workspace,
    resources: () => ({ workspace, sandbox, provider, profile }) };
}

test("session options preserve default, explicit undefined, and custom values", () => {
  const { raw, memory } = fixture();
  for (const options of [{}, { cleanupBudgetMs: undefined, runtime: undefined, modelProxyUrl: undefined, publicEgress: undefined, sandboxRetentionMs: undefined, onRetention: undefined }]) {
    const session = new SandboxSession({ raw, memory, ...options });
    assert.equal(session.raw, raw);
    assert.equal(session.memory, memory);
    assert.equal(session.cleanupBudgetMs, 20 * 60_000);
    assert.deepEqual(session.runtime, { kind: "legacy" });
    assert.equal(session.modelProxyUrl, undefined);
    assert.equal(session.publicEgress, false);
    assert.equal(session.sandboxRetentionMs, 0);
    assert.equal(session.onRetention, undefined);
  }
  const runtime = readRuntimeLayout({ AGENT_DISPATCHER_RUNTIME_LAYOUT: "private" });
  const modelProxyUrl = new URL("https://model-gateway.example.test/v1");
  for (const cleanupBudgetMs of [0, 1234]) {
    const session = new SandboxSession({ raw, memory, cleanupBudgetMs, runtime, modelProxyUrl, publicEgress: true, sandboxRetentionMs: 2500, onRetention: () => {} });
    assert.equal(session.cleanupBudgetMs, cleanupBudgetMs);
    assert.equal(session.runtime, runtime);
    assert.equal(session.modelProxyUrl, modelProxyUrl);
    assert.equal(session.publicEgress, true);
    assert.equal(session.sandboxRetentionMs, 2500);
    assert.equal(typeof session.onRetention, "function");
  }
});

test("sandbox retention config is opt-in, whole seconds, and fail-closed", () => {
  assert.equal(readSandboxRetentionMs({}), 0);
  assert.equal(readSandboxRetentionMs({ AGENT_DISPATCHER_SANDBOX_RETENTION: undefined }), 0);
  assert.equal(readSandboxRetentionMs({ AGENT_DISPATCHER_SANDBOX_RETENTION: "0" }), 0);
  assert.equal(readSandboxRetentionMs({ AGENT_DISPATCHER_SANDBOX_RETENTION: "30" }), 30_000);
  assert.equal(readSandboxRetentionMs({ AGENT_DISPATCHER_SANDBOX_RETENTION: "86400" }), 86_400_000);
  for (const value of ["", " ", "-1", "1.5", "abc", "86401", "999999999999999999999999", "10s", "0x10"]) {
    assert.throws(() => readSandboxRetentionMs({ AGENT_DISPATCHER_SANDBOX_RETENTION: value }), undefined, `rejects ${JSON.stringify(value)}`);
  }
});

test("retention holds finished session resources before cleanup and reports names", async () => {
  const retained = [];
  const f = fixture({ sandboxRetentionMs: 40, onRetention: (info) => retained.push(info) });
  const startedAt = performance.now();
  const result = await f.session.run(image, decision, {});
  const elapsedMs = performance.now() - startedAt;
  assert.equal(result.outcome, "passed");
  assert.equal(result.cleanup, "deleted");
  assert.equal(result.completion, "gone");
  assert.equal(retained.length, 1);
  assert.equal(retained[0].runId, result.runId);
  assert.equal(retained[0].workspaceName, result.workspace.name);
  assert.equal(retained[0].sandboxName, result.sandbox.name);
  assert.equal(retained[0].retentionMs, 40);
  assert.ok(elapsedMs >= 40, "retention delays cleanup");
  assert.equal(f.calls.filter((c) => c.name === "deleteSandbox").length, 1);
  assert.ok(f.resources().sandbox === undefined && f.resources().workspace === undefined);
});

test("aborting during retention falls through to immediate cleanup", async () => {
  const retained = [];
  const f = fixture({ sandboxRetentionMs: 120_000, onRetention: (info) => retained.push(info) });
  const controller = new AbortController();
  const running = f.session.run(image, decision, {}, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const abortedAt = performance.now();
  controller.abort();
  const result = await running;
  assert.ok(performance.now() - abortedAt < 10_000, "cleanup does not wait out the retention window");
  assert.equal(retained.length, 1);
  assert.equal(result.cleanup, "deleted");
  assert.equal(result.completion, "gone");
  assert.ok(f.resources().sandbox === undefined && f.resources().workspace === undefined);
});

test("session passes deployment runtime options to the memory policy builder", () => {
  const source = `
    import { registerHooks } from 'node:module';
    registerHooks({ load(url, context, nextLoad) {
      if (url.endsWith('/dist/memory-policy.js')) return { format: 'module', shortCircuit: true, source: "export function createMemoryPolicy(...args) { globalThis.policyArguments.push(args); throw new Error('stop before resource creation'); }" };
      return nextLoad(url, context);
    }});
    globalThis.policyArguments = [];
    const { SandboxSession } = await import('./dist/sandbox-session.js');
    const memory = { url: new URL('https://memory.example/health'), credentialProvider: { mint: async () => { throw new Error(); } } };
    for (const options of [{}, { memoryRuntime: true, serviceGatewayUrl: new URL('https://services.example/') }]) {
      const result = await new SandboxSession({ raw: {}, memory, ...options }).run('image', { action: 'start', prompt: 'x', scripts: [] }, {});
      if (result.stage !== 'policy' || result.completion !== 'not-created') throw new Error('unexpected session result');
    }
    console.log(JSON.stringify(globalThis.policyArguments.map(args => ({ count: args.length, options: args[4] }))));
  `;
  const result = spawnSync(process.execPath, ["--import", "./test/register-sdk-hook.mjs", "--input-type=module", "--eval", source], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { count: 5, options: { memoryRuntime: false } },
    { count: 5, options: { memoryRuntime: true, serviceGatewayUrl: "https://services.example/" } },
  ]);
});

test("public egress flag merges the static rule into the sandbox policy without credential bindings", async () => {
  const enabled = fixture({ publicEgress: true });
  const result = await enabled.session.run(image, decision, {});
  assert.equal(result.outcome, "passed");
  assert.equal(result.completion, "gone");
  const enabledPolicy = enabled.calls.find((call) => call.name === "createSandbox").request.spec.policy;
  const egress = enabledPolicy.networkPolicies.public_egress;
  assert.ok(egress, "public_egress rule must be present when the flag is set");
  assert.deepEqual(egress, createPublicEgressRule());
  for (const endpoint of egress.endpoints) {
    // Security invariant: raw-tunnel L4, no supervisor TLS interception,
    // no credential binding.
    assert.equal(endpoint.credentialBinding, undefined);
    assert.equal(endpoint.providerCredentialed ?? false, false);
    assert.equal(endpoint.protocol, "");
    assert.equal(endpoint.tls, NetworkTlsMode.SKIP);
    assert.equal(endpoint.port, 443);
  }
  assert.ok(enabledPolicy.networkPolicies.memory_health, "memory rule is preserved alongside the egress rule");

  const disabled = fixture({ publicEgress: false });
  const disabledResult = await disabled.session.run(image, decision, {});
  assert.equal(disabledResult.outcome, "passed");
  const disabledPolicy = disabled.calls.find((call) => call.name === "createSandbox").request.spec.policy;
  assert.equal(disabledPolicy.networkPolicies.public_egress, undefined, "flag off must leave the policy unchanged");
  assert.ok(disabledPolicy.networkPolicies.memory_health);

  const modelProxy = fixture({ publicEgress: true, modelProxyUrl: new URL("https://model-gateway.example.test/v1") });
  const combined = await modelProxy.session.run(image, decision, {});
  assert.equal(combined.outcome, "passed");
  const combinedPolicy = modelProxy.calls.find((call) => call.name === "createSandbox").request.spec.policy;
  assert.deepEqual(
    Object.keys(combinedPolicy.networkPolicies),
    ["memory_health", "model_proxy", "public_egress"],
  );
});

test("extra effective network rules fail closed only while public egress is enabled", async () => {
  // A Gateway-added rule shadowing a public host:port with an intercepted
  // (non-skip) endpoint could expose globally resolved credentials; the
  // effective key set must match the requested set exactly.
  const shadowRule = () => create(SandboxPolicySchema, {
    networkPolicies: { shadow: { name: "shadow", endpoints: [{ host: "github.com", port: 443, protocol: "rest", tls: NetworkTlsMode.UNSPECIFIED, enforcement: NetworkEnforcementMode.ENFORCE, rules: [{ allow: { method: "GET", path: "/**" } }] }] } },
  }).networkPolicies.shadow;

  const enabled = fixture({ publicEgress: true, enrichPolicy: (policy) => { policy.networkPolicies.shadow = shadowRule(); } });
  const enabledResult = await enabled.session.run(image, decision, {});
  assert.equal(enabledResult.outcome, "unknown");
  assert.equal(enabledResult.stage, "readiness");
  assert.equal(enabledResult.errorCode, "other");
  assert.equal(enabledResult.completion, "gone");
  assert.equal(enabledResult.cleanup, "deleted");

  // Flag off: additive Gateway baselines keep today's permissive contract.
  const legacy = fixture({ enrichPolicy: (policy) => { policy.networkPolicies.extra_baseline = shadowRule(); } });
  const legacyResult = await legacy.session.run(image, decision, {});
  assert.equal(legacyResult.outcome, "passed");
  assert.equal(legacyResult.completion, "gone");
});

test("strict public egress tolerates only the exact reserved provider rule", async () => {
  // Regression (REHOR-245): the real Gateway (>= 0.1.6) attaches a reserved
  // `_provider_<attached-provider>` rule on provider attachment; strict mode
  // rejected it and every healthy session failed at the readiness stage.
  const healthy = fixture({ publicEgress: true });
  const healthyResult = await healthy.session.run(image, decision, {});
  assert.equal(healthyResult.outcome, "passed");
  assert.equal(healthyResult.completion, "gone");
  assert.equal(healthyResult.cleanup, "deleted");

  // A reserved-shaped rule for a different provider is not exempt.
  const impostor = fixture({
    publicEgress: true,
    enrichPolicy: (policy) => {
      policy.networkPolicies._provider_someone_else = create(SandboxPolicySchema, {
        networkPolicies: { _provider_someone_else: { name: "_provider_someone_else" } },
      }).networkPolicies._provider_someone_else;
    },
  });
  const impostorResult = await impostor.session.run(image, decision, {});
  assert.equal(impostorResult.outcome, "unknown");
  assert.equal(impostorResult.stage, "readiness");
  assert.equal(impostorResult.errorCode, "other");
});

test("mutating a public endpoint away from raw TLS skip fails the effective policy check", async () => {
  // An effective public endpoint whose TLS mode was widened from SKIP
  // must fail closed.
  const mutated = fixture({
    publicEgress: true,
    enrichPolicy: (policy) => {
      for (const endpoint of policy.networkPolicies.public_egress.endpoints) endpoint.tls = NetworkTlsMode.UNSPECIFIED;
    },
  });
  const result = await mutated.session.run(image, decision, {});
  assert.equal(result.outcome, "unknown");
  assert.equal(result.stage, "readiness");
  assert.equal(result.completion, "gone");
  assert.equal(result.cleanup, "deleted");
});

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

test("production writer creates exact bytes at mode 0600 and refuses existing files or symlinks", async () => {
  const f = fixture();
  await f.session.run(image, decision, {});
  const writer = f.calls.find((call) => call.name === "execSandbox").request;
  const directory = mkdtempSync(join(tmpdir(), "rehor-input-writer-"));
  const target = join(directory, "input.json");
  const command = writer.command[2].replace(JSON.stringify(INPUT_FILE_PATH), JSON.stringify(target));
  const bytes = writer.stdin;
  try {
    execFileSync("python3", ["-c", command], { input: bytes });
    assert.deepEqual(readFileSync(target), bytes);
    assert.equal(statSync(target).mode & 0o777, 0o600);

    const existing = Buffer.from("preserve existing file");
    writeFileSync(target, existing, { mode: 0o644 });
    assert.equal(spawnSync("python3", ["-c", command], { input: bytes }).status, 1);
    assert.deepEqual(readFileSync(target), existing);

    const victim = join(directory, "victim");
    const link = join(directory, "linked-input.json");
    const victimBytes = Buffer.from("do not follow symlink");
    writeFileSync(victim, victimBytes);
    symlinkSync(victim, link);
    const linkCommand = writer.command[2].replace(JSON.stringify(INPUT_FILE_PATH), JSON.stringify(link));
    assert.equal(spawnSync("python3", ["-c", linkCommand], { input: bytes }).status, 1);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(readFileSync(victim), victimBytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
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
  const result = await new SandboxSession({ raw: f.raw, memory: f.memory }).run(image, decision, {});
  assert.equal(result.completion, "gone");
  const policy = f.calls.find((call) => call.name === "createSandbox").request.spec.policy;
  assert.deepEqual(Object.keys(policy.networkPolicies), ["memory_health"]);
  const rule = policy.networkPolicies.memory_health;
  assert.equal(rule.endpoints[0].host, "memory.example.test");
  assert.deepEqual(rule.endpoints[0].rules, [{ allow: { method: "GET", path: "/health" } }]);
  assert.deepEqual(rule.binaries, [{ path: "/usr/bin/python3.12" }, { path: "/usr/local/bin/node" }, { path: "/usr/local/nvm/versions/node/*/bin/node" }]);
  assert.deepEqual(policy.filesystem.readOnly, ["/home/botuser/app"]);
  assert.deepEqual(policy.filesystem.readWrite, ["/home/botuser/repos", "/home/botuser/data", "/tmp"]);
  assert.equal(f.calls.filter((call) => call.name === "execSandbox").length, 2);
});

test("model proxy URL dispatches with the model-gateway rule verified against the effective policy", async () => {
  const f = fixture({ modelProxyUrl: new URL("https://model-gateway.example.test/v1") });
  const result = await f.session.run(image, decision, {});
  assert.equal(result.outcome, "passed");
  assert.equal(result.completion, "gone");
  assert.equal(result.cleanup, "deleted");
  const policy = f.calls.find((call) => call.name === "createSandbox").request.spec.policy;
  assert.deepEqual(Object.keys(policy.networkPolicies), ["memory_health", "model_proxy"]);
  const rule = policy.networkPolicies.model_proxy;
  assert.equal(rule.name, "model-proxy");
  assert.equal(rule.endpoints[0].host, "model-gateway.example.test");
  assert.equal(rule.endpoints[0].port, 443);
  assert.equal(rule.endpoints[0].path, "/v1/**");
  assert.deepEqual(rule.endpoints[0].rules, [
    { allow: { method: "GET", path: "/v1/models" } },
    { allow: { method: "POST", path: "/v1/chat/completions" } },
    { allow: { method: "POST", path: "/v1/responses" } },
  ]);
  assert.deepEqual(rule.endpoints[0].credentialBinding, { provider: result.provider.name });
  assert.deepEqual(rule.binaries, [{ path: "/opt/opencode/bin/opencode" }, { path: "/usr/local/bin/node" }, { path: "/usr/local/nvm/versions/node/*/bin/node" }]);
  assert.equal(f.calls.filter((call) => call.name === "execSandbox").length, 2);
});

test("model proxy rule drift fails before writer or runner", async () => {
  for (const enrichPolicy of [
    (policy) => { policy.networkPolicies.model_proxy.endpoints[0].rules[1].allow.method = "GET"; },
    (policy) => { policy.networkPolicies.model_proxy.endpoints[0].credentialBinding.provider = "someone-else"; },
    (policy) => { policy.networkPolicies.model_proxy.endpoints[0].providerCredentialed = false; },
    (policy) => { delete policy.networkPolicies.model_proxy; },
  ]) {
    const f = fixture({ modelProxyUrl: new URL("https://model-gateway.example.test/v1"), enrichPolicy });
    const result = await f.session.run(image, decision, {});
    assert.equal(result.outcome, "unknown");
    assert.equal(result.stage, "readiness");
    assert.equal(result.completion, "gone");
    assert.equal(result.cleanup, "deleted");
    assert.equal(f.calls.some((call) => call.name === "execSandbox"), false);
  }
});

test("Git gateway rule is checked against effective policy before runner starts", async () => {
  const serviceGatewayUrl = new URL("https://service-gateway.example.test:8454");
  const valid = fixture();
  const result = await new SandboxSession({ raw: valid.raw, memory: valid.memory, serviceGatewayUrl }).run(image, decision, {});
  assert.equal(result.outcome, "passed");
  const git = valid.calls.find((call) => call.name === "createSandbox").request.spec.policy.networkPolicies.service_gateway_git;
  assert.equal(git.endpoints[0].host, serviceGatewayUrl.hostname);
  assert.deepEqual(git.endpoints[0].credentialBinding, { provider: result.provider.name });
  assert.equal(valid.calls.filter((call) => call.name === "execSandbox").length, 2);

  for (const enrichPolicy of [
    (policy) => { policy.networkPolicies.service_gateway_git.endpoints[0].path = "/**"; },
    (policy) => { policy.networkPolicies.service_gateway_git.endpoints[0].rules[0].allow.method = "PUT"; },
    (policy) => { policy.networkPolicies.service_gateway_git.endpoints[0].host = "other.example.test"; },
    (policy) => { policy.networkPolicies.service_gateway_git.endpoints[0].credentialBinding.provider = "someone-else"; },
    (policy) => { policy.networkPolicies.service_gateway_git.endpoints[0].providerCredentialed = false; },
    (policy) => { policy.networkPolicies.service_gateway_git.binaries[0].path = "/usr/bin/curl"; },
    (policy) => { delete policy.networkPolicies.service_gateway_git; },
  ]) {
    const f = fixture({ enrichPolicy });
    const rejected = await new SandboxSession({ raw: f.raw, memory: f.memory, serviceGatewayUrl }).run(image, decision, {});
    assert.equal(rejected.outcome, "unknown");
    assert.equal(rejected.stage, "readiness");
    assert.equal(rejected.completion, "gone");
    assert.equal(rejected.cleanup, "deleted");
    assert.equal(f.calls.some((call) => call.name === "execSandbox"), false);
  }
});

test("canonical unqualified profile image dispatches under additive Gateway policy", async () => {
  const f = fixture({ enrichPolicy: (policy) => policy.filesystem.readWrite.push("/home/botuser/app-cache") });
  const result = await f.session.run("onboarding:latest", decision, {});
  assert.equal(result.outcome, "passed");
  assert.equal(result.completion, "gone");
  assert.equal(f.calls.find((call) => call.name === "createSandbox").request.spec.template.image, "onboarding:latest");
  assert.equal(f.calls.filter((call) => call.name === "execSandbox").length, 2);
});

test("private runtime uses configurable paths and accepts safe exact Gateway filesystem additions", async () => {
  const runtime = readRuntimeLayout({ AGENT_DISPATCHER_RUNTIME_LAYOUT: "private", AGENT_DISPATCHER_RUNTIME_SOURCE: "/opt/custom/app", AGENT_DISPATCHER_RUNTIME_PARENT: "/sandbox" });
  const f = fixture({ enrichPolicy: (policy) => {
    policy.filesystem.readWrite.push("/run", "/var/cache");
  } });
  const result = await new SandboxSession({ raw: f.raw, memory: f.memory, runtime }).run(image, decision, {});
  assert.equal(result.outcome, "passed");
  const spec = f.calls.find((call) => call.name === "createSandbox").request.spec;
  assert.deepEqual(spec.policy.filesystem.readOnly, ["/opt/rehor", "/opt/opencode", "/opt/custom/app"]);
  assert.deepEqual(spec.policy.filesystem.readWrite, ["/tmp", "/sandbox"]);
  const [writer, runner] = f.calls.filter((call) => call.name === "execSandbox");
  assert.equal(writer.request.workdir, "/sandbox");
  assert.deepEqual(runner.request.command, ["/usr/bin/python3.12", "/opt/rehor/sandbox-bootstrap.py"]);
  assert.equal(runner.request.workdir, "/sandbox");
  assert.deepEqual(runner.request.environment, { ...INPUT_ENVIRONMENT, REHOR_RUNTIME_SOURCE: "/opt/custom/app", REHOR_RUNTIME_PARENT: "/sandbox" });
});

for (const runtime of [
  { kind: "legacy" },
  readRuntimeLayout({ AGENT_DISPATCHER_RUNTIME_LAYOUT: "private", AGENT_DISPATCHER_RUNTIME_SOURCE: "/opt/custom/app" }),
]) {
  test(`${runtime.kind} runtime accepts non-overlapping exact Gateway defaults`, async () => {
    const f = fixture({ enrichPolicy: (policy) => policy.filesystem.readWrite.push("/sandbox", "/run", "/var/cache", "/home/botuser/app-cache", "/opt/rehor-cache") });
    const result = await new SandboxSession({ raw: f.raw, memory: f.memory, runtime }).run(image, decision, {});
    assert.equal(result.outcome, "passed");
    assert.equal(result.cleanup, "deleted");
    assert.equal(f.calls.filter((call) => call.name === "execSandbox").length, 2);
  });

  test(`${runtime.kind} runtime rejects unsafe effective writes before any exec and cleans up`, async (t) => {
    const protectedPaths = runtime.kind === "legacy" ? ["/home/botuser/app"] : ["/opt/rehor", "/opt/opencode", runtime.source];
    const paths = [
      "/", ...(runtime.kind === "legacy" ? ["/home", "/home/botuser"] : ["/opt", "/opt/custom"]),
      ...protectedPaths.flatMap((path) => [path, `${path}/child`]),
      "relative", "~/cache", "/run/$CACHE", "/run/${CACHE}", "/run/$(id)", "/run/`id`", "/run/~cache",
      "/run/*", "/run/?", "/run/[ab]", "/run/{a,b}", "/run/!(cache)", "/run/+(cache)",
      "/run/../home/botuser/app", "/run/./cache", "/run//cache", "//run", "/run/", "/run/\\cache",
      "/run/\u0000cache", "/run/\ncache", "/run/\u007fcache", "/run/\u0085cache",
    ];
    for (const path of paths) await t.test(JSON.stringify(path), async () => {
      const f = fixture({ enrichPolicy: (policy) => policy.filesystem.readWrite.push(path) });
      const result = await new SandboxSession({ raw: f.raw, memory: f.memory, runtime }).run(image, decision, {});
      assert.equal(result.stage, "readiness");
      assert.equal(result.outcome, "unknown");
      assert.equal(result.completion, "gone");
      assert.equal(result.cleanup, "deleted");
      assert.equal(f.calls.some((call) => call.name === "execSandbox"), false);
      assert.deepEqual(f.resources(), { workspace: undefined, sandbox: undefined, provider: undefined, profile: undefined });
    });
  });

  test(`${runtime.kind} runtime rejects unexpected includeWorkdir before any exec`, async () => {
    const f = fixture({ enrichPolicy: (policy) => { policy.filesystem.includeWorkdir = true; } });
    const result = await new SandboxSession({ raw: f.raw, memory: f.memory, runtime }).run(image, decision, {});
    assert.equal(result.stage, "readiness");
    assert.equal(result.outcome, "unknown");
    assert.equal(result.cleanup, "deleted");
    assert.equal(result.completion, "gone");
    assert.equal(f.calls.some((call) => call.name === "execSandbox"), false);
  });
}

test("runtime layout rejects invalid, ambiguous or overlapping paths", () => {
  assert.deepEqual(readRuntimeLayout({}), { kind: "legacy" });
  // The deployment template always renders the private-layout path variables,
  // including for the default legacy layout; legacy must ignore them.
  assert.deepEqual(readRuntimeLayout({
    AGENT_DISPATCHER_RUNTIME_LAYOUT: "legacy",
    AGENT_DISPATCHER_RUNTIME_SOURCE: "/opt/rehor/app",
    AGENT_DISPATCHER_RUNTIME_PARENT: "/tmp",
  }), { kind: "legacy" });
  for (const env of [
    { AGENT_DISPATCHER_RUNTIME_LAYOUT: "unknown" },
    { AGENT_DISPATCHER_RUNTIME_LAYOUT: "private", AGENT_DISPATCHER_RUNTIME_PARENT: "/opt" },
    { AGENT_DISPATCHER_RUNTIME_LAYOUT: "private", AGENT_DISPATCHER_RUNTIME_PARENT: "/opt/opencode/state" },
    { AGENT_DISPATCHER_RUNTIME_LAYOUT: "private", AGENT_DISPATCHER_RUNTIME_SOURCE: "/tmp/app" },
    { AGENT_DISPATCHER_RUNTIME_LAYOUT: "private", AGENT_DISPATCHER_RUNTIME_PARENT: "/tmp/*" },
    { AGENT_DISPATCHER_RUNTIME_LAYOUT: "private", AGENT_DISPATCHER_RUNTIME_PARENT: "/" },
    { AGENT_DISPATCHER_RUNTIME_LAYOUT: "private", AGENT_DISPATCHER_RUNTIME_SOURCE: "relative" },
  ]) assert.throws(() => readRuntimeLayout(env));
});

test("private runtime fails closed when requested filesystem policy is missing", async () => {
  const runtime = readRuntimeLayout({ AGENT_DISPATCHER_RUNTIME_LAYOUT: "private" });
  for (const enrichPolicy of [
    ...["/opt/rehor", "/opt/opencode", runtime.source].map((missing) => (policy) => { policy.filesystem.readOnly = policy.filesystem.readOnly.filter((path) => path !== missing); }),
    (policy) => { policy.filesystem.readWrite = policy.filesystem.readWrite.filter((path) => path !== "/tmp"); },
    (policy) => { policy.filesystem = undefined; },
  ]) {
    const f = fixture({ enrichPolicy });
    const result = await new SandboxSession({ raw: f.raw, memory: f.memory, runtime }).run(image, decision, {});
    assert.equal(result.stage, "readiness");
    assert.equal(result.outcome, "unknown");
    assert.equal(result.cleanup, "deleted");
    assert.equal(result.completion, "gone");
    assert.equal(f.calls.some((call) => call.name === "execSandbox"), false);
  }
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

test("effective filesystem rejects missing supplied constraints", async () => {
  const mutations = [
    (policy) => { policy.filesystem.readOnly = policy.filesystem.readOnly.filter((path) => path !== "/home/botuser/app"); },
    ...["/home/botuser/repos", "/home/botuser/data", "/tmp"].map((missing) => (policy) => { policy.filesystem.readWrite = policy.filesystem.readWrite.filter((path) => path !== missing); }),
    (policy) => { policy.filesystem = undefined; },
  ];
  for (const enrichPolicy of mutations) {
    const f = fixture({ enrichPolicy });
    const result = await f.session.run(image, decision, {});
    assert.equal(result.outcome, "unknown");
    assert.equal(result.stage, "readiness");
    assert.equal(result.cleanup, "deleted");
    assert.equal(result.completion, "gone");
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

test("transient readiness and cleanup errors retry without losing the session", async () => {
  const f = fixture({ configFailures: 1, providerStatusFailures: 1, cleanupReadFailures: 1, cleanupSandboxReadFailures: 1, transientDelete: true });
  const result = await f.session.run(image, decision, {});
  assert.equal(result.outcome, "passed");
  assert.equal(result.completion, "gone");
  assert.equal(result.cleanup, "deleted");
  const deletes = f.calls.filter((call) => call.name === "deleteSandbox");
  assert.equal(deletes.length, 2);
  assert.equal(deletes[0].request.requestId, deletes[1].request.requestId);
});

test("lost delete response reconciles absence instead of retrying mutation", async () => {
  const f = fixture({ transientDeleteAfterCommit: true });
  const result = await f.session.run(image, decision, {});
  assert.equal(result.completion, "gone");
  assert.equal(result.cleanup, "deleted");
  assert.equal(f.calls.filter((call) => call.name === "deleteSandbox").length, 1);
});

test("one shared cleanup budget stops slow reads and records unresolved cleanup", async () => {
  const f = fixture({ cleanupBudgetMs: 1, slowCleanup: true });
  const result = await f.session.run(image, decision, {});
  assert.equal(result.completion, "unknown");
  assert.equal(result.cleanup, "unknown");
  assert.equal(result.errorCode, "deadline_exceeded");
  assert.equal(f.calls.some((call) => call.name === "deleteSandbox"), false);
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

test("accepted deletion without confirmed sandbox absence retains resources and admission", async () => {
  const f = fixture({ cleanupBudgetMs: 100 });
  f.raw.deleteSandbox = async (request) => {
    f.calls.push({ name: "deleteSandbox", request });
    return { sandboxId: f.resources().sandbox.metadata.id, outcome: DeletionOutcome.ACCEPTED };
  };
  const dispatcher = new SessionDispatcher();
  let result;
  const admitted = dispatcher.dispatch("agent", decision, async () => {
    result = await f.session.run(image, decision, {});
    return result.completion;
  });
  assert.equal(admitted.status, "started");
  assert.equal(await admitted.completion, "unknown");
  assert.equal(result.outcome, "unknown");
  assert.equal(result.cleanup, "unknown");
  assert.equal(result.errorCode, "deadline_exceeded");
  assert.equal(dispatcher.status("agent"), "retained");
  assert.ok(f.resources().sandbox);
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

test("delayed workspace create stays unknown and retains its agent reservation", async () => {
  const f = fixture({ delayedCreate: "workspace" });
  const dispatcher = new SessionDispatcher();
  const admitted = dispatcher.dispatch("agent", decision, async () => {
    const result = await f.session.run(image, decision, {});
    assert.equal(result.cleanup, "unknown");
    return result.completion;
  });
  assert.equal(admitted.status, "started");
  assert.equal(await admitted.completion, "unknown");
  assert.equal(dispatcher.status("agent"), "retained");
  assert.deepEqual(dispatcher.dispatch("agent", decision, () => "gone"), { status: "busy" });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(f.workspace(), "delayed create became visible after cleanup read");
  assert.equal(dispatcher.status("agent"), "retained");
  assert.deepEqual(dispatcher.dispatch("agent", decision, () => "gone"), { status: "busy" });
  assert.equal(f.calls.some((call) => call.name === "deleteWorkspace"), false);
});

test("delayed profile, provider and sandbox creates block dependent cleanup", async () => {
  for (const resource of ["profile", "provider", "sandbox"]) {
    const f = fixture({ delayedCreate: resource });
    const result = await f.session.run(image, decision, {});
    assert.equal(result.completion, "unknown", `${resource} completion`);
    assert.equal(result.cleanup, "unknown", `${resource} cleanup`);
    assert.equal(f.calls.some((call) => call.name === "deleteWorkspace"), false, `${resource} must retain workspace`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(f.resources()[resource], `${resource} became visible after cleanup read`);
    if (resource === "sandbox") {
      assert.equal(f.calls.some((call) => ["deleteProvider", "deleteProviderProfile"].includes(call.name)), false);
    }
  }
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
