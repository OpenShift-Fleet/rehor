import { execFileSync } from "node:child_process";
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

/** Concrete local/API projection used by the production coordinator entrypoint. */
export function createCompatibilitySink(options: CompatibilitySinkOptions): CompatibilitySink {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const logger = options.logger ?? console;
  const transcripts = new Map<string, StoredTranscript>();
  const compress =
    options.compressTranscript ??
    ((text: string) =>
      execFileSync(options.zstdCommand ?? "zstd", ["-q", "-c"], {
        input: text,
        maxBuffer: 16 * 1024 * 1024,
      }));

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
    const existing = transcripts.get(record.attemptId) ?? {
      attemptId: record.attemptId,
      records: [],
    };
    existing.records.push(record);
    transcripts.set(record.attemptId, existing);
  };

  const writeCycleRun = async (record: CycleRunRecord): Promise<void> => {
    const stored = transcripts.get(record.attemptId);
    const transcript = stored ? transcriptText(stored.records) : "";
    let transcriptBase64: string | undefined;
    try {
      const compressed = await compress(transcript);
      transcriptBase64 = Buffer.from(compressed).toString("base64");
      await mkdir(join(options.dataDirectory, "transcripts"), { recursive: true });
      await writeFile(
        join(options.dataDirectory, "transcripts", `${record.attemptId}.jsonl.zst`),
        compressed,
      );
    } catch (error) {
      logger.warn(`coordinator transcript compression failed: ${describe(error)}`);
    }

    const payload = toCycleRunPayload(record, transcriptBase64);
    await writeLocal("cycle-runs.jsonl", {
      ...payload,
      run_id: record.runId,
      attempt_id: record.attemptId,
    });
    await postJson(options.cycleRunsUrl, payload, fetchImpl, logger);
    transcripts.delete(record.attemptId);
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
      }
      await writeLocal("cycle-runs.jsonl", payload);
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
        name: "devbot_preflight_outcome_total",
        value: 1,
        labels: { outcome: input.state },
      });
    },
  };
}

export class PrometheusMetricStore {
  private readonly values = new Map<string, { point: MetricPoint; value: number }>();

  async observe(point: MetricPoint): Promise<void> {
    const key = `${point.name}|${stableLabels(point.labels)}`;
    const current = this.values.get(key);
    if (current) current.value += point.value;
    else this.values.set(key, { point, value: point.value });
  }

  render(): string {
    const groups = new Map<string, { type: "counter" | "gauge"; lines: string[] }>();
    for (const { point, value } of [...this.values.values()].sort((a, b) =>
      a.point.name.localeCompare(b.point.name),
    )) {
      const type = point.name.endsWith("_total") ? "counter" : "gauge";
      const group = groups.get(point.name) ?? { type, lines: [] };
      group.lines.push(`${point.name}${renderLabels(point.labels)} ${formatNumber(value)}`);
      groups.set(point.name, group);
    }

    const lines: string[] = [];
    for (const [name, group] of groups) {
      lines.push(`# TYPE ${name} ${group.type}`, ...group.lines);
    }
    return `${lines.join("\n")}\n`;
  }
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
    if (!response.ok)
      logger.warn(`coordinator compatibility POST ${url} returned HTTP ${response.status}`);
  } catch (error) {
    logger.warn(`coordinator compatibility POST ${url} failed: ${describe(error)}`);
  }
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

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
