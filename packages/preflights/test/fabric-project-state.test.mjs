import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fabricProjectState } from "../dist/preflights/fabric-project-state/index.js";
import {
  linkedIssues,
  planDigest,
  plannerTicketSnapshot,
  planSnapshot,
} from "../dist/preflights/fabric-project-state/plan.js";
import { createPreflightRunContext } from "../dist/shared/run-context.js";

const instanceId = "coordinator";
const parentKey = "RHCLOUD-1";
const teamFieldId = "customfield_10001";
const controlLabel = "dev-bot-coordinator";
const implementationLabel = "implementation-bot";
const repos = { demo: { upstream: "https://github.com/org/demo.git" } };
const parent = {
  key: parentKey,
  fields: { summary: "Parent 🧶", description: null, status: { name: "New" } },
};
const ticket = (number, extra = {}) => ({
  key: `RHCLOUD-${number}`,
  fields: {
    parent: { key: parentKey },
    [teamFieldId]: { id: "team-1" },
    summary: `Ticket ${number}`,
    description: null,
    updated: null,
    priority: null,
    issuetype: null,
    status: { name: "New" },
    labels: ["phase:01"],
    issuelinks: [],
    assignee: null,
    customfield_10020: null,
    ...extra,
  },
});
const control = ticket(2, {
  labels: [controlLabel, "repo:demo", `${controlLabel}:active`],
  [teamFieldId]: { id: "team-1" },
});
const handedOff = ticket(3, { labels: ["repo:demo", "phase:01", implementationLabel] });
const blockedByOtherTeam = ticket(5, {
  issuelinks: [{ type: { name: "Blocks" }, inwardIssue: { key: "RHCLOUD-9" } }],
});
const adf = (type, value) => ({
  type: "doc",
  version: 1,
  content: [{ type, content: [{ type: "text", text: value }] }],
});
const approval = {
  id: "10",
  body: adf("paragraph", "COORDINATOR: approved café"),
  created: "2026-11-20",
};
const ownComment = { id: "11", body: adf("heading", "Coordinator update") };
const pr = (number, title, names = []) => ({
  number,
  title,
  labels: names.map((name) => ({ name })),
});
const pulls = [
  pr(3, "Not a match [RHCLOUD-30]"),
  pr(7, "Fix [rhcloud-3]", ["z", "a"]),
  pr(8, "No x[RHCLOUD-3] match"),
];

async function run(options = {}) {
  const controlIssue = options.control ?? control;
  const comments = options.comments ?? [approval, ownComment];
  const children = options.children ?? [
    handedOff,
    ticket(4),
    blockedByOtherTeam,
    ticket(9, { [teamFieldId]: { id: "other-team" }, status: { name: "Done" } }),
    ticket(10, { parent: { key: "RHCLOUD-20" } }),
  ];
  const jiraResponse = (value) => {
    let body = JSON.stringify(value);
    for (const [marker, lexeme] of Object.entries(options.lexemes ?? {}))
      body = body.replaceAll(JSON.stringify(marker), lexeme);
    return new Response(body, { headers: { "content-type": "application/json" } });
  };
  const ctx = createPreflightRunContext({
    instanceId,
    repos: options.repos ?? repos,
    memory: {
      baseUrl: "https://memory.example",
      fetch: async (url, init) => {
        const { pathname, searchParams } = new URL(url);
        assert.equal(init.method, "GET");
        assert.equal(pathname, "/api/tasks");
        assert.equal(searchParams.get("instance_id"), instanceId);
        assert.equal(searchParams.get("exclude_status"), null);
        if (options.memoryFailure) return Response.json({}, { status: 403 });
        const tasks = options.tasks ?? [];
        const offset = Number(searchParams.get("offset"));
        return Response.json({ items: tasks.slice(offset, offset + 50), total: tasks.length });
      },
    },
    proxy: {
      baseUrl: "https://proxy.example/service",
      fetch: async (url, init) => {
        const { pathname, searchParams } = new URL(url);
        if (pathname === "/service/jira/rest/api/3/search/jql") {
          assert.equal(init.method, "POST");
          const query = JSON.parse(init.body);
          if (query.jql === `project = "RHCLOUD" AND labels = "${controlLabel}" ORDER BY key ASC`) {
            return jiraResponse(
              options.searchFailure
                ? { isLast: true }
                : { issues: [{ key: control.key }], isLast: true },
            );
          }
          assert.equal(query.jql, `parent = "${parentKey}" ORDER BY key ASC`);
          assert.ok(query.fields.includes(teamFieldId));
          for (const field of ["updated", "priority", "issuetype"])
            assert.ok(query.fields.includes(field));
          if (!query.nextPageToken) {
            const page = {
              issues: [controlIssue, ...children.slice(0, 1)],
              nextPageToken: "next",
              isLast: false,
              ...(options.extraPageFields ?? {}),
            };
            return jiraResponse(page);
          }
          assert.equal(query.nextPageToken, "next");
          return jiraResponse({ issues: children.slice(1), isLast: true });
        }
        assert.equal(init.method, "GET");
        if (pathname.endsWith(`/issue/${control.key}/comment`)) {
          const startAt = Number(searchParams.get("startAt"));
          return jiraResponse(
            options.truncateComments
              ? { comments: [], total: 1, startAt }
              : {
                  comments: comments.slice(startAt, startAt + 1),
                  total: options.commentTotal ?? comments.length,
                  startAt,
                },
          );
        }
        if (pathname.endsWith(`/issue/${control.key}`)) return jiraResponse(controlIssue);
        if (pathname.endsWith(`/issue/${parentKey}`)) return jiraResponse(options.parent ?? parent);
        assert.equal(pathname, "/service/github/repos/org/demo/pulls");
        assert.equal(searchParams.get("state"), "open");
        if (options.githubFailure)
          return Response.json({ details: "should not enter diagnostics" }, { status: 403 });
        return Response.json(options.pulls ?? pulls);
      },
    },
  });
  const input = fabricProjectState.input.parse({
    controlLabel,
    teamFieldId,
    implementationLabel,
    includeBacklog: true,
    ...options.params,
  });
  return fabricProjectState.run(ctx, input);
}

function project(result) {
  assert.equal(result.status, "start", result.content);
  const payload = JSON.parse(result.content);
  assert.equal(payload.implementation_label, implementationLabel);
  assert.equal(payload.projects.length, 1);
  return payload.projects[0];
}

const plannerCommand = (id, body = "PLANNER: /coord plan focus on rollout") => ({
  id,
  body,
  created: "2026-11-23",
});
const plannerReceiptComment = (id, requested, block = "plan text") => ({
  id,
  body:
    `PLANNER: Planner update - Technical plan for RHCLOUD-1\n\n${block}\n\n` +
    `Planner request comment: ${requested}`,
  created: "2026-11-24",
});
const coordinationBlock = (hash, tickets, omitHash = false) =>
  "```planner-coordination\n" +
  JSON.stringify({
    ...(omitHash ? {} : { input_snapshot_hash: hash }),
    ticket_assignments: tickets,
  }) +
  "\n```";

// Two-control scan where the first control is an actionable coordinator and
// the second carries the planner route. Every read beyond the control search,
// the two control issues, and their comments is recorded as unexpected.
async function plannerRun(options = {}) {
  const memoryReads = { count: 0 };
  const unexpected = [];
  let first = options.first ?? control;
  if (options.lagFirst) {
    // The search index still returns this control, but the label is gone.
    first = structuredClone(first);
    first.fields.labels = first.fields.labels.filter((label) => label !== controlLabel);
  }
  const second =
    options.second ??
    (() => {
      // Planner routing must not need the Team field, task metadata, or the
      // repository map: the route precedes all coordination reads.
      const issue = ticket(8, { labels: [controlLabel, "repo:demo"] });
      delete issue.fields[teamFieldId];
      return issue;
    })();
  const jiraResponse = (value) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const commentPage = (comments) => ({
    comments,
    total: comments.length,
    startAt: 0,
  });
  const ctx = createPreflightRunContext({
    instanceId,
    repos: options.repos ?? {},
    memory: {
      baseUrl: "https://memory.example",
      fetch: async () => {
        memoryReads.count += 1;
        return Response.json({ items: [], total: 0 });
      },
    },
    proxy: {
      baseUrl: "https://proxy.example/service",
      fetch: async (url, init) => {
        const { pathname } = new URL(url);
        if (pathname === "/service/jira/rest/api/3/search/jql") {
          const query = JSON.parse(init.body);
          if (query.jql === `project = "RHCLOUD" AND labels = "${controlLabel}" ORDER BY key ASC`)
            return jiraResponse({
              issues: [{ key: "RHCLOUD-2" }, { key: "RHCLOUD-8" }],
              isLast: true,
            });
          unexpected.push(`sibling search: ${query.jql}`);
          return jiraResponse({ issues: [], isLast: true });
        }
        assert.equal(init.method, "GET");
        if (pathname.endsWith("/issue/RHCLOUD-2")) return jiraResponse(first);
        if (pathname.endsWith("/issue/RHCLOUD-2/comment")) {
          // A label-lagged control is skipped before its comments are read,
          // so a failing comments response here must never surface.
          if (options.lagFirst) return new Response("forbidden", { status: 403 });
          return jiraResponse(commentPage(options.firstComments ?? [approval]));
        }
        if (pathname.endsWith("/issue/RHCLOUD-8")) return jiraResponse(second);
        if (pathname.endsWith("/issue/RHCLOUD-8/comment"))
          return jiraResponse(commentPage(options.secondComments ?? [plannerCommand("12")]));
        unexpected.push(pathname);
        return jiraResponse({ issues: [], isLast: true });
      },
    },
  });
  const input = fabricProjectState.input.parse({
    controlLabel,
    teamFieldId,
    implementationLabel,
    includeBacklog: true,
  });
  const result = await fabricProjectState.run(ctx, input);
  return { result, memoryReads: memoryReads.count, unexpected };
}

const task = (snapshot_hash, options = {}) => ({
  external_key: control.key,
  source_type: "jira",
  instance_id: instanceId,
  status: "archived",
  metadata: { snapshot_hash, processed_comment_ids: [approval.id] },
  ...options,
});

test("selects direct same-Team scope, waits on external blockers, and observes PR-only changes", async () => {
  const first = project(await run());
  assert.equal(first.team_id, "team-1");
  assert.equal(first.first_run, true);
  assert.equal(first.current_phase, "phase:01");
  assert.deepEqual(
    first.tickets.map(({ key }) => key),
    ["RHCLOUD-3", "RHCLOUD-4", "RHCLOUD-5"],
  );
  assert.deepEqual(first.ready, [{ key: "RHCLOUD-4", repo_candidates: ["demo"] }]);
  assert.deepEqual(first.waiting, ["RHCLOUD-5"]);
  assert.deepEqual(first.new_comments, [{ ...approval, body: "COORDINATOR: approved café" }]);
  // Gating keeps the real REST dependency links (RHCLOUD-5 waits on its
  // blocker) even though the hash-normalized plan snapshot cannot carry
  // them: the Fabric Python reads links from the mcp-atlassian shape, where
  // they are structurally invisible (see the parity goldens).
  assert.deepEqual(first.plan_snapshot["RHCLOUD-5"].blockers, []);
  assert.deepEqual(first.waiting, ["RHCLOUD-5"]);
  // Golden digests from the real deployed pipeline: mcp-atlassian 0.23.1
  // models plus the Fabric Python reference (upstream d62cc55), regenerated
  // through test/fixtures/project-state-parity/generate.py and verified
  // against project_coordinator.fingerprint at the same reference.
  assert.equal(
    first.snapshot_hash,
    "f634899c42ad23af95af50d6def2f939f9038b65f19e198eb4d7e5a8f36cc6fa",
  );
  assert.equal(
    first.plan_snapshot_hash,
    "029fa055304ee886594dd9357d5565203eff5e9a14dbd66834a7878f215c63e1",
  );
  assert.equal(first.ticket_changes.baseline_missing, true);
  assert.equal(first.plan_change_required, false);
  assert.deepEqual(first.open_pull_requests, {
    "RHCLOUD-3": [
      {
        repo: "org/demo",
        number: 7,
        title: "Fix [rhcloud-3]",
        url: "https://github.com/org/demo/pull/7",
        labels: ["a", "z"],
      },
    ],
  });

  const stateOnly = ticket(2, {
    ...control.fields,
    labels: [controlLabel, "repo:demo", `${controlLabel}:blocked`],
  });
  const tasks = [
    task("ignored", { source_type: "github" }),
    ...Array.from({ length: 49 }, (_, i) =>
      task("unrelated", { external_key: `RHCLOUD-${100 + i}` }),
    ),
    task(first.snapshot_hash),
  ];
  assert.equal((await run({ control: stateOnly, comments: [approval], tasks })).status, "skip");
  const changed = project(
    await run({ tasks, pulls: [pr(7, "Fix [rhcloud-3]", ["a", "reviewed", "z"])] }),
  );
  assert.equal(changed.first_run, false);
  assert.deepEqual(changed.new_comments, []);
  assert.notEqual(changed.snapshot_hash, first.snapshot_hash);
});

test("ticket blockers do not suppress unrelated ready work; orphan control has its own stable gate", async () => {
  const owned = ticket(4, { assignee: { accountId: "owner" } });
  const outside = ticket(5, { labels: ["phase:01", "repo:foreign"] });
  const backlog = ticket(6);
  const gated = project(
    await run({ children: [owned, outside, backlog], params: { includeBacklog: false } }),
  );
  assert.deepEqual(gated.ready, [{ key: "RHCLOUD-6", repo_candidates: ["demo"] }]);
  assert.deepEqual(gated.gaps, []);
  assert.deepEqual(gated.blocked_tickets, [
    { key: "RHCLOUD-4", reasons: ["ticket is not unassigned"] },
    { key: "RHCLOUD-5", reasons: ["repo label is outside the control ticket's allowlist"] },
  ]);
  const duplicate = project(
    await run({ children: [ticket(4, { labels: [controlLabel, "phase:01"] })] }),
  );
  assert.ok(duplicate.gaps.includes("Parent has multiple same-Team control tickets"));
  assert.deepEqual(duplicate.ready, []);
  const orphan = ticket(2, { ...control.fields, parent: null });
  const report = project(await run({ control: orphan }));
  assert.equal(report.error, "Control ticket has no parent issue");
  assert.equal(
    (await run({ control: orphan, tasks: [task(report.snapshot_hash)] })).status,
    "skip",
  );
});

test("plan changes and pending approvals are reported against stored plan metadata", async () => {
  const first = project(await run({ children: [ticket(4)] }));
  const changedTicket = ticket(4, {
    summary: "Changed",
    updated: "2026-11-22",
    priority: { name: "High" },
    issuetype: { name: "Task" },
    issuelinks: [{ type: { name: "Relates" }, outwardIssue: { key: "RHCLOUD-7" } }],
  });
  const saved = task(first.snapshot_hash, {
    metadata: {
      snapshot_hash: first.snapshot_hash,
      plan_snapshot: first.plan_snapshot,
      approved_plan_snapshot_hash: first.plan_snapshot_hash,
      pending_plan_approval: true,
    },
  });
  const changed = project(await run({ children: [changedTicket, ticket(6)], tasks: [saved] }));
  assert.equal(changed.approved_plan_snapshot_changed, true);
  assert.equal(changed.plan_approval_pending, true);
  assert.equal(changed.plan_change_required, true);
  assert.deepEqual(
    changed.ticket_changes.added.map(({ key }) => key),
    ["RHCLOUD-6"],
  );
  // Link changes no longer appear in the plan diff: the Fabric Python reads
  // links from the mcp-atlassian shape where they are invisible, so the
  // normalized snapshot (and therefore the approval hash) cannot observe
  // them. Dependency gating still uses the raw REST links (waiting above).
  assert.deepEqual(Object.keys(changed.ticket_changes.changed[0].fields), [
    "issue_type",
    "priority",
    "summary",
  ]);
  assert.equal(changed.approved_plan_snapshot_hash, first.plan_snapshot_hash);
  const noBaseline = project(
    await run({
      children: [changedTicket],
      tasks: [
        task(first.snapshot_hash, {
          metadata: {
            snapshot_hash: first.snapshot_hash,
            approved_plan_snapshot_hash: first.plan_snapshot_hash,
          },
        }),
      ],
    }),
  );
  assert.equal(noBaseline.ticket_changes.baseline_missing, true);
  assert.equal(noBaseline.plan_change_required, true);
  const pending = project(
    await run({
      children: [ticket(4)],
      comments: [approval, { id: "16", body: "COORDINATOR: approve" }],
      tasks: [saved],
    }),
  );
  assert.deepEqual(pending.ticket_changes.changed, []);
  assert.equal(pending.approved_plan_snapshot_changed, false);
  assert.equal(pending.plan_approval_pending, true);
  assert.equal(pending.plan_change_required, true);
  const removed = project(await run({ children: [], tasks: [saved] }));
  assert.deepEqual(
    removed.ticket_changes.removed.map(({ key }) => key),
    ["RHCLOUD-4"],
  );
});

test("no-sprint unassigned placeholders can hand off while owned/status tickets remain blocked", async () => {
  const children = [
    ticket(4, { assignee: { display_name: "Unassigned" } }),
    ticket(5, {
      assignee: { displayName: "Unassigned", accountId: "real-id" },
      status: { name: "In Progress" },
      labels: ["phase:01", "repo:foreign"],
    }),
  ];
  const result = project(await run({ children, params: { includeBacklog: false } }));
  assert.deepEqual(result.ready, [{ key: "RHCLOUD-4", repo_candidates: ["demo"] }]);
  assert.deepEqual(result.blocked_tickets, [
    {
      key: "RHCLOUD-5",
      reasons: [
        "repo label is outside the control ticket's allowlist",
        "status In Progress is not not-started",
        "ticket is not unassigned",
      ],
    },
  ]);
  // The plan snapshot no longer carries runtime fields such as assignee;
  // unassigned placeholders only gate readiness now.
  assert.equal("assignee" in result.plan_snapshot["RHCLOUD-4"], false);
});

test("routed coordinator comments normalize case and dynamic headings without hiding feedback", async () => {
  const comments = [
    approval,
    { id: "12", body: adf("heading", "COORDINATOR: coordinator UPDATE - Next steps") },
    { id: "13", body: "## Coordinator update - Plan\nbody" },
    { id: "14", body: "COORDINATOR: proceed\nReport\nCoordinator action: continue" },
    { id: "15", body: "COORDINATOR: Coordinator update from user" },
    { id: "16", body: adf("heading", "COORDINATOR: h1. Coordinator update - approved") },
  ];
  const result = project(await run({ comments }));
  // Only first-line COORDINATOR-routed comments count as feedback, and the
  // persona prefix is stripped before the own-report heading match, so bot
  // reports starting "COORDINATOR: Coordinator update" stay ignored.
  assert.deepEqual(
    result.new_comments.map(({ id }) => id),
    ["10", "15", "16"],
  );
  const noOwn = project(await run({ comments: [approval, comments[4], comments[5]] }));
  assert.equal(result.snapshot_hash, noOwn.snapshot_hash);
  // Unrouted user chatter never reaches the fingerprint or new_comments.
  const unrouted = project(
    await run({ comments: [approval, comments[1], comments[2], comments[3]] }),
  );
  const routedOnly = project(await run({ comments: [approval] }));
  assert.equal(unrouted.snapshot_hash, routedOnly.snapshot_hash);
  assert.deepEqual(
    unrouted.new_comments.map(({ id }) => id),
    ["10"],
  );
});

test("planner requests preempt coordination before any task or repository read", async () => {
  // A planner command on a LATER control preempts an actionable earlier
  // control: the planner-first pass covers every sorted control before any
  // coordination, task, or repository read, exactly like the Fabric Python.
  const { result, memoryReads, unexpected } = await plannerRun({});
  assert.equal(result.status, "start", result.content);
  assert.deepEqual(JSON.parse(result.content), {
    planner: { control_key: "RHCLOUD-8", comment_id: "12", parent_key: "RHCLOUD-1" },
  });
  assert.equal(memoryReads, 0);
  assert.deepEqual(unexpected, []);

  // A label-lagged candidate is skipped before its comments are read, so a
  // failing comments fetch on it cannot block the remaining controls.
  const laggedFirst = await plannerRun({ lagFirst: true });
  assert.equal(laggedFirst.result.status, "start", laggedFirst.result.content);
  assert.deepEqual(JSON.parse(laggedFirst.result.content), {
    planner: { control_key: "RHCLOUD-8", comment_id: "12", parent_key: "RHCLOUD-1" },
  });
  assert.deepEqual(laggedFirst.unexpected, []);

  // An answered command (receipt marker quotes the command comment id) and a
  // route that is not the first line both fall through to coordination.
  const answered = project(
    await run({ comments: [plannerCommand("12"), plannerReceiptComment("13", "12")] }),
  );
  assert.equal(answered.control_key, "RHCLOUD-2");
  assert.deepEqual(answered.new_comments, []);
  assert.equal(answered.planner_plan.comment_id, "13");
  const notFirstLine = project(
    await run({ comments: [{ id: "12", body: "context\nPLANNER: /coord plan", created: "" }] }),
  );
  assert.equal(notFirstLine.control_key, "RHCLOUD-2");

  // A control whose label already fell out of the search index cannot route
  // a planner request; it is simply not enrolled.
  const lagged = structuredClone(control);
  lagged.fields.labels = ["repo:demo"];
  assert.equal((await run({ control: lagged, comments: [plannerCommand("12")] })).status, "skip");
});

test("planner plan reports the newest receipt and whether it covers current tickets", async () => {
  const childIssues = [handedOff, ticket(4), blockedByOtherTeam];
  const digest = planDigest(plannerTicketSnapshot(childIssues, teamFieldId));
  const assignments = {
    "RHCLOUD-3": { phase: "phase:01", repository: "demo" },
    "RHCLOUD-4": { phase: "phase:02", repository: "demo" },
    "RHCLOUD-5": { phase: "phase:03", repository: "demo" },
  };

  const none = project(await run());
  assert.deepEqual(none.planner_plan, {
    comment_id: null,
    assignments: {},
    current: false,
    input_snapshot_hash: null,
    current_snapshot_hash: digest,
  });
  assert.equal(none.planner_plan_current, false);

  const current = project(
    await run({
      comments: [
        approval,
        plannerReceiptComment("20", "12", coordinationBlock(digest, assignments)),
      ],
    }),
  );
  assert.equal(current.planner_plan_current, true);
  assert.deepEqual(current.planner_plan, {
    comment_id: "20",
    assignments,
    current: true,
    input_snapshot_hash: digest,
    current_snapshot_hash: digest,
  });

  // A stale input hash keeps the assignments visible but not current.
  const staleHash = "0".repeat(64);
  const stale = project(
    await run({
      comments: [
        approval,
        plannerReceiptComment("20", "12", coordinationBlock(staleHash, assignments)),
      ],
    }),
  );
  assert.equal(stale.planner_plan_current, false);
  assert.equal(stale.planner_plan.input_snapshot_hash, staleHash);
  assert.deepEqual(stale.planner_plan.assignments, assignments);

  // A parseable block that omits input_snapshot_hash still emits the field
  // as null (Python dict.get), never drops it from the JSON payload.
  const missingHashResult = await run({
    comments: [
      approval,
      plannerReceiptComment("20", "12", coordinationBlock(null, assignments, true)),
    ],
  });
  assert.equal(missingHashResult.status, "start");
  const missingHashPayload = JSON.parse(missingHashResult.content);
  assert.deepEqual(missingHashPayload.projects[0].planner_plan, {
    comment_id: "20",
    assignments,
    current: false,
    input_snapshot_hash: null,
    current_snapshot_hash: digest,
  });
  assert.match(missingHashResult.content, /"input_snapshot_hash":null/);

  // Invalid phases, unknown repositories, and missing tickets invalidate.
  for (const invalid of [
    { ...assignments, "RHCLOUD-4": { phase: "phase:2", repository: "demo" } },
    { ...assignments, "RHCLOUD-4": { phase: "phase:02", repository: "foreign" } },
    { "RHCLOUD-3": assignments["RHCLOUD-3"], "RHCLOUD-4": assignments["RHCLOUD-4"] },
  ]) {
    const broken = project(
      await run({
        comments: [approval, plannerReceiptComment("20", "12", coordinationBlock(digest, invalid))],
      }),
    );
    assert.equal(broken.planner_plan_current, false, JSON.stringify(invalid));
  }

  // Only the NEWEST receipt counts, however invalid: the coordinator asks
  // for a fresh plan instead of falling back to an older valid one.
  const newestWins = project(
    await run({
      comments: [
        approval,
        plannerReceiptComment("20", "12", coordinationBlock(digest, assignments)),
        plannerReceiptComment("21", "19"),
      ],
    }),
  );
  assert.deepEqual(newestWins.planner_plan, {
    comment_id: "21",
    assignments: {},
    current: false,
    input_snapshot_hash: null,
    current_snapshot_hash: digest,
  });
});

test("planner receipts wake the coordinator while unrouted chatter does not", async () => {
  const base = project(await run());
  const plain = { id: "12", body: "plain human note", created: "2026-11-21" };
  assert.equal(
    (
      await run({
        comments: [approval, ownComment, plain],
        tasks: [task(base.snapshot_hash)],
      })
    ).status,
    "skip",
  );
  const woken = project(
    await run({
      comments: [approval, ownComment, plannerReceiptComment("13", "12")],
      tasks: [task(base.snapshot_hash)],
    }),
  );
  // Golden from project_coordinator.fingerprint at Fabric d62cc55: the
  // latest_planner_receipt control field is the only wake input here.
  assert.equal(
    woken.snapshot_hash,
    "9fa57cdc849bdcdfcbf1774e79b654ba689fbeb41f9558d64bef7cc60c6a1d04",
  );
  assert.equal(woken.first_run, false);
  assert.deepEqual(woken.new_comments, []);
  assert.equal(woken.planner_plan.comment_id, "13");
});

test("Python latest snapshot and fingerprint match ADF, normalized assignee and planning fields", async () => {
  const description = adf("paragraph", "café's 🧶\nworks");
  const child = ticket(4, {
    description,
    updated: "2026-11-23T12:00:00.000+0000",
    priority: { id: "1", name: "High" },
    issuetype: { name: "Task" },
    assignee: { display_name: "Unassigned" },
    issuelinks: [{ type: { name: "Relates" }, outwardIssue: { key: "RHCLOUD-8" } }],
  });
  const result = project(await run({ children: [child] }));
  // Generated by running the real mcp-atlassian 0.23.1 models plus the
  // Fabric Python reference (upstream d62cc55) over this Jira data; see
  // test/fixtures/project-state-parity/generate.py.
  assert.equal(
    result.plan_snapshot_hash,
    "04be4fc5151d1e997f9e27ad89b078836e962e1e50956ec3aa4c4573aabd59cc",
  );
  assert.equal(
    result.snapshot_hash,
    "5deb6dde83a18fb952dc4938aa1a791fe7d92d075ab4f388d67b138072d72504",
  );
  // ADF descriptions flatten to the mcp-atlassian text form and links
  // disappear from the hash-normalized snapshot, exactly like the Python
  // runner digests them.
  assert.equal(result.plan_snapshot[child.key].description, "café's 🧶\nworks");
  assert.deepEqual(result.plan_snapshot[child.key].related, []);
  assert.equal(result.plan_snapshot[child.key].priority, "High");
  const sprintOnly = ticket(4, { ...child.fields, customfield_10020: [{ id: 123 }] });
  assert.equal(project(await run({ children: [sprintOnly] })).snapshot_hash, result.snapshot_hash);
});

// Fixtures transcribed from the Python reference preflight test scenario
// (bootstrap, skip while unchanged, wake on completion). The goldens below
// were generated by running project_coordinator.py at Fabric upstream d62cc55
// against this exact Jira data with the reads stubbed, so the TypeScript
// start content must match them field for field.
const parityParent = {
  key: parentKey,
  fields: {
    summary: "Parent epic",
    description: "Epic holding the coordinator work",
    status: { name: "New" },
  },
};
const parityControl = ticket(2, {
  [teamFieldId]: { id: "42" },
  summary: "Ticket 2",
  description: "Coordinate the work",
  updated: "2026-11-20T09:00:00.000+0000",
  priority: { name: "Medium", id: "3" },
  issuetype: { name: "Task" },
  labels: ["dev-bot-coordinator", "repo:demo"],
});
const parityChild = (extra = {}) =>
  ticket(3, {
    [teamFieldId]: { id: "42" },
    summary: "First implementation ticket",
    description: "Clear acceptance criteria",
    updated: "2026-11-21T10:00:00.000+0000",
    priority: { name: "Medium", id: "3" },
    issuetype: { name: "Story" },
    labels: ["phase:01"],
    issuelinks: [{ type: { name: "Relates" }, outwardIssue: { key: "RHCLOUD-2" } }],
    ...extra,
  });
const parityRun = (options = {}) =>
  run({
    control: options.control ?? parityControl,
    parent: parityParent,
    comments: [],
    tasks: options.tasks ?? [],
    ...options,
  });
const goldenBootstrap = JSON.parse(`
{
  "allowed_repos": [
    "demo"
  ],
  "approved_plan_snapshot_changed": false,
  "approved_plan_snapshot_hash": null,
  "blocked_tickets": [],
  "control_key": "RHCLOUD-2",
  "current_phase": "phase:01",
  "first_run": true,
  "gaps": [],
  "github_pr_errors": {},
  "legacy_plan_snapshot_migrated": false,
  "new_comments": [],
  "open_pull_requests": {},
  "parent_key": "RHCLOUD-1",
  "plan_approval_pending": false,
  "plan_change_required": false,
  "planner_plan": {
    "assignments": {},
    "comment_id": null,
    "current": false,
    "current_snapshot_hash": "a37b321cf26418c8a28ac3eef87e0382621468a41501e802f77cc7fd8573b753",
    "input_snapshot_hash": null
  },
  "planner_plan_current": false,
  "plan_snapshot": {
    "RHCLOUD-3": {
      "blockers": [],
      "description": "Clear acceptance criteria",
      "issue_type": "Story",
      "phase_labels": [
        "phase:01"
      ],
      "planning_labels": [],
      "priority": "Medium",
      "related": [],
      "repo_labels": [],
      "summary": "First implementation ticket",
      "team_id": "42"
    }
  },
  "plan_snapshot_hash": "0c6491302cd9b1d5ad7a80679ade841ad4c2df66b8d6df0e0b2b6a7d8c6e8077",
  "ready": [
    {
      "key": "RHCLOUD-3",
      "repo_candidates": [
        "demo"
      ]
    }
  ],
  "snapshot_hash": "fb1cc20bc6b1f4c8df7b7e0c2a8f7c92293805a3dba235167f686e13d3b9d67e",
  "state": null,
  "team_field_id": "customfield_10001",
  "team_id": "42",
  "ticket_changes": {
    "added": [],
    "baseline_missing": true,
    "changed": [],
    "removed": []
  },
  "tickets": [
    {
      "assignee": false,
      "blockers": [],
      "description": "Clear acceptance criteria",
      "implementation_labeled": false,
      "key": "RHCLOUD-3",
      "phase_labels": [
        "phase:01"
      ],
      "repo_labels": [],
      "status": "New",
      "summary": "First implementation ticket"
    }
  ],
  "waiting": []
}`);
const goldenWake = JSON.parse(`
{
  "allowed_repos": [
    "demo"
  ],
  "approved_plan_snapshot_changed": false,
  "approved_plan_snapshot_hash": "0c6491302cd9b1d5ad7a80679ade841ad4c2df66b8d6df0e0b2b6a7d8c6e8077",
  "blocked_tickets": [],
  "control_key": "RHCLOUD-2",
  "current_phase": null,
  "first_run": false,
  "gaps": [],
  "github_pr_errors": {},
  "legacy_plan_snapshot_migrated": true,
  "new_comments": [],
  "open_pull_requests": {},
  "parent_key": "RHCLOUD-1",
  "plan_approval_pending": false,
  "plan_change_required": false,
  "planner_plan": {
    "assignments": {},
    "comment_id": null,
    "current": false,
    "current_snapshot_hash": "a37b321cf26418c8a28ac3eef87e0382621468a41501e802f77cc7fd8573b753",
    "input_snapshot_hash": null
  },
  "planner_plan_current": false,
  "plan_snapshot": {
    "RHCLOUD-3": {
      "blockers": [],
      "description": "Clear acceptance criteria",
      "issue_type": "Story",
      "phase_labels": [
        "phase:01"
      ],
      "planning_labels": [],
      "priority": "Medium",
      "related": [],
      "repo_labels": [],
      "summary": "First implementation ticket",
      "team_id": "42"
    }
  },
  "plan_snapshot_hash": "0c6491302cd9b1d5ad7a80679ade841ad4c2df66b8d6df0e0b2b6a7d8c6e8077",
  "ready": [],
  "snapshot_hash": "26f8fcbee2ffb023eeacaf8cee2a06b7cfea5ee7f75d45f55258df5771302bf2",
  "state": "dev-bot-coordinator:active",
  "team_field_id": "customfield_10001",
  "team_id": "42",
  "ticket_changes": {
    "added": [],
    "baseline_missing": false,
    "changed": [],
    "removed": []
  },
  "tickets": [
    {
      "assignee": false,
      "blockers": [],
      "description": "Clear acceptance criteria",
      "implementation_labeled": false,
      "key": "RHCLOUD-3",
      "phase_labels": [
        "phase:01"
      ],
      "repo_labels": [],
      "status": "Release Pending",
      "summary": "First implementation ticket"
    }
  ],
  "waiting": []
}`);

test("start content is identical to the Fabric Python preflight reference output", async () => {
  const bootstrap = project(await parityRun({ children: [parityChild()] }));
  assert.deepEqual(bootstrap, goldenBootstrap);

  const activeControl = structuredClone(parityControl);
  activeControl.fields.labels.push("dev-bot-coordinator:active");
  const stored = task(bootstrap.snapshot_hash, {
    metadata: {
      snapshot_hash: bootstrap.snapshot_hash,
      plan_snapshot: bootstrap.plan_snapshot,
      approved_plan_snapshot_hash: bootstrap.plan_snapshot_hash,
    },
  });
  assert.equal(
    (await parityRun({ control: activeControl, children: [parityChild()], tasks: [stored] }))
      .status,
    "skip",
  );

  // A status-only change wakes the coordinator through the fingerprint but
  // leaves the plan digest untouched, so no plan revision is required.
  const completed = parityChild({ status: { name: "Release Pending" } });
  const woken = project(
    await parityRun({ control: activeControl, children: [completed], tasks: [stored] }),
  );
  assert.deepEqual(woken, goldenWake);
  assert.equal(woken.plan_snapshot_hash, bootstrap.plan_snapshot_hash);
});

test("legacy runtime-field plan snapshots migrate without forcing a reapproval", async () => {
  // Snapshot format used before the runtime fields were dropped: it carries
  // updated/status/assignee/labels and includes the implementation bot label
  // in planning_labels. Link sets were never observable through the MCP
  // shape, so a legacy snapshot with non-empty blockers/related no longer
  // matches the normalized plan and requires one fresh approval instead.
  const legacySnapshot = {
    "RHCLOUD-3": {
      summary: "First implementation ticket",
      description: "Clear acceptance criteria",
      updated: "2026-11-21T10:00:00.000+0000",
      status: "New",
      assignee: false,
      priority: "Medium",
      issue_type: "Story",
      team_id: "42",
      labels: ["phase:01", "triaged", "implementation-bot"],
      phase_labels: ["phase:01"],
      repo_labels: [],
      planning_labels: ["implementation-bot", "triaged"],
      blockers: [],
      related: [],
    },
  };
  const legacyDigest = planDigest(legacySnapshot);
  const handedOff = parityChild({ labels: ["phase:01", "triaged", implementationLabel] });
  const legacyTask = (metadata) =>
    task("stale-wake-hash", {
      metadata: { snapshot_hash: "stale-wake-hash", plan_snapshot: legacySnapshot, ...metadata },
    });

  const migrated = project(
    await parityRun({
      children: [handedOff],
      tasks: [legacyTask({ approved_plan_snapshot_hash: legacyDigest })],
    }),
  );
  assert.equal(migrated.legacy_plan_snapshot_migrated, true);
  assert.equal(
    migrated.plan_snapshot_hash,
    "b025868d4d872b89cdf8df061bdba08cf23996a1509f514380dc4f293950b40a",
  );
  assert.equal(migrated.approved_plan_snapshot_hash, migrated.plan_snapshot_hash);
  assert.deepEqual(migrated.ticket_changes, {
    baseline_missing: false,
    added: [],
    removed: [],
    changed: [],
  });
  assert.equal(migrated.approved_plan_snapshot_changed, false);
  assert.equal(migrated.plan_change_required, false);
  assert.deepEqual(migrated.plan_snapshot["RHCLOUD-3"].planning_labels, ["triaged"]);
  assert.deepEqual(Object.keys(migrated.plan_snapshot["RHCLOUD-3"]).sort(), [
    "blockers",
    "description",
    "issue_type",
    "phase_labels",
    "planning_labels",
    "priority",
    "related",
    "repo_labels",
    "summary",
    "team_id",
  ]);

  const mismatched = project(
    await parityRun({
      children: [handedOff],
      tasks: [legacyTask({ approved_plan_snapshot_hash: "0".repeat(64) })],
    }),
  );
  assert.equal(mismatched.legacy_plan_snapshot_migrated, false);
  assert.equal(mismatched.approved_plan_snapshot_changed, true);
  assert.equal(mismatched.plan_change_required, true);

  const pending = project(
    await parityRun({
      children: [handedOff],
      tasks: [
        legacyTask({ approved_plan_snapshot_hash: legacyDigest, pending_plan_approval: true }),
      ],
    }),
  );
  assert.equal(pending.legacy_plan_snapshot_migrated, false);
  assert.equal(pending.plan_approval_pending, true);
  assert.equal(pending.plan_change_required, true);

  // A real user label change is still reported and blocks the migration.
  const relabeled = project(
    await parityRun({
      children: [parityChild({ labels: ["phase:01", "triaged", "urgent"] })],
      tasks: [legacyTask({ approved_plan_snapshot_hash: legacyDigest })],
    }),
  );
  assert.equal(relabeled.legacy_plan_snapshot_migrated, false);
  assert.deepEqual(relabeled.ticket_changes.changed[0].fields.planning_labels, {
    before: ["implementation-bot", "triaged"],
    after: ["triaged", "urgent"],
  });
  assert.equal(relabeled.plan_change_required, true);

  // A legacy snapshot carrying link sets can no longer match the normalized
  // plan (links are invisible on the MCP side), so it demands one fresh
  // approval instead of silently migrating.
  const linkedLegacyTask = task("stale-wake-hash", {
    metadata: {
      snapshot_hash: "stale-wake-hash",
      plan_snapshot: {
        ...legacySnapshot,
        "RHCLOUD-3": { ...legacySnapshot["RHCLOUD-3"], related: ["RHCLOUD-2"] },
      },
      approved_plan_snapshot_hash: planDigest({
        ...legacySnapshot,
        "RHCLOUD-3": { ...legacySnapshot["RHCLOUD-3"], related: ["RHCLOUD-2"] },
      }),
    },
  });
  const linkedLegacy = project(
    await parityRun({ children: [handedOff], tasks: [linkedLegacyTask] }),
  );
  assert.equal(linkedLegacy.legacy_plan_snapshot_migrated, false);
  assert.deepEqual(linkedLegacy.ticket_changes.changed[0].fields.related, {
    before: ["RHCLOUD-2"],
    after: [],
  });
  assert.equal(linkedLegacy.plan_change_required, true);
});

test("plan digest inputs converge across REST and MCP issue shapes", () => {
  const restShape = {
    key: "RHCLOUD-7",
    fields: {
      parent: { key: parentKey },
      [teamFieldId]: { id: "42" },
      summary: "Shared summary",
      description: "Plain text",
      updated: "2026-11-23T12:00:00.000+0000",
      priority: { name: "High", id: "3" },
      issuetype: { name: "Story" },
      status: { name: "New" },
      labels: ["phase:01", "triaged"],
      issuelinks: [],
      assignee: null,
    },
  };
  // The shape the mcp-atlassian jira_search tool returns: fields flattened
  // to the top level, issuetype renamed to issue_type, custom fields wrapped
  // in {"value": ...}, timestamps reformatted, an Unassigned placeholder, and
  // empty collections (here issuelinks) omitted entirely.
  const mcpShape = {
    id: "12345",
    key: "RHCLOUD-7",
    summary: "Shared summary",
    description: "Plain text",
    status: { name: "New", category: "To Do", color: "blue-gray" },
    issue_type: { name: "Story" },
    priority: { name: "High" },
    assignee: { display_name: "Unassigned" },
    labels: ["phase:01", "triaged"],
    created: "2026-11-20 09:00:00 UTC",
    updated: "2026-11-23 12:00:00 UTC",
    [teamFieldId]: { value: { id: "42" }, name: "Team" },
  };
  const rest = planSnapshot([restShape], teamFieldId, implementationLabel);
  const mcp = planSnapshot([mcpShape], teamFieldId, implementationLabel);
  assert.deepEqual(mcp, rest);
  assert.equal(planDigest(mcp), planDigest(rest));

  // Cloud ADF descriptions and issue links converge too: REST reads are
  // normalized through the same mcp-atlassian 0.23.1 transformations the
  // Fabric Python digests (adf_to_text for descriptions, the simplified
  // snake_case link shape), so the same logical ticket digests identically
  // on both sides. See test/fixtures/project-state-parity/parity-goldens.json
  // for goldens generated by executing the real server models and Python.
  const adfRest = {
    ...restShape,
    fields: { ...restShape.fields, description: adf("paragraph", "text") },
  };
  const adfMcp = { ...mcpShape, description: "text" };
  assert.deepEqual(
    planSnapshot([adfRest], teamFieldId, implementationLabel),
    planSnapshot([adfMcp], teamFieldId, implementationLabel),
  );
  const linkedRest = {
    ...restShape,
    fields: {
      ...restShape.fields,
      issuelinks: [
        { type: { name: "Blocks", inward: "is blocked by" }, inwardIssue: { key: "RHCLOUD-9" } },
      ],
    },
  };
  const linkedMcp = {
    ...mcpShape,
    issuelinks: [
      {
        id: "1",
        type: { id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" },
        inward_issue: { id: "9", key: "RHCLOUD-9", fields: { summary: "Other" } },
      },
    ],
  };
  // The plan snapshot cannot observe links on either side (the Python reads
  // camelCase keys the simplified shape never carries), but execution
  // gating still reads the raw REST links (see the waiting assertions).
  assert.deepEqual(
    planSnapshot([linkedRest], teamFieldId, implementationLabel)["RHCLOUD-7"].blockers,
    [],
  );
  assert.deepEqual(
    planSnapshot([linkedMcp], teamFieldId, implementationLabel)["RHCLOUD-7"].blockers,
    [],
  );
  assert.equal(
    planDigest(planSnapshot([linkedRest], teamFieldId, implementationLabel)),
    planDigest(planSnapshot([linkedMcp], teamFieldId, implementationLabel)),
  );
  assert.deepEqual(linkedIssues(linkedRest).blockers, ["RHCLOUD-9"]);
});

test("unavailable or partial reads never produce actionable payloads", async () => {
  for (const option of ["searchFailure", "truncateComments", "memoryFailure", "githubFailure"]) {
    const result = await run({ [option]: true });
    assert.equal(result.status, "error", option);
    assert.doesNotMatch(result.content, /should not enter diagnostics/);
  }
  const missingMap = await run({ repos: {} });
  assert.equal(missingMap.status, "error");
  assert.match(missingMap.content, /repository map/);
});

test("missing requested planning fields fail closed while explicit null is valid", async () => {
  assert.equal((await run({ children: [ticket(4)] })).status, "start");
  for (const name of ["updated", "description", "priority", "issuetype"]) {
    const child = ticket(4);
    delete child.fields[name];
    const result = await run({ children: [child] });
    assert.equal(result.status, "error", name);
    assert.match(result.content, new RegExp(`Missing Jira field ${name}`));
  }
  const controlWithoutDescription = structuredClone(control);
  delete controlWithoutDescription.fields.description;
  assert.equal((await run({ control: controlWithoutDescription })).status, "error");
  const parentWithoutDescription = structuredClone(parent);
  delete parentWithoutDescription.fields.description;
  assert.equal((await run({ parent: parentWithoutDescription })).status, "error");
  for (const name of ["summary", "status", "parent", teamFieldId]) {
    const issue = structuredClone(control);
    delete issue.fields[name];
    assert.match((await run({ control: issue })).content, new RegExp(`Missing Jira field ${name}`));
  }
  for (const name of ["summary", "status"]) {
    const issue = structuredClone(parent);
    delete issue.fields[name];
    assert.match((await run({ parent: issue })).content, new RegExp(`Missing Jira field ${name}`));
  }
  const omittedTeam = ticket(4);
  delete omittedTeam.fields[teamFieldId];
  assert.match(
    (await run({ children: [omittedTeam] })).content,
    new RegExp(`Missing Jira field ${teamFieldId}`),
  );
  const nullTeam = ticket(4, { [teamFieldId]: null });
  assert.equal((await run({ children: [nullTeam] })).status, "start");
  const nullParent = { ...parent, fields: { summary: null, description: null, status: null } };
  assert.equal((await run({ parent: nullParent, children: [ticket(4)] })).status, "start");
  assert.match(
    (await run({ parent: { ...parent, fields: { ...parent.fields, status: {} } } })).content,
    /Invalid Jira status/,
  );
});

test("unrelated decimals do not affect snapshot validation", async () => {
  // An unused decimal inside the team field object stays accepted: the team
  // extraction only reads the id key of the (wrapped) custom field value.
  const child = ticket(4, { [teamFieldId]: { id: "team-1", score: "DECIMAL" } });
  const human = {
    id: "20",
    body: { ...adf("paragraph", "COORDINATOR: approve"), version: "DECIMAL" },
    created: "DECIMAL",
  };
  const result = project(
    await run({
      children: [child],
      comments: [human],
      extraPageFields: { timing: "DECIMAL" },
      commentTotal: "DECIMAL",
      lexemes: { DECIMAL: "1.0" },
    }),
  );
  assert.equal(result.team_id, "team-1");
  assert.equal(result.new_comments[0].body, "COORDINATOR: approve");
});

test("missing JSON reviver source fails closed only for numbers used in snapshot", () => {
  const moduleUrl = new URL("../dist/preflights/fabric-project-state/snapshot.js", import.meta.url)
    .href;
  const script = `
    const {parsePythonCompatibleJson, teamId, assertSnapshotField} = await import(${JSON.stringify(moduleUrl)});
    const original = JSON.parse;
    JSON.parse = (raw, reviver) => original(raw, function(key, value) { return reviver.call(this, key, value); });
    const issue = parsePythonCompatibleJson('{"fields":{"team":{"id":"42","ignored":1.0},"description":{"version":1}}}');
    if (teamId(issue, "team") !== "42") throw Error("unrelated number rejected");
    try { assertSnapshotField(issue, "description"); throw Error("expected rejection"); }
    catch (error) { if (!error.message.includes("Unsupported Jira number representation")) throw error; }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("ambiguous Python numeric and object representations fail closed", async () => {
  // Python json.loads preserves 1.0 and 1e0 as floats; JavaScript normally loses that distinction.
  for (const floatLexeme of ["1.0", "1e0", "9007199254740992"]) {
    const result = await run({
      children: [ticket(4, { priority: { id: "FLOAT_LEXEME" } })],
      lexemes: { FLOAT_LEXEME: floatLexeme },
    });
    assert.equal(result.status, "error", floatLexeme);
    assert.match(result.content, /Unsupported Jira number representation in snapshot/);
    assert.doesNotMatch(result.content, /upstream request failed/);
  }
  // A description object without ADF content no longer reaches the Python
  // repr path: the server's adf_to_text returns None for it, so the Python
  // runner digests an empty description and so does the port.
  const reorderedKeys = ticket(4, { description: { 2: "two", 1: "one" } });
  const reordered = project(await run({ children: [reorderedKeys] }));
  assert.equal(reordered.plan_snapshot["RHCLOUD-4"].description, "");
  // JSON-encoded string team fields carry no team through the wrapped MCP
  // shape (the string never matches the id pattern), so the child is simply
  // out of scope instead of failing the whole read.
  const encodedTeam = ticket(4, { [teamFieldId]: '{"id":1.0}' });
  const excluded = project(await run({ children: [encodedTeam] }));
  assert.deepEqual(
    excluded.tickets.map(({ key }) => key),
    [],
  );
  assert.equal(excluded.team_id, "team-1");
  // Float team ids inside the wrapped value still fail closed.
  const floatTeam = ticket(4, { [teamFieldId]: { id: "FLOAT_LEXEME" } });
  assert.match(
    (await run({ children: [floatTeam], lexemes: { FLOAT_LEXEME: "1.0" } })).content,
    /Unsupported Jira number representation in snapshot/,
  );
  const encodedComment = { id: "12", body: '{"version":1.0,"type":"doc"}' };
  assert.equal((await run({ comments: [encodedComment] })).status, "error");
  const rawParent = { ...parent, fields: { ...parent.fields, summary: "FLOAT_LEXEME" } };
  assert.match(
    (await run({ parent: rawParent, lexemes: { FLOAT_LEXEME: "1.0" } })).content,
    /Unsupported Jira number representation in snapshot/,
  );
  const rawDescription = ticket(4, { description: { version: "FLOAT_LEXEME" } });
  assert.match(
    (await run({ children: [rawDescription], lexemes: { FLOAT_LEXEME: "1e0" } })).content,
    /Unsupported Jira number representation in snapshot/,
  );
});
