import assert from "node:assert/strict";
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
            return Response.json(
              options.searchFailure
                ? { isLast: true }
                : { issues: [{ key: control.key }], isLast: true },
            );
          }
          assert.equal(query.jql, `parent = "${parentKey}" ORDER BY key ASC`);
          assert.ok(query.fields.includes(teamFieldId));
          if (!query.nextPageToken)
            return Response.json({
              issues: [controlIssue, ...children.slice(0, 1)],
              nextPageToken: "next",
              isLast: false,
            });
          assert.equal(query.nextPageToken, "next");
          return Response.json({ issues: children.slice(1), isLast: true });
        }
        assert.equal(init.method, "GET");
        if (pathname.endsWith(`/issue/${control.key}/comment`)) {
          const startAt = Number(searchParams.get("startAt"));
          return Response.json(
            options.truncateComments
              ? { comments: [], total: 1, startAt }
              : { comments: comments.slice(startAt, startAt + 1), total: comments.length, startAt },
          );
        }
        if (pathname.endsWith(`/issue/${control.key}`)) return Response.json(controlIssue);
        if (pathname.endsWith(`/issue/${parentKey}`)) return Response.json(parent);
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
    "ca45e7408e57f33c07474da21b0673ee492ecf7602507f90e0f5c5bb6ae417d7",
  );
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

test("ownership and plan checks suppress runnable work; orphan control has its own stable gate", async () => {
  const owned = ticket(4, { assignee: { accountId: "owner" } });
  const outside = ticket(5, { labels: ["phase:01", "repo:foreign"] });
  const backlog = ticket(6);
  const gated = project(
    await run({ children: [owned, outside, backlog], params: { includeBacklog: false } }),
  );
  assert.deepEqual(gated.ready, []);
  assert.deepEqual(gated.gaps, [
    "RHCLOUD-4 is not unassigned in a not-started status",
    "RHCLOUD-5 has a repo outside the control ticket's allowed repos",
    "RHCLOUD-6 is outside the active sprint and backlog intake is disabled",
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
