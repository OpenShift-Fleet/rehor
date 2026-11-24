import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMemoryPolicy } from "../dist/memory-policy.js";
import { sandboxEnvironment } from "../dist/runtime-environment.js";

const presetHelper = new URL("../../../presets/envs/browser/skills/gh-release-upload/upload.py", import.meta.url);
const imageHelper = new URL("../../../.claude/skills/gh-release-upload/upload.py", import.meta.url);
const python = process.env.PYTHON ?? "python3";
const placeholder = "openshell:resolve:env:v1_BOT_MEMORY_TOKEN";
const gateway = () => new URL("https://service-gateway.example.test:8454");
const memoryUrl = () => new URL("https://memory.example.test/health");
const png = Buffer.from("89504e470d0a1a0a-screenshot-bytes");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "rehor-screenshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function record(requests) {
  return (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ url: "https://github.com/example/repo/releases/download/screenshots/shot.png" }));
    });
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function close(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

/** Minimal child environment: no ambient proxy or credential variables. */
function helperEnvironment(extra) {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", ...extra };
}

function upload(dir, environment, filename = "shot.png") {
  const file = join(dir, "shot.png");
  writeFileSync(file, png);
  // Spawn asynchronously: the mocked service runs in this process.
  return new Promise((resolve) => {
    const child = spawn(python, [presetHelper.pathname, file, "example/repo", filename], {
      env: helperEnvironment(environment),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test("sandbox runtime environment and policy expose exactly one screenshot route", () => {
  const bare = { PATH: "/bin" };
  const withGateway = sandboxEnvironment(bare, { GH_RELEASE_UPLOAD_URL: "http://proxy:8446/upload" }, gateway());
  assert.equal(withGateway.GH_RELEASE_UPLOAD_URL, "https://service-gateway.example.test:8454/screenshots/upload");

  // Legacy behavior is preserved: no gateway configured, no rewrite.
  assert.equal(sandboxEnvironment(bare, undefined).GH_RELEASE_UPLOAD_URL, undefined);
  assert.equal(
    sandboxEnvironment({ GH_RELEASE_UPLOAD_URL: "http://proxy:8446/upload" }, undefined).GH_RELEASE_UPLOAD_URL,
    "http://proxy:8446/upload",
  );

  const policy = createMemoryPolicy(memoryUrl(), "provider-name-1", undefined, undefined, { serviceGatewayUrl: gateway() });
  const rule = policy.networkPolicies.service_gateway_screenshots;
  assert.ok(rule, "the service gateway policy must carry the screenshot rule");
  assert.equal(rule.name, "service-gateway-screenshots");
  assert.deepEqual(rule.binaries, [{ path: "/usr/bin/python3.12" }]);
  assert.equal(rule.endpoints.length, 1);

  const route = new URL(withGateway.GH_RELEASE_UPLOAD_URL);
  const endpoint = rule.endpoints[0];
  assert.equal(endpoint.host, route.hostname);
  assert.equal(endpoint.port, Number(route.port));
  assert.equal(endpoint.path, route.pathname);
  assert.deepEqual(endpoint.rules, [{ allow: { method: "POST", path: "/screenshots/upload" } }]);
  assert.deepEqual(endpoint.credentialBinding, { provider: "provider-name-1" });

  // No other admitted endpoint may reach the upload route.
  const admitted = [];
  for (const [name, candidate] of Object.entries(policy.networkPolicies)) {
    for (const candidateEndpoint of candidate.endpoints) {
      for (const candidateRule of candidateEndpoint.rules) {
        if (candidateEndpoint.path === "/screenshots/upload" && candidateRule.allow.method === "POST" && candidateRule.allow.path === "/screenshots/upload") {
          admitted.push(name);
        }
      }
    }
  }
  assert.deepEqual(admitted, ["service_gateway_screenshots"]);
});

test("legacy helper keeps the existing unauthenticated loopback upload contract", async (t) => {
  const dir = tempDir(t);
  const requests = [];
  const server = createServer(record(requests));
  const port = await listen(server);
  t.after(() => close(server));

  const result = await upload(dir, { GH_RELEASE_UPLOAD_URL: `http://127.0.0.1:${port}/upload` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/upload");
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].headers["x-repo"], "example/repo");
  assert.equal(requests[0].headers["x-filename"], "shot.png");
  assert.equal(requests[0].headers["content-type"], "image/png");
  assert.deepEqual(requests[0].body, png);
  assert.match(result.stdout, /^!\[shot\.png\]\(https:\/\/github\.com\/example\/repo\/releases\/download\/screenshots\/shot\.png\)$/m);
});

test("sandbox helper posts to the gateway route with only the placeholder", async (t) => {
  const dir = tempDir(t);
  const requests = [];
  const server = createServer(record(requests));
  const port = await listen(server);
  t.after(() => close(server));

  // Both established placeholder variables carry the same supervisor marker.
  for (const [name, extra] of [
    ["EXECUTOR_TOKEN", { EXECUTOR_TOKEN: placeholder, BOT_MEMORY_TOKEN: "raw-secret-must-not-be-used" }],
    ["BOT_MEMORY_TOKEN", { BOT_MEMORY_TOKEN: placeholder }],
  ]) {
    requests.length = 0;
    const result = await upload(dir, {
      REHOR_INPUT_SOURCE: "sandbox",
      GH_RELEASE_UPLOAD_URL: `http://127.0.0.1:${port}/screenshots/upload`,
      ...extra,
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.equal(requests.length, 1, name);
    assert.equal(requests[0].method, "POST", name);
    assert.equal(requests[0].url, "/screenshots/upload", name);
    assert.equal(requests[0].headers.authorization, `Bearer ${placeholder}`, name);
    assert.equal(requests[0].headers["x-repo"], "example/repo", name);
    assert.equal(requests[0].headers["x-filename"], "shot.png", name);
    assert.deepEqual(requests[0].body, png, name);
    assert.match(result.stdout, /^!\[shot\.png\]\(/m, name);
    assert.equal(`${result.stdout}${result.stderr}`.includes("raw-secret"), false, name);
  }
});

test("sandbox helper fails closed without a URL or placeholder and never falls back", async (t) => {
  const dir = tempDir(t);
  const requests = [];
  const server = createServer(record(requests));
  const port = await listen(server);
  t.after(() => close(server));

  for (const scenario of [
    { name: "missing URL", env: {} },
    { name: "raw token", env: { GH_RELEASE_UPLOAD_URL: `http://127.0.0.1:${port}/screenshots/upload`, EXECUTOR_TOKEN: "raw-secret-token" } },
    { name: "raw memory token", env: { GH_RELEASE_UPLOAD_URL: `http://127.0.0.1:${port}/screenshots/upload`, BOT_MEMORY_TOKEN: "raw-secret-token" } },
    { name: "missing placeholder", env: { GH_RELEASE_UPLOAD_URL: `http://127.0.0.1:${port}/screenshots/upload` } },
  ]) {
    requests.length = 0;
    const result = await upload(dir, { REHOR_INPUT_SOURCE: "sandbox", ...scenario.env });
    assert.notEqual(result.status, 0, `${scenario.name} must fail closed`);
    assert.match(result.stderr, /^ERR: /m, scenario.name);
    assert.equal(requests.length, 0, `${scenario.name} must not reach the network`);
    assert.equal(`${result.stdout}${result.stderr}`.includes("raw-secret-token"), false, scenario.name);
  }
});

test("the preset and image copies of the upload helper stay identical", () => {
  assert.equal(readFileSync(presetHelper, "utf8"), readFileSync(imageHelper, "utf8"));
});
