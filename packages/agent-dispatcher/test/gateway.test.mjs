import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readGatewayConfig } from "../dist/gateway-config.js";
import { connectGateway } from "../dist/gateway.js";
import { clientCredentials } from "@nvidia/openshell-sdk";
import { createLifecycleLogger } from "../dist/logging.js";

const env = {
  OPENSHELL_GATEWAY_ENDPOINT: "https://gateway.example:8443",
  OPENSHELL_GATEWAY_NAME: "example",
  OPENSHELL_OIDC_ISSUER: "https://issuer.example/realm",
  OPENSHELL_CLIENT_ID: "example-client",
  OPENSHELL_OIDC_AUDIENCE: "example-audience",
  OPENSHELL_OIDC_CLIENT_SECRET: "test-secret",
  OPENSHELL_SERVICE_ACCOUNT_SUBJECT: "example-subject",
};
const config = () => readGatewayConfig(env);

function fixture() {
  const calls = [];
  const tokenProvider = { getToken: async () => "test-token" };
  const raw = {
    getCurrentUser: async (...args) => { calls.push(["identity", ...args]); return { subject: "example-subject", identityProvider: "oidc" }; },
  };
  const sdk = {
    clientCredentials: (options) => { calls.push(["credentials", options]); return tokenProvider; },
    connect: async (options) => { calls.push(["connect", options]); return { raw }; },
  };
  return { sdk, calls, tokenProvider, raw };
}

test("gateway config is opt-in, complete, HTTPS only and rejects unsafe TLS", () => {
  assert.equal(readGatewayConfig({}), undefined);
  for (const key of Object.keys(env).slice(0, 6)) {
    const partial = { ...env }; delete partial[key];
    assert.throws(() => readGatewayConfig(partial), { message: "Invalid gateway configuration" });
  }
  for (const overrides of [
    { OPENSHELL_SERVICE_ACCOUNT_SUBJECT: "" }, { OPENSHELL_OIDC_AUDIENCE: " " },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    ...["http://gateway.example", "https://user:secret@gateway.example", "https://gateway.example/path", "https://gateway.example?secret=1", "not a url"].map((url) => ({ OPENSHELL_GATEWAY_ENDPOINT: url })),
    ...["http://issuer.example", "https://user:secret@issuer.example", "https://issuer.example/?secret=1", "https://issuer.example/#secret"].map((url) => ({ OPENSHELL_OIDC_ISSUER: url })),
  ]) assert.throws(() => readGatewayConfig({ ...env, ...overrides }), { message: "Invalid gateway configuration" });
  const { OPENSHELL_SERVICE_ACCOUNT_SUBJECT, ...noSubject } = env;
  assert.equal(readGatewayConfig(noSubject).subject, undefined);
});

test("preflight wires renewable provider and authenticated identity; no sandbox operations", async () => {
  const f = fixture();
  const client = await connectGateway(config(), async () => f.sdk);
  assert.equal(client.raw, f.raw);
  assert.deepEqual(f.calls[0], ["credentials", { issuer: env.OPENSHELL_OIDC_ISSUER, clientId: env.OPENSHELL_CLIENT_ID, clientSecret: env.OPENSHELL_OIDC_CLIENT_SECRET, audience: env.OPENSHELL_OIDC_AUDIENCE, timeoutMs: 10_000 }]);
  assert.equal(f.calls[1][1].gateway, env.OPENSHELL_GATEWAY_ENDPOINT);
  assert.equal(f.calls[1][1].insecureSkipVerify, false);
  assert.equal(await f.calls[1][1].oidcTokenProvider.getToken(), "test-token");
  assert.equal(f.calls[2][0], "identity");
  assert.ok(f.calls[2][2].signal instanceof AbortSignal);
  assert.equal(f.calls.length, 3);
});

test("identity required and subject mismatch fails closed; SDK exceptions are sanitized", async () => {
  for (const subject of ["", "different-subject"]) {
    const f = fixture(); f.raw.getCurrentUser = async () => ({ subject, identityProvider: "oidc" });
    await assert.rejects(connectGateway(config(), async () => f.sdk), (error) => {
      assert.equal(error.message, "OpenShell gateway preflight failed");
      assert.doesNotMatch(error.stack, /different-subject|example-subject/);
      return true;
    });
  }
  for (const stage of ["factory", "credentials", "connect", "identity"]) {
    const f = fixture();
    const boom = () => { throw new Error("test-secret test-token example-client example-subject issuer.example"); };
    if (stage === "credentials") f.sdk.clientCredentials = boom;
    if (stage === "connect") f.sdk.connect = boom;
    if (stage === "identity") f.raw.getCurrentUser = boom;
    await assert.rejects(connectGateway(config(), async () => stage === "factory" ? boom() : f.sdk), (error) => {
      assert.equal(error.message, "OpenShell gateway preflight failed");
      assert.doesNotMatch(error.stack, /test-secret|test-token|example-client|example-subject|issuer\.example/);
      return true;
    });
  }
});

test("only OIDC identity is accepted even without an expected subject", async () => {
  for (const identityProvider of ["local_dev", "mtls", "cloudflare_access", "", undefined, "OIDC"]) {
    const f = fixture(); f.raw.getCurrentUser = async () => ({ subject: "example-subject", identityProvider });
    await assert.rejects(connectGateway({ ...config(), subject: undefined }, async () => f.sdk), (error) => {
      assert.equal(error.message, "OpenShell gateway preflight failed");
      assert.doesNotMatch(error.stack, /local_dev|cloudflare_access|example-subject/);
      return true;
    });
  }
  const f = fixture();
  await connectGateway({ ...config(), subject: undefined }, async () => f.sdk);
});

test("real SDK provider refreshes client credentials on later gateway calls", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  let grants = 0;
  const forms = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ issuer: env.OPENSHELL_OIDC_ISSUER, token_endpoint: "https://issuer.example/token" });
    forms.push(options.body);
    return Response.json({ access_token: `token-${++grants}`, expires_in: 120 });
  };
  Date.now = () => now;
  try {
    let provider;
    const sdk = { clientCredentials, connect: async (options) => {
      provider = options.oidcTokenProvider;
      return { raw: {
        getCurrentUser: async (_, options) => { assert.equal(await provider.getToken(options.signal), "token-1"); return { subject: "example-subject", identityProvider: "oidc" }; },
      } };
    } };
    await connectGateway(config(), async () => sdk);
    assert.equal(grants, 1);
    now += 100_000;
    assert.equal(await provider.getToken(), "token-2");
    assert.equal(grants, 2);
    for (const form of forms) {
      assert.equal(form.get("grant_type"), "client_credentials");
      assert.equal(form.get("client_id"), env.OPENSHELL_CLIENT_ID);
      assert.equal(form.get("client_secret"), env.OPENSHELL_OIDC_CLIENT_SECRET);
      assert.equal(form.get("audience"), env.OPENSHELL_OIDC_AUDIENCE);
    }
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test("preflight drains SDK token acquisition after RPC abort before reporting failure", async () => {
  const originalFetch = globalThis.fetch;
  const lines = [];
  let releaseDiscovery;
  let announceDiscovery;
  const discoveryStarted = new Promise((resolve) => { announceDiscovery = resolve; });
  const discoveryGate = new Promise((resolve) => { releaseDiscovery = resolve; });
  let tokenPosts = 0;
  let tokenWaiter;
  globalThis.fetch = async (url) => {
    if (url.endsWith("/.well-known/openid-configuration")) {
      announceDiscovery();
      await discoveryGate;
      return Response.json({ issuer: env.OPENSHELL_OIDC_ISSUER, token_endpoint: "https://issuer.example/token" });
    }
    tokenPosts++;
    return Response.json({ access_token: "test-token", expires_in: 120 });
  };
  try {
    const sdk = { clientCredentials, connect: async ({ oidcTokenProvider }) => ({ raw: {
      getCurrentUser: async () => {
        const controller = new AbortController();
        tokenWaiter = oidcTokenProvider.getToken(controller.signal);
        void tokenWaiter.catch(() => {});
        await discoveryStarted;
        controller.abort();
        throw new Error("test-secret");
      },
    } }) };
    let finished = false;
    const preflight = connectGateway(config(), async () => sdk, createLifecycleLogger({ write: (line) => lines.push(line) })).finally(() => { finished = true; });
    const rejected = assert.rejects(preflight, { message: "OpenShell gateway preflight failed" });
    await discoveryStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(tokenPosts, 0);
    releaseDiscovery();
    await rejected;
    await assert.rejects(tokenWaiter);
    assert.equal(tokenPosts, 1);
    assert.equal(finished, true);
    assert.deepEqual(lines.map(JSON.parse).map(({ event, status }) => [event, status]), [
      ["gateway.authentication", "start"], ["gateway.oidc", "start"], ["gateway.oidc", "success"], ["gateway.authentication", "failure"],
    ]);
    assert.doesNotMatch(lines.join("\n"), /test-secret|test-token|issuer\.example/);
  } finally { releaseDiscovery(); globalThis.fetch = originalFetch; }
});

test("direct adapter rejects insecure configuration before SDK use", async () => {
  const f = fixture();
  await assert.rejects(connectGateway({ ...config(), endpoint: "http://gateway.example" }, async () => f.sdk), { message: "OpenShell gateway preflight failed" });
  assert.equal(f.calls.length, 0);
});

test("partial runtime gateway config fails without exposing values", () => {
  const result = spawnSync(process.execPath, ["dist/index.js"], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: { OPENSHELL_CLIENT_ID: "sensitive-client" }, timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "OpenShell gateway configuration failed");
  assert.doesNotMatch(result.stderr + result.stdout, /sensitive-client/);
  assert.deepEqual(result.stdout.trim().split("\n").map(JSON.parse).map(({ event, status }) => [event, status]), [
    ["startup", "start"], ["configuration", "start"], ["configuration", "failure"], ["startup", "failure"], ["shutdown", "start"], ["shutdown", "success"],
  ]);
});

test("runtime fails closed when real SDK credential preflight fails", () => {
  const script = 'globalThis.fetch = async () => { throw new Error("test-secret test-token example-client example-subject"); };';
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(script)}`, "dist/index.js"], {
    cwd: new URL("..", import.meta.url), encoding: "utf8", env, timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "OpenShell gateway preflight failed");
  assert.doesNotMatch(result.stderr + result.stdout, /test-secret|test-token|example-client|example-subject|issuer\.example/);
});

test("gateway logs provider acquisition and validated OIDC identity without sensitive data", async () => {
  const f = fixture();
  const lines = [];
  f.sdk.connect = async ({ oidcTokenProvider }) => ({ raw: { getCurrentUser: async () => {
    assert.equal(await oidcTokenProvider.getToken(), "test-token");
    return { subject: "example-subject", identityProvider: "oidc" };
  } } });
  await connectGateway(config(), async () => f.sdk, createLifecycleLogger({ write: (line) => lines.push(line), now: () => 42 }));
  assert.deepEqual(lines.map(JSON.parse).map(({ event, status }) => [event, status]), [
    ["gateway.authentication", "start"], ["gateway.oidc", "start"], ["gateway.oidc", "success"], ["gateway.authentication", "success"],
  ]);
  assert.doesNotMatch(lines.join("\n"), /test-secret|test-token|example-client|example-subject|issuer\.example|gateway\.example/);
});

test("gateway reports acquisition failure and identity mismatch without false success or sensitive values", async () => {
  for (const mode of ["token", "subject", "local_dev", "empty"]) {
    const f = fixture();
    const lines = [];
    if (mode === "token") f.tokenProvider.getToken = async () => { throw new Error("test-secret test-token issuer.example"); };
    f.sdk.connect = async ({ oidcTokenProvider }) => ({ raw: { getCurrentUser: async () => {
      await oidcTokenProvider.getToken();
      return { subject: mode === "subject" ? "wrong-subject" : mode === "empty" ? "" : "example-subject", identityProvider: mode === "local_dev" ? "local_dev" : "oidc" };
    } } });
    await assert.rejects(connectGateway(config(), async () => f.sdk, createLifecycleLogger({ write: (line) => lines.push(line) })), { message: "OpenShell gateway preflight failed" });
    const records = lines.map(JSON.parse);
    assert.deepEqual(records.map(({ event, status }) => [event, status]), [
      ["gateway.authentication", "start"], ["gateway.oidc", "start"], ["gateway.oidc", mode === "token" ? "failure" : "success"], ["gateway.authentication", "failure"],
    ]);
    assert.equal(records.at(-1).category, mode === "token" ? "internal" : "authentication");
    if (mode === "token") assert.equal(records[2].category, "internal");
    assert.doesNotMatch(lines.join("\n"), /test-secret|test-token|example-client|example-subject|wrong-subject|issuer\.example|local_dev/);
  }
});

test("SIGTERM during OIDC waits for in-flight work before one successful shutdown", { timeout: 8000 }, async () => {
  const script = `globalThis.fetch = async () => { await new Promise(resolve => setTimeout(resolve, 500)); throw new Error('network-secret issuer.example'); };`;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(script)}`, "dist/index.js"], {
    cwd: new URL("..", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  let signaled = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!signaled && output.includes('"event":"gateway.oidc","status":"start"')) {
      signaled = true;
      child.kill("SIGTERM");
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const result = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    assert.equal(signaled, true);
    assert.deepEqual(result, { code: 0, signal: null });
    const records = output.trim().split("\n").map(JSON.parse);
    const steps = records.map(({ event, status }) => [event, status]);
    assert.equal(steps.filter(([event]) => event === "shutdown").length, 2);
    const stopStart = steps.findIndex(([event, status]) => event === "shutdown" && status === "start");
    const oidcFailure = steps.findIndex(([event, status]) => event === "gateway.oidc" && status === "failure");
    const gatewayFailure = steps.findIndex(([event, status]) => event === "gateway.authentication" && status === "failure");
    const stopSuccess = steps.findIndex(([event, status]) => event === "shutdown" && status === "success");
    assert.ok(stopStart >= 0 && oidcFailure > stopStart && gatewayFailure > oidcFailure && stopSuccess > gatewayFailure);
    assert.equal(records[oidcFailure].category, "internal");
    assert.ok(!steps.some(([event, status]) => event === "startup" && status === "failure"));
    assert.ok(!steps.some(([event]) => event === "ready"));
    assert.equal(stderr, "");
    assert.doesNotMatch(output, /network-secret|test-secret|test-token|example-client|example-subject|issuer\.example/);
  } finally { child.kill("SIGKILL"); }
});

test("SIGTERM reports unsuccessful shutdown if in-flight work exceeds deadline", { timeout: 8000 }, async () => {
  const script = `
    const original = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 25000 ? 400 : ms, ...args);
    globalThis.fetch = async () => new Promise(() => {});
  `;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(script)}`, "dist/index.js"], {
    cwd: new URL("..", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let signaled = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!signaled && output.includes('"event":"gateway.oidc","status":"start"')) {
      signaled = true;
      child.kill("SIGTERM");
    }
  });
  try {
    const result = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    assert.equal(signaled, true);
    assert.deepEqual(result, { code: 1, signal: null });
    assert.doesNotMatch(output, /"event":"shutdown","status":"success"/);
    assert.doesNotMatch(output, /test-secret|test-token|example-client|example-subject|issuer\.example/);
  } finally { child.kill("SIGKILL"); }
});

test("gateway omits token events when provider is not called and survives logger failure", async () => {
  const f = fixture();
  const lines = [];
  await connectGateway(config(), async () => f.sdk, createLifecycleLogger({ write: (line) => lines.push(line) }));
  assert.deepEqual(lines.map(JSON.parse).map(({ event }) => event), ["gateway.authentication", "gateway.authentication"]);
  await connectGateway(config(), async () => fixture().sdk, { start() { throw new Error("logger-secret"); } });
  const failed = fixture();
  failed.raw.getCurrentUser = async () => { throw new Error("business-secret"); };
  await assert.rejects(connectGateway(config(), async () => failed.sdk, {
    start() { return { success() { throw new Error("logger-secret"); }, failure() { throw new Error("logger-secret"); } }; },
  }), { message: "OpenShell gateway preflight failed" });
});
