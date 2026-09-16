import type { RuntimeCapabilities } from "../domain/capabilities";
import type { RehorEvent } from "../domain/event";
import type { RehorRun } from "../domain/run";

/** Stable coordinator boundary. Runtime SDK types must not cross this port. */
export interface AgentRuntime {
  start(signal: AbortSignal): Promise<RuntimeCapabilities>;
  run(input: RehorRun, signal: AbortSignal): AsyncIterable<RehorEvent>;
  stop(): Promise<void>;
}
