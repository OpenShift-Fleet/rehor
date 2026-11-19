import assert from "node:assert/strict";
import test from "node:test";
import { PreflightHttpError } from "../dist/shared/http.js";
import { createMemoryServerClient, MemoryAuthRejectedError } from "../dist/shared/memory-server.js";
import { createRunState } from "../dist/shared/run-context.js";

// Tests for the instance-scoped active-task retrieval the quality
// feedback preflight needs: getTasks() returns only the newest 50 tasks
// of all statuses, so done tasks can hide an older active task behind
// the cap. getActiveTasks() queries each active status
// (in_progress/pr_open/pr_changes) separately, scoped to the configured
// instance, and pages through the whole per-status listing. Known,
// pinned limitation: the query is instance-scoped, so historical task
// rows with a missing or foreign instance_id are not selected — the
// fetch refuses to broaden to the global listing rather than mix other
// instances' tasks into the result.

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

const fillers = (count, first = 1, status = "in_progress") =>
  Array.from({ length: count }, (_, i) => task(`filler-${first + i}`, { status }));

const INSTANCE = "hcc-framework-agent-dev";

/** Query params of a recorded request URL. */
const paramsOf = (url) => new URL(url).searchParams;

/** Server double: buckets tasks by status, pages per query window. */
const statusServer = (tasks = []) =>
  recordingFetch(({ url }) => {
    const params = paramsOf(url);
    const status = params.get("status");
    const limit = Number(params.get("limit") ?? 20);
    const offset = Number(params.get("offset") ?? 0);
    const bucket = status === null ? tasks : tasks.filter((item) => item.status === status);
    return jsonResponse({ items: bucket.slice(offset, offset + limit), total: bucket.length });
  });

const clientOn = (server, options = {}) =>
  createMemoryServerClient({
    baseUrl: "http://memory:8080",
    instanceId: INSTANCE,
    fetch: server.fetch,
    ...options,
  });

test("getActiveTasks scans each active status instance-scoped and paginated", async () => {
  const tasks = [...fillers(50), ...fillers(10, 51), task("pr-open-1", { status: "pr_open" })];
  const server = statusServer(tasks);
  const active = await clientOn(server).getActiveTasks();
  assert.equal(active.length, 61);
  // One full scan per status, in the canonical active-status order, each
  // page instance-scoped; the 60 in_progress tasks need two pages.
  assert.deepEqual(
    server.calls.map((call) => call.url),
    [
      `http://memory:8080/api/tasks?status=in_progress&limit=50&offset=0&instance_id=${INSTANCE}`,
      `http://memory:8080/api/tasks?status=in_progress&limit=50&offset=50&instance_id=${INSTANCE}`,
      `http://memory:8080/api/tasks?status=pr_open&limit=50&offset=0&instance_id=${INSTANCE}`,
      `http://memory:8080/api/tasks?status=pr_changes&limit=50&offset=0&instance_id=${INSTANCE}`,
    ],
  );
});

test("more than 50 done tasks cannot hide an older active task", async () => {
  const active = task("merge-violation:my-repo:123", { status: "in_progress" });
  const server = statusServer([...fillers(55, 1, "done"), active]);
  const result = await clientOn(server).getActiveTasks();
  // The done tasks never enter the result: the queries are status-scoped,
  // so the newest-50 all-status cap that hides the active task from the
  // plain listing does not apply.
  assert.deepEqual(result, [active]);
  for (const call of server.calls) {
    assert.match(paramsOf(call.url).get("status"), /^(in_progress|pr_open|pr_changes)$/);
  }
  // Demonstrated on the same server: the plain listing the preflight
  // used to inherit misses the task behind the done tasks.
  const listed = await clientOn(server).getTasks();
  assert.equal(
    listed.some((item) => item.external_key === "merge-violation:my-repo:123"),
    false,
  );
});

test("getActiveTasks pages deep into a status listing", async () => {
  const target = task("merge-violation:deep:9", { status: "pr_changes" });
  const bucket = [...fillers(95, 1, "pr_changes"), target, ...fillers(24, 96, "pr_changes")];
  const server = statusServer(bucket);
  const result = await clientOn(server).getActiveTasks();
  assert.ok(result.some((item) => item.external_key === "merge-violation:deep:9"));
  assert.equal(result.length, 120);
  // Three pages for the 120 pr_changes tasks plus one empty page for
  // each of the two statuses nothing sits in.
  assert.equal(server.calls.length, 5);
});

test("getActiveTasks refuses to run without a configured instance and never queries globally", async () => {
  const server = statusServer([task("a-1")]);
  await assert.rejects(
    () => clientOn(server, { instanceId: undefined }).getActiveTasks(),
    /requires a configured instanceId/,
  );
  await assert.rejects(
    () => clientOn(server, { instanceId: "" }).getActiveTasks(),
    /requires a configured instanceId/,
  );
  // The refusal happens before any request — never a global listing.
  assert.equal(server.calls.length, 0);
});

test("instance scoping never selects other instances' rows", async () => {
  // Historical rows with a foreign instance_id are not selected, and
  // the fetch does not compensate by dropping the instance_id query.
  const foreign = task("merge-violation:other:1", {
    status: "in_progress",
    instance_id: "somewhere-else",
  });
  const own = task("merge-violation:own:1", { status: "in_progress", instance_id: INSTANCE });
  const server = recordingFetch(({ url }) => {
    const params = paramsOf(url);
    // A strict server: only rows matching the query's instance scope.
    assert.equal(params.get("instance_id"), INSTANCE);
    const bucket = [foreign, own].filter(
      (item) => item.instance_id === INSTANCE && item.status === params.get("status"),
    );
    return jsonResponse({ items: bucket, total: bucket.length });
  });
  const result = await clientOn(server).getActiveTasks();
  assert.deepEqual(result, [own]);
});

for (const status of [401, 403]) {
  test(`getActiveTasks fails closed on ${status} instead of reporting no active work`, async () => {
    const client = createMemoryServerClient({
      baseUrl: "http://memory:8080",
      instanceId: INSTANCE,
      token: "rejected-token",
      fetch: async () => new Response("denied", { status }),
    });
    await assert.rejects(
      () => client.getActiveTasks(),
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

test("getActiveTasks fails closed on a late-page failure; the failure is not cached", async () => {
  let failures = 1;
  const inProgress = fillers(60);
  const { fetch, calls } = recordingFetch(({ url }) => {
    const params = paramsOf(url);
    if (failures > 0 && params.get("status") === "in_progress" && params.get("offset") === "50") {
      failures -= 1;
      return new Response("down", { status: 500 });
    }
    const bucket = params.get("status") === "in_progress" ? inProgress : [];
    const offset = Number(params.get("offset") ?? 0);
    return jsonResponse({ items: bucket.slice(offset, offset + 50), total: bucket.length });
  });
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    instanceId: INSTANCE,
    fetch,
  });
  await assert.rejects(
    () => client.getActiveTasks(),
    (error) => error instanceof PreflightHttpError && error.status === 500,
  );
  // Nothing was cached as success: the retry refetches from page 0.
  const active = await client.getActiveTasks();
  assert.equal(active.length, 60);
  assert.ok(calls.length > 4);
});

test("getActiveTasks fails closed on transport failures", async () => {
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    instanceId: INSTANCE,
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    () => client.getActiveTasks(),
    (error) => {
      assert.ok(error instanceof PreflightHttpError);
      assert.equal(error.status, null);
      return true;
    },
  );
});

test("getActiveTasks fails closed on a malformed page instead of treating it as empty", async () => {
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    instanceId: INSTANCE,
    fetch: async () => jsonResponse({ total: 5 }),
  });
  await assert.rejects(
    () => client.getActiveTasks(),
    (error) => {
      assert.ok(!(error instanceof PreflightHttpError));
      assert.match(error.message, /no items array/);
      return true;
    },
  );
});

test("getActiveTasks fails closed when a status exceeds the page bound", async () => {
  // 200 pages of full in_progress pages, no total, never exhausted.
  const { fetch, calls } = recordingFetch(() => jsonResponse({ items: fillers(50) }));
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    instanceId: INSTANCE,
    fetch,
  });
  await assert.rejects(
    () => client.getActiveTasks(),
    (error) => {
      assert.match(error.message, /exceeded 200 pages/);
      return true;
    },
  );
  assert.equal(calls.length, 200);
});

test("getActiveTasks sends the bearer token in the header, never the URL", async () => {
  const gate = task("a-1", { status: "in_progress" });
  const server = recordingFetch(() => jsonResponse({ items: [gate], total: 1 }));
  const client = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    instanceId: INSTANCE,
    token: "synthetic-secret",
    fetch: server.fetch,
  });
  await client.getActiveTasks();
  assert.equal(server.calls[0].init.headers.Authorization, "Bearer synthetic-secret");
  assert.ok(!server.calls[0].url.includes("synthetic-secret"));
});

test("getActiveTasks caches per run: repeat calls issue no requests", async () => {
  const server = statusServer([task("a-1", { status: "in_progress" })]);
  const client = clientOn(server);
  const first = await client.getActiveTasks();
  assert.equal(first.length, 1);
  const second = await client.getActiveTasks();
  assert.deepEqual(second, first);
  assert.equal(server.calls.length, 3);
});

test("the per-run state cache serves another client in the same run", async () => {
  const state = createRunState();
  const first = clientOn(statusServer([task("a-1", { status: "in_progress" })]), { state });
  await first.getActiveTasks();
  const secondServer = statusServer([task("a-1", { status: "in_progress" })]);
  const second = clientOn(secondServer, { state });
  const tasks = await second.getActiveTasks();
  assert.equal(tasks.length, 1);
  assert.equal(secondServer.calls.length, 0);
});

test("getActiveTasks does not disturb the getTasks/getCapacity run-state caches", async () => {
  const server = statusServer([task("a-1", { status: "in_progress" })]);
  const client = clientOn(server);
  await client.getActiveTasks();
  await client.getTasks();
  await client.getCapacity();
  // Five distinct fetches: three status scans plus the two listing
  // calls — the active-task fetch never seeds or reads their caches.
  assert.equal(server.calls.length, 5);
});

// --- the unattributed-including fetch (legacy task pickup) ---

test("includeUnattributed scans each active status globally and paginated", async () => {
  const tasks = [...fillers(50), ...fillers(10, 51), task("pr-open-1", { status: "pr_open" })];
  const server = statusServer(tasks);
  const active = await clientOn(server).getActiveTasks({ includeUnattributed: true });
  assert.equal(active.length, 61);
  // One full scan per status, in the canonical active-status order, the
  // 60 in_progress tasks needing two pages — and no instance_id
  // parameter anywhere: the attribution split is client-side.
  assert.deepEqual(
    server.calls.map((call) => call.url),
    [
      "http://memory:8080/api/tasks?status=in_progress&limit=50&offset=0",
      "http://memory:8080/api/tasks?status=in_progress&limit=50&offset=50",
      "http://memory:8080/api/tasks?status=pr_open&limit=50&offset=0",
      "http://memory:8080/api/tasks?status=pr_changes&limit=50&offset=0",
    ],
  );
});

test("includeUnattributed keeps own-instance and truly unassigned rows only", async () => {
  // A dumb server: the global bucket returns every in_progress row
  // regardless of attribution, so the client-side filter is the thing
  // under test.
  const rows = [
    task("own-1", { status: "in_progress", instance_id: INSTANCE }),
    task("missing-1", { status: "in_progress" }),
    task("null-1", { status: "in_progress", instance_id: null }),
    task("foreign-1", { status: "in_progress", instance_id: "somewhere-else" }),
    task("empty-1", { status: "in_progress", instance_id: "" }),
  ];
  const server = statusServer(rows);
  const active = await clientOn(server).getActiveTasks({ includeUnattributed: true });
  assert.deepEqual(active.map((item) => item.external_key).sort(), [
    "missing-1",
    "null-1",
    "own-1",
  ]);
  // An empty-string instance_id is not unassigned — it names something,
  // just not this instance, so it stays out like any foreign row.
  assert.equal(
    active.some((item) => item.external_key === "empty-1"),
    false,
  );
  assert.equal(
    active.some((item) => item.external_key === "foreign-1"),
    false,
  );
});

test("a status transition racing the scans collapses to one row per identity", async () => {
  // The task moved from in_progress to pr_open between the two
  // per-status scans, so a naive server shows it in both buckets.
  const racing = task("merge-violation:my-repo:1", { status: "in_progress", source_type: "jira" });
  const server = recordingFetch(({ url }) => {
    const status = paramsOf(url).get("status");
    const bucket = status === "pr_changes" ? [] : [racing];
    return jsonResponse({ items: bucket, total: bucket.length });
  });
  const active = await clientOn(server).getActiveTasks();
  assert.deepEqual(active, [racing]);
  // The same collapse applies to the unattributed-including fetch.
  const global = await clientOn(server, { state: undefined }).getActiveTasks({
    includeUnattributed: true,
  });
  assert.deepEqual(global, [racing]);
});

test("identity is (source_type, external_key): same key, two sources stay two rows", async () => {
  const jiraRow = task("merge-violation:my-repo:1", { status: "in_progress", source_type: "jira" });
  const ghRow = task("merge-violation:my-repo:1", { status: "in_progress", source_type: "github" });
  const server = statusServer([jiraRow, ghRow]);
  const active = await clientOn(server).getActiveTasks();
  assert.equal(active.length, 2);
  // Rows without a string external_key have no identity to compare and
  // are never collapsed.
  const keyless = statusServer([{ status: "in_progress" }, { status: "in_progress" }]);
  assert.equal((await clientOn(keyless).getActiveTasks()).length, 2);
});

test("includeUnattributed refuses to run without a configured instance too", async () => {
  const server = statusServer([task("a-1")]);
  await assert.rejects(
    () => clientOn(server, { instanceId: undefined }).getActiveTasks({ includeUnattributed: true }),
    /requires a configured instanceId/,
  );
  await assert.rejects(
    () => clientOn(server, { instanceId: "" }).getActiveTasks({ includeUnattributed: true }),
    /requires a configured instanceId/,
  );
  // The refusal happens before any request — the client-side
  // attribution filter has nothing to compare against without an
  // instance, so the fetch never runs.
  assert.equal(server.calls.length, 0);
});

for (const status of [401, 403]) {
  test(`includeUnattributed fails closed on ${status} instead of reporting no active work`, async () => {
    const client = createMemoryServerClient({
      baseUrl: "http://memory:8080",
      instanceId: INSTANCE,
      token: "rejected-token",
      fetch: async () => new Response("denied", { status }),
    });
    await assert.rejects(
      () => client.getActiveTasks({ includeUnattributed: true }),
      (error) => {
        assert.ok(error instanceof MemoryAuthRejectedError);
        assert.equal(error.status, status);
        return true;
      },
    );
  });
}

test("includeUnattributed fails closed on a malformed page and on the page bound", async () => {
  const malformed = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    instanceId: INSTANCE,
    fetch: async () => jsonResponse({ total: 5 }),
  });
  await assert.rejects(
    () => malformed.getActiveTasks({ includeUnattributed: true }),
    (error) => !(error instanceof PreflightHttpError) && /no items array/.test(error.message),
  );
  // 200 pages of full pages, no total, never exhausted.
  const unbounded = recordingFetch(() => jsonResponse({ items: fillers(50) }));
  const bounded = createMemoryServerClient({
    baseUrl: "http://memory:8080",
    instanceId: INSTANCE,
    fetch: unbounded.fetch,
  });
  await assert.rejects(
    () => bounded.getActiveTasks({ includeUnattributed: true }),
    (error) => /exceeded 200 pages/.test(error.message),
  );
  assert.equal(unbounded.calls.length, 200);
});

test("the two active-task scopes cache separately and never serve each other", async () => {
  const server = statusServer([task("a-1", { status: "in_progress" })]);
  const client = clientOn(server);
  await client.getActiveTasks();
  const instanceCalls = server.calls.length; // 3 status scans
  // The unattributed scope is a different fetch: it does not reuse the
  // instance-scoped scan's pages or result.
  await client.getActiveTasks({ includeUnattributed: true });
  const globalCalls = server.calls.length;
  assert.equal(globalCalls, instanceCalls + 3);
  // Both scopes are cached now — repeats issue nothing.
  await client.getActiveTasks();
  await client.getActiveTasks({ includeUnattributed: true });
  assert.equal(server.calls.length, globalCalls);
});

test("the unattributed scope is shared through the run state without contaminating the instance scope", async () => {
  const state = createRunState();
  const first = clientOn(statusServer([task("a-1", { status: "in_progress" })]), { state });
  await first.getActiveTasks({ includeUnattributed: true });
  // Another client in the same run: the unattributed scope is served
  // from the shared state, while the instance scope still fetches its
  // own scan — the scopes never read each other's cache.
  const instanceServer = statusServer([task("a-1", { status: "in_progress" })]);
  const second = clientOn(instanceServer, { state });
  await second.getActiveTasks({ includeUnattributed: true });
  assert.equal(instanceServer.calls.length, 0);
  await second.getActiveTasks();
  assert.equal(instanceServer.calls.length, 3);
});
