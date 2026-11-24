import assert from "node:assert/strict";
import test from "node:test";
import { PreflightHttpError } from "../dist/shared/http.js";
import { createMemoryServerClient, MemoryAuthRejectedError } from "../dist/shared/memory-server.js";
import { createRunState } from "../dist/shared/run-context.js";

const INSTANCE = "quality";
const UNATTRIBUTED = { includeUnattributed: true };
const task = (external_key, extra = {}) => ({
  external_key,
  status: "in_progress",
  instance_id: INSTANCE,
  ...extra,
});
const fillers = (count, extra) =>
  Array.from({ length: count }, (_, i) => task(`filler-${i}`, extra));
const clientOn = (fetch, options) =>
  createMemoryServerClient({
    baseUrl: "http://memory:8080",
    instanceId: INSTANCE,
    fetch,
    ...options,
  });

// Model the memory server's per-status, optional instance filter and paging.
const taskServer = (rows, intercept) => {
  const calls = [];
  const fetch = async (url) => {
    const { pathname, searchParams } = new URL(url);
    assert.equal(pathname, "/api/tasks");
    const statuses = searchParams.getAll("status");
    assert.equal(statuses.length, 1);
    const status = statuses[0];
    const instance = searchParams.get("instance_id");
    const limit = Number(searchParams.get("limit") ?? 20);
    const offset = Number(searchParams.get("offset") ?? 0);
    const call = { status, instance, offset };
    calls.push(call);
    const override = intercept?.(call);
    if (override) return override;
    const bucket = rows.filter(
      (row) => row.status === status && (instance === null || row.instance_id === instance),
    );
    return Response.json({ items: bucket.slice(offset, offset + limit), total: bucket.length });
  };
  return { calls, fetch };
};

for (const [scope, options] of [
  ["instance", undefined],
  ["includeUnattributed", UNATTRIBUTED],
]) {
  test(`${scope} scan pages all active statuses and excludes non-owned work`, async () => {
    const inProgress = fillers(55);
    const open = task("open", { status: "pr_open" });
    const changes = task("changes", { status: "pr_changes" });
    const missing = { external_key: "missing", status: "in_progress" };
    const unassigned = task("unassigned", { instance_id: null });
    const own = [...inProgress, open, changes];
    const { calls, fetch } = taskServer([
      ...fillers(55, { status: "done" }),
      task("paused", { status: "paused" }),
      task("foreign", { instance_id: "other" }),
      task("empty", { instance_id: "" }),
      ...own,
      missing,
      unassigned,
    ]);
    const expected = options ? [...own, missing, unassigned] : own;
    const active = await clientOn(fetch).getActiveTasks(options);

    assert.deepEqual(
      active.map((row) => row.external_key).sort(),
      expected.map((row) => row.external_key).sort(),
    );
    assert.deepEqual(
      new Set(calls.map(({ status }) => status)),
      new Set(["in_progress", "pr_open", "pr_changes"]),
    );
    assert.ok(calls.some(({ status, offset }) => status === "in_progress" && offset > 0));
    assert.deepEqual(
      new Set(calls.map(({ instance }) => instance)),
      new Set([options ? null : INSTANCE]),
    );
  });
}

test("both active-task scopes refuse to query without an instance", async () => {
  for (const instanceId of [undefined, ""]) {
    const client = clientOn(async () => assert.fail("unexpected fetch"), { instanceId });
    await assert.rejects(() => client.getActiveTasks(), /requires a configured instanceId/);
    await assert.rejects(
      () => client.getActiveTasks(UNATTRIBUTED),
      /requires a configured instanceId/,
    );
  }
});

test("status transitions dedupe by source and key, not by key alone", async () => {
  const jira = task("finding", { source_type: "jira" });
  const github = task("finding", { status: "pr_open", source_type: "github" });
  const transitioned = { ...jira, status: "pr_open" };
  const keyless = [
    { status: "pr_changes", instance_id: INSTANCE },
    { status: "pr_changes", instance_id: INSTANCE },
  ];
  const { fetch } = taskServer([jira, github, transitioned, ...keyless]);

  for (const options of [undefined, UNATTRIBUTED]) {
    const active = await clientOn(fetch).getActiveTasks(options);
    assert.equal(active.filter((row) => row.source_type === "jira").length, 1);
    assert.deepEqual(
      active.filter((row) => row.source_type === "github"),
      [github],
    );
    assert.equal(active.filter((row) => row.external_key === undefined).length, 2);
    assert.equal(active.length, 4);
  }
});

test("same-run clients reuse matching active scopes without mixing attributed and legacy rows", async () => {
  const state = createRunState();
  const own = task("own");
  const legacy = task("legacy", { instance_id: null });
  const { calls, fetch } = taskServer([own, legacy]);
  const first = clientOn(fetch, { state });
  const second = clientOn(fetch, { state });

  assert.deepEqual(await first.getActiveTasks(UNATTRIBUTED), [own, legacy]);
  const afterGlobal = calls.length;
  assert.deepEqual(await second.getActiveTasks(), [own]);
  assert.ok(calls.length > afterGlobal);
  const afterBoth = calls.length;
  assert.deepEqual(await second.getActiveTasks(UNATTRIBUTED), [own, legacy]);
  assert.deepEqual(await first.getActiveTasks(), [own]);
  assert.equal(calls.length, afterBoth);
});

test("a cached general task listing cannot stand in for an active status scan", async () => {
  const active = task("active");
  const done = task("done", { status: "done" });
  const paused = task("paused", { status: "paused" });
  const client = clientOn(
    async (url) => {
      const query = new URL(url).searchParams;
      const status = query.get("status");
      if (status !== null) {
        return Response.json({ items: status === "in_progress" ? [active] : [] });
      }
      // The newest-first general listing did not include the older active task.
      return Response.json({ items: [done, paused] });
    },
    { state: createRunState() },
  );

  assert.deepEqual(await client.getTasks(), [done, paused]);
  assert.deepEqual(await client.getActiveTasks(), [active]);
  assert.deepEqual(await client.getTasks(), [done, paused]);
});

for (const [status, options, ErrorType] of [
  [500, undefined, PreflightHttpError],
  [403, UNATTRIBUTED, MemoryAuthRejectedError],
]) {
  test(`late active-task page ${status} rejects partial results and permits retry`, async () => {
    const active = fillers(55);
    let failOnce = true;
    const { fetch } = taskServer(active, ({ offset }) => {
      if (offset === 0 || !failOnce) return undefined;
      failOnce = false;
      return new Response(null, { status });
    });
    const client = clientOn(fetch, { state: createRunState() });
    await assert.rejects(
      () => client.getActiveTasks(options),
      (error) => error instanceof ErrorType && error.status === status,
    );
    assert.deepEqual(await client.getActiveTasks(options), active);
  });
}

test("malformed and non-exhausting active scans do not report successful results", async () => {
  const malformed = clientOn(async () => Response.json({ total: 5 }));
  await assert.rejects(() => malformed.getActiveTasks(), /no items array/);

  const items = fillers(50);
  let pages = 0;
  const unbounded = clientOn(async () => {
    pages += 1;
    assert.ok(pages <= 200, "page guard was bypassed");
    return Response.json({ items });
  });
  await assert.rejects(() => unbounded.getActiveTasks(UNATTRIBUTED), /exceeded 200 pages/);
  assert.equal(pages, 200);
});
