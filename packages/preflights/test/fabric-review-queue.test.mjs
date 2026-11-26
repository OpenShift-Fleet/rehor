import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function run({
  task,
  tasks,
  total,
  labelEvent = true,
  issueComments = [],
  refreshedComments,
  members = [],
  failPatch = false,
  memberError = false,
  memberStatuses = [],
  reviewBody = marker,
  headSha = head,
} = {}) {
  const writes = [];
  let issueReads = 0;
  let memberReads = 0;
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
          writes.push({ path, method: init.method, body: init.body && JSON.parse(init.body) });
          if (failPatch && init.method === "PATCH") return new Response(null, { status: 403 });
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
            head: { sha: headSha },
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
          return Response.json({
            id: 42,
            user: { login: bot },
            state: "COMMENTED",
            body: reviewBody,
          });
        if (path.startsWith("/orgs/org/members/"))
          return new Response(null, {
            status:
              memberStatuses[memberReads++] ??
              (memberError ? 503 : members.includes(path.split("/").pop()) ? 204 : 404),
          });
        if (path.endsWith("/labels/dev-bot-review-waiting-for-approval")) return Response.json({});
        if (path === `/repos/${repo}/issues/1/comments`)
          return Response.json(
            issueReads++ > 0 ? (refreshedComments ?? issueComments) : issueComments,
          );
        if (path.endsWith("/comments") || path.endsWith("/reviews")) return Response.json([]);
        throw new Error(`unexpected request: ${path}`);
      },
    },
  });
  return fabricReviewQueue
    .run(ctx, { review_label: label, bot_login: bot })
    .then((result) => ({ ...result, writes, memberReads }));
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

const approvalId = (trigger = "revision") =>
  `RA-${createHash("sha256").update([repo, 1, head, base, trigger].join("|")).digest("hex").slice(0, 12)}`;
const requestMarker = (key) => `<!-- dev-review-bot:review-approval:${key} -->`;
const comment = (id, login, body, created, updated = created) => ({
  id,
  user: { login, type: "User" },
  body,
  created_at: created,
  updated_at: updated,
});
const before = "2026-11-23T09:00:00Z";
const oldReplyAt = "2026-11-23T09:30:00Z";
const rebindAt = "2026-11-23T10:00:00Z";
const after = "2026-11-23T11:00:00Z";
const key = approvalId();
const oldKey = "RA-123456789abc";
const task = {
  ...tracked,
  status: "pr_open",
  metadata: { review_id: 42, last_reviewed_sha: "c".repeat(40), last_reviewed_base_sha: base },
};
const approvalBody = (approval, reviewTask = task) => {
  const meta = reviewTask.metadata;
  const context = [
    true,
    reviewTask.status,
    ...[
      "last_reviewed_sha",
      "last_reviewed_base_sha",
      "last_reviewed_at",
      "active_head_sha",
      "active_base_sha",
      "review_id",
      "update_count",
    ].map((field) => meta[field] ?? null),
  ];
  const digest = createHash("sha256").update(JSON.stringify(context)).digest("hex").slice(0, 16);
  return `${requestMarker(approval)}\n<!-- dev-review-bot:review-approval-context:v1:${digest} -->`;
};

test("new approval request uses revision-scoped ID and posts once", async () => {
  assert.equal(key, "RA-6becc4c6f8de"); // Same digest as Python's repo|number|head|base|trigger.
  const result = await run({ task, labelEvent: false });
  assert.equal(result.status, "skip");
  const requests = result.writes.filter((write) => write.path.endsWith("/comments"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.ok(requests[0].body.body.includes(requestMarker(key)));
});

test("existing bot request is rebound with PATCH, never duplicated or immediately authorized", async () => {
  const old = comment(10, bot, requestMarker(oldKey), before);
  const stale = comment(11, "member", `Review bot: yes ${key}`, after);
  const result = await run({
    task,
    labelEvent: false,
    issueComments: [old, stale],
    members: ["member"],
  });
  assert.equal(result.status, "skip");
  const requests = result.writes.filter((write) => write.path.includes("/comments"));
  assert.deepEqual(
    requests.map(({ path, method }) => [path, method]),
    [[`/repos/${repo}/issues/comments/10`, "PATCH"]],
  );
  assert.ok(requests[0].body.body.includes(requestMarker(key)));
  assert.equal(
    (await run({ task, labelEvent: false, issueComments: [old], failPatch: true })).status,
    "error",
  );
});

test("approval after latest update must come from an organization member", async () => {
  const request = comment(10, bot, approvalBody(key), before, rebindAt);
  const oldAnswer = comment(11, "member", `Review bot: yes ${key}`, oldReplyAt);
  const sameSecond = comment(12, "member", `Review bot: yes ${key}`, rebindAt);
  const outsider = comment(13, "outsider", `Review bot: yes ${key}`, after);
  const baseInput = { task, labelEvent: false, members: ["member"] };
  for (const answer of [
    oldAnswer,
    { ...oldAnswer, updated_at: after },
    sameSecond,
    outsider,
    comment(14, "member", `Review bot: yes ${oldKey}`, after),
  ]) {
    const result = await run({ ...baseInput, issueComments: [request, answer] });
    assert.equal(result.status, "skip");
    assert.equal(
      result.writes.some((write) => write.path.includes("/comments")),
      false,
    );
  }
  const fresh = comment(15, "member", `Review bot: yes ${key}`, after);
  const result = await run({ ...baseInput, issueComments: [request, oldAnswer, fresh] });
  assert.equal(result.status, "error");
  assert.match(result.content, /revision continuity/);
  assert.equal(result.memberReads, 2);
  const declined = comment(16, "member", `Review bot: no ${key}`, after);
  assert.equal(
    (await run({ ...baseInput, issueComments: [request, fresh, declined] })).status,
    "skip",
  );
  assert.equal(
    (await run({ ...baseInput, issueComments: [request, fresh], memberError: true })).status,
    "error",
  );
});

test("repeated revision IDs and duplicate legacy requests cannot revive older answers", async () => {
  const rebound = comment(10, bot, approvalBody(key), before, rebindAt);
  const duplicate = comment(20, bot, approvalBody(key), before);
  const stale = comment(21, "member", `Review bot: yes ${key}`, oldReplyAt);
  const input = { task, labelEvent: false, members: ["member"] };
  assert.equal(
    (await run({ ...input, issueComments: [rebound, duplicate, stale] })).status,
    "skip",
  );
  const changed = { ...rebound, body: requestMarker(oldKey) };
  const result = await run({ ...input, issueComments: [changed, duplicate, stale] });
  assert.equal(result.status, "skip");
  assert.equal(result.writes.filter((write) => write.method === "PATCH").length, 1);
  assert.equal(
    result.writes.some((write) => write.method === "POST" && write.path.endsWith("/comments")),
    false,
  );
  // A later legacy duplicate may have represented the intervening revision.
  const original = comment(10, bot, approvalBody(key), before);
  const later = comment(20, bot, requestMarker(oldKey), rebindAt);
  const oldApproval = comment(21, "member", `Review bot: yes ${key}`, after);
  const ambiguous = await run({ ...input, issueComments: [original, later, oldApproval] });
  assert.equal(ambiguous.status, "skip");
  assert.equal(ambiguous.writes.filter((write) => write.method === "PATCH").length, 1);
  const missingTime = { ...rebound, updated_at: null };
  assert.equal((await run({ ...input, issueComments: [missingTime, stale] })).status, "error");
});

test("changed review history or legacy unbound requests invalidate old approvals", async () => {
  const oldTask = { ...task, metadata: { ...task.metadata, last_reviewed_sha: "d".repeat(40) } };
  const prior = comment(10, bot, approvalBody(key, oldTask), before);
  const legacy = { ...prior, body: requestMarker(key) };
  const answer = comment(11, "member", `Review bot: yes ${key}`, after);
  for (const request of [prior, legacy]) {
    const result = await run({
      task,
      labelEvent: false,
      issueComments: [request, answer],
      members: ["member"],
    });
    assert.equal(result.status, "skip");
    assert.equal(result.writes.filter((write) => write.method === "PATCH").length, 1);
  }
});

test("a request rebound during selection cannot use the cached approval", async () => {
  const request = comment(10, bot, approvalBody(key), before);
  const answer = comment(11, "member", `Review bot: yes ${key}`, after);
  for (const rebound of [
    { ...request, body: approvalBody(oldKey), updated_at: rebindAt },
    { ...request, updated_at: after },
  ]) {
    const result = await run({
      task,
      labelEvent: false,
      issueComments: [request, answer],
      refreshedComments: [rebound, answer],
      members: ["member"],
    });
    assert.equal(result.status, "skip");
    assert.equal(
      result.writes.some((write) => write.method === "PATCH"),
      false,
    );
  }
});

test("malformed issue comments cannot hide a request or a later decision", async () => {
  const request = comment(10, bot, approvalBody(key), before);
  const yes = comment(11, "member", `Review bot: yes ${key}`, oldReplyAt);
  const denial = comment(12, "member", `Review bot: no ${key}`, after);
  const laterRequest = comment(13, bot, approvalBody(oldKey), after);
  for (const bad of [
    { ...laterRequest, id: null },
    { ...laterRequest, created_at: null },
    { ...laterRequest, user: null },
    { ...denial, id: null },
    { ...denial, body: null },
    { ...denial, created_at: null },
    { ...denial, updated_at: null },
    { ...denial, user: { login: "member" } },
    { ...denial, id: yes.id },
  ]) {
    const result = await run({
      task,
      labelEvent: false,
      issueComments: [request, yes, bad],
      members: ["member"],
    });
    assert.equal(result.status, "error");
  }
  const refreshed = await run({
    task,
    labelEvent: false,
    issueComments: [request, yes],
    refreshedComments: [request, yes, { ...denial, id: null }],
    members: ["member"],
  });
  assert.equal(refreshed.status, "error");
  assert.doesNotMatch(refreshed.content, /revision continuity/);
});

test("latest ambiguous decision and edited decisions block earlier approval", async () => {
  const request = comment(10, bot, approvalBody(key), before);
  const yes = comment(11, "member", `Review bot: yes ${key}`, oldReplyAt);
  const ambiguous = comment(12, "member", `Review bot: yes ${key}\nReview bot: no ${key}`, after);
  const editedDenial = comment(9, "member", `Review bot: no ${key}`, before, after);
  const simultaneousDenial = comment(9, "member", `Review bot: no ${key}`, oldReplyAt);
  for (const decision of [ambiguous, editedDenial, simultaneousDenial]) {
    const result = await run({
      task,
      labelEvent: false,
      issueComments: [request, yes, decision],
      members: ["member"],
    });
    assert.equal(result.status, "skip");
    if (decision === ambiguous)
      assert.ok(
        result.writes.some((write) => write.method === "POST" && write.path.endsWith("/labels")),
      );
  }
});

test("final authorization rechecks membership rather than reusing scan cache", async () => {
  const request = comment(10, bot, approvalBody(key), before);
  const yes = comment(11, "member", `Review bot: yes ${key}`, after);
  const result = await run({
    task,
    labelEvent: false,
    issueComments: [request, yes],
    memberStatuses: [204, 404],
  });
  assert.equal(result.status, "skip");
  assert.equal(result.memberReads, 2);
  const unavailable = await run({
    task,
    labelEvent: false,
    issueComments: [request, yes],
    memberStatuses: [204, 503],
  });
  assert.equal(unavailable.status, "error");
  assert.doesNotMatch(unavailable.content, /revision continuity/);
});

test("reused revision without a durable event epoch cannot authorize dispatch", async () => {
  const request = comment(10, bot, approvalBody(key), before);
  const yes = comment(11, "member", `Review bot: yes ${key}`, after);
  const input = { task, labelEvent: false, issueComments: [request, yes], members: ["member"] };
  let revision = head;
  const first = await run({ ...input, headSha: revision });
  // No polling or tracking while the branch changes A -> B -> A.
  revision = "d".repeat(40);
  assert.notEqual(revision, head);
  revision = head;
  const second = await run({ ...input, headSha: revision });
  for (const result of [first, second]) {
    assert.equal(result.status, "error");
    assert.match(result.content, /revision continuity/i);
  }
});

test("explicit re-review IDs bind the approval to the request trigger", async () => {
  const rereview = comment(30, "member", "/review-bot re-review", after);
  const result = await run({
    task,
    labelEvent: false,
    issueComments: [rereview],
    members: ["member"],
  });
  assert.equal(result.status, "skip");
  const request = result.writes.find((write) => write.path.endsWith("/comments"));
  assert.ok(request.body.body.includes(requestMarker(approvalId("rereview:30"))));
  assert.ok(request.body.body.includes("A re-review was requested"));
});

test("ledger recovery retains its existing identity and restoration contract", async () => {
  const recoveryId = `LR-${createHash("sha256")
    .update([repo, 1, 42, "c".repeat(40), base, head, base].join("|"))
    .digest("hex")
    .slice(0, 12)}`;
  const recoveryRequest = comment(
    10,
    bot,
    `<!-- dev-review-bot:ledger-recovery:${recoveryId} -->`,
    before,
  );
  const answer = comment(11, "member", `Review bot: yes ${recoveryId}`, after);
  const result = await run({
    task: { ...task, metadata: { ...task.metadata, review_label_event_id: 1 } },
    reviewBody: "legacy review without ledger",
    issueComments: [recoveryRequest, answer],
    members: ["member"],
  });
  assert.equal(result.status, "start");
  const { work } = JSON.parse(result.content);
  assert.equal(work.ledger_recovery_approved, true);
  assert.equal(work.ledger_recovery_response_comment_id, 11);
  assert.equal(work.update_count, 0);
  assert.equal(work.ledger_restore, undefined);
  const revoked = await run({
    task: { ...task, metadata: { ...task.metadata, review_label_event_id: 1 } },
    reviewBody: "legacy review without ledger",
    issueComments: [recoveryRequest, answer],
    memberStatuses: [204, 404],
  });
  assert.equal(revoked.status, "skip");
  assert.equal(revoked.memberReads, 2);
});
