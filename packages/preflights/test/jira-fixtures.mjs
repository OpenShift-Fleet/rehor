import { createPreflightRunContext } from "../dist/index.js";

/**
 * Fixture wiring for the jira preflight tests: a run context whose
 * memory-server and jira clients run against injectable fetch fakes — zero
 * network. The memory fake answers every /api/tasks query with the same
 * non-archived task list (the real server applies only the first
 * exclude_status), so capacity is derived from the task list like production.
 */

export const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** An active task (status defaults to in_progress, like the Python _mock_tasks). */
export const activeTask = (task = {}) => ({
  status: "in_progress",
  external_key: "TEST-1",
  repo: "my-repo",
  ...task,
});

export const doneTask = (task = {}) => ({ status: "done", external_key: "TEST-D", ...task });

export const pausedTask = (task = {}) => ({ status: "paused", external_key: "TEST-P", ...task });

/**
 * A REST-shaped candidate issue as the search endpoint returns it.
 * `fields` overrides merge into the defaults.
 */
export const candidateIssue = (key, fields = {}) => ({
  key,
  fields: {
    summary: `Summary of ${key}`,
    status: { name: "New" },
    priority: { name: "High" },
    issuetype: { name: "Bug" },
    labels: [],
    description: "",
    comment: { comments: [] },
    issuelinks: [],
    ...fields,
  },
});

/**
 * Jira REST router fake. `issues` maps issue keys to
 * `{ fields, comments }`; the client merges `comments` (served by the
 * dedicated paginated endpoint) into `fields.comment.comments`. `search`
 * receives each JQL and returns the matching issue list, served as one
 * final page of the enhanced `/search/jql` response shape.
 */
export function createJiraFetch({ issues = {}, search } = {}) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/jira/rest/api/2/search/jql") {
      const body = JSON.parse(init.body);
      const found = search ? await search(body.jql, body) : [];
      return jsonResponse({ issues: found, isLast: true });
    }
    const issue = /^\/jira\/rest\/api\/2\/issue\/([^/]+)$/.exec(path);
    if (issue) {
      const key = decodeURIComponent(issue[1]);
      const entry = issues[key];
      return jsonResponse(entry ? { key, fields: entry.fields ?? {} } : { key, fields: {} });
    }
    const comment = /^\/jira\/rest\/api\/2\/issue\/([^/]+)\/comment$/.exec(path);
    if (comment) {
      const key = decodeURIComponent(comment[1]);
      const list = issues[key]?.comments ?? [];
      return jsonResponse({ comments: list, startAt: 0, total: list.length });
    }
    return jsonResponse({ error: "not found" }, 404);
  };
}

/** A run context wired to the fakes: memory tasks, jira issues/search, repos. */
export function createTestContext({
  tasks = [],
  issues = {},
  search,
  repos = {},
  instanceId = "test-instance",
  proxy,
} = {}) {
  return createPreflightRunContext({
    instanceId,
    memory: {
      baseUrl: "http://memory.test",
      fetch: async () => jsonResponse({ items: tasks }),
    },
    jira: {
      baseUrl: "https://proxy.test",
      fetch: createJiraFetch({ issues, search }),
    },
    repos,
    proxy,
  });
}

/** Ten clean active tasks — the at-capacity scenario (capacity 10/10). */
export function tenCleanActiveTasks(prefix = "CAP") {
  return Array.from({ length: 10 }, (_unused, index) =>
    activeTask({
      external_key: `${prefix}-${index}`,
      status: "pr_open",
      last_addressed: "2026-07-01T12:00:00",
      metadata: { prs: [{ repo: "my-repo", number: 1, host: "github" }] },
    }),
  );
}

/** Issue-map entries for the ten-clean-active-tasks scenario. */
export function cleanIssueEntries(prefix = "CAP") {
  return Array.from({ length: 10 }, () => ({
    fields: { status: { name: "Code Review" }, labels: [], issuelinks: [] },
    comments: [],
  })).reduce((map, entry, index) => {
    map[`${prefix}-${index}`] = entry;
    return map;
  }, {});
}
