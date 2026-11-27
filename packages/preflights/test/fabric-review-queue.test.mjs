import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
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
  review = null,
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
          return Response.json(
            review ?? {
              id: 42,
              user: { login: bot },
              state: "COMMENTED",
              body:
                typeof reviewBody === "function"
                  ? reviewBody(Number(path.split("/")[5]))
                  : reviewBody,
            },
          );
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

/**
 * Assert the exact reference the Fabric restore-review-ledger SKILL needs
 * from a `ledger_restore: "runner"` start: its CLI is invoked with
 * `--repo`, `--pr`, `--head-sha`, `--base-sha`, `--task-key`, and
 * `--review-id <work.status_review_id>` (appending `--pending` for
 * `ledger_restore_pending`), and it rejects a review id that does not match
 * the task's tracked `metadata.review_id`. Fabric's own
 * `restore_review_ledger` tests cover the consumer side.
 */
const assertRestoreReference = (work, { reviewId, pending = false }) => {
  assert.equal(work.ledger_restore, "runner");
  assert.equal(work.status_review_id, reviewId);
  assert.ok(Number.isSafeInteger(work.status_review_id) && work.status_review_id > 0);
  assert.equal(work.task_key, `review-only:github:${work.repo}#${work.number}`);
  assert.match(work.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(Number.isSafeInteger(work.number) && work.number > 0);
  assert.match(work.head_sha, /^[0-9a-f]{40}$/);
  assert.match(work.base_sha, /^[0-9a-f]{40}$/);
  assert.equal(work.ledger_restore_pending, pending === true ? true : undefined);
  assert.equal(work.ledger_path, undefined);
};

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
  assertRestoreReference(work, { reviewId: 42 });
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
  assertRestoreReference(payload.work, { reviewId: 42 });
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

test("new approval request uses revision-scoped ID and posts once with the Python copy", async () => {
  assert.equal(key, "RA-6becc4c6f8de"); // Same digest as Python's repo|number|head|base|trigger.
  const result = await run({ task, labelEvent: false });
  assert.equal(result.status, "skip");
  const requests = result.writes.filter((write) => write.path.endsWith("/comments"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  const body = requests[0].body.body;
  assert.ok(body.includes(requestMarker(key)));
  // Python _approval_request_body copy, verbatim.
  assert.ok(
    body.includes("No review will run until an organization member approves this exact revision."),
  );
  assert.ok(body.includes(`\`Review bot: yes ${key}\` — approve and start the review.`));
  assert.ok(body.includes(`\`Review bot: no ${key}\` — decline the review.`));
  // Python with_footer copy: the approval step plus the standing steps.
  assert.ok(
    body.includes(
      `- Approve with \`Review bot: yes ${key}\` or decline with \`Review bot: no ${key}\`.`,
    ),
  );
  assert.ok(body.includes("**Status Comment:** Pending the first review."));
  assert.ok(
    body.includes(
      "- Comment `/review-bot learning-extraction` to ask for reusable lessons from this PR.",
    ),
  );
  assert.ok(!body.includes("continuity"));
  assert.ok(!body.includes("review-approval-context"));
});

test("a member-approved re-review starts with the Python authorization fields", async () => {
  const request = comment(10, bot, requestMarker(key), before);
  const yes = comment(11, "member", `Review bot: yes ${key}`, after);
  const result = await run({
    task,
    labelEvent: false,
    issueComments: [request, yes],
    members: ["member"],
  });
  assert.equal(result.status, "start");
  const payload = JSON.parse(result.content);
  assert.deepEqual(payload.discovery_errors, []);
  const { work } = payload;
  assert.equal(work.kind, "review");
  assert.equal(work.review_authorization, "organization_member_approved");
  assert.equal(work.review_approval_id, key);
  assert.equal(work.review_approval_response_comment_id, 11);
  assert.equal(work.review_approval_responder, "member");
  assert.equal(work.ledger_restore, "runner");
  assert.equal(work.status_review_id, 42);
  assert.equal(work.update_count, 1);
  assert.equal(work.pr_summary, "This PR fixes a permission.");
  // The approving reply is in-window human feedback, exactly like Python.
  assert.deepEqual(work.feedback_comment_ids, ["issue:11"]);
  // Python removes the waiting label once a member decision exists.
  assert.ok(
    result.writes.some((write) => write.method === "DELETE" && write.path.includes("/labels/")),
  );
  assert.equal(result.memberReads, 1);
});

test("a same-SHA resume restores the tracked ledger and starts", async () => {
  const result = await run({ task: tracked });
  assert.equal(result.status, "start");
  const { work } = JSON.parse(result.content);
  assert.equal(work.kind, "resume");
  assert.equal(work.review_authorization, undefined);
  assert.equal(work.review_approval_id, undefined);
  assert.equal(work.ledger_restore, "runner");
  assert.equal(work.status_review_id, 42);
  assert.equal(work.update_count, 1);
  assert.equal(work.pr_summary, "This PR fixes a permission.");
  assert.deepEqual(work.feedback_comment_ids, []);
  assert.deepEqual(result.writes, []);
});

test("a matching pending review publication reaches the start hand-off", async () => {
  const pendingBody = ledgerBody({ pr: 1, updateCount: 2 });
  const pending = {
    repo,
    pr: 1,
    head_sha: head,
    base_sha: base,
    operation: "review",
    publication_body: pendingBody,
    publication_json: { body: pendingBody },
    update_count: 2,
  };
  const submitted = await run({
    task: { ...labelTracked, metadata: { ...labelTracked.metadata, pending_publication: pending } },
  });
  assert.equal(submitted.status, "start");
  const { work } = JSON.parse(submitted.content);
  assert.equal(work.kind, "review");
  assert.equal(work.ledger_restore, "runner");
  assert.equal(work.ledger_restore_pending, true);
  assert.equal(work.status_review_id, 42);
  assert.equal(work.update_count, 1);

  // An interrupted publication: the tracked review is an empty pending draft
  // for this head, and the saved body restores the ledger (Python's
  // EmptyPendingReview upgrade path with a matching pending publication).
  const interrupted = await run({
    task: { ...tracked, metadata: { ...tracked.metadata, pending_publication: pending } },
    review: {
      id: 42,
      user: { login: bot },
      state: "PENDING",
      body: "",
      commit_id: head,
    },
    labelEvent: false,
  });
  assert.equal(interrupted.status, "start");
  const resumed = JSON.parse(interrupted.content).work;
  assert.equal(resumed.kind, "resume");
  assert.equal(resumed.ledger_restore, "runner");
  assert.equal(resumed.ledger_restore_pending, true);
  assert.equal(resumed.status_review_id, 42);
  assert.equal(resumed.update_count, 2);
  assert.equal(resumed.ignore_review_id, undefined);
});

test("a stale pending publication is skipped, never an error", async () => {
  const stale = {
    repo,
    pr: 1,
    head_sha: "d".repeat(40),
    base_sha: base,
    operation: "review",
    publication_body: ledgerBody({ pr: 1, headSha: "d".repeat(40), updateCount: 3 }),
  };
  // With a decodable tracked review the stale pending is simply unused.
  const restored = await run({
    task: { ...labelTracked, metadata: { ...labelTracked.metadata, pending_publication: stale } },
  });
  assert.equal(restored.status, "start");
  const { work } = JSON.parse(restored.content);
  assert.equal(work.ledger_restore_pending, undefined);
  assert.equal(work.update_count, 1);
  // Without one, Python falls through to ledger-recovery consent. A
  // feedback-check task skips the review-approval step and reaches recovery
  // directly, like Python's main() ordering.
  const feedbackTask = {
    ...tracked,
    status: "pr_open",
    metadata: {
      review_id: 42,
      last_reviewed_sha: head,
      last_reviewed_base_sha: base,
      last_seen_updated_at: "2026-11-23T10:00:00Z",
    },
  };
  const waiting = await run({
    task: { ...feedbackTask, metadata: { ...feedbackTask.metadata, pending_publication: stale } },
    reviewBody: "legacy review without ledger",
    labelEvent: false,
    issueComments: [comment(12, "member", "The history should restart.", "2026-11-23T10:30:00Z")],
    members: ["member"],
  });
  assert.equal(waiting.status, "skip");
  assert.match(
    waiting.content,
    /Waiting for organization-member ledger-recovery decisions on org\/repo#1/,
  );
});

test("a waiting approval does not starve an independent fresh-label review", async () => {
  const second = {
    ...task,
    external_key: `review-only:github:${repo}#2`,
    metadata: { ...task.metadata, review_label_event_id: 1 },
  };
  const request = comment(10, bot, requestMarker(key), before);
  const result = await run({
    tasks: [task, second],
    numbers: [1, 2],
    labelEvents: { 1: false, 2: true },
    commentsByNumber: { 1: [request], 2: [] },
    members: [],
  });
  assert.equal(result.status, "start");
  const payload = JSON.parse(result.content);
  assert.equal(payload.work.number, 2);
  assert.equal(payload.work.review_authorization, "label_added");
  assert.deepEqual(payload.discovery_errors, []);
  const blocked = await run({
    task,
    labelEvent: false,
    issueComments: [request],
    members: [],
  });
  assert.equal(blocked.status, "skip");
  assert.equal(
    blocked.content,
    `Waiting for organization-member review approvals on ${repo}#1 (waiting); ` +
      "No labeled PR needs review or feedback handling",
  );
});

test("existing bot request is rebound with PATCH, never duplicated", async () => {
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
  assert.ok(requests[0].body.body.includes("approve and start the review"));
  assert.ok(!requests[0].body.body.includes("continuity"));
  assert.equal(
    (await run({ task, labelEvent: false, issueComments: [old], failPatch: true })).status,
    "error",
  );
});

test("approval decisions require a strictly later organization-member reply", async () => {
  const request = comment(10, bot, requestMarker(key), before);
  const baseInput = { task, labelEvent: false, members: ["member"] };
  // Python ignores replies that are not strictly later than the request's
  // (created, id) tuple, carry more than one decision, quote another id, or
  // come from a non-member: each leaves the approval waiting.
  for (const answer of [
    comment(11, "member", `Review bot: yes ${key}`, "2026-11-23T08:00:00Z"), // before request
    comment(9, "member", `Review bot: yes ${key}`, before), // same second, lower id
    comment(11, "outsider", `Review bot: yes ${key}`, after), // non-member
    comment(11, "member", `Review bot: yes ${oldKey}`, after), // other id
    comment(11, "member", `Review bot: yes ${key}\nReview bot: no ${key}`, after), // two decisions
    comment(11, bot, `Review bot: yes ${key}`, after), // the bot itself
  ]) {
    const result = await run({ ...baseInput, issueComments: [request, answer] });
    assert.equal(result.status, "skip");
    assert.match(result.content, /\(waiting\)/);
    assert.equal(
      result.writes.some((write) => write.path.includes("/comments")),
      false,
    );
  }
  const fresh = comment(15, "member", `Review bot: yes ${key}`, after);
  const result = await run({ ...baseInput, issueComments: [request, fresh] });
  assert.equal(result.status, "start");
  assert.equal(
    JSON.parse(result.content).work.review_authorization,
    "organization_member_approved",
  );
  assert.equal(result.memberReads, 1);
  const declined = comment(16, "member", `Review bot: no ${key}`, after);
  assert.equal(
    (await run({ ...baseInput, issueComments: [request, fresh, declined] })).status,
    "skip",
  );
  // A membership-verification failure is a per-PR wait, not a run error
  // (Python returns verification_unavailable and keeps scanning).
  const unavailable = await run({
    task,
    labelEvent: false,
    issueComments: [request, fresh],
    members: ["member"],
    memberError: true,
  });
  assert.equal(unavailable.status, "skip");
  assert.match(unavailable.content, /\(verification_unavailable\)/);
  // The wait is not a decision: a later healthy cycle reaches the member
  // decision and starts.
  const retry = await run({ ...baseInput, issueComments: [request, fresh] });
  assert.equal(retry.status, "start");
});

test("duplicate legacy requests keep the earliest matching request authoritative", async () => {
  const request = comment(10, bot, requestMarker(key), before);
  const duplicate = comment(20, bot, requestMarker(key), rebindAt);
  const answer = comment(21, "member", `Review bot: yes ${key}`, after);
  const input = { task, labelEvent: false, members: ["member"] };
  // Python uses the earliest matching request and tolerates later duplicates.
  const result = await run({ ...input, issueComments: [request, duplicate, answer] });
  assert.equal(result.status, "start");
  assert.equal(result.writes.filter((write) => write.method === "PATCH").length, 0);
  // No matching request at all: the earliest legacy request is rebound once.
  const old = comment(10, bot, requestMarker(oldKey), before);
  const later = comment(20, bot, requestMarker(oldKey), rebindAt);
  const rebound = await run({ ...input, issueComments: [old, later, answer] });
  assert.equal(rebound.status, "skip");
  assert.equal(rebound.writes.filter((write) => write.method === "PATCH").length, 1);
  assert.equal(
    rebound.writes.some((write) => write.method === "POST" && write.path.endsWith("/comments")),
    false,
  );
});

test("legacy marker-only requests and changed task state authorize Python-style", async () => {
  // Python binds an approval only to repo, number, head, base, and the
  // rereview trigger — not to the task's review history. A marker-only
  // request for the current id stays authoritative even when the task's
  // history moved on, and an old yes reply remains valid. This is the
  // documented reused-approval ABA surface (see the README).
  const priorTask = { ...task, metadata: { ...task.metadata, last_reviewed_sha: "d".repeat(40) } };
  const request = comment(10, bot, requestMarker(key), before);
  const answer = comment(11, "member", `Review bot: yes ${key}`, after);
  const result = await run({
    task: priorTask,
    labelEvent: false,
    issueComments: [request, answer],
    members: ["member"],
  });
  assert.equal(result.status, "start");
  const { work } = JSON.parse(result.content);
  assert.equal(work.review_authorization, "organization_member_approved");
  assert.equal(work.review_approval_response_comment_id, 11);
});

test("malformed issue comments cannot hide a request or a later decision", async () => {
  const request = comment(10, bot, requestMarker(key), before);
  const yes = comment(11, "member", `Review bot: yes ${key}`, oldReplyAt);
  const denial = comment(12, "member", `Review bot: no ${key}`, after);
  const laterRequest = comment(13, bot, requestMarker(oldKey), after);
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
});

test("the latest single-decision member reply wins, edits are invisible", async () => {
  // Python never inspects updated_at on replies: an edited answer still
  // counts, and a comment with both decisions is skipped, not blocking.
  const request = comment(10, bot, requestMarker(key), before);
  const yes = comment(11, "member", `Review bot: yes ${key}`, oldReplyAt);
  const ambiguous = comment(12, "member", `Review bot: yes ${key}\nReview bot: no ${key}`, after);
  const editedDenialBefore = comment(9, "member", `Review bot: no ${key}`, before, after);
  const simultaneousDenial = comment(9, "member", `Review bot: no ${key}`, oldReplyAt);
  const input = { task, labelEvent: false, members: ["member"] };
  const editedYes = comment(11, "member", `Review bot: yes ${key}`, oldReplyAt, after);
  for (const decision of [
    ambiguous, // skipped, not blocking: the earlier yes still wins
    editedDenialBefore, // created before the request: ignored, edits or not
    simultaneousDenial, // same second as yes, lower id: yes wins
  ]) {
    const result = await run({ ...input, issueComments: [request, yes, decision] });
    assert.equal(result.status, "start");
    assert.equal(
      JSON.parse(result.content).work.review_authorization,
      "organization_member_approved",
    );
  }
  // A reply edited after the fact still counts (Python never reads updated_at).
  const edited = await run({ ...input, issueComments: [request, editedYes] });
  assert.equal(edited.status, "start");
  // A later clean denial supersedes the earlier approval.
  const denied = await run({
    ...input,
    issueComments: [request, yes, comment(12, "member", `Review bot: no ${key}`, after)],
  });
  assert.equal(denied.status, "skip");
  assert.match(denied.content, /\(declined\)/);
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

test("ledger recovery consent starts a fresh review with reset history", async () => {
  const answer = comment(11, "member", `Review bot: yes ${recoveryId}`, after);
  const result = await run({
    task: recoveryTask,
    reviewBody: "legacy review without ledger",
    issueComments: [recoveryRequest, answer],
    members: ["member"],
  });
  assert.equal(result.status, "start");
  const { work } = JSON.parse(result.content);
  assert.equal(work.kind, "review");
  // The fresh label event authorized this review; recovery consent only
  // reset its history (Python keeps review_authorization untouched here).
  assert.equal(work.review_authorization, "label_added");
  assert.equal(work.update_count, 0);
  assert.equal(work.ledger_restore, undefined);
  assert.equal(work.ledger_recovery_approved, true);
  assert.equal(work.ledger_recovery_response_comment_id, 11);
  assert.equal(work.ledger_recovery_responder, "member");
  // The consenting reply itself is filtered out of the feedback ids.
  assert.deepEqual(work.feedback_comment_ids, []);
  assert.equal(result.memberReads, 1);
  const declined = await run({
    task: recoveryTask,
    reviewBody: "legacy review without ledger",
    issueComments: [recoveryRequest, comment(12, "member", `Review bot: no ${recoveryId}`, after)],
    members: ["member"],
  });
  assert.equal(declined.status, "skip");
  assert.match(
    declined.content,
    /Waiting for organization-member ledger-recovery decisions on org\/repo#1/,
  );
});

test("recovery consent waits and posts the Python request copy", async () => {
  const waiting = await run({
    task: recoveryTask,
    reviewBody: "legacy review without ledger",
    issueComments: [],
  });
  assert.equal(waiting.status, "skip");
  const posted = waiting.writes.find((write) => write.path.endsWith("/comments"));
  const body = posted.body.body;
  assert.ok(body.includes(`<!-- dev-review-bot:ledger-recovery:${recoveryId} -->`));
  // Python _request_ledger_recovery copy, verbatim.
  assert.ok(body.includes(`**Review history needs recovery (${recoveryId}).**`));
  assert.ok(body.includes("Should a fresh re-review run?"));
  assert.ok(body.includes("anywhere in their comment."));
  // Python with_footer recovery step.
  assert.ok(
    body.includes(
      `- Approve a fresh review with \`Review bot: yes ${recoveryId}\` or decline with \`Review bot: no ${recoveryId}\`.`,
    ),
  );
  assert.ok(!body.includes("continuity"));
});

test("recovery consent follows the Python reply rules on reuse and recency", async () => {
  const answer = comment(11, "member", `Review bot: yes ${recoveryId}`, after);
  const input = {
    task: recoveryTask,
    reviewBody: "legacy review without ledger",
    issueComments: [recoveryRequest, answer],
    members: ["member"],
  };
  // Python reuses a still-matching recovery request after an A→B→A head
  // cycle — the documented legacy parity, not a stronger guarantee.
  let revision = head;
  const first = await run({ ...input, headSha: revision });
  revision = "d".repeat(40);
  assert.notEqual(revision, head);
  revision = head;
  const second = await run({ ...input, headSha: revision });
  for (const result of [first, second]) {
    assert.equal(result.status, "start");
    assert.equal(JSON.parse(result.content).work.ledger_recovery_approved, true);
  }
});

test("the latest recovery reply wins and edits are invisible, like Python", async () => {
  const edited = comment(11, "member", `Review bot: no ${recoveryId}`, oldReplyAt, rebindAt);
  const input = {
    task: recoveryTask,
    reviewBody: "legacy review without ledger",
    members: ["member"],
  };
  const later = comment(12, "member", `Review bot: yes ${recoveryId}`, after);
  const result = await run({ ...input, issueComments: [recoveryRequest, edited, later] });
  assert.equal(result.status, "start");
  assert.equal(JSON.parse(result.content).work.ledger_recovery_approved, true);
  // Same second: the higher comment id wins, as Python's max((created, id)).
  const tie = comment(12, "member", `Review bot: yes ${recoveryId}`, oldReplyAt);
  const tied = await run({ ...input, issueComments: [recoveryRequest, edited, tie] });
  assert.equal(tied.status, "start");
  for (const answer of [comment(12, "member", `Review bot: no ${recoveryId}`, after)]) {
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
  const request = comment(10, bot, requestMarker(key), before);
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
  assert.deepEqual([patch.method, patch.path], ["PATCH", `/repos/${repo}/issues/comments/10`]);
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
  const request = comment(10, bot, requestMarker(key), before);
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

test("GitHub contract: REST-only evidence still starts approved work, no GraphQL exists", async () => {
  // Mirroring Python means an approved re-review dispatches on REST evidence
  // alone: snapshots, comments, and label events. That is the documented
  // reused-approval/reused-head ABA surface (see the README), not a stronger
  // guarantee — and the preflight never attempts any /graphql call.
  const request = comment(10, bot, requestMarker(key), before);
  const yes = comment(11, "member", `Review bot: yes ${key}`, after);
  const result = await run({
    task,
    labelEvent: false,
    issueComments: [request, yes],
    members: ["member"],
  });
  assert.equal(result.status, "start");
  assert.equal(
    JSON.parse(result.content).work.review_authorization,
    "organization_member_approved",
  );
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
  assert.match(
    foreignPayload.content,
    /#1: Ledger payload belongs to another schema, repository, or PR/,
  );

  const trailingJunk = await run({
    task: labelTracked,
    reviewBody: ledgerBody({
      updateCount: 1,
    }).replace(
      /(?<=dev-review-bot:review-ledger:v1:)[A-Za-z0-9_-]+(?= -->)/,
      Buffer.concat([
        deflateSync(
          Buffer.from(
            JSON.stringify({
              version: 1,
              repo,
              pr: 1,
              head_sha: head,
              base_sha: base,
              update_count: 1,
              findings: [],
            }),
            "utf8",
          ),
        ),
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
  assertRestoreReference(work, { reviewId: 42 });
  assert.equal(work.update_count, 1);
  assert.equal(work.pr_summary, "This PR fixes a permission.");
});

test("a verify command without a durable ledger waits with an actionable reason", async () => {
  // Python never offers ledger recovery to verification: with no durable
  // payload the wait is permanent. The skip must name the cause and the
  // recovery path, post no recovery request, and never start.
  const verifyTask = (metadata) => ({
    ...tracked,
    status: "pr_open",
    metadata: {
      review_id: 42,
      last_reviewed_sha: head,
      last_reviewed_base_sha: base,
      last_seen_updated_at: "2026-11-23T10:00:00Z",
      ...metadata,
    },
  });
  const input = {
    labelEvent: false,
    reviewBody: "legacy review without ledger",
    issueComments: [comment(30, "member", "/review-bot verify", "2026-11-23T10:30:00Z")],
    members: ["member"],
  };
  const noPath = await run({ ...input, task: verifyTask({}) });
  assert.equal(noPath.status, "skip");
  assert.equal(
    noPath.content,
    `Verification commands need a recoverable prior ledger on ${repo}#1 ` +
      "(tracked review has no durable ledger payload; " +
      "a member-approved re-review rebuilds the durable ledger); " +
      "No labeled PR needs review or feedback handling",
  );
  assert.deepEqual(noPath.writes, []);

  // A pre-migration task whose only ledger is a legacy local file: the
  // dispatcher can never reach that host path, so the reason says so.
  const legacyOnly = await run({
    ...input,
    task: verifyTask({ ledger_path: "data/review-context/restored-ledgers/old.json" }),
  });
  assert.equal(legacyOnly.status, "skip");
  assert.equal(
    legacyOnly.content,
    `Verification commands need a recoverable prior ledger on ${repo}#1 ` +
      "(tracked review has no durable ledger payload and its legacy ledger file is not reachable from this dispatcher; " +
      "a member-approved re-review rebuilds the durable ledger); " +
      "No labeled PR needs review or feedback handling",
  );
  assert.deepEqual(legacyOnly.writes, []);
  // No ledger is fabricated and no review is restarted: the verify work
  // never converts, unlike the recovery path for review/feedback work.
  const started = await run({
    ...input,
    task: verifyTask({}),
    reviewBody: ledgerBody({ pr: 1, updateCount: 1 }),
  });
  assert.equal(started.status, "start");
  assert.equal(JSON.parse(started.content).work.kind, "verify");
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
  assertRestoreReference(work, { reviewId: 42, pending: true });
  assert.equal(work.update_count, 2);
});

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

test("an invalid tracked review ID fails safely instead of emitting a restore reference", async () => {
  const result = await run({
    task: { ...labelTracked, metadata: { ...labelTracked.metadata, review_id: "42" } },
  });
  assert.equal(result.status, "error");
  assert.match(result.content, /#1: Tracked review ID is invalid/);
  assert.deepEqual(result.writes, []);
});

test("a pending publication without a tracked review ID waits for recovery", async () => {
  // A matching pending publication must never produce a restore reference
  // the runner CLI cannot invoke: without metadata.review_id the pending
  // without a tracked id the runner cannot restore it, so recovery requires
  // consent instead of emitting an unusable reference.
  const body = ledgerBody({ pr: 1, updateCount: 2 });
  const task = pendingVerifyTask(body);
  delete task.metadata.review_id;
  task.metadata.last_reviewed_sha = "c".repeat(40);
  task.metadata.review_label_event_id = 1;
  const result = await run({ task, reviewBody: body });
  assert.equal(result.status, "skip");
  assert.match(
    result.content,
    /Waiting for organization-member ledger-recovery decisions on org\/repo#1/,
  );
});

// Python parity goldens: static expected outcomes generated once from the
// real Fabric review_queue.py (commit 37d5263) under stubbed memory/gh/
// membership boundaries — see test/fixtures/fabric-review-queue-golden.json
// and its README. Each stored scenario replays through this port; outcomes,
// work fields, and consent-comment bodies must match, with only the
// documented ledger_restore hand-off replacing Python's ledger_path. No
// Python runs in CI and no Fabric source is vendored.

const goldenFile = JSON.parse(
  await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fabric-review-queue-golden.json"),
    "utf8",
  ),
);

/** The TS run() inputs mirroring one golden scenario. */
function goldenRun(scenario) {
  const restore = scenario.restore;
  const review =
    restore.mode === "payload"
      ? {
          id: 42,
          user: { login: bot },
          state: "COMMENTED",
          body: ledgerBody({ pr: 1, updateCount: restore.payload.update_count }),
        }
      : restore.mode === "missing"
        ? { id: 42, user: { login: bot }, state: "COMMENTED", body: "legacy review without ledger" }
        : { id: 42, user: { login: bot }, state: "PENDING", body: "", commit_id: head };
  return run({
    tasks: scenario.tasks,
    labelEvent: false,
    issueComments: scenario.comments,
    members: Object.entries(scenario.members)
      .filter(([, isMember]) => isMember)
      .map(([login]) => login),
    review,
  });
}

/** Python gh api mutations normalized to the TS proxy write log. */
const pythonCommentWrites = (writes) =>
  writes
    .filter((write) => write.path.endsWith("/comments"))
    .map((write) => ({
      method: write.method,
      path: `/${write.path}`,
      body: write.fields.body,
    }));
const tsCommentWrites = (writes) =>
  writes
    .filter((write) => write.path.endsWith("/comments"))
    .map((write) => ({ method: write.method, path: write.path, body: write.body.body }));

function assertPythonParity(python, tsResult) {
  assert.equal(tsResult.status, python.status);
  if (python.status !== "start") {
    assert.equal(tsResult.content, python.content);
    return;
  }
  const pythonWork = JSON.parse(python.content).work;
  const tsWork = JSON.parse(tsResult.content).work;
  const { ledger_path: ledgerPath, ...expected } = pythonWork;
  const actual = {};
  for (const [field, value] of Object.entries(tsWork)) {
    if (
      field !== "ledger_restore" &&
      field !== "ledger_restore_pending" &&
      field !== "status_review_id"
    )
      actual[field] = value;
  }
  assert.deepEqual(actual, expected);
  if (ledgerPath !== undefined) {
    // The documented runner hand-off replaces Python's local ledger file.
    assert.equal(tsWork.ledger_restore, "runner");
    assert.equal(tsWork.status_review_id, 42);
  }
}

for (const [name, entry] of Object.entries(goldenFile)) {
  if (name === "provenance") continue;
  test(`Python golden parity: ${name}`, async () => {
    const tsResult = await goldenRun(entry.scenario);
    assertPythonParity(entry.python, tsResult);
    assert.deepEqual(pythonCommentWrites(entry.python.writes), tsCommentWrites(tsResult.writes));
  });
}

test("restored starts satisfy the runner-restoration CLI's input contract", async () => {
  // Fabric restore_review_ledger.py (SKILL.md contract, verified once
  // against this port's output): it is invoked with --repo, --pr,
  // --head-sha, --base-sha, --review-id work.status_review_id, --task-key,
  // and --pending only when ledger_restore_pending is set. It fails closed
  // unless the task key is review-only:github:{repo}#{number}, the tracked
  // task's metadata.review_id equals the passed review id, the live PR sits
  // at the pinned head/base, and (for --pending) the saved publication
  // matches the revision. Pin the emitted fields that feed those checks.
  const body = ledgerBody({ pr: 1, updateCount: 1 });
  const restored = await run({ task: labelTracked, reviewBody: body });
  assert.equal(restored.status, "start");
  const work = JSON.parse(restored.content).work;
  assert.equal(work.ledger_restore, "runner");
  assert.match(work.task_key, /^review-only:github:[\w.-]+\/[\w.-]+#\d+$/);
  assert.equal(work.task_key, `review-only:github:${work.repo}#${work.number}`);
  assert.equal(work.status_review_id, labelTracked.metadata.review_id);
  assert.match(work.head_sha, /^[0-9a-f]{40}$/);
  assert.match(work.base_sha, /^[0-9a-f]{40}$/);
  assert.equal(work.ledger_restore_pending, undefined);

  const pendingBody = ledgerBody({ pr: 1, updateCount: 2 });
  const pending = await run({
    task: pendingVerifyTask(pendingBody),
    reviewBody: pendingBody,
    labelEvent: false,
    issueComments: [comment(30, "member", "/review-bot verify", "2026-11-23T10:30:00Z")],
    members: ["member"],
  });
  assert.equal(pending.status, "start");
  const pendingWork = JSON.parse(pending.content).work;
  assert.equal(pendingWork.ledger_restore_pending, true);
  assert.equal(pendingWork.status_review_id, 42);
});
