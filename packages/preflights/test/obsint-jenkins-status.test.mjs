import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import {
  classifyJobs,
  classifyPattern,
  computeCurrentSignature,
} from "../dist/preflights/obsint-jenkins-status/classify.js";
import { build, fakeJenkins, fakeMemory, fakeSlack, job, obsintContext } from "./obsint-fixtures.mjs";

/**
 * Port of the watchduty `01-jenkins-status.py` coverage, adapted to the TS
 * module API: classification, tracked-job cleanup, error-signature gating,
 * and the compact Slack report — all through the registered preflight with
 * plain-object client fakes, so the run-context wiring is exercised too.
 */

const registry = createPopulatedRegistry();
const jenkinsStatus = registry.get("obsint-jenkins-status");

const runStatus = (ctx) => jenkinsStatus.run(ctx, jenkinsStatus.input.parse({}));

const md5Prefix = (text) => createHash("md5").update(text).digest("hex").slice(0, 12);

const scheduledTask = (repo, externalKey) => ({
  external_key: externalKey,
  repo,
  source_type: "scheduled",
  status: "in_progress",
});

// --- classification unit tests (ported from the Python classifier) ---

test("classifyJobs excludes disabled and building jobs and sorts by priority", () => {
  const failingProd = job("pipeline-prod", { builds: [build(10, "FAILURE"), build(9, "SUCCESS")] });
  const failingStage = job("pipeline-stage", { builds: [build(4, "FAILURE")] });
  const recovering = job("worker", { builds: [build(7, "SUCCESS"), build(6, "FAILURE")] });
  const healthy = job("worker-2", { builds: [build(3, "SUCCESS")] });
  const classified = classifyJobs([
    healthy,
    recovering,
    failingStage,
    failingProd,
    job("gone", { color: "disabled" }),
    job("cooking", { builds: [build(2, null)] }),
  ]);
  assert.deepEqual(classified.headFailing.map((entry) => entry.name), ["pipeline-prod", "pipeline-stage"]);
  assert.deepEqual(classified.recovering, ["worker"]);
  assert.deepEqual(classified.healthy, ["worker-2"]);
  assert.deepEqual(classified.skipped, [
    { name: "gone", reason: "disabled" },
    { name: "cooking", reason: "building" },
  ]);
  assert.equal(classified.hasFailures, true);
});

test("classifyJobs returns null for an empty job list", () => {
  assert.equal(classifyJobs([]), null);
});

test("classifyPattern names the failure patterns from build history", () => {
  assert.deepEqual(classifyPattern(job("h", { builds: [build(1, "SUCCESS")] })), { pattern: "healthy" });
  assert.deepEqual(classifyPattern(job("b", { builds: [build(2, "SUCCESS"), build(1, "FAILURE")] })), {
    pattern: "isolated-blip",
    sequence: "S-F",
  });
  assert.deepEqual(
    classifyPattern(job("r", { builds: [build(3, "SUCCESS"), build(2, "FAILURE"), build(1, "FAILURE")] })),
    { pattern: "recovering", sequence: "S-F-F" },
  );
  const flapping = classifyPattern(
    job("f", { builds: [build(7, "FAILURE"), build(6, "SUCCESS"), build(5, "FAILURE"), build(4, "SUCCESS")] }),
  );
  assert.equal(flapping.pattern, "flapping");
  assert.equal(flapping.transitions, 3);
  assert.equal(flapping.first_fail_build, 7);
  assert.equal(flapping.consec_fails, 1);
  assert.equal(flapping.sequence, "F-S-F-S");
  const consecutive = classifyPattern(
    job("c", { builds: [build(5, "FAILURE"), build(4, "FAILURE"), build(3, "SUCCESS")] }),
  );
  assert.deepEqual(consecutive, {
    pattern: "consecutive-fail",
    first_fail_build: 4,
    consec_fails: 2,
    sequence: "F-F-S",
  });
  assert.deepEqual(classifyPattern(job("e", { builds: [] })), { pattern: "unknown" });
});

test("computeCurrentSignature fingerprints result, stages, tests, and counts", () => {
  const failing = job("j", { builds: [build(10, "FAILURE")] });
  assert.equal(computeCurrentSignature(failing), md5Prefix("result:FAILURE"));
  assert.equal(computeCurrentSignature(failing, { build: 10, stages: [] }), md5Prefix("result:FAILURE"));
  const detail = {
    build: 10,
    stages: [
      { name: "build", status: "SUCCESS", duration_s: 10 },
      { name: "test", status: "FAILED", duration_s: 5 },
    ],
    failure_summary: { failed_tests: ["FAILED tests::test_b", "FAILED tests::test_a"], counts: "2 failed" },
  };
  assert.equal(
    computeCurrentSignature(failing, detail),
    md5Prefix("result:FAILURE|stages:test|tests:FAILED tests::test_a,FAILED tests::test_b|counts:2 failed"),
  );
  const tailDetail = { build: 10, stages: [], log_tail: "line1\n\nline2\nline3\nline4\nline5\nline6" };
  assert.equal(
    computeCurrentSignature(failing, tailDetail),
    md5Prefix("result:FAILURE|tail:line2|line3|line4|line5|line6"),
  );
  assert.equal(computeCurrentSignature(job("empty", { builds: [] })), "");
});

// --- run() decision logic ---

test("unwired jenkins client returns an error result", async () => {
  const result = await runStatus(obsintContext({ memory: fakeMemory() }));
  assert.equal(result.status, "error");
  assert.match(result.content, /obsint-jenkins-status requires a wired Jenkins client/);
});

test("both instances unreachable skips the cycle", async () => {
  const result = await runStatus(
    obsintContext({ jenkins: fakeJenkins({ jobs: null }), memory: fakeMemory() }),
  );
  assert.deepEqual(result, {
    status: "skip",
    content: "Pre-flight: both Jenkins instances unreachable. Skipping cycle.",
  });
});

test("an empty job list skips the cycle", async () => {
  const result = await runStatus(obsintContext({ jenkins: fakeJenkins({ jobs: [] }) }));
  assert.deepEqual(result, {
    status: "skip",
    content: "Pre-flight: no jobs returned from Jenkins. Skipping cycle.",
  });
});

test("the all-jobs fetch requests 10 builds like the Python skill invocation", async () => {
  const jenkins = fakeJenkins({ jobs: [] });
  await runStatus(obsintContext({ jenkins }));
  assert.deepEqual(jenkins.calls.allJobsCalls, [10]);
});

test("all healthy jobs skip the cycle and clean up tracked scheduled tasks", async () => {
  const memory = fakeMemory({
    tasks: [
      scheduledTask("old-job", "watchduty:jenkins:old-job"),
      { external_key: "jira-1", repo: "other-repo", source_type: "jira", status: "in_progress" },
    ],
    memories: [
      { id: "m1", content: "old analysis", tags: ["watchduty", "watchduty:jenkins:old-job"] },
    ],
  });
  const jenkins = fakeJenkins({ jobs: [job("healthy-job", { builds: [build(3, "SUCCESS")] })] });
  const result = await runStatus(obsintContext({ jenkins, memory }));
  assert.deepEqual(result, {
    status: "skip",
    content: "Pre-flight: all 1 eligible Jenkins jobs are healthy. Skipping cycle.",
  });
  // The stale scheduled task was archived and its memory deleted; the
  // jira-sourced task was left alone.
  assert.deepEqual(memory.calls.archivedTasks, ["watchduty:jenkins:old-job"]);
  assert.deepEqual(memory.calls.deletedMemories, ["m1"]);
  assert.deepEqual(
    memory.calls.listedTags,
    [{ tag: "watchduty:jenkins:old-job", limit: 10 }],
  );
});

test("healthy cleanup tolerates archive failures with a WARN line", async () => {
  const memory = fakeMemory({ tasks: [scheduledTask("old-job", "watchduty:jenkins:old-job")] });
  memory.archiveTask = async () => {
    throw new Error("memory down");
  };
  const jenkins = fakeJenkins({ jobs: [job("healthy-job", { builds: [build(3, "SUCCESS")] })] });
  const result = await runStatus(obsintContext({ jenkins, memory }));
  assert.equal(result.status, "skip");
  assert.match(result.content, /all 1 eligible Jenkins jobs are healthy/);
  assert.match(result.content, /WARN: could not archive task watchduty:jenkins:old-job: memory down/);
});

test("a new failing job starts with the pre-classified JSON report", async () => {
  const jenkins = fakeJenkins({
    jobs: [
      job("job-a", { builds: [build(10, "FAILURE"), build(9, "SUCCESS"), build(8, "SUCCESS")] }),
      job("job-b", { builds: [build(5, "SUCCESS")] }),
      job("job-c", { builds: [build(3, null)] }),
      job("job-d", { color: "disabled" }),
    ],
    errors: ["https://jenkins-qe.example.invalid/api/json request_failed"],
  });
  const memory = fakeMemory({ memories: [] });
  const result = await runStatus(obsintContext({ jenkins, memory }));
  assert.equal(result.status, "start");
  assert.equal(
    result.content,
    "Pre-flight: 1 NEW failing, 0 already tracked, 0 recovering, 1 healthy.\n" +
      "Patterns pre-classified. Only fetch individual build details when analyzing a failure.\n\n" +
      JSON.stringify(
        {
          failing: [
            {
              name: "job-a",
              instance: "qe",
              pattern: "consecutive-fail",
              first_fail_build: 10,
              consec_fails: 1,
              sequence: "F-S-S",
              latest_fail_build: 10,
              failed_builds: [10],
            },
          ],
          tracked_failing_jobs: [],
          tracked_failing_count: 0,
          recovering_jobs: [],
          recovering_count: 0,
          healthy_jobs: ["job-b"],
          healthy_count: 1,
          skipped: [
            { name: "job-c", reason: "building" },
            { name: "job-d", reason: "disabled" },
          ],
          errors: ["https://jenkins-qe.example.invalid/api/json request_failed"],
        },
        null,
        2,
      ),
  );
});

test("a tracked failing job with an unchanged signature skips without Slack wired", async () => {
  const jenkins = fakeJenkins({
    jobs: [
      job("job-a", { builds: [build(10, "FAILURE")] }),
      job("job-b", { builds: [build(5, "SUCCESS")] }),
    ],
  });
  const memory = fakeMemory({
    tasks: [scheduledTask("job-a", "watchduty:jenkins:job-a")],
    memories: [
      // The stored memory content hashes to the current signature
      // (result-only fingerprint: the fetched detail carries no failure
      // summary and no log tail).
      { id: "m1", content: "result:FAILURE", tags: ["watchduty", "watchduty:jenkins:job-a"] },
    ],
  });
  const result = await runStatus(obsintContext({ jenkins, memory }));
  assert.deepEqual(result, {
    status: "skip",
    content: "Pre-flight: 1 failing (all tracked, same errors), 0 recovering, 1 healthy. Slack skipped (no webhook).",
  });
  // The signature check fetched the latest build detail.
  assert.deepEqual(jenkins.calls.buildDetails, ["job-a:10"]);
});

test("a tracked failing job with an unchanged signature sends the compact Slack report", async () => {
  const jenkins = fakeJenkins({
    jobs: [
      job("job-a", { builds: [build(10, "FAILURE")] }),
      job("job-b", { builds: [build(5, "SUCCESS")] }),
      job("job-c", { builds: [build(3, null)] }),
    ],
  });
  const memory = fakeMemory({
    tasks: [scheduledTask("job-a", "watchduty:jenkins:job-a")],
    memories: [{ id: "m1", content: "result:FAILURE", tags: ["watchduty", "watchduty:jenkins:job-a"] }],
  });
  const slack = fakeSlack();
  const result = await runStatus(obsintContext({ jenkins, memory, slack }));
  assert.deepEqual(result, {
    status: "skip",
    content: "Pre-flight: 1 failing (all tracked, same errors), 0 recovering, 1 healthy. compact Slack sent.",
  });
  assert.equal(slack.calls.sent.length, 1);
  assert.equal(
    slack.calls.sent[0],
    "🚨 *CCX Jenkins Watchduty Report (no change)*\n" +
      "\n" +
      "🔴 *Failing (1) — no change since last report:*\n" +
      "- <https://jenkins-qe.example.invalid/job/ccx/job/job-a/10/|job-a> — last failed #10\n" +
      "🟢 Healthy (1)\n" +
      "🛠️ Building (1)",
  );
});

test("a failed Slack send degrades to the no-webhook skip, never an error", async () => {
  const jenkins = fakeJenkins({ jobs: [job("job-a", { builds: [build(10, "FAILURE")] })] });
  const memory = fakeMemory({
    tasks: [scheduledTask("job-a", "watchduty:jenkins:job-a")],
    memories: [{ id: "m1", content: "result:FAILURE", tags: ["watchduty", "watchduty:jenkins:job-a"] }],
  });
  const slack = fakeSlack({ ok: false });
  const result = await runStatus(obsintContext({ jenkins, memory, slack }));
  assert.deepEqual(result, {
    status: "skip",
    content: "Pre-flight: 1 failing (all tracked, same errors), 0 recovering, 0 healthy. Slack skipped (no webhook).",
  });
});

test("a tracked failing job with a changed error signature starts a re-analysis", async () => {
  const failing = job("job-a", { builds: [build(10, "FAILURE")] });
  const jenkins = fakeJenkins({
    jobs: [failing, job("job-b", { builds: [build(5, "SUCCESS")] })],
    details: new Map([
      [
        "job-a:10",
        {
          build: 10,
          stages: [{ name: "test", status: "FAILED", duration_s: 5 }],
          failure_summary: { failed_tests: ["FAILED tests::test_a"], counts: "1 failed" },
        },
      ],
    ]),
  });
  const memory = fakeMemory({
    tasks: [scheduledTask("job-a", "watchduty:jenkins:job-a")],
    memories: [{ id: "m1", content: "result:FAILURE", tags: ["watchduty", "watchduty:jenkins:job-a"] }],
  });
  const result = await runStatus(obsintContext({ jenkins, memory }));
  assert.equal(result.status, "start");
  assert.match(result.content, /Pre-flight: 1 failing with CHANGED errors, 0 tracked \(same error\), 0 recovering, 1 healthy\./);
  assert.match(result.content, /Error signature changed for these jobs — re-analyze and update memory\./);
  // The slimmed job carries the fetched detail.
  const output = JSON.parse(result.content.split("\n\n").slice(1).join("\n\n"));
  assert.equal(output.failing[0].name, "job-a");
  assert.equal(output.failing[0].detail.build, 10);
  assert.deepEqual(output.failing[0].detail.failure_summary, {
    failed_tests: ["FAILED tests::test_a"],
    counts: "1 failed",
  });
  assert.deepEqual(memory.calls.archivedTasks, []);
});

test("a failing job without a stored signature counts as changed", async () => {
  const jenkins = fakeJenkins({ jobs: [job("job-a", { builds: [build(10, "FAILURE")] })] });
  const memory = fakeMemory({
    tasks: [scheduledTask("job-a", "watchduty:jenkins:job-a")],
    // watchduty-tagged memories exist, but none for job-a.
    memories: [{ id: "m0", content: "unrelated", tags: ["watchduty"] }],
  });
  const result = await runStatus(obsintContext({ jenkins, memory }));
  assert.equal(result.status, "start");
  assert.match(result.content, /1 failing with CHANGED errors/);
});

test("a recovered tracked job is cleaned up while the still-failing one stays tracked", async () => {
  const jenkins = fakeJenkins({
    jobs: [
      job("job-a", { builds: [build(10, "FAILURE")] }),
      job("job-b", { builds: [build(5, "SUCCESS")] }),
    ],
  });
  const memory = fakeMemory({
    tasks: [
      scheduledTask("job-a", "watchduty:jenkins:job-a"),
      scheduledTask("recovered-job", "watchduty:jenkins:recovered-job"),
    ],
    memories: [
      { id: "m1", content: "result:FAILURE", tags: ["watchduty", "watchduty:jenkins:job-a"] },
      { id: "m2", content: "old", tags: ["watchduty", "watchduty:jenkins:recovered-job"] },
    ],
  });
  const result = await runStatus(obsintContext({ jenkins, memory }));
  // job-a is tracked with the same signature -> skip; recovered-job cleaned.
  assert.equal(result.status, "skip");
  assert.match(result.content, /1 failing \(all tracked, same errors\)/);
  assert.deepEqual(memory.calls.archivedTasks, ["watchduty:jenkins:recovered-job"]);
  assert.deepEqual(memory.calls.deletedMemories, ["m2"]);
});

test("memory listing failures escalate to an error result, never an empty tracked set", async () => {
  const jenkins = fakeJenkins({ jobs: [job("job-a", { builds: [build(10, "FAILURE")] })] });
  const memory = fakeMemory({
    // job-a is tracked, so the run reaches the stored-signature listing.
    tasks: [scheduledTask("job-a", "watchduty:jenkins:job-a")],
  });
  memory.listMemories = async () => {
    throw new Error("memory server unavailable");
  };
  const result = await runStatus(obsintContext({ jenkins, memory }));
  assert.equal(result.status, "error");
  assert.match(result.content, /memory server unavailable/);
});

test("task listing failures escalate to an error result", async () => {
  const jenkins = fakeJenkins({ jobs: [job("job-a", { builds: [build(10, "FAILURE")] })] });
  const memory = fakeMemory();
  memory.getTasks = async () => {
    throw new Error("tasks fetch failed");
  };
  const result = await runStatus(obsintContext({ jenkins, memory }));
  assert.equal(result.status, "error");
  assert.match(result.content, /tasks fetch failed/);
});
