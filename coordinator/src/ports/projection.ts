import type { RehorEvent } from "../domain/event";
import type { RehorRun } from "../domain/run";

export type ProjectionResult = void | PromiseLike<void>;

/**
 * Receives normalized events after the coordinator accepts them.
 *
 * Persistence, status, transcript, and cost integrations implement this
 * boundary instead of depending on a provider SDK or runtime adapter.
 */
export interface CoordinatorProjection {
  onEvent?(event: RehorEvent, run: RehorRun): ProjectionResult;
  onTerminal?(event: RehorEvent & { kind: "terminal" }, run: RehorRun): ProjectionResult;
}
