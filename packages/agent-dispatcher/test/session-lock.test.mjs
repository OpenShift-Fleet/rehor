import test from "node:test";
import assert from "node:assert/strict";
import { createSessionLockClient, withSessionLock } from "../dist/session-lock.js";
import { readSessionLockTtlMs } from "../dist/config.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Minimal fake fetch routing by path; handlers are either fixed response
// shapes or functions of the captured request.
function harness(handlers) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const request = { url: String(url), method: init.method, headers: { ...init.headers }, body: JSON.parse(init.body) };
    requests.push(request);
    const handler = handlers[new URL(String(url)).pathname];
    if (!handler) return { status: 404, json: async () => ({}) };
    const response = typeof handler === "function" ? handler(request) : handler;
    return { status: response.status, json: async () => response.body };
  };
  return { requests, fetchImpl };
}

const logs = () => {
  const entries = [];
  return { entries, log: (event, status, data) => entries.push({ event, status, data }) };
};

const client = (fetchImpl) => createSessionLockClient({
  url: new URL("https://memory.example/health"),
  mint: async () => "synthetic-bearer",
  fetchImpl,
});

test("lock client sends exact request shapes with integer-second TTLs", async () => {
  const { requests, fetchImpl } = harness({
    "/api/locks/acquire": { status: 200, body: { acquired: true, lock_token: "tok-1", holder: "pod-a", acquired_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T00:30:00Z" } },
    "/api/locks/renew": { status: 200, body: { renewed: true, expires_at: "2026-01-01T00:30:00Z" } },
    "/api/locks/release": { status: 200, body: { released: true } },
  });
  const lock = client(fetchImpl);
  assert.deepEqual(await lock.acquire("agent-session:abc", "pod-a", 30_000), {
    status: "acquired", token: "tok-1", expiresAt: "2026-01-01T00:30:00Z",
  });
  assert.equal(await lock.renew("agent-session:abc", "tok-1", 90_000), true);
  assert.equal(await lock.release("agent-session:abc", "tok-1"), true);
  assert.deepEqual(requests.map((request) => [request.method, request.url]), [
    ["POST", "https://memory.example/api/locks/acquire"],
    ["POST", "https://memory.example/api/locks/renew"],
    ["POST", "https://memory.example/api/locks/release"],
  ]);
  for (const request of requests) {
    assert.equal(request.headers.authorization, "Bearer synthetic-bearer");
    assert.equal(request.headers["content-type"], "application/json");
  }
  assert.deepEqual(requests[0].body, { key: "agent-session:abc", holder: "pod-a", ttl_seconds: 30 });
  assert.deepEqual(requests[1].body, { key: "agent-session:abc", lock_token: "tok-1", ttl_seconds: 90 });
  assert.deepEqual(requests[2].body, { key: "agent-session:abc", lock_token: "tok-1" });
});

test("lock client rounds sub-second TTLs up and maps failures to statuses", async () => {
  const { requests, fetchImpl } = harness({
    "/api/locks/acquire": (request) => {
      if (request.body.ttl_seconds === 2) return { status: 409, body: { acquired: false, holder: "pod-b", acquired_at: "x", expires_at: "y" } };
      return { status: 200, body: { acquired: true, lock_token: "tok-1", expires_at: "x" } };
    },
    "/api/locks/renew": { status: 409, body: { renewed: false } },
    "/api/locks/release": { status: 500, body: {} },
  });
  const lock = client(fetchImpl);
  // 1500ms must round up to 2 seconds, never down to a shorter lease.
  assert.deepEqual(await lock.acquire("k", "pod-a", 1_500), { status: "contended", holder: "pod-b" });
  assert.equal(await lock.renew("k", "tok-1", 1_500), false);
  assert.equal(await lock.release("k", "tok-1"), false);
  assert.deepEqual(requests[0].body, { key: "k", holder: "pod-a", ttl_seconds: 2 });
});

test("lock client maps malformed bodies, error statuses, and transport failures to error", async () => {
  for (const acquire of [
    { status: 200, body: { acquired: false } },
    { status: 200, body: { acquired: true, lock_token: "" } },
    { status: 200, body: { acquired: true } },
    { status: 400, body: {} },
  ]) {
    const { fetchImpl } = harness({ "/api/locks/acquire": acquire });
    assert.deepEqual(await client(fetchImpl).acquire("k", "pod-a", 30_000), { status: "error" });
  }
  const throwing = async () => { throw new Error("network-secret"); };
  assert.deepEqual(await client(throwing).acquire("k", "pod-a", 30_000), { status: "error" });
  const failingMint = createSessionLockClient({ url: new URL("https://memory.example/health"), mint: async () => { throw new Error("mint-secret"); }, fetchImpl: throwing });
  assert.deepEqual(await failingMint.acquire("k", "pod-a", 30_000), { status: "error" });
});

test("contended 409 without a holder body reports a null holder", async () => {
  const { fetchImpl } = harness({ "/api/locks/acquire": { status: 409, body: { acquired: false } } });
  assert.deepEqual(await client(fetchImpl).acquire("k", "pod-a", 30_000), { status: "contended", holder: null });
});

test("acquired lock runs the session with the acquisition token, renews, and releases", async () => {
  const { requests, fetchImpl } = harness({
    "/api/locks/acquire": { status: 200, body: { acquired: true, lock_token: "tok-1", holder: "pod-a", acquired_at: "x", expires_at: "y" } },
    "/api/locks/renew": { status: 200, body: { renewed: true, expires_at: "y" } },
    "/api/locks/release": { status: 200, body: { released: true } },
  });
  const { entries, log } = logs();
  let ran = 0;
  let observedToken;
  const outcome = await withSessionLock({
    lock: client(fetchImpl), key: "k", holder: "pod-a", ttlMs: 60, log,
    run: async (lockToken) => { ran++; observedToken = lockToken; await sleep(45); return "session-result"; },
  });
  assert.deepEqual(outcome, { status: "ran", result: "session-result" });
  assert.equal(ran, 1);
  // The run callback receives the exact acquisition token so durable
  // bookkeeping (session registry) can reference the lease.
  assert.equal(observedToken, "tok-1");
  assert.deepEqual(entries, []);
  assert.deepEqual(requests.find((request) => request.url.endsWith("/release")).body, { key: "k", lock_token: "tok-1" });
  // Renewal fired during the run at one third of the TTL.
  assert.ok(requests.filter((request) => request.url.endsWith("/renew")).length >= 1);
  // The renew timer is cleared once the session settles.
  const settled = requests.length;
  await sleep(150);
  assert.equal(requests.length, settled);
});

test("contended acquisition never runs the session and never releases", async () => {
  const { requests, fetchImpl } = harness({
    "/api/locks/acquire": { status: 409, body: { acquired: false, holder: "pod-b", acquired_at: "x", expires_at: "y" } },
  });
  const { entries, log } = logs();
  const outcome = await withSessionLock({
    lock: client(fetchImpl), key: "k", holder: "pod-a", ttlMs: 30_000, log,
    run: async () => { throw new Error("must not run"); },
  });
  assert.deepEqual(outcome, { status: "contended" });
  assert.deepEqual(entries, [{ event: "sandbox.lock", status: "success", data: { contended: true, holder: "pod-b" } }]);
  assert.deepEqual(requests.map((request) => request.url), ["https://memory.example/api/locks/acquire"]);
});

test("acquisition failure is an error, never a session and never a release", async () => {
  const throwing = async () => { throw new Error("network-secret"); };
  const { entries, log } = logs();
  const outcome = await withSessionLock({
    lock: client(throwing), key: "k", holder: "pod-a", ttlMs: 30_000, log,
    run: async () => { throw new Error("must not run"); },
  });
  assert.deepEqual(outcome, { status: "error" });
  assert.deepEqual(entries, [{ event: "sandbox.lock", status: "failure", data: { category: "internal" } }]);
});

test("failed renewal is logged once, the session continues, and release still happens", async () => {
  const { requests, fetchImpl } = harness({
    "/api/locks/acquire": { status: 200, body: { acquired: true, lock_token: "tok-1", holder: "pod-a", acquired_at: "x", expires_at: "y" } },
    "/api/locks/renew": { status: 409, body: { renewed: false } },
    "/api/locks/release": { status: 200, body: { released: true } },
  });
  const { entries, log } = logs();
  const outcome = await withSessionLock({
    lock: client(fetchImpl), key: "k", holder: "pod-a", ttlMs: 30, log,
    run: async () => { await sleep(70); return "still-ran"; },
  });
  assert.deepEqual(outcome, { status: "ran", result: "still-ran" });
  // Many renew attempts during the run, but the failure is logged once.
  assert.ok(requests.filter((request) => request.url.endsWith("/renew")).length > 1);
  assert.deepEqual(entries, [{ event: "sandbox.lock", status: "failure", data: { renew: true } }]);
  assert.deepEqual(requests.find((request) => request.url.endsWith("/release")).body, { key: "k", lock_token: "tok-1" });
});

test("failed release is logged without affecting the session result", async () => {
  const { fetchImpl } = harness({
    "/api/locks/acquire": { status: 200, body: { acquired: true, lock_token: "tok-1", holder: "pod-a", acquired_at: "x", expires_at: "y" } },
    "/api/locks/renew": { status: 200, body: { renewed: true, expires_at: "y" } },
    "/api/locks/release": { status: 200, body: { released: false } },
  });
  const { entries, log } = logs();
  const outcome = await withSessionLock({
    lock: client(fetchImpl), key: "k", holder: "pod-a", ttlMs: 30_000, log,
    run: async () => "result",
  });
  assert.deepEqual(outcome, { status: "ran", result: "result" });
  assert.deepEqual(entries, [{ event: "sandbox.lock", status: "failure", data: { release: true } }]);
});

test("a thrown session error still releases the lock and propagates", async () => {
  const { requests, fetchImpl } = harness({
    "/api/locks/acquire": { status: 200, body: { acquired: true, lock_token: "tok-1", holder: "pod-a", acquired_at: "x", expires_at: "y" } },
    "/api/locks/renew": { status: 200, body: { renewed: true, expires_at: "y" } },
    "/api/locks/release": { status: 200, body: { released: true } },
  });
  const { entries, log } = logs();
  await assert.rejects(withSessionLock({
    lock: client(fetchImpl), key: "k", holder: "pod-a", ttlMs: 30_000, log,
    run: async () => { throw new Error("session-secret"); },
  }), /session-secret/);
  assert.deepEqual(entries, []);
  assert.deepEqual(requests.find((request) => request.url.endsWith("/release")).body, { key: "k", lock_token: "tok-1" });
});

test("session lock TTL configuration is fail-closed with a 30-minute default", () => {
  assert.equal(readSessionLockTtlMs({}), 30 * 60_000);
  assert.equal(readSessionLockTtlMs({ AGENT_DISPATCHER_SESSION_LOCK_TTL_MS: undefined }), 30 * 60_000);
  assert.equal(readSessionLockTtlMs({ AGENT_DISPATCHER_SESSION_LOCK_TTL_MS: "0" }), 0);
  assert.equal(readSessionLockTtlMs({ AGENT_DISPATCHER_SESSION_LOCK_TTL_MS: "60000" }), 60_000);
  for (const value of ["", "abc", "-1", "1.5", "1e5", " ", "9007199254740993", "86400001"]) {
    assert.throws(() => readSessionLockTtlMs({ AGENT_DISPATCHER_SESSION_LOCK_TTL_MS: value }), { message: /AGENT_DISPATCHER_SESSION_LOCK_TTL_MS/ });
  }
});
