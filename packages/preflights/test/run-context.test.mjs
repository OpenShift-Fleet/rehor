import assert from "node:assert/strict";
import test from "node:test";
import { createJiraClient } from "../dist/shared/jira.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";
import { createPreflightRunContext, createRunState } from "../dist/shared/run-context.js";

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("run context requires a non-empty instance id", () => {
  assert.throws(
    () => createPreflightRunContext({ instanceId: "", memory: { baseUrl: "http://m" } }),
    /instanceId/,
  );
  assert.throws(
    () => createPreflightRunContext({ instanceId: "  ", memory: { baseUrl: "http://m" } }),
    /instanceId/,
  );
});

test("run context generates a unique run id per run and honors an explicit one", () => {
  const memory = createMemoryServerClient({ baseUrl: "http://memory:8080" });
  const a = createPreflightRunContext({ instanceId: "bot-1", memory });
  const b = createPreflightRunContext({ instanceId: "bot-1", memory });
  assert.notEqual(a.runId, b.runId);
  const explicit = createPreflightRunContext({ instanceId: "bot-1", runId: "run-7", memory });
  assert.equal(explicit.runId, "run-7");
});

test("run state stores, reads, and snapshots per-run values", () => {
  const state = createRunState();
  assert.equal(state.has("jira"), false);
  state.set("jira", { feedback: 1, interrupted: 0 });
  assert.equal(state.has("jira"), true);
  assert.deepEqual(state.get("jira"), { feedback: 1, interrupted: 0 });
  assert.deepEqual(state.snapshot(), { jira: { feedback: 1, interrupted: 0 } });
});

test("run state accepts initial values and replaces keys like save_state merges", () => {
  const state = createRunState({ has_actionable: false });
  assert.equal(state.get("has_actionable"), false);
  state.set("has_actionable", true);
  state.set("jira", { feedback: 0 });
  assert.deepEqual(state.snapshot(), { has_actionable: true, jira: { feedback: 0 } });
});

test("run context wires the memory client to the shared per-run cache", async () => {
  const calls = [];
  const ctx = createPreflightRunContext({
    instanceId: "devbot-pilot",
    memory: {
      baseUrl: "http://memory:8080",
      token: "synthetic",
      fetch: async (url) => {
        calls.push(url);
        return jsonResponse({ items: [{ external_key: "REHOR-1", status: "in_progress" }] });
      },
    },
  });
  assert.equal(ctx.instanceId, "devbot-pilot");

  const tasks = await ctx.memory.getTasks();
  assert.equal(tasks.length, 1);
  // Cached under the Python state-file key, visible through ctx.state.
  assert.deepEqual(ctx.state.get("tasks"), [{ external_key: "REHOR-1", status: "in_progress" }]);

  const capacity = await ctx.memory.getCapacity();
  assert.deepEqual(capacity, { active: 1, max: 10 });
  assert.deepEqual(ctx.state.get("capacity"), { active: 1, max: 10 });

  // One tasks fetch and one capacity fetch — repeated calls hit the cache.
  await ctx.memory.getTasks();
  await ctx.memory.getCapacity();
  assert.deepEqual(calls, [
    "http://memory:8080/api/tasks?exclude_status=archived&limit=50&instance_id=devbot-pilot",
    "http://memory:8080/api/tasks?exclude_status=archived&exclude_status=done&exclude_status=paused&limit=50&instance_id=devbot-pilot",
  ]);
});

test("run context forwards its instance id when the client config omits one", async () => {
  let url;
  const ctx = createPreflightRunContext({
    instanceId: "devbot-pilot",
    memory: {
      baseUrl: "http://memory:8080",
      fetch: async (requestUrl) => {
        url = requestUrl;
        return jsonResponse({ items: [] });
      },
    },
  });
  await ctx.memory.getTasks();
  assert.match(url, /instance_id=devbot-pilot/);
});

test("run context accepts an already-built memory client as-is", () => {
  const memory = createMemoryServerClient({ baseUrl: "http://memory:8080" });
  const ctx = createPreflightRunContext({ instanceId: "bot-1", memory });
  assert.equal(ctx.memory, memory);
});

test("run contexts do not share state", () => {
  const memory = createMemoryServerClient({ baseUrl: "http://memory:8080" });
  const a = createPreflightRunContext({ instanceId: "bot-1", memory });
  const b = createPreflightRunContext({ instanceId: "bot-1", memory });
  a.state.set("tasks", []);
  assert.equal(b.state.has("tasks"), false);
});

test("run context carries the proxy route wiring for external-system clients", () => {
  const memory = createMemoryServerClient({ baseUrl: "http://memory:8080" });
  const plain = createPreflightRunContext({
    instanceId: "bot-1",
    memory,
    proxy: "https://proxy.example/devbot-proxy",
  });
  assert.equal(plain.proxy, "https://proxy.example/devbot-proxy");

  const withFetch = createPreflightRunContext({
    instanceId: "bot-1",
    memory,
    proxy: {
      baseUrl: "https://proxy.example/devbot-proxy",
      fetch: async () => new Response("{}"),
    },
  });
  assert.deepEqual(withFetch.proxy, {
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: withFetch.proxy.fetch,
  });

  // An unwired route stays undefined — preflights decide how to fail on it.
  const unwired = createPreflightRunContext({ instanceId: "bot-1", memory });
  assert.equal(unwired.proxy, undefined);
});

test("run context wires a jira client from config", async () => {
  const calls = [];
  const ctx = createPreflightRunContext({
    instanceId: "bot-1",
    memory: { baseUrl: "http://memory:8080" },
    jira: {
      baseUrl: "https://proxy.example",
      fetch: async (url) => {
        calls.push(url);
        return jsonResponse({ issues: [], isLast: true });
      },
    },
  });
  const issues = await ctx.jira.searchIssues("jql");
  assert.deepEqual(issues, []);
  assert.deepEqual(calls, ["https://proxy.example/jira/rest/api/2/search/jql"]);
});

test("run context accepts an already-built jira client and leaves jira unwired when omitted", () => {
  const client = createJiraClient({ baseUrl: "https://proxy.example" });
  const ctx = createPreflightRunContext({
    instanceId: "bot-1",
    memory: { baseUrl: "http://memory:8080" },
    jira: client,
  });
  assert.equal(ctx.jira, client);
  const bare = createPreflightRunContext({
    instanceId: "bot-1",
    memory: { baseUrl: "http://memory:8080" },
  });
  assert.equal(bare.jira, undefined);
});

test("run context carries the dispatcher-materialized repos map, defaulting to {}", () => {
  const repos = { "my-repo": { upstream: "https://github.com/org/my-repo" } };
  const ctx = createPreflightRunContext({
    instanceId: "bot-1",
    memory: { baseUrl: "http://memory:8080" },
    repos,
  });
  assert.equal(ctx.repos, repos);
  const bare = createPreflightRunContext({
    instanceId: "bot-1",
    memory: { baseUrl: "http://memory:8080" },
  });
  assert.deepEqual(bare.repos, {});
});
