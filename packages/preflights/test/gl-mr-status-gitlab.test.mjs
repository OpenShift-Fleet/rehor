import assert from "node:assert/strict";
import test from "node:test";
import { createGitlabClient, GITLAB_PATH_PREFIX } from "../dist/preflights/gl-mr-status/gitlab.js";
import { PreflightHttpError } from "../dist/shared/http.js";

/**
 * Transport tests for the GitLab client of the gl-mr-status preflight —
 * the port of the Python `gl_mr` / `gl_mr_notes` glab-CLI wrappers
 * (bot/tests/test_preflight_shared.py: gl_mr_notes pagination + system-note
 * filtering), adapted to the injectable-fetch seam. Gitbeaker builds the
 * API paths; every request routes through the auth proxy's GitLab path
 * prefix and the injected fetch, so nothing here touches the network.
 */

const PROXY_BASE = "https://proxy.example/devbot-proxy";
const ROUTE = `${PROXY_BASE}${GITLAB_PATH_PREFIX}`;

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function note(username, createdAt, body, system = false, extra = {}) {
  return { author: { username }, created_at: createdAt, body, system, ...extra };
}

test("getMergeRequest composes the proxy route with the encoded project path", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ state: "opened", has_conflicts: true });
  };
  const client = createGitlabClient({ baseUrl: PROXY_BASE, fetch: fetchImpl });

  const mr = await client.getMergeRequest("team/project", 42);

  assert.equal(mr.state, "opened");
  assert.equal(mr.has_conflicts, true);
  assert.equal(client.route, ROUTE);
  assert.deepEqual(
    calls.map((call) => call.url),
    [`${ROUTE}/api/v4/projects/team%2Fproject/merge_requests/42`],
  );
  assert.equal(calls[0].init.method, "GET");
  const headerNames = Object.keys(calls[0].init.headers ?? {}).map((name) => name.toLowerCase());
  assert.equal(
    headerNames.some(
      (name) => name === "authorization" || name === "private-token" || name === "job-token",
    ),
    false,
    "no credentials are sent — the auth proxy injects them upstream",
  );
});

test("getMergeRequest honors a custom path prefix", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return jsonResponse({ state: "opened" });
  };
  const client = createGitlabClient({
    baseUrl: PROXY_BASE,
    pathPrefix: "/gl-alt",
    fetch: fetchImpl,
  });

  await client.getMergeRequest("team/project", 42);

  assert.equal(
    calls[0],
    "https://proxy.example/devbot-proxy/gl-alt/api/v4/projects/team%2Fproject/merge_requests/42",
  );
});

test("getMergeRequest rejects an invalid proxy base URL", () => {
  assert.throws(() => createGitlabClient({ baseUrl: "" }), /baseUrl/);
  assert.throws(() => createGitlabClient({ baseUrl: "not-a-url" }), /baseUrl/);
});

test("getMergeRequest maps a 404 to a route-unavailable PreflightHttpError", async () => {
  const fetchImpl = async () => new Response("no such route", { status: 404 });
  const client = createGitlabClient({ baseUrl: PROXY_BASE, fetch: fetchImpl });

  await assert.rejects(
    client.getMergeRequest("team/project", 42),
    (error) =>
      error instanceof PreflightHttpError &&
      error.status === 404 &&
      error.routeUnavailable === true &&
      error.route === ROUTE &&
      error.url === `${ROUTE}/api/v4/projects/team%2Fproject/merge_requests/42`,
  );
});

test("getMergeRequest maps a non-404 failure to a PreflightHttpError", async () => {
  const fetchImpl = async () => new Response("boom", { status: 500 });
  const client = createGitlabClient({ baseUrl: PROXY_BASE, fetch: fetchImpl });

  await assert.rejects(
    client.getMergeRequest("team/project", 42),
    (error) =>
      error instanceof PreflightHttpError &&
      error.status === 500 &&
      error.routeUnavailable === false,
  );
});

test("getMergeRequest maps a network failure to a statusless PreflightHttpError", async () => {
  const fetchImpl = async () => {
    throw new Error("connection refused");
  };
  const client = createGitlabClient({ baseUrl: PROXY_BASE, fetch: fetchImpl });

  await assert.rejects(
    client.getMergeRequest("team/project", 42),
    (error) => error instanceof PreflightHttpError && error.status === null,
  );
});

test("getMergeRequest rejects a non-JSON response body", async () => {
  const fetchImpl = async () =>
    new Response("<html>gateway</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  const client = createGitlabClient({ baseUrl: PROXY_BASE, fetch: fetchImpl });

  await assert.rejects(
    client.getMergeRequest("team/project", 42),
    (error) => error instanceof PreflightHttpError && /non-JSON/.test(error.message),
  );
});

test("listMergeRequestNotes pages through results with per_page=50 sorted ascending", async () => {
  const calls = [];
  const notesUrl = `${ROUTE}/api/v4/projects/team%2Fproject/merge_requests/42/notes`;
  const fetchImpl = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target === `${notesUrl}?sort=asc&per_page=50`) {
      return jsonResponse([note("reviewer", "2026-07-01T10:00:00Z", "note")], {
        headers: {
          link: `<${notesUrl}?page=2&per_page=50&sort=asc>; rel="next", <${notesUrl}?page=1&per_page=50&sort=asc>; rel="first"`,
        },
      });
    }
    if (target === `${notesUrl}?page=2&per_page=50&sort=asc`) {
      return jsonResponse([note("second", "2026-07-02T10:00:00Z", "later note")]);
    }
    throw new Error(`unexpected URL: ${target}`);
  };
  const client = createGitlabClient({ baseUrl: PROXY_BASE, fetch: fetchImpl });

  const notes = await client.listMergeRequestNotes("team/project", 42);

  assert.deepEqual(calls, [
    `${notesUrl}?sort=asc&per_page=50`,
    `${notesUrl}?page=2&per_page=50&sort=asc`,
  ]);
  assert.deepEqual(notes, [
    { a: "reviewer", t: "2026-07-01T10:00:00Z", b: "note" },
    { a: "second", t: "2026-07-02T10:00:00Z", b: "later note" },
  ]);
});

test("listMergeRequestNotes filters system notes and maps missing fields", async () => {
  const fetchImpl = async () =>
    jsonResponse([
      note("reviewer", "2026-07-01T10:00:00", "looks good"),
      note("gitlab", "2026-07-01T10:01:00", "merged", true),
      { created_at: "2026-07-01T10:02:00", body: "anonymous", system: false },
    ]);
  const client = createGitlabClient({ baseUrl: PROXY_BASE, fetch: fetchImpl });

  const notes = await client.listMergeRequestNotes("team/project", 42);

  assert.deepEqual(notes, [
    { a: "reviewer", t: "2026-07-01T10:00:00", b: "looks good" },
    { a: "?", t: "2026-07-01T10:02:00", b: "anonymous" },
  ]);
});
