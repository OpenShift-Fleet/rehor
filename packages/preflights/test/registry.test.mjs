import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createPreflightRegistry, definePreflight } from "../dist/index.js";
import { fixtureRegistry, ghPrStatus, jiraKanban } from "./fixtures.mjs";

test("definePreflight exposes the id and input schema", () => {
  assert.equal(ghPrStatus.id, "gh-pr-status");
  assert.equal(ghPrStatus.input instanceof z.ZodObject, true);
});

test("definePreflight rejects invalid ids and non-object input schemas", () => {
  const input = z.strictObject({});
  const run = async () => ({ status: "skip", content: "unused" });
  assert.throws(() => definePreflight({ id: "", input, run }));
  assert.throws(() => definePreflight({ id: "x", input: z.string(), run }));
});

test("registry lookups return the preflight or undefined — callers fail closed", () => {
  assert.equal(fixtureRegistry.has("gh-pr-status"), true);
  assert.equal(fixtureRegistry.get("gh-pr-status")?.id, "gh-pr-status");
  assert.equal(fixtureRegistry.has("missing"), false);
  assert.equal(fixtureRegistry.get("missing"), undefined);
  assert.deepEqual(fixtureRegistry.ids(), [
    "gh-pr-status",
    "gl-mr-status",
    "jira-kanban",
    "onboarding",
  ]);
});

test("registry construction rejects duplicate ids", () => {
  assert.throws(
    () => createPreflightRegistry([ghPrStatus, ghPrStatus]),
    /duplicate preflight id "gh-pr-status"/,
  );
});

test("run receives the context and typed params and returns an execution result", async () => {
  const skipped = await ghPrStatus.run({ instanceId: "rehor-pilot" }, {});
  assert.deepEqual(skipped, { status: "skip", content: "no active PRs" });

  const started = await jiraKanban.run(
    { instanceId: "rehor-pilot" },
    { project: "REHOR", label: "rehor-pilot", statuses: ["New"], interrupted_retry_minutes: 30 },
  );
  assert.deepEqual(started, { status: "start", content: "kanban rehor-pilot REHOR" });
});
