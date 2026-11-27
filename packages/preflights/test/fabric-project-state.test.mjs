import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fabricProjectState } from "../dist/preflights/fabric-project-state/index.js";
import { planDigest, planSnapshot } from "../dist/preflights/fabric-project-state/plan.js";
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
  [teamFieldId]: '{"data":[{"teamId":"team-1"}]}',
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
const approval = { id: "10", body: adf("paragraph", "approved café"), created: "2026-11-20" };
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
        if (pathname === "/service/jira/rest/api/2/search/jql") {
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
  assert.deepEqual(first.new_comments, [{ ...approval, body: "approved café" }]);
  // Golden digests from the Python reference (Fabric upstream 37d5263) on
  // identical Jira/PR data.
  assert.equal(
    first.snapshot_hash,
    "780416a2901c9f01ff04f6c089bf7ce2505be7fd742f3d26b6327bddd3a69222",
  );
  assert.equal(
    first.plan_snapshot_hash,
    "267dfb0adb31b74c0f4b8e49f1233c85b456b46e171074898fb744aeb0db4aad",
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
  assert.deepEqual(Object.keys(changed.ticket_changes.changed[0].fields), [
    "issue_type",
    "priority",
    "related",
    "summary",
  ]);
  assert.deepEqual(changed.ticket_changes.changed[0].fields.related, {
    before: [],
    after: ["RHCLOUD-7"],
  });
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
      comments: [approval, { id: "16", body: "approve" }],
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

test("coordinator comments normalize case and dynamic headings without hiding human comments", async () => {
  const comments = [
    approval,
    { id: "12", body: adf("heading", "coordinator UPDATE - Next steps") },
    { id: "13", body: "## Coordinator update - Plan\nbody" },
    { id: "14", body: "Report\nCoordinator action: continue" },
    { id: "15", body: "Coordinator update from user" },
    { id: "16", body: "h1. Coordinator update - approved" },
  ];
  const result = project(await run({ comments }));
  assert.deepEqual(
    result.new_comments.map(({ id }) => id),
    ["10", "15", "16"],
  );
  const noOwn = project(await run({ comments: [approval, comments[4], comments[5]] }));
  assert.equal(result.snapshot_hash, noOwn.snapshot_hash);
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
  // Generated using project_coordinator.py from Fabric upstream 37d5263.
  assert.equal(
    result.plan_snapshot_hash,
    "d551e815803a2e34696a33e7fa3033710ba1e03af3d22ac9c57fd90f29b77cce",
  );
  assert.equal(
    result.snapshot_hash,
    "c548b23fce722c03f4167b809836cdc7d27e7f957a7435c61b0aaf6e4ae9accf",
  );
  assert.deepEqual(result.plan_snapshot[child.key].related, ["RHCLOUD-8"]);
  assert.equal(result.plan_snapshot[child.key].priority, "High");
  const sprintOnly = ticket(4, { ...child.fields, customfield_10020: [{ id: 123 }] });
  assert.equal(project(await run({ children: [sprintOnly] })).snapshot_hash, result.snapshot_hash);
});

// Fixtures transcribed from the Python reference preflight test scenario
// (bootstrap, skip while unchanged, wake on completion). The goldens below
// were generated by running project_coordinator.py at Fabric upstream 37d5263
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
      "related": [
        "RHCLOUD-2"
      ],
      "repo_labels": [],
      "summary": "First implementation ticket",
      "team_id": "42"
    }
  },
  "plan_snapshot_hash": "0261141777cb6fa483c5c9da4491fb7baf178bad8d52015a3789eec9f653f5f8",
  "ready": [
    {
      "key": "RHCLOUD-3",
      "repo_candidates": [
        "demo"
      ]
    }
  ],
  "snapshot_hash": "87eb912626b6368f7b0325d76f44ae2935ae24bd52cb28aac2022a4a31c2070a",
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
  "approved_plan_snapshot_hash": "0261141777cb6fa483c5c9da4491fb7baf178bad8d52015a3789eec9f653f5f8",
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
      "related": [
        "RHCLOUD-2"
      ],
      "repo_labels": [],
      "summary": "First implementation ticket",
      "team_id": "42"
    }
  },
  "plan_snapshot_hash": "0261141777cb6fa483c5c9da4491fb7baf178bad8d52015a3789eec9f653f5f8",
  "ready": [],
  "snapshot_hash": "afbbc94c174e830064ace27c846e6ddcbc62baf3fd8a2dd0a25154a3c40af1c6",
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
  // in planning_labels.
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
      related: ["RHCLOUD-2"],
    },
  };
  const legacyDigest = "ca4d0fceba64320b8148d72865d99ca28e860f0223702f81b4c8ead8954afdf3";
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
    "265f22e3dc4d41ec04cc200d2cbf1ca7a8839e8c5e2a773209e21ff66f19441b",
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
});

test("plan digest inputs converge across REST and MCP issue shapes for stable fields", () => {
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

  // UNRESOLVED cross-API risk, kept visible on purpose: Cloud ADF
  // descriptions and issue links do not converge. REST returns the raw ADF
  // object (hashed as its Python str() repr) while the MCP server converts
  // descriptions to plain text, and the MCP model renames link keys to
  // inward_issue/outward_issue, which the shared camelCase extraction reads
  // as no links at all. The same logical ticket then digests differently on
  // each side until the Fabric Python side adopts a matching normalization.
  const adfRest = {
    ...restShape,
    fields: { ...restShape.fields, description: adf("paragraph", "text") },
  };
  const adfMcp = { ...mcpShape, description: "text" };
  assert.notEqual(
    planDigest(planSnapshot([adfRest], teamFieldId, implementationLabel)),
    planDigest(planSnapshot([adfMcp], teamFieldId, implementationLabel)),
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
  assert.deepEqual(
    planSnapshot([linkedRest], teamFieldId, implementationLabel)["RHCLOUD-7"].blockers,
    ["RHCLOUD-9"],
  );
  assert.deepEqual(
    planSnapshot([linkedMcp], teamFieldId, implementationLabel)["RHCLOUD-7"].blockers,
    [],
  );
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
  const child = ticket(4, { [teamFieldId]: '{"id":"team-1","score":1.0}' });
  const human = {
    id: "20",
    body: { ...adf("paragraph", "approve"), version: "DECIMAL" },
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
  assert.equal(result.new_comments[0].body, "approve");
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
  const reorderedKeys = ticket(4, { description: { 2: "two", 1: "one" } });
  const result = await run({ children: [reorderedKeys] });
  assert.equal(result.status, "error");
  assert.match(result.content, /numeric object key/);
  const encodedTeam = ticket(4, { [teamFieldId]: '{"id":1.0}' });
  assert.equal((await run({ children: [encodedTeam] })).status, "error");
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
