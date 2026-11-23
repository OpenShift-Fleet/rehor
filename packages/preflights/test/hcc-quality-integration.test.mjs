import assert from "node:assert/strict";
import test from "node:test";
import { createPreflightRunContext } from "../dist/index.js";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import { createJiraFetch } from "./jira-fixtures.mjs";

const FIXED = Date.parse("2026-11-16T10:00:00Z"); // Monday 11:00 Prague
const TOKEN = "fixture-memory-bearer";
const TASK_ID = "merge-violation:my-repo:123";
const ISSUE = "RHCLOUD-999";
const COMMENT = {
  created: "2026-11-16T09:00:00",
  body: "Re-check the flaky login test",
  author: { displayName: "Reviewer" },
};
const TRACKED = {
  external_key: TASK_ID,
  instance_id: "quality",
  status: "in_progress",
  source_type: "jira",
  metadata: { jira_key: ISSUE },
  last_addressed: "2026-11-14T12:00:00",
};

function gateway(tasks, calls) {
  const jiraFetch = createJiraFetch({
    issues: {
      [ISSUE]: {
        fields: { status: { name: "In Progress" }, labels: [], issuelinks: [] },
        comments: [COMMENT],
      },
    },
  });
  return async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    calls.push(pathname);
    if (pathname === "/api/tasks") {
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${TOKEN}`);
      const status = searchParams.get("status");
      const bucket = tasks.filter((task) => status === null || task.status === status);
      const offset = Number(searchParams.get("offset") ?? 0);
      const limit = Number(searchParams.get("limit") ?? 20);
      return Response.json({ items: bucket.slice(offset, offset + limit), total: bucket.length });
    }
    if (pathname.startsWith("/jira/")) return jiraFetch(url, init);
    assert.equal(pathname, "/github/graphql");
    const { variables } = JSON.parse(init.body);
    if (typeof variables.search === "string") {
      assert.match(variables.search, /\bis:merged\b/);
      return Response.json({
        data: {
          search: {
            nodes: [{ number: 123, mergedAt: "2026-11-16T08:30:00Z", title: "Fix login flake" }],
            pageInfo: { hasNextPage: false },
          },
        },
      });
    }
    return Response.json({
      data: {
        repository: {
          pullRequest: {
            state: "MERGED",
            reviews: { nodes: [] },
            statusCheckRollup: {
              contexts: {
                nodes: [{ __typename: "CheckRun", name: "unit-tests", conclusion: "FAILURE" }],
              },
            },
          },
        },
      },
    });
  };
}

test("real registered checks share a context: scan finds new work, feedback only resumes fresh tracked work", async () => {
  // Registry entrypoints use the wall clock. Mock this file's single test only.
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [FIXED]));
    }
    static now() {
      return FIXED;
    }
  };
  try {
    const registry = createPopulatedRegistry();
    for (const [name, tasks, expected] of [
      ["new finding", [], ["start", "skip"]],
      ["fresh feedback", [TRACKED], ["skip", "start"]],
      ["addressed feedback", [{ ...TRACKED, last_addressed: COMMENT.created }], ["skip", "skip"]],
    ]) {
      const calls = [];
      const fetch = gateway(tasks, calls);
      const ctx = createPreflightRunContext({
        instanceId: "quality",
        memory: { baseUrl: "http://memory.test", token: TOKEN, fetch },
        jira: { baseUrl: "https://proxy.test", fetch },
        proxy: { baseUrl: "https://proxy.test", fetch },
        repos: { "my-repo": { upstream: "https://github.com/org/my-repo" } },
      });
      const outcomes = [];
      for (const id of ["hcc-merged-pr-violations", "hcc-quality-jira-feedback"]) {
        const check = registry.get(id);
        outcomes.push(await check.run(ctx, check.input.parse({})));
      }
      assert.deepEqual(
        outcomes.map((result) => result.status),
        expected,
        name,
      );
      assert.ok(calls.includes("/github/graphql"), name);
      assert.deepEqual(
        calls.filter((path) => path.startsWith("/jira/")),
        tasks.length
          ? [`/jira/rest/api/2/issue/${ISSUE}`, `/jira/rest/api/2/issue/${ISSUE}/comment`]
          : [],
        name,
      );
      assert.ok(
        outcomes.every(({ content }) => !content.includes(TOKEN)),
        name,
      );
      const [scan, feedback] = outcomes;
      if (scan.status === "start") assert.ok(scan.content.includes(`Task ID: ${TASK_ID}`));
      if (feedback.status === "start") {
        assert.ok(feedback.content.includes(`Task ID: ${TASK_ID}`));
        assert.ok(feedback.content.includes(`Jira key: ${ISSUE}`));
        assert.ok(feedback.content.includes(COMMENT.body));
      }
    }
  } finally {
    globalThis.Date = RealDate;
  }
});
