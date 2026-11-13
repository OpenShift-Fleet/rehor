import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createPreflightRegistry, definePreflight } from "@rehor/preflights";
import { loadInstanceRepos, runTsPreflight } from "../dist/preflight-engine-ts.js";

// The engine consumes only the preflights/workflow fields of a profile.
const profile = (extra = {}) => ({ name: "agent", workflow: "custom", ...extra });
const wiring = (extra = {}) => ({ instanceId: "fixture-instance", memory: { baseUrl: "https://memory.example/mcp", token: "fixture-token" }, ...extra });

/** Build a registry of fake preflights; `spec` maps id → outcome (or a
 * function of the run context). Records every call for ordering asserts. */
function fakeRegistry(spec) {
  const calls = [];
  const preflights = Object.entries(spec).map(([id, outcome]) =>
    definePreflight({
      id,
      input: id === "needs-params" ? z.strictObject({ label: z.string().min(1) }) : z.strictObject({}),
      run: async (ctx, params) => {
        calls.push({ id, ctx, params });
        return typeof outcome === "function" ? outcome(ctx) : outcome;
      },
    }),
  );
  return { registry: createPreflightRegistry(preflights), calls };
}

test("invalid configuration fails closed with stable messages before any execution", async () => {
  const { registry, calls } = fakeRegistry({ "needs-params": { status: "skip", content: "" } });
  const result = await runTsPreflight({
    profile: profile({ preflights: ["nope", { id: "needs-params" }, 42] }),
    wiring: wiring(),
    registry,
  });
  assert.equal(result.action, "error");
  assert.equal(result.reason, "configuration");
  assert.equal(result.transcript, [
    "agent: nope: unknown preflight id",
    'needs-params: missing required parameter "label"',
    "entry 3: malformed preflight entry",
  ].join("\n"));
  assert.deepEqual(result.scripts, []);
  assert.deepEqual(calls, []);
});

test("error transcripts name the instance: profile and config repository", async () => {
  const { registry } = fakeRegistry({ "needs-params": { status: "skip", content: "" } });
  const repositoryUrl = "https://github.com/fleetshift/fleetshift-config.git";
  const result = await runTsPreflight({
    profile: profile({ name: "fleetshift-config", preflights: [{ id: "needs-params" }] }),
    wiring: wiring(),
    registry,
    repositoryUrl,
  });
  assert.equal(result.action, "error");
  assert.equal(
    result.transcript,
    'fleetshift-config (https://github.com/fleetshift/fleetshift-config.git): needs-params: missing required parameter "label"',
  );
  const bare = await runTsPreflight({
    profile: profile({ name: "fleetshift-config", preflights: [{ id: "needs-params" }] }),
    wiring: wiring(),
    registry,
  });
  assert.equal(
    bare.transcript,
    'fleetshift-config: needs-params: missing required parameter "label"',
  );
});

test("missing declaration and default set is a loud error; an explicit empty list is no-scripts", async () => {
  const { registry } = fakeRegistry({});
  const missing = await runTsPreflight({ profile: profile({ preflights: undefined }), wiring: wiring(), registry });
  assert.equal(missing.action, "error");
  assert.equal(missing.reason, "configuration");
  assert.equal(
    missing.transcript,
    'agent: No preflights configured: the profile declares no preflights and workflow "custom" has no registered default set',
  );
  assert.deepEqual(missing.scripts, []);
  const declared = await runTsPreflight({ profile: profile({ preflights: [] }), wiring: wiring(), registry });
  assert.deepEqual(declared, { action: "no-scripts", scripts: [] });
});

test("workflow defaults apply when the profile declares no preflights", async () => {
  const { registry, calls } = fakeRegistry({
    "gh-pr-status": { status: "skip", content: "no PRs" },
    "gl-mr-status": { status: "skip", content: "no MRs" },
  });
  const result = await runTsPreflight({ profile: profile({ workflow: "jira-sprint" }), wiring: wiring(), registry });
  assert.equal(result.action, "skip");
  assert.deepEqual(calls.map((call) => call.id), ["gh-pr-status", "gl-mr-status"]);
});

test("aggregation mirrors the Python contract: skip-only, start, all-error, and ordering", async () => {
  const skipOnly = fakeRegistry({ one: { status: "skip", content: "skip-one" }, two: { status: "skip", content: "skip-two" } });
  const skipped = await runTsPreflight({ profile: profile({ preflights: ["one", "two"] }), wiring: wiring(), registry: skipOnly.registry });
  assert.equal(skipped.action, "skip");
  assert.equal(skipped.transcript, "skip-one\n\nskip-two");
  assert.deepEqual(skipped.scripts.map((script) => [script.name, script.status]), [["one", "skip"], ["two", "skip"]]);

  const mixed = fakeRegistry({
    first: { status: "skip", content: "skip-content" },
    second: { status: "start", content: "start-content" },
    third: { status: "error", content: "error-content" },
  });
  const started = await runTsPreflight({ profile: profile({ preflights: ["first", "second", "third"] }), wiring: wiring(), registry: mixed.registry });
  assert.equal(started.action, "start");
  // The prompt is assembled from start results only (the settled spike
  // decision): skip and error content never enters the agent prompt.
  assert.equal(started.prompt, "start-content");
  assert.ok(!started.prompt.includes("skip-content"));
  assert.ok(!started.prompt.includes("error-content"));
  assert.deepEqual(started.scripts.map((script) => [script.name, script.status]), [["first", "skip"], ["second", "start"], ["third", "error"]]);
  // Errored entries never block work another preflight found, but an
  // actionable start still carries the error in the cycle-report scripts.
  assert.ok(started.scripts.some((script) => script.name === "third" && script.status === "error" && script.content === "error-content"));
  // Declared order is preserved.
  assert.deepEqual(mixed.calls.map((call) => call.id), ["first", "second", "third"]);

  const failing = fakeRegistry({ one: { status: "error", content: "boom-one" }, two: { status: "error", content: "boom-two" } });
  const errored = await runTsPreflight({ profile: profile({ preflights: ["one", "two"] }), wiring: wiring(), registry: failing.registry });
  assert.equal(errored.action, "error");
  assert.equal(errored.reason, "execution");
  assert.equal(errored.transcript, "agent: boom-one\n\nboom-two");
});

test("a thrown preflight is an execution error of that entry only, without exception detail", async () => {
  const { registry } = fakeRegistry({
    thrower: () => { throw new Error("secret upstream detail"); },
    starter: { status: "start", content: "work" },
  });
  const result = await runTsPreflight({ profile: profile({ preflights: ["thrower", "starter"] }), wiring: wiring(), registry });
  assert.equal(result.action, "start");
  assert.equal(result.prompt, "work");
  const thrown = result.scripts.find((script) => script.name === "thrower");
  assert.deepEqual([thrown.status, thrown.content], ["error", "thrower failed to execute"]);
  assert.ok(!JSON.stringify(result).includes("secret upstream detail"));
});

test("skip transcripts carry the [PREFLIGHT ERROR] summary like the Python runner", async () => {
  const { registry } = fakeRegistry({
    skipper: { status: "skip", content: "nothing to do" },
    failer: { status: "error", content: "x".repeat(300) },
  });
  const result = await runTsPreflight({ profile: profile({ preflights: ["skipper", "failer"] }), wiring: wiring(), registry });
  assert.equal(result.action, "skip");
  assert.match(result.transcript, /^\[PREFLIGHT ERROR\] failer: x{200}\n\nnothing to do$/);
});

test("missing dispatcher wiring fails closed even without preflight entries", async () => {
  const { registry, calls } = fakeRegistry({ one: { status: "skip", content: "" } });
  for (const [w, message] of [
    [wiring({ instanceId: "" }), "agent: Preflight engine requires an instance identity (BOT_INSTANCE_ID)"],
    [wiring({ instanceId: " \t" }), "agent: Preflight engine requires an instance identity (BOT_INSTANCE_ID)"],
    [wiring({ instanceId: undefined }), "agent: Preflight engine requires an instance identity (BOT_INSTANCE_ID)"],
    [wiring({ memory: { baseUrl: "", token: "t" } }), "agent: Preflight engine requires BOT_MEMORY_URL"],
    [wiring({ memory: { baseUrl: "  ", token: "t" } }), "agent: Preflight engine requires BOT_MEMORY_URL"],
    [wiring({ memory: { baseUrl: undefined, token: "t" } }), "agent: Preflight engine requires BOT_MEMORY_URL"],
    [wiring({ memory: { baseUrl: "https://memory.example", token: "" } }), "agent: Preflight engine requires a minted memory credential"],
    [wiring({ memory: { baseUrl: "https://memory.example", token: " \n" } }), "agent: Preflight engine requires a minted memory credential"],
    [wiring({ memory: { baseUrl: "https://memory.example", token: undefined } }), "agent: Preflight engine requires a minted memory credential"],
  ]) {
    for (const preflights of [["one"], [], undefined]) {
      const result = await runTsPreflight({ profile: profile({ preflights }), wiring: w, registry });
      assert.equal(result.action, "error");
      assert.equal(result.reason, "configuration");
      assert.equal(result.transcript, message);
      assert.deepEqual(result.scripts, []);
    }
  }
  assert.deepEqual(calls, []);
});

test("signal abort between entries cancels the run without executing later entries", async () => {
  const controller = new AbortController();
  const { registry, calls } = fakeRegistry({
    first: (ctx) => { controller.abort(); return { status: "start", content: "late-start" }; },
    second: { status: "start", content: "never" },
  });
  const result = await runTsPreflight({
    profile: profile({ preflights: ["first", "second"] }),
    wiring: wiring(),
    registry,
    signal: controller.signal,
  });
  assert.deepEqual(result, { action: "error", transcript: "agent: Preflight cancelled", scripts: [{ name: "first", status: "start", content: "late-start" }], reason: "execution" });
  assert.deepEqual(calls.map((call) => call.id), ["first"]);
});

async function memoryFixture(t, handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (handler) handler(req, res);
    else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [] }));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test("memory wiring reaches the client: bearer token, instance filter, one shared fetch per run", async (t) => {
  const { requests, baseUrl } = await memoryFixture(t);
  const { registry, calls } = fakeRegistry({
    one: async (ctx) => ({ status: "skip", content: `tasks:${(await ctx.memory.getTasks()).length}` }),
    two: async (ctx) => ({ status: "skip", content: `capacity:${(await ctx.memory.getCapacity()).max}` }),
  });
  const result = await runTsPreflight({
    profile: profile({ preflights: ["one", "two"] }),
    wiring: wiring({ memory: { baseUrl, token: "fixture-token" } }),
    registry,
  });
  assert.equal(result.action, "skip");
  assert.deepEqual(result.scripts.map((script) => script.content), ["tasks:0", "capacity:10"]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.url.startsWith("/api/tasks?") && request.url.includes("instance_id=fixture-instance") && request.authorization === "Bearer fixture-token"));
  // One run context shared by all entries: both preflights see the same instance id.
  assert.ok(calls.every((call) => call.ctx.instanceId === "fixture-instance"));
});

test("proxy wiring: jira client and proxy route only when proxyBaseUrl is present", async (t) => {
  const jiraCalls = [];
  const server = createServer((req, res) => {
    jiraCalls.push(`${req.method} ${req.url}`);
    if (req.url === "/jira/rest/api/2/search/jql") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ issues: [{ key: "REHOR-1", fields: { summary: "s" } }], isLast: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));
  const { requests, baseUrl } = await memoryFixture(t);
  const proxyBaseUrl = `http://127.0.0.1:${server.address().port}`;

  const { registry, calls } = fakeRegistry({
    wired: async (ctx) => ({ status: "skip", content: `issues:${(await ctx.jira.searchIssues("labels = x")).length}` }),
  });
  const result = await runTsPreflight({
    profile: profile({ preflights: ["wired"] }),
    wiring: wiring({ memory: { baseUrl, token: "fixture-token" }, proxyBaseUrl }),
    registry,
  });
  assert.equal(result.action, "skip");
  assert.equal(result.scripts[0].content, "issues:1");
  assert.deepEqual(jiraCalls, ["POST /jira/rest/api/2/search/jql"]);
  assert.equal(calls[0].ctx.proxy, proxyBaseUrl);

  // Without proxyBaseUrl the context carries no proxy route and no jira
  // client; a jira preflight errors rather than silently skipping.
  const { registry: bare } = fakeRegistry({ bare: (ctx) => ({ status: "skip", content: `proxy:${ctx.proxy === undefined},jira:${ctx.jira === undefined}` }) });
  const bareResult = await runTsPreflight({
    profile: profile({ preflights: ["bare"] }),
    wiring: wiring({ memory: { baseUrl, token: "fixture-token" } }),
    registry: bare,
  });
  assert.equal(bareResult.scripts[0].content, "proxy:true,jira:true");
});

test("repos wiring passes the instance map into the run context", async () => {
  const repos = { "my-repo": { upstream: "https://github.com/org/my-repo.git", host: "github" } };
  const { registry, calls } = fakeRegistry({ one: (ctx) => ({ status: "skip", content: JSON.stringify(ctx.repos) }) });
  const result = await runTsPreflight({ profile: profile({ preflights: ["one"] }), wiring: wiring({ repos }), registry });
  assert.deepEqual(JSON.parse(result.scripts[0].content), repos);
  assert.deepEqual(calls[0].ctx.repos, repos);
});

test("per-run shared state accumulates across entries", async () => {
  const { registry } = fakeRegistry({
    first: (ctx) => { ctx.state.set("bookkeeping", 41); return { status: "skip", content: "" }; },
    second: (ctx) => ({ status: "skip", content: `state:${ctx.state.get("bookkeeping")}` }),
  });
  const result = await runTsPreflight({ profile: profile({ preflights: ["first", "second"] }), wiring: wiring(), registry });
  assert.equal(result.scripts[1].content, "state:41");
});

test("parameterized entries pass parsed params to the preflight", async () => {
  const { registry, calls } = fakeRegistry({ "needs-params": { status: "skip", content: "" } });
  await runTsPreflight({
    profile: profile({ preflights: [{ id: "needs-params", with: { label: "team-label" } }] }),
    wiring: wiring(),
    registry,
  });
  assert.deepEqual(calls.map((call) => call.params), [{ label: "team-label" }]);
});

test("loadInstanceRepos loads the instance map and degrades like the package loader", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "instance-repos-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await loadInstanceRepos(root), undefined);
  await writeFile(join(root, "project-repos.json"), JSON.stringify({ "my-repo": { upstream: "https://github.com/org/my-repo.git" }, broken: 7 }));
  const repos = await loadInstanceRepos(root);
  assert.deepEqual(repos, { "my-repo": { upstream: "https://github.com/org/my-repo.git" }, broken: {} });
  await writeFile(join(root, "project-repos.json"), "not json");
  assert.deepEqual(await loadInstanceRepos(root), {});
  await writeFile(join(root, "project-repos.json"), "[1]");
  assert.deepEqual(await loadInstanceRepos(root), {});
});
