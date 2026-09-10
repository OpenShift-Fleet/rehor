import type { RehorEvent, RehorRun, RuntimeCapabilities } from "../domain";
import { RuntimeContractError } from "../domain";
import type { AgentRuntime } from "../ports";

export interface FakeRuntimeOptions {
  events?: RehorEvent[];
  error?: Error;
  delayMs?: number;
}

const CAPABILITIES: RuntimeCapabilities = {
  runtimeId: "fake",
  runtimeVersion: "test",
  configVersion: "test",
  streaming: true,
  interruption: true,
  childSessions: false,
  toolSupport: true,
  mcpSupport: true,
  structuredOutput: true,
  usageGuarantee: "partial-and-final",
};

/** Deterministic runtime used to exercise coordinator and adapter contracts. */
export class FakeAgentRuntime implements AgentRuntime {
  private readonly options: FakeRuntimeOptions;
  private started = false;
  private stopped = false;
  private _stopCalls = 0;
  private _emittedEventCount = 0;
  private _abortReason: unknown;

  constructor(options: FakeRuntimeOptions = {}) {
    this.options = options;
  }

  get stopCalls(): number {
    return this._stopCalls;
  }

  get emittedEventCount(): number {
    return this._emittedEventCount;
  }

  get abortReason(): unknown {
    return this._abortReason;
  }

  async start(signal: AbortSignal): Promise<RuntimeCapabilities> {
    if (this.stopped) throw new RuntimeContractError("stopped runtime must not be restarted");
    if (signal.aborted) throw this.aborted(signal);
    this.started = true;
    return CAPABILITIES;
  }

  run(input: RehorRun, signal: AbortSignal): AsyncIterable<RehorEvent> {
    const runtime = this;
    return (async function* stream(): AsyncGenerator<RehorEvent> {
      if (!runtime.started) throw new RuntimeContractError("runtime must be started before run");
      if (runtime.stopped) throw new RuntimeContractError("stopped runtime must not stream events");
      if (signal.aborted) throw runtime.aborted(signal);

      for (const event of runtime.options.events ?? []) {
        await runtime.delay(signal);
        // stop() ends the stream: adapters must not keep emitting after shutdown.
        if (runtime.stopped) return;
        runtime._emittedEventCount += 1;
        yield {
          ...event,
          runId: input.runId,
          attemptId: input.attemptId,
        };
      }

      if (runtime.options.error) throw runtime.options.error;
      if (signal.aborted) throw runtime.aborted(signal);
    })();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this._stopCalls += 1;
  }

  private delay(signal: AbortSignal): Promise<void> {
    const delayMs = this.options.delayMs ?? 0;
    if (signal.aborted) return Promise.reject(this.aborted(signal));
    if (delayMs === 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(this.aborted(signal));
      };

      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private aborted(signal: AbortSignal): Error {
    this._abortReason = signal.reason;
    return new Error("runtime aborted");
  }
}
