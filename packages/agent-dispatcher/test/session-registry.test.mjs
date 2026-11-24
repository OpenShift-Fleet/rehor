import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { SandboxPhase } from "@nvidia/openshell-sdk/raw";
import { createSessionRegistryClient, reconcileOpenSessions } from "../dist/session-registry.js";

// Minimal fake fetch routing by path; handlers are either fixed response
// shapes or functions of the captured request.
function harness(handlers) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const request = { url: String(url), method: init.method, headers: { ...init.headers }, body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(request);
    const handler = handlers[new URL(String(url)).pathname];
    if (!handler) return { status: 404, json: async () => ({}) };
    const response = typeof handler === "function" ? handler(request) : handler;
    return { status: response.status, json: async () => response.body };
  };
  return { requests, fetchImpl };
}

const client = (fetchImpl) => createSessionRegistryClient({
  url: new URL("https://memory.example/health"),
  mint: async () => "synthetic-bearer",
  fetchImpl,
});

const recordJson = {
  run_id: "01234567-89ab-cdef-0123-456789abcdef",
  agent_id: "agent-1",
  holder: "pod-old",
  lock_token: "tok-9",
  state: "open",
  workspace_name: "w123456789012345678",
  sandbox_name: "s123456789012345678",
  provider_name: "v123456789012345678",
  profile_name: "p123456789012345678",
  started_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:10:00Z",
  detail: { reason: "x" },
};

test("registry client sends exact request shapes with minted bearers", async () => {
  const { requests, fetchImpl } = harness({
    "/api/session-registry/register": { status: 200, body: { registered: true } },
    "/api/session-registry/update": { status: 200, body: { updated: true, record: recordJson } },
    "/api/session-registry": { status: 200, body: [recordJson] },
  });
  const registry = client(fetchImpl);
  assert.equal(await registry.register({ runId: "run-1", agentId: "agent-1", holder: "pod-a", lockToken: "tok-1" }), true);
  assert.equal(
    await registry.update("run-1", {
      state: "completed",
      workspaceName: "w1",
      sandboxName: "s1",
      providerName: "v1",
      profileName: "p1",
      detail: { outcome: "passed" },
    }),
    true,
  );
  assert.deepEqual(await registry.listOpen(), [{
    runId: recordJson.run_id,
    agentId: recordJson.agent_id,
    holder: recordJson.holder,
    lockToken: recordJson.lock_token,
    state: recordJson.state,
    workspaceName: recordJson.workspace_name,
    sandboxName: recordJson.sandbox_name,
    providerName: recordJson.provider_name,
    profileName: recordJson.profile_name,
    startedAt: recordJson.started_at,
    updatedAt: recordJson.updated_at,
    detail: recordJson.detail,
  }]);
  assert.deepEqual(requests.map((request) => [request.method, request.url]), [
    ["POST", "https://memory.example/api/session-registry/register"],
    ["POST", "https://memory.example/api/session-registry/update"],
    ["GET", "https://memory.example/api/session-registry?state=open"],
  ]);
  for (const request of requests) {
    assert.equal(request.headers.authorization, "Bearer synthetic-bearer");
    if (request.method === "POST") assert.equal(request.headers["content-type"], "application/json");
    else assert.equal(request.headers["content-type"], undefined);
  }
  assert.deepEqual(requests[0].body, { run_id: "run-1", agent_id: "agent-1", holder: "pod-a", lock_token: "tok-1" });
  assert.deepEqual(requests[1].body, {
    run_id: "run-1",
    state: "completed",
    workspace_name: "w1",
    sandbox_name: "s1",
    provider_name: "v1",
    profile_name: "p1",
    detail: { outcome: "passed" },
  });
  assert.equal(new URL(requests[2].url).search, "?state=open");
});

test("registry client omits absent fields and maps optional nulls", async () => {
  const { requests, fetchImpl } = harness({
    "/api/session-registry/register": { status: 200, body: { registered: true } },
    "/api/session-registry/update": { status: 200, body: { updated: true } },
    "/api/session-registry": {
      status: 200,
      body: [
        { run_id: "r1", agent_id: "a1" },
        "malformed",
        { run_id: "r2", agent_id: "a2", holder: "pod-b", state: "open" },
      ],
    },
  });
  const registry = client(fetchImpl);
  assert.equal(await registry.register({ runId: "r1", agentId: "a1", holder: "pod-a" }), true);
  assert.equal(await registry.update("r1", { state: "abandoned" }), true);
  assert.deepEqual(requests[0].body, { run_id: "r1", agent_id: "a1", holder: "pod-a" });
  assert.deepEqual(requests[1].body, { run_id: "r1", state: "abandoned" });
  assert.deepEqual(await registry.listOpen(), [
    { runId: "r1", agentId: "a1", holder: "", lockToken: null, state: "", workspaceName: null, sandboxName: null, providerName: null, profileName: null, startedAt: "", updatedAt: "", detail: null },
    { runId: "r2", agentId: "a2", holder: "pod-b", lockToken: null, state: "open", workspaceName: null, sandboxName: null, providerName: null, profileName: null, startedAt: "", updatedAt: "", detail: null },
  ]);
});

test("registry client maps failures to false and empty, never throwing", async () => {
  for (const register of [
    { status: 200, body: { registered: false } },
    { status: 200, body: {} },
    { status: 500, body: {} },
  ]) {
    const { fetchImpl } = harness({ "/api/session-registry/register": register });
    assert.equal(await client(fetchImpl).register({ runId: "r", agentId: "a", holder: "h" }), false);
  }
  for (const update of [
    { status: 200, body: { updated: false } },
    { status: 404, body: { updated: false } },
    { status: 500, body: {} },
  ]) {
    const { fetchImpl } = harness({ "/api/session-registry/update": update });
    assert.equal(await client(fetchImpl).update("r", { state: "completed" }), false);
  }
  for (const list of [{ status: 200, body: {} }, { status: 200, body: "nope" }, { status: 500, body: {} }]) {
    const { fetchImpl } = harness({ "/api/session-registry": list });
    assert.deepEqual(await client(fetchImpl).listOpen(), []);
  }
  const throwing = async () => { throw new Error("network-secret"); };
  const failing = client(throwing);
  assert.equal(await failing.register({ runId: "r", agentId: "a", holder: "h" }), false);
  assert.equal(await failing.update("r", { state: "completed" }), false);
  assert.deepEqual(await failing.listOpen(), []);
  const failingMint = createSessionRegistryClient({
    url: new URL("https://memory.example/health"),
    mint: async () => { throw new Error("mint-secret"); },
    fetchImpl: throwing,
  });
  assert.equal(await failingMint.register({ runId: "r", agentId: "a", holder: "h" }), false);
  assert.deepEqual(await failingMint.listOpen(), []);
});

// ---- reconcileOpenSessions -------------------------------------------------

const registryRecord = (fields = {}) => ({
  runId: randomUUID(),
  agentId: "agent-1",
  holder: "pod-old",
  lockToken: "tok-9",
  state: "open",
  workspaceName: "w00000000000000000a",
  sandboxName: "s00000000000000000a",
  providerName: "v00000000000000000a",
  profileName: "p00000000000000000a",
  startedAt: "t0",
  updatedAt: "t1",
  detail: null,
  ...fields,
});

const fakeRegistry = (records, { updateResult = true } = {}) => {
  const updates = [];
  return {
    updates,
    async register() { return true; },
    async update(runId, fields) { updates.push({ runId, fields }); return updateResult; },
    async listOpen() { return records; },
  };
};

const fakeLock = ({ releaseResult = true } = {}) => {
  const releases = [];
  return {
    releases,
    async release(key, token) { releases.push({ key, token }); return releaseResult; },
  };
};

const fakeLog = () => {
  const entries = [];
  const log = (event, status, data) => entries.push({ event, status, data });
  log.entries = entries;
  return log;
};

const ownedLabels = (runId) => ({ "rehor-session": "agent", "rehor-run-id": runId });

// Fake gateway: resources exist unless disabled; getSandbox walks the given
// phase sequence (last value repeats) so adoption polls observe transitions.
function fakeGateway(options = {}) {
  const calls = [];
  let reads = 0;
  const scopeOf = (request) => request.workspaceScope?.selection?.value;
  const gateway = {
    calls,
    async getWorkspace(request) {
      calls.push({ name: "getWorkspace", request });
      if (options.workspace === false) throw new ConnectError("private", Code.NotFound);
      return { workspace: { metadata: { name: request.name, labels: options.labels ?? ownedLabels(options.runId) } } };
    },
    async getSandbox(request) {
      calls.push({ name: "getSandbox", request });
      if (options.sandbox === false) throw new ConnectError("private", Code.NotFound);
      const sequence = options.phases ?? [options.phase ?? SandboxPhase.READY];
      const phase = sequence[Math.min(reads, sequence.length - 1)];
      reads++;
      return { sandbox: { metadata: { name: request.name, workspace: scopeOf(request), labels: options.labels ?? ownedLabels(options.runId) }, status: { phase } } };
    },
    async deleteSandbox(request) { calls.push({ name: "deleteSandbox", request }); return { sandboxId: "id", outcome: 2 }; },
    async deleteProvider(request) { calls.push({ name: "deleteProvider", request }); return {}; },
    async deleteProviderProfile(request) { calls.push({ name: "deleteProviderProfile", request }); return {}; },
    async deleteWorkspace(request) { calls.push({ name: "deleteWorkspace", request }); return {}; },
  };
  return gateway;
}

const reconcile = (options) => reconcileOpenSessions({
  holder: "pod-current",
  pollIntervalMs: 5,
  adoptTimeoutMs: 5_000,
  ...options,
});

test("reconciliation skips records owned by the current holder", async () => {
  const record = registryRecord({ holder: "pod-current" });
  const gateway = fakeGateway({ runId: record.runId });
  const registry = fakeRegistry([record]);
  const lock = fakeLock();
  const log = fakeLog();
  await reconcile({ registry, lockClient: lock, gateway, log });
  assert.deepEqual(gateway.calls, []);
  assert.deepEqual(registry.updates, []);
  assert.deepEqual(lock.releases, []);
  assert.deepEqual(log.entries, []);
});

test("records without provisioned names are abandoned without gateway calls", async () => {
  const record = registryRecord({ workspaceName: null, sandboxName: null });
  const gateway = fakeGateway({ runId: record.runId });
  const registry = fakeRegistry([record]);
  const lock = fakeLock();
  const log = fakeLog();
  await reconcile({ registry, lockClient: lock, gateway, log });
  assert.deepEqual(gateway.calls, []);
  assert.deepEqual(registry.updates, [{ runId: record.runId, fields: { state: "abandoned", detail: { reason: "never-provisioned" } } }]);
  assert.deepEqual(lock.releases, [{ key: "agent-session:agent-1", token: "tok-9" }]);
  assert.deepEqual(log.entries, [
    { event: "sandbox.reconcile", status: "success", data: { runId: record.runId, reason: "never-provisioned", adopted: false } },
  ]);
});

test("a vanished workspace abandons the record and releases the stored lock token", async () => {
  const record = registryRecord();
  const gateway = fakeGateway({ runId: record.runId, workspace: false });
  const registry = fakeRegistry([record]);
  const lock = fakeLock();
  const log = fakeLog();
  await reconcile({ registry, lockClient: lock, gateway, log });
  assert.deepEqual(gateway.calls.map((call) => call.name), ["getWorkspace"]);
  assert.deepEqual(registry.updates, [{ runId: record.runId, fields: { state: "abandoned", detail: { reason: "workspace-gone" } } }]);
  assert.deepEqual(lock.releases, [{ key: `agent-session:${record.agentId}`, token: "tok-9" }]);
  assert.deepEqual(log.entries[0].data, { runId: record.runId, reason: "workspace-gone", adopted: false });
});

test("a vanished sandbox cleans up leftover dependencies and abandons the record", async () => {
  const record = registryRecord();
  const gateway = fakeGateway({ runId: record.runId, sandbox: false });
  const registry = fakeRegistry([record]);
  const lock = fakeLock();
  await reconcile({ registry, lockClient: lock, gateway, log: fakeLog() });
  const names = gateway.calls.map((call) => call.name);
  assert.deepEqual(names, ["getWorkspace", "getSandbox", "deleteProvider", "deleteProviderProfile", "deleteWorkspace"]);
  const workspaceScope = { selection: { case: "workspace", value: record.workspaceName } };
  assert.deepEqual(gateway.calls.find((call) => call.name === "deleteProvider").request, {
    workspaceScope, name: record.providerName, allowMissing: true, requestId: gateway.calls[2].request.requestId,
  });
  assert.deepEqual(gateway.calls.find((call) => call.name === "deleteProviderProfile").request, {
    workspaceScope, id: record.profileName, allowMissing: true, requestId: gateway.calls[3].request.requestId,
  });
  assert.deepEqual(gateway.calls.find((call) => call.name === "deleteWorkspace").request, {
    name: record.workspaceName, allowMissing: true, requestId: gateway.calls[4].request.requestId,
  });
  for (const call of gateway.calls) {
    if (call.request.requestId !== undefined) assert.match(call.request.requestId, /^[0-9a-f-]{36}$/);
  }
  assert.deepEqual(registry.updates, [{ runId: record.runId, fields: { state: "abandoned", detail: { reason: "sandbox-gone" } } }]);
  assert.deepEqual(lock.releases, [{ key: `agent-session:${record.agentId}`, token: "tok-9" }]);
});

test("a terminal sandbox is cleaned up including the sandbox itself", async () => {
  const record = registryRecord();
  const gateway = fakeGateway({ runId: record.runId, phase: SandboxPhase.COMPLETED });
  const registry = fakeRegistry([record]);
  const lock = fakeLock();
  await reconcile({ registry, lockClient: lock, gateway, log: fakeLog() });
  assert.deepEqual(gateway.calls.map((call) => call.name), [
    "getWorkspace", "getSandbox", "deleteSandbox", "deleteProvider", "deleteProviderProfile", "deleteWorkspace",
  ]);
  assert.deepEqual(gateway.calls.find((call) => call.name === "deleteSandbox").request, {
    workspaceScope: { selection: { case: "workspace", value: record.workspaceName } },
    name: record.sandboxName,
    requestId: gateway.calls[2].request.requestId,
  });
  assert.deepEqual(registry.updates, [{ runId: record.runId, fields: { state: "completed", detail: { reason: "reconciled-terminal" } } }]);
  assert.deepEqual(lock.releases, [{ key: `agent-session:${record.agentId}`, token: "tok-9" }]);
});

test("a running sandbox is adopted until terminal, then cleaned up and completed", async () => {
  const record = registryRecord();
  const gateway = fakeGateway({ runId: record.runId, phases: [SandboxPhase.READY, SandboxPhase.READY, SandboxPhase.COMPLETED] });
  const registry = fakeRegistry([record]);
  const lock = fakeLock();
  const log = fakeLog();
  const startedAt = Date.now();
  await reconcile({ registry, lockClient: lock, gateway, log, pollIntervalMs: 5, adoptTimeoutMs: 5_000 });
  assert.ok(Date.now() - startedAt >= 10, "at least two polls ran");
  assert.equal(gateway.calls.filter((call) => call.name === "getSandbox").length, 3);
  assert.deepEqual(gateway.calls.map((call) => call.name), [
    "getWorkspace", "getSandbox", "getSandbox", "getSandbox",
    "deleteSandbox", "deleteProvider", "deleteProviderProfile", "deleteWorkspace",
  ]);
  assert.deepEqual(registry.updates, [{ runId: record.runId, fields: { state: "completed", detail: { reason: "adopted" } } }]);
  assert.deepEqual(lock.releases, [{ key: `agent-session:${record.agentId}`, token: "tok-9" }]);
  assert.deepEqual(log.entries[0].data, { runId: record.runId, reason: "adopted", adopted: true });
});

test("adoption timeout abandons the record without deleting anything or releasing the lock", async () => {
  const record = registryRecord();
  const gateway = fakeGateway({ runId: record.runId, phase: SandboxPhase.READY });
  const registry = fakeRegistry([record]);
  const lock = fakeLock();
  const log = fakeLog();
  await reconcile({ registry, lockClient: lock, gateway, log, pollIntervalMs: 5, adoptTimeoutMs: 60 });
  assert.equal(gateway.calls.some((call) => call.name.startsWith("delete")), false);
  assert.ok(gateway.calls.filter((call) => call.name === "getSandbox").length >= 2, "polling retried before timing out");
  assert.deepEqual(registry.updates, [{ runId: record.runId, fields: { state: "abandoned", detail: { reason: "adopt-timeout" } } }]);
  assert.deepEqual(lock.releases, []);
  assert.deepEqual(log.entries[0].data, { runId: record.runId, reason: "adopt-timeout", adopted: true });
});

test("a record whose gateway read fails is logged and left open without blocking the rest", async () => {
  const a = registryRecord({ agentId: "agent-a", workspaceName: "wa", sandboxName: "sa", providerName: "va", profileName: "pa" });
  const b = registryRecord({ agentId: "agent-b", workspaceName: "wb", sandboxName: "sb", providerName: "vb", profileName: "pb" });
  const calls = [];
  const gateway = {
    async getWorkspace(request) {
      calls.push(`getWorkspace:${request.name}`);
      if (request.name === "wa") throw new ConnectError("private", Code.Unavailable);
      return { workspace: { metadata: { name: request.name, labels: ownedLabels(b.runId) } } };
    },
    async getSandbox() { calls.push("getSandbox"); throw new ConnectError("private", Code.NotFound); },
    async deleteSandbox() { calls.push("deleteSandbox"); },
    async deleteProvider(request) { calls.push(`deleteProvider:${request.name}`); },
    async deleteProviderProfile(request) { calls.push(`deleteProviderProfile:${request.id}`); },
    async deleteWorkspace(request) { calls.push(`deleteWorkspace:${request.name}`); },
  };
  const registry = fakeRegistry([a, b]);
  const lock = fakeLock();
  const log = fakeLog();
  await reconcile({ registry, lockClient: lock, gateway, log });
  // Record A failed and was left open; record B was fully reconciled.
  assert.deepEqual(registry.updates, [{ runId: b.runId, fields: { state: "abandoned", detail: { reason: "sandbox-gone" } } }]);
  assert.deepEqual(log.entries.map(({ status, data }) => [status, data.reason]), [
    ["failure", "record-failure"],
    ["success", "sandbox-gone"],
  ]);
  assert.equal(log.entries[0].data.runId, a.runId);
  assert.deepEqual(lock.releases, [{ key: `agent-session:${b.agentId}`, token: "tok-9" }]);
  assert.deepEqual(calls, ["getWorkspace:wa", "getWorkspace:wb", "getSandbox", "deleteProvider:vb", "deleteProviderProfile:pb", "deleteWorkspace:wb"]);
});

test("resources not owned by the record are never deleted", async () => {
  const record = registryRecord();
  const gateway = fakeGateway({ runId: record.runId, labels: { "rehor-session": "someone-else", "rehor-run-id": randomUUID() } });
  const registry = fakeRegistry([record]);
  const lock = fakeLock();
  const log = fakeLog();
  await reconcile({ registry, lockClient: lock, gateway, log });
  assert.deepEqual(gateway.calls.map((call) => call.name), ["getWorkspace"]);
  assert.deepEqual(registry.updates, []);
  assert.deepEqual(lock.releases, []);
  assert.deepEqual(log.entries, [{ event: "sandbox.reconcile", status: "failure", data: { runId: record.runId, reason: "record-failure" } }]);
});

test("failed registry updates and lock releases are logged without blocking the outcome", async () => {
  const record = registryRecord();
  const gateway = fakeGateway({ runId: record.runId, workspace: false });
  const registry = fakeRegistry([record], { updateResult: false });
  const lock = fakeLock({ releaseResult: false });
  const log = fakeLog();
  await reconcile({ registry, lockClient: lock, gateway, log });
  assert.deepEqual(registry.updates.length, 1);
  assert.deepEqual(lock.releases, [{ key: `agent-session:${record.agentId}`, token: "tok-9" }]);
  assert.deepEqual(log.entries.map(({ status, data }) => [status, data]), [
    ["failure", { runId: record.runId, reason: "workspace-gone", adopted: false }],
    ["failure", { runId: record.runId, release: true }],
  ]);
});

test("an abort signal between adoption polls returns promptly", async () => {
  const record = registryRecord();
  const gateway = fakeGateway({ runId: record.runId, phase: SandboxPhase.READY });
  const registry = fakeRegistry([record]);
  const lock = fakeLock();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const startedAt = Date.now();
  await reconcile({ registry, lockClient: lock, gateway, log: fakeLog(), signal: controller.signal, pollIntervalMs: 5_000, adoptTimeoutMs: 60_000 });
  assert.ok(Date.now() - startedAt < 1_000, "aborts between polls instead of waiting them out");
  assert.deepEqual(gateway.calls.map((call) => call.name), ["getWorkspace", "getSandbox"]);
  assert.deepEqual(registry.updates, []);
  assert.deepEqual(lock.releases, []);
});
