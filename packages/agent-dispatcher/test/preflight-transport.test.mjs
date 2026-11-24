import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { z } from "zod";
import { createPreflightRegistry, definePreflight } from "@rehor/preflights";
import { createPopulatedRegistry } from "@rehor/preflights/preflights";
import { runTsPreflight } from "../dist/preflight-engine-ts.js";
import { createPreflightTransport, PreflightDeadlineError } from "../dist/preflight-transport.js";

const token = "fixture-short-lived-credential";
const sprint = { id: "jira-sprint", with: { label: "fixture" } };
const profile = (preflights) => ({ name: "agent", workflow: "custom", preflights });
const deferred = () => Promise.withResolvers();
const json = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function gateway(t, handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, {}, 401);
    handler(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    requests, server, baseUrl,
    wiring: { instanceId: "fixture", memory: { baseUrl: `${baseUrl}/mcp`, token }, proxyBaseUrl: baseUrl },
  };
}

function registry(spec) {
  return createPreflightRegistry(Object.entries(spec).map(([id, run]) => definePreflight({ id, input: z.strictObject({}), run })));
}

test("populated Jira sprint authenticates at gateway and shares memory caches across entries", async (t) => {
  const fixture = await gateway(t, (req, res) => json(res,
    req.url.startsWith("/api/tasks?") ? { items: [] } : { issues: [], isLast: true }));
  const result = await runTsPreflight({ profile: profile([sprint, sprint]), wiring: fixture.wiring });
  assert.equal(result.action, "skip");
  assert.deepEqual(result.scripts.map((entry) => entry.status), ["skip", "skip"]);
  assert.equal(fixture.requests.filter((req) => req.url.startsWith("/api/tasks?")).length, 2);
  assert.equal(fixture.requests.filter((req) => req.url === "/jira/rest/api/2/search/jql").length, 2);
  assert.ok(fixture.requests.every((req) => req.authorization === `Bearer ${token}`));
  assert.ok(!JSON.stringify(result).includes(token));
});

test("populated GitHub and GitLab clients authenticate all detail/comment routes through gateway", async (t) => {
  const tasks = [{ external_key: "TASK-1", status: "pr_open", repo: "org/repo", metadata: {
    prs: [{ repo: "org/repo", number: 1, host: "github" }],
    mrs: [{ repo: "org/repo", number: 2, host: "gitlab" }],
  } }];
  const fixture = await gateway(t, (req, res) => {
    if (req.url.startsWith("/api/tasks?")) return json(res, { items: tasks });
    if (req.url === "/github/graphql") return json(res, { data: { repository: { pullRequest: {
      state: "MERGED", title: "Merged fixture", reviews: { nodes: [] },
    } } } });
    if (req.url.includes("/comments") || req.url.includes("/notes")) return json(res, []);
    if (req.url.startsWith("/gitlab/api/v4/projects/")) return json(res, { state: "merged", title: "Merged fixture" });
    json(res, {}, 404);
  });
  const result = await runTsPreflight({ profile: profile(["gh-pr-status", "gl-mr-status"]), wiring: fixture.wiring });
  assert.equal(result.action, "start");
  assert.deepEqual(result.scripts.map((entry) => entry.status), ["start", "start"]);
  assert.equal(fixture.requests.filter((req) => req.url.startsWith("/api/tasks?")).length, 2);
  for (const route of ["/github/graphql", "/github/repos/org/repo/pulls/1/comments", "/github/repos/org/repo/issues/1/comments", "/gitlab/api/v4/projects/org%2Frepo/merge_requests/2", "/gitlab/api/v4/projects/org%2Frepo/merge_requests/2/notes"]) {
    assert.ok(fixture.requests.some((req) => req.url.startsWith(route)), route);
  }
  assert.ok(fixture.requests.every((req) => req.authorization === `Bearer ${token}`));
});

test("missing or invalid proxy wiring fails without vendor fallback", async () => {
  for (const proxyBaseUrl of [undefined, "", "not-a-url", "file:///fixture", "https://user:password@proxy.example", "https://proxy.example?route=jira"]) {
    const result = await runTsPreflight({
      profile: profile([sprint]),
      wiring: { instanceId: "fixture", memory: { baseUrl: "http://127.0.0.1:1/mcp", token }, proxyBaseUrl },
    });
    assert.equal(result.action, "error");
    assert.equal(result.reason, proxyBaseUrl === undefined ? "execution" : "configuration");
    assert.ok(!JSON.stringify(result).includes("password"));
  }
});

test("gateway injection is confined to configured origin and subtree boundaries", async (t) => {
  const fixture = await gateway(t, (_req, res) => json(res, {}));
  const outside = await gateway(t, (_req, res) => json(res, {}));
  const transport = createPreflightTransport({ memoryBaseUrl: `${fixture.baseUrl}/mcp`, proxyBaseUrl: `${fixture.baseUrl}/services`, token });
  await transport.runEntry(async () => {
    for (const path of ["jira", "github", "gitlab"]) {
      await transport.gatewayFetch(`${fixture.baseUrl}/services/${path}/fixture`, { headers: { authorization: "replace-me" } });
    }
    for (const target of [
      `${outside.baseUrl}/services/jira/fixture`, `${fixture.baseUrl}/jira/fixture`,
      `${fixture.baseUrl}/services/github-other/fixture`, `${fixture.baseUrl}/services/executor/fixture`,
      `${fixture.baseUrl}/services/jira/../../private`, `${fixture.baseUrl}/services/jira/%2e%2e/%2e%2e/private`,
      `${fixture.baseUrl}/services/jira/fixture#fragment`,
    ]) await assert.rejects(transport.gatewayFetch(target, {}), /configured route/);
    await assert.rejects(transport.memoryFetch(`${outside.baseUrl}/api/tasks`, {}), /configured route/);
  }, undefined, 2_000);
  assert.equal(fixture.requests.length, 3);
  assert.deepEqual(outside.requests, []);
});

test("redirect following cannot send gateway credential to another origin or off-route path", async (t) => {
  const outside = await gateway(t, (_req, res) => json(res, {}));
  const fixture = await gateway(t, (req, res) => {
    res.writeHead(302, { location: req.url.includes("external") ? `${outside.baseUrl}/jira/target` : "/private/target" });
    res.end();
  });
  const transport = createPreflightTransport({ memoryBaseUrl: fixture.baseUrl, proxyBaseUrl: fixture.baseUrl, token });
  await transport.runEntry(async () => {
    for (const target of ["external", "internal"]) {
      await assert.rejects(transport.gatewayFetch(`${fixture.baseUrl}/jira/${target}`, { redirect: "follow" }));
      const response = await transport.gatewayFetch(`${fixture.baseUrl}/github/${target}`, { redirect: "manual" });
      assert.equal(response.status, 302);
    }
  }, undefined, 2_000);
  assert.equal(fixture.requests.length, 4);
  assert.deepEqual(outside.requests, []);
});

for (const destination of ["/gitlab/off-route", "external"]) {
  test(`GitHub client retains redirect and pagination boundaries: ${destination}`, { timeout: 3_000 }, async (t) => {
    const outside = await gateway(t, (_req, res) => json(res, []));
    const populated = createPopulatedRegistry();
    // The reviewed preflight builds the real Octokit client from ctx.proxy.
    const tasks = [{ status: "pr_open", metadata: { prs: [{ repo: "org/repo", number: 1, host: "github" }] } }];
    const api = await gateway(t, (req, res) => {
      if (req.url.startsWith("/api/tasks?")) return json(res, { items: tasks });
      if (req.url === "/github/graphql") return json(res, { data: { repository: { pullRequest: { state: "OPEN" } } } });
      const target = destination === "external" ? `${outside.baseUrl}/github/page` : new URL(destination, api.baseUrl).toString();
      if (req.url.includes("/pulls/")) { res.writeHead(302, { location: target }); return res.end(); }
      res.setHeader("link", `<${target}>; rel="next"`);
      json(res, []);
    });
    const result = await runTsPreflight({ profile: profile(["gh-pr-status"]), wiring: api.wiring, registry: populated });
    assert.equal(result.action, "error");
    assert.deepEqual(api.requests.filter((req) => req.url.startsWith("/github/")).map((req) => req.url), [
      "/github/graphql", "/github/repos/org/repo/pulls/1/comments", "/github/repos/org/repo/issues/1/comments",
    ]);
    assert.ok(api.requests.every((req) => req.url.startsWith("/api/tasks?") || req.url.startsWith("/github/")));
    assert.deepEqual(outside.requests, []);
  });
}

for (const phase of ["headers", "body", "error-body"]) {
  test(`abort during active memory ${phase} drains IO and starts no capacity, Jira, or later entry`, { timeout: 3_000 }, async (t) => {
    const controller = new AbortController();
    const closed = deferred();
    const fixture = await gateway(t, (req, res) => {
      res.on("close", closed.resolve);
      if (phase !== "headers") {
        res.writeHead(phase === "error-body" ? 503 : 200, { "content-type": "application/json" });
        res.write('{"items":[');
      }
      setImmediate(() => controller.abort());
    });
    const start = performance.now();
    const result = await runTsPreflight({ profile: profile([sprint, sprint]), wiring: fixture.wiring, signal: controller.signal });
    assert.equal(result.action, "error");
    assert.equal(result.transcript, "agent: Preflight cancelled");
    assert.equal(result.scripts.length, 1);
    await closed.promise;
    assert.equal(fixture.requests.length, 1);
    assert.ok(performance.now() - start < 1_000);
  });
}

test("abort during paginated Jira body stops next pages and later entries", { timeout: 3_000 }, async (t) => {
  const controller = new AbortController();
  let pages = 0;
  const fixture = await gateway(t, (req, res) => {
    if (req.url.startsWith("/api/tasks?")) return json(res, { items: [] });
    pages++;
    if (pages === 1) return json(res, { issues: [], isLast: false, nextPageToken: "page-2" });
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"issues":[');
    setImmediate(() => controller.abort());
  });
  const result = await runTsPreflight({ profile: profile([sprint, sprint]), wiring: fixture.wiring, signal: controller.signal });
  assert.equal(result.transcript, "agent: Preflight cancelled");
  assert.equal(result.scripts.length, 1);
  assert.equal(pages, 2);
  assert.equal(fixture.requests.length, 4);
});

test("entry deadline aborts IO, preserves shared context, and does not block later entries or profiles", { timeout: 3_000 }, async (t) => {
  let requests = 0;
  const fixture = await gateway(t, (_req, res) => { if (++requests > 1) json(res, { items: [] }); });
  const seen = [];
  const custom = registry({
    slow: async (ctx) => { seen.push(ctx); ctx.state.set("fixture", 42); await ctx.memory.getTasks(); return { status: "start", content: "late" }; },
    next: async (ctx) => { seen.push(ctx); assert.equal(ctx.state.get("fixture"), 42); await ctx.memory.getTasks(); return { status: "start", content: "work" }; },
  });
  const result = await runTsPreflight({ profile: profile(["slow", "next"]), wiring: fixture.wiring, registry: custom, entryTimeoutMs: 150 });
  assert.equal(result.action, "start");
  assert.equal(result.prompt, "work");
  assert.deepEqual(result.scripts.map((entry) => entry.status), ["error", "start"]);
  assert.equal(result.scripts[0].content, "slow timed out after 150ms");
  assert.equal(seen[0], seen[1]);
  assert.equal(fixture.requests.length, 2);
  const later = await runTsPreflight({ profile: profile(["slow"]), wiring: fixture.wiring, registry: custom, entryTimeoutMs: 150 });
  assert.equal(later.action, "start");
});

test("failed entry drains parallel response bodies before next entry", { timeout: 3_000 }, async (t) => {
  const commentsOpen = deferred();
  const commentsClosed = deferred();
  const fixture = await gateway(t, (req, res) => {
    if (new URL(req.url, "http://fixture.invalid").pathname.endsWith("/comment")) {
      res.on("close", commentsClosed.resolve);
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"comments":[');
      commentsOpen.resolve();
      return;
    }
    if (req.url.startsWith("/jira/")) {
      void commentsOpen.promise.then(() => json(res, {}, 500));
      return;
    }
    json(res, { items: [] });
  });
  const custom = registry({
    parallel: async (ctx) => { await ctx.jira.getIssueWithComments("TASK-1"); return { status: "start", content: "never" }; },
    next: async (ctx) => { await ctx.memory.getTasks(); return { status: "start", content: "work" }; },
  });
  const result = await runTsPreflight({ profile: profile(["parallel", "next"]), wiring: fixture.wiring, registry: custom });
  assert.equal(result.action, "start");
  assert.equal(result.prompt, "work");
  assert.deepEqual(result.scripts.map((entry) => entry.status), ["error", "start"]);
  await commentsClosed.promise;
  assert.equal(fixture.requests.length, 3);
  assert.ok(fixture.requests.some((req) => req.url === "/jira/rest/api/2/issue/TASK-1/comment?startAt=0&maxResults=50"));
});

test("late continuation stays cancelled while another entry runs", { timeout: 3_000 }, async (t) => {
  const fixture = await gateway(t, (_req, res) => json(res, {}));
  const transport = createPreflightTransport({ memoryBaseUrl: fixture.baseUrl, proxyBaseUrl: fixture.baseUrl, token });
  const release = deferred();
  const lateDone = deferred();
  await assert.rejects(transport.runEntry(async () => {
    await release.promise;
    await assert.rejects(transport.gatewayFetch(`${fixture.baseUrl}/jira/late`, {}));
    lateDone.resolve();
  }, undefined, 20), PreflightDeadlineError);
  await transport.runEntry(async () => {
    release.resolve();
    await lateDone.promise;
    await transport.gatewayFetch(`${fixture.baseUrl}/jira/current`, {});
  }, undefined, 2_000);
  assert.deepEqual(fixture.requests.map((req) => req.url), ["/jira/current"]);
});

test("request timeouts remain effective within longer entry deadline, including body reads", { timeout: 3_000 }, async (t) => {
  const fixture = await gateway(t, (_req, res) => { res.writeHead(200); res.write("partial"); });
  const transport = createPreflightTransport({ memoryBaseUrl: fixture.baseUrl, proxyBaseUrl: fixture.baseUrl, token });
  const start = performance.now();
  await transport.runEntry(async () => {
    await assert.rejects(transport.gatewayFetch(`${fixture.baseUrl}/jira/fixture`, { signal: AbortSignal.timeout(150) }));
  }, undefined, 2_000);
  assert.ok(performance.now() - start < 1_000);
  assert.equal(fixture.requests.length, 1);
});

test("already aborted runs launch no entries or network requests", async (t) => {
  const fixture = await gateway(t, (_req, res) => json(res, {}));
  const result = await runTsPreflight({ profile: profile([sprint]), wiring: fixture.wiring, signal: AbortSignal.abort() });
  assert.equal(result.transcript, "agent: Preflight cancelled");
  assert.deepEqual(result.scripts, []);
  assert.deepEqual(fixture.requests, []);
});
