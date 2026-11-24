import {
  assertTerminalEvent,
  type RehorEvent,
  type RehorTerminalEvent,
  RuntimeContractError,
} from "./event";
import type { RehorRun } from "./run";
import { parseRehorEvent } from "./validation";

export interface EventIngestResult {
  accepted: boolean;
  duplicate: boolean;
  outOfOrder: boolean;
  /** Arrived past the terminal sequence and was dropped rather than recorded. */
  afterTerminal: boolean;
}

export interface MissingSequenceRange {
  start: number;
  end: number;
}

export class EventLedger {
  private readonly received = new Map<string, RehorEvent>();
  private readonly receivedBySequence = new Map<number, RehorEvent>();
  private readonly receivedInOrder: RehorEvent[] = [];
  private highestSequence = 0;
  private acceptedTerminalEvent?: RehorTerminalEvent;

  constructor(private readonly run: RehorRun) {}

  get events(): readonly RehorEvent[] {
    return [...this.receivedInOrder];
  }

  get terminalEvent(): RehorEvent | undefined {
    return this.acceptedTerminalEvent;
  }

  requireTerminal(): RehorTerminalEvent {
    if (!this.acceptedTerminalEvent) throw new RuntimeContractError("terminal event missing");
    assertTerminalEvent(this.acceptedTerminalEvent);
    return this.acceptedTerminalEvent;
  }

  get missingSequenceRanges(): readonly MissingSequenceRange[] {
    const sequences = [...this.receivedBySequence.keys()].sort((left, right) => left - right);
    const ranges: MissingSequenceRange[] = [];
    let expected = 1;

    for (const sequence of sequences) {
      if (sequence > expected) ranges.push({ start: expected, end: sequence - 1 });
      expected = sequence + 1;
    }
    return ranges;
  }

  ingest(value: unknown): EventIngestResult {
    const event = parseRehorEvent(value);
    if (event.runId !== this.run.runId || event.attemptId !== this.run.attemptId) {
      throw new RuntimeContractError("event attribution does not match run attempt");
    }
    if (
      event.workspace.worktreePath !== this.run.worktree.path ||
      event.workspace.repository !== this.run.worktree.repository ||
      event.workspace.snapshot !== this.run.worktree.snapshot.commitSha
    ) {
      throw new RuntimeContractError("event workspace does not match run workspace");
    }
    if (event.provider !== this.run.provider.id) {
      throw new RuntimeContractError("event provider does not match run provider");
    }
    const existing = this.received.get(event.eventId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(event)) {
        throw new RuntimeContractError(`conflicting duplicate event ID: ${event.eventId}`);
      }
      return { accepted: false, duplicate: true, outOfOrder: false, afterTerminal: false };
    }

    // Exactly one terminal event per attempt. Leniency below is for trailing
    // usage records, never for a second terminal: silently keeping either one
    // would let a finished attempt report the wrong state to the projections.
    if (this.acceptedTerminalEvent && event.kind === "terminal") {
      throw new RuntimeContractError(
        `terminal event already accepted: ${this.acceptedTerminalEvent.eventId}`,
      );
    }

    // Events below the terminal sequence were already in flight when the runtime
    // finished; dropping them would lose late usage and cost records. Events past
    // it are a contract violation, but several SDKs trail a final usage record
    // after the result message — dropping one must not fail a finished attempt.
    if (this.acceptedTerminalEvent && event.sequence > this.acceptedTerminalEvent.sequence) {
      return { accepted: false, duplicate: false, outOfOrder: false, afterTerminal: true };
    }

    const existingSequence = this.receivedBySequence.get(event.sequence);
    if (existingSequence) {
      throw new RuntimeContractError(
        `event sequence already accepted: ${event.sequence} (${existingSequence.eventId})`,
      );
    }

    const outOfOrder = this.highestSequence > event.sequence;
    this.received.set(event.eventId, event);
    this.receivedBySequence.set(event.sequence, event);
    this.receivedInOrder.push(event);
    if (event.sequence > this.highestSequence) this.highestSequence = event.sequence;
    if (event.kind === "terminal") {
      assertTerminalEvent(event);
      this.acceptedTerminalEvent = event;
    }

    return { accepted: true, duplicate: false, outOfOrder, afterTerminal: false };
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    // Codepoint order, not locale collation: `localeCompare` ignores characters
    // such as soft hyphens and would canonicalize equal payloads differently.
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}
