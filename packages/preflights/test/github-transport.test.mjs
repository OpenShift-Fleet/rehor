import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createGitHubClient } from "../dist/shared/github.js";
import { isPreflightHttpError } from "../dist/shared/http.js";

/**
 * Transport-level tests for the GitHub client: every outgoing SDK URL is
 * constrained to the configured proxy route (origin and route path
 * boundary). The gateway rewrites pagination Link headers and redirect
 * Location headers into gateway-relative "/github/..." paths; the client
 * normalizes those onto the configured route (never double-prefixing, never
 * dropping an external path prefix from the proxy base URL) and follows
 * same-route redirects manually so a redirect can never steer a request off
 * the route or bypass the wrapper through the native fetch auto-follow.
 */

const jsonResponse = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const graphqlResponse = (pullRequest) => ({ data: { repository: { pullRequest } } });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const abortError = () => {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
};

/** Promise that settles after `ms`, or rejects as soon as `signal` aborts. */
const delayUntil = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const PROXY_BASE = "https://proxy.example/devbot-proxy";
const ROUTE = `${PROXY_BASE}/github`;
const PULLS_URL = `${ROUTE}/repos/org/repo/pulls/7/comments`;
const ISSUES_URL = `${ROUTE}/repos/org/repo/issues/7/comments`;

test("transport normalizes gateway-relative Link pagination onto the configured route", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: PROXY_BASE,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("/pulls/7/comments")) {
        if (!url.includes("page=")) {
          return jsonResponse([{ user: { login: "a" }, created_at: "t1", body: "one" }], 200, {
            // The gateway cannot infer its public origin, so it emits paths
            // relative to its own root.
            link: '</github/repos/org/repo/pulls/7/comments?page=2>; rel="next"',
          });
        }
        return jsonResponse([{ user: { login: "b" }, created_at: "t2", body: "two" }]);
      }
      return jsonResponse([]);
    },
  });
  const comments = await client.getPrComments("org/repo", 7);
  // Octokit's endpoint merger prepends its baseUrl to the gateway-relative
  // path; the transport must strip the duplicated prefix so the page request
  // lands on the route exactly once.
  assert.deepEqual(
    calls.map((call) => call.url),
    [PULLS_URL, `${PULLS_URL}?page=2`, ISSUES_URL],
  );
  assert.deepEqual(comments, [
    { a: "a", t: "t1", b: "one" },
    { a: "b", t: "t2", b: "two" },
  ]);
  // Redirects are handled by the wrapper, never by the native auto-follow.
  for (const call of calls) {
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal(call.init.headers.authorization, undefined);
  }
});

test("transport rejects an absolute off-site Link URL before requesting it", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: PROXY_BASE,
    fetch: async (url) => {
      calls.push(url);
      if (calls.length > 6) {
        throw new Error(`runaway pagination followed ${url}`);
      }
      if (url.includes("/comments")) {
        return jsonResponse([], 200, {
          link: '<https://evil.example/repos/org/repo/pulls/7/comments?page=2>; rel="next"',
        });
      }
      return jsonResponse([]);
    },
  });
  await assert.rejects(
    () => client.getPrComments("org/repo", 7),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, null);
      assert.equal(error.route, ROUTE);
      assert.match(error.message, /evil\.example/);
      assert.match(error.message, /proxy route/);
      return true;
    },
  );
  // Rejected before the underlying transport ran any follow-up page; the
  // second endpoint was still tried and also rejected.
  assert.equal(calls.length, 2);
  for (const url of calls) {
    assert.ok(url.startsWith(ROUTE), `unexpected transport url ${url}`);
  }
});

test("transport rejects an absolute upstream Link URL instead of rebasing it", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: PROXY_BASE,
    fetch: async (url) => {
      calls.push(url);
      if (calls.length > 6) {
        throw new Error(`runaway pagination followed ${url}`);
      }
      if (url.includes("/comments")) {
        return jsonResponse([], 200, {
          link: '<https://api.github.com/repos/org/repo/pulls/7/comments?page=2>; rel="next"',
        });
      }
      return jsonResponse([]);
    },
  });
  await assert.rejects(
    () => client.getPrComments("org/repo", 7),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, null);
      assert.equal(error.route, ROUTE);
      // The transport must not guess the vendor host or rebase it onto the route.
      assert.match(error.message, /api\.github\.com/);
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test("transport rejects same-origin cross-prefix Link URLs", async () => {
  const absolute = [];
  const absoluteClient = createGitHubClient({
    baseUrl: PROXY_BASE,
    fetch: async (url) => {
      absolute.push(url);
      if (url.includes("/comments")) {
        return jsonResponse([], 200, {
          link: `<${PROXY_BASE}/gitlab/repos/org/repo/pulls/7/comments?page=2>; rel="next"`,
        });
      }
      return jsonResponse([]);
    },
  });
  await assert.rejects(
    () => absoluteClient.getPrComments("org/repo", 7),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, null);
      assert.match(error.message, /gitlab/);
      return true;
    },
  );
  assert.equal(absolute.length, 2);

  // A root-relative cross-prefix path cannot escape either: Octokit's
  // endpoint merger anchors it on the route, so the follow-up stays inside
  // /github (and fails upstream) instead of reaching another prefix.
  const relative = [];
  const relativeClient = createGitHubClient({
    baseUrl: PROXY_BASE,
    fetch: async (url) => {
      relative.push(url);
      if (url === PULLS_URL) {
        return jsonResponse([], 200, {
          link: '</gitlab/repos/org/repo/pulls/7/comments?page=2>; rel="next"',
        });
      }
      return jsonResponse({ message: "Not Found" }, 404);
    },
  });
  await assert.rejects(
    () => relativeClient.getPrComments("org/repo", 7),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, 404);
      return true;
    },
  );
  for (const url of relative) {
    assert.ok(url.startsWith(ROUTE), `unexpected transport url ${url}`);
  }

  // Dot segments cannot walk out of the route: the wrapper normalizes the
  // merged URL and rejects it before the transport runs. (Deeper chains are
  // additionally mangled into on-route paths by Octokit's URL-template
  // parser, so they cannot escape either.)
  const traversal = [];
  const traversalClient = createGitHubClient({
    baseUrl: PROXY_BASE,
    fetch: async (url) => {
      traversal.push(url);
      if (url === PULLS_URL || url === ISSUES_URL) {
        return jsonResponse([], 200, {
          link: '</github/../../gitlab/x>; rel="next"',
        });
      }
      return jsonResponse([]);
    },
  });
  await assert.rejects(
    () => traversalClient.getPrComments("org/repo", 7),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, null);
      assert.match(error.message, /gitlab/);
      return true;
    },
  );
  assert.equal(traversal.length, 2);
});

test("transport follows a same-route redirect manually and stays on the route", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: PROXY_BASE,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url === PULLS_URL) {
        return new Response(null, {
          status: 302,
          headers: { location: "/github/repos/org/repo/pulls/7/comments?page=2" },
        });
      }
      if (url.includes("/pulls/7/comments")) {
        return jsonResponse([{ user: { login: "a" }, created_at: "t1", body: "redirected" }]);
      }
      return jsonResponse([{ user: { login: "b" }, created_at: "t2", body: "plain" }]);
    },
  });
  const comments = await client.getPrComments("org/repo", 7);
  assert.deepEqual(
    calls.map((call) => call.url),
    [PULLS_URL, `${PULLS_URL}?page=2`, ISSUES_URL],
  );
  // GET stays GET across the redirect; the wrapper, not native fetch, follows.
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[1].init.redirect, "manual");
  assert.deepEqual(comments, [
    { a: "a", t: "t1", b: "redirected" },
    { a: "b", t: "t2", b: "plain" },
  ]);
});

test("transport follows a same-route absolute redirect", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: PROXY_BASE,
    fetch: async (url) => {
      calls.push(url);
      if (url === PULLS_URL) {
        return new Response(null, {
          status: 302,
          headers: { location: `${PULLS_URL}?page=2` },
        });
      }
      if (url.includes("/pulls/7/comments")) {
        return jsonResponse([{ user: { login: "a" }, created_at: "t1", body: "redirected" }]);
      }
      return jsonResponse([]);
    },
  });
  const comments = await client.getPrComments("org/repo", 7);
  assert.deepEqual(calls, [PULLS_URL, `${PULLS_URL}?page=2`, ISSUES_URL]);
  assert.deepEqual(comments, [{ a: "a", t: "t1", b: "redirected" }]);
});

test("transport rejects a redirect off the route before requesting the target", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: PROXY_BASE,
    fetch: async (url) => {
      calls.push(url);
      if (url.includes("/comments")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/leak" },
        });
      }
      return jsonResponse([]);
    },
  });
  await assert.rejects(
    () => client.getPrComments("org/repo", 7),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, null);
      assert.match(error.message, /evil\.example/);
      return true;
    },
  );
  // Only the two first pages ran; the redirect targets were never requested.
  assert.equal(calls.length, 2);
});

test("transport rejects same-origin cross-prefix redirects", async () => {
  const run = async (location) => {
    const calls = [];
    const client = createGitHubClient({
      baseUrl: PROXY_BASE,
      fetch: async (url) => {
        calls.push(url);
        if (url.includes("/comments")) {
          return new Response(null, { status: 302, headers: { location } });
        }
        return jsonResponse([]);
      },
    });
    await assert.rejects(
      () => client.getPrComments("org/repo", 7),
      (error) => {
        assert.ok(isPreflightHttpError(error));
        assert.equal(error.status, null);
        return true;
      },
    );
    // Both endpoints were tried; the redirect targets were never requested.
    assert.equal(calls.length, 2);
  };
  await run(`${PROXY_BASE}/jira/rest/x`);
  await run("/jira/rest/x");
  await run(`${PROXY_BASE}/githublab/repos/org/repo/pulls/7/comments`);
  // Dot segments in a redirect target cannot walk out of the route either.
  await run("/github/x/../../../../../gitlab/y");
});

test("GraphQL transport rejects an external redirect", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: PROXY_BASE,
    fetch: async (url) => {
      calls.push(url);
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/leak" },
      });
    },
  });
  await assert.rejects(
    () => client.getPr("org/repo", 7),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, null);
      assert.match(error.message, /evil\.example/);
      return true;
    },
  );
  assert.deepEqual(calls, [`${ROUTE}/graphql`]);
});

test("GraphQL transport follows a same-route redirect as a GET without a body", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: PROXY_BASE,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (init.method === "POST") {
        return new Response(null, {
          status: 302,
          headers: { location: `${ROUTE}/graphql?retry=1` },
        });
      }
      return jsonResponse(graphqlResponse({ state: "OPEN" }));
    },
  });
  const pr = await client.getPr("org/repo", 7);
  assert.equal(pr.state, "OPEN");
  assert.deepEqual(
    calls.map((call) => call.url),
    [`${ROUTE}/graphql`, `${ROUTE}/graphql?retry=1`],
  );
  // 302 on a POST follows fetch semantics: the redirect is replayed as GET.
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[1].init.body, undefined);
  assert.equal(calls[1].init.redirect, "manual");
});

test("guarded transport rejects an external redirect from a real HTTP server, keeping the other endpoint's comments", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url.includes("/pulls/7/comments")) {
      // The gateway only rewrites same-upstream Locations; a redirect to a
      // foreign origin reaches the client untouched and must be rejected
      // before any request leaves for it.
      res.writeHead(302, { location: "https://evil.example/leak" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ user: { login: "issue" }, created_at: "t2", body: "kept" }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = createGitHubClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    // One endpoint failing never discards the other endpoint's comments.
    const comments = await client.getPrComments("org/repo", 7);
    assert.deepEqual(comments, [{ a: "issue", t: "t2", b: "kept" }]);
    // Exactly the two first pages; the redirect target was never contacted.
    assert.deepEqual(requests, [
      "/github/repos/org/repo/pulls/7/comments",
      "/github/repos/org/repo/issues/7/comments",
    ]);
  } finally {
    server.close();
  }
});

test("guarded transport follows same-route redirects from a real HTTP server", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/github/repos/org/repo/pulls/7/comments") {
      res.writeHead(302, { location: "/github/repos/org/repo/pulls/7/comments?redirected=1" });
      res.end();
      return;
    }
    if (req.url.includes("/pulls/7/comments")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([{ user: { login: "native" }, created_at: "t1", body: "via redirect" }]),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ user: { login: "issue" }, created_at: "t2", body: "plain" }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    // Native fetch — no injectable transport: proves the wrapper, not the
    // fixture, owns redirect handling on the real code path.
    const client = createGitHubClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const comments = await client.getPrComments("org/repo", 7);
    assert.deepEqual(requests, [
      "/github/repos/org/repo/pulls/7/comments",
      "/github/repos/org/repo/pulls/7/comments?redirected=1",
      "/github/repos/org/repo/issues/7/comments",
    ]);
    assert.deepEqual(comments, [
      { a: "native", t: "t1", b: "via redirect" },
      { a: "issue", t: "t2", b: "plain" },
    ]);
  } finally {
    server.close();
  }
});

test("comment pagination aborts in-flight page requests at the deadline", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: PROXY_BASE,
    timeoutMs: 60,
    fetch: async (url, init) => {
      calls.push({ url, signal: init.signal });
      if (url.includes("/pulls/7/comments") && !url.includes("page=")) {
        // The first page answers quickly and points at a second page.
        await delay(20);
        return jsonResponse([], 200, {
          link: '</github/repos/org/repo/pulls/7/comments?page=2>; rel="next"',
        });
      }
      // Every other request stalls until the deadline aborts it.
      await delayUntil(1_000, init.signal);
      return jsonResponse([]);
    },
  });
  await assert.rejects(
    () => client.getPrComments("org/repo", 7),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, null);
      assert.match(error.message, /timed out after 60ms/);
      return true;
    },
  );
  // Page 2 of the review-comments walk and the first page of the issue
  // comments walk were requested, aborted in flight, and no further page
  // followed.
  assert.deepEqual(
    calls.map((call) => call.url),
    [PULLS_URL, `${PULLS_URL}?page=2`, ISSUES_URL],
  );
  assert.equal(calls[1].signal instanceof AbortSignal, true);
  assert.equal(calls[2].signal instanceof AbortSignal, true);
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(calls[2].signal.aborted, true);
});

test("pages after the deadline are not requested even when the transport stalls", async () => {
  const calls = [];
  const client = createGitHubClient({
    baseUrl: PROXY_BASE,
    timeoutMs: 40,
    fetch: async (url) => {
      calls.push(url);
      if (url.includes("/pulls/7/comments")) {
        if (!url.includes("page=")) {
          // Ignores the abort signal: resolves after the deadline with a
          // next link that would trigger a second page.
          await delay(80);
          return jsonResponse([], 200, {
            link: '</github/repos/org/repo/pulls/7/comments?page=2>; rel="next"',
          });
        }
        return jsonResponse([]);
      }
      return jsonResponse([{ user: { login: "kept" }, created_at: "t", body: "kept" }]);
    },
  });
  const comments = await client.getPrComments("org/repo", 7);
  // The stalled endpoint failed at its deadline; the other endpoint's
  // comment survives, and the page past the deadline never reached the
  // transport.
  assert.deepEqual(comments, [{ a: "kept", t: "t", b: "kept" }]);
  assert.deepEqual(calls, [PULLS_URL, ISSUES_URL]);
});

test("the GraphQL deadline stays a live abort signal on the transport", async () => {
  const seen = [];
  const client = createGitHubClient({
    baseUrl: PROXY_BASE,
    timeoutMs: 40,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        seen.push(init.signal);
        if (init.signal?.aborted) {
          reject(abortError());
          return;
        }
        init.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      }),
  });
  await assert.rejects(
    () => client.getPr("org/repo", 7),
    (error) => {
      assert.ok(isPreflightHttpError(error));
      assert.equal(error.status, null);
      assert.match(error.message, /timed out after 40ms/);
      return true;
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0] instanceof AbortSignal, true);
  assert.equal(seen[0].aborted, true);
});

test("a completed comments walk leaves no deadline timer behind", async () => {
  const countTimeouts = () =>
    process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  const client = createGitHubClient({
    baseUrl: PROXY_BASE,
    timeoutMs: 5_000,
    fetch: async () => jsonResponse([]),
  });
  const before = countTimeouts();
  await client.getPrComments("org/repo", 7);
  assert.equal(countTimeouts(), before);
});
