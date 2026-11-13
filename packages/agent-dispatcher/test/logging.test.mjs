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
  "preflight.cycle", "preflight.error", "preflight.run",
  "sandbox.session", "sandbox.cleanup", "sandbox.retention", "ready", "shutdown",
];

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Parse a record, requiring an ISO 8601 timestamp, and strip it for comparisons. */
function parsed(line) {
  const { time, ...record } = JSON.parse(line);
  assert.match(time, ISO_TIME);
  return record;
}

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

test("retention records expose only opaque gateway names and a bounded duration", () => {
  const { logger, lines } = fixture();
  logger.log("sandbox.retention", "success", { retentionMs: 30_000, workspaceName: "w123456789012345678", sandboxName: "s123456789012345678" });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.event, "sandbox.retention");
  assert.equal(record.status, "success");
  assert.equal(record.workspaceName, "w123456789012345678");
  assert.equal(record.sandboxName, "s123456789012345678");
  assert.equal(record.retentionMs, 30000);
  for (const options of [
    { workspaceName: "not-a-name" }, { workspaceName: "" }, { workspaceName: 19 },
    { sandboxName: "S1234567890123456789" }, { sandboxName: "s12345678901234567" },
    { sandboxName: "secret-token-payload" }, { retentionMs: "30000" }, { retentionMs: NaN }, { retentionMs: Infinity },
  ]) {
    logger.log("sandbox.retention", "success", options);
  }
  assert.equal(lines.length, 1, "malformed retention details are dropped, never logged");
});

test("session lock records expose only fixed contention, holder and failure flags", () => {
  const { logger, lines } = fixture();
  logger.log("sandbox.lock", "success", { contended: true, holder: "rehor-agent-dispatcher-7f9d8c6b5-x2k4z" });
  logger.log("sandbox.lock", "failure", { category: "internal" });
  logger.log("sandbox.lock", "failure", { renew: true });
  logger.log("sandbox.lock", "failure", { release: true });
  assert.deepEqual(lines.map(parsed), [
    { event: "sandbox.lock", status: "success", contended: true, holder: "rehor-agent-dispatcher-7f9d8c6b5-x2k4z", level: 30 },
    { event: "sandbox.lock", status: "failure", category: "internal", level: 50 },
    { event: "sandbox.lock", status: "failure", renew: true, level: 50 },
    { event: "sandbox.lock", status: "failure", release: true, level: 50 },
  ]);
  for (const options of [
    { holder: "not a pod name" }, { holder: "Pod_Name" }, { holder: "" }, { holder: "-leading" }, { holder: "trailing-" }, { holder: 7 },
    { contended: "yes" }, { renew: 1 }, { release: null },
  ]) {
    logger.log("sandbox.lock", "success", options);
  }
  assert.equal(lines.length, 4, "malformed lock details are dropped, never logged");
});

test("registry and reconcile records expose only fixed identifiers and outcomes", () => {
  const { logger, lines } = fixture();
  const runId = "01234567-89ab-cdef-0123-456789abcdef";
  logger.log("sandbox.registry", "failure", { register: true });
  logger.log("sandbox.registry", "failure", { update: true });
  logger.log("sandbox.reconcile", "success", { runId, reason: "adopted", adopted: true });
  logger.log("sandbox.reconcile", "failure", { runId, reason: "startup-timeout" });
  assert.deepEqual(lines.map(parsed), [
    { event: "sandbox.registry", status: "failure", register: true, level: 50 },
    { event: "sandbox.registry", status: "failure", update: true, level: 50 },
    { event: "sandbox.reconcile", status: "success", runId, reason: "adopted", adopted: true, level: 30 },
    { event: "sandbox.reconcile", status: "failure", runId, reason: "startup-timeout", level: 50 },
  ]);
  for (const options of [
    { runId: "not-a-uuid" }, { runId: "" }, { runId: 42 },
    { reason: "secret" }, { reason: "ADOPTED" }, { adopted: "yes" }, { adopted: 1 },
    { register: "true" }, { update: null },
  ]) {
    logger.log("sandbox.reconcile", "success", options);
    logger.log("sandbox.registry", "failure", options);
  }
  assert.equal(lines.length, 4, "malformed registry and reconcile details are dropped, never logged");
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
    { event: "kubernetes.token_request", status: "failure", durationMs: 123, category: "credentials" },
  ]);
  assert.equal(JSON.parse(lines.at(-1)).level, 50);
});

test("cheap events collapse to a single completion record; long stages keep their start record", () => {
  const { logger, lines, advance } = fixture();
  for (const event of ["configuration", "kubernetes.token_request", "memory.token", "gateway.authentication", "gateway.oidc"]) {
    const operation = logger.start(event);
    advance(7);
    operation.success();
  }
  for (const event of ["startup", "shutdown", "sandbox.session"]) {
    const operation = logger.start(event);
    advance(9);
    operation.failure("internal");
  }
  assert.deepEqual(lines.map(fields), [
    { event: "configuration", status: "success", durationMs: 7 },
    { event: "kubernetes.token_request", status: "success", durationMs: 7 },
    { event: "memory.token", status: "success", durationMs: 7 },
    { event: "gateway.authentication", status: "success", durationMs: 7 },
    { event: "gateway.oidc", status: "success", durationMs: 7 },
    { event: "startup", status: "start" },
    { event: "startup", status: "failure", durationMs: 9, category: "internal" },
    { event: "shutdown", status: "start" },
    { event: "shutdown", status: "failure", durationMs: 9, category: "internal" },
    { event: "sandbox.session", status: "start" },
    { event: "sandbox.session", status: "failure", durationMs: 9, category: "internal" },
  ]);
});

test("start options ride along on announced stage records", () => {
  const { logger, lines } = fixture();
  const agentId = "d".repeat(64);
  const session = logger.start("sandbox.session", { profile: "profile-例", repository: "https://github.com/org/repo.git", agentId });
  session.success();
  assert.deepEqual(lines.map(parsed), [
    { event: "sandbox.session", status: "start", level: 30, profile: "profile-例", repository: "https://github.com/org/repo.git", agentId },
    { event: "sandbox.session", status: "success", level: 30, durationMs: 0, profile: "profile-例", repository: "https://github.com/org/repo.git", agentId },
  ]);
});

test("every record carries an ISO 8601 timestamp", () => {
  const { logger, lines } = fixture();
  logger.log("ready", "success");
  logger.log("preflight.run", "success", { preflightId: "jira-sprint", decision: "start", agentId: "e".repeat(64) });
  logger.log("preflight.cycle", "success", { decision: "skip", profile: "agent", repository: "https://github.com/org/repo.git", agentId: "e".repeat(64) });
  logger.log("preflight.error", "failure", { reason: "execution" });
  assert.equal(lines.length, 4);
  const times = lines.map((line) => JSON.parse(line).time);
  assert.ok(times.every((time) => ISO_TIME.test(time)));
  assert.ok(times.every((time) => !Number.isNaN(Date.parse(time))));
});

test("decision and cycle reason use fixed allowlists; malformed values reject the whole record", () => {
  const { logger, lines } = fixture();
  const agentId = "f".repeat(64);
  const repository = "https://github.com/org/repo.git";
  for (const decision of ["start", "skip", "busy", "error", "no-scripts", "throttled", "shutdown", "sync-error", "discovery-error", "invalid-config"]) {
    logger.log("preflight.cycle", "success", { decision, profile: "agent", repository, agentId });
  }
  logger.log("preflight.cycle", "success", { decision: "busy", reason: "session in progress", profile: "agent", repository, agentId });
  logger.log("preflight.run", "success", { preflightId: "jira-sprint", decision: "start", profile: "agent", repository, agentId });
  for (const options of [
    { decision: "secret" }, { decision: "START" }, { decision: "" }, { decision: 7 }, { decision: {} }, { decision: null },
    { decision: "busy", reason: "secret reason" },
    { decision: "start", preflightId: "not an id" },
  ]) {
    assert.doesNotThrow(() => logger.log("preflight.cycle", "success", { profile: "agent", repository, ...options }));
    assert.doesNotThrow(() => logger.log("preflight.run", "success", { profile: "agent", repository, ...options }));
  }
  assert.equal(lines.length, 12, "malformed decision or reason values are dropped, never logged");
  assert.deepEqual(lines.map(parsed).map(({ decision, reason }) => [decision, reason ?? null]).slice(0, 3), [
    ["start", null], ["skip", null], ["busy", null],
  ]);
  const busy = lines.map(parsed).find((record) => record.decision === "busy" && record.reason);
  assert.equal(busy.reason, "session in progress");
  assert.ok(lines.every((line) => !line.includes("secret")));
});

test("preflight identity fields accept safe identifiers only; transcripts never logged", () => {
  const { logger, lines } = fixture();
  const agentId = "a".repeat(64);
  logger.log("preflight.error", "failure", {
    category: "configuration",
    profile: "fleetshift-config",
    repository: "https://github.com/org/fleetshift-config.git",
    agentId,
  });
  // Unknown fields (a transcript, free-form message text) are ignored, never
  // logged — the identity fields alone make the record.
  logger.log("preflight.error", "failure", {
    profile: "ok",
    repository: "https://github.com/org/repo.git",
    agentId,
    transcript: "secret-error-detail",
    message: "secret",
  });
  for (const options of [
    { profile: "/etc/passwd", agentId },
    { profile: "x".repeat(2049), agentId },
    { profile: "ok", repository: "https://user:secret@example.test/repo.git", agentId },
    { profile: "ok", repository: "not a url", agentId },
    { profile: "ok", repository: "https://github.com/org/repo.git?query=1", agentId },
    { profile: "ok", repository: "https://github.com/org/repo.git", agentId: "not-a-hash" },
    { profile: "ok", repository: "https://github.com/org/repo.git", agentId: 42 },
    { profile: 7, repository: "https://github.com/org/repo.git", agentId },
  ]) {
    assert.doesNotThrow(() => logger.log("preflight.error", "failure", options));
  }
  assert.equal(lines.length, 2);
  assert.deepEqual(parsed(lines[0]), {
    event: "preflight.error", status: "failure", category: "configuration", level: 50,
    profile: "fleetshift-config",
    repository: "https://github.com/org/fleetshift-config.git",
    agentId,
  });
  assert.deepEqual(parsed(lines[1]), {
    event: "preflight.error", status: "failure", level: 50,
    profile: "ok",
    repository: "https://github.com/org/repo.git",
    agentId,
  });
  assert.ok(lines.every((line) => !line.includes("secret")));
});

test("preflight identity preserves Unicode and removes userinfo and control characters", () => {
  const { logger, lines } = fixture();
  const agentId = "b".repeat(64);
  logger.log("preflight.error", "failure", {
    profile: "Řehoř 例\n\u001b\u202e",
    repository: "ssh://private-user%40token@example.test/org/config.git",
    agentId,
  });
  assert.deepEqual(parsed(lines[0]), {
    event: "preflight.error", status: "failure", level: 50,
    profile: "Řehoř 例\\u{a}\\u{1b}\\u{202e}",
    repository: "ssh://example.test/org/config.git", agentId,
  });
  assert.doesNotMatch(lines[0], /private-user|token|\u001b|\u202e/);
  for (const repository of [
    "ssh://user:private-password@example.test/org/config.git",
    "https://private-user@example.test/org/config.git",
    "ssh://user@example.test/org/config.git?secret=private-query",
    "ssh://user@example.test/org/config.git#private-fragment",
    "ssh://user@example.test/org/\nconfig.git",
    `https://example.test/${"x".repeat(2048)}`,
  ]) logger.log("preflight.error", "failure", { profile: "agent", repository, agentId });
  assert.equal(lines.length, 1);
});

test("preflight reasons use a fixed allowlist", () => {
  const { logger, lines } = fixture();
  for (const reason of ["configuration", "execution"]) logger.log("preflight.error", "failure", { reason });
  for (const reason of ["secret", "internal", "CONFIGURATION", "", null, 1, {}]) {
    logger.log("preflight.error", "failure", { reason });
  }
  assert.deepEqual(lines.map(parsed), [
    { event: "preflight.error", status: "failure", reason: "configuration", level: 50 },
    { event: "preflight.error", status: "failure", reason: "execution", level: 50 },
  ]);
});

test("preflight wiring fields use a fixed allowlist", () => {
  const { logger, lines } = fixture();
  for (const configurationField of ["BOT_INSTANCE_ID", "BOT_MEMORY_URL", "memory credential"]) logger.log("preflight.error", "failure", { configurationField });
  for (const configurationField of ["secret-token", "", null, 1, {}]) logger.log("preflight.error", "failure", { configurationField });
  assert.deepEqual(lines.map(JSON.parse).map(({ configurationField }) => configurationField), ["BOT_INSTANCE_ID", "BOT_MEMORY_URL", "memory credential"]);
});

test("preflight diagnostics and preflight ids pass a strict allowlist", () => {
  const { logger, lines } = fixture();
  const agentId = "c".repeat(64);
  const repository = "https://github.com/org/repo.git";
  const diagnostics = [
    { path: "preflights[0].with.label", code: "invalid_type", message: "Invalid input: expected string, received number", received: "123" },
  ];
  // Every issue is logged: no count or length limit drops any diagnostic.
  const many = Array.from({ length: 40 }, (_, index) => ({ path: `preflights[${index}].with.label`, code: "invalid_type", message: "Invalid input: expected string, received number", received: "123" }));
  const long = { path: "preflights[0].id", code: "unknown_preflight", message: `nope-${"x".repeat(400)}: unknown preflight id`, received: JSON.stringify(`nope-${"x".repeat(400)}`) };
  logger.log("preflight.error", "failure", { reason: "configuration", profile: "ok", repository, agentId, diagnostics, preflightId: "jira-sprint" });
  logger.log("preflight.error", "failure", { reason: "configuration", profile: "ok", repository, agentId, diagnostics: many });
  logger.log("preflight.error", "failure", { reason: "configuration", profile: "ok", repository, agentId, diagnostics: [long] });
  for (const options of [
    { diagnostics: "secret" }, { diagnostics: {} }, { diagnostics: [] },
    { diagnostics: [{ path: "p" }] },
    { diagnostics: [{ path: "p", code: "c", message: "m", received: "r", extra: "secret" }] },
    { diagnostics: [{ path: "p", code: "c", message: "m", received: 7 }] },
    { diagnostics: [{ path: "", code: "c", message: "m", received: "r" }] },
    { diagnostics: [{ path: "p", code: "c", message: "m\u0001", received: "r" }] },
    { preflightId: "not an id" }, { preflightId: "" }, { preflightId: 42 }, { preflightId: "-leading" }, { preflightId: "x".repeat(65) },
  ]) {
    assert.doesNotThrow(() => logger.log("preflight.error", "failure", { agentId, ...options }));
  }
  assert.equal(lines.length, 3, "malformed diagnostics and preflight ids are dropped, never logged");
  assert.deepEqual(parsed(lines[0]), {
    event: "preflight.error", status: "failure", level: 50, reason: "configuration",
    profile: "ok", repository, agentId, diagnostics, preflightId: "jira-sprint",
  });
  assert.equal(JSON.parse(lines[1]).diagnostics.length, 40);
  assert.deepEqual(JSON.parse(lines[2]).diagnostics, [long]);
  assert.ok(lines.every((line) => !line.includes("secret")));
});

test("broken clocks omit duration without leaking errors", () => {
  const lines = [];
  const logger = createLifecycleLogger({
    write: (line) => lines.push(line),
    now: () => { throw new Error("clock-secret"); },
  });
  assert.doesNotThrow(() => logger.start("gateway.oidc").success());
  assert.deepEqual(lines.map(fields), [
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

test("production wiring preserves decision, filters runner env, and drains signal-racing sessions with mocks only", { timeout: 30000 }, async () => {
  const modules = {
    "config.js": `export const readAuthConfig = () => ({ memoryUrl: new URL('https://memory.example') }); export const readBotMemoryUrl = () => new URL('https://memory.example/mcp'); export const readServiceGatewayUrl = () => new URL('https://services.example/'); export const readModelProxyUrl = () => undefined; export const readPublicEgressEnabled = () => false; export const readSandboxRetentionMs = () => 0; export const readSessionLockTtlMs = () => 0;`,
    "preflight.js": `export const createCredentialProvider = () => ({ get: async () => {}, mint: async () => ({ token: 'mock-memory-credential', expiresAt: 123 }) }); export const preflightFailureMessage = () => 'failed';`,
    "gateway-config.js": `export const readGatewayConfig = () => ({});`,
    "gateway.js": `export const connectGateway = async () => ({ raw: {} });`,
    "config-repositories.js": `export const parseConfigRepositories = () => [{}]; export const verifyConfigRepositoryTools = async () => {};`,
    "dispatcher-loop.js": `
      export const preflightEnvironment = () => ({ PATH: '/host/bin', BOT_LABEL: 'host-label', BOT_INSTANCE_ID: 'host-instance', BOT_MEMORY_URL: 'https://unvalidated.example/mcp', JIRA_MCP_URL: 'http://jira.internal/mcp', EXECUTOR_ADDR: 'executor.internal:9090' });
      export async function runDispatcherLoop(options) {
        process.send({ event: 'host', environment: options.env });
        process.send({ event: 'minted', token: await options.memoryCredential() });
        const decision = { action: 'start', prompt: 'sensitive-prompt', scripts: [{ name: '01-work.py', status: 'start', content: 'sensitive-content' }] };
        const profile = { name: 'fixture-profile', configPath: '/sensitive/config.yaml', image: { reference: 'registry.example/agent:runner' }, preflightEnv: { BOT_LABEL: 'profile-label', BOT_MEMORY_URL: 'https://untrusted.example/mcp' } };
        const completed = options.launch(profile, 'a'.repeat(64), decision.prompt, decision, 'https://github.com/org/fixture-config.git');
        void completed.then(completion => process.send({ event: 'completion', completion }));
        await new Promise(resolve => setImmediate(resolve));
      }
    `,
    "sandbox-session.js": `
      export class SandboxSession {
        constructor({ raw, memory, runtime, memoryRuntime, serviceGatewayUrl, sandboxRetentionMs, onRetention, ...rest }) { if (!raw || !memory.credentialProvider.mint || memory.url.hostname !== 'memory.example' || runtime.kind !== 'legacy' || !memoryRuntime || serviceGatewayUrl.href !== 'https://services.example/' || sandboxRetentionMs !== 0 || typeof onRetention !== 'function' || Object.keys(rest).length) throw new Error('invalid session wiring'); }
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
    const sessionStart = records.find(({ event, status }) => event === "sandbox.session" && status === "start");
    assert.equal(sessionStart.profile, "fixture-profile");
    assert.equal(sessionStart.agentId, "a".repeat(64));
    assert.equal(sessionStart.repository, "https://github.com/org/fixture-config.git");
    assert.match(sessionStart.time, ISO_TIME);
    assert.ok(records.every(({ time }) => ISO_TIME.test(time)));
    assert.doesNotMatch(stdout, /sensitive|config\.yaml|memory-credential|must-not-forward|registry\.example/);
  } finally { child.kill("SIGKILL"); }
});

test("dispatcher exits after SIGTERM with stdout pipe already full", { timeout: 30000 }, async () => {
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
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("dispatcher failed to exit")), 20000); timer.unref(); }),
    ]);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stderr, "");
  } finally { child.kill("SIGKILL"); child.stdout.destroy(); }
});

test("dispatcher exits after SIGTERM with stdout pipe closed", { timeout: 30000 }, async () => {
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
  test(`default cycle output survives ${mode} stdout`, { timeout: 30000 }, async () => {
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
            const { createLifecycleLogger } = await import('./logging.js');
            createLifecycleLogger().log('preflight.cycle', 'failure', { decision: 'invalid-config' });
            process.send('cycle-emitted');
            return { status: 'invalid-config', repositories: [] };
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
    const deadline = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("cycle or shutdown stalled")), 20000); timer.unref(); });
    if (mode === "closed") child.stdout.destroy();
    try {
      assert.equal(await Promise.race([emitted, exited, deadline]), "cycle-emitted");
      child.kill("SIGTERM");
      assert.deepEqual(await Promise.race([exited, deadline]), { code: 0, signal: null });
      assert.equal(stderr, "");
      if (mode === "readable") {
        await Promise.race([closed, deadline]);
        const records = stdout.trim().split("\n").map(JSON.parse);
        const cycle = records.find(({ event }) => event === "preflight.cycle");
        assert.equal(cycle.status, "failure");
        assert.equal(cycle.decision, "invalid-config");
        assert.match(cycle.time, ISO_TIME);
        assert.doesNotMatch(stdout, /secret-config/);
      }
    } finally { child.kill("SIGKILL"); child.stdout.destroy(); }
  });
}

test("dispatcher writes lifecycle and default cycle events to a regular stdout file", { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dispatcher-stdout-"));
  const path = join(directory, "stdout.jsonl");
  const file = await open(path, "wx", 0o600);
  t.after(async () => { await file.close(); await rm(directory, { recursive: true, force: true }); });
  const modules = {
    "config.js": `export const readAuthConfig = () => ({ memoryUrl: new URL('https://memory.example') }); export const readBotMemoryUrl = () => new URL('https://memory.example/mcp'); export const readServiceGatewayUrl = () => undefined; export const readModelProxyUrl = () => undefined; export const readPublicEgressEnabled = () => false; export const readSandboxRetentionMs = () => 0; export const readSessionLockTtlMs = () => 0;`,
    "preflight.js": `export const createCredentialProvider = () => ({ get: async () => {}, mint: async () => ({ token: 'secret-credential', expiresAt: 123 }) }); export const preflightFailureMessage = () => 'failed';`,
    "gateway-config.js": `export const readGatewayConfig = () => ({});`,
    "gateway.js": `export const connectGateway = async () => ({ raw: {} });`,
    "config-repositories.js": `export const parseConfigRepositories = () => [{}]; export const verifyConfigRepositoryTools = async () => {};`,
    "dispatcher-cycle.js": `export async function runDispatcherCycle() { const { createLifecycleLogger } = await import('./logging.js'); createLifecycleLogger().log('preflight.cycle', 'failure', { decision: 'invalid-config' }); process.send('cycle-emitted'); return { status: 'invalid-config', repositories: [] }; }`,
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
  const deadline = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("cycle or shutdown stalled")), 20000); timer.unref(); });
  try {
    assert.equal(await Promise.race([emitted, exited, deadline]), "cycle-emitted");
    child.kill("SIGTERM");
    assert.deepEqual(await Promise.race([exited, deadline]), { code: 0, signal: null });
    assert.equal(stderr, "");
    const output = await readFile(path, "utf8");
    const records = output.trim().split("\n").map(JSON.parse);
    assert.ok(records.some(({ event, status }) => event === "startup" && status === "start"));
    assert.ok(records.some(({ event, status }) => event === "shutdown" && status === "success"));
    const cycle = records.find(({ event }) => event === "preflight.cycle");
    assert.equal(cycle.status, "failure");
    assert.equal(cycle.decision, "invalid-config");
    assert.ok(records.every(({ time }) => ISO_TIME.test(time)));
    assert.doesNotMatch(output, /secret-config|secret-token|secret-credential|memory\.example/);
  } finally { child.kill("SIGKILL"); }
});

test("SIGTERM with unresolved session cleanup logs shutdown failure and keeps nonzero exit", { timeout: 30000 }, async () => {
  const modules = {
    "config.js": `export const readAuthConfig = () => ({ memoryUrl: new URL('https://memory.example') }); export const readBotMemoryUrl = () => new URL('https://memory.example/mcp'); export const readServiceGatewayUrl = () => undefined; export const readModelProxyUrl = () => undefined; export const readPublicEgressEnabled = () => false; export const readSandboxRetentionMs = () => 0; export const readSessionLockTtlMs = () => 0;`,
    "preflight.js": `export const createCredentialProvider = () => ({ get: async () => {}, mint: async () => ({ token: 'mock-token', expiresAt: 123 }) }); export const preflightFailureMessage = () => 'failed';`,
    "gateway-config.js": `export const readGatewayConfig = () => ({});`,
    "gateway.js": `export const connectGateway = async () => ({ raw: {} });`,
    "config-repositories.js": `export const parseConfigRepositories = () => [{}]; export const verifyConfigRepositoryTools = async () => {};`,
    "dispatcher-loop.js": `
      export const preflightEnvironment = () => ({});
      export async function runDispatcherLoop(options) {
        const decision = { action: 'start', prompt: 'work', scripts: [] };
        const profile = { name: 'fixture-profile', image: { reference: 'registry.example/agent:runner' }, preflightEnv: {} };
        const completion = await options.launch(profile, 'b'.repeat(64), decision.prompt, decision, 'https://github.com/org/fixture-config.git');
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
    const cleanupFailure = records.find(({ event, status }) => event === "sandbox.cleanup" && status === "failure");
    assert.equal(cleanupFailure.profile, "fixture-profile");
    assert.equal(cleanupFailure.agentId, "b".repeat(64));
    assert.ok(records.some(({ event, status, category }) => event === "shutdown" && status === "failure" && category === "internal"));
    assert.equal(records.some(({ event, status }) => event === "shutdown" && status === "success"), false);
  } finally { child.kill("SIGKILL"); }
});

test("SIGTERM during memory preflight drains current work without starting Gateway", { timeout: 30000 }, async () => {
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
    if (!signaled && output.includes('"event":"startup","status":"start"')) {
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
