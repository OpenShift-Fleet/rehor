import assert from "node:assert/strict";
import test from "node:test";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import {
  build,
  fakeJenkins,
  fakeMemory,
  fakeSlack,
  job,
  obsintContext,
} from "./obsint-fixtures.mjs";

const preflight = createPopulatedRegistry().get("obsint-jenkins-status");
const run = (clients) => preflight.run(obsintContext(clients), preflight.input.parse({}));
const task = (repo) => ({
  external_key: `watchduty:jenkins:${repo}`,
  repo,
  source_type: "scheduled",
  status: "in_progress",
});
const note = (repo, content, id = repo) => ({
  id,
  content,
  tags: ["watchduty", `watchduty:jenkins:${repo}`],
});
const failing = job("job-a", { builds: [build(10, "FAILURE"), build(9, "SUCCESS")] });
const healthy = job("job-b", { builds: [build(5, "SUCCESS")] });
const trackedFailure = () =>
  fakeMemory({ tasks: [task("job-a")], memories: [note("job-a", "result:FAILURE")] });
const report = (result) => JSON.parse(result.content.slice(result.content.indexOf("\n\n") + 2));

test("unreachable Jenkins and empty job lists never trigger analysis or cleanup", async () => {
  for (const jobs of [null, []]) {
    const memory = fakeMemory({ tasks: [task("old-job")] });
    const result = await run({ jenkins: fakeJenkins({ jobs }), memory });
    assert.equal(result.status, "skip");
    assert.deepEqual(memory.calls.archivedTasks, []);
  }
});

test("a new failure starts with classified history, excluding disabled and building jobs", async () => {
  const error = "https://jenkins-qe.example.invalid/api/json request_failed";
  const jenkins = fakeJenkins({
    jobs: [
      failing,
      healthy,
      job("building", { builds: [build(3, null)] }),
      job("disabled", { color: "disabled" }),
    ],
    errors: [error],
  });
  const result = await run({ jenkins });
  assert.equal(result.status, "start");
  const output = report(result);
  assert.deepEqual(
    output.failing.map(({ name }) => name),
    ["job-a"],
  );
  assert.equal(output.failing[0].pattern, "consecutive-fail");
  assert.equal(output.failing[0].latest_fail_build, 10);
  assert.deepEqual(
    new Set(output.skipped.map(({ name }) => name)),
    new Set(["building", "disabled"]),
  );
  assert.deepEqual(output.healthy_jobs, ["job-b"]);
  assert.deepEqual(output.errors, [error]);
});

test("tracked signatures deduplicate later cycles and changed details restart analysis", async () => {
  const jobs = [failing, healthy];
  assert.equal((await run({ jenkins: fakeJenkins({ jobs }) })).status, "start");

  // Simulate the task and signature persisted by the analysis session.
  const memory = trackedFailure();
  const slack = fakeSlack();
  const details = new Map();
  const jenkins = fakeJenkins({ jobs, details });
  assert.equal((await run({ jenkins, memory, slack })).status, "skip");
  assert.equal(slack.calls.sent.length, 1);
  assert.ok(
    slack.calls.sent[0].includes("https://jenkins-qe.example.invalid/job/ccx/job/job-a/10/"),
  );

  const failure_summary = { failed_tests: ["FAILED tests::test_a"], counts: "1 failed" };
  details.set("job-a:10", { build: 10, stages: [], failure_summary });
  const changed = await run({ jenkins, memory, slack });
  assert.equal(changed.status, "start");
  const [entry] = report(changed).failing;
  assert.equal(entry.name, "job-a");
  assert.deepEqual(entry.detail.failure_summary, failure_summary);
  assert.equal(slack.calls.sent.length, 1);
  assert.deepEqual(memory.calls.archivedTasks, []);
});

test("a tracked failure with no saved signature still starts analysis", async () => {
  const memory = fakeMemory({ tasks: [task("job-a")] });
  const result = await run({ jenkins: fakeJenkins({ jobs: [failing] }), memory });
  assert.equal(result.status, "start");
  assert.deepEqual(
    report(result).failing.map(({ name }) => name),
    ["job-a"],
  );
});

test("a failed compact Slack send does not start duplicate analysis", async () => {
  const slack = fakeSlack({ ok: false });
  const result = await run({
    jenkins: fakeJenkins({ jobs: [failing] }),
    memory: trackedFailure(),
    slack,
  });
  assert.equal(result.status, "skip");
  assert.equal(slack.calls.sent.length, 1);
});

test("recovered job cleanup leaves still-failing and unrelated tasks alone", async () => {
  const memory = fakeMemory({
    tasks: [task("job-a"), task("job-b"), { ...task("jira-work"), source_type: "jira" }],
    memories: [
      note("job-a", "result:FAILURE"),
      note("job-b", "old failure"),
      note("jira-work", "unrelated"),
    ],
  });
  const result = await run({ jenkins: fakeJenkins({ jobs: [failing, healthy] }), memory });
  assert.equal(result.status, "skip");
  assert.deepEqual(memory.calls.archivedTasks, ["watchduty:jenkins:job-b"]);
  assert.deepEqual(memory.calls.deletedMemories, ["job-b"]);
});

test("healthy-cycle cleanup warns when archiving fails", async () => {
  const memory = fakeMemory({ tasks: [task("old-job")] });
  memory.archiveTask = async () => {
    throw new Error("memory down");
  };
  const result = await run({ jenkins: fakeJenkins({ jobs: [healthy] }), memory });
  assert.equal(result.status, "skip");
  assert.match(result.content, /WARN:.*old-job.*memory down/);
});

test("tracking lookup failures surface as errors rather than new failures", async () => {
  for (const method of ["getTasks", "listMemories"]) {
    const memory = trackedFailure();
    memory[method] = async () => {
      throw new Error(`${method} unavailable`);
    };
    const result = await run({ jenkins: fakeJenkins({ jobs: [failing] }), memory });
    assert.equal(result.status, "error", method);
    assert.ok(result.content.includes(`${method} unavailable`));
  }
});
