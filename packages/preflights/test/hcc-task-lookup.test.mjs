import assert from "node:assert/strict";
import test from "node:test";
import { PreflightHttpError } from "../dist/shared/http.js";
import { createMemoryServerClient, MemoryAuthRejectedError } from "../dist/shared/memory-server.js";

const INSTANCE = "quality";
const SCOPED = { scopeByInstance: true };
const task = (external_key, extra = {}) => ({ external_key, ...extra });
const fillers = (count) => Array.from({ length: count }, (_, i) => task(`filler-${i}`));
const clientOn = (fetch, options) =>
  createMemoryServerClient({
    baseUrl: "http://memory:8080",
    instanceId: INSTANCE,
    fetch,
    ...options,
  });

const listing = (rows, intercept = () => undefined) => {
  const calls = [];
  const fetch = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    assert.equal(pathname, "/api/tasks");
    // Exact key/source matching is client-side; the listing must include archived rows.
    for (const key of ["exclude_status", "status", "external_key", "source_type"]) {
      assert.ok(!searchParams.has(key), `unexpected filter: ${key}`);
    }
    const offset = Number(searchParams.get("offset") ?? 0);
    const limit = Number(searchParams.get("limit") ?? 20);
    const instance = searchParams.get("instance_id");
    calls.push({ offset, instance });
    const override = intercept({ offset, init, url });
    if (override) return override;
    const scoped = instance === null ? rows : rows.filter((row) => row.instance_id === instance);
    return Response.json({ items: scoped.slice(offset, offset + limit), total: scoped.length });
  };
  return { calls, fetch };
};

test("exact lookup finds an archived gate beyond the first page and shares pages across keys and sources", async () => {
  const otherSource = task("gate", { source_type: "github" });
  const archived = task("gate", { status: "archived", source_type: "jira" });
  const later = task("later");
  const { calls, fetch } = listing([
    otherSource,
    task("gate-jira", { source_type: "jira" }),
    ...fillers(48),
    archived,
    ...fillers(49),
    later,
    ...fillers(49),
  ]);
  const client = clientOn(fetch);

  assert.deepEqual(await client.getTaskByKey("gate", { sourceType: "jira" }), archived);
  assert.deepEqual(
    calls.map(({ offset }) => offset),
    [0, 50],
  );
  assert.deepEqual(await client.getTaskByKey("gate"), otherSource);
  assert.deepEqual(await client.getTaskByKey("later"), later);
  assert.equal(await client.getTaskByKey("gate", { sourceType: "scheduled" }), undefined);
  // The final page is full: total is what establishes exhaustion.
  assert.deepEqual(
    calls.map(({ offset }) => offset),
    [0, 50, 100],
  );
});

test("global and instance lookups keep separate page caches even for the same key", async () => {
  const legacy = task("gate", { source_type: "jira", instance_id: null });
  const own = task("gate", { source_type: "scheduled", instance_id: INSTANCE });
  const foreign = task("foreign", { instance_id: "other" });
  const { calls, fetch } = listing([legacy, own, foreign], ({ init, url }) => {
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-secret");
    assert.ok(!url.includes("synthetic-secret"));
  });
  const client = clientOn(fetch, { token: "synthetic-secret" });

  assert.deepEqual(await client.getTaskByKey("gate"), legacy);
  assert.deepEqual(await client.getTaskByKey("gate", SCOPED), own);
  assert.equal(await client.getTaskByKey("foreign", SCOPED), undefined);
  assert.deepEqual(await client.getTaskByKey("foreign"), foreign);
  assert.deepEqual(
    calls.map(({ instance }) => instance),
    [null, INSTANCE],
  );

  const noInstance = clientOn(fetch, { token: "synthetic-secret", instanceId: undefined });
  assert.deepEqual(await noInstance.getTaskByKey("gate", SCOPED), legacy);
  assert.equal(calls.at(-1).instance, null);
});

test("concurrent lookups for different keys share an in-flight page", async () => {
  const a = task("a");
  const b = task("b");
  const { promise, resolve } = Promise.withResolvers();
  let calls = 0;
  const client = clientOn(async () => {
    calls += 1;
    await promise;
    return Response.json({ items: [a, b] });
  });
  const both = Promise.all([client.getTaskByKey("a"), client.getTaskByKey("b")]);
  resolve();
  assert.deepEqual(await both, [a, b]);
  assert.equal(calls, 1);
});

for (const [status, ErrorType] of [
  [403, MemoryAuthRejectedError],
  [500, PreflightHttpError],
]) {
  test(`late lookup page ${status} rejects instead of reporting absence, then retries`, async () => {
    const gate = task("gate");
    let failOnce = true;
    const { calls, fetch } = listing([...fillers(50), gate], ({ offset }) => {
      if (offset === 0 || !failOnce) return undefined;
      failOnce = false;
      return new Response(null, { status });
    });
    const client = clientOn(fetch);
    await assert.rejects(
      () => client.getTaskByKey("gate"),
      (error) => error instanceof ErrorType && error.status === status,
    );
    assert.deepEqual(await client.getTaskByKey("gate"), gate);
    assert.deepEqual(
      calls.map(({ offset }) => offset),
      [0, 50, 50],
    );
  });
}

for (const items of [[], [task("another-key")]]) {
  test(`lookup treats ${items.length ? "a short" : "an empty"} page without total as exhausted`, async () => {
    let calls = 0;
    const client = clientOn(async () => {
      calls += 1;
      assert.equal(calls, 1);
      return Response.json({ items });
    });
    assert.equal(await client.getTaskByKey("missing"), undefined);
  });
}

test("lookup rejects a malformed page rather than treating it as empty", async () => {
  const client = clientOn(async () => Response.json({ total: 5 }));
  await assert.rejects(() => client.getTaskByKey("gate"), /no items array/);
});

test("lookup rejects when pagination cannot establish absence within the page bound", async () => {
  const items = fillers(50);
  let pages = 0;
  const client = clientOn(async () => {
    pages += 1;
    assert.ok(pages <= 200, "page guard was bypassed");
    return Response.json({ items });
  });
  await assert.rejects(() => client.getTaskByKey("gate"), /exceeded 200 pages/);
  assert.equal(pages, 200);
});

test("lookup rejects invalid keys before fetching", async () => {
  const client = clientOn(async () => assert.fail("unexpected fetch"));
  await assert.rejects(() => client.getTaskByKey(""), /non-empty externalKey/);
  await assert.rejects(() => client.getTaskByKey(undefined), /non-empty externalKey/);
});
