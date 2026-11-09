import { providerDiagnostic } from "./diagnostics";
import {
  type AbortCause,
  createEventFactory,
  EventLedger,
  parseRehorRun,
  type RehorEvent,
  type RehorRun,
  type RuntimeCapabilities,
  RuntimeContractError,
  type TerminalEventPayload,
  type Usage,
  UsageLedger,
  type ValidatedRehorRun,
  WorkContextTracker,
} from "./domain";
import { type Logger, safeText } from "./log";
import type { AgentRuntime, AgentRuntimeRunContext } from "./ports/agent-runtime";
import type { CoordinatorProjection } from "./ports/projection";
import { type CombinedAbortSignals, combineAbortSignals, isRecord } from "./utils";

export const CoordinatorAbortKind = {
  Cancelled: "cancelled",
  Shutdown: "shutdown",
  TimedOut: "timed_out",
  Failed: "failed",
} as const;
export type CoordinatorAbortKind = AbortCause["kind"];

export interface CoordinatorOptions {
  /** Aborts the attempt as cancelled. */
  signal?: AbortSignal;
  /** Aborts the attempt as interrupted, normally for SIGTERM/SIGINT. */
  shutdownSignal?: AbortSignal;
  projection?: CoordinatorProjection;
  /** Best-effort progress output for accepted normalized runtime events. */
  logger?: Pick<Logger, "log">;
  /** Legacy clock override; also used for elapsed time when monotonicNow is absent. */
  now?: () => number;
  /** Monotonic clock in milliseconds for duration/timeout accounting. */
  monotonicNow?: () => number;
}

export interface CoordinatorResult {
  run: RehorRun;
  capabilities?: RuntimeCapabilities;
  events: readonly RehorEvent[];
  terminal: RehorEvent & { kind: "terminal"; payload: TerminalEventPayload };
  durationMs: number;
  /** Runtime, contract, projection, or cleanup failure. Expected aborts are omitted. */
  error?: unknown;
}

/** Error used when a runtime ends without producing the required terminal event. */
export class CoordinatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinatorError";
  }
}

/** Runtime cleanup failed independently of the work terminal state. */
export class RuntimeCleanupError extends Error {
  constructor(
    readonly previousFailures: readonly unknown[] = [],
    diagnosticCause?: string,
  ) {
    super(
      "Runtime cleanup failed",
      previousFailures.length
        ? { cause: previousFailures[0] }
        : diagnosticCause
          ? { cause: diagnosticCause }
          : undefined,
    );
    this.name = "RuntimeCleanupError";
  }
}

class CoordinatorAbort extends Error {
  constructor(readonly cause: AbortCause) {
    super(abortMessage(cause));
    this.name = "CoordinatorAbort";
  }
}

interface CostPolicyEvent extends Record<string, unknown> {
  state: "info" | "warning" | "critical" | "exhausted";
  label: string;
  usedUsd: number;
  budgetUsd: number;
  message: string;
}

export type { CostPolicyEvent };

const UNKNOWN_PRICING_MESSAGE =
  "COST BUDGET INACTIVE: model pricing is unknown for this run, so the cost cap " +
  "is not enforced. The cycle timeout still applies.";

/** Grace window: the run hard-aborts once spend reaches this multiple of the budget. */
const HARD_LIMIT_MULTIPLIER = 1.15;

const roundUsd = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * Per-cycle-run USD cost budget. Threshold notices let the agent save state via
 * task_update; the 115% hard limit aborts the run with reason budget_exceeded.
 * Runs whose usage never reports known pricing fail open on a one-time notice.
 */
export class CostBudgetPolicy {
  private readonly ledger = new UsageLedger();
  private readonly emitted = new Set<CostPolicyEvent["state"]>();
  private unknownPricingNotified = false;

  constructor(private readonly run: RehorRun) {}

  observe(usage: Usage): CostPolicyEvent | undefined {
    this.ledger.record(usage);
    if (!this.ledger.hasKnownCost()) {
      // Fail open only when pricing is affirmatively unknown. An in-flight
      // snapshot may simply not have settled its cost yet, so a missing cost
      // alone must not disable the budget; the cycle timeout still applies.
      if (usage.cost?.source !== "unknown" || this.unknownPricingNotified) return undefined;
      this.unknownPricingNotified = true;
      return this.event("warning", UNKNOWN_PRICING_MESSAGE);
    }

    const budgetUsd = this.run.limits.budgetUsd;
    const ratio = this.ledger.totalCostUsd() / budgetUsd;
    const state =
      ratio >= 1
        ? "exhausted"
        : ratio >= 0.9
          ? "critical"
          : ratio >= 0.75
            ? "warning"
            : ratio >= 0.5
              ? "info"
              : undefined;
    if (state === undefined || this.emitted.has(state)) return undefined;
    this.emitted.add(state);
    return this.event(state, budgetMessage(state, this.ledger.totalCostUsd(), budgetUsd));
  }

  hardLimitReached(): boolean {
    return this.ledger.totalCostUsd() >= this.run.limits.budgetUsd * HARD_LIMIT_MULTIPLIER;
  }

  private event(state: CostPolicyEvent["state"], message: string): CostPolicyEvent {
    return {
      state,
      label: this.run.label,
      usedUsd: roundUsd(this.ledger.totalCostUsd()),
      budgetUsd: roundUsd(this.run.limits.budgetUsd),
      message,
    };
  }
}

function budgetMessage(
  state: CostPolicyEvent["state"],
  usedUsd: number,
  budgetUsd: number,
): string {
  const used = roundUsd(usedUsd);
  const budget = roundUsd(budgetUsd);
  const remaining = roundUsd(Math.max(0, budgetUsd - usedUsd));
  switch (state) {
    case "info":
      return `COST BUDGET: $${used} of $${budget} used. Plan remaining work accordingly.`;
    case "warning":
      return (
        `COST BUDGET WARNING: $${used}/${budget} used (~$${remaining} remaining). ` +
        "Save progress soon via task_update (summary + metadata with last_step, " +
        "files_changed, next_step). Prioritize completing the current step."
      );
    case "critical":
      return (
        `COST BUDGET CRITICAL: $${used}/${budget} used (~$${remaining} remaining). ` +
        "Save progress NOW via task_update with current summary, last_step, " +
        "files_changed, and next_step. Then wrap up or stop."
      );
    case "exhausted":
      return (
        `COST BUDGET EXHAUSTED: $${used}/${budget} used. Wrap up now: save state ` +
        "via task_update and finish only essential bookkeeping. The run will be " +
        "stopped if cost reaches the hard limit."
      );
  }
}

/**
 * Runs one provider-neutral attempt and projects its normalized lifecycle.
 *
 * Runtime failures resolve to a failed terminal result so callers can persist
 * partial usage and transcript events. Malformed events remain visible through
 * `result.error` while cleanup and terminal projection still run.
 */
export async function executeRun(
  runtime: AgentRuntime,
  input: RehorRun,
  options: CoordinatorOptions = {},
): Promise<CoordinatorResult> {
  return executeRunWithValidatedInput(runtime, parseRehorRun(input), options);
}

/** Runs a run already validated by parseRehorRun. */
export async function executeRunWithValidatedInput(
  runtime: AgentRuntime,
  run: ValidatedRehorRun,
  options: CoordinatorOptions = {},
): Promise<CoordinatorResult> {
  const ledger = new EventLedger(run);
  const workContext = new WorkContextTracker(run);
  const wallClockNow = options.now ?? Date.now;
  const elapsedNow = options.monotonicNow ?? options.now ?? monotonicClock;
  const startedAt = elapsedNow();
  const abortState = combineAbortSignals(options);
  const timeout = setTimeout(
    () =>
      abortState.abort({
        kind: CoordinatorAbortKind.TimedOut,
        reason: `run timed out after ${run.limits.timeoutMs}ms`,
      }),
    run.limits.timeoutMs,
  );

  let capabilities: RuntimeCapabilities | undefined;
  let failure: unknown;
  let cleanupError: unknown;
  let cleanupFailed = false;
  let acceptingEvents = true;
  let stopPromise: Promise<void> | undefined;
  const stopRuntime = (): Promise<void> => {
    stopPromise ??= Promise.resolve().then(() => runtime.stop());
    return stopPromise;
  };

  try {
    if (abortState.signal.aborted) {
      const cause = abortState.cause;
      if (cause) failure = new CoordinatorAbort(cause);
    } else {
      try {
        capabilities = await raceWithAbort(() => runtime.start(abortState.signal), abortState);
      } catch (error) {
        failure = error;
      }

      const cause = abortState.cause;
      if (!failure && capabilities && !cause) {
        const consumePromise = consumeEvents(
          runtime,
          run,
          abortState,
          ledger,
          options.projection,
          options.logger,
          workContext,
          () => acceptingEvents,
        );
        try {
          await raceWithAbort(
            () => consumePromise,
            abortState,
            async () => {
              try {
                await stopRuntime();
              } finally {
                await consumePromise.catch(() => undefined);
              }
            },
          );
        } catch (error) {
          failure = error;
        }
      }
    }

    const cause = abortState.cause;
    if (!failure && cause) failure = new CoordinatorAbort(cause);
    if (!failure && !ledger.terminalEvent) {
      const missingTerminalError = new CoordinatorError("runtime ended without terminal event");
      failure = missingTerminalError;
      abortState.abort({
        kind: CoordinatorAbortKind.Failed,
        reason: missingTerminalError.message,
      });
    }
  } finally {
    acceptingEvents = false;
    if (failure && !abortState.signal.aborted) {
      abortState.abort({
        kind: CoordinatorAbortKind.Failed,
        reason: describeError(failure),
      });
    }

    try {
      await stopRuntime();
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
      if (!failure) failure = error;
    }

    clearTimeout(timeout);
    abortState.dispose();
  }

  if (!ledger.terminalEvent) {
    const terminal = workContext.enrichTerminal(
      createTerminalEvent(
        run,
        nextSequence(ledger.events),
        terminalState(abortState.cause),
        terminalReason(abortState.cause, failure),
        Math.max(0, Math.floor(elapsedNow() - startedAt)),
        wallClockNow,
      ),
    );
    ledger.ingest(terminal);
    try {
      await projectEvent(terminal, run, options.projection);
    } catch (error) {
      if (!failure) failure = error;
    }
  }

  const terminal = ledger.requireTerminal();
  const cause = abortState.cause;
  const surfacedFailure = shouldSurface(failure, cause) ? failure : undefined;
  const runtimeCleanupFailure = ledger.events.find(
    (event) => event.kind === "cleanup" && event.payload.state === "failed",
  );
  // Stop failures are independent of work and abort causes. Always classify
  // them so the loop can count them even if shutdown races with a failed run.
  const previousFailures: unknown[] = surfacedFailure === undefined ? [] : [surfacedFailure];
  if (cleanupFailed && !previousFailures.includes(cleanupError))
    previousFailures.push(cleanupError);
  // Cleanup event messages are untrusted; retain only a fixed classification as fallback.
  const surfacedError =
    runtimeCleanupFailure || cleanupFailed
      ? new RuntimeCleanupError(
          previousFailures,
          previousFailures.length === 0 && runtimeCleanupFailure
            ? providerDiagnostic(runtimeCleanupFailure.payload.message)
            : undefined,
        )
      : surfacedFailure;

  return {
    run,
    ...(capabilities ? { capabilities } : {}),
    events: ledger.events,
    terminal,
    durationMs: Math.max(0, Math.floor(elapsedNow() - startedAt)),
    ...(surfacedError === undefined ? {} : { error: surfacedError }),
  };
}

async function consumeEvents(
  runtime: AgentRuntime,
  run: RehorRun,
  abortState: CombinedAbortSignals,
  ledger: EventLedger,
  projection: CoordinatorProjection | undefined,
  logger: Pick<Logger, "log"> | undefined,
  workContext: WorkContextTracker,
  isAccepting: () => boolean,
): Promise<void> {
  const costBudget = new CostBudgetPolicy(run);
  const childSessionRefs = new Set<string>();
  const assistantTextBuffer = logger ? new AssistantTextPreviewBuffer(logger) : undefined;
  const acceptedSequences = new Set(ledger.events.map(({ sequence }) => sequence));
  let coordinatorEventOffset = 0;

  const accept = (event: RehorEvent): RehorEvent | undefined => {
    const before = ledger.events.length;
    if (!ledger.ingest(event).accepted) return undefined;
    const retained = ledger.events[before];
    if (!retained) throw new RuntimeContractError("accepted event was not retained by ledger");
    acceptedSequences.add(retained.sequence);
    return retained;
  };

  const emitPolicy = async (policy: CostPolicyEvent, parent?: RehorEvent): Promise<void> => {
    const createEvent = createEventFactory(run, run.policyHash.value, {
      startSequence: nextSequence(ledger.events) - 1,
    });
    const policyEvent = createEvent("policy", policy, {
      runtimeSessionRef: parent?.runtimeSessionRef,
      parentEventId: parent?.eventId,
    });
    const acceptedPolicyEvent = accept(policyEvent);
    if (!acceptedPolicyEvent) return;
    coordinatorEventOffset += 1;
    await projectEvent(acceptedPolicyEvent, run, projection);
  };

  const context: AgentRuntimeRunContext = {
    onAbortCause(cause) {
      abortState.abort(cause);
    },
  };
  const iterator = runtime.run(run, abortState.signal, context)[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      // Runtime adapters may emit a final partial usage snapshot and terminal
      // event while draining an SDK query after cancellation or timeout.
      // Keep accepting that bounded drain; stop accepting only once the
      // coordinator cleanup has completed.
      if (!isAccepting()) return;

      const normalizedEvent = workContext.enrichTerminal(
        mapRuntimeTerminal(next.value, abortState.cause),
      );
      const sequencedEvent = sequenceAfterCoordinatorEvents(
        normalizedEvent,
        coordinatorEventOffset,
        acceptedSequences,
      );
      const event = accept(sequencedEvent);
      if (!event) continue;
      workContext.observe(event);
      if (
        event.kind === "run" &&
        event.payload.state === "child_session_started" &&
        typeof event.runtimeSessionRef === "string"
      ) {
        childSessionRefs.add(event.runtimeSessionRef);
      }
      logProgress(logger, event, childSessionRefs, assistantTextBuffer);
      await projectEvent(event, run, projection);

      if (event.kind === "usage") {
        const policy = costBudget.observe(event.payload as Usage);
        if (policy) {
          await emitPolicy(policy, event);
          context.onPolicyNotice?.(policy.message);
        }
        if (costBudget.hardLimitReached()) {
          abortState.abort({ kind: CoordinatorAbortKind.Failed, reason: "budget_exceeded" });
        }
      }
    }
  } finally {
    await iterator.return?.();
  }
}

const MAX_ASSISTANT_PREVIEW_LENGTH = 300;
// Streaming deltas are buffered until a redaction-safe boundary so a secret
// split across deltas cannot evade environment-value and pattern redaction.
// Text past the cap is dropped, never emitted as a separate mid-part slice,
// so no raw split point can fall inside a secret and evade whole-value
// redaction when logged previews are concatenated.
const MAX_ASSISTANT_TEXT_BUFFER = 16 * 1024;

type ActivityScope = "root" | "subagent";

interface BufferedAssistantText {
  scope: ActivityScope;
  text: string;
  truncated: boolean;
}

/** Buffers streaming assistant text so previews are only redacted as a whole. */
class AssistantTextPreviewBuffer {
  private readonly pending = new Map<string, BufferedAssistantText>();
  private readonly seenParts = new Set<string>();

  constructor(private readonly logger: Pick<Logger, "log">) {}

  appendDelta(scopeKey: string, scope: ActivityScope, text: string, partId?: string): void {
    if (partId !== undefined) this.seenParts.add(partId);
    this.extend(scopeKey, scope, text);
  }

  appendPart(scopeKey: string, scope: ActivityScope, text: string, partId?: string): void {
    // Completed-message parts repeat text already streamed for the part.
    if (partId !== undefined) {
      if (this.seenParts.has(partId)) return;
      this.seenParts.add(partId);
    }
    this.extend(scopeKey, scope, text);
  }

  private extend(scopeKey: string, scope: ActivityScope, text: string): void {
    const current = this.pending.get(scopeKey) ?? { scope, text: "", truncated: false };
    if (!current.truncated) {
      const room = MAX_ASSISTANT_TEXT_BUFFER - current.text.length;
      current.text += text.slice(0, room);
      current.truncated = text.length > room;
    }
    this.pending.set(scopeKey, current);
  }

  flush(scopeKey: string): void {
    const buffered = this.pending.get(scopeKey);
    if (!buffered) return;
    this.pending.delete(scopeKey);
    this.emit(buffered.scope, buffered.text, buffered.truncated);
  }

  flushAll(): void {
    for (const scopeKey of [...this.pending.keys()]) this.flush(scopeKey);
  }

  private emit(scope: ActivityScope, text: string, truncated: boolean): void {
    if (!text) return;
    const redacted = safeText(text);
    const preview = redacted.slice(0, MAX_ASSISTANT_PREVIEW_LENGTH);
    this.logger.log("INFO", "Assistant text", {
      activity_scope: scope,
      text_preview: `${preview}${truncated || redacted.length > preview.length ? "…" : ""}`,
    });
  }
}

/** Logs safe, provider-neutral progress without allowing logging to affect a run. */
function logProgress(
  logger: Pick<Logger, "log"> | undefined,
  event: RehorEvent,
  childSessionRefs: ReadonlySet<string>,
  textBuffer: AssistantTextPreviewBuffer | undefined,
): void {
  if (!logger || !textBuffer) return;
  try {
    const scopeKey = event.runtimeSessionRef ?? "";
    const activityScope: ActivityScope =
      event.runtimeSessionRef && childSessionRefs.has(event.runtimeSessionRef)
        ? "subagent"
        : "root";

    if (event.kind === "terminal") {
      textBuffer.flushAll();
      return;
    }

    if (event.kind === "run") {
      // Every run state change ends any pending assistant text part.
      textBuffer.flush(scopeKey);
      if (event.payload.state === "child_session_started") {
        logger.log("INFO", "Subagent session started", { activity_scope: "subagent" });
        return;
      }
      if (event.payload.state === "turn_started") {
        logger.log("INFO", "Turn started", { activity_scope: activityScope });
      }
      return;
    }

    if (event.kind === "model") {
      const phase = event.payload.phase;
      if (phase === "reasoning") return;

      if (event.payload.role === "assistant" && typeof event.payload.text === "string") {
        // Complete assistant messages already carry whole text.
        textBuffer.flush(scopeKey);
        const redacted = safeText(event.payload.text);
        const preview = redacted.slice(0, MAX_ASSISTANT_PREVIEW_LENGTH);
        logger.log("INFO", "Assistant text", {
          activity_scope: activityScope,
          text_preview: `${preview}${redacted.length > preview.length ? "…" : ""}`,
        });
        return;
      }
      if (phase === "text") {
        const partId = typeof event.payload.partId === "string" ? event.payload.partId : undefined;
        // Per-delta redaction would let a secret split across streaming deltas
        // reach the log, so text is buffered until a redaction-safe boundary.
        if (typeof event.payload.delta === "string") {
          textBuffer.appendDelta(scopeKey, activityScope, event.payload.delta, partId);
        } else if (typeof event.payload.text === "string") {
          textBuffer.appendPart(scopeKey, activityScope, event.payload.text, partId);
        }
      }
      return;
    }

    if (event.kind === "tool") {
      textBuffer.flush(scopeKey);
      const rawState = event.payload.state;
      const isError =
        event.payload.isError === true || rawState === "failed" || rawState === "error";
      const state = rawState === "started" ? "started" : isError ? "failed" : "completed";
      const duration = event.payload.durationMs;
      const rawName =
        typeof event.payload.name === "string"
          ? event.payload.name
          : typeof event.payload.toolName === "string"
            ? event.payload.toolName
            : "unknown";
      logger.log(isError ? "WARNING" : "INFO", isError ? "Tool failed" : `Tool ${state}`, {
        activity_scope: activityScope,
        tool_name: safeText(rawName).slice(0, 200),
        state,
        ...(typeof duration === "number" && Number.isFinite(duration)
          ? { duration_ms: duration }
          : {}),
        ...(isError ? { failed: true } : {}),
      });
      return;
    }
  } catch {
    // Event logging is diagnostic only and must never interrupt execution.
  }
}

function mapRuntimeTerminal(event: RehorEvent, cause: AbortCause | undefined): RehorEvent {
  if (event.kind !== "terminal") return event;
  const payload = event.payload as TerminalEventPayload;
  if (payload.state !== "failed" || !cause) return event;
  const state = terminalState(cause);
  const reason = terminalReason(cause, undefined);
  return {
    ...event,
    payload: {
      ...payload,
      state,
      reason,
    },
  };
}

function sequenceAfterCoordinatorEvents(
  event: RehorEvent,
  offset: number,
  acceptedSequences: ReadonlySet<number>,
): RehorEvent {
  if (offset === 0) return event;
  let sequence = event.sequence + offset;
  while (acceptedSequences.has(sequence)) sequence += 1;
  return { ...event, sequence };
}

async function projectEvent(
  event: RehorEvent,
  run: RehorRun,
  projection: CoordinatorProjection | undefined,
): Promise<void> {
  await projection?.onEvent?.(event, run);
  if (event.kind === "terminal") {
    await projection?.onTerminal?.(event as RehorEvent & { kind: "terminal" }, run);
  }
}

async function raceWithAbort<T>(
  operation: () => Promise<T> | T,
  abortState: CombinedAbortSignals,
  cleanup?: () => Promise<void>,
): Promise<T> {
  const operationResult = Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
  const result = await Promise.race([
    operationResult,
    abortState.aborted.then((cause) => ({ kind: "abort" as const, cause })),
  ]);

  if (result.kind === "abort") {
    await cleanup?.().catch(() => undefined);
    throw new CoordinatorAbort(result.cause);
  }
  if (result.kind === "error") throw result.error;
  return result.value;
}

function createTerminalEvent(
  run: RehorRun,
  sequence: number,
  state: TerminalEventPayload["state"],
  reason: string,
  durationMs: number,
  now: () => number,
): RehorEvent & { kind: "terminal"; payload: TerminalEventPayload } {
  return {
    schemaVersion: "1",
    eventId: `coordinator-terminal-${run.attemptId}`,
    runId: run.runId,
    attemptId: run.attemptId,
    sequence,
    occurredAt: new Date(now()).toISOString(),
    kind: "terminal",
    workspace: {
      worktreePath: run.worktree.path,
      repository: run.worktree.repository,
      snapshot: run.worktree.snapshot.commitSha,
    },
    provider: run.provider.id,
    model: run.provider.requestedModel,
    policyVersion: run.policyHash.value,
    payload: { state, reason, durationMs },
  };
}

const STATE_BY_CAUSE = {
  timed_out: "timed_out",
  shutdown: "interrupted",
  cancelled: "cancelled",
  failed: "failed",
} as const;

function terminalState(cause: AbortCause | undefined): TerminalEventPayload["state"] {
  return cause ? STATE_BY_CAUSE[cause.kind] : "failed";
}

function terminalReason(cause: AbortCause | undefined, failure: unknown): string {
  return cause
    ? abortMessage(cause)
    : describeError(failure ?? new CoordinatorError("runtime ended without terminal event"));
}

/** Human-readable abort reason; structured `{ kind, reason }` values unwrap to their detail. */
function causeText(reason: unknown, fallback: string): string {
  if (reason === undefined || reason === null) return fallback;
  if (reason instanceof Error) return reason.message;
  if (isRecord(reason)) {
    if (reason.reason !== undefined) return causeText(reason.reason, fallback);
    return typeof reason.kind === "string" ? reason.kind : fallback;
  }
  return String(reason);
}

function nextSequence(events: readonly RehorEvent[]): number {
  let maximum = 0;
  for (const event of events) maximum = Math.max(maximum, event.sequence);
  return maximum + 1;
}

function abortMessage(cause: AbortCause): string {
  switch (cause.kind) {
    case CoordinatorAbortKind.TimedOut:
      return causeText(cause.reason, "run timed out");
    case CoordinatorAbortKind.Shutdown:
      return causeText(cause.reason, "shutdown requested");
    case CoordinatorAbortKind.Cancelled:
      return causeText(cause.reason, "run cancelled");
    case CoordinatorAbortKind.Failed:
      return causeText(cause.reason, "run failed");
  }
}

function monotonicClock(): number {
  return performance.now();
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function shouldSurface(error: unknown, cause: AbortCause | undefined): boolean {
  if (error === undefined) return false;
  if (cause?.kind === CoordinatorAbortKind.Failed && cause.reason === "budget_exceeded") {
    return false;
  }
  // Runtime adapters commonly reject with their own abort-shaped error after
  // the coordinator has already classified the external cancellation.
  if (cause && cause.kind !== CoordinatorAbortKind.Failed) return false;
  return true;
}
