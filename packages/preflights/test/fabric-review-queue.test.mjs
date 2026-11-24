import assert from "node:assert/strict";
import test from "node:test";
import { fabricReviewQueue } from "../dist/preflights/fabric-review-queue/index.js";
import { createPreflightRunContext } from "../dist/shared/run-context.js";

const head = "a".repeat(40);
const base = "b".repeat(40);
const repo = "org/repo";
const taskKey = `review-only:github:${repo}#1`;
const instanceId = "reviewer";
const label = "dev-bot-review";
const bot = "review-bot";
const time = "2026-11-23T12:00:00Z";
const marker = "<!-- dev-review-bot:review-ledger:v1:fixture -->";

function run({ task, tasks, total, labelEvent = true } = {}) {
  const writes = [];
  const allTasks = tasks ?? (task ? [task] : []);
  const ctx = createPreflightRunContext({
    instanceId,
    repos: { repo: { upstream: `https://github.com/${repo}.git` } },
    memory: {
      baseUrl: "https://memory.invalid",
      fetch: async (url) => {
        const offset = Number(new URL(url).searchParams.get("offset"));
        return Response.json({
          items: allTasks.slice(offset, offset + 50),
          total: total ?? allTasks.length,
        });
      },
    },
    proxy: {
      baseUrl: "https://gateway.invalid",
      fetch: async (url, init) => {
        const path = new URL(url).pathname.replace(/^\/github/, "");
        if (init?.method !== "GET") {
          writes.push(path);
          return Response.json({});
        }
        if (path === "/user") return Response.json({ login: bot });
        if (path === `/repos/${repo}/issues`)
          return Response.json([{ number: 1, pull_request: {} }]);
        if (path === `/repos/${repo}/pulls/1`) {
          return Response.json({
            number: 1,
            state: "open",
            draft: false,
            user: { login: "author" },
            head: { sha: head },
            base: { sha: base },
            updated_at: time,
            merged_at: null,
            labels: [{ name: label }],
          });
        }
        if (path.endsWith("/events")) {
          return Response.json(
            labelEvent
              ? [{ id: 2, event: "labeled", label: { name: label }, created_at: time }]
              : [],
          );
        }
        if (path.endsWith("/reviews/42"))
          return Response.json({ id: 42, user: { login: bot }, state: "COMMENTED", body: marker });
        if (path.endsWith("/labels/dev-bot-review-waiting-for-approval")) return Response.json({});
        if (path.endsWith("/comments") || path.endsWith("/reviews")) return Response.json([]);
        throw new Error(`unexpected request: ${path}`);
      },
    },
  });
  return fabricReviewQueue
    .run(ctx, { review_label: label, bot_login: bot })
    .then((result) => ({ ...result, writes }));
}

const tracked = {
  external_key: taskKey,
  source_type: "github",
  instance_id: instanceId,
  status: "in_progress",
  metadata: { review_id: 42, active_head_sha: head, active_base_sha: base },
};

test("resuming a tracked review sends only the sandbox restore reference", async () => {
  const result = await run({ task: tracked });
  assert.equal(result.status, "start");
  const { work } = JSON.parse(result.content);
  assert.equal(work.kind, "resume");
  assert.equal(work.task_key, taskKey);
  assert.equal(work.status_review_id, 42);
  assert.equal(work.ledger_restore, "runner");
  assert.equal(work.ledger_path, undefined);
  assert.ok(!result.content.includes(marker));
  assert.deepEqual(result.writes, []);
});

test("the instance scan finds tracked work behind a full first page", async () => {
  // The legacy lifecycle keeps done/archived rows for the same instance, so a
  // single capped page can hide the tracked review behind newer finished work.
  const finished = Array.from({ length: 50 }, (_, i) => ({
    external_key: `review-only:github:other/repo#${i}`,
    source_type: "github",
    instance_id: instanceId,
    status: "done",
  }));
  const result = await run({ tasks: [...finished, tracked] });
  assert.equal(result.status, "start");
  assert.equal(JSON.parse(result.content).work.kind, "resume");
});

test("only a fresh label event dispatches a new review without approval", async () => {
  const authorized = await run();
  assert.equal(authorized.status, "start");
  const { work } = JSON.parse(authorized.content);
  assert.equal(work.review_authorization, "label_added");
  assert.equal(work.ledger_restore, undefined);
  assert.equal((await run({ labelEvent: false })).status, "skip");
});

test("paused or archived work is not restarted and incomplete memory reads fail closed", async () => {
  for (const status of ["paused", "archived"]) {
    assert.equal((await run({ task: { ...tracked, status } })).status, "skip");
  }
  const incomplete = await run({ task: tracked, total: 2 });
  assert.equal(incomplete.status, "error");
  assert.deepEqual(incomplete.writes, []);
});
