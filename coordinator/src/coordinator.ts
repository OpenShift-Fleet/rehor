import {
  EventLedger,
  parseRehorRun,
  type RehorEvent,
  type RehorRun,
  type RuntimeCapabilities,
  RuntimeContractError,
  type TerminalEventPayload,
} from "./domain";
import type { AgentRuntime } from "./ports/agent-runtime";
import type { CoordinatorProjection } from "./ports/projection";

export type CoordinatorAbortKind = "cancelled" | "shutdown" | "timed_out" | "failed";

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

interface AbortCause {
  kind: CoordinatorAbortKind;
  reason?: unknown;
}

class CoordinatorAbort extends Error {
  constructor(readonly cause: AbortCause) {
    super(abortMessage(cause));
    this.name = "CoordinatorAbort";
  }
}

class AbortState {
  readonly controller = new AbortController();
  readonly abortPromise: Promise<AbortCause>;

  private causeValue: AbortCause | undefined;
  private readonly listeners: Array<() => void> = [];
  private resolveAbort!: (cause: AbortCause) => void;

  constructor(signal: AbortSignal | undefined, shutdownSignal: AbortSignal | undefined) {
    this.abortPromise = new Promise<AbortCause>((resolve) => {
      this.resolveAbort = resolve;
    });

    this.watch(shutdownSignal, (reason) => ({ kind: "shutdown", reason }));
    this.watch(signal, (reason) => ({ kind: inferAbortKind(reason), reason }));
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cause(): AbortCause | undefined {
    return this.causeValue;
  }

  trigger(cause: AbortCause): void {
    if (this.controller.signal.aborted) return;
    this.causeValue = cause;
    this.controller.abort(cause);
    this.resolveAbort(cause);
  }

  dispose(): void {
    for (const remove of this.listeners) remove();
    this.listeners.length = 0;
  }

  private watch(signal: AbortSignal | undefined, cause: (reason: unknown) => AbortCause): void {
    if (!signal) return;

    const onAbort = (): void => this.trigger(cause(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    this.listeners.push(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
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
  const wallClockNow = options.now ?? Date.now;
  const elapsedNow = options.monotonicNow ?? options.now ?? monotonicClock;
  const startedAt = elapsedNow();
  const abortState = new AbortState(options.signal, options.shutdownSignal);
  const timeout = setTimeout(
    () =>
      abortState.trigger({
        kind: "timed_out",
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
      failure = new CoordinatorAbort(abortState.cause ?? { kind: "cancelled" });
    } else {
      try {
        capabilities = await raceWithAbort(() => runtime.start(abortState.signal), abortState);
      } catch (error) {
        failure = error;
      }

      if (!failure && abortState.signal.aborted) {
        failure = new CoordinatorAbort(abortState.cause ?? { kind: "cancelled" });
      }

      if (!failure) {
        const consumePromise = consumeEvents(
          runtime,
          run,
          abortState,
          ledger,
          options.projection,
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
      failure = new CoordinatorAbort(abortState.cause ?? { kind: "cancelled" });
    }

    if (!ledger.terminalEvent && !failure) {
      const missingTerminalError = new CoordinatorError("runtime ended without terminal event");
      failure = missingTerminalError;
      abortState.trigger({ kind: "failed", reason: missingTerminalError.message });
    }
  } finally {
    acceptingEvents = false;
    if (failure && !abortState.signal.aborted) {
      abortState.trigger({ kind: "failed", reason: describeError(failure) });
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
    const terminal = createTerminalEvent(
      run,
      nextSequence(ledger.events),
      terminalState(abortState.cause, failure),
      terminalReason(abortState.cause, failure),
      Math.max(0, Math.floor(elapsedNow() - startedAt)),
      wallClockNow,
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
  isAccepting: () => boolean,
): Promise<void> {
  const iterator = runtime.run(run, abortState.signal)[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      if (abortState.signal.aborted || !isAccepting()) return;

      const before = ledger.events.length;
      const result = ledger.ingest(next.value);
      if (!result.accepted) continue;

      const event = ledger.events[before];
      if (!event) throw new RuntimeContractError("accepted event was not retained by ledger");
      await projectEvent(event, run, projection);
    }
  } finally {
    await iterator.return?.();
  }
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
  if (cause?.kind === "timed_out") return "timed_out";
  if (cause?.kind === "shutdown") return "interrupted";
  if (cause?.kind === "cancelled") return "cancelled";
  if (failure) return "failed";
  return "failed";
}

function terminalReason(cause: AbortCause | undefined, failure: unknown): string {
  if (cause?.kind === "timed_out") return String(cause.reason ?? "run timed out");
  if (cause?.kind === "shutdown") return String(cause.reason ?? "shutdown requested");
  if (cause?.kind === "cancelled") return String(cause.reason ?? "run cancelled");
  return describeError(failure ?? new CoordinatorError("runtime ended without terminal event"));
}

function nextSequence(events: readonly RehorEvent[]): number {
  let maximum = 0;
  for (const event of events) maximum = Math.max(maximum, event.sequence);
  return maximum + 1;
}

function inferAbortKind(reason: unknown): CoordinatorAbortKind {
  if (reason instanceof Error && reason.name === "TimeoutError") return "timed_out";
  if (reason === "shutdown" || reason === "SIGINT" || reason === "SIGTERM") return "shutdown";
  if (reason === "timeout" || reason === "timed_out") return "timed_out";
  return "cancelled";
}

function abortMessage(cause: AbortCause): string {
  switch (cause.kind) {
    case "timed_out":
      return String(cause.reason ?? "run timed out");
    case "shutdown":
      return String(cause.reason ?? "shutdown requested");
    case "cancelled":
      return String(cause.reason ?? "run cancelled");
    case "failed":
      return String(cause.reason ?? "run failed");
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
  // Runtime adapters commonly reject with their own abort-shaped error after
  // the coordinator has already classified the external cancellation.
  if (cause && cause.kind !== "failed") return false;
  return true;
}
