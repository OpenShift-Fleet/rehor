import {
  createEventFactory,
  EventLedger,
  parseRehorRun,
  type RehorEvent,
  type RehorRun,
  type RuntimeCapabilities,
  RuntimeContractError,
  type TerminalEventPayload,
  WorkContextTracker,
} from "./domain";
import { type AbortCause, abortCauseFrom } from "./domain/abort-cause";
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

class AbortState {
  readonly abortPromise: Promise<AbortCause>;

  private readonly combined: CombinedAbortSignals;
  private removeAbortListener: () => void = () => undefined;

  constructor(signal: AbortSignal | undefined, shutdownSignal: AbortSignal | undefined) {
    this.combined = combineAbortSignals({ signal, shutdownSignal });
    this.abortPromise = new Promise<AbortCause>((resolve) => {
      const onAbort = (): void => {
        resolve(this.cause ?? abortCauseFrom(this.signal.reason, "cancelled"));
      };
      if (this.signal.aborted) onAbort();
      else {
        this.signal.addEventListener("abort", onAbort, { once: true });
        this.removeAbortListener = () => this.signal.removeEventListener("abort", onAbort);
      }
    });
  }

  get signal(): AbortSignal {
    return this.combined.signal;
  }

  get cause(): AbortCause | undefined {
    return this.combined.cause;
  }

  trigger(cause: AbortCause): void {
    this.combined.abort(cause);
  }

  dispose(): void {
    this.removeAbortListener();
    this.combined.dispose();
  }
}

interface TurnPolicyEvent extends Record<string, unknown> {
  state: "warning" | "critical";
  label: string;
  usedTurns: number;
  maxTurns: number;
  message: string;
}

interface TurnPolicyUpdate {
  events: TurnPolicyEvent[];
  exhausted: boolean;
}

class TurnBudgetPolicy {
  private readonly countedToolCalls = new Set<string>();
  private usedTurns = 0;
  private warned = false;
  private critical = false;
  private exhausted = false;

  constructor(private readonly run: RehorRun) {}

  observe(event: RehorEvent): TurnPolicyUpdate | undefined {
    if (event.kind !== "tool") return undefined;
    if (event.payload.state !== "completed" || event.payload.isError === true) return undefined;

    const id =
      typeof event.payload.toolUseId === "string" ? event.payload.toolUseId : event.eventId;
    return this.complete(id);
  }

  complete(toolUseId: string): TurnPolicyUpdate | undefined {
    if (this.exhausted || this.countedToolCalls.has(toolUseId)) return undefined;
    this.countedToolCalls.add(toolUseId);
    this.usedTurns += 1;

    const maxTurns = this.run.limits.maxTurns;
    const warningAt = Math.floor(maxTurns * 0.75);
    const criticalAt = Math.floor(maxTurns * 0.9);
    const remaining = Math.max(0, maxTurns - this.usedTurns);
    const events: TurnPolicyEvent[] = [];
    if (this.usedTurns >= criticalAt && !this.critical) {
      this.critical = true;
      events.push({
        state: "critical",
        label: this.run.label,
        usedTurns: this.usedTurns,
        maxTurns,
        message:
          `TURN BUDGET CRITICAL: ~${this.usedTurns}/${maxTurns} tool calls used, ` +
          `~${remaining} remaining. You MUST save progress NOW via ` +
          "task_update with current summary, last_step, files_changed, and next_step. " +
          "Then wrap up or stop.",
      });
    } else if (this.usedTurns >= warningAt && !this.warned) {
      this.warned = true;
      events.push({
        state: "warning",
        label: this.run.label,
        usedTurns: this.usedTurns,
        maxTurns,
        message:
          `TURN BUDGET WARNING: ~${this.usedTurns}/${maxTurns} tool calls used, ` +
          `~${remaining} remaining. Save progress via task_update soon ` +
          "(summary + metadata with last_step, files_changed, next_step). " +
          "Prioritize completing current step and saving state.",
      });
    }

    this.exhausted = this.usedTurns >= maxTurns;
    return { events, exhausted: this.exhausted };
  }

  get limitReached(): boolean {
    return this.exhausted;
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
  const run = parseRehorRun(input);
  const ledger = new EventLedger(run);
  const workContext = new WorkContextTracker(run);
  const wallClockNow = options.now ?? Date.now;
  const elapsedNow = options.monotonicNow ?? options.now ?? monotonicClock;
  const startedAt = elapsedNow();
  const abortState = new AbortState(options.signal, options.shutdownSignal);
  const timeout = setTimeout(
    () =>
      abortState.trigger({
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
      failure = new CoordinatorAbort(
        abortState.cause ?? { kind: CoordinatorAbortKind.Cancelled, reason: undefined },
      );
    } else {
      try {
        capabilities = await raceWithAbort(() => runtime.start(abortState.signal), abortState);
      } catch (error) {
        failure = error;
      }

      if (!failure && abortState.signal.aborted) {
        failure = new CoordinatorAbort(
          abortState.cause ?? { kind: CoordinatorAbortKind.Cancelled, reason: undefined },
        );
      }

      if (!failure && capabilities) {
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

    if (!failure && abortState.signal.aborted) {
      failure = new CoordinatorAbort(
        abortState.cause ?? { kind: CoordinatorAbortKind.Cancelled, reason: undefined },
      );
    }

    if (!ledger.terminalEvent && !failure) {
      const missingTerminalError = new CoordinatorError("runtime ended without terminal event");
      failure = missingTerminalError;
      abortState.trigger({
        kind: CoordinatorAbortKind.Failed,
        reason: missingTerminalError.message,
      });
    }
  } finally {
    acceptingEvents = false;
    if (failure && !abortState.signal.aborted) {
      abortState.trigger({
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
        terminalState(abortState.cause, failure),
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
  abortState: AbortState,
  ledger: EventLedger,
  projection: CoordinatorProjection | undefined,
  workContext: WorkContextTracker,
  capabilities: RuntimeCapabilities,
  isAccepting: () => boolean,
): Promise<void> {
  const turnBudget = new TurnBudgetPolicy(run);
  const pendingPolicyUpdates = new Map<string, TurnPolicyUpdate>();
  const toolStarts = new Map<string, RehorEvent>();
  const acceptedSequences = new Set(ledger.events.map(({ sequence }) => sequence));
  let coordinatorEventOffset = 0;

  const emitPolicyUpdate = async (
    toolUseId: string,
    update: TurnPolicyUpdate,
    sourceEvent?: RehorEvent,
  ): Promise<void> => {
    if (update.events.length === 0) return;
    const parent = sourceEvent ?? toolStarts.get(toolUseId);
    const createEvent = createEventFactory(run, run.policyHash.value, {
      startSequence: nextSequence(ledger.events) - 1,
    });
    for (const payload of update.events) {
      const policyEvent = createEvent("policy", payload, {
        ...(parent?.runtimeSessionRef ? { runtimeSessionRef: parent.runtimeSessionRef } : {}),
        ...(parent ? { parentEventId: parent.eventId } : {}),
      });
      const policyBefore = ledger.events.length;
      const policyResult = ledger.ingest(policyEvent);
      if (!policyResult.accepted) continue;
      coordinatorEventOffset += 1;
      const acceptedPolicyEvent = ledger.events[policyBefore];
      if (!acceptedPolicyEvent) {
        throw new RuntimeContractError("accepted policy event was not retained by ledger");
      }
      acceptedSequences.add(acceptedPolicyEvent.sequence);
      await projectEvent(acceptedPolicyEvent, run, projection);
    }
  };

  const flushPendingPolicyUpdates = async (): Promise<void> => {
    for (const [toolUseId, update] of pendingPolicyUpdates) {
      await emitPolicyUpdate(toolUseId, update);
      pendingPolicyUpdates.delete(toolUseId);
    }
  };

  const context: AgentRuntimeRunContext = {
    onAbortCause(cause) {
      abortState.trigger(cause);
    },
    onSuccessfulToolCall(toolUseId, notices) {
      const update = turnBudget.complete(toolUseId);
      if (!update) return;
      if (update.events.length > 0) pendingPolicyUpdates.set(toolUseId, update);
      const notice = update.events[0]?.message;
      if (notice) notices.deliverNotice(notice);
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

      const before = ledger.events.length;
      const normalizedEvent = workContext.enrichTerminal(
        mapRuntimeTerminal(next.value, abortState.cause),
      );
      const sequencedEvent = sequenceAfterCoordinatorEvents(
        normalizedEvent,
        coordinatorEventOffset,
        acceptedSequences,
      );
      const result = ledger.ingest(sequencedEvent);
      if (!result.accepted) continue;

      const event = ledger.events[before];
      if (!event) throw new RuntimeContractError("accepted event was not retained by ledger");
      acceptedSequences.add(event.sequence);
      workContext.observe(event);
      await projectEvent(event, run, projection);

      if (event.kind === "tool") {
        const toolUseId =
          typeof event.payload.toolUseId === "string" ? event.payload.toolUseId : event.eventId;
        if (event.payload.state === "started") toolStarts.set(toolUseId, event);
        if (event.payload.state === "completed") {
          const callbackUpdate = pendingPolicyUpdates.get(toolUseId);
          const turnUpdate = callbackUpdate ?? turnBudget.observe(event);
          if (callbackUpdate) pendingPolicyUpdates.delete(toolUseId);
          if (turnUpdate) await emitPolicyUpdate(toolUseId, turnUpdate, event);
        }
      }

      if (
        !capabilities.enforcesTurnLimit &&
        event.kind === "run" &&
        event.payload.state === "turn_started" &&
        turnBudget.limitReached
      ) {
        abortState.trigger({ kind: CoordinatorAbortKind.Failed, reason: "max_turns" });
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
  const state = terminalState(cause, undefined);
  const reason = terminalReason(cause, undefined);
  return {
    ...event,
    payload: {
      ...payload,
      state,
      ...(reason === undefined ? {} : { reason }),
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
  abortState: AbortState,
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
    abortState.abortPromise.then((cause) => ({ kind: "abort" as const, cause })),
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

function terminalState(
  cause: AbortCause | undefined,
  failure: unknown,
): TerminalEventPayload["state"] {
  if (cause?.kind === CoordinatorAbortKind.TimedOut) return "timed_out";
  if (cause?.kind === CoordinatorAbortKind.Shutdown) return "interrupted";
  if (cause?.kind === CoordinatorAbortKind.Cancelled) return "cancelled";
  if (cause?.kind === CoordinatorAbortKind.Failed) return "failed";
  if (failure) return "failed";
  return "failed";
}

function terminalReason(cause: AbortCause | undefined, failure: unknown): string {
  if (cause?.kind === CoordinatorAbortKind.TimedOut)
    return causeText(cause.reason, "run timed out");
  if (cause?.kind === CoordinatorAbortKind.Shutdown)
    return causeText(cause.reason, "shutdown requested");
  if (cause?.kind === CoordinatorAbortKind.Cancelled)
    return causeText(cause.reason, "run cancelled");
  if (cause?.kind === CoordinatorAbortKind.Failed) return causeText(cause.reason, "run failed");
  return describeError(failure ?? new CoordinatorError("runtime ended without terminal event"));
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
