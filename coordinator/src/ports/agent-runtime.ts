import type { AbortCause } from "../domain/abort-cause";
import type { RuntimeCapabilities } from "../domain/capabilities";
import type { RehorEvent } from "../domain/event";
import type { RehorRun } from "../domain/run";

export interface RuntimeNoticePort {
  deliverNotice(text: string): void;
}

/** Synchronous callbacks used only while a runtime is consuming a turn. */
export interface AgentRuntimeRunContext {
  /** Called by a successful-tool hook before the next model turn begins. */
  onSuccessfulToolCall?(toolUseId: string, notices: RuntimeNoticePort): void;
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
