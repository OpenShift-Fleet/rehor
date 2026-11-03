import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDispatcherCycle } from "../dist/dispatcher-cycle.js";
import { SessionDispatcher } from "../dist/dispatch-sessions.js";

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
  repositoriesJson: JSON.stringify(urls), cacheRoot: "/cache", env: { BOT_INSTANCE_ID: "secret-instance" },
  dispatcher: new SessionDispatcher(), launch: async () => "gone", ...extra,
});

test("each agent waits five minutes between checks, including skip and error", async () => {
  let now = 0;
  const calls = [];
  const opts = options({
    now: () => now,
    dependencies: {
      syncRepositories: async (_root, [repo]) => [{ name: repo.name, path: repo.name, revision: "abc" }],
      discoverProfiles: async (root) => [profile("same", root)],
      prepareRuntime: async (p) => ({ botRoot: p.botRoot, dispose: async () => {} }),
      preflight: async ({ botRoot }) => {
        calls.push(botRoot);
        return { action: botRoot === "one" ? "skip" : "error", transcript: "", scripts: [] };
      },
    },
  });
  const statuses = async () => (await runDispatcherCycle(opts)).repositories.map((r) => r.profiles[0].status);
  assert.deepEqual(await statuses(), ["skip", "error"]);
  now = 299_999;
  assert.deepEqual(await statuses(), ["throttled", "throttled"]);
  now = 300_000;
  assert.deepEqual(await statuses(), ["skip", "error"]);
  assert.deepEqual(calls, ["one", "two", "one", "two"]);
});

test("per-agent preflight environment overrides shared defaults", async () => {
  const seen = [];
  const opts = options({
    env: { BOT_INSTANCE_ID: "shared", BOT_LABEL: "shared" },
    dependencies: {
      syncRepositories: async (_root, [repo]) => [{ name: repo.name, path: repo.name, revision: "abc" }],
      discoverProfiles: async (root) => [{ ...profile("same", root), preflightEnv: { BOT_INSTANCE_ID: root, BOT_LABEL: `${root}-label` } }],
      prepareRuntime: async (p) => ({ botRoot: p.botRoot, dispose: async () => {} }),
      preflight: async ({ env }) => { seen.push(env); return { action: "skip", transcript: "", scripts: [] }; },
    },
  });
  await runDispatcherCycle(opts);
  assert.deepEqual(seen, [{ BOT_INSTANCE_ID: "one", BOT_LABEL: "one-label" }, { BOT_INSTANCE_ID: "two", BOT_LABEL: "two-label" }]);
});

test("sequential preflights, parallel sessions, busy check and stable unique identities", async () => {
  const events = [];
  const waiting = deferred();
  const dispatcher = new SessionDispatcher();
  const opts = options({ dispatcher, launch: async (p, prompt) => {
    events.push(`launch:${p.botRoot}:${prompt}`);
    await waiting.promise;
    return "gone";
  }, dependencies: {
    prepareRuntime: async (p) => ({ botRoot: p.botRoot, dispose: async () => {} }),
    syncRepositories: async (_root, [repo]) => [{ name: repo.name, path: repo.name, revision: "abc" }],
    discoverProfiles: async (root) => [profile("same", root)],
    preflight: async ({ botRoot, workflow, instanceDir, env }) => {
      events.push(`preflight:${botRoot}`);
      assert.equal(workflow, "same");
      assert.equal(instanceDir, `${botRoot}/same`);
      assert.deepEqual(env, { BOT_INSTANCE_ID: "secret-instance" });
      return start(botRoot);
    },
  } });
  const first = await runDispatcherCycle(opts);
  await tick();
  assert.deepEqual(events, ["preflight:one", "launch:one:one", "preflight:two", "launch:two:two"]);
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
      prepareRuntime: async (p) => ({ botRoot: p.botRoot, dispose: async () => {} }),
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
    env: (p) => { if (p.name === "resolver") throw new Error("secret-resolver"); return { BOT_LABEL: p.name }; },
    launch: async (p) => { launched.push(p.name); if (p.name === "reject") throw new Error("secret-launch"); return "gone"; },
    dependencies: {
      prepareRuntime: async (p) => ({ botRoot: p.botRoot, dispose: async () => {} }),
      syncRepositories: async (_root, [repo]) => {
        if (repo.name === "sync") throw new Error("secret-sync");
        return [{ name: repo.name, path: repo.name, revision: "secret-revision" }];
      },
      discoverProfiles: async (root) => {
        if (root === "discovery") throw new Error("secret-discovery");
        return (root === "one" ? names : ["other"]).map((name) => profile(name, root));
      },
      preflight: async ({ workflow, env }) => {
        assert.equal(env.BOT_LABEL, workflow);
        if (workflow === "throws") throw new Error("secret-preflight");
        if (workflow === "skip" || workflow === "error") return { action: workflow, transcript: "secret-transcript", scripts: [] };
        if (workflow === "none") return { action: "no-scripts", scripts: [] };
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

test("real discovery and Python runner receive supplied onboarding context; no scripts never launch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dispatcher-cycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bot = join(root, "dev-bot");
  const workflow = join(bot, "presets", "workflows", "onboarding", "preflight");
  const agent = join(root, "instance", "onboard", "agent");
  await Promise.all([agent, workflow, join(bot, "presets", "shared", "preflight"), join(bot, ".claude", "skills"), join(bot, "data")].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(join(agent, "instance.yaml"), "workflow: onboarding\nimage: { repository: registry.example/team/name }\n");
  await writeFile(join(workflow, "work.py"), `import json, os\nassert os.environ['BOT_INSTANCE_ID'] == 'supplied-id'\nassert os.environ['BOT_LABEL'] == 'supplied-label'\nprint(json.dumps({'status': 'start', 'content': 'secret-prompt'}))\n`);
  const calls = [];
  let now = 0;
  const opts = options({ repositoriesJson: JSON.stringify([urls[0]]), now: () => now,
    env: { PATH: process.env.PATH, BOT_INSTANCE_ID: "supplied-id", BOT_LABEL: "supplied-label" },
    launch: async (p, prompt) => { calls.push([p.name, prompt]); return "gone"; },
    dependencies: { syncRepositories: async () => [{ name: "one", path: root, revision: "abc" }] },
  });
  const first = await runDispatcherCycle(opts);
  await opts.dispatcher.drain();
  assert.equal(first.repositories[0].profiles[0].status, "started");
  assert.deepEqual(calls, [["onboard", "secret-prompt"]]);
  assert.doesNotMatch(JSON.stringify(first), /secret|supplied|onboard/);
  await rm(join(workflow, "work.py"));
  now = 300_000;
  const second = await runDispatcherCycle(opts);
  assert.equal(second.repositories[0].profiles[0].status, "no-scripts");
  assert.equal(calls.length, 1);
});

test("checked-in onboarding preflight flows through cycle with hermetic services", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dispatcher-onboarding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bot = join(root, "dev-bot");
  const agent = join(root, "instance", "onboard", "agent");
  const workflow = join(bot, "presets", "workflows", "onboarding", "preflight");
  const shared = join(bot, "presets", "shared", "preflight");
  const skills = join(bot, ".claude", "skills");
  await Promise.all([agent, workflow, shared, skills, join(bot, "data")].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(join(agent, "instance.yaml"), "workflow: onboarding\nimage: { repository: registry.example/team/name }\n");
  const source = fileURLToPath(new URL("../../../", import.meta.url));
  await Promise.all([
    copyFile(join(source, "presets/workflows/onboarding/preflight/03-onboarding-jira.py"), join(workflow, "03-onboarding-jira.py")),
    ...["common.py", "onboarding_preflight.py"].map((name) => copyFile(join(source, "presets/shared/preflight", name), join(shared, name))),
  ]);
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [] }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = server.address().port;
  await writeFile(join(shared, "sitecustomize.py"), `import socket\n_original = socket.socket.connect\ndef _local_only(sock, address):\n    if not isinstance(address, tuple) or address[0] != '127.0.0.1' or address[1] != ${port}:\n        raise RuntimeError('external network disabled')\n    return _original(sock, address)\nsocket.socket.connect = _local_only\nsocket.socket.connect_ex = lambda *args: (_ for _ in ()).throw(RuntimeError('external network disabled'))\n`);
  await writeFile(join(skills, "jira_mcp.py"), `import os\ndef jira_call(name, args):\n    assert name == 'jira_search'\n    assert 'labels = "fixture-label"' in args['jql']\n    return {'issues': [{'key': 'REHOR-123', 'fields': {'summary': 'Synthetic candidate', 'status': {'name': 'New'}, 'labels': ['fixture-label']}}]} if os.environ['FIXTURE_WORK'] == 'yes' else {'issues': []}\ndef jira_cleanup():\n    pass\n`);
  const calls = [];
  let now = 0;
  const opts = options({ repositoriesJson: JSON.stringify([urls[0]]), now: () => now,
    env: { PATH: process.env.PATH, BOT_MEMORY_URL: `http://127.0.0.1:${port}`, BOT_INSTANCE_ID: "fixture-instance", BOT_LABEL: "fixture-label", BOT_JIRA_PROJECT: "REHOR", FIXTURE_WORK: "yes" },
    launch: async (p, prompt) => { calls.push([p.name, prompt]); return "gone"; },
    dependencies: { syncRepositories: async () => [{ name: "one", path: root, revision: "abc" }] },
  });
  const started = await runDispatcherCycle(opts);
  await opts.dispatcher.drain();
  assert.equal(started.repositories[0].profiles[0].status, "started");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "onboard");
  assert.match(calls[0][1], /REHOR-123.*Synthetic candidate/);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => url.includes("instance_id=fixture-instance")));
  opts.env.FIXTURE_WORK = "no";
  now = 300_000;
  const skipped = await runDispatcherCycle(opts);
  assert.equal(skipped.repositories[0].profiles[0].status, "skip");
  assert.equal(calls.length, 1);
  assert.equal(requests.length, 4);
  assert.doesNotMatch(JSON.stringify([started, skipped]), /fixture|Synthetic|REHOR-123|onboard/);
});

test("memory authorization failures are errors and the minted credential is forwarded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dispatcher-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bot = join(root, "dev-bot");
  const agent = join(root, "instance", "onboard", "agent");
  const workflow = join(bot, "presets", "workflows", "onboarding", "preflight");
  const shared = join(bot, "presets", "shared", "preflight");
  const skills = join(bot, ".claude", "skills");
  await Promise.all([agent, workflow, shared, skills, join(bot, "data")].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(join(agent, "instance.yaml"), "workflow: onboarding\nimage: { repository: registry.example/team/name }\n");
  const source = fileURLToPath(new URL("../../../", import.meta.url));
  await Promise.all([
    copyFile(join(source, "presets/workflows/onboarding/preflight/03-onboarding-jira.py"), join(workflow, "03-onboarding-jira.py")),
    ...["common.py", "onboarding_preflight.py"].map((name) => copyFile(join(source, "presets/shared/preflight", name), join(shared, name))),
  ]);
  // Only requests carrying the minted credential succeed; anything else is 401.
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization !== "Bearer fixture-token") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [] }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = server.address().port;
  await writeFile(join(skills, "jira_mcp.py"), `def jira_call(name, args):\n    return {'issues': []}\ndef jira_cleanup():\n    pass\n`);
  let now = 0;
  const opts = (extra = {}) => options({ repositoriesJson: JSON.stringify([urls[0]]), now: () => now,
    env: { PATH: process.env.PATH, BOT_MEMORY_URL: `http://127.0.0.1:${port}`, BOT_INSTANCE_ID: "fixture-instance", BOT_LABEL: "fixture-label", BOT_JIRA_PROJECT: "REHOR" },
    memoryCredential: async () => "fixture-token",
    dependencies: { syncRepositories: async () => [{ name: "one", path: root, revision: "abc" }] },
    ...extra,
  });
  // Authenticated access: the credential is forwarded on every memory request.
  const authenticated = await runDispatcherCycle(opts());
  assert.equal(authenticated.repositories[0].profiles[0].status, "skip");
  assert.ok(seen.length > 0);
  assert.ok(seen.every((authorization) => authorization === "Bearer fixture-token"));
  // Without a credential the endpoint rejects the request; the preflight must
  // fail as an error, never a successful empty result.
  now = 300_000;
  const rejected = await runDispatcherCycle(opts({ memoryCredential: undefined, dispatcher: new SessionDispatcher() }));
  assert.equal(rejected.repositories[0].profiles[0].status, "error");
  // A minting failure also fails the profile instead of running unauthenticated.
  now = 600_000;
  const unminted = await runDispatcherCycle(opts({ memoryCredential: async () => { throw new Error("mint-secret"); }, dispatcher: new SessionDispatcher() }));
  assert.equal(unminted.repositories[0].profiles[0].status, "error");
  assert.doesNotMatch(JSON.stringify([authenticated, rejected, unminted]), /fixture-token|mint-secret|127\.0\.0\.1/);
});
