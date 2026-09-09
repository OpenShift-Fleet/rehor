import type { RehorEvent } from "../domain/event";
import type { RehorRun } from "../domain/run";

export type CompatibilityWriteResult = void | PromiseLike<void>;

export interface CycleRunRecord {
  runId: string;
  attemptId: string;
  taskId: number | null;
  cycleType: string;
  instanceId: string;
  startedAt: string;
  finishedAt: string;
  toolCalls: number;
  tokensUsed: number;
  inputPrompt: string | null;
  progress: {
    externalKey: string | null;
    repository: string | null;
    workType: string | null;
    summary: string | null;
  };
}

export type CompatibilityStatus = "working" | "idle" | "error";

export interface StatusUpdate {
  state: CompatibilityStatus;
  message: string;
  instanceId: string;
  externalKey?: string;
  repository?: string;
}

export interface CostRecord {
  timestamp: string;
  runId: string;
  attemptId: string;
  label: string;
  instanceId: string;
  sessionId: string | null;
  numTurns: number;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
  modelUsage: Readonly<Record<string, Readonly<Record<string, number>>>>;
  isError: boolean;
  noWork: boolean;
  externalKey: string | null;
  repository: string | null;
  workType: string | null;
  summary: string | null;
}

export interface TranscriptEventRecord {
  runId: string;
  attemptId: string;
  instanceId: string;
  sequence: number;
  occurredAt: string;
  event: RehorEvent;
  run: RehorRun;
}

export interface MetricPoint {
  name: string;
  value: number;
  labels: Readonly<Record<string, string>>;
}

export interface CycleRunWriter {
  write(record: CycleRunRecord): CompatibilityWriteResult;
}

export interface StatusWriter {
  write(update: StatusUpdate): CompatibilityWriteResult;
}

export interface CostWriter {
  write(record: CostRecord): CompatibilityWriteResult;
}

export interface TranscriptWriter {
  append(record: TranscriptEventRecord): CompatibilityWriteResult;
}

export interface MetricsWriter {
  observe(point: MetricPoint): CompatibilityWriteResult;
}

/** Legacy output ports; implementations may write files, HTTP, or Prometheus. */
export interface CompatibilityWriters {
  cycleRuns?: CycleRunWriter;
  status?: StatusWriter;
  costs?: CostWriter;
  transcripts?: TranscriptWriter;
  metrics?: MetricsWriter;
}
