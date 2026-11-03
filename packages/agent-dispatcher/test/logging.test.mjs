import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createLifecycleLogger } from "../dist/logging.js";

const events = [
  "startup", "configuration", "kubernetes.token_request", "memory.missing_token",
  "memory.invalid_token", "memory.token", "gateway.authentication", "gateway.oidc",
  "ready", "shutdown",
];

function fixture() {
  const lines = [];
  let time = 100;
  const logger = createLifecycleLogger({ write: (line) => lines.push(line), now: () => time });
  return { logger, lines, advance: (ms) => { time += ms; } };
}

// pino adds its level to each record; everything else is our lifecycle schema.
const fields = (line) => {
  const { event, status, durationMs, category } = JSON.parse(line);
  return durationMs !== undefined || category !== undefined
    ? { event, status, ...(durationMs !== undefined && { durationMs }), ...(category !== undefined && { category }) }
    : { event, status };
};

test("all fixed lifecycle events and statuses produce JSON, without arbitrary metadata", () => {
  const { logger, lines } = fixture();
  for (const event of events) {
    for (const status of ["start", "success", "failure"]) {
      logger.log(event, status, { category: "network", message: "secret", token: "secret" });
    }
  }
  assert.equal(lines.length, events.length * 3);
  const first = JSON.parse(lines[0]);
  assert.equal(first.event, "startup");
  assert.equal(first.status, "start");
  assert.equal(first.category, "network");
  assert.equal(first.level, 30);
  assert.ok(lines.every((line) => JSON.parse(line).level === 30 || JSON.parse(line).level === 50));
  assert.ok(lines.every((line) => !line.includes("secret")));
});

test("runtime rejects arbitrary event names, statuses, categories, and malformed input", () => {
  const { logger, lines } = fixture();
  for (const event of ["secret", "__proto__", "constructor", "STARTUP", "", null, 1, {}, Symbol("secret")]) {
    assert.doesNotThrow(() => logger.log(event, "start"));
    assert.doesNotThrow(() => logger.start(event).failure("internal"));
  }
  for (const status of ["secret", "__proto__", null, 0, {}]) logger.log("startup", status);
  for (const options of [null, "secret", 1, { category: "secret" }, { category: {} },
    { durationMs: "1" }, { durationMs: NaN }, { durationMs: Infinity },
    { get category() { throw new Error("secret"); } },
    new Proxy({}, { get() { throw new Error("secret"); } })]) {
    assert.doesNotThrow(() => logger.log("startup", "failure", options));
  }
  assert.deepEqual(lines, []);
});

test("durations are bounded, rounded and measured with an injectable clock", () => {
  const { logger, lines, advance } = fixture();
  logger.log("startup", "success", { durationMs: -4 });
  logger.log("startup", "success", { durationMs: 2.6 });
  logger.log("startup", "success", { durationMs: Number.MAX_VALUE });
  const operation = logger.start("kubernetes.token_request");
  advance(123);
  operation.failure("credentials");
  assert.deepEqual(lines.map(fields), [
    { event: "startup", status: "success", durationMs: 0 },
    { event: "startup", status: "success", durationMs: 3 },
    { event: "startup", status: "success", durationMs: 86_400_000 },
    { event: "kubernetes.token_request", status: "start" },
    { event: "kubernetes.token_request", status: "failure", durationMs: 123, category: "credentials" },
  ]);
  assert.equal(JSON.parse(lines.at(-1)).level, 50);
});

test("broken clocks omit duration without leaking errors", () => {
  const lines = [];
  const logger = createLifecycleLogger({
    write: (line) => lines.push(line),
    now: () => { throw new Error("clock-secret"); },
  });
  assert.doesNotThrow(() => logger.start("gateway.oidc").success());
  assert.deepEqual(lines.map(fields), [
    { event: "gateway.oidc", status: "start" },
    { event: "gateway.oidc", status: "success" },
  ]);
});

test("writer errors never escape or get logged, including rejected async writers", async () => {
  const original = new Error("business-secret");
  const logger = createLifecycleLogger({ write: () => { throw new Error("writer-secret"); } });
  const stderr = process.stderr.write;
  const consoleError = console.error;
  const output = [];
  try {
    process.stderr.write = (chunk) => { output.push(String(chunk)); return true; };
    console.error = (...args) => { output.push(args.join(" ")); };
    assert.throws(() => {
      try { throw original; } finally { logger.log("shutdown", "failure", { category: "internal" }); }
    }, (error) => error === original);
    const asyncLogger = createLifecycleLogger({ write: async () => { throw new Error("async-writer-secret"); } });
    assert.doesNotThrow(() => asyncLogger.log("startup", "start"));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.stderr.write = stderr;
    console.error = consoleError;
  }
  assert.deepEqual(output, []);
});

test("dispatcher exits after SIGTERM with stdout pipe already full", { timeout: 8000 }, async () => {
  const preload = `
    import { writeSync } from 'node:fs';
    process.stdout._handle.setBlocking(false);
    try { for (;;) writeSync(1, Buffer.alloc(4096)); }
    catch (error) { if (error.code !== 'EAGAIN') throw error; }
    process.stdout._handle.setBlocking(true);
    setTimeout(() => process.send('full'), 200);
  `;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "dist/index.js"], {
    cwd: new URL("..", import.meta.url), env: {}, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve) => child.once("message", resolve));
    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("dispatcher failed to exit")), 3000); timer.unref(); }),
    ]);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stderr, "");
  } finally { child.kill("SIGKILL"); child.stdout.destroy(); }
});

test("SIGTERM during memory preflight drains current work without starting Gateway", { timeout: 8000 }, async () => {
  const preload = `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const fs = createRequire(process.cwd() + '/preload.cjs')('node:fs/promises');
    fs.readFile = async () => { await new Promise(resolve => setTimeout(resolve, 400)); throw new Error('file-secret'); };
    syncBuiltinESMExports();
  `;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "dist/index.js"], {
    cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"], env: {
      AGENT_DISPATCHER_AUTH_NAMESPACE: "agents",
      AGENT_DISPATCHER_AUTH_SERVICE_ACCOUNT: "sandbox-agent",
      AGENT_DISPATCHER_AUTH_MEMORY_URL: "https://memory.example/health",
      KUBERNETES_SERVICE_HOST: "kubernetes.example",
      OPENSHELL_GATEWAY_ENDPOINT: "https://gateway.example",
      OPENSHELL_GATEWAY_NAME: "gateway",
      OPENSHELL_OIDC_ISSUER: "https://issuer.example",
      OPENSHELL_CLIENT_ID: "client-secret-id",
      OPENSHELL_OIDC_AUDIENCE: "audience-secret",
      OPENSHELL_OIDC_CLIENT_SECRET: "client-secret",
    },
  });
  let output = "";
  let stderr = "";
  let signaled = false;
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!signaled && output.includes('"event":"kubernetes.token_request","status":"start"')) {
      signaled = true;
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
    const stopStart = steps.findIndex(([event, status]) => event === "shutdown" && status === "start");
    const tokenFailure = steps.findIndex(([event, status]) => event === "kubernetes.token_request" && status === "failure");
    const stopSuccess = steps.findIndex(([event, status]) => event === "shutdown" && status === "success");
    assert.ok(stopStart >= 0 && tokenFailure > stopStart && stopSuccess > tokenFailure);
    assert.ok(!steps.some(([event, status]) => event === "gateway.authentication" || event === "ready" || (event === "startup" && status === "failure")));
    assert.equal(stderr, "");
    assert.doesNotMatch(output, /file-secret|client-secret|audience-secret|memory\.example|kubernetes\.example|issuer\.example/);
  } finally { child.kill("SIGKILL"); }
});
