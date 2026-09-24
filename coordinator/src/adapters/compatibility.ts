import { spawn } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  CompatibilityWriters,
  CostRecord,
  CycleRunRecord,
  MetricPoint,
  StatusUpdate,
  TranscriptEventRecord,
} from "../ports/compatibility";

export interface CompatibilitySinkOptions {
  dataDirectory: string;
  statusUrl?: string;
  costsUrl?: string;
  cycleRunsUrl?: string;
  fetch?: typeof globalThis.fetch;
  logger?: Pick<Console, "warn">;
  zstdCommand?: string;
  compressTranscript?: (text: string) => Promise<Uint8Array> | Uint8Array;
}

export interface CompatibilitySink {
  writers: CompatibilityWriters;
  metricStore: PrometheusMetricStore;
  writePreflightCycle(input: PreflightCycleInput): Promise<void>;
}

export interface PreflightCycleInput {
  label: string;
  instanceId: string;
  state: "idle" | "error";
  transcript: string;
  inputPrompt: string;
  startedAt?: string;
  finishedAt?: string;
}

interface StoredTranscript {
  attemptId: string;
  records: TranscriptEventRecord[];
}

const MAX_COMPRESSED_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
/** Attempts that never reach a cycle-run write are evicted beyond this bound. */
const MAX_BUFFERED_TRANSCRIPTS = 8;

/** Concrete local/API projection used by the production coordinator entrypoint. */
export function createCompatibilitySink(options: CompatibilitySinkOptions): CompatibilitySink {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const logger = options.logger ?? console;
  const transcripts = new Map<string, StoredTranscript>();
  const compress =
    options.compressTranscript ??
    ((text: string) => zstdCompress(options.zstdCommand ?? "zstd", text));

  const writeLocal = async (fileName: string, value: unknown): Promise<void> => {
    await mkdir(options.dataDirectory, { recursive: true });
    await appendFile(join(options.dataDirectory, fileName), `${JSON.stringify(value)}\n`, "utf8");
  };

  const writeStatus = async (update: StatusUpdate): Promise<void> => {
    const payload = toStatusPayload(update);
    await writeLocal("status.jsonl", payload);
    await postJson(options.statusUrl, payload, fetchImpl, logger);
  };

  const appendTranscript = async (record: TranscriptEventRecord): Promise<void> => {
    let existing = transcripts.get(record.attemptId);
    if (!existing) {
      existing = { attemptId: record.attemptId, records: [] };
      transcripts.set(record.attemptId, existing);
      // Map iteration is insertion-ordered, so the first keys are the oldest.
      for (const attemptId of transcripts.keys()) {
        if (transcripts.size <= MAX_BUFFERED_TRANSCRIPTS) break;
        transcripts.delete(attemptId);
      }
    }
    existing.records.push(record);
  };

  const writeCycleRun = async (record: CycleRunRecord): Promise<void> => {
    const stored = transcripts.get(record.attemptId);
    transcripts.delete(record.attemptId);
    const transcript = stored ? transcriptText(stored.records) : "";
    const transcriptDirectory = join(options.dataDirectory, "transcripts");
    const transcriptFile = `${record.attemptId}.jsonl.zst`;
    let transcriptBase64: string;
    await mkdir(transcriptDirectory, { recursive: true });
    try {
      const compressed = await compress(transcript);
      transcriptBase64 = Buffer.from(compressed).toString("base64");
      await writeFile(join(transcriptDirectory, transcriptFile), compressed);
    } catch (error) {
      // Keep the uncompressed transcript for diagnosis; it is only written on failure.
      await writeFile(join(transcriptDirectory, `${record.attemptId}.jsonl`), transcript, "utf8");
      logger.warn(`coordinator transcript compression failed: ${describe(error)}`);
      throw new Error(`coordinator transcript compression failed: ${describe(error)}`, {
        cause: error,
      });
    }

    const payload = toCycleRunPayload(record, transcriptBase64);
    // The local record points at the .zst file instead of repeating it as base64.
    const { transcript_b64: _transcript, ...localPayload } = payload;
    await writeLocal("cycle-runs.jsonl", {
      ...localPayload,
      run_id: record.runId,
      attempt_id: record.attemptId,
      transcript_path: join("transcripts", transcriptFile),
    });
    await postJson(options.cycleRunsUrl, payload, fetchImpl, logger);
  };

  const writeCost = async (record: CostRecord): Promise<void> => {
    const payload = toLegacyCostEntry(record);
    await writeLocal("costs.jsonl", payload);
    await postJson(options.costsUrl, payload, fetchImpl, logger);
  };

  const metrics = new PrometheusMetricStore();
  const writers: CompatibilityWriters = {
    status: { write: writeStatus },
    costs: { write: writeCost },
    transcripts: { append: appendTranscript },
    cycleRuns: { write: writeCycleRun },
    metrics: { observe: (point) => metrics.observe(point) },
  };

  return {
    writers,
    metricStore: metrics,
    async writePreflightCycle(input) {
      const startedAt = input.startedAt ?? new Date().toISOString();
      const finishedAt = input.finishedAt ?? new Date().toISOString();
      const payload = {
        task_id: null,
        cycle_type: input.state === "idle" ? "preflight_skip" : "preflight_error",
        instance_id: input.instanceId,
        started_at: startedAt,
        finished_at: finishedAt,
        tool_calls: 0,
        tokens_used: 0,
        input_prompt: input.inputPrompt,
        progress: {
          external_key: null,
          repo: null,
          work_type: input.state === "idle" ? "idle" : "error",
          summary: input.transcript,
        },
        transcript_b64: undefined as string | undefined,
      };
      try {
        payload.transcript_b64 = Buffer.from(await compress(input.transcript)).toString("base64");
      } catch (error) {
        logger.warn(`coordinator preflight transcript compression failed: ${describe(error)}`);
        throw new Error(`coordinator preflight transcript compression failed: ${describe(error)}`, {
          cause: error,
        });
      }
      const { transcript_b64: _transcript, ...localPayload } = payload;
      await writeLocal("cycle-runs.jsonl", localPayload);
      await postJson(options.cycleRunsUrl, omitUndefined(payload), fetchImpl, logger);
      await writeStatus({
        state: input.state,
        message:
          input.state === "idle"
            ? "No work found. Sleeping..."
            : "Preflight failed — check bot.log",
        instanceId: input.instanceId,
      });
      await metrics.observe({
        type: "counter",
        name: "devbot_preflight_outcome_total",
        value: 1,
        labels: { label: input.label, action: input.state === "idle" ? "skip" : "error" },
      });
    },
  };
}

type ScalarMetricPoint = Extract<MetricPoint, { type: "counter" | "gauge" }>;
type HistogramMetricPoint = Extract<MetricPoint, { type: "histogram" }>;
type StoredMetric =
  | { kind: "scalar"; point: ScalarMetricPoint; value: number }
  | {
      kind: "histogram";
      point: HistogramMetricPoint;
      bucketCounts: number[];
      count: number;
      sum: number;
    };

export class PrometheusMetricStore {
  private readonly values = new Map<string, StoredMetric>();
  private readonly definitions = new Map<
    string,
    { type: MetricPoint["type"]; buckets?: readonly number[] }
  >();

  async observe(point: MetricPoint): Promise<void> {
    const definition = this.definitions.get(point.name);
    if (definition && definition.type !== point.type) {
      throw new Error(`Prometheus metric '${point.name}' changed type`);
    }
    if (
      point.type === "histogram" &&
      definition?.buckets &&
      !sameBuckets(definition.buckets, point.buckets)
    ) {
      throw new Error(`Prometheus histogram '${point.name}' changed buckets`);
    }
    if (!definition) {
      this.definitions.set(point.name, {
        type: point.type,
        ...(point.type === "histogram" ? { buckets: [...point.buckets] } : {}),
      });
    }

    const key = `${point.name}|${stableLabels(point.labels)}`;
    const current = this.values.get(key);
    if (!current) {
      if (point.type === "histogram") {
        const histogram: StoredMetric = {
          kind: "histogram",
          point,
          bucketCounts: point.buckets.map(() => 0),
          count: 0,
          sum: 0,
        };
        this.observeHistogram(histogram, point.value);
        this.values.set(key, histogram);
      } else {
        this.values.set(key, { kind: "scalar", point, value: point.value });
      }
      return;
    }

    if (current.kind === "histogram") {
      if (point.type !== "histogram")
        throw new Error(`Prometheus metric '${point.name}' changed type`);
      this.observeHistogram(current, point.value);
    } else {
      if (point.type === "histogram")
        throw new Error(`Prometheus metric '${point.name}' changed type`);
      current.value = point.type === "counter" ? current.value + point.value : point.value;
    }
  }

  render(): string {
    const groups = new Map<string, { type: MetricPoint["type"]; lines: string[] }>();
    const values = [...this.values.values()].sort((a, b) => {
      const nameOrder = a.point.name.localeCompare(b.point.name);
      return nameOrder || stableLabels(a.point.labels).localeCompare(stableLabels(b.point.labels));
    });
    for (const metric of values) {
      const point = metric.point;
      const group = groups.get(point.name) ?? { type: point.type, lines: [] };
      if (metric.kind === "histogram") {
        const histogramPoint = metric.point;
        histogramPoint.buckets.forEach((bound, index) => {
          group.lines.push(
            `${histogramPoint.name}_bucket${renderLabels({ ...histogramPoint.labels, le: String(bound) })} ${metric.bucketCounts[index]}`,
          );
        });
        group.lines.push(
          `${histogramPoint.name}_bucket${renderLabels({ ...histogramPoint.labels, le: "+Inf" })} ${metric.count}`,
          `${histogramPoint.name}_sum${renderLabels(histogramPoint.labels)} ${String(metric.sum)}`,
          `${histogramPoint.name}_count${renderLabels(histogramPoint.labels)} ${metric.count}`,
        );
      } else {
        group.lines.push(`${point.name}${renderLabels(point.labels)} ${String(metric.value)}`);
      }
      groups.set(point.name, group);
    }

    const lines: string[] = [];
    for (const [name, group] of groups) {
      lines.push(`# TYPE ${name} ${group.type}`, ...group.lines);
    }
    return `${lines.join("\n")}\n`;
  }

  private observeHistogram(
    metric: Extract<StoredMetric, { kind: "histogram" }>,
    value: number,
  ): void {
    metric.count += 1;
    metric.sum += value;
    metric.point.buckets.forEach((bound, index) => {
      if (value <= bound) metric.bucketCounts[index] = (metric.bucketCounts[index] ?? 0) + 1;
    });
  }
}

function sameBuckets(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function toLegacyCostEntry(record: CostRecord): Record<string, unknown> {
  return {
    timestamp: record.timestamp,
    label: record.label,
    session_id: record.sessionId ?? "",
    num_turns: record.numTurns,
    duration_ms: record.durationMs,
    cost_usd: record.costUsd,
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    cache_read_tokens: record.cacheReadTokens,
    cache_write_tokens: record.cacheWriteTokens,
    model: record.model,
    model_usage: record.modelUsage,
    is_error: record.isError,
    no_work: record.noWork,
    instance_id: record.instanceId,
    external_key: record.externalKey,
    repo: record.repository,
    work_type: record.workType,
    summary: record.summary,
    run_id: record.runId,
    attempt_id: record.attemptId,
    runtime_id: record.runtimeId ?? "unknown",
    provider_id: record.providerId ?? "unknown",
  };
}

export function toCycleRunPayload(
  record: CycleRunRecord,
  transcriptBase64?: string,
): Record<string, unknown> {
  return omitUndefined({
    task_id: record.taskId,
    cycle_type: record.cycleType,
    instance_id: record.instanceId,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    tool_calls: record.toolCalls,
    tokens_used: record.tokensUsed,
    input_prompt: record.inputPrompt,
    progress: {
      external_key: record.progress.externalKey,
      repo: record.progress.repository,
      work_type: record.progress.workType,
      summary: record.progress.summary,
    },
    transcript_b64: transcriptBase64,
  });
}

function toStatusPayload(update: StatusUpdate): Record<string, unknown> {
  return {
    state: update.state,
    message: update.message,
    instance_id: update.instanceId,
    ...(update.externalKey === undefined ? {} : { external_key: update.externalKey }),
    ...(update.repository === undefined ? {} : { repo: update.repository }),
  };
}

function transcriptText(records: readonly TranscriptEventRecord[]): string {
  return (
    records.map((record) => JSON.stringify(record.event)).join("\n") + (records.length ? "\n" : "")
  );
}

/**
 * Best-effort dashboard projection. Like Python's _push_status, a failed POST is
 * logged and dropped so an unavailable memory-server never aborts a live run;
 * the local JSONL record written beforehand remains the durable copy.
 */
async function postJson(
  url: string | undefined,
  payload: Record<string, unknown>,
  fetchImpl: typeof globalThis.fetch,
  logger: Pick<Console, "warn">,
): Promise<void> {
  if (!url) return;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    logger.warn(`coordinator compatibility POST ${url} failed: ${describe(error)}`);
  }
}

/** Compress with the zstd CLI without blocking the event loop. */
function zstdCompress(command: string, text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["-q", "-c"], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_COMPRESSED_TRANSCRIPT_BYTES) {
        fail(new Error("zstd output exceeded limit"));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        resolve(Buffer.concat(chunks));
        return;
      }
      fail(new Error(`zstd exited with ${code ?? signal}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
    child.stdin.end(text, "utf8");
  });
}

function stableLabels(labels: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
}

function renderLabels(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
