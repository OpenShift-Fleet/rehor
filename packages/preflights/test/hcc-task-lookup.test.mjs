import assert from "node:assert/strict";
import test from "node:test";
import { PreflightHttpError } from "../dist/shared/http.js";
import { createMemoryServerClient, MemoryAuthRejectedError } from "../dist/shared/memory-server.js";

// Regression tests for the exact task-key lookup the HCC daily/weekly gates
// need: getTasks() excludes archived tasks and caps at the newest 50, so a
// gate task that is archived or older than the newest 50 used to look absent
// and the preflight restarted finished work. getTaskByKey matches the key
// (and optional source type) client-side while paging through the full
// /api/tasks listing — the API has no server-side external_key/source_type
// filtering. Fetched pages are cached per scope (global vs instance) and
// shared across lookups on the same client, so per-finding scans over many
// keys paginate once. undefined means absent from the scanned (possibly
// cached) pages, not a guaranteed exact absence under concurrent writes.

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

const task = (external_key, extra = {}) => ({ external_key, ...extra });

const fillers = (count, first = 1) =>
  Array.from({ length: count }, (_, i) => task(`filler-${first + i}`));

const pageAt = (url, offset) => Number(new URL(url).searchParams.get("offset")) === offset;

test("getTaskByKey finds a task on the first page without excluding any status", async () => {
  const gate = task("merge-violations-2026-11-18", { status: "in_progress" });
  const { fetch, calls } = recordingFetch(() =>
    jsonResponse({ items: [gate, ...fillers(49)], total: 50 }),
  );
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  assert.deepEqual(await client.getTaskByKey("merge-violations-2026-11-18"), gate);
  assert.equal(calls.length, 1);
  // No exclude_status (archived must be visible) and an explicit page
  // window; the key match itself is client-side.
  assert.equal(calls[0].url, "http://memory:8080/api/tasks?limit=50&offset=0");
});

test("getTaskByKey filters by source type client-side", async () => {
  const foreign = task("gate-1", { source_type: "github" });
  const gate = task("gate-1", { source_type: "jira" });
  const { fetch, calls } = recordingFetch(() => jsonResponse({ items: [foreign, gate], total: 2 }));
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  assert.deepEqual(await client.getTaskByKey("gate-1", { sourceType: "jira" }), gate);
  assert.equal(calls.length, 1);
  // No source_type query param: the filter is applied client-side only.
  assert.equal(calls[0].url, "http://memory:8080/api/tasks?limit=50&offset=0");
});

test("getTaskByKey finds an archived gate task", async () => {
  const archived = task("test-scan-2026-11-17", { status: "archived" });
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async () => jsonResponse({ items: [archived], total: 1 }),
  });
  assert.deepEqual(await client.getTaskByKey("test-scan-2026-11-17"), archived);
});

test("getTaskByKey pages past the 50-task listing cap and stops at the match", async () => {
  const gate = task("weekly-report-2026-11-13", { status: "done" });
  const { fetch, calls } = recordingFetch(({ url }) => {
    if (pageAt(url, 0)) {
      return jsonResponse({ items: fillers(50), total: 120 });
    }
    return jsonResponse({ items: [...fillers(9, 51), gate], total: 120 });
  });
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  assert.deepEqual(await client.getTaskByKey("weekly-report-2026-11-13"), gate);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "http://memory:8080/api/tasks?limit=50&offset=50");
  // The match ends the scan even though total (120) was not reached.
});

test("getTaskByKey resolves undefined only after exhausting the scanned pages", async () => {
  const { fetch, calls } = recordingFetch(({ url }) => {
    if (pageAt(url, 0)) return jsonResponse({ items: fillers(50), total: 70 });
    return jsonResponse({ items: fillers(20, 51), total: 70 });
  });
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  assert.equal(await client.getTaskByKey("merge-violations-2026-11-18"), undefined);
  assert.equal(calls.length, 2);
});

test("getTaskByKey skips a same-key task of a foreign source type across pages", async () => {
  const foreign = task("gate-1", { source_type: "github" });
  const gate = task("gate-1", { source_type: "jira" });
  const { fetch, calls } = recordingFetch(({ url }) => {
    if (pageAt(url, 0)) return jsonResponse({ items: [foreign, ...fillers(49)], total: 120 });
    return jsonResponse({ items: [...fillers(49, 51), gate], total: 120 });
  });
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  assert.deepEqual(await client.getTaskByKey("gate-1", { sourceType: "jira" }), gate);
  assert.equal(calls.length, 2);
  // No external_key/source_type query params: the match is client-side.
  assert.equal(calls[0].url, "http://memory:8080/api/tasks?limit=50&offset=0");
});

test("getTaskByKey treats an empty page as absence within the scanned pages", async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ items: [] }));
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  assert.equal(await client.getTaskByKey("nope"), undefined);
  assert.equal(calls.length, 1);
});

test("getTaskByKey treats a short page without total as the last page", async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ items: fillers(3) }));
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  assert.equal(await client.getTaskByKey("nope"), undefined);
  assert.equal(calls.length, 1);
});

test("getTaskByKey can filter by source_type", async () => {
  const foreign = task("gate-1", { source_type: "github" });
  const own = task("gate-1", { source_type: "jira" });
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async () => jsonResponse({ items: [foreign, own], total: 2 }),
  });
  assert.deepEqual(await client.getTaskByKey("gate-1", { sourceType: "jira" }), own);
  assert.equal(await client.getTaskByKey("gate-1", { sourceType: "gitlab" }), undefined);
  // Without a filter, any source matches.
  assert.deepEqual(await client.getTaskByKey("gate-1"), foreign);
});

test("getTaskByKey defaults to the global scope and can opt into instance scoping", async () => {
  const gate = task("gate-1");
  const unscoped = recordingFetch(() => jsonResponse({ items: [gate] }));
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    instanceId: "hcc-framework-agent-dev",
    fetch: unscoped.fetch,
  });
  // Even with an instance configured, the default lookup is not scoped:
  // gate tasks are agent-created and their instance_id is not guaranteed.
  assert.deepEqual(await client.getTaskByKey("gate-1"), gate);
  assert.equal(unscoped.calls[0].url, "http://memory:8080/api/tasks?limit=50&offset=0");

  const scoped = recordingFetch(() => jsonResponse({ items: [gate] }));
  const scopedClient = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    instanceId: "hcc-framework-agent-dev",
    fetch: scoped.fetch,
  });
  assert.deepEqual(await scopedClient.getTaskByKey("gate-1", { scopeByInstance: true }), gate);
  assert.equal(
    scoped.calls[0].url,
    "http://memory:8080/api/tasks?limit=50&offset=0&instance_id=hcc-framework-agent-dev",
  );

  // Opting in without a configured instance cannot scope.
  const bare = recordingFetch(() => jsonResponse({ items: [] }));
  const bareClient = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch: bare.fetch });
  assert.equal(await bareClient.getTaskByKey("gate-1", { scopeByInstance: true }), undefined);
  assert.equal(bare.calls[0].url, "http://memory:8080/api/tasks?limit=50&offset=0");
});

test("getTaskByKey sends the bearer token in the header, never the URL", async () => {
  const gate = task("gate-1");
  const { fetch, calls } = recordingFetch(() => jsonResponse({ items: [gate] }));
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    token: "synthetic-secret",
    fetch,
  });
  assert.deepEqual(await client.getTaskByKey("gate-1"), gate);
  assert.equal(calls[0].init.headers.Authorization, "Bearer synthetic-secret");
  assert.ok(!calls[0].url.includes("synthetic-secret"));
});

for (const status of [401, 403]) {
  test(`getTaskByKey fails closed on ${status} instead of reporting absent`, async () => {
    const client = createMemoryServerClient({
      baseUrl: "http://memory:8080",
      token: "rejected-token",
      fetch: async () => new Response("denied", { status }),
    });
    await assert.rejects(
      () => client.getTaskByKey("gate-1"),
      (error) => {
        assert.ok(error instanceof MemoryAuthRejectedError);
        assert.ok(error instanceof PreflightHttpError);
        assert.equal(error.status, status);
        assert.equal(error.message, `authenticated request rejected (${status})`);
        return true;
      },
    );
  });
}

test("getTaskByKey fails closed on a late-page auth rejection", async () => {
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async (url) => {
      if (pageAt(url, 0)) return jsonResponse({ items: fillers(50), total: 100 });
      return new Response("denied", { status: 403 });
    },
  });
  await assert.rejects(
    () => client.getTaskByKey("gate-1"),
    (error) => error instanceof MemoryAuthRejectedError,
  );
});

test("getTaskByKey fails closed on server errors and retries on the next call", async () => {
  let failures = 1;
  const gate = task("gate-1");
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async () => {
      if (failures > 0) {
        failures -= 1;
        return new Response("down", { status: 500 });
      }
      return jsonResponse({ items: [gate] });
    },
  });
  await assert.rejects(
    () => client.getTaskByKey("gate-1"),
    (error) => {
      assert.ok(error instanceof PreflightHttpError);
      assert.ok(!(error instanceof MemoryAuthRejectedError));
      assert.equal(error.status, 500);
      return true;
    },
  );
  // The failure is not cached as an absence.
  assert.deepEqual(await client.getTaskByKey("gate-1"), gate);
});

test("getTaskByKey fails closed on transport failures", async () => {
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    () => client.getTaskByKey("gate-1"),
    (error) => {
      assert.ok(error instanceof PreflightHttpError);
      assert.equal(error.status, null);
      return true;
    },
  );
});

test("getTaskByKey fails closed on a malformed page instead of treating it as empty", async () => {
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    fetch: async () => jsonResponse({ total: 5 }),
  });
  await assert.rejects(
    () => client.getTaskByKey("gate-1"),
    (error) => {
      assert.ok(!(error instanceof PreflightHttpError));
      assert.match(error.message, /no items array/);
      return true;
    },
  );
});

test("getTaskByKey fails closed when the scan exceeds the page bound", async () => {
  // 200 pages of full filler pages, no total, never a match.
  const { fetch, calls } = recordingFetch(() => jsonResponse({ items: fillers(50) }));
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  await assert.rejects(
    () => client.getTaskByKey("gate-1"),
    (error) => {
      assert.match(error.message, /exceeded 200 pages/);
      return true;
    },
  );
  assert.equal(calls.length, 200);
});

test("getTaskByKey rejects an empty key before any request", async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({ items: [] }));
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  await assert.rejects(() => client.getTaskByKey(""), /non-empty externalKey/);
  await assert.rejects(() => client.getTaskByKey(undefined), /non-empty externalKey/);
  assert.equal(calls.length, 0);
});

test("getTaskByKey memoizes one lookup per key and shares pages across signatures", async () => {
  const jiraGate = task("gate-1", { source_type: "jira" });
  const other = task("gate-2");
  const { fetch, calls } = recordingFetch(() =>
    jsonResponse({ items: [jiraGate, other], total: 2 }),
  );
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  assert.deepEqual(await client.getTaskByKey("gate-1"), jiraGate);
  // Same key and signature: memoized, no refetch.
  assert.deepEqual(await client.getTaskByKey("gate-1"), jiraGate);
  assert.equal(calls.length, 1);

  // A different source-type filter is a different lookup, but it reuses
  // the cached page instead of paginating again.
  assert.deepEqual(await client.getTaskByKey("gate-1", { sourceType: "jira" }), jiraGate);
  assert.equal(calls.length, 1);

  // A different key is a different lookup served from the same page.
  assert.deepEqual(await client.getTaskByKey("gate-2"), other);
  assert.equal(calls.length, 1);
});

test("getTaskByKey reuses fetched pages across different keys", async () => {
  const a = task("key-a");
  const b = task("key-b");
  const { fetch, calls } = recordingFetch(({ url }) => {
    if (pageAt(url, 0)) return jsonResponse({ items: fillers(50), total: 120 });
    if (pageAt(url, 50)) return jsonResponse({ items: [...fillers(49, 51), a], total: 120 });
    return jsonResponse({ items: [...fillers(19, 101), b], total: 120 });
  });
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  // First key pays for the pagination and stops at its own match.
  assert.deepEqual(await client.getTaskByKey("key-a"), a);
  assert.equal(calls.length, 2);
  // Second key continues from the cached pages and fetches only the page
  // it has not seen yet.
  assert.deepEqual(await client.getTaskByKey("key-b"), b);
  assert.equal(calls.length, 3);
  // A miss resolves from the cached pages alone — no new requests.
  assert.equal(await client.getTaskByKey("missing"), undefined);
  assert.equal(calls.length, 3);
});

test("concurrent lookups deduplicate in-flight page requests", async () => {
  const a = task("key-a");
  const b = task("key-b");
  let pending = 0;
  const { fetch, calls } = recordingFetch(async ({ url }) => {
    // Two lookups starting together must not issue overlapping requests
    // for the same page.
    pending += 1;
    assert.equal(pending, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    pending -= 1;
    if (pageAt(url, 0)) return jsonResponse({ items: [a, b, ...fillers(48)], total: 50 });
    return jsonResponse({ items: [] });
  });
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  const [first, second] = await Promise.all([
    client.getTaskByKey("key-a"),
    client.getTaskByKey("key-b"),
  ]);
  assert.deepEqual(first, a);
  assert.deepEqual(second, b);
  // One shared page-0 request served both lookups.
  assert.equal(calls.length, 1);
});

test("a failed page request is not cached and a retry refetches", async () => {
  const gate = task("gate-1");
  const other = task("gate-2");
  let failures = 1;
  const { fetch, calls } = recordingFetch(async () => {
    if (failures > 0) {
      failures -= 1;
      return new Response("down", { status: 500 });
    }
    return jsonResponse({ items: [gate, other], total: 2 });
  });
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  await assert.rejects(
    () => client.getTaskByKey("gate-1"),
    (error) => error instanceof PreflightHttpError && error.status === 500,
  );
  // The failure left nothing behind: the retry refetches the page.
  assert.deepEqual(await client.getTaskByKey("gate-1"), gate);
  assert.equal(calls.length, 2);
  // The recovered page is cached and serves another key without a request.
  assert.deepEqual(await client.getTaskByKey("gate-2"), other);
  assert.equal(calls.length, 2);
});

test("page cache is scoped per instance: global and instance lookups never share pages", async () => {
  const globalGate = task("gate-1");
  const instanceGate = task("gate-2");
  const { fetch, calls } = recordingFetch(({ url }) => {
    if (new URL(url).searchParams.get("instance_id") === null) {
      return jsonResponse({ items: [globalGate], total: 1 });
    }
    return jsonResponse({ items: [instanceGate], total: 1 });
  });
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    instanceId: "hcc-framework-agent-dev",
    fetch,
  });
  // Global lookup fetches the unscoped listing.
  assert.deepEqual(await client.getTaskByKey("gate-1"), globalGate);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://memory:8080/api/tasks?limit=50&offset=0");
  // Instance-scoped lookup fetches separately: cached global pages are
  // never reused across scopes.
  assert.deepEqual(await client.getTaskByKey("gate-2", { scopeByInstance: true }), instanceGate);
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1].url,
    "http://memory:8080/api/tasks?limit=50&offset=0&instance_id=hcc-framework-agent-dev",
  );
  // Repeated lookups in each scope reuse only their own pages.
  assert.deepEqual(await client.getTaskByKey("gate-1"), globalGate);
  assert.deepEqual(await client.getTaskByKey("gate-2", { scopeByInstance: true }), instanceGate);
  assert.equal(calls.length, 2);
  // A global lookup for an instance-only key must not see instance pages.
  assert.equal(await client.getTaskByKey("gate-2"), undefined);
  assert.equal(calls.length, 2);
});

test("getTaskByKey does not disturb the getTasks/getCapacity run-state caches", async () => {
  const gate = task("gate-1");
  const { fetch, calls } = recordingFetch(() => jsonResponse({ items: [gate] }));
  const client = createMemoryServerClient({ baseUrl: "http://memory:8080", fetch });
  await client.getTaskByKey("gate-1");
  await client.getTasks();
  await client.getCapacity();
  // Three distinct fetches: the lookup never seeds or reads the listing caches.
  assert.equal(calls.length, 3);
});
