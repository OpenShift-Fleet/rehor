import assert from "node:assert/strict";
import test from "node:test";
import { isPreflightHttpError } from "../dist/shared/http.js";
import { createJiraClient, JIRA_PATH_PREFIX } from "../dist/shared/jira.js";

const jsonResponse = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** An Atlassian Document Format document with one paragraph per argument. */
const adfDoc = (...paragraphs) => ({
  type: "doc",
  version: 1,
  content: paragraphs.map((text) => ({
    type: "paragraph",
    content: text === "" ? [] : [{ type: "text", text }],
  })),
});

test("jira client declares the /jira route prefix on the proxy", () => {
  assert.equal(JIRA_PATH_PREFIX, "/jira");
});

test("jira client searches via POST /rest/api/2/search/jql with fields", async () => {
  const calls = [];
  const client = createJiraClient({
    baseUrl: "https://proxy.example/devbot-proxy",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ issues: [{ key: "REHOR-1" }], isLast: true });
    },
  });
  const issues = await client.searchIssues("project = REHOR", {
    fields: ["summary", "status"],
  });
  assert.deepEqual(issues, [{ key: "REHOR-1" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://proxy.example/devbot-proxy/jira/rest/api/2/search/jql");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    jql: "project = REHOR",
    maxResults: 50,
    fields: ["summary", "status"],
  });
});

test("jira client requests the default field set when fields are omitted", async () => {
  const bodies = [];
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse({ issues: [], isLast: true });
    },
  });
  await client.searchIssues("jql");
  // search/jql returns only ids unless fields are requested, so an omitted
  // `fields` option keeps asking for Jira's classic default (navigable) set.
  assert.deepEqual(bodies[0].fields, ["*navigable"]);
});

test("jira client paginates search with nextPageToken until isLast", async () => {
  const pages = [
    { issues: [{ key: "A" }, { key: "B" }], isLast: false, nextPageToken: "token-1" },
    { issues: [{ key: "C" }], isLast: true },
  ];
  const bodies = [];
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      return jsonResponse(pages[body.nextPageToken === undefined ? 0 : 1]);
    },
  });
  const issues = await client.searchIssues("jql");
  assert.equal(issues.length, 3);
  assert.deepEqual(
    bodies.map((body) => body.nextPageToken),
    [undefined, "token-1"],
  );
});

test("jira client stops on the final page that omits the token entirely", async () => {
  let calls = 0;
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async () => {
      calls += 1;
      // JRACLOUD-92184: the last page carries no nextPageToken key at all.
      return jsonResponse({ issues: [{ key: "A" }], isLast: true });
    },
  });
  const issues = await client.searchIssues("jql");
  assert.equal(issues.length, 1);
  assert.equal(calls, 1);
});

test("jira client treats an empty continuation token as the final page", async () => {
  let calls = 0;
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async () => {
      calls += 1;
      return jsonResponse({ issues: [{ key: "A" }], isLast: true, nextPageToken: "" });
    },
  });
  const issues = await client.searchIssues("jql");
  assert.equal(issues.length, 1);
  assert.equal(calls, 1);
});

test("jira client keeps paging when an empty page carries a continuation token", async () => {
  const pages = [
    { issues: [], isLast: false, nextPageToken: "token-1" },
    { issues: [{ key: "A" }], isLast: true },
  ];
  let calls = 0;
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async () => {
      const page = pages[calls];
      calls += 1;
      return jsonResponse(page);
    },
  });
  const issues = await client.searchIssues("jql");
  assert.deepEqual(issues, [{ key: "A" }]);
  assert.equal(calls, 2);
});

test("jira client stops paging early once the requested limit is reached", async () => {
  let calls = 0;
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async () => {
      calls += 1;
      const issues = Array.from({ length: 50 }, (_unused, index) => ({ key: `K-${index}` }));
      return jsonResponse({ issues, isLast: false, nextPageToken: "token-1" });
    },
  });
  const issues = await client.searchIssues("jql", { limit: 10 });
  assert.equal(issues.length, 10);
  assert.equal(calls, 1);
});

test("jira client applies the limit across pages", async () => {
  const pages = [
    { issues: [{ key: "A" }, { key: "B" }], isLast: false, nextPageToken: "token-1" },
    {
      issues: [{ key: "C" }, { key: "D" }, { key: "E" }],
      isLast: true,
    },
  ];
  let calls = 0;
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async () => {
      const page = pages[calls];
      calls += 1;
      return jsonResponse(page);
    },
  });
  const issues = await client.searchIssues("jql", { limit: 3 });
  assert.deepEqual(
    issues.map((issue) => issue.key),
    ["A", "B", "C"],
  );
  assert.equal(calls, 2);
});

test("jira client rejects a repeated continuation token instead of looping", async () => {
  let calls = 0;
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async () => {
      calls += 1;
      return jsonResponse({ issues: [{ key: "A" }], isLast: false, nextPageToken: "same" });
    },
  });
  await assert.rejects(
    () => client.searchIssues("jql"),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /repeated continuation token/);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("jira client rejects a non-final page that carries no continuation token", async () => {
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async () => jsonResponse({ issues: [{ key: "A" }], isLast: false }),
  });
  await assert.rejects(
    () => client.searchIssues("jql"),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /isLast=false.*no nextPageToken|no nextPageToken.*isLast=false/);
      return true;
    },
  );
});

test("jira client flattens ADF rich text from search results", async () => {
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async () =>
      jsonResponse({
        issues: [
          {
            key: "REHOR-1",
            fields: {
              summary: "s",
              description: adfDoc("First paragraph", "Second paragraph"),
              comment: {
                comments: [{ body: adfDoc("Comment body") }, { body: "plain string body" }],
              },
            },
          },
        ],
        isLast: true,
      }),
  });
  const issues = await client.searchIssues("jql");
  assert.equal(issues[0].fields.description, "First paragraph\nSecond paragraph");
  assert.equal(issues[0].fields.comment.comments[0].body, "Comment body");
  assert.equal(issues[0].fields.comment.comments[1].body, "plain string body");
});

test("jira client flattens ADF hardBreaks into newlines", async () => {
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async () =>
      jsonResponse({
        issues: [
          {
            key: "REHOR-1",
            fields: {
              description: {
                type: "doc",
                version: 1,
                content: [
                  {
                    type: "paragraph",
                    content: [
                      { type: "text", text: "line a" },
                      { type: "hardBreak" },
                      { type: "text", text: "line b" },
                    ],
                  },
                ],
              },
            },
          },
        ],
        isLast: true,
      }),
  });
  const issues = await client.searchIssues("jql");
  assert.equal(issues[0].fields.description, "line a\nline b");
});

test("jira client fetches an issue with comma-joined fields", async () => {
  const calls = [];
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) => {
      calls.push(url);
      return jsonResponse({ key: "REHOR-1", fields: { summary: "s" } });
    },
  });
  const issue = await client.getIssue("REHOR-1", { fields: ["summary", "status"] });
  assert.equal(issue.key, "REHOR-1");
  // URLSearchParams percent-encodes the comma; Jira decodes it identically.
  assert.deepEqual(calls, [
    "https://proxy.example/jira/rest/api/2/issue/REHOR-1?fields=summary%2Cstatus",
  ]);
});

test("jira client URL-encodes issue keys", async () => {
  let url;
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async (requestUrl) => {
      url = requestUrl;
      return jsonResponse({});
    },
  });
  await client.getIssue("KEY 1");
  assert.equal(url, "https://proxy.example/jira/rest/api/2/issue/KEY%201");
});

test("jira client paginates comments through the dedicated endpoint", async () => {
  const pages = [
    { comments: [{ body: "one" }, { body: "two" }], startAt: 0, total: 3 },
    { comments: [{ body: "three" }], startAt: 2, total: 3 },
  ];
  const calls = [];
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) => {
      calls.push(url);
      const startAt = Number(new URL(url).searchParams.get("startAt"));
      return jsonResponse(pages[startAt / 2]);
    },
  });
  const comments = await client.getIssueComments("REHOR-1");
  assert.equal(comments.length, 3);
  assert.deepEqual(calls, [
    "https://proxy.example/jira/rest/api/2/issue/REHOR-1/comment?startAt=0&maxResults=50",
    "https://proxy.example/jira/rest/api/2/issue/REHOR-1/comment?startAt=2&maxResults=50",
  ]);
});

test("jira client merges paginated comments into the issue — no comment cap", async () => {
  const calls = [];
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith("/comment?startAt=0&maxResults=50")) {
        return jsonResponse({
          comments: [{ body: "old" }, { body: "new" }],
          startAt: 0,
          total: 2,
        });
      }
      return jsonResponse({
        key: "REHOR-1",
        fields: { summary: "s", status: { name: "In Progress" } },
      });
    },
  });
  const issue = await client.getIssueWithComments("REHOR-1", {
    fields: ["summary", "status", "comment", "updated"],
  });
  assert.equal(issue.key, "REHOR-1");
  assert.equal(issue.fields.summary, "s");
  assert.deepEqual(issue.fields.comment, { comments: [{ body: "old" }, { body: "new" }] });
  // The issue GET must not ask for the embedded comment field; comments come
  // from the paginated endpoint, which has no oldest-first cap.
  assert.equal(
    calls[0],
    "https://proxy.example/jira/rest/api/2/issue/REHOR-1?fields=summary%2Cstatus%2Cupdated",
  );
});

test("jira client uses the configured API version", async () => {
  let url;
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    apiVersion: "3",
    fetch: async (requestUrl) => {
      url = requestUrl;
      return jsonResponse({ issues: [], isLast: true });
    },
  });
  await client.searchIssues("jql");
  assert.equal(url, "https://proxy.example/jira/rest/api/3/search/jql");
});

test("jira client sends no Authorization header — the proxy injects credentials", async () => {
  let seen;
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async (_url, init) => {
      seen = init;
      return jsonResponse({ issues: [], isLast: true });
    },
  });
  await client.searchIssues("jql");
  assert.equal(seen.headers.Authorization, undefined);
});

test("jira client surfaces upstream failures as execution errors", async () => {
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async (_url, init) =>
      new Response("failure", { status: init.method === "POST" ? 400 : 404 }),
  });
  await assert.rejects(
    () => client.searchIssues("bogus"),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 400);
      assert.equal(error.route, "https://proxy.example/jira");
      return true;
    },
  );
  await assert.rejects(
    () => client.getIssue("REHOR-404"),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 404);
      assert.equal(error.routeUnavailable, true);
      return true;
    },
  );
});

test("jira client surfaces the retired search endpoint's 410 — no legacy fallback", async () => {
  const client = createJiraClient({
    baseUrl: "https://proxy.example",
    fetch: async () =>
      new Response("The requested API has been removed", {
        status: 410,
        headers: { "Content-Type": "text/plain" },
      }),
  });
  await assert.rejects(
    () => client.searchIssues("jql"),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 410);
      return true;
    },
  );
});
