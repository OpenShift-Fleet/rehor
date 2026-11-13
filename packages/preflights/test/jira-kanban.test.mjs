import assert from "node:assert/strict";
import test from "node:test";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import {
  activeTask,
  candidateIssue,
  cleanIssueEntries,
  createTestContext,
  tenCleanActiveTasks,
} from "./jira-fixtures.mjs";

const registry = createPopulatedRegistry();
const jiraKanban = registry.get("jira-kanban");

const KANBAN_PARAMS = { project: "LCORE", label: "hcc-ai-lightspeed-core" };

const runKanban = (ctx, withParams = {}) =>
  jiraKanban.run(ctx, jiraKanban.input.parse({ ...KANBAN_PARAMS, ...withParams }));

const cleanJiraEntry = {
  fields: { status: { name: "Code Review" }, labels: [], issuelinks: [] },
  comments: [],
};

// --- input schema (ported from the _parse_statuses tests) ---

test("default statuses are New, Backlog, To Do", () => {
  const params = jiraKanban.input.parse(KANBAN_PARAMS);
  assert.deepEqual(params.statuses, ["New", "Backlog", "To Do"]);
  assert.equal(params.interrupted_retry_minutes, 30);
  assert.equal(params.jql_extra, undefined);
  assert.equal(params.email, undefined);
});

test("custom statuses are used as-is", () => {
  const params = jiraKanban.input.parse({
    ...KANBAN_PARAMS,
    statuses: ["Open", "In Review", "Blocked"],
  });
  assert.deepEqual(params.statuses, ["Open", "In Review", "Blocked"]);
});

// --- run() decision logic (ported, params instead of env) ---

test("no active tasks and no candidates returns skip", async () => {
  const ctx = createTestContext({ tasks: [], search: async () => [] });
  const result = await runKanban(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /No eligible work/);
  assert.match(result.content, /No eligible work candidates in kanban backlog/);
});

test("no active tasks with candidates returns start", async () => {
  const ctx = createTestContext({
    tasks: [],
    search: async () => [
      candidateIssue("LCORE-1", {
        summary: "Fix CVE",
        labels: ["Security"],
        description: "Fix it",
      }),
    ],
  });
  const result = await runKanban(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /LCORE-1/);
  assert.match(result.content, /-> 1 candidate\(s\) found/);
  assert.match(result.content, /-> Top pick: LCORE-1/);
});

test("candidates without repo labels still start (unlike sprint)", async () => {
  const ctx = createTestContext({
    tasks: [],
    search: async () => [
      candidateIssue("LCORE-10", {
        summary: "CVE in lightspeed-stack",
        labels: ["Security", "pscomponent:lightspeed-core/lightspeed-stack-rhel9"],
        description: "Vulnerable package found",
      }),
    ],
  });
  const result = await runKanban(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /LCORE-10/);
  assert.match(result.content, /agent determines repo from ticket content/);
});

test("active task with feedback returns start", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "LCORE-2",
        status: "pr_open",
        repo: "lightspeed-stack",
        last_addressed: "2026-06-30T10:00:00",
        metadata: { prs: [{ repo: "lightspeed-stack", number: 1, host: "github" }] },
      }),
    ],
    issues: {
      "LCORE-2": {
        fields: { status: { name: "In Progress" }, labels: [], issuelinks: [] },
        comments: [
          {
            created: "2026-07-01T10:00:00",
            body: "Can you check this?",
            author: { displayName: "Human" },
          },
        ],
      },
    },
  });
  const result = await runKanban(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /JIRA FEEDBACK/);
});

test("active tasks all clean, no candidates returns skip", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "LCORE-3",
        status: "pr_open",
        repo: "lightspeed-stack",
        last_addressed: "2026-07-01T12:00:00",
        metadata: { prs: [{ repo: "lightspeed-stack", number: 1, host: "github" }] },
      }),
    ],
    issues: { "LCORE-3": cleanJiraEntry },
    search: async () => [],
  });
  const result = await runKanban(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /No eligible work/);
});

test("active tasks all clean with candidates returns start", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "LCORE-3",
        status: "pr_open",
        repo: "lightspeed-stack",
        last_addressed: "2026-07-01T12:00:00",
        metadata: { prs: [{ repo: "lightspeed-stack", number: 1, host: "github" }] },
      }),
    ],
    issues: { "LCORE-3": cleanJiraEntry },
    search: async () => [
      candidateIssue("LCORE-99", {
        summary: "New CVE",
        labels: ["Security"],
        description: "Build it",
      }),
    ],
  });
  const result = await runKanban(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /LCORE-99/);
});

test("at capacity with investigation tickets returns start", async () => {
  const ctx = createTestContext({
    tasks: tenCleanActiveTasks(),
    issues: cleanIssueEntries(),
    search: async (jql) =>
      jql.includes("needs-investigation")
        ? [
            candidateIssue("LCORE-4", {
              summary: "Investigate outage",
              labels: ["needs-investigation"],
              description: "Look into it",
            }),
          ]
        : [],
  });
  const result = await runKanban(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /Investigation/);
});

test("at capacity without investigation tickets returns skip", async () => {
  const ctx = createTestContext({
    tasks: tenCleanActiveTasks(),
    issues: cleanIssueEntries(),
    search: async () => [],
  });
  const result = await runKanban(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /capacity/i);
});

test("interrupted task returns start", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "LCORE-5",
        repo: "lightspeed-stack",
        metadata: { last_step: "implemented" },
      }),
    ],
    issues: { "LCORE-5": cleanJiraEntry },
  });
  const result = await runKanban(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /INTERRUPTED/);
});

// --- candidate query construction (ported from the JQL tests) ---

test("default candidate query filters by project, statuses, label, and empty assignee", async () => {
  const jqls = [];
  const ctx = createTestContext({
    tasks: [],
    search: async (jql) => {
      jqls.push(jql);
      return [];
    },
  });
  await runKanban(ctx);
  assert.equal(jqls.length, 1);
  assert.equal(
    jqls[0],
    'project = LCORE AND status IN ("New", "Backlog", "To Do") AND labels = hcc-ai-lightspeed-core AND assignee is EMPTY ORDER BY priority DESC, created ASC',
  );
});

test("bot-assigned fallback query runs when email is set", async () => {
  const jqls = [];
  const ctx = createTestContext({
    tasks: [],
    search: async (jql) => {
      jqls.push(jql);
      return [];
    },
  });
  await runKanban(ctx, { email: "bot@test.com" });
  assert.equal(jqls.length, 2);
  assert.match(jqls[1], /assignee = "bot@test\.com"/);
});

test("jql_extra is appended to candidate queries", async () => {
  const jqls = [];
  const ctx = createTestContext({
    tasks: [],
    search: async (jql) => {
      jqls.push(jql);
      return [];
    },
  });
  await runKanban(ctx, { jql_extra: "type = Vulnerability" });
  assert.equal(jqls.length, 1);
  assert.match(jqls[0], /AND assignee is EMPTY AND type = Vulnerability ORDER BY/);
});

test("jql_extra with the documented leading AND yields a single AND", async () => {
  // The spike-doc example form: jql_extra: 'AND priority not in ("Undefined")'
  // (docs/preflight-rework-spike-input.md) — the optional leading AND is
  // normalized away instead of producing "AND AND".
  const jqls = [];
  const ctx = createTestContext({
    tasks: [],
    search: async (jql) => {
      jqls.push(jql);
      return [];
    },
  });
  await runKanban(ctx, { jql_extra: 'AND priority not in ("Undefined")' });
  assert.equal(jqls.length, 1);
  assert.equal(
    jqls[0],
    'project = LCORE AND status IN ("New", "Backlog", "To Do") AND labels = hcc-ai-lightspeed-core AND assignee is EMPTY AND priority not in ("Undefined") ORDER BY priority DESC, created ASC',
  );
});

test("jql_extra leading AND is normalized case-insensitively across whitespace", async () => {
  const jqls = [];
  const ctx = createTestContext({
    tasks: [],
    search: async (jql) => {
      jqls.push(jql);
      return [];
    },
  });
  await runKanban(ctx, { jql_extra: "  and\tpriority = Highest" });
  assert.equal(jqls.length, 1);
  assert.match(jqls[0], /AND assignee is EMPTY AND priority = Highest ORDER BY/);
  assert.doesNotMatch(jqls[0], /AND AND/i);
});

test("whitespace-only jql_extra adds no clause", async () => {
  const jqls = [];
  const ctx = createTestContext({
    tasks: [],
    search: async (jql) => {
      jqls.push(jql);
      return [];
    },
  });
  await runKanban(ctx, { jql_extra: "   " });
  assert.equal(jqls.length, 1);
  assert.equal(
    jqls[0],
    'project = LCORE AND status IN ("New", "Backlog", "To Do") AND labels = hcc-ai-lightspeed-core AND assignee is EMPTY ORDER BY priority DESC, created ASC',
  );
});

test("documented jql_extra form reaches the unassigned and bot-assigned queries", async () => {
  const jqls = [];
  const ctx = createTestContext({
    tasks: [],
    search: async (jql) => {
      jqls.push(jql);
      return [];
    },
  });
  await runKanban(ctx, { email: "bot@test.com", jql_extra: 'AND priority not in ("Undefined")' });
  assert.equal(jqls.length, 2);
  assert.match(jqls[0], /AND assignee is EMPTY AND priority not in \("Undefined"\) ORDER BY/);
  assert.match(
    jqls[1],
    /AND assignee = "bot@test\.com" AND priority not in \("Undefined"\) ORDER BY/,
  );
  for (const jql of jqls) {
    assert.doesNotMatch(jql, /AND AND/i);
  }
});

test("documented jql_extra form reaches the at-capacity investigation query", async () => {
  const jqls = [];
  const ctx = createTestContext({
    tasks: tenCleanActiveTasks(),
    issues: cleanIssueEntries(),
    search: async (jql) => {
      jqls.push(jql);
      return [];
    },
  });
  await runKanban(ctx, { jql_extra: 'AND priority not in ("Undefined")' });
  assert.equal(jqls.length, 1);
  assert.match(jqls[0], /labels = needs-investigation/);
  assert.match(
    jqls[0],
    /AND status IN \("New", "Backlog", "To Do"\) AND priority not in \("Undefined"\) ORDER BY/,
  );
  assert.doesNotMatch(jqls[0], /AND AND/i);
});

test("custom statuses appear in the candidate query", async () => {
  const jqls = [];
  const ctx = createTestContext({
    tasks: [],
    search: async (jql) => {
      jqls.push(jql);
      return [];
    },
  });
  await runKanban(ctx, { statuses: ["Open", "Ready"] });
  assert.equal(jqls.length, 1);
  assert.match(jqls[0], /"Open"/);
  assert.match(jqls[0], /"Ready"/);
});

test("investigation query filters by label and needs-investigation", async () => {
  const jqls = [];
  const ctx = createTestContext({
    tasks: tenCleanActiveTasks(),
    issues: cleanIssueEntries(),
    search: async (jql) => {
      jqls.push(jql);
      return [];
    },
  });
  await runKanban(ctx);
  assert.equal(jqls.length, 1);
  assert.match(jqls[0], /labels = hcc-ai-lightspeed-core/);
  assert.match(jqls[0], /labels = needs-investigation/);
  assert.match(jqls[0], /project = LCORE/);
});
