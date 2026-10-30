import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAuthConfig } from "../dist/config.js";
import { createCredentialProvider, preflightFailureMessage } from "../dist/preflight.js";
import { httpsRequest } from "../dist/https.js";
import { createLifecycleLogger } from "../dist/logging.js";

const baseEnv = {
  AGENT_DISPATCHER_AUTH_NAMESPACE: "agents",
  AGENT_DISPATCHER_AUTH_SERVICE_ACCOUNT: "sandbox-agent",
  AGENT_DISPATCHER_AUTH_MEMORY_URL: "https://memory.example/health",
};
const config = () => readAuthConfig(baseEnv);

function fixture() {
  let now = Date.parse("2026-01-01T00:00:00Z");
  let issued = 0;
  const calls = [];
  const files = [];
  const deps = {
    now: () => now,
    env: { KUBERNETES_SERVICE_HOST: "kubernetes.example", KUBERNETES_SERVICE_PORT_HTTPS: "443" },
    readFile: async (path) => { files.push(path); return Buffer.from(path.endsWith("/token") ? "projected-secret" : "cluster-ca"); },
    http: async (req) => {
      calls.push(req);
      if (req.method === "POST") {
        issued++;
        return { status: 201, body: JSON.stringify({ status: { token: `minted-secret-${issued}`, expirationTimestamp: new Date(now + 120_000).toISOString() } }) };
      }
      return { status: req.headers?.authorization?.startsWith("Bearer minted-secret-") ? 200 : 401, body: "" };
    },
  };
  return { deps, calls, files, advance: (ms) => { now += ms; } };
}

test("configuration is opt-in, complete, strict and HTTPS-only", () => {
  assert.equal(readAuthConfig({}), undefined);
  for (const env of [
    { AGENT_DISPATCHER_AUTH_NAMESPACE: "agents" },
    { ...baseEnv, AGENT_DISPATCHER_AUTH_OTHER: "x" },
    { ...baseEnv, AGENT_DISPATCHER_AUTH_AUDIENCE: "" },
    { ...baseEnv, AGENT_DISPATCHER_AUTH_NAMESPACE: "../bad" },
    ...["http://memory.example", "https://user:pass@memory.example", "https://memory.example/?secret=x", "https://memory.example/#x"].map((url) => ({ ...baseEnv, AGENT_DISPATCHER_AUTH_MEMORY_URL: url })),
  ]) assert.throws(() => readAuthConfig(env));
  assert.throws(() => createCredentialProvider({ ...config(), memoryUrl: new URL("http://memory.example") }));
});

test("TokenRequest uses projected credentials, default audience, and exact memory endpoint; cache refreshes on demand", async () => {
  const f = fixture();
  const provider = createCredentialProvider(config(), f.deps);
  const [first, concurrent] = await Promise.all([provider.get(), provider.get()]);
  assert.deepEqual(first, concurrent);
  assert.equal(first.token, "minted-secret-1");
  assert.equal(f.calls.length, 4);
  const post = f.calls[0];
  assert.equal(post.url.href, "https://kubernetes.example/api/v1/namespaces/agents/serviceaccounts/sandbox-agent/token");
  assert.equal(post.headers.authorization, "Bearer projected-secret");
  assert.equal(post.ca.toString(), "cluster-ca");
  assert.deepEqual(JSON.parse(post.body).spec, { expirationSeconds: 3600 });
  assert.deepEqual(f.calls.slice(1).map((call) => [call.url.href, call.headers?.authorization]), [
    [baseEnv.AGENT_DISPATCHER_AUTH_MEMORY_URL, undefined],
    [baseEnv.AGENT_DISPATCHER_AUTH_MEMORY_URL, "Bearer invalid-preflight-credential"],
    [baseEnv.AGENT_DISPATCHER_AUTH_MEMORY_URL, "Bearer minted-secret-1"],
  ]);
  first.token = "mutated";
  assert.equal((await provider.get()).token, "minted-secret-1");
  f.advance(60_000);
  assert.equal((await provider.get()).token, "minted-secret-2");
  assert.equal(f.files.length, 4);
  assert.equal(f.calls.length, 8);
});

test("explicit audience is requested and endpoint objects are copied", async () => {
  const f = fixture();
  const cfg = readAuthConfig({ ...baseEnv, AGENT_DISPATCHER_AUTH_AUDIENCE: "custom-audience" });
  const provider = createCredentialProvider(cfg, f.deps);
  cfg.memoryUrl.hostname = "unexpected.example";
  await provider.get();
  assert.deepEqual(JSON.parse(f.calls[0].body).spec.audiences, ["custom-audience"]);
  assert.equal(f.calls[1].url.href, baseEnv.AGENT_DISPATCHER_AUTH_MEMORY_URL);
});

test("failed refresh never returns an old credential", async () => {
  const original = fixture();
  let fail = false;
  const client = original.deps.http;
  original.deps.http = async (request) => {
    if (fail) throw new Error("minted-secret-1");
    return client(request);
  };
  const refreshing = createCredentialProvider(config(), original.deps);
  await refreshing.get();
  original.advance(60_000);
  fail = true;
  await assert.rejects(refreshing.get(), { message: "Agent dispatcher TokenRequest failed", stage: "token-request" });
});

test("missing or invalid bearer success, redirects, and other unexpected negative responses fail before token delivery", async () => {
  for (const step of [1, 2]) {
    for (const status of [200, 302, 500]) {
      const f = fixture();
      const original = f.deps.http;
      f.deps.http = async (req) => {
        const result = await original(req);
        return f.calls.length === step + 1 ? { status, body: "minted-secret-1" } : result;
      };
      await assert.rejects(createCredentialProvider(config(), f.deps).get(), { message: "Agent dispatcher memory endpoint preflight failed", stage: "memory-endpoint" });
      assert.equal(f.calls.length, step + 1);
      assert.ok(!f.calls.some((call) => call.headers?.authorization === "Bearer minted-secret-1"));
    }
  }
});

test("real-token rejection, expired or invalid TokenRequest, errors and no retries fail closed without leaking secrets", async () => {
  for (const mode of ["api-rejected", "bad-json", "no-token", "expired", "network", "memory-network", "valid-rejected", "expires-during-check"]) {
    const f = fixture();
    const original = f.deps.http;
    f.deps.http = async (req) => {
      const result = await original(req);
      if (mode === "network") throw new Error("projected-secret minted-secret-1 https://secret.example");
      if (req.method === "POST") {
        if (mode === "api-rejected") return { status: 403, body: "projected-secret" };
        if (mode === "bad-json") return { status: 200, body: "minted-secret-1" };
        if (mode === "no-token") return { status: 200, body: '{}' };
        if (mode === "expired") return { status: 200, body: JSON.stringify({ status: { token: "minted-secret-1", expirationTimestamp: "2020-01-01T00:00:00Z" } }) };
      } else {
        if (mode === "memory-network") throw new Error("projected-secret minted-secret-1 https://secret.example");
        if (mode === "valid-rejected" && req.headers?.authorization === "Bearer minted-secret-1") return { status: 302, body: "minted-secret-1" };
        if (mode === "expires-during-check") f.advance(30_000);
      }
      return result;
    };
    await assert.rejects(createCredentialProvider(config(), f.deps).get(), (error) => {
      const memoryFailure = ["memory-network", "valid-rejected", "expires-during-check"].includes(mode);
      assert.equal(error.message, memoryFailure ? "Agent dispatcher memory endpoint preflight failed" : "Agent dispatcher TokenRequest failed");
      assert.equal(error.stage, memoryFailure ? "memory-endpoint" : "token-request");
      assert.equal(preflightFailureMessage(error), error.message);
      assert.doesNotMatch(error.stack, /projected-secret|minted-secret|secret\.example/);
      return true;
    });
    assert.equal(f.calls.filter((call) => call.method === "POST").length, 1);
  }
});

test("unexpected errors produce fixed safe runtime message", () => {
  assert.equal(preflightFailureMessage(new Error("projected-secret minted-secret-1")), "Agent dispatcher credential preflight failed");
});

test("partial runtime config exits without printing credentials", () => {
  const result = spawnSync(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8",
    env: { AGENT_DISPATCHER_AUTH_NAMESPACE: "sensitive-value" }, timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "Agent dispatcher auth configuration failed");
  assert.doesNotMatch(result.stderr + result.stdout, /sensitive-value/);
});

test("runtime reports TokenRequest stage without leaking configuration", () => {
  const result = spawnSync(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8",
    env: { ...baseEnv, KUBERNETES_SERVICE_HOST: "sensitive-api.example" }, timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "Agent dispatcher TokenRequest failed");
  assert.doesNotMatch(result.stderr + result.stdout, /sensitive-api|memory\.example/);
  const records = result.stdout.trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(({ event, status }) => [event, status]), [
    ["startup", "start"], ["configuration", "start"], ["configuration", "success"],
    ["kubernetes.token_request", "start"], ["kubernetes.token_request", "failure"], ["startup", "failure"], ["shutdown", "start"], ["shutdown", "success"],
  ]);
});

test("unconfigured runtime retains scaffold startup and clean shutdown", { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ["dist/index.js"], { cwd: new URL("..", import.meta.url), env: {}, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const closed = new Promise((resolve) => child.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (data) => {
        output += data;
        if (output.includes("Hello from @rehor/agent-dispatcher")) resolve();
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Exited before startup")));
    });
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: 0, signal: null });
    await closed;
    const records = output.trim().split("\n").filter((line) => line.startsWith("{")).map(JSON.parse);
    assert.deepEqual(records.map(({ event, status }) => [event, status]), [
      ["startup", "start"], ["configuration", "start"], ["configuration", "success"],
      ["startup", "success"], ["ready", "success"], ["shutdown", "start"], ["shutdown", "success"],
    ]);
  } finally {
    child.kill("SIGKILL");
  }
});

test("memory lifecycle logs only executed checks and never credentials, including cached calls", async () => {
  const f = fixture();
  const lines = [];
  const logger = createLifecycleLogger({ write: (line) => lines.push(line), now: () => 42 });
  const provider = createCredentialProvider(config(), f.deps, logger);
  await Promise.all([provider.get(), provider.get()]);
  await provider.get();
  assert.deepEqual(lines.map(JSON.parse).map(({ event, status }) => [event, status]), [
    ["kubernetes.token_request", "start"], ["kubernetes.token_request", "success"],
    ["memory.missing_token", "start"], ["memory.missing_token", "success"],
    ["memory.invalid_token", "start"], ["memory.invalid_token", "success"],
    ["memory.token", "start"], ["memory.token", "success"],
  ]);
  assert.doesNotMatch(lines.join("\n"), /secret|agents|sandbox-agent|memory\.example|kubernetes\.example/);
});

test("memory failure logs the failing check only and does not leak errors or response bodies", async () => {
  for (const failingStep of [0, 1, 2, 3]) {
    const f = fixture();
    const lines = [];
    const original = f.deps.http;
    f.deps.http = async (request) => {
      const result = await original(request);
      if (f.calls.length === failingStep + 1) {
        if (failingStep === 1) return { status: 200, body: "body-secret" };
        throw new Error("projected-secret minted-secret-1 body-secret");
      }
      return result;
    };
    await assert.rejects(createCredentialProvider(config(), f.deps, createLifecycleLogger({ write: (line) => lines.push(line) })).get());
    const records = lines.map(JSON.parse);
    const names = ["kubernetes.token_request", "memory.missing_token", "memory.invalid_token", "memory.token"];
    assert.deepEqual(records.map(({ event, status }) => [event, status]), names.slice(0, failingStep + 1).flatMap((name, i) => [[name, "start"], [name, i === failingStep ? "failure" : "success"]]));
    assert.equal(records.at(-1).category, "internal");
    assert.doesNotMatch(lines.join("\n"), /secret|memory\.example|kubernetes\.example/);
  }
});

test("memory preflight survives a broken injected logger", async () => {
  const f = fixture();
  const broken = { start() { throw new Error("logger-secret"); }, log() { throw new Error("logger-secret"); } };
  assert.equal((await createCredentialProvider(config(), f.deps, broken).get()).token, "minted-secret-1");
  const f2 = fixture();
  const brokenCompletion = { start() { return { success() { throw new Error("logger-secret"); }, failure() { throw new Error("logger-secret"); } }; } };
  assert.equal((await createCredentialProvider(config(), f2.deps, brokenCompletion).get()).token, "minted-secret-1");
  const f3 = fixture();
  const asyncBroken = { start() { return Promise.reject(new Error("logger-secret")); } };
  assert.equal((await createCredentialProvider(config(), f3.deps, asyncBroken).get()).token, "minted-secret-1");
  await new Promise((resolve) => setImmediate(resolve));
});

test("credential expiry before valid-token request records check failure without sending token", async () => {
  const f = fixture();
  const lines = [];
  const original = f.deps.http;
  f.deps.http = async (request) => {
    const response = await original(request);
    if (request.method === "GET") f.advance(30_000);
    return response;
  };
  await assert.rejects(createCredentialProvider(config(), f.deps, createLifecycleLogger({ write: (line) => lines.push(line) })).get());
  assert.equal(f.calls.length, 3);
  assert.deepEqual(lines.map(JSON.parse).slice(-2).map(({ event, status }) => [event, status]), [
    ["memory.token", "start"], ["memory.token", "failure"],
  ]);
});

test("HTTPS transport verifies TLS, never follows redirects, bounds POST body and timeouts", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatcher-test-"));
  let server;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
    const cert = readFileSync(join(directory, "cert.pem"));
    let redirected = 0;
    let markClosed;
    const closed = new Promise((resolve) => { markClosed = resolve; });
    server = createServer({ key: readFileSync(join(directory, "key.pem")), cert }, (req, res) => {
      if (req.url === "/redirect") { res.writeHead(302, { location: "/target" }); res.end(); }
      else if (req.url === "/target") { redirected++; res.end("unexpected"); }
      else if (req.url === "/large") { res.writeHead(403); res.end("x".repeat(65_537)); }
      else if (req.url === "/limit") res.end("x".repeat(65_536));
      else if (req.url === "/headers-hang") { res.on("close", markClosed); res.writeHead(403); res.flushHeaders(); }
      else if (req.url === "/body-hang") { res.writeHead(201); res.write("partial"); }
      else if (req.url !== "/hang") res.end("ok");
    });
    await new Promise((resolve) => server.listen(0, "localhost", resolve));
    const url = (path) => new URL(`https://localhost:${server.address().port}${path}`);
    await assert.rejects(httpsRequest({ url: url("/"), method: "GET" }), { message: "HTTPS request failed" });
    const tlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    try {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      await assert.rejects(httpsRequest({ url: url("/"), method: "GET" }), { message: "HTTPS request failed" });
    } finally {
      if (tlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsSetting;
    }
    await assert.rejects(httpsRequest({ url: new URL("http://localhost/"), method: "GET" }), { message: "HTTPS required" });
    assert.equal((await httpsRequest({ url: url("/redirect"), method: "GET", ca: cert, headers: { authorization: "Bearer secret" } })).status, 302);
    assert.equal((await httpsRequest({ url: url("/redirect"), method: "POST", ca: cert })).status, 302);
    assert.equal(redirected, 0);
    assert.deepEqual(await httpsRequest({ url: url("/large"), method: "GET", ca: cert }), { status: 403, body: "" });
    await assert.rejects(httpsRequest({ url: url("/large"), method: "POST", ca: cert }), { message: "HTTPS response too large" });
    assert.equal((await httpsRequest({ url: url("/limit"), method: "POST", ca: cert })).body.length, 65_536);
    assert.deepEqual(await httpsRequest({ url: url("/headers-hang"), method: "GET", ca: cert }), { status: 403, body: "" });
    let closeTimer;
    try {
      await Promise.race([closed, new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error("GET connection not closed")), 2000); })]);
    } finally { clearTimeout(closeTimer); }
    await assert.rejects(httpsRequest({ url: url("/hang"), method: "GET", ca: cert }), { message: "HTTPS request timed out" });
    await assert.rejects(httpsRequest({ url: url("/body-hang"), method: "POST", ca: cert }), { message: "HTTPS request timed out" });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
