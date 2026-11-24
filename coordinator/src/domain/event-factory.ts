import {
  type RawEventReference,
  type RehorEvent,
  type RehorEventKind,
  RuntimeContractError,
} from "./event";
import type { RehorRun } from "./run";

export interface EventFactoryOverrides {
  eventId?: string;
  occurredAt?: string;
  model?: string;
  runtimeSessionRef?: string;
  parentEventId?: string;
  rawEventRef?: RawEventReference;
}

export interface EventFactoryOptions {
  /**
   * Highest sequence already emitted for this attempt. The next event uses
   * `startSequence + 1`, so a resumed attempt or a second factory does not
   * replay sequence numbers the ledger has already accepted.
   */
  startSequence?: number;
}

/** Stamps run-owned envelope fields so adapters only provide event-specific data. */
export function createEventFactory(
  run: RehorRun,
  policyVersion: string,
  options: EventFactoryOptions = {},
) {
  const startSequence = options.startSequence ?? 0;
  if (!Number.isSafeInteger(startSequence) || startSequence < 0) {
    throw new RuntimeContractError("startSequence must be a non-negative safe integer");
  }
  let sequence = startSequence;

  return function createEvent(
    kind: RehorEventKind,
    payload: RehorEvent["payload"],
    overrides: EventFactoryOverrides = {},
  ): RehorEvent {
    return {
      schemaVersion: "1",
      eventId: overrides.eventId ?? globalThis.crypto.randomUUID(),
      runId: run.runId,
      attemptId: run.attemptId,
      sequence: ++sequence,
      occurredAt: overrides.occurredAt ?? new Date().toISOString(),
      kind,
      workspace: {
        worktreePath: run.worktree.path,
        repository: run.worktree.repository,
        snapshot: run.worktree.snapshot.commitSha,
      },
      provider: run.provider.id,
      model: overrides.model ?? run.provider.requestedModel,
      policyVersion,
      payload,
      ...(overrides.runtimeSessionRef === undefined
        ? {}
        : { runtimeSessionRef: overrides.runtimeSessionRef }),
      ...(overrides.parentEventId === undefined ? {} : { parentEventId: overrides.parentEventId }),
      ...(overrides.rawEventRef === undefined ? {} : { rawEventRef: overrides.rawEventRef }),
    };
  };
}
