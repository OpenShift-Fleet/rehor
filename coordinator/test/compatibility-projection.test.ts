import { describe, expect, it } from "bun:test";

import { executeRun, LegacyCompatibilityProjection, type RehorEvent, type RehorRun } from "../src";
import { FakeAgentRuntime } from "../src/testing/fake-agent-runtime";

const run: RehorRun = {
  schemaVersion: "1",
  runId: "run-projection",
  attemptId: "attempt-projection",
  instanceId: "instance-01",
  label: "hcc-ai-framework",
  workflowId: "jira-sprint",
  prompt: "Run the cycle.",
  task: null,
  worktree: {
    path: "/work/rehor",
    repository: "https://github.com/OpenShift-Fleet/rehor.git",
    snapshot: { ref: "refs/heads/rehor-139", commitSha: "abc123", dirty: false },
  },
  instructionHash: { algorithm: "sha256", value: "1".repeat(64) },
  configHash: { algorithm: "sha256", value: "2".repeat(64) },
  policyHash: { algorithm: "sha256", value: "3".repeat(64) },
  provider: { id: "vertex", requestedModel: "claude-opus-4-6" },
  limits: { timeoutMs: 1_000, maxTurns: 20 },
  preflightPayloadRef: null,
};

function event(
  eventId: string,
  sequence: number,
  kind: RehorEvent["kind"],
  payload: Readonly<Record<string, unknown>>,
  runtimeSessionRef?: string,
): RehorEvent {
  return {
    schemaVersion: "1",
    eventId,
    runId: run.runId,
    attemptId: run.attemptId,
    sequence,
    occurredAt: `2026-09-07T12:00:0${sequence}.000Z`,
    kind,
    ...(runtimeSessionRef ? { runtimeSessionRef } : {}),
    workspace: {
      worktreePath: run.worktree.path,
      repository: run.worktree.repository,
      snapshot: run.worktree.snapshot.commitSha,
    },
    provider: run.provider.id,
    model: run.provider.requestedModel,
    policyVersion: "policy-1",
    payload,
  };
}

const start = event("run-01", 1, "run", { state: "started" }, "session-01");
const partialUsage = event("usage-01", 2, "usage", {
  requestedModel: run.provider.requestedModel,
  tokenCounts: { input: 10, output: 2 },
  partial: true,
  final: false,
  estimated: false,
  incomplete: true,
  cost: { amount: 0.1, currency: "USD", source: "provider" },
});
const finalUsage = event("usage-02", 3, "usage", {
  requestedModel: run.provider.requestedModel,
  tokenCounts: { input: 100, output: 20, cacheRead: 4, cacheWrite: 5 },
  partial: false,
  final: true,
  estimated: false,
  incomplete: false,
  cost: { amount: 1.2, currency: "USD", source: "provider" },
});
const terminal = event("terminal-01", 4, "terminal", {
  state: "completed",
  resultText: "Implemented work.",
  turns: 7,
  durationMs: 3_000,
  context: {
    taskId: 42,
    externalKey: "REHOR-139",
    repository: "rehor",
    workType: "new_ticket",
    summary: "Coordinator migration",
  },
});

describe("legacy compatibility projection", () => {
  it("writes status, transcript, cost, cycle-run, and metric records", async () => {
    const statuses: unknown[] = [];
    const transcripts: unknown[] = [];
    const costs: unknown[] = [];
    const cycleRuns: unknown[] = [];
    const metrics: unknown[] = [];
    const projection = new LegacyCompatibilityProjection({
      status: {
        write: (record) => {
          statuses.push(record);
        },
      },
      transcripts: {
        append: (record) => {
          transcripts.push(record);
        },
      },
      costs: {
        write: (record) => {
          costs.push(record);
        },
      },
      cycleRuns: {
        write: (record) => {
          cycleRuns.push(record);
        },
      },
      metrics: {
        observe: (record) => {
          metrics.push(record);
        },
      },
    });

    const result = await executeRun(
      new FakeAgentRuntime({ events: [start, partialUsage, finalUsage, terminal] }),
      run,
      {
        projection,
      },
    );

    expect(result.error).toBeUndefined();
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({ state: "working", instanceId: run.instanceId });
    expect(statuses[1]).toMatchObject({ state: "idle", message: "Cycle complete. Sleeping..." });
    expect(transcripts).toHaveLength(4);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      runId: run.runId,
      sessionId: "session-01",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
      costUsd: 1.2,
      numTurns: 7,
      isError: false,
      noWork: false,
    });
    expect(cycleRuns[0]).toMatchObject({
      cycleType: "task_work",
      taskId: 42,
      tokensUsed: 120,
      inputPrompt: run.prompt,
      progress: { externalKey: "REHOR-139", workType: "new_ticket" },
    });
    expect(metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "devbot_cycles_total", value: 1 }),
        expect.objectContaining({ name: "devbot_cycle_cost_usd_total", value: 1.2 }),
      ]),
    );
  });

  it("classifies terminal no-work as idle without starting a second session", async () => {
    const statuses: unknown[] = [];
    const cycleRuns: unknown[] = [];
    const projection = new LegacyCompatibilityProjection({
      status: {
        write: (record) => {
          statuses.push(record);
        },
      },
      cycleRuns: {
        write: (record) => {
          cycleRuns.push(record);
        },
      },
    });
    const noWorkTerminal = event("terminal-idle", 2, "terminal", {
      state: "completed",
      resultText: "NO_WORK_FOUND",
      noWork: true,
    });

    await executeRun(new FakeAgentRuntime({ events: [start, noWorkTerminal] }), run, {
      projection,
    });

    expect(statuses.at(-1)).toMatchObject({ state: "idle", message: "No work found. Sleeping..." });
    expect(cycleRuns[0]).toMatchObject({ cycleType: "idle", tokensUsed: 0 });
  });
});
