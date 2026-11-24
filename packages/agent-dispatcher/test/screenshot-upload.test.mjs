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

test("sandbox screenshot URL agrees with the admitted policy route", () => {
  const bare = { PATH: "/bin" };
  const withGateway = sandboxEnvironment(bare, undefined, gateway());
  assert.equal(withGateway.GH_RELEASE_UPLOAD_URL, "https://service-gateway.example.test:8454/screenshots/upload");

  // Legacy behavior is preserved: no gateway configured, no rewrite.
  assert.equal(sandboxEnvironment(bare, undefined).GH_RELEASE_UPLOAD_URL, undefined);
  assert.equal(
    sandboxEnvironment({ GH_RELEASE_UPLOAD_URL: "http://proxy:8446/upload" }, undefined).GH_RELEASE_UPLOAD_URL,
    "http://proxy:8446/upload",
  );

  // The URL the helper receives must be exactly the route the policy admits.
  // The rule's method, client binary and credential binding are asserted once
  // in memory-policy.test.mjs.
  const endpoint = createMemoryPolicy(memoryUrl(), "provider-name-1", undefined, undefined, { serviceGatewayUrl: gateway() })
    .networkPolicies.service_gateway_screenshots.endpoints[0];
  const route = new URL(withGateway.GH_RELEASE_UPLOAD_URL);
  assert.equal(endpoint.host, route.hostname);
  assert.equal(endpoint.port, Number(route.port));
  assert.equal(endpoint.path, route.pathname);
});

test("legacy helper keeps the unauthenticated upload contract even with a configured credential", async (t) => {
  const dir = tempDir(t);
  const requests = [];
  const server = createServer(record(requests));
  const port = await listen(server);
  t.after(() => close(server));

  const result = await upload(dir, { GH_RELEASE_UPLOAD_URL: `http://127.0.0.1:${port}/upload`, BOT_MEMORY_TOKEN: "fixture-legacy-credential" });
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

  // A raw credential is configured alongside the supervisor marker: only the
  // placeholder may reach the request, and only as the bearer value.
  const result = await upload(dir, {
    REHOR_INPUT_SOURCE: "sandbox",
    GH_RELEASE_UPLOAD_URL: `http://127.0.0.1:${port}/screenshots/upload`,
    EXECUTOR_TOKEN: placeholder,
    BOT_MEMORY_TOKEN: "raw-secret-must-not-be-used",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "/screenshots/upload");
  assert.equal(requests[0].headers.authorization, `Bearer ${placeholder}`);
  assert.deepEqual(requests[0].body, png);
  assert.match(result.stdout, /^!\[shot\.png\]\(/m);
  assert.equal(`${result.stdout}${result.stderr}`.includes("raw-secret"), false);
});

test("sandbox helper fails closed without a URL or placeholder and never falls back", async (t) => {
  const dir = tempDir(t);
  const requests = [];
  const server = createServer(record(requests));
  const port = await listen(server);
  t.after(() => close(server));

  for (const scenario of [
    { name: "missing URL", env: {} },
    { name: "non-placeholder credential", env: { GH_RELEASE_UPLOAD_URL: `http://127.0.0.1:${port}/screenshots/upload`, EXECUTOR_TOKEN: "raw-secret-token" } },
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
