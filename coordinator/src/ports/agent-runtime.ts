import type { AbortCause } from "../domain/abort-cause";
import type { RuntimeCapabilities } from "../domain/capabilities";
import type { RehorEvent } from "../domain/event";
import type { RehorRun } from "../domain/run";

/** Synchronous callbacks used only while a runtime is consuming a turn. */
export interface AgentRuntimeRunContext {
  /**
   * Coordinator push channel for policy notices (for example cost budget
   * warnings). Runtimes assign an implementation so the coordinator can
   * deliver agent-facing guidance while a run is in flight.
   */
  onPolicyNotice?(text: string): void;
  /** Reports typed runtime failures that are lifecycle causes, not thrown errors. */
  onAbortCause?(cause: AbortCause): void;
}

/** Stable coordinator boundary. Runtime SDK types must not cross this port. */
export interface AgentRuntime {
  start(signal: AbortSignal): Promise<RuntimeCapabilities>;
  run(
    input: RehorRun,
    signal: AbortSignal,
    context?: AgentRuntimeRunContext,
  ): AsyncIterable<RehorEvent>;
  stop(): Promise<void>;
}
