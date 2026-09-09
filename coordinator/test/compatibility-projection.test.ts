import { describe, expect, it } from "vitest";

import { executeRun, LegacyCompatibilityProjection, type RehorEvent, type RehorRun } from "../src";
import type { CycleRunRecord, MetricPoint } from "../src/ports/compatibility";
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
        expect.objectContaining({
          name: "devbot_cycles_total",
          value: 1,
          labels: expect.objectContaining({ status: "ok" }),
        }),
        expect.objectContaining({ name: "devbot_cycle_cost_usd_total", value: 1.2 }),
        expect.objectContaining({
          name: "devbot_cycle_duration_seconds",
          labels: { label: run.label, work_type: "new_ticket" },
        }),
      ]),
    );
  });

  it("classifies a contextless no-work terminal as triage_only", async () => {
    const statuses: unknown[] = [];
    const cycleRuns: unknown[] = [];
    const metrics: unknown[] = [];
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
      metrics: {
        observe: (record) => {
          metrics.push(record);
        },
      },
    });
    const idleUsage = event("usage-idle", 2, "usage", {
      requestedModel: run.provider.requestedModel,
      tokenCounts: { cacheRead: 5 },
      partial: false,
      final: true,
      estimated: false,
      incomplete: false,
    });
    const noWorkTerminal = event("terminal-idle", 3, "terminal", {
      state: "completed",
      resultText: "NO_WORK_FOUND",
      noWork: true,
    });

    await executeRun(new FakeAgentRuntime({ events: [start, idleUsage, noWorkTerminal] }), run, {
      projection,
    });

    expect(statuses.at(-1)).toMatchObject({ state: "idle", message: "No work found. Sleeping..." });
    expect(cycleRuns[0]).toMatchObject({ cycleType: "triage_only", tokensUsed: 0 });
    expect(metrics).toContainEqual(
      expect.objectContaining({ name: "devbot_idle_with_tokens_total" }),
    );
  });

  it("keeps attempts isolated and ignores events after terminalization", async () => {
    const costs: unknown[] = [];
    const transcripts: unknown[] = [];
    const projection = new LegacyCompatibilityProjection({
      costs: {
        write: (record) => {
          costs.push(record);
        },
      },
      transcripts: {
        append: (record) => {
          transcripts.push(record);
        },
      },
    });
    const retry = { ...run, attemptId: "attempt-projection-retry" };
    const retryStart = { ...start, attemptId: retry.attemptId, runId: retry.runId };
    const retryTerminal = { ...terminal, attemptId: retry.attemptId, runId: retry.runId };

    await executeRun(new FakeAgentRuntime({ events: [start, partialUsage, terminal] }), run, {
      projection,
    });
    await executeRun(
      new FakeAgentRuntime({ events: [retryStart, finalUsage, retryTerminal] }),
      retry,
      {
        projection,
      },
    );
    await projection.onEvent?.(
      { ...start, eventId: "late-agent", kind: "agent", sequence: 5 },
      run,
    );

    expect(costs).toHaveLength(2);
    expect(costs[0]).toMatchObject({ attemptId: run.attemptId, inputTokens: 10 });
    expect(costs[1]).toMatchObject({ attemptId: retry.attemptId, inputTokens: 100 });
    expect(
      transcripts.filter((record) => (record as { attemptId: string }).attemptId === run.attemptId),
    ).toHaveLength(3);
  });

  /**
   * Runs one attempt that ends in `terminalPayload` and returns only the two
   * outputs whose shape has to match the Python writers: the cycle-run record
   * and the raw metric points.
   */
  async function projectTerminal(
    terminalPayload: Readonly<Record<string, unknown>>,
  ): Promise<{ cycleRun: CycleRunRecord | undefined; metrics: MetricPoint[] }> {
    const cycleRuns: CycleRunRecord[] = [];
    const metrics: MetricPoint[] = [];
    const projection = new LegacyCompatibilityProjection({
      cycleRuns: {
        write: (record) => {
          cycleRuns.push(record);
        },
      },
      metrics: {
        observe: (point) => {
          metrics.push(point);
        },
      },
    });

    await executeRun(
      new FakeAgentRuntime({
        events: [start, event("terminal-case", 2, "terminal", terminalPayload)],
      }),
      run,
      { projection },
    );
    return { cycleRun: cycleRuns[0], metrics };
  }

  function context(workType?: string): Record<string, unknown> {
    return {
      taskId: 42,
      externalKey: "REHOR-139",
      repository: "rehor",
      summary: "Coordinator migration",
      ...(workType === undefined ? {} : { workType }),
    };
  }

  function metric(metrics: MetricPoint[], name: string): MetricPoint | undefined {
    return metrics.find((point) => point.name === name);
  }

  // bot/transcripts.py::_WORK_TYPE_TO_CYCLE_TYPE, entry for entry.
  const cycleTypeCases: ReadonlyArray<[string, string]> = [
    ["new_ticket", "task_work"],
    ["pr_review", "task_work"],
    ["ci_fix", "task_work"],
    ["idle", "idle"],
    ["memory_housekeeping", "idle"],
    ["error", "error"],
  ];

  for (const [workType, cycleType] of cycleTypeCases) {
    it(`maps work type ${workType} to cycle type ${cycleType}`, async () => {
      const { cycleRun } = await projectTerminal({
        state: "completed",
        resultText: "Implemented work.",
        context: context(workType),
      });

      expect(cycleRun).toMatchObject({ cycleType });
    });
  }

  it("maps an unrecognised work type to task_work rather than triage_only", async () => {
    const { cycleRun } = await projectTerminal({
      state: "completed",
      resultText: "Implemented work.",
      context: context("bug_fix"),
    });

    expect(cycleRun).toMatchObject({ cycleType: "task_work" });
  });

  it("keeps a no-work result text from downgrading real task work to idle", async () => {
    // Python classifies on work type alone; a task cycle whose summary happens to
    // say "nothing to do" must still record as task_work.
    const { cycleRun } = await projectTerminal({
      state: "completed",
      resultText: "Closed the ticket, nothing to do here anymore.",
      context: context("new_ticket"),
    });

    expect(cycleRun).toMatchObject({ cycleType: "task_work" });
  });

  it("classifies any failed terminal as an error cycle regardless of work type", async () => {
    const { cycleRun, metrics } = await projectTerminal({
      state: "failed",
      reason: "runtime exited non-zero",
      resultText: "boom",
      context: context("new_ticket"),
    });

    expect(cycleRun).toMatchObject({ cycleType: "error" });
    expect(metric(metrics, "devbot_cycles_total")?.labels).toMatchObject({ status: "error" });
  });

  it("labels devbot_cycles_total with the legacy ok/idle/error vocabulary", async () => {
    const completed = await projectTerminal({
      state: "completed",
      resultText: "Implemented work.",
      context: context("new_ticket"),
    });
    const idle = await projectTerminal({
      state: "completed",
      resultText: "NO_WORK_FOUND",
      noWork: true,
      context: context("idle"),
    });

    expect(metric(completed.metrics, "devbot_cycles_total")?.labels).toMatchObject({
      status: "ok",
    });
    expect(metric(idle.metrics, "devbot_cycles_total")?.labels).toMatchObject({ status: "idle" });
  });

  it("observes cycle duration with only the label and work_type dimensions", async () => {
    const { metrics } = await projectTerminal({
      state: "completed",
      resultText: "Implemented work.",
      durationMs: 4_000,
      context: context("pr_review"),
    });
    const duration = metric(metrics, "devbot_cycle_duration_seconds");

    // bot/metrics.py declares this histogram as ["label", "work_type"]; any extra
    // or missing key makes the Python registry reject the observation outright.
    expect(duration?.labels).toEqual({ label: run.label, work_type: "pr_review" });
    expect(duration?.value).toBe(4);
  });

  it("falls back to work_type unknown for a missing or blank work type", async () => {
    const missing = await projectTerminal({
      state: "completed",
      resultText: "NO_WORK_FOUND",
      noWork: true,
    });
    const blank = await projectTerminal({
      state: "completed",
      resultText: "Implemented work.",
      context: context(""),
    });

    // bot/run.py:565 is `(ctx.work_type if ctx else None) or "unknown"` — a no-work
    // cycle is never relabelled "idle", and an empty string falls back too.
    expect(metric(missing.metrics, "devbot_cycle_duration_seconds")?.labels).toMatchObject({
      work_type: "unknown",
    });
    expect(metric(blank.metrics, "devbot_cycle_duration_seconds")?.labels).toMatchObject({
      work_type: "unknown",
    });
  });

  it("counts idle-with-tokens from cache-only usage", async () => {
    const cacheOnlyUsage = event("usage-cache", 2, "usage", {
      requestedModel: run.provider.requestedModel,
      tokenCounts: { cacheRead: 12 },
      partial: false,
      final: true,
      estimated: false,
      incomplete: false,
    });
    const metrics: MetricPoint[] = [];
    const projection = new LegacyCompatibilityProjection({
      metrics: {
        observe: (point) => {
          metrics.push(point);
        },
      },
    });

    await executeRun(
      new FakeAgentRuntime({
        events: [
          start,
          cacheOnlyUsage,
          event("terminal-cache", 3, "terminal", {
            state: "completed",
            resultText: "NO_WORK_FOUND",
            noWork: true,
          }),
        ],
      }),
      run,
      { projection },
    );

    // The counter exists to catch preflight bugs that burn only cache reads, so
    // input+output alone must not gate it.
    expect(metric(metrics, "devbot_idle_with_tokens_total")).toBeDefined();
  });

  it("does not count idle-with-tokens for a failed no-work cycle", async () => {
    const { metrics } = await projectTerminal({
      state: "failed",
      reason: "runtime exited non-zero",
      resultText: "NO_WORK_FOUND",
      noWork: true,
    });

    // Python resolves status "error" before "idle", so the idle counter stays put.
    expect(metric(metrics, "devbot_cycles_total")?.labels).toMatchObject({ status: "error" });
    expect(metric(metrics, "devbot_idle_with_tokens_total")).toBeUndefined();
  });
});
