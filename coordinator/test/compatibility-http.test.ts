import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createCompatibilitySink,
  PrometheusMetricStore,
  toCycleRunPayload,
  toLegacyCostEntry,
} from "../src/adapters/compatibility";
import type { CostRecord, CycleRunRecord, MetricPoint } from "../src/ports/compatibility";

const cost: CostRecord = {
  timestamp: "2026-09-22T12:00:00.000Z",
  runId: "run-1",
  attemptId: "attempt-1",
  label: "hcc-ai-framework",
  instanceId: "instance-1",
  sessionId: "session-1",
  numTurns: 2,
  durationMs: 1500,
  costUsd: 0.25,
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
  model: "rehor-openai/gpt-5.6-luna",
  modelUsage: { "rehor-openai/gpt-5.6-luna": { input_tokens: 10, output_tokens: 20 } },
  isError: false,
  noWork: false,
  externalKey: "REHOR-146",
  repository: "https://github.com/example/rehor.git",
  workType: "task",
  summary: "completed",
};

const cycle: CycleRunRecord = {
  runId: "run-1",
  attemptId: "attempt-1",
  taskId: null,
  cycleType: "task_work",
  instanceId: "instance-1",
  startedAt: "2026-09-22T12:00:00.000Z",
  finishedAt: "2026-09-22T12:00:01.500Z",
  toolCalls: 2,
  tokensUsed: 30,
  inputPrompt: "Run one cycle.",
  progress: {
    externalKey: "REHOR-146",
    repository: "https://github.com/example/rehor.git",
    workType: "task",
    summary: "completed",
  },
};

describe("compatibility adapters", () => {
  it("keeps the legacy cost JSONL shape while retaining coordinator identity", () => {
    expect(toLegacyCostEntry(cost)).toMatchObject({
      timestamp: cost.timestamp,
      label: cost.label,
      session_id: "session-1",
      duration_ms: 1500,
      input_tokens: 10,
      cache_read_tokens: 3,
      external_key: "REHOR-146",
      repo: "https://github.com/example/rehor.git",
      run_id: "run-1",
      attempt_id: "attempt-1",
      runtime_id: "unknown",
    });
  });

  it("maps cycle records to the memory-server API contract", () => {
    expect(toCycleRunPayload(cycle, "encoded-transcript")).toEqual({
      task_id: null,
      cycle_type: "task_work",
      instance_id: "instance-1",
      started_at: cycle.startedAt,
      finished_at: cycle.finishedAt,
      tool_calls: 2,
      tokens_used: 30,
      input_prompt: "Run one cycle.",
      progress: {
        external_key: "REHOR-146",
        repo: "https://github.com/example/rehor.git",
        work_type: "task",
        summary: "completed",
      },
      transcript_b64: "encoded-transcript",
    });
  });

  it("writes local JSONL and compressed transcript output before HTTP projection", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "rehor-coordinator-"));
    const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
    const sink = createCompatibilitySink({
      dataDirectory,
      fetch,
      compressTranscript: async (text) => Buffer.from(`compressed:${text}`),
    });
    const costs = sink.writers.costs;
    const transcripts = sink.writers.transcripts;
    const cycleRuns = sink.writers.cycleRuns;
    if (!costs || !transcripts || !cycleRuns) throw new Error("compatibility writers missing");

    await costs.write(cost);
    await transcripts.append({
      runId: "run-1",
      attemptId: "attempt-1",
      instanceId: "instance-1",
      sequence: 1,
      occurredAt: cost.timestamp,
      event: { sequence: 1 } as never,
      run: { runId: "run-1" } as never,
    });
    await cycleRuns.write(cycle);

    expect(JSON.parse(await readFile(join(dataDirectory, "costs.jsonl"), "utf8"))).toMatchObject({
      label: cost.label,
      input_tokens: 10,
    });
    const localCycle = JSON.parse(
      await readFile(join(dataDirectory, "cycle-runs.jsonl"), "utf8"),
    ) as Record<string, unknown>;
    expect(localCycle).toMatchObject({
      cycle_type: "task_work",
      instance_id: "instance-1",
      transcript_path: join("transcripts", "attempt-1.jsonl.zst"),
    });
    expect(localCycle).not.toHaveProperty("transcript_b64");
    expect(
      await readFile(join(dataDirectory, "transcripts", "attempt-1.jsonl.zst"), "utf8"),
    ).toContain("compressed:");
    await expect(
      readFile(join(dataDirectory, "transcripts", "attempt-1.jsonl"), "utf8"),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("logs failed HTTP projections without failing the run and keeps the local JSONL record", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "rehor-coordinator-"));
    const logger = { warn: vi.fn() };
    const sink = createCompatibilitySink({
      dataDirectory,
      costsUrl: "http://memory-server/api/costs",
      statusUrl: "http://memory-server/api/status",
      fetch: vi.fn(async () => new Response("unavailable", { status: 503 })),
      logger,
    });
    const costs = sink.writers.costs;
    const status = sink.writers.status;
    if (!costs || !status) throw new Error("writers missing");

    await expect(costs.write(cost)).resolves.toBeUndefined();
    await expect(
      status.write({ state: "working", message: "working", instanceId: "instance-1" }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 503"));
    expect(JSON.parse(await readFile(join(dataDirectory, "costs.jsonl"), "utf8"))).toMatchObject({
      attempt_id: cost.attemptId,
      cost_usd: cost.costUsd,
    });
  });

  it("fails a cycle-run projection when transcript compression fails", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "rehor-coordinator-"));
    const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
    const sink = createCompatibilitySink({
      dataDirectory,
      cycleRunsUrl: "http://memory-server/api/cycle-runs",
      fetch,
      compressTranscript: async () => {
        throw new Error("zstd output exceeded limit");
      },
    });
    const transcripts = sink.writers.transcripts;
    const cycleRuns = sink.writers.cycleRuns;
    if (!transcripts || !cycleRuns) throw new Error("cycle-run writers missing");
    await transcripts.append({
      runId: cycle.runId,
      attemptId: cycle.attemptId,
      instanceId: cycle.instanceId,
      sequence: 1,
      occurredAt: cycle.startedAt,
      event: { sequence: 1 } as never,
      run: { runId: cycle.runId } as never,
    });

    await expect(cycleRuns.write(cycle)).rejects.toThrow("transcript compression failed");
    expect(
      await readFile(join(dataDirectory, "transcripts", `${cycle.attemptId}.jsonl`), "utf8"),
    ).toContain('{"sequence":1}');
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a missing zstd binary as a compression failure", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "rehor-coordinator-"));
    const sink = createCompatibilitySink({
      dataDirectory,
      zstdCommand: join(dataDirectory, "missing-zstd"),
      logger: { warn: vi.fn() },
    });
    const cycleRuns = sink.writers.cycleRuns;
    if (!cycleRuns) throw new Error("cycle-run writer missing");

    await expect(cycleRuns.write(cycle)).rejects.toThrow("transcript compression failed");
  });

  it("renders escaped Prometheus labels and cumulative counter observations", async () => {
    const metrics = new PrometheusMetricStore();
    const points: MetricPoint[] = [
      {
        type: "counter",
        name: "devbot_cycles_total",
        value: 1,
        labels: { label: 'bot"1', status: "ok" },
      },
      {
        type: "counter",
        name: "devbot_cycles_total",
        value: 2,
        labels: { label: 'bot"1', status: "ok" },
      },
    ];
    for (const point of points) await metrics.observe(point);

    const output = metrics.render();
    expect(output).toContain("# TYPE devbot_cycles_total counter");
    expect(output).toContain('devbot_cycles_total{label="bot\\"1",status="ok"} 3');
  });

  it("sets gauges to their latest value rather than accumulating them", async () => {
    const metrics = new PrometheusMetricStore();
    for (const value of [1, 2, 0]) {
      await metrics.observe({
        type: "gauge",
        name: "devbot_preflight_consecutive_errors",
        value,
        labels: { label: "hcc-ai-framework" },
      });
    }

    expect(metrics.render()).toContain(
      'devbot_preflight_consecutive_errors{label="hcc-ai-framework"} 0',
    );
  });

  it("renders histogram bucket, sum, and count series", async () => {
    const metrics = new PrometheusMetricStore();
    await metrics.observe({
      type: "histogram",
      name: "devbot_cycle_duration_seconds",
      value: 42.5,
      labels: { label: "hcc-ai-framework", work_type: "task" },
      buckets: [30, 60],
    });

    const output = metrics.render();
    expect(output).toContain("# TYPE devbot_cycle_duration_seconds histogram");
    expect(output).toContain(
      'devbot_cycle_duration_seconds_bucket{label="hcc-ai-framework",le="30",work_type="task"} 0',
    );
    expect(output).toContain(
      'devbot_cycle_duration_seconds_bucket{label="hcc-ai-framework",le="60",work_type="task"} 1',
    );
    expect(output).toContain(
      'devbot_cycle_duration_seconds_bucket{label="hcc-ai-framework",le="+Inf",work_type="task"} 1',
    );
    expect(output).toContain(
      'devbot_cycle_duration_seconds_sum{label="hcc-ai-framework",work_type="task"} 42.5',
    );
    expect(output).toContain(
      'devbot_cycle_duration_seconds_count{label="hcc-ai-framework",work_type="task"} 1',
    );
  });

  it("keeps Python's legacy preflight metric label names and action values", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "rehor-coordinator-"));
    const sink = createCompatibilitySink({
      dataDirectory,
      compressTranscript: async (text) => Buffer.from(text),
    });
    await sink.writePreflightCycle({
      label: "hcc-ai-framework",
      instanceId: "instance-1",
      state: "idle",
      transcript: "No work found",
      inputPrompt: "No work found",
    });
    await sink.writePreflightCycle({
      label: "hcc-ai-framework",
      instanceId: "instance-1",
      state: "error",
      transcript: "Preflight failed",
      inputPrompt: "Preflight failed",
    });

    const output = sink.metricStore.render();
    expect(output).toContain(
      'devbot_preflight_outcome_total{action="skip",label="hcc-ai-framework"} 1',
    );
    expect(output).toContain(
      'devbot_preflight_outcome_total{action="error",label="hcc-ai-framework"} 1',
    );
  });
});
