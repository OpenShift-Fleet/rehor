import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLifecycleLogger } from "../dist/logging.js";

const events = [
  "startup", "configuration", "kubernetes.token_request", "memory.missing_token",
  "memory.invalid_token", "memory.token", "gateway.authentication", "gateway.oidc",
  "sandbox.session", "sandbox.cleanup", "ready", "shutdown",
];

function fixture() {
  const lines = [];
  let time = 100;
  const logger = createLifecycleLogger({ write: (line) => lines.push(line), now: () => time });
  return { logger, lines, advance: (ms) => { time += ms; } };
}

// pino adds its level to each record; everything else is our lifecycle schema.
const fields = (line) => {
  const { event, status, durationMs, category, stage, errorCode } = JSON.parse(line);
  return durationMs !== undefined || category !== undefined || stage !== undefined || errorCode !== undefined
    ? { event, status, ...(durationMs !== undefined && { durationMs }), ...(category !== undefined && { category }), ...(stage !== undefined && { stage }), ...(errorCode !== undefined && { errorCode }) }
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
  for (const options of [null, "secret", 1, { category: "secret" }, { category: {} }, { stage: "secret" }, { errorCode: "secret" },
    { durationMs: "1" }, { durationMs: NaN }, { durationMs: Infinity },
    { get category() { throw new Error("secret"); } },
    new Proxy({}, { get() { throw new Error("secret"); } })]) {
    assert.doesNotThrow(() => logger.log("startup", "failure", options));
  }
  assert.deepEqual(lines, []);
});

test("session diagnostics expose only fixed stage and error codes", () => {
  const { logger, lines } = fixture();
  const session = logger.start("sandbox.session");
  session.failure("internal", { stage: "runner", errorCode: "unavailable" });
  assert.deepEqual(lines.map(fields), [
    { event: "sandbox.session", status: "start" },
    { event: "sandbox.session", status: "failure", durationMs: 0, category: "internal", stage: "runner", errorCode: "unavailable" },
  ]);
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

test("production wiring preserves decision, filters runner env, and drains signal-racing sessions with mocks only", { timeout: 8000 }, async () => {
  const modules = {
    "config.js": `export const readAuthConfig = () => ({ memoryUrl: new URL('https://memory.example') }); export const readBotMemoryUrl = () => new URL('https://memory.example/mcp'); export const readServiceGatewayUrl = () => new URL('https://services.example/'); export const readModelProxyUrl = () => undefined; export const readPublicEgressEnabled = () => false;`,
    "preflight.js": `export const createCredentialProvider = () => ({ get: async () => {}, mint: async () => ({ token: 'mock-memory-credential', expiresAt: 123 }) }); export const preflightFailureMessage = () => 'failed';`,
    "gateway-config.js": `export const readGatewayConfig = () => ({});`,
    "gateway.js": `export const connectGateway = async () => ({ raw: {} });`,
    "config-repositories.js": `export const parseConfigRepositories = () => [{}];`,
    "work-preflight.js": `export const verifyPreflightTools = async () => {};`,
    "dispatcher-loop.js": `
      export const preflightEnvironment = () => ({ PATH: '/host/bin', BOT_LABEL: 'host-label', BOT_INSTANCE_ID: 'host-instance', BOT_MEMORY_URL: 'https://unvalidated.example/mcp', JIRA_MCP_URL: 'http://jira.internal/mcp', EXECUTOR_ADDR: 'executor.internal:9090' });
      export async function runDispatcherLoop(options) {
        process.send({ event: 'host', environment: options.env });
        process.send({ event: 'minted', token: await options.memoryCredential() });
        const decision = { action: 'start', prompt: 'sensitive-prompt', scripts: [{ name: '01-work.py', status: 'start', content: 'sensitive-content' }] };
        const profile = { configPath: '/sensitive/config.yaml', image: { reference: 'registry.example/agent:runner' }, preflightEnv: { BOT_LABEL: 'profile-label', BOT_MEMORY_URL: 'https://untrusted.example/mcp' } };
        const completed = options.launch(profile, decision.prompt, decision);
        void completed.then(completion => process.send({ event: 'completion', completion }));
        await new Promise(resolve => setImmediate(resolve));
      }
    `,
    "sandbox-session.js": `
      export class SandboxSession {
        constructor({ raw, memory, runtime, memoryRuntime, serviceGatewayUrl, ...rest }) { if (!raw || !memory.credentialProvider.mint || memory.url.hostname !== 'memory.example' || runtime.kind !== 'legacy' || !memoryRuntime || serviceGatewayUrl.href !== 'https://services.example/' || Object.keys(rest).length) throw new Error('invalid session wiring'); }
        run(image, decision, environment, signal) {
          process.send({ event: 'run', image, decision, environment, aborted: signal.aborted });
          process.exitCode = 7;
          process.kill(process.pid, 'SIGTERM');
          return new Promise(resolve => setTimeout(() => {
            process.send({ event: 'settled', aborted: signal.aborted });
            resolve({ completion: 'gone', outcome: 'passed', cleanup: 'deleted' });
          }, 80));
        }
      }
    `,
  };
  const preload = `
    import { registerHooks } from 'node:module';
    const modules = ${JSON.stringify(modules)};
    registerHooks({ load(url, context, nextLoad) {
      const name = url.split('/').pop();
      if (url.includes('/dist/') && Object.hasOwn(modules, name)) return { format: 'module', source: modules[name], shortCircuit: true };
      return nextLoad(url, context);
    } });
  `;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "dist/index.js"], {
    cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      AGENT_DISPATCHER_CONFIG_REPOS: '["https://example.test/config.git"]',
      BOT_MEMORY_TOKEN: 'must-not-forward', OPENSHELL_OIDC_CLIENT_SECRET: 'must-not-forward',
      KUBERNETES_SERVICE_HOST: 'must-not-forward',
    },
  });
  const messages = [];
  let stdout = "";
  let stderr = "";
  child.on("message", (message) => messages.push(message));
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const result = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    assert.deepEqual(result, { code: 7, signal: null });
    assert.equal(stderr, "");
    assert.deepEqual(messages.map(({ event }) => event), ["host", "minted", "run", "settled", "completion"]);
    assert.deepEqual(messages[0].environment, { PATH: "/host/bin", BOT_LABEL: "host-label", BOT_INSTANCE_ID: "host-instance", BOT_MEMORY_URL: "https://memory.example/mcp", JIRA_MCP_URL: "http://jira.internal/mcp", EXECUTOR_ADDR: "executor.internal:9090" });
    assert.equal(messages[1].token, "mock-memory-credential");
    assert.equal(messages[2].image, "registry.example/agent:runner");
    assert.deepEqual(messages[2].decision, { action: "start", prompt: "sensitive-prompt", scripts: [{ name: "01-work.py", status: "start", content: "sensitive-content" }] });
    assert.deepEqual(messages[2].environment, { BOT_LABEL: "profile-label", BOT_INSTANCE_ID: "host-instance", BOT_MEMORY_URL: "https://memory.example/mcp", JIRA_MCP_URL: "https://services.example/jira/mcp", EXECUTOR_ADDR: "executor.internal:9090", EXECUTOR_HTTP_URL: "https://services.example/executor/execute" });
    assert.equal(messages[2].aborted, false);
    assert.equal(messages[3].aborted, true);
    assert.equal(messages[4].completion, "gone");
    const records = stdout.trim().split("\n").map(JSON.parse);
    const shutdownSuccess = records.findIndex(({ event, status }) => event === "shutdown" && status === "success");
    const sessionSuccess = records.findIndex(({ event, status }) => event === "sandbox.session" && status === "success");
    assert.ok(sessionSuccess >= 0 && shutdownSuccess > sessionSuccess);
    assert.doesNotMatch(stdout, /sensitive|config\.yaml|memory-credential|must-not-forward|registry\.example/);
  } finally { child.kill("SIGKILL"); }
});

test("dispatcher exits after SIGTERM with stdout pipe already full", { timeout: 8000 }, async () => {
  const preload = `
    import { writeSync } from 'node:fs';
    process.stdout._handle.setBlocking(false);
    try { for (;;) writeSync(1, Buffer.alloc(4096)); }
    catch (error) { if (error.code !== 'EAGAIN') throw error; }
    try { for (;;) writeSync(1, Buffer.alloc(1)); }
    catch (error) { if (error.code !== 'EAGAIN') throw error; }
    process.stdout._handle.setBlocking(true);
    const on = process.on;
    process.on = function(event, listener) {
      const result = on.call(this, event, listener);
      if (event === 'SIGTERM') process.nextTick(() => process.send('full'));
      return result;
    };
  `;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "dist/index.js"], {
    cwd: new URL("..", import.meta.url), env: {}, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    assert.equal(await new Promise((resolve) => child.once("message", resolve)), "full");
    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("dispatcher failed to exit")), 3000); timer.unref(); }),
    ]);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stderr, "");
  } finally { child.kill("SIGKILL"); child.stdout.destroy(); }
});

test("dispatcher exits after SIGTERM with stdout pipe closed", { timeout: 8000 }, async () => {
  const preload = `
    const on = process.on;
    process.on = function(event, listener) {
      const result = on.call(this, event, listener);
      if (event === 'SIGTERM') process.nextTick(() => process.send('ready'));
      return result;
    };
  `;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "dist/index.js"], {
    cwd: new URL("..", import.meta.url), env: {}, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.stdout.destroy();
  try {
    assert.equal(await new Promise((resolve) => child.once("message", resolve)), "ready");
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.equal(stderr, "");
  } finally { child.kill("SIGKILL"); }
});

for (const mode of ["readable", "full", "closed", "missing setBlocking", "missing handle", "failed setBlocking", "undefined setBlocking"]) {
  test(`default cycle output survives ${mode} stdout`, { timeout: 8000 }, async () => {
    const preload = `
      import { writeSync } from 'node:fs';
      import { registerHooks } from 'node:module';
      if (!['closed', 'readable'].includes(${JSON.stringify(mode)})) {
        process.stdout._handle.setBlocking(false);
        try { for (;;) writeSync(1, Buffer.alloc(4096)); }
        catch (error) { if (error.code !== 'EAGAIN') throw error; }
        try { for (;;) writeSync(1, Buffer.alloc(1)); }
        catch (error) { if (error.code !== 'EAGAIN') throw error; }
        process.stdout._handle.setBlocking(true);
        if (${JSON.stringify(mode)} === 'missing setBlocking') {
          Object.defineProperty(process.stdout._handle, 'setBlocking', { value: undefined });
        }
        if (${JSON.stringify(mode)} === 'missing handle') {
          Object.defineProperty(process.stdout, '_handle', { value: undefined });
        }
        if (${JSON.stringify(mode)} === 'failed setBlocking') {
          Object.defineProperty(process.stdout._handle, 'setBlocking', { value: () => -1 });
        }
        if (${JSON.stringify(mode)} === 'undefined setBlocking') {
          Object.defineProperty(process.stdout._handle, 'setBlocking', { value: () => undefined });
        }
      }
      registerHooks({ load(url, context, nextLoad) {
        if (url.endsWith('/dist/dispatcher-cycle.js')) return { format: 'module', shortCircuit: true, source: \`
          export async function runDispatcherCycle() {
            return { get status() { process.send('cycle-emitted'); return 'invalid-config'; }, repositories: [] };
          }
        \` };
        return nextLoad(url, context);
      } });
    `;
    const script = `
      const { createLifecycleLogger } = await import('./dist/logging.js');
      const { runDispatcherLoop } = await import('./dist/dispatcher-loop.js');
      const controller = new AbortController();
      process.on('SIGTERM', () => controller.abort());
      createLifecycleLogger().log('startup', 'start');
      await runDispatcherLoop({ repositoriesJson: 'secret-config', signal: controller.signal });
      process.disconnect();
    `;
    const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "--input-type=module", "-e", script], {
      cwd: new URL("..", import.meta.url), env: {}, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    if (mode === "readable") child.stdout.on("data", (chunk) => { stdout += chunk; });
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    const closed = new Promise((resolve) => child.once("close", resolve));
    const emitted = new Promise((resolve) => child.once("message", resolve));
    const deadline = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("cycle or shutdown stalled")), 3000); timer.unref(); });
    if (mode === "closed") child.stdout.destroy();
    try {
      assert.equal(await Promise.race([emitted, exited, deadline]), "cycle-emitted");
      child.kill("SIGTERM");
      assert.deepEqual(await Promise.race([exited, deadline]), { code: 0, signal: null });
      assert.equal(stderr, "");
      if (mode === "readable") {
        await Promise.race([closed, deadline]);
        const records = stdout.trim().split("\n").map(JSON.parse);
        assert.deepEqual(records.find(({ event }) => event === "preflight.cycle"), { event: "preflight.cycle", result: { status: "invalid-config", repositories: [] } });
        assert.doesNotMatch(stdout, /secret-config/);
      }
    } finally { child.kill("SIGKILL"); child.stdout.destroy(); }
  });
}

test("dispatcher writes lifecycle and default cycle events to a regular stdout file", { timeout: 8000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dispatcher-stdout-"));
  const path = join(directory, "stdout.jsonl");
  const file = await open(path, "wx", 0o600);
  t.after(async () => { await file.close(); await rm(directory, { recursive: true, force: true }); });
  const modules = {
    "config.js": `export const readAuthConfig = () => ({ memoryUrl: new URL('https://memory.example') }); export const readBotMemoryUrl = () => undefined; export const readServiceGatewayUrl = () => undefined; export const readModelProxyUrl = () => undefined; export const readPublicEgressEnabled = () => false;`,
    "preflight.js": `export const createCredentialProvider = () => ({ get: async () => {}, mint: async () => ({ token: 'secret-credential', expiresAt: 123 }) }); export const preflightFailureMessage = () => 'failed';`,
    "gateway-config.js": `export const readGatewayConfig = () => ({});`,
    "gateway.js": `export const connectGateway = async () => ({ raw: {} });`,
    "config-repositories.js": `export const parseConfigRepositories = () => [{}];`,
    "work-preflight.js": `export const verifyPreflightTools = async () => {};`,
    "dispatcher-cycle.js": `export async function runDispatcherCycle() { return { get status() { process.send('cycle-emitted'); return 'invalid-config'; }, repositories: [] }; }`,
  };
  const preload = `
    import { registerHooks } from 'node:module';
    const modules = ${JSON.stringify(modules)};
    registerHooks({ load(url, context, nextLoad) {
      const name = url.split('/').pop();
      if (url.includes('/dist/') && Object.hasOwn(modules, name)) return { format: 'module', source: modules[name], shortCircuit: true };
      return nextLoad(url, context);
    } });
  `;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "dist/index.js"], {
    cwd: new URL("..", import.meta.url), stdio: ["ignore", file.fd, "pipe", "ipc"],
    env: { AGENT_DISPATCHER_CONFIG_REPOS: 'secret-config', BOT_MEMORY_TOKEN: 'secret-token' },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const emitted = new Promise((resolve) => child.once("message", resolve));
  const deadline = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("cycle or shutdown stalled")), 3000); timer.unref(); });
  try {
    assert.equal(await Promise.race([emitted, exited, deadline]), "cycle-emitted");
    child.kill("SIGTERM");
    assert.deepEqual(await Promise.race([exited, deadline]), { code: 0, signal: null });
    assert.equal(stderr, "");
    const output = await readFile(path, "utf8");
    const records = output.trim().split("\n").map(JSON.parse);
    assert.ok(records.some(({ event, status }) => event === "startup" && status === "start"));
    assert.ok(records.some(({ event, status }) => event === "shutdown" && status === "success"));
    assert.deepEqual(records.find(({ event }) => event === "preflight.cycle"), { event: "preflight.cycle", result: { status: "invalid-config", repositories: [] } });
    assert.doesNotMatch(output, /secret-config|secret-token|secret-credential|memory\.example/);
  } finally { child.kill("SIGKILL"); }
});

test("SIGTERM with unresolved session cleanup logs shutdown failure and keeps nonzero exit", { timeout: 8000 }, async () => {
  const modules = {
    "config.js": `export const readAuthConfig = () => ({ memoryUrl: new URL('https://memory.example') }); export const readBotMemoryUrl = () => undefined; export const readServiceGatewayUrl = () => undefined; export const readModelProxyUrl = () => undefined; export const readPublicEgressEnabled = () => false;`,
    "preflight.js": `export const createCredentialProvider = () => ({ get: async () => {}, mint: async () => ({ token: 'mock-token', expiresAt: 123 }) }); export const preflightFailureMessage = () => 'failed';`,
    "gateway-config.js": `export const readGatewayConfig = () => ({});`,
    "gateway.js": `export const connectGateway = async () => ({ raw: {} });`,
    "config-repositories.js": `export const parseConfigRepositories = () => [{}];`,
    "work-preflight.js": `export const verifyPreflightTools = async () => {};`,
    "dispatcher-loop.js": `
      export const preflightEnvironment = () => ({});
      export async function runDispatcherLoop(options) {
        const decision = { action: 'start', prompt: 'work', scripts: [] };
        const profile = { image: { reference: 'registry.example/agent:runner' }, preflightEnv: {} };
        const completion = await options.launch(profile, decision.prompt, decision);
        process.send({ event: 'completion', completion });
      }
    `,
    "sandbox-session.js": `
      export class SandboxSession {
        constructor({ raw, memory, runtime }) { if (!raw || !memory.credentialProvider.mint || runtime.kind !== 'legacy') throw new Error('invalid session wiring'); }
        run() {
          process.exitCode = 7;
          process.kill(process.pid, 'SIGTERM');
          return new Promise(resolve => setTimeout(() => resolve({ completion: 'unknown', outcome: 'unknown', cleanup: 'unknown' }), 40));
        }
      }
    `,
  };
  const preload = `
    import { registerHooks } from 'node:module';
    const modules = ${JSON.stringify(modules)};
    registerHooks({ load(url, context, nextLoad) {
      const name = url.split('/').pop();
      if (url.includes('/dist/') && Object.hasOwn(modules, name)) return { format: 'module', source: modules[name], shortCircuit: true };
      return nextLoad(url, context);
    } });
  `;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "dist/index.js"], {
    cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe", "ipc"], env: {
      AGENT_DISPATCHER_CONFIG_REPOS: '["https://example.test/config.git"]',
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const result = await new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    assert.deepEqual(result, { code: 7, signal: null });
    assert.equal(stderr, "");
    const records = stdout.trim().split("\n").map(JSON.parse);
    assert.ok(records.some(({ event, status }) => event === "sandbox.cleanup" && status === "failure"));
    assert.ok(records.some(({ event, status, category }) => event === "shutdown" && status === "failure" && category === "internal"));
    assert.equal(records.some(({ event, status }) => event === "shutdown" && status === "success"), false);
  } finally { child.kill("SIGKILL"); }
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
