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
    expect(
      JSON.parse(await readFile(join(dataDirectory, "cycle-runs.jsonl"), "utf8")),
    ).toMatchObject({
      cycle_type: "task_work",
      instance_id: "instance-1",
    });
    expect(
      await readFile(join(dataDirectory, "transcripts", "attempt-1.jsonl.zst"), "utf8"),
    ).toContain("compressed:");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders escaped Prometheus labels and cumulative observations", async () => {
    const metrics = new PrometheusMetricStore();
    const points: MetricPoint[] = [
      { name: "devbot_cycles_total", value: 1, labels: { label: 'bot"1', status: "ok" } },
      { name: "devbot_cycles_total", value: 2, labels: { label: 'bot"1', status: "ok" } },
    ];
    for (const point of points) await metrics.observe(point);

    const output = metrics.render();
    expect(output).toContain("# TYPE devbot_cycles_total counter");
    expect(output).toContain('devbot_cycles_total{label="bot\\"1",status="ok"} 3');
  });
});
