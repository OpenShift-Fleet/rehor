import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDispatcherCycle } from "../dist/dispatcher-cycle.js";
import { SessionDispatcher } from "../dist/dispatch-sessions.js";
import { createLifecycleLogger } from "../dist/logging.js";

const urls = ["https://example.test/one.git", "https://example.test/two.git"];
const start = (prompt = "secret-prompt") => ({ action: "start", prompt, scripts: [] });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const profile = (name, root) => ({ name, botRoot: root, workflow: name, instanceDir: `${root}/${name}` });
const options = (extra = {}) => ({
  repositoriesJson: JSON.stringify(urls), cacheRoot: "/cache", env: { BOT_INSTANCE_ID: "secret-instance", BOT_MEMORY_URL: "https://memory.example/mcp" },
  memoryCredential: async () => "fixture-token", dispatcher: new SessionDispatcher(), launch: async () => "gone", ...extra,
});

test("launch receives agent ID, original start decision and script metadata with mock-only dependencies", async () => {
  const decision = {
    action: "start", prompt: "sensitive prompt",
    scripts: [{ name: "gh-pr-status", status: "start", content: "sensitive content" }],
  };
  const selected = profile("agent", "one");
  const calls = [];
  const opts = options({
    repositoriesJson: JSON.stringify([urls[0]]),
    launch: async (...args) => { calls.push(args); return "gone"; },
    dependencies: {
      syncRepositories: async () => [{ name: "one", path: "one", revision: "abc" }],
      discoverProfiles: async () => [selected],
      preflight: async () => decision,
    },
  });
  const result = await runDispatcherCycle(opts);
  await opts.dispatcher.drain();
  assert.equal(result.repositories[0].profiles[0].status, "started");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], selected);
  assert.match(calls[0][1], /^[0-9a-f]{64}$/);
  assert.equal(calls[0][2], decision.prompt);
  assert.equal(calls[0][3], decision);
  assert.deepEqual(calls[0][3].scripts, decision.scripts);
  assert.doesNotMatch(JSON.stringify(result), /sensitive|gh-pr-status/);
});

test("each agent waits five minutes between checks, including skip and error", async () => {
  let now = 0;
  const calls = [];
  const opts = options({
    now: () => now,
    dependencies: {
      syncRepositories: async (_root, [repo]) => [{ name: repo.name, path: repo.name, revision: "abc" }],
      discoverProfiles: async (root) => [profile("same", root)],
      preflight: async ({ repositoryUrl, wiring }) => {
        calls.push(repositoryUrl);
        return { action: repositoryUrl.endsWith("/one.git") ? "skip" : "error", transcript: "", scripts: [] };
      },
    },
  });
  const statuses = async () => (await runDispatcherCycle(opts)).repositories.map((r) => r.profiles[0].status);
  assert.deepEqual(await statuses(), ["skip", "error"]);
  now = 299_999;
  assert.deepEqual(await statuses(), ["throttled", "throttled"]);
  now = 300_000;
  assert.deepEqual(await statuses(), ["skip", "error"]);
  assert.deepEqual(calls, [urls[0], urls[1], urls[0], urls[1]]);
});

test("per-agent preflight environment overrides shared instance identity", async () => {
  const seen = [];
  const opts = options({
    env: { BOT_INSTANCE_ID: "shared", BOT_LABEL: "shared", BOT_MEMORY_URL: "https://memory.example/mcp" },
    dependencies: {
      syncRepositories: async (_root, [repo]) => [{ name: repo.name, path: repo.name, revision: "abc" }],
      discoverProfiles: async (root) => [{ ...profile("same", root), preflightEnv: { BOT_INSTANCE_ID: `${root}-例`, BOT_LABEL: `${root}-label` } }],
      preflight: async ({ wiring }) => { seen.push(wiring); return { action: "skip", transcript: "", scripts: [] }; },
    },
  });
  await runDispatcherCycle(opts);
  assert.deepEqual(seen.map((wiring) => wiring.instanceId), ["one-例", "two-例"]);
});

test("deployment memory URL cannot be replaced by profile in preflight wiring", async () => {
  for (const deploymentUrl of [undefined, "", "https://memory.example/mcp"]) {
    const seen = [];
    const opts = options({
      env: { BOT_INSTANCE_ID: "fixture", BOT_MEMORY_URL: deploymentUrl, JIRA_MCP_URL: "http://jira.internal/mcp", EXECUTOR_ADDR: "executor.internal:9090" },
      dependencies: {
        syncRepositories: async (_root, [repo]) => [{ name: repo.name, path: repo.name, revision: "abc" }],
        discoverProfiles: async (root) => [{ ...profile("same", root), preflightEnv: { BOT_MEMORY_URL: "https://untrusted.example/mcp" } }],
        preflight: async ({ wiring }) => { seen.push(wiring.memory.baseUrl); return { action: "skip", transcript: "", scripts: [] }; },
      },
    });
    await runDispatcherCycle(opts);
    assert.deepEqual(seen, deploymentUrl ? [deploymentUrl, deploymentUrl] : []);
  }
});

test("required wiring failures identify every profile without exposing values or running work", async () => {
  const valid = { BOT_INSTANCE_ID: "identity-例", BOT_MEMORY_URL: "https://memory.example/mcp" };
  for (const [field, value, reason] of [
    ["BOT_INSTANCE_ID", undefined, "configuration"], ["BOT_INSTANCE_ID", "", "configuration"], ["BOT_INSTANCE_ID", " \t", "configuration"],
    ["BOT_MEMORY_URL", undefined, "configuration"], ["BOT_MEMORY_URL", "", "configuration"], ["BOT_MEMORY_URL", " \t", "configuration"],
    ["memory credential", undefined, "configuration"], ["memory credential", "", "configuration"], ["memory credential", " \t", "configuration"],
    ["memory credential", "throw", "execution"],
  ]) {
    const lines = [];
    let calls = 0;
    const env = field === "memory credential" ? valid : { ...valid, [field]: value };
    const credential = field === "memory credential"
      ? value === undefined ? undefined : async () => { if (value === "throw") throw new Error("private-mint-error"); return value; }
      : async () => "private-minted-credential";
    const opts = options({ env, memoryCredential: credential,
      logger: createLifecycleLogger({ write: (line) => lines.push(line) }),
      launch: async () => { calls++; return "gone"; },
      dependencies: {
        syncRepositories: async (_root, [repo]) => [{ name: repo.name, path: repo.name, revision: "abc" }],
        discoverProfiles: async (root) => [{ ...profile("profile", root), preflights: [] }],
        preflight: async () => { calls++; return start(); },
      },
    });
    const result = await runDispatcherCycle(opts);
    assert.deepEqual(result.repositories.map((repo) => repo.profiles[0].status), ["error", "error"]);
    assert.equal(calls, 0);
    assert.deepEqual(lines.map(JSON.parse), result.repositories.map((repo, i) => ({
      level: 50, event: "preflight.error", status: "failure", reason, profile: "profile", repository: urls[i],
      agentId: repo.profiles[0].agentId, configurationField: field,
    })));
    assert.doesNotMatch(JSON.stringify([result, lines]), /private-mint|identity-例|memory\.example/);
  }
});

test("invalid profile identity does not use deployment fallback and can recover without cooldown", async () => {
  let profileId = " ";
  let calls = 0;
  const opts = options({ repositoriesJson: JSON.stringify([urls[0]]), now: () => 0,
    env: { BOT_INSTANCE_ID: "shared", BOT_MEMORY_URL: "https://memory.example/mcp" },
    dependencies: {
      syncRepositories: async () => [{ name: "one", path: "one", revision: "abc" }],
      discoverProfiles: async () => [{ ...profile("agent", "one"), preflightEnv: { BOT_INSTANCE_ID: profileId } }],
      preflight: async ({ wiring }) => { calls++; assert.equal(wiring.instanceId, "identity-例"); return start(); },
    },
  });
  assert.equal((await runDispatcherCycle(opts)).repositories[0].profiles[0].status, "error");
  profileId = "identity-例";
  assert.equal((await runDispatcherCycle(opts)).repositories[0].profiles[0].status, "started");
  await opts.dispatcher.drain();
  assert.equal(calls, 1);
});

test("mint failures are reported even while a profile is busy", async () => {
  const session = deferred();
  const lines = [];
  const opts = options({ repositoriesJson: JSON.stringify([urls[0]]),
    logger: createLifecycleLogger({ write: (line) => lines.push(line) }),
    launch: async () => { await session.promise; return "gone"; },
    dependencies: {
      syncRepositories: async () => [{ name: "one", path: "one", revision: "abc" }],
      discoverProfiles: async () => [profile("agent", "one")],
      preflight: async () => start(),
    },
  });
  assert.equal((await runDispatcherCycle(opts)).repositories[0].profiles[0].status, "started");
  opts.memoryCredential = async () => { throw new Error("private-exception"); };
  const result = await runDispatcherCycle(opts);
  assert.equal(result.repositories[0].profiles[0].status, "error");
  assert.equal(JSON.parse(lines[0]).reason, "execution");
  assert.equal(JSON.parse(lines[0]).configurationField, "memory credential");
  assert.doesNotMatch(lines[0], /private-exception/);
  session.resolve();
  await opts.dispatcher.drain();
});

test("preflight errors identify Unicode profiles and sanitize SSH userinfo", async () => {
  const lines = [];
  const opts = options({ repositoriesJson: JSON.stringify(["ssh://private-user@example.test/config.git"]), env: {},
    logger: createLifecycleLogger({ write: (line) => lines.push(line) }),
    dependencies: {
      syncRepositories: async () => [{ name: "config", path: "one", revision: "abc" }],
      discoverProfiles: async () => [profile("unicode-例", "one")],
      preflight: async () => { throw new Error("must not run"); },
    },
  });
  const result = await runDispatcherCycle(opts);
  assert.deepEqual(JSON.parse(lines[0]), {
    level: 50, event: "preflight.error", status: "failure", reason: "configuration",
    profile: "unicode-例", repository: "ssh://example.test/config.git",
    agentId: result.repositories[0].profiles[0].agentId, configurationField: "BOT_INSTANCE_ID",
  });
  assert.doesNotMatch(lines[0], /private-user/);
});

test("owner identifiers are sanitized before reaching an injected logger", async () => {
  const logs = [];
  const opts = options({ repositoriesJson: JSON.stringify(["ssh://private-user@example.test/config.git"]),
    logger: { log: (event, status, fields) => logs.push({ event, status, ...fields }), start: () => ({ success: () => {}, failure: () => {} }) },
    dependencies: {
      syncRepositories: async () => [{ name: "config", path: "one", revision: "abc" }],
      discoverProfiles: async () => [profile("profile-例\n\u001b", "one")],
      preflight: async () => ({ action: "error", reason: "execution", transcript: "private-transcript", scripts: [] }),
    },
  });
  const result = await runDispatcherCycle(opts);
  assert.deepEqual(logs, [{ event: "preflight.error", status: "failure", reason: "execution",
    profile: "profile-例\\u{a}\\u{1b}", repository: "ssh://example.test/config.git",
    agentId: result.repositories[0].profiles[0].agentId }]);
  assert.doesNotMatch(JSON.stringify(logs), /private-user|private-transcript/);
});

test("invalid owner identifiers retain opaque agent identity", async () => {
  const lines = [];
  const opts = options({ repositoriesJson: JSON.stringify([urls[0]]), env: {},
    logger: createLifecycleLogger({ write: (line) => lines.push(line) }),
    dependencies: {
      syncRepositories: async () => [{ name: "one", path: "one", revision: "abc" }],
      discoverProfiles: async () => [profile("x".repeat(2049), "one")],
    },
  });
  const result = await runDispatcherCycle(opts);
  assert.deepEqual(JSON.parse(lines[0]), {
    level: 50, event: "preflight.error", status: "failure", reason: "configuration",
    repository: urls[0], agentId: result.repositories[0].profiles[0].agentId, configurationField: "BOT_INSTANCE_ID",
  });
});

test("cycle wiring threads the minted credential, services gateway, and instance repos", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dispatcher-wiring-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const instanceDir = join(root, "instance", "agent");
  await mkdir(instanceDir, { recursive: true });
  await writeFile(join(instanceDir, "project-repos.json"), JSON.stringify({ "my-repo": { upstream: "https://github.com/org/my-repo.git" } }));
  const seen = [];
  const opts = (extra = {}) => options({
    repositoriesJson: JSON.stringify([urls[0]]),
    env: { BOT_INSTANCE_ID: "fixture-instance", BOT_MEMORY_URL: "https://memory.example/mcp" },
    memoryCredential: async () => "fixture-token",
    serviceGatewayUrl: new URL("https://services.example/"),
    dependencies: {
      syncRepositories: async () => [{ name: "one", path: "one", revision: "abc" }],
      discoverProfiles: async () => [{ ...profile("agent", "one"), instanceDir }],
      preflight: async (invocation) => { seen.push(invocation); return { action: "skip", transcript: "", scripts: [] }; },
    },
    ...extra,
  });
  await runDispatcherCycle(opts());
  assert.equal(seen.length, 1);
  assert.equal(seen[0].profile.instanceDir, instanceDir);
  assert.equal(seen[0].repositoryUrl, urls[0]);
  assert.deepEqual(seen[0].wiring, {
    instanceId: "fixture-instance",
    memory: { baseUrl: "https://memory.example/mcp", token: "fixture-token" },
    proxyBaseUrl: "https://services.example/",
    repos: { "my-repo": { upstream: "https://github.com/org/my-repo.git" } },
  });
  // No services gateway: no proxy route is invented and repos are omitted
  // when the instance directory has no project-repos.json.
  seen.length = 0;
  const bare = join(root, "instance", "bare");
  await mkdir(bare, { recursive: true });
  const second = opts({ serviceGatewayUrl: undefined, dependencies: {
    syncRepositories: async () => [{ name: "one", path: "one", revision: "abc" }],
    discoverProfiles: async () => [{ ...profile("bare", "one"), instanceDir: bare }],
    preflight: async (invocation) => { seen.push(invocation); return { action: "skip", transcript: "", scripts: [] }; },
  }, dispatcher: new SessionDispatcher() });
  await runDispatcherCycle(second);
  // No services gateway and no project-repos.json: no proxy route or repos
  // are invented; the instance identity and memory wiring still apply.
  assert.deepEqual(seen[0].wiring, {
    instanceId: "fixture-instance",
    memory: { baseUrl: "https://memory.example/mcp", token: "fixture-token" },
  });
});

test("sequential preflights, parallel sessions, busy check and stable unique identities", async () => {
  const events = [];
  const waiting = deferred();
  const dispatcher = new SessionDispatcher();
  const opts = options({ dispatcher, launch: async (p, _agentId, prompt) => {
    events.push(`launch:${prompt}`);
    await waiting.promise;
    return "gone";
  }, dependencies: {
    syncRepositories: async (_root, [repo]) => [{ name: repo.name, path: repo.name, revision: "abc" }],
    discoverProfiles: async (root) => [profile("same", root)],
    preflight: async ({ wiring, signal, repositoryUrl }) => {
      assert.equal(wiring.instanceId, "secret-instance");
      assert.equal(signal, undefined);
      const which = repositoryUrl.endsWith("/one.git") ? "one" : "two";
      events.push(`preflight:${which}`);
      return start(which);
    },
  } });
  const first = await runDispatcherCycle(opts);
  await tick();
  assert.deepEqual(events, ["preflight:one", "launch:one", "preflight:two", "launch:two"]);
  assert.deepEqual(first.repositories.map((r) => r.profiles[0].status), ["started", "started"]);
  const ids = first.repositories.map((r) => r.profiles[0].agentId);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(dispatcher.size, 2);
  const second = await runDispatcherCycle(opts);
  assert.deepEqual(second.repositories.map((r) => r.profiles[0].status), ["busy", "busy"]);
  assert.deepEqual(second.repositories.map((r) => r.profiles[0].agentId), ids);
  assert.equal(events.length, 4);
  assert.doesNotMatch(JSON.stringify(first), /secret|example|one|two/);
  waiting.resolve();
  await dispatcher.drain();
});

test("overlapping cycles do not repeat a preflight within the cooldown", async () => {
  const waiting = deferred();
  const session = deferred();
  const entered = deferred();
  const dispatcher = new SessionDispatcher();
  let calls = 0;
  const opts = options({ repositoriesJson: JSON.stringify([urls[0]]), dispatcher,
    launch: async () => { await session.promise; return "gone"; },
    dependencies: {
      syncRepositories: async () => [{ name: "one", path: "one", revision: "abc" }],
      discoverProfiles: async () => [profile("same", "one")],
      preflight: async () => { calls++; entered.resolve(); await waiting.promise; return start(); },
    },
  });
  const first = runDispatcherCycle(opts);
  await entered.promise;
  const second = runDispatcherCycle(opts);
  await tick();
  assert.equal(calls, 1);
  waiting.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.repositories[0].profiles[0].status, "started");
  // The second cycle hits the five-minute cooldown rather than repeating the check.
  assert.equal(b.repositories[0].profiles[0].status, "throttled");
  assert.equal(calls, 1);
  session.resolve();
  await dispatcher.drain();
});

test("decisions, thrown failures and rejected launch stay isolated and redact results", async () => {
  const dispatcher = new SessionDispatcher();
  const launched = [];
  const names = ["skip", "error", "none", "throws", "resolver", "reject", "start"];
  const opts = options({ dispatcher,
    repositoriesJson: JSON.stringify(["https://example.test/sync.git", "https://example.test/discovery.git", urls[0], urls[1]]),
    env: (p) => { if (p.name === "resolver") throw new Error("secret-resolver"); return { BOT_INSTANCE_ID: p.name, BOT_MEMORY_URL: "https://memory.example/mcp" }; },
    launch: async (p) => { launched.push(p.name); if (p.name === "reject") throw new Error("secret-launch"); return "gone"; },
    dependencies: {
      syncRepositories: async (_root, [repo]) => {
        if (repo.name === "sync") throw new Error("secret-sync");
        return [{ name: repo.name, path: repo.name, revision: "secret-revision" }];
      },
      discoverProfiles: async (root) => {
        if (root === "discovery") throw new Error("secret-discovery");
        return (root === "one" ? names : ["other"]).map((name) => profile(name, root));
      },
      preflight: async ({ wiring }) => {
        assert.equal(wiring.instanceId.length > 0, true);
        if (wiring.instanceId === "throws") throw new Error("secret-preflight");
        if (wiring.instanceId === "skip" || wiring.instanceId === "error") return { action: wiring.instanceId, transcript: "secret-transcript", scripts: [] };
        if (wiring.instanceId === "none") return { action: "no-scripts", scripts: [] };
        return start();
      },
    },
  });
  const result = await runDispatcherCycle(opts);
  await tick();
  assert.deepEqual(result.repositories.map((r) => r.status), ["sync-error", "discovery-error", "processed", "processed"]);
  assert.deepEqual(result.repositories[2].profiles.map((p) => p.status), ["skip", "error", "no-scripts", "error", "error", "started", "started"]);
  assert.equal(result.repositories[3].profiles[0].status, "started");
  assert.deepEqual(launched, ["reject", "start", "other"]);
  assert.equal(dispatcher.status(result.repositories[2].profiles[5].agentId), "retained");
  assert.doesNotMatch(JSON.stringify(result), /secret|example|sync\.git|transcript|prompt|BOT_LABEL/);
});

test("invalid repository configuration fails safely before sync", async () => {
  let syncs = 0;
  for (const repositoriesJson of ["secret-not-json", JSON.stringify(["https://user:secret@example.test/repo"]), JSON.stringify([urls[0], urls[0]])]) {
    const result = await runDispatcherCycle(options({ repositoriesJson, dependencies: { syncRepositories: async () => { syncs++; return []; } } }));
    assert.deepEqual(result, { status: "invalid-config", repositories: [] });
  }
  assert.equal(syncs, 0);
});

/** Minimal config-repo checkout: one instance declaring `preflights:`. */
async function checkoutFixture(t, instanceYaml) {
  const root = await mkdtemp(join(tmpdir(), "dispatcher-cycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bot = join(root, "dev-bot");
  const agent = join(root, "instance", "onboard", "agent");
  await Promise.all([
    mkdir(agent, { recursive: true }),
    mkdir(join(bot, "presets", "workflows", "onboarding"), { recursive: true }),
    mkdir(join(bot, "presets", "workflows", "jira-sprint"), { recursive: true }),
  ]);
  await writeFile(join(agent, "instance.yaml"), instanceYaml);
  return { root, agent };
}

async function memoryServer(t, authorize = true) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (authorize && req.headers.authorization !== "Bearer fixture-token") {      res.writeHead(401, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [] }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return { requests, port: server.address().port };
}

test("real discovery and TS engine dispatch a declared preflight with hermetic services", async (t) => {
  const { root } = await checkoutFixture(t, "workflow: onboarding\nimage: { repository: registry.example/team/name }\npreflights:\n  - jira-triage\n");
  const { requests, port } = await memoryServer(t);
  const calls = [];
  let now = 0;
  const opts = options({ repositoriesJson: JSON.stringify([urls[0]]), now: () => now,
    env: { BOT_MEMORY_URL: `http://127.0.0.1:${port}`, BOT_INSTANCE_ID: "fixture-instance", BOT_LABEL: "fixture-label" },
    memoryCredential: async () => "fixture-token",
    serviceGatewayUrl: new URL("https://services.example/"),
    launch: async (p, _agentId, prompt) => { calls.push([p.name, prompt]); return "gone"; },
    dependencies: { syncRepositories: async () => [{ name: "one", path: root, revision: "abc" }] },
  });
  const result = await runDispatcherCycle(opts);
  await opts.dispatcher.drain();
  assert.equal(result.repositories[0].profiles[0].status, "started");
  assert.deepEqual(calls.map(([name]) => [name]), [["onboard"]]);
  assert.match(calls[0][1], /No active tasks/);
  // jira-triage fetches tasks and capacity once each, authenticated and
  // instance-filtered; the jira client is wired but never called (no tasks).
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.url.startsWith("/api/tasks?") && request.url.includes("instance_id=fixture-instance")));
  assert.doesNotMatch(JSON.stringify(result), /fixture|onboard|No active tasks/);
});

test("workflow defaults inherit; a profile with neither defaults nor declarations errors loudly", async (t) => {
  const { root, agent } = await checkoutFixture(t, "workflow: jira-sprint\nimage: { repository: registry.example/team/name }\n");
  const config = join(agent, "instance.yaml");
  const { port } = await memoryServer(t);
  let now = 0;
  const cycle = () => {
    const dispatcher = new SessionDispatcher();
    const opts = options({ repositoriesJson: JSON.stringify([urls[0]]), now: () => now, dispatcher,
      env: { BOT_MEMORY_URL: `http://127.0.0.1:${port}`, BOT_INSTANCE_ID: "fixture-instance" },
      memoryCredential: async () => "fixture-token",
      serviceGatewayUrl: new URL("https://services.example/"),
      launch: async () => "gone",
      dependencies: { syncRepositories: async () => [{ name: "one", path: root, revision: "abc" }] },
    });
    return { opts, dispatcher, status: async () => (await runDispatcherCycle(opts)).repositories[0].profiles[0].status };
  };
  // jira-sprint inherits the central default set (gh-pr-status, gl-mr-status);
  // with no active tasks both skip, so nothing is dispatched.
  const inherited = cycle();
  assert.equal(await inherited.status(), "skip");
  await inherited.dispatcher.drain();
  // A workflow without a default set and without declared preflights is a
  // loud error — never a silent skip (the migration contract, REHOR-232).
  now = 300_000;
  await writeFile(config, "workflow: onboarding\nimage: { repository: registry.example/team/name }\n");
  const missing = cycle();
  assert.equal(await missing.status(), "error");
  // An explicit empty declaration is a deliberate no-preflights profile.
  now = 600_000;
  await writeFile(config, "workflow: onboarding\nimage: { repository: registry.example/team/name }\npreflights: []\n");
  const empty = cycle();
  assert.equal(await empty.status(), "no-scripts");
});

test("memory authorization failures are errors and the minted credential is required", async (t) => {
  const { root } = await checkoutFixture(t, "workflow: onboarding\nimage: { repository: registry.example/team/name }\npreflights:\n  - jira-triage\n");
  const { requests, port } = await memoryServer(t);
  let now = 0;
  const opts = (extra = {}) => options({ repositoriesJson: JSON.stringify([urls[0]]), now: () => now,
    env: { BOT_MEMORY_URL: `http://127.0.0.1:${port}`, BOT_INSTANCE_ID: "fixture-instance", BOT_LABEL: "fixture-label" },
    serviceGatewayUrl: new URL("https://services.example/"),
    launch: async () => "gone",
    dependencies: { syncRepositories: async () => [{ name: "one", path: root, revision: "abc" }] },
    ...extra,
  });
  // Without a credential provider the engine refuses to run unauthenticated.
  const unauthenticated = await runDispatcherCycle(opts({ memoryCredential: undefined }));
  assert.equal(unauthenticated.repositories[0].profiles[0].status, "error");
  assert.equal(requests.length, 0);
  // A minting failure also fails the profile instead of running unauthenticated.
  now = 300_000;
  const unminted = await runDispatcherCycle(opts({ memoryCredential: async () => { throw new Error("mint-secret"); }, dispatcher: new SessionDispatcher() }));
  assert.equal(unminted.repositories[0].profiles[0].status, "error");
  // With the credential, memory fetches authenticate; the preflight starts.
  now = 600_000;
  const authenticatedOpts = opts({ memoryCredential: async () => "fixture-token", dispatcher: new SessionDispatcher() });
  const authenticated = await runDispatcherCycle(authenticatedOpts);
  await authenticatedOpts.dispatcher.drain();
  assert.equal(authenticated.repositories[0].profiles[0].status, "started");
  assert.ok(requests.length > 0);
  assert.ok(requests.every((request) => request.authorization === "Bearer fixture-token"));
  assert.doesNotMatch(JSON.stringify([unauthenticated, unminted, authenticated]), /fixture-token|mint-secret|127\.0\.0\.1/);
});

test("abort signal is forwarded to the preflight engine", async () => {
  const controller = new AbortController();
  const seen = [];
  const opts = options({ repositoriesJson: JSON.stringify([urls[0]]), signal: controller.signal,
    dependencies: {
      syncRepositories: async () => [{ name: "one", path: "one", revision: "abc" }],
      discoverProfiles: async () => [profile("same", "one")],
      preflight: async (invocation) => { seen.push(invocation.signal); return { action: "skip", transcript: "", scripts: [] }; },
    },
  });
  await runDispatcherCycle(opts);
  assert.deepEqual(seen, [controller.signal]);
});

test("a validation failure on a named profile logs and reports the instance identity", async (t) => {
  const { root } = await checkoutFixture(t, "workflow: onboarding\nimage: { repository: registry.example/team/name }\npreflights:\n  - nope-unknown-id\n");
  const logs = [];
  let now = 0;
  const opts = options({ repositoriesJson: JSON.stringify([urls[0]]), now: () => now,
    logger: { log: (event, status, details) => logs.push({ event, status, ...details }), start: () => ({ success: () => {}, failure: () => {} }) },
    env: { BOT_INSTANCE_ID: "fixture-instance", BOT_MEMORY_URL: "https://memory.example/mcp" },
    memoryCredential: async () => "fixture-token",
    dependencies: { syncRepositories: async () => [{ name: "one", path: root, revision: "abc" }] },
  });
  const result = await runDispatcherCycle(opts);
  const [record] = result.repositories[0].profiles;
  assert.equal(record.status, "error");
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], {
    event: "preflight.error",
    status: "failure",
    reason: "configuration",
    profile: "onboard",
    repository: urls[0],
    agentId: record.agentId,
  });
  assert.match(record.agentId, /^[a-f0-9]{64}$/);
  // Transcripts never enter the log record.
  assert.ok(!("transcript" in logs[0]));
});

test("preflight error reasons reach lifecycle logs, including missing reasons and exceptions", async () => {
  const lines = [];
  const names = ["configuration", "execution", "missing", "throws", "resolver"];
  const opts = options({
    repositoriesJson: JSON.stringify([urls[0]]),
    logger: createLifecycleLogger({ write: (line) => lines.push(line) }),
    env: (p) => { if (p.name === "resolver") throw new Error("secret-resolver"); return { BOT_INSTANCE_ID: p.name, BOT_MEMORY_URL: "https://memory.example/mcp" }; },
    dependencies: {
      syncRepositories: async () => [{ name: "one", path: "one", revision: "abc" }],
      discoverProfiles: async () => names.map((name) => profile(name, "one")),
      preflight: async ({ profile: selected }) => {
        if (selected.name === "throws") throw new Error("secret-exception");
        return { action: "error", transcript: "secret-transcript", scripts: [], ...(selected.name === "missing" ? {} : { reason: selected.name }) };
      },
    },
  });
  const result = await runDispatcherCycle(opts);
  const profiles = result.repositories[0].profiles;
  assert.deepEqual(profiles.map((item) => item.status), names.map(() => "error"));
  assert.deepEqual(lines.map(JSON.parse), names.map((name, index) => ({
    level: 50, event: "preflight.error", status: "failure",
    reason: name === "configuration" ? "configuration" : "execution",
    profile: name, repository: urls[0], agentId: profiles[index].agentId,
  })));
  assert.ok(lines.every((line) => !line.includes("secret")));
});
