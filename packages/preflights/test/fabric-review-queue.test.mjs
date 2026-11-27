import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
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

/** Encode one review-ledger:v1 payload exactly like the Python publisher. */
const encodeLedger = (payload) =>
  deflateSync(Buffer.from(JSON.stringify(payload), "utf8")).toString("base64url");

/** A status-review body that decodes through the ported Python validator. */
const ledgerBody = ({
  updateCount = 1,
  findings = [],
  summary = "This PR fixes a permission.",
  pr = 1,
  headSha = head,
  baseSha = base,
  risk = null,
} = {}) => {
  const riskMarker = risk
    ? `\n<!-- dev-review-bot:risk-assessment:v1:${Buffer.from(
        JSON.stringify({ version: 1, ...risk }),
        "utf8",
      ).toString("base64url")} -->`
    : "";
  return (
    `## Review ${updateCount + 1}\n\n${summary}\n\n` +
    `<!-- dev-review-bot:fabric-access-review:${headSha}:${baseSha} -->\n` +
    `<!-- dev-review-bot:review-ledger:v1:${encodeLedger({
      version: 1,
      repo,
      pr,
      head_sha: headSha,
      base_sha: baseSha,
      update_count: updateCount,
      findings,
    })} -->${riskMarker}`
  );
};

function run({
  task,
  tasks,
  total,
  labelEvent = true,
  issueComments = [],
  refreshedComments,
  members = [],
  failPatch = false,
  failPost = false,
  memberError = false,
  memberStatuses = [],
  reviewBody = (number) => ledgerBody({ pr: number }),
  headSha = head,
  numbers = [1],
  labelEvents = {},
  commentsByNumber = {},
  pull = {},
} = {}) {
  const writes = [];
  const paths = [];
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
        paths.push(path);
        if (init?.method !== "GET") {
          writes.push({ path, method: init.method, body: init.body && JSON.parse(init.body) });
          if (failPatch && init.method === "PATCH") return new Response(null, { status: 403 });
          if (failPost && init.method === "POST" && path.endsWith("/comments"))
            return new Response(null, { status: 403 });
          return Response.json({});
        }
        if (path === "/user") return Response.json({ login: bot });
        if (path === `/repos/${repo}/issues`)
          return Response.json(numbers.map((number) => ({ number, pull_request: {} })));
        const pullMatch = new RegExp(`^/repos/${repo}/pulls/(\\d+)$`).exec(path);
        if (pullMatch) {
          const number = Number(pullMatch[1]);
          return Response.json({
            number,
            state: "open",
            draft: false,
            user: { login: "author" },
            head: { sha: headSha, ref: "fix/permission" },
            base: { sha: base },
            updated_at: time,
            merged_at: null,
            labels: [{ name: label }],
            title: `Fix a permission (${number})`,
            html_url: `https://github.com/${repo}/pull/${number}`,
            ...pull,
          });
        }
        if (path.endsWith("/events")) {
          const number = Number(path.split("/")[5]);
          return Response.json(
            (labelEvents[number] ?? labelEvent)
              ? [{ id: 2, event: "labeled", label: { name: label }, created_at: time }]
              : [],
          );
        }
        if (path.endsWith("/reviews/42"))
          return Response.json({
            id: 42,
            user: { login: bot },
            state: "COMMENTED",
            body: typeof reviewBody === "function" ? reviewBody(Number(path.split("/")[5])) : reviewBody,
          });
        if (path.startsWith("/orgs/org/members/"))
          return new Response(null, {
            status:
              memberStatuses[memberReads++] ??
              (memberError ? 503 : members.includes(path.split("/").pop()) ? 204 : 404),
          });
        if (path.endsWith("/labels/dev-bot-review-waiting-for-approval")) return Response.json({});
        const issueMatch = new RegExp(`^/repos/${repo}/issues/(\\d+)/comments$`).exec(path);
        if (issueMatch) {
          const number = Number(issueMatch[1]);
          if (commentsByNumber[number]) return Response.json(commentsByNumber[number]);
          return Response.json(
            issueReads++ > 0 ? (refreshedComments ?? issueComments) : issueComments,
          );
        }
        if (path.endsWith("/comments") || path.endsWith("/reviews")) return Response.json([]);
        throw new Error(`unexpected request: ${path}`);
      },
    },
  });
  return fabricReviewQueue
    .run(ctx, { review_label: label, bot_login: bot })
    .then((result) => ({ ...result, writes, memberReads, paths }));
}

const comment = (id, login, body, created, updated = created) => ({
  id,
  user: { login, type: "User" },
  body,
  created_at: created,
  updated_at: updated,
});

const tracked = {
  external_key: taskKey,
  source_type: "github",
  instance_id: instanceId,
  status: "in_progress",
  metadata: { review_id: 42, active_head_sha: head, active_base_sha: base },
};
const labelTracked = {
  ...tracked,
  status: "pr_open",
  metadata: {
    review_id: 42,
    last_reviewed_sha: "c".repeat(40),
    last_reviewed_base_sha: base,
    review_label_event_id: 1,
  },
};

test("a label-authorized tracked review sends only the sandbox restore reference", async () => {
  const result = await run({ task: labelTracked });
  assert.equal(result.status, "start");
  const { work } = JSON.parse(result.content);
  assert.equal(work.kind, "review");
  assert.equal(work.task_key, taskKey);
  // Python emits status_review_id only on command_reply work; restored starts
  // also carry it because the Fabric runner-restoration CLI is invoked with
  // work.status_review_id and validates it against the task's review_id.
  assert.equal(work.status_review_id, 42);
  assert.equal(work.ledger_restore, "runner");
  assert.equal(work.ledger_path, undefined);
  // The decoded ledger surfaces exactly what Python's restore emitted.
  assert.equal(work.update_count, 1);
  assert.equal(work.pr_summary, "This PR fixes a permission.");
  assert.equal(work.risk_assessment, undefined);
  assert.deepEqual(work.feedback_comment_ids, []);
  assert.ok(!result.content.includes(marker));
  assert.deepEqual(result.writes, []);
});

test("start content matches the Python reference field-for-field (fresh label review)", async () => {
  // Transcribed from the Python test_main_selects_one_github_pr_and_ignores_gitlab
  // scenario: one labeled GitHub PR, no task yet, a fresh label-add event. The
  // Python preflight would print json.dumps({"work": chosen, ...}) with exactly
  // these fields (priority popped, feedback_comment_ids defaulted to []).
  const result = await run();
  assert.equal(result.status, "start");
  const payload = JSON.parse(result.content);
  assert.deepEqual(payload, {
    work: {
      kind: "review",
      task_key: taskKey,
      task_exists: false,
      task_active: false,
      repo_key: "repo",
      repo,
      number: 1,
      title: "Fix a permission (1)",
      url: `https://github.com/${repo}/pull/1`,
      head_sha: head,
      base_sha: base,
      head_branch: "fix/permission",
      pr_author: "author",
      updated_at: time,
      review_label_event_id: 2,
      review_authorization: "label_added",
      feedback_comment_ids: [],
      update_count: 0,
    },
    discovery_errors: [],
  });
  // Key order follows the Python dict insertion order, so the serialized
  // object is byte-compatible modulo json.dumps' separator spaces.
  assert.deepEqual(Object.keys(payload.work), [
    "kind",
    "task_key",
    "task_exists",
    "task_active",
    "repo_key",
    "repo",
    "number",
    "title",
    "url",
    "head_sha",
    "base_sha",
    "head_branch",
    "pr_author",
    "updated_at",
    "review_label_event_id",
    "review_authorization",
    "feedback_comment_ids",
    "update_count",
  ]);
});

test("start content matches the Python reference (feedback check with restored ledger)", async () => {
  // Transcribed from the Python test_feedback_scan_fetches_each_comment_surface_once_...:
  // a pr_open task whose PR received one unseen human comment in the window.
  const result = await run({
    task: {
      ...tracked,
      status: "pr_open",
      metadata: {
        review_id: 42,
        last_reviewed_sha: head,
        last_reviewed_base_sha: base,
        last_seen_updated_at: "2026-11-23T10:00:00Z",
      },
    },
    labelEvent: false,
    issueComments: [
      comment(104, "alice", "The endpoint also needs pagination.", "2026-11-23T10:30:00Z"),
    ],
    members: ["alice"],
  });
  assert.equal(result.status, "start");
  const payload = JSON.parse(result.content);
  assert.deepEqual(payload, {
    work: {
      kind: "feedback_check",
      task_key: taskKey,
      task_exists: true,
      task_active: true,
      repo_key: "repo",
      repo,
      number: 1,
      title: "Fix a permission (1)",
      url: `https://github.com/${repo}/pull/1`,
      head_sha: head,
      base_sha: base,
      head_branch: "fix/permission",
      pr_author: "author",
      updated_at: time,
      feedback_comment_ids: ["issue:104"],
      ledger_restore: "runner",
      status_review_id: 42,
      update_count: 1,
      pr_summary: "This PR fixes a permission.",
    },
    discovery_errors: [],
  });
});

test("start content matches the Python reference (restored risk assessment)", async () => {
  const risk = {
    risk: "low",
    explanation: "The change is contained to one permission check.",
    evidence_files: ["policy.py"],
    head_sha: head,
    base_sha: base,
  };
  const result = await run({
    task: labelTracked,
    reviewBody: ledgerBody({ risk }),
  });
  assert.equal(result.status, "start");
  const { work } = JSON.parse(result.content);
  assert.deepEqual(work.risk_assessment, risk);
  assert.equal(work.update_count, 1);
});

test("start content matches the Python reference (contextual command reply)", async () => {
  // Python bot_command_requests entry shape: id, source, feedback_id, login,
  // created_at, url, request, too_long (action only for learning requests).
  const request = comment(
    105,
    "member",
    "/review-bot what does the timeout do?",
    "2026-11-23T10:30:00Z",
  );
  const result = await run({
    task: {
      ...tracked,
      status: "pr_open",
      metadata: {
        review_id: 42,
        last_reviewed_sha: head,
        last_reviewed_base_sha: base,
        last_seen_updated_at: "2026-11-23T10:00:00Z",
      },
    },
    issueComments: [request],
    members: ["member"],
  });
  assert.equal(result.status, "start");
  const payload = JSON.parse(result.content);
  assert.deepEqual(payload, {
    work: {
      kind: "command_reply",
      task_key: taskKey,
      task_exists: true,
      task_active: true,
      repo_key: "repo",
      repo,
      number: 1,
      title: "Fix a permission (1)",
      url: `https://github.com/${repo}/pull/1`,
      head_sha: head,
      base_sha: base,
      head_branch: "fix/permission",
      pr_author: "author",
      updated_at: time,
      command_requests: [
        {
          id: 105,
          source: "issue",
          feedback_id: "issue:105",
          login: "member",
          created_at: "2026-11-23T10:30:00Z",
          url: `https://github.com/${repo}/pull/1#issuecomment-105`,
          request: "what does the timeout do?",
          too_long: false,
        },
      ],
      feedback_comment_ids: ["issue:105"],
      task_status: "pr_open",
      status_review_id: 42,
    },
    discovery_errors: [],
  });
});

test("oversized and learning commands carry the Python request flags", async () => {
  const long = "x".repeat(4001);
  const requests = [
    comment(106, "member", "/review-bot learning-extraction", "2026-11-23T10:30:00Z"),
    comment(107, "member", `/review-bot ${long}`, "2026-11-23T10:31:00Z"),
  ];
  const result = await run({
    task: {
      ...tracked,
      status: "pr_open",
      metadata: {
        review_id: 42,
        last_reviewed_sha: head,
        last_reviewed_base_sha: base,
        last_seen_updated_at: "2026-11-23T10:00:00Z",
      },
    },
    issueComments: requests,
    members: ["member"],
  });
  assert.equal(result.status, "start");
  const { work } = JSON.parse(result.content);
  assert.equal(work.command_requests[0].action, "learning-extraction");
  assert.deepEqual(work.command_requests[1], {
    id: 107,
    source: "issue",
    feedback_id: "issue:107",
    login: "member",
    created_at: "2026-11-23T10:31:00Z",
    url: `https://github.com/${repo}/pull/1#issuecomment-107`,
    request: "",
    too_long: true,
  });
});

test("lifecycle work keeps the Python lifecycle_work field set", async () => {
  const done = {
    external_key: taskKey,
    source_type: "github",
    instance_id: instanceId,
    status: "done",
    metadata: {},
  };
  const merged = await run({ task: done, numbers: [], pull: { state: "closed", merged_at: time } });
  assert.equal(merged.status, "start");
  assert.deepEqual(JSON.parse(merged.content).work, {
    kind: "merge_complete",
    task_key: taskKey,
    task_exists: true,
    task_active: false,
    repo_key: "repo",
    repo,
    number: 1,
    title: "Fix a permission (1)",
    url: `https://github.com/${repo}/pull/1`,
    head_sha: head,
    base_sha: base,
    updated_at: time,
    merged_at: time,
  });
  const closed = await run({
    task: done,
    numbers: [],
    pull: { state: "closed", merged_at: null },
  });
  assert.equal(closed.status, "start");
  const closedWork = JSON.parse(closed.content).work;
  assert.equal(closedWork.kind, "closed_unmerged");
  assert.equal(closedWork.merged_at, undefined);
  assert.equal(closedWork.head_branch, undefined);
  const reconcile = await run({ task: done, numbers: [] });
  assert.equal(reconcile.status, "start");
  assert.deepEqual(JSON.parse(reconcile.content).work, {
    kind: "reconcile_open",
    task_key: taskKey,
    task_exists: true,
    task_active: false,
    repo_key: "repo",
    repo,
    number: 1,
    title: "Fix a permission (1)",
    url: `https://github.com/${repo}/pull/1`,
    head_sha: head,
    base_sha: base,
    updated_at: time,
  });
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
  const result = await run({ tasks: [...finished, labelTracked] });
  assert.equal(result.status, "start");
  assert.equal(JSON.parse(result.content).work.kind, "review");
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
const recoveryTask = { ...task, metadata: { ...task.metadata, review_label_event_id: 1 } };
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
  return `Approval is necessary but cannot start a review until revision continuity can be verified.\n${requestMarker(approval)}\n<!-- dev-review-bot:review-approval-context:v1:${digest} -->`;
};

test("new approval request uses revision-scoped ID and posts once", async () => {
  assert.equal(key, "RA-6becc4c6f8de"); // Same digest as Python's repo|number|head|base|trigger.
  const result = await run({ task, labelEvent: false });
  assert.equal(result.status, "skip");
  const requests = result.writes.filter((write) => write.path.endsWith("/comments"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.ok(requests[0].body.body.includes(requestMarker(key)));
  assert.doesNotMatch(requests[0].body.body, /approve and start/i);
  assert.match(requests[0].body.body, /continuity/i);
});

test("approval-authorized or unproven same-SHA resumes fail closed", async () => {
  for (const metadata of [
    tracked.metadata,
    { ...tracked.metadata, review_authorization: "organization_member_approved" },
    { ...tracked.metadata, review_authorization: "label_added", ledger_recovery_approved: true },
  ]) {
    const result = await run({ task: { ...tracked, metadata } });
    assert.equal(result.status, "error");
    assert.match(result.content, /revision continuity/);
  }
});

test("a pending review with unknown recovery provenance cannot bypass continuity", async () => {
  const pending = {
    repo,
    pr: 1,
    head_sha: head,
    base_sha: base,
    operation: "review",
    publication_body: marker,
  };
  const result = await run({
    task: { ...labelTracked, metadata: { ...labelTracked.metadata, pending_publication: pending } },
  });
  assert.equal(result.status, "error");
  assert.match(result.content, /revision continuity.*pending review/);
  assert.ok(!result.content.includes(marker));
});

test("a continuity-blocked candidate does not starve an independent fresh-label review", async () => {
  const second = {
    ...task,
    external_key: `review-only:github:${repo}#2`,
    metadata: { ...task.metadata, review_label_event_id: 1 },
  };
  const request = comment(10, bot, approvalBody(key), before);
  const yes = comment(11, "member", `Review bot: yes ${key}`, after);
  const result = await run({
    tasks: [task, second],
    numbers: [1, 2],
    labelEvents: { 1: false, 2: true },
    commentsByNumber: { 1: [request, yes], 2: [] },
    members: ["member"],
  });
  assert.equal(result.status, "start");
  const payload = JSON.parse(result.content);
  assert.equal(payload.work.number, 2);
  assert.equal(payload.work.review_authorization, "label_added");
  assert.ok(
    payload.discovery_errors.some(
      (error) => error.includes("#1") && error.includes("revision continuity"),
    ),
  );
  const blocked = await run({
    task,
    labelEvent: false,
    issueComments: [request, yes],
    members: ["member"],
  });
  assert.equal(blocked.status, "error");
  assert.match(blocked.content, /#1.*revision continuity/);
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
  assert.doesNotMatch(requests[0].body.body, /approve and start/i);
  assert.match(requests[0].body.body, /continuity/i);
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
  const outdatedCopy = {
    ...prior,
    body: approvalBody(key).replace(
      "Approval is necessary but cannot start a review until revision continuity can be verified.",
      "Approve and start the review.",
    ),
  };
  const answer = comment(11, "member", `Review bot: yes ${key}`, after);
  for (const request of [prior, legacy, outdatedCopy]) {
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

test("ledger recovery consent is rechecked and cannot bypass the continuity gate", async () => {
  const answer = comment(11, "member", `Review bot: yes ${recoveryId}`, after);
  const result = await run({
    task: recoveryTask,
    reviewBody: "legacy review without ledger",
    issueComments: [recoveryRequest, answer],
    members: ["member"],
  });
  assert.equal(result.status, "error");
  assert.match(result.content, /revision continuity/);
  assert.equal(result.memberReads, 2);
  const revoked = await run({
    task: recoveryTask,
    reviewBody: "legacy review without ledger",
    issueComments: [recoveryRequest, answer],
    memberStatuses: [204, 404],
  });
  assert.equal(revoked.status, "skip");
  assert.equal(revoked.memberReads, 2);
});

test("recovery consent cannot authorize a reused revision without continuity proof", async () => {
  const answer = comment(11, "member", `Review bot: yes ${recoveryId}`, after);
  const input = {
    task: recoveryTask,
    reviewBody: "legacy review without ledger",
    issueComments: [recoveryRequest, answer],
    members: ["member"],
  };
  let revision = head;
  const first = await run({ ...input, headSha: revision });
  revision = "d".repeat(40);
  assert.notEqual(revision, head);
  revision = head;
  const second = await run({ ...input, headSha: revision });
  for (const result of [first, second]) {
    assert.equal(result.status, "error");
    assert.match(result.content, /revision continuity/);
  }
  const waiting = await run({ ...input, issueComments: [] });
  const posted = waiting.writes.find((write) => write.path.endsWith("/comments"));
  assert.match(posted.body.body, /continuity/i);
});

test("later clean recovery consent supersedes earlier edited answers only when strictly later", async () => {
  const edited = comment(11, "member", `Review bot: no ${recoveryId}`, oldReplyAt, rebindAt);
  const input = {
    task: recoveryTask,
    reviewBody: "legacy review without ledger",
    members: ["member"],
  };
  const later = comment(12, "member", `Review bot: yes ${recoveryId}`, after);
  const result = await run({ ...input, issueComments: [recoveryRequest, edited, later] });
  assert.equal(result.status, "error");
  assert.match(result.content, /revision continuity/);
  assert.equal(result.memberReads, 2);
  for (const answer of [
    comment(12, "member", `Review bot: yes ${recoveryId}`, rebindAt),
    comment(12, "member", `Review bot: yes ${recoveryId}`, oldReplyAt),
    comment(12, "member", `Review bot: no ${recoveryId}`, after),
  ]) {
    assert.equal(
      (await run({ ...input, issueComments: [recoveryRequest, edited, answer] })).status,
      "skip",
    );
  }
});

test("Python skip and wait message formats are preserved", async () => {
  // A labeled draft PR with no task yields no candidate at all: the plain
  // Python no-work skip message.
  const quiet = await run({ labelEvent: false, pull: { draft: true } });
  assert.equal(quiet.status, "skip");
  assert.equal(quiet.content, "No labeled PR needs review or feedback handling");
  const waiting = await run({ task, labelEvent: false });
  assert.equal(waiting.status, "skip");
  assert.equal(
    waiting.content,
    `Waiting for organization-member review approvals on ${repo}#1 (waiting); ` +
      "No labeled PR needs review or feedback handling",
  );
  const request = comment(10, bot, approvalBody(key), before);
  const denied = comment(11, "member", `Review bot: no ${key}`, after);
  const declined = await run({
    task,
    labelEvent: false,
    issueComments: [request, denied],
    members: ["member"],
  });
  assert.equal(declined.status, "skip");
  assert.equal(
    declined.content,
    `Waiting for organization-member review approvals on ${repo}#1 (declined); ` +
      "No labeled PR needs review or feedback handling",
  );
});

test("capacity skip uses the Python message and counts only unexcluded active tasks", async () => {
  const activeTasks = Array.from({ length: 10 }, (_, i) => ({
    external_key: `review-only:github:${repo}#${i + 2}`,
    source_type: "github",
    instance_id: instanceId,
    status: "in_progress",
    metadata: { active_head_sha: head, active_base_sha: base },
  }));
  const atCapacity = await run({ tasks: activeTasks, numbers: [1], labelEvent: true });
  assert.equal(atCapacity.status, "skip");
  assert.equal(atCapacity.content, "Review instance at task capacity (10/10)");
  // A candidate excluded for an approval wait frees one capacity slot, like
  // Python's excluded_task_keys re-scan: #1 waits for approval, so the fresh
  // label-authorized review on #2 dispatches at the same raw active count.
  const withWait = await run({
    tasks: [
      ...Array.from({ length: 9 }, (_, i) => ({
        external_key: `review-only:github:${repo}#${i + 3}`,
        source_type: "github",
        instance_id: instanceId,
        status: "in_progress",
        metadata: { active_head_sha: head, active_base_sha: base },
      })),
      { ...task, external_key: `review-only:github:${repo}#1` },
    ],
    numbers: [1, 2],
    labelEvents: { 1: false, 2: true },
    commentsByNumber: { 1: [] },
  });
  assert.equal(withWait.status, "start");
  assert.equal(JSON.parse(withWait.content).work.number, 2);
});

test("GitHub contract: comment rebinding PATCHes the issue-comment endpoint and fails closed", async () => {
  const old = comment(10, bot, requestMarker(oldKey), before);
  const result = await run({ task, labelEvent: false, issueComments: [old], members: [] });
  assert.equal(result.status, "skip");
  const patch = result.writes.find((write) => write.method === "PATCH");
  assert.deepEqual(
    [patch.method, patch.path],
    ["PATCH", `/repos/${repo}/issues/comments/10`],
  );
  // The REST contract for editing a PR conversation comment: JSON body with
  // the single `body` field, on the issue-comments collection (never the
  // pulls review-comments endpoint).
  assert.deepEqual(Object.keys(patch.body), ["body"]);
  assert.equal(typeof patch.body.body, "string");
  assert.ok(!patch.path.includes("/pulls/"));

  const forbidden = await run({
    task,
    labelEvent: false,
    issueComments: [old],
    failPatch: true,
  });
  assert.equal(forbidden.status, "error");
  assert.match(forbidden.content, new RegExp(`${repo}#1: .*HTTP 403`));

  const unpostable = await run({ task, labelEvent: false, failPost: true });
  assert.equal(unpostable.status, "error");
  assert.match(unpostable.content, new RegExp(`${repo}#1: .*HTTP 403`));
});

test("GitHub contract: membership uses the org-member endpoint with 204/404 semantics", async () => {
  const request = comment(10, bot, approvalBody(key), before);
  const yes = comment(11, "member", `Review bot: yes ${key}`, after);
  const result = await run({
    task,
    labelEvent: false,
    issueComments: [request, yes],
    members: ["member"],
  });
  assert.ok(result.paths.includes("/orgs/org/members/member"));
  // The bot identity and PR reads ride the same proxied REST route.
  assert.ok(result.paths.includes("/user"));
  assert.ok(result.paths.includes(`/repos/${repo}/pulls/1`));
});

test("GitHub contract: no GraphQL timeline capability exists and consent cannot bypass it", async () => {
  // The revision-event (timeline) capability is deliberately absent: only
  // REST snapshots are available, and neither they nor label events prove
  // that head and base never changed and returned between polls. An approved
  // re-review on an unchanged head must therefore fail closed with an error,
  // never start, and the preflight must not attempt any /graphql call.
  const request = comment(10, bot, approvalBody(key), before);
  const yes = comment(11, "member", `Review bot: yes ${key}`, after);
  const result = await run({
    task,
    labelEvent: false,
    issueComments: [request, yes],
    members: ["member"],
  });
  assert.equal(result.status, "error");
  assert.match(result.content, /#1.*cannot verify revision continuity/);
  assert.ok(!result.paths.some((path) => path.includes("/graphql")));
});

test("a malformed status-review ledger fails closed instead of starting fresh", async () => {
  const brokenMarker = ledgerBody().replace(
    /(?<=dev-review-bot:review-ledger:v1:)[A-Za-z0-9_-]+(?= -->)/,
    "!!!",
  );
  const malformed = await run({ task: labelTracked, reviewBody: brokenMarker });
  assert.equal(malformed.status, "error");
  assert.match(malformed.content, /#1: Tracked review contains a malformed ledger payload marker/);

  const foreignPayload = await run({
    task: labelTracked,
    reviewBody: ledgerBody({ pr: 2 }),
  });
  assert.equal(foreignPayload.status, "error");
  assert.match(foreignPayload.content, /#1: Ledger payload belongs to another schema, repository, or PR/);

  const trailingJunk = await run({
    task: labelTracked,
    reviewBody: ledgerBody({
      updateCount: 1,
    }).replace(
      /(?<=dev-review-bot:review-ledger:v1:)[A-Za-z0-9_-]+(?= -->)/,
      Buffer.concat([
        deflateSync(Buffer.from(JSON.stringify({ version: 1, repo, pr: 1, head_sha: head, base_sha: base, update_count: 1, findings: [] }), "utf8")),
        Buffer.from([0x00]),
      ]).toString("base64url"),
    ),
  });
  assert.equal(trailingJunk.status, "error");
  assert.match(trailingJunk.content, /#1: Ledger payload compression is invalid/);

  const oversize = await run({
    task: labelTracked,
    reviewBody: ledgerBody().replace(
      /(?<=dev-review-bot:review-ledger:v1:)[A-Za-z0-9_-]+(?= -->)/,
      deflateSync(Buffer.alloc(1_100_000, 0x61)).toString("base64url"),
    ),
  });
  assert.equal(oversize.status, "error");
  assert.match(oversize.content, /#1: Decompressed ledger exceeds the safe size limit/);

  const brokenRisk = await run({
    task: labelTracked,
    reviewBody: `${ledgerBody()}\n<!-- dev-review-bot:risk-assessment:v1:!!! -->`,
  });
  assert.equal(brokenRisk.status, "error");
  assert.match(brokenRisk.content, /#1: Status review has a malformed risk-assessment marker/);
});

test("a verify start hands the tracked review to the runner for ledger restoration", async () => {
  const result = await run({
    task: {
      ...tracked,
      status: "pr_open",
      metadata: {
        review_id: 42,
        last_reviewed_sha: head,
        last_reviewed_base_sha: base,
        last_seen_updated_at: "2026-11-23T10:00:00Z",
      },
    },
    labelEvent: false,
    issueComments: [comment(30, "member", "/review-bot verify", "2026-11-23T10:30:00Z")],
    members: ["member"],
  });
  assert.equal(result.status, "start");
  const { work } = JSON.parse(result.content);
  assert.equal(work.kind, "verify");
  assert.deepEqual(work.verify_comment_ids, [30]);
  assert.deepEqual(work.feedback_comment_ids, []);
  assert.equal(work.ledger_restore, "runner");
  assert.equal(work.status_review_id, 42);
  assert.equal(work.update_count, 1);
  assert.equal(work.pr_summary, "This PR fixes a permission.");
});

test("a matching pending publication marks the restored start for the CLI retry path", async () => {
  const pendingBody = ledgerBody({ pr: 1, updateCount: 2 });
  const result = await run({
    task: pendingVerifyTask(pendingBody),
    reviewBody: pendingBody,
    labelEvent: false,
    issueComments: [comment(30, "member", "/review-bot verify", "2026-11-23T10:30:00Z")],
    members: ["member"],
  });
  assert.equal(result.status, "start");
  const { work } = JSON.parse(result.content);
  assert.equal(work.kind, "verify");
  assert.equal(work.ledger_restore, "runner");
  assert.equal(work.ledger_restore_pending, true);
  assert.equal(work.status_review_id, 42);
  assert.equal(work.update_count, 2);
});

// End-to-end hand-off: drive the vendored Fabric restore_review_ledger.py
// (the runner-side consumer of ledger_restore work) with the exact command
// its SKILL.md prescribes, built only from the emitted work fields.

/** A pr_open verify task with a full matching pending publication retry. */
const pendingVerifyTask = (pendingBody) => ({
  external_key: taskKey,
  source_type: "github",
  instance_id: instanceId,
  status: "pr_open",
  metadata: {
    review_id: 42,
    last_reviewed_sha: head,
    last_reviewed_base_sha: base,
    last_seen_updated_at: "2026-11-23T10:00:00Z",
    pending_publication: {
      repo,
      pr: 1,
      head_sha: head,
      base_sha: base,
      operation: "verify",
      publication_body: pendingBody,
      publication_json: { body: pendingBody },
      update_count: 2,
    },
  },
});

const restoreFixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fabric-restore-review-ledger",
);
const execFileAsync = promisify(execFile);
const python3Available = await execFileAsync("python3", ["--version"])
  .then(() => true)
  .catch(() => false);

/** Stub HOME/app/bot/memory_mcp plus a gh executable, like the Fabric test. */
async function restoreCliEnv(task, reviewBodyString) {
  const home = await mkdtemp(join(tmpdir(), "fabric-restore-"));
  const app = join(home, "app");
  await mkdir(join(app, "bot"), { recursive: true });
  await writeFile(join(app, "bot", "__init__.py"), "");
  await writeFile(
    join(app, "bot", "memory_mcp.py"),
    `import json\nTASK = json.loads(${JSON.stringify(JSON.stringify(task))})\n` +
      "def memory_call(tool, args):\n    return TASK\n\n\ndef memory_cleanup():\n    pass\n",
  );
  const responses = {
    [`repos/${repo}/pulls/1`]: { state: "open", head: { sha: head }, base: { sha: base } },
    [`repos/${repo}/pulls/1/reviews/42`]: {
      id: 42,
      state: "COMMENTED",
      user: { login: bot },
      body: reviewBodyString,
    },
    [`repos/${repo}/pulls/1/reviews/42/comments`]: [],
  };
  const bin = join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "gh"),
    "#!/usr/bin/env python3\nimport json, sys\n" +
      `RESPONSES = json.loads(${JSON.stringify(JSON.stringify(responses))})\n` +
      "print(json.dumps(RESPONSES[sys.argv[2]]))\n",
  );
  await chmod(join(bin, "gh"), 0o755);
  return {
    cwd: app,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      BOT_INSTANCE_ID: instanceId,
      GH_USER_NAME: bot,
    },
    // The CLI resolves its output path, which follows the macOS /var symlink.
    app: await realpath(app),
  };
}

/** The exact SKILL.md command, constructed only from the emitted work. */
function skillCommand(work, cliEnv) {
  const args = [
    join(restoreFixtures, "restore_review_ledger.py"),
    "--repo",
    work.repo,
    "--pr",
    String(work.number),
    "--head-sha",
    work.head_sha,
    "--base-sha",
    work.base_sha,
    "--review-id",
    String(work.status_review_id),
    "--task-key",
    work.task_key,
  ];
  if (work.ledger_restore_pending === true) args.push("--pending");
  return args;
}

test(
  "restored work drives the Fabric runner-restoration CLI end to end",
  { skip: python3Available ? false : "python3 is not available" },
  async () => {
    const body = ledgerBody({ pr: 1, updateCount: 1 });
    const result = await run({ task: labelTracked, reviewBody: body });
    assert.equal(result.status, "start");
    const { work } = JSON.parse(result.content);
    assert.equal(work.ledger_restore, "runner");
    assert.equal(work.status_review_id, 42);
    const cliEnv = await restoreCliEnv(labelTracked, body);
    const { stdout } = await execFileAsync("python3", skillCommand(work), cliEnv);
    const restored = JSON.parse(stdout);
    assert.deepEqual(Object.keys(restored).sort(), ["ledger_path", "source", "update_count"]);
    assert.equal(restored.source, "review");
    assert.equal(restored.update_count, 1);
    assert.ok(isAbsolute(restored.ledger_path));
    assert.ok(restored.ledger_path.startsWith(cliEnv.app));
    assert.deepEqual(JSON.parse(await readFile(restored.ledger_path, "utf8")), []);
  },
);

test(
  "pending-retry work drives the CLI with --pending and the pending body",
  { skip: python3Available ? false : "python3 is not available" },
  async () => {
    const body = ledgerBody({ pr: 1, updateCount: 2 });
    const result = await run({
      task: pendingVerifyTask(body),
      reviewBody: body,
      labelEvent: false,
      issueComments: [comment(30, "member", "/review-bot verify", "2026-11-23T10:30:00Z")],
      members: ["member"],
    });
    assert.equal(result.status, "start");
    const { work } = JSON.parse(result.content);
    assert.equal(work.ledger_restore_pending, true);
    const cliEnv = await restoreCliEnv(pendingVerifyTask(body), body);
    const { stdout } = await execFileAsync("python3", skillCommand(work), cliEnv);
    const restored = JSON.parse(stdout);
    assert.equal(restored.source, "pending");
    assert.equal(restored.update_count, 2);
    assert.deepEqual(JSON.parse(await readFile(restored.ledger_path, "utf8")), []);
  },
);

test(
  "the CLI rejects a stale status_review_id, proving the emitted reference must match the task",
  { skip: python3Available ? false : "python3 is not available" },
  async () => {
    const body = ledgerBody({ pr: 1, updateCount: 1 });
    const result = await run({ task: labelTracked, reviewBody: body });
    assert.equal(result.status, "start");
    const { work } = JSON.parse(result.content);
    const cliEnv = await restoreCliEnv(labelTracked, body);
    const command = skillCommand(work).map((value) =>
      value === String(work.status_review_id) ? String(work.status_review_id + 1) : value,
    );
    const failure = await execFileAsync("python3", command, cliEnv).then(
      () => undefined,
      (error) => error,
    );
    assert.ok(failure, "the CLI must fail closed on a mismatched review id");
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /Ledger restoration blocked/);
    await assert.rejects(stat(join(cliEnv.app, "data")));
  },
);
