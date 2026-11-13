import assert from "node:assert/strict";
import test from "node:test";
import {
  describeFetchFailure,
  FetchTracker,
  failureEvidenceLines,
  totalFetchFailureError,
} from "../dist/shared/failure-policy.js";
import { PreflightHttpError } from "../dist/shared/http.js";

/**
 * Focused tests for the shared fetch-failure policy (shared/failure-policy.ts):
 * the isolated-failure tolerance, the zero-success escalation naming the
 * required route, and the evidence discipline (status/transport reasons
 * only — never error messages or bodies).
 */

const httpError = (status, message = "upstream detail") =>
  new PreflightHttpError({
    status,
    method: "GET",
    url: "https://proxy.example/devbot-proxy/github/repos/org/repo/pulls/9/comments",
    route: "https://proxy.example/devbot-proxy/github",
    message,
  });

// --- describeFetchFailure: status/transport classification only ---

test("describeFetchFailure reports the HTTP status", () => {
  for (const status of [401, 403, 404, 429, 502, 503]) {
    assert.equal(describeFetchFailure(httpError(status)), `HTTP ${status}`);
  }
});

test("describeFetchFailure classifies statusless errors as transport failures", () => {
  assert.equal(describeFetchFailure(httpError(null)), "network or timeout failure");
});

test("describeFetchFailure degrades unknown errors to a generic reason", () => {
  assert.equal(describeFetchFailure(new Error("boom")), "client error");
  assert.equal(describeFetchFailure("not even an error"), "client error");
});

// --- FetchTracker bookkeeping ---

test("tracker counts attempted and succeeded separately", () => {
  const tracker = new FetchTracker();
  tracker.recordSuccess();
  tracker.recordSuccess();
  tracker.recordFailure("org/gone#7", httpError(404));
  assert.equal(tracker.attempted, 3);
  assert.equal(tracker.succeeded, 2);
  assert.deepEqual(tracker.failures, [{ item: "org/gone#7", reason: "HTTP 404" }]);
});

// --- the zero-success escalation ---

test("no escalation when nothing was attempted", () => {
  const tracker = new FetchTracker();
  assert.equal(
    totalFetchFailureError(tracker, { system: "GitHub", noun: "PR", route: "https://p/github" }),
    null,
  );
});

test("no escalation when at least one fetch succeeded (isolated failures tolerated)", () => {
  const tracker = new FetchTracker();
  tracker.recordSuccess();
  tracker.recordFailure("org/gone#7", httpError(404));
  tracker.recordFailure("org/other#8", httpError(503));
  assert.equal(
    totalFetchFailureError(tracker, { system: "GitHub", noun: "PR", route: "https://p/github" }),
    null,
  );
});

test("zero successes with attempts escalates naming the route and every reason", () => {
  const tracker = new FetchTracker();
  tracker.recordFailure("org/a#1", httpError(503));
  tracker.recordFailure("org/b#2", httpError(null));
  const error = totalFetchFailureError(tracker, {
    system: "GitHub",
    noun: "PR",
    route: "https://proxy.example/devbot-proxy/github",
  });
  assert.ok(error instanceof Error);
  assert.equal(
    error.message,
    "GitHub route https://proxy.example/devbot-proxy/github is not usable: " +
      "2 PR fetches attempted, 0 succeeded (org/a#1: HTTP 503; org/b#2: network or timeout failure)",
  );
});

test("a single failed attempt uses the singular fetch word", () => {
  const tracker = new FetchTracker();
  tracker.recordFailure("org/a#1", httpError(401));
  const error = totalFetchFailureError(tracker, {
    system: "GitLab",
    noun: "MR note",
    route: "https://p/gitlab",
  });
  assert.equal(
    error.message,
    "GitLab route https://p/gitlab is not usable: " +
      "1 MR note fetch attempted, 0 succeeded (org/a#1: HTTP 401)",
  );
});

// --- evidence discipline ---

test("escalation messages never carry error bodies or credentials", () => {
  const tracker = new FetchTracker();
  tracker.recordFailure("org/a#1", httpError(403, "denied: token ghp_secret-token-value"));
  const error = totalFetchFailureError(tracker, {
    system: "GitHub",
    noun: "PR",
    route: "https://p/github",
  });
  assert.ok(error instanceof Error);
  assert.equal(error.message.includes("ghp_secret-token-value"), false);
  assert.equal(error.message.includes("denied"), false);
  assert.equal(error.message.includes("HTTP 403"), true);
});

test("failureEvidenceLines render one indented line per failure", () => {
  const tracker = new FetchTracker();
  tracker.recordSuccess();
  tracker.recordFailure("org/gone#7", httpError(404));
  assert.deepEqual(failureEvidenceLines(tracker, "PR"), ["  PR org/gone#7: HTTP 404"]);
  assert.deepEqual(failureEvidenceLines(new FetchTracker(), "PR comments"), []);
});
