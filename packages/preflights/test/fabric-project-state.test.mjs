import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fabricProjectState } from "../dist/preflights/fabric-project-state/index.js";
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
  // Golden digest from the Python fingerprint on identical Jira/PR data.
  assert.equal(
    first.snapshot_hash,
    "780416a2901c9f01ff04f6c089bf7ce2505be7fd742f3d26b6327bddd3a69222",
  );
  assert.equal(
    first.plan_snapshot_hash,
    "2a2b0702878e5003989796314f878fc7b721330096348f7e4f32f7b82881bacc",
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
    "updated",
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
  assert.equal(result.plan_snapshot["RHCLOUD-4"].assignee, false);
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
  // Generated using project_coordinator.py from Fabric main 5208712bd167.
  assert.equal(
    result.plan_snapshot_hash,
    "9744b7200d47e03959ea2d7df947763aba024fe7fc5bdd92bf442f75978c8e88",
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
