import assert from "node:assert/strict";
import test from "node:test";
import { PreflightHttpError } from "../dist/shared/http.js";
import {
  createMemoryServerClient,
  MemoryAuthRejectedError,
  normalizeMemoryBaseUrl,
} from "../dist/shared/memory-server.js";

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const recordingFetch = (handler) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init, calls });
  };
  return { fetch, calls };
};

test("normalizeMemoryBaseUrl strips one /mcp suffix and trailing slashes", () => {
  assert.equal(
    normalizeMemoryBaseUrl("http://memory-server:8080/mcp"),
    "http://memory-server:8080",
  );
  assert.equal(
    normalizeMemoryBaseUrl("http://memory-server:8080/mcp/"),
    "http://memory-server:8080",
  );
  assert.equal(normalizeMemoryBaseUrl("http://localhost:8080"), "http://localhost:8080");
  assert.equal(normalizeMemoryBaseUrl("http://localhost:8080/"), "http://localhost:8080");
  // One strip only, like the Python helper.
  assert.equal(normalizeMemoryBaseUrl("https://host/mcp/mcp"), "https://host/mcp");
});

test("memory client sends a bearer token only when one is configured", async () => {
  const withToken = recordingFetch(() => jsonResponse({ items: [] }));
  const tokenized = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    token: "synthetic-secret",
    fetch: withToken.fetch,
  });
  await tokenized.getTasks();
  assert.equal(withToken.calls[0].init.headers.Authorization, "Bearer synthetic-secret");

  // No token configured → no Authorization header (credentials are injected
  // configuration, never read from the environment).
  const bare = recordingFetch(() => jsonResponse({ items: [] }));
  const anonymous = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch: bare.fetch });
  await anonymous.getTasks();
  assert.equal(bare.calls[0].init.headers.Authorization, undefined);
});

test("memory client queries active tasks with the Python helper's URL", async () => {
  const { fetch, calls } = recordingFetch(() =>
    jsonResponse({ items: [{ external_key: "REHOR-1" }] }),
  );
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  const tasks = await client.getTasks();
  assert.deepEqual(tasks, [{ external_key: "REHOR-1" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://memory:8080/api/tasks?exclude_status=archived&limit=50");
});

test("memory client appends instance_id when an instance is configured", async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ items: [] }));
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080/mcp",
    instanceId: "devbot-pilot",
    fetch,
  });
  await client.getTasks();
  assert.equal(
    calls[0].url,
    "http://memory:8080/api/tasks?exclude_status=archived&limit=50&instance_id=devbot-pilot",
  );
});

test("memory client tolerates responses without items", async () => {
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async () => jsonResponse({}),
  });
  assert.deepEqual(await client.getTasks(), []);
});

test("memory client caches tasks per client instance — one fetch per run", async () => {
  const { fetch, calls } = recordingFetch(() =>
    jsonResponse({ items: [{ external_key: "REHOR-1" }, { external_key: "REHOR-2" }] }),
  );
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  assert.equal((await client.getTasks()).length, 2);
  assert.equal((await client.getTasks()).length, 2);
  assert.equal(calls.length, 1);
});

test("memory client queries capacity with the repeated exclude_status keys", async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ items: [] }));
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  const capacity = await client.getCapacity();
  assert.deepEqual(capacity, { active: 0, max: 10 });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "http://memory:8080/api/tasks?exclude_status=archived&exclude_status=done&exclude_status=paused&limit=50",
  );
});

test("memory client counts only active statuses toward capacity", async () => {
  const items = [
    { status: "in_progress" },
    { status: "pr_open" },
    { status: "pr_changes" },
    { status: "paused" },
    { status: "done" },
    { status: "needs_review" },
    {},
  ];
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async () => jsonResponse({ items }),
  });
  assert.deepEqual(await client.getCapacity(), { active: 3, max: 10 });
});

test("memory client caches capacity separately from tasks", async () => {
  const { fetch, calls } = recordingFetch(() =>
    jsonResponse({ items: [{ status: "in_progress" }] }),
  );
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  await client.getTasks();
  await client.getCapacity();
  await client.getCapacity();
  assert.equal(calls.length, 2);
});

test("memory client rejects authenticated requests instead of returning empty", async () => {
  for (const status of [401, 403]) {
    const client = createMemoryServerClient({
      baseUrl: "http://memory:8080",
      token: "rejected-token",
      fetch: async () => new Response("denied", { status }),
    });
    await assert.rejects(
      () => client.getTasks(),
      (error) => {
        assert.ok(error instanceof MemoryAuthRejectedError);
        assert.ok(error instanceof PreflightHttpError);
        assert.equal(error.status, status);
        assert.equal(error.message, `authenticated request rejected (${status})`);
        return true;
      },
    );
  }
});

test("memory client treats other failures as execution errors and retries on the next call", async () => {
  let failures = 2;
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async () => {
      if (failures > 0) {
        failures -= 1;
        return new Response("down", { status: 503 });
      }
      return jsonResponse({ items: [{ external_key: "REHOR-1" }] });
    },
  });
  await assert.rejects(
    () => client.getTasks(),
    (error) => {
      assert.ok(error instanceof PreflightHttpError);
      assert.ok(!(error instanceof MemoryAuthRejectedError));
      assert.equal(error.status, 503);
      return true;
    },
  );
  // A failed fetch is never cached as an empty task list.
  await assert.rejects(() => client.getTasks());
  assert.deepEqual(await client.getTasks(), [{ external_key: "REHOR-1" }]);
});
