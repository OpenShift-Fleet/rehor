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
  type ValidatedRehorRun,
  WorkContextTracker,
} from "./domain";
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

class CoordinatorAbort extends Error {
  constructor(readonly cause: AbortCause) {
    super(abortMessage(cause));
    this.name = "CoordinatorAbort";
  }
}

interface TurnPolicyEvent extends Record<string, unknown> {
  state: "warning" | "critical";
  label: string;
  usedTurns: number;
  maxTurns: number;
  message: string;
}

class TurnBudgetPolicy {
  private readonly countedToolCalls = new Set<string>();
  private usedTurns = 0;
  private warned = false;
  private critical = false;
  limitReached = false;

  constructor(private readonly run: RehorRun) {}

  complete(toolUseId: string): TurnPolicyEvent | undefined {
    if (this.limitReached || this.countedToolCalls.has(toolUseId)) return undefined;
    this.countedToolCalls.add(toolUseId);
    this.usedTurns += 1;

    const maxTurns = this.run.limits.maxTurns;
    const warningAt = Math.floor(maxTurns * 0.75);
    const criticalAt = Math.floor(maxTurns * 0.9);
    const remaining = Math.max(0, maxTurns - this.usedTurns);
    const at = (state: TurnPolicyEvent["state"], message: string): TurnPolicyEvent => ({
      state,
      label: this.run.label,
      usedTurns: this.usedTurns,
      maxTurns,
      message,
    });
    let event: TurnPolicyEvent | undefined;
    if (this.usedTurns >= criticalAt && !this.critical) {
      this.critical = true;
      event = at(
        "critical",
        `TURN BUDGET CRITICAL: ~${this.usedTurns}/${maxTurns} tool calls used, ` +
          `~${remaining} remaining. You MUST save progress NOW via ` +
          "task_update with current summary, last_step, files_changed, and next_step. " +
          "Then wrap up or stop.",
      );
    } else if (this.usedTurns >= warningAt && !this.warned) {
      this.warned = true;
      event = at(
        "warning",
        `TURN BUDGET WARNING: ~${this.usedTurns}/${maxTurns} tool calls used, ` +
          `~${remaining} remaining. Save progress via task_update soon ` +
          "(summary + metadata with last_step, files_changed, next_step). " +
          "Prioritize completing current step and saving state.",
      );
    }

    this.limitReached = this.usedTurns >= maxTurns;
    return event;
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
          workContext,
          capabilities,
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
  const surfacedError = cleanupError ?? (shouldSurface(failure, cause) ? failure : undefined);

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
  workContext: WorkContextTracker,
  capabilities: RuntimeCapabilities,
  isAccepting: () => boolean,
): Promise<void> {
  const turnBudget = new TurnBudgetPolicy(run);
  const pendingPolicyUpdates = new Map<string, TurnPolicyEvent>();
  const toolStarts = new Map<string, RehorEvent>();
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

  const emitPolicy = async (policy: TurnPolicyEvent, parent?: RehorEvent): Promise<void> => {
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

  const flushPendingPolicyUpdates = async (): Promise<void> => {
    for (const [toolUseId, policy] of pendingPolicyUpdates) {
      await emitPolicy(policy, toolStarts.get(toolUseId));
      pendingPolicyUpdates.delete(toolUseId);
    }
  };

  const context: AgentRuntimeRunContext = {
    onAbortCause(cause) {
      abortState.abort(cause);
    },
    onSuccessfulToolCall(toolUseId, notices) {
      const policy = turnBudget.complete(toolUseId);
      if (!policy) return;
      pendingPolicyUpdates.set(toolUseId, policy);
      notices.deliverNotice(policy.message);
    },
  };
  const iterator = runtime.run(run, abortState.signal, context)[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        await flushPendingPolicyUpdates();
        return;
      }
      // Runtime adapters may emit a final partial usage snapshot and terminal
      // event while draining an SDK query after cancellation or timeout.
      // Keep accepting that bounded drain; stop accepting only once the
      // coordinator cleanup has completed.
      if (!isAccepting()) return;
      if (next.value.kind === "terminal") await flushPendingPolicyUpdates();

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
      await projectEvent(event, run, projection);

      if (event.kind === "tool" && event.payload.budgetUnit !== "container") {
        const toolUseId =
          typeof event.payload.toolUseId === "string" ? event.payload.toolUseId : event.eventId;
        if (event.payload.state === "started") toolStarts.set(toolUseId, event);
        if (event.payload.state === "completed") {
          const policy =
            pendingPolicyUpdates.get(toolUseId) ??
            (event.payload.isError === true ? undefined : turnBudget.complete(toolUseId));
          pendingPolicyUpdates.delete(toolUseId);
          if (policy) await emitPolicy(policy, event);
        }
      }

      if (
        !capabilities.enforcesTurnLimit &&
        event.kind === "run" &&
        event.payload.state === "turn_started" &&
        turnBudget.limitReached
      ) {
        abortState.abort({ kind: CoordinatorAbortKind.Failed, reason: "max_turns" });
      }
    }
  } finally {
    await iterator.return?.();
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
  if (cause?.kind === CoordinatorAbortKind.Failed && cause.reason === "max_turns") return false;
  // Runtime adapters commonly reject with their own abort-shaped error after
  // the coordinator has already classified the external cancellation.
  if (cause && cause.kind !== CoordinatorAbortKind.Failed) return false;
  return true;
}
