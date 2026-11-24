import assert from "node:assert/strict";
import test from "node:test";
import { createHttpClient, isPreflightHttpError, PreflightHttpError } from "../dist/shared/http.js";

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("http client composes the proxy base URL with the system path prefix", async () => {
  const calls = [];
  const client = createHttpClient({
    baseUrl: "https://proxy.example/devbot-proxy/",
    pathPrefix: "jira",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true });
    },
  });
  assert.equal(client.route, "https://proxy.example/devbot-proxy/jira");
  const data = await client.getJson("/rest/api/2/search");
  assert.deepEqual(data, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://proxy.example/devbot-proxy/jira/rest/api/2/search");
});

test("http client sends Accept JSON and no credentials of its own", async () => {
  let seen;
  const client = createHttpClient({
    baseUrl: "https://proxy.example",
    fetch: async (_url, init) => {
      seen = init;
      return jsonResponse([]);
    },
  });
  await client.getJson("/x");
  assert.equal(seen.headers.Accept, "application/json");
  assert.equal(seen.headers.Authorization, undefined);
  assert.equal(seen.method, "GET");
});

test("http client serializes query values, repeating array keys", async () => {
  let url;
  const client = createHttpClient({
    baseUrl: "https://proxy.example",
    fetch: async (requestUrl) => {
      url = requestUrl;
      return jsonResponse({});
    },
  });
  await client.getJson("/api/tasks", {
    query: { exclude_status: ["archived", "done"], limit: 50, instance_id: "bot-1" },
  });
  assert.equal(
    url,
    "https://proxy.example/api/tasks?exclude_status=archived&exclude_status=done&limit=50&instance_id=bot-1",
  );
});

test("http client posts a JSON body with content type", async () => {
  let seen;
  const client = createHttpClient({
    baseUrl: "https://proxy.example",
    fetch: async (_url, init) => {
      seen = init;
      return jsonResponse({ issues: [] });
    },
  });
  await client.postJson("/search", { jql: "project = REHOR" });
  assert.equal(seen.method, "POST");
  assert.equal(seen.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(seen.body), { jql: "project = REHOR" });
});

test("http client rejects non-2xx responses as execution errors", async () => {
  const client = createHttpClient({
    baseUrl: "https://proxy.example",
    pathPrefix: "/jira",
    fetch: async () => new Response("boom", { status: 500 }),
  });
  await assert.rejects(
    () => client.getJson("/rest/api/2/search"),
    (error) => {
      assert.ok(error instanceof PreflightHttpError);
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 500);
      assert.equal(error.method, "GET");
      assert.equal(error.url, "https://proxy.example/jira/rest/api/2/search");
      assert.equal(error.route, "https://proxy.example/jira");
      assert.equal(error.routeUnavailable, false);
      assert.match(error.message, /HTTP 500/);
      return true;
    },
  );
});

test("http client flags 404 as an unavailable route, never a silent skip", async () => {
  const client = createHttpClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    pathPrefix: "/jira",
    fetch: async () => new Response("not found", { status: 404 }),
  });
  await assert.rejects(
    () => client.getJson("/rest/api/2/search"),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 404);
      assert.equal(error.routeUnavailable, true);
      assert.match(
        error.message,
        /required route "https:\/\/proxy.example\/devbot-proxy\/jira" is not available/,
      );
      return true;
    },
  );
});

test("http client wraps network failures as statusless execution errors", async () => {
  const client = createHttpClient({
    baseUrl: "https://proxy.example",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    () => client.getJson("/x"),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, null);
      assert.equal(error.routeUnavailable, false);
      assert.match(error.message, /failed: fetch failed/);
      return true;
    },
  );
});

test("http client turns timeouts into execution errors", async () => {
  const client = createHttpClient({
    baseUrl: "https://proxy.example",
    timeoutMs: 20,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        // AbortSignal.timeout() arms an unref'd timer: on Node 22 nothing else
        // keeps the event loop alive, so it would drain before the abort fires.
        // Keep the loop alive with a ref'd fallback; if the abort never comes,
        // reject loudly instead of hanging the test runner.
        const fallback = setTimeout(() => reject(new Error("test fetch never aborted")), 5_000);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(fallback);
          reject(init.signal.reason);
        });
      }),
  });
  await assert.rejects(
    () => client.getJson("/x"),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, null);
      assert.match(error.message, /timed out after 20ms/);
      return true;
    },
  );
});

test("http client rejects 200 responses with non-JSON bodies", async () => {
  const client = createHttpClient({
    baseUrl: "https://proxy.example",
    fetch: async () => new Response("<html>gateway</html>", { status: 200 }),
  });
  await assert.rejects(
    () => client.getJson("/x"),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.match(error.message, /non-JSON/);
      return true;
    },
  );
});

test("http client requires an absolute http(s) base URL and /-prefixed paths", async () => {
  assert.throws(() => createHttpClient({ baseUrl: "" }), /non-empty/);
  assert.throws(() => createHttpClient({ baseUrl: "proxy.example/jira" }), /absolute URL/);
  assert.throws(() => createHttpClient({ baseUrl: "ftp://proxy.example" }), /absolute URL/);
  const client = createHttpClient({
    baseUrl: "https://proxy.example",
    fetch: async () => jsonResponse({}),
  });
  await assert.rejects(() => client.getJson("no-slash"), /must start with/);
});

test("isPreflightHttpError rejects unrelated errors", () => {
  assert.equal(isPreflightHttpError(new Error("nope")), false);
  assert.equal(isPreflightHttpError("string"), false);
  assert.equal(isPreflightHttpError(null), false);
});
