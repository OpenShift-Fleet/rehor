import {
  assertTerminalEvent,
  assertUsagePayload,
  type RehorEvent,
  type RehorTerminalEvent,
} from "../domain/event";
import type { RehorRun } from "../domain/run";
import type { TerminalWorkContext } from "../domain/terminal-state";
import type { Usage } from "../domain/usage";
import type {
  CompatibilityWriters,
  CostRecord,
  CycleRunRecord,
  MetricPoint,
  StatusUpdate,
} from "../ports/compatibility";
import type { CoordinatorProjection } from "../ports/projection";

interface ProjectionState {
  startedAt: string;
  runtimeSessionRef: string | null;
  usages: Map<string, Usage>;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  modelUsage: Readonly<Record<string, Readonly<Record<string, number>>>>;
  model: string;
}

/** Maps normalized coordinator events to legacy status/cost/transcript outputs. */
export class LegacyCompatibilityProjection implements CoordinatorProjection {
  private readonly state = new Map<string, ProjectionState>();

  constructor(
    private readonly writers: CompatibilityWriters,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async onEvent(event: RehorEvent, run: RehorRun): Promise<void> {
    const state = this.stateFor(event, run);
    if (event.runtimeSessionRef) state.runtimeSessionRef = event.runtimeSessionRef;
    if (event.kind === "usage") this.recordUsage(state, event);

    await this.writers.transcripts?.append({
      runId: run.runId,
      attemptId: run.attemptId,
      instanceId: run.instanceId,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      event,
      run,
    });
    await this.writers.metrics?.observe({
      name: "devbot_events_total",
      value: 1,
      labels: { label: run.label, workflow: run.workflowId, kind: event.kind },
    });

    const status = statusForEvent(event, run);
    if (status) await this.writers.status?.write(status);
  }

  async onTerminal(event: RehorEvent & { kind: "terminal" }, run: RehorRun): Promise<void> {
    assertTerminalEvent(event);
    const state = this.stateFor(event, run);
    const payload = event.payload;
    const context = payload.context;
    const totals = aggregateUsage(state.usages, run);
    const noWork = payload.noWork === true || containsNoWork(payload.resultText ?? "");
    const isError = payload.state !== "completed";
    const durationMs = payload.durationMs ?? elapsedMs(state.startedAt, event.occurredAt);
    const cycleType = resolveCycleType(context?.workType, isError, noWork);
    const status = statusForTerminal(run, payload.state, payload.reason, noWork, context);

    await this.writers.status?.write(status);
    await this.writers.costs?.write(
      buildCostRecord(run, event, state, context, totals, noWork, isError, durationMs),
    );
    await this.writers.cycleRuns?.write(
      buildCycleRunRecord(run, event, state, context, cycleType, totals),
    );
    await observeTerminalMetrics(
      this.writers.metrics,
      run,
      payload.state,
      totals,
      durationMs,
      noWork,
    );
    this.state.delete(run.runId);
  }

  private stateFor(event: RehorEvent, run: RehorRun): ProjectionState {
    const existing = this.state.get(run.runId);
    if (existing) return existing;
    const state: ProjectionState = {
      startedAt: event.occurredAt || this.now(),
      runtimeSessionRef: null,
      usages: new Map(),
    };
    this.state.set(run.runId, state);
    return state;
  }

  private recordUsage(state: ProjectionState, event: RehorEvent): void {
    assertUsagePayload(event.payload);
    const usage = event.payload as Usage;
    const previous = state.usages.get(usage.requestedModel);
    // Usage events are snapshots: final wins over partial, latest partial replaces old partial.
    if (!previous || usage.final || !previous.final) {
      state.usages.set(usage.requestedModel, usage);
    }
  }
}

function statusForEvent(event: RehorEvent, run: RehorRun): StatusUpdate | null {
  if (event.kind === "run") {
    return {
      state: "working",
      message: "Starting cycle...",
      instanceId: run.instanceId,
    };
  }

  const text = stringPayload(event.payload, "text") ?? stringPayload(event.payload, "message");
  const tool = stringPayload(event.payload, "name");
  if (event.kind !== "agent" && event.kind !== "model" && event.kind !== "tool") return null;
  const message = text || (tool ? `Tool: ${tool}` : null);
  if (!message) return null;
  return {
    state: "working",
    message: message.slice(0, 500),
    instanceId: run.instanceId,
  };
}

function statusForTerminal(
  run: RehorRun,
  state: string,
  reason: string | undefined,
  noWork: boolean,
  context: TerminalWorkContext | undefined,
): StatusUpdate {
  const status: CompatibilityStatusForTerminal = noWork || state === "completed" ? "idle" : "error";
  return {
    state: status,
    message: noWork
      ? "No work found. Sleeping..."
      : status === "error"
        ? reason || "Cycle failed — check bot.log"
        : "Cycle complete. Sleeping...",
    instanceId: run.instanceId,
    ...(context?.externalKey ? { externalKey: context.externalKey } : {}),
    ...(context?.repository ? { repository: context.repository } : {}),
  };
}

type CompatibilityStatusForTerminal = "idle" | "error";

function buildCostRecord(
  run: RehorRun,
  event: RehorTerminalEvent,
  state: ProjectionState,
  context: TerminalWorkContext | undefined,
  totals: UsageTotals,
  noWork: boolean,
  isError: boolean,
  durationMs: number,
): CostRecord {
  return {
    timestamp: event.occurredAt || new Date().toISOString(),
    runId: run.runId,
    attemptId: run.attemptId,
    label: run.label,
    instanceId: run.instanceId,
    sessionId: state.runtimeSessionRef,
    numTurns: event.payload.turns ?? 0,
    durationMs,
    costUsd: totals.costUsd,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    model: totals.model,
    modelUsage: totals.modelUsage,
    isError,
    noWork,
    externalKey: context?.externalKey ?? null,
    repository: context?.repository ?? null,
    workType: context?.workType ?? null,
    summary: context?.summary ?? null,
  };
}

function buildCycleRunRecord(
  run: RehorRun,
  event: RehorTerminalEvent,
  state: ProjectionState,
  context: TerminalWorkContext | undefined,
  cycleType: string,
  totals: UsageTotals,
): CycleRunRecord {
  return {
    runId: run.runId,
    attemptId: run.attemptId,
    taskId: context?.taskId ?? null,
    cycleType,
    instanceId: run.instanceId,
    startedAt: state.startedAt,
    finishedAt: event.occurredAt,
    toolCalls: event.payload.turns ?? 0,
    tokensUsed: totals.inputTokens + totals.outputTokens,
    inputPrompt: run.prompt,
    progress: {
      externalKey: context?.externalKey ?? null,
      repository: context?.repository ?? null,
      workType: context?.workType ?? null,
      summary: context?.summary ?? null,
    },
  };
}

async function observeTerminalMetrics(
  writer: CompatibilityWriters["metrics"],
  run: RehorRun,
  state: string,
  totals: UsageTotals,
  durationMs: number,
  noWork: boolean,
): Promise<void> {
  if (!writer) return;
  const labels = { model: totals.model, label: run.label, workflow: run.workflowId };
  const points: MetricPoint[] = [
    { name: "devbot_cycles_total", value: 1, labels: { ...labels, status: state } },
    { name: "devbot_cycle_duration_seconds", value: durationMs / 1000, labels },
    { name: "devbot_cycle_cost_usd_total", value: totals.costUsd, labels },
    { name: "devbot_cycle_input_tokens_total", value: totals.inputTokens, labels },
    { name: "devbot_cycle_output_tokens_total", value: totals.outputTokens, labels },
    { name: "devbot_cycle_cache_read_tokens_total", value: totals.cacheReadTokens, labels },
    { name: "devbot_cycle_cache_write_tokens_total", value: totals.cacheWriteTokens, labels },
  ];
  if (noWork && totals.inputTokens + totals.outputTokens > 0) {
    points.push({
      name: "devbot_idle_with_tokens_total",
      value: 1,
      labels: { label: run.label, workflow: run.workflowId },
    });
  }
  for (const point of points) await writer.observe(point);
}

function aggregateUsage(usages: Map<string, Usage>, run: RehorRun): UsageTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  const modelUsage: Record<string, Record<string, number>> = {};

  for (const usage of usages.values()) {
    const model = usage.returnedModel ?? usage.requestedModel;
    const counts = usage.tokenCounts;
    const modelCounts = modelUsage[model] ?? {};
    modelUsage[model] = modelCounts;
    const input = counts.input ?? 0;
    const output = counts.output ?? 0;
    const cacheRead = counts.cacheRead ?? 0;
    const cacheWrite = counts.cacheWrite ?? 0;
    inputTokens += input;
    outputTokens += output;
    cacheReadTokens += cacheRead;
    cacheWriteTokens += cacheWrite;
    costUsd += usage.cost?.amount ?? 0;
    modelCounts.input_tokens = (modelCounts.input_tokens ?? 0) + input;
    modelCounts.output_tokens = (modelCounts.output_tokens ?? 0) + output;
    modelCounts.cache_read_input_tokens = (modelCounts.cache_read_input_tokens ?? 0) + cacheRead;
    modelCounts.cache_creation_input_tokens =
      (modelCounts.cache_creation_input_tokens ?? 0) + cacheWrite;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    modelUsage,
    model: Object.keys(modelUsage)[0] ?? run.provider.requestedModel,
  };
}

function resolveCycleType(workType: string | undefined, isError: boolean, noWork: boolean): string {
  if (isError) return "error";
  if (noWork) return "idle";
  if (workType === "new_ticket" || workType === "pr_review" || workType === "ci_fix") {
    return "task_work";
  }
  if (workType === "memory_housekeeping") return "idle";
  return "triage_only";
}

function containsNoWork(text: string): boolean {
  const lower = text.toLowerCase();
  return [
    "no_work_found",
    "no work found",
    "no work available",
    "nothing to do",
    "nothing to pick up",
    "no tickets",
    "no unassigned",
    "no assigned tickets",
    "0 unassigned",
  ].some((pattern) => lower.includes(pattern));
}

function stringPayload(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  return typeof payload[key] === "string" ? payload[key] : null;
}

function elapsedMs(startedAt: string, finishedAt: string): number {
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 0;
  return Math.max(0, finish - start);
}
