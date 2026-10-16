import {
  createOpencodeClient,
  type Event as OpenCodeEvent,
  type OpencodeClient,
} from "@opencode-ai/sdk";
import { providerDiagnostic, runtimeErrorDetails } from "../../diagnostics";
import {
  createEventFactory,
  type RehorEvent,
  type RehorRun,
  type RuntimeTerminalState,
} from "../../domain";
import type { RuntimeCapabilities } from "../../domain/capabilities";
import { type Logger, nullLogger } from "../../log";
import type { AgentRuntime, AgentRuntimeRunContext } from "../../ports";
import {
  abortReason,
  assertPositiveInteger,
  boundedOperation,
  buildTerminalPayload,
  errorMessage,
  record,
  redactSensitiveText,
  stringValue,
} from "../shared";
import {
  buildOpenCodeEnvironment,
  createOpenCodeFetch,
  type OpenCodeEnvironmentOptions,
  type ProxyEnvironment,
} from "./environment";
import {
  beginsNewTurn,
  createNormalizationContext,
  isSessionEvent,
  type NormalizationContext,
  normalizeOpenCodeEvent,
  unwrapSdkResponse,
} from "./normalizer";
import {
  OPENCODE_VERSION,
  OpenCodeProcessLeakError,
  type OpenCodeServerController,
  type OpenCodeServerInfo,
  OpenCodeServerSupervisor,
  type OpenCodeSupervisorOptions,
} from "./process-supervisor";
import { reconcileSession } from "./reconcile";
import type { EffectiveOpenCodeModel, RenderedOpenCodeV1Config } from "./types";

export type OpenCodeV1ServerOptions = Omit<OpenCodeSupervisorOptions, "renderedConfig">;
export type OpenCodeSupervisorFactory = (
  renderedConfig: RenderedOpenCodeV1Config | undefined,
) => OpenCodeServerController;

export interface OpenCodeV1RuntimeOptions extends OpenCodeEnvironmentOptions {
  logger?: Logger;
  policyVersion?: string;
  reconciliationTimeoutMs?: number;
  reconciliationMessageLimit?: number;
  requestTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  /** Immutable configuration rendered by the runtime factory for this run. */
  renderedConfig?: RenderedOpenCodeV1Config;
  /** Configuration failures are emitted through the normal runtime lifecycle. */
  renderError?: unknown;
  server?: OpenCodeV1ServerOptions;
  /** Build an injected supervisor with this run's immutable rendered snapshot. */
  supervisor?: OpenCodeSupervisorFactory;
  clientFactory?: OpenCodeClientFactory;
}

export type OpenCodeClientFactory = (
  server: OpenCodeServerInfo,
  directory: string,
  environment: Readonly<Record<string, string>>,
) => OpencodeClient;

interface ActiveRun {
  controller: AbortController;
  client?: OpencodeClient;
  sessionId?: string;
  directory?: string;
  stream?: AsyncGenerator<OpenCodeEvent>;
}

interface RuntimeOutcome {
  state: RuntimeTerminalState;
  reason?: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const CAPABILITIES: RuntimeCapabilities = {
  runtimeId: "opencode-v1",
  runtimeVersion: OPENCODE_VERSION,
  configVersion: "1",
  streaming: true,
  interruption: true,
  enforcesTurnLimit: false,
  childSessions: true,
  toolSupport: true,
  mcpSupport: true,
  structuredOutput: false,
  usageGuarantee: "partial-and-final",
};

/**
 * OpenCode V1 adapter. OpenCode SDK values are consumed here and never cross
 * the AgentRuntime port; callers receive only Rehor-owned events.
 */
export class OpenCodeV1Runtime implements AgentRuntime {
  private readonly logger: Logger;
  private readonly policyVersion: string;
  private readonly supervisor: OpenCodeServerController;
  private readonly clientEnvironment: Record<string, string>;
  private readonly renderedConfig?: RenderedOpenCodeV1Config;
  private readonly renderError?: unknown;
  private readonly reconciliationTimeoutMs: number;
  private readonly reconciliationMessageLimit: number;
  private readonly requestTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly clientFactory: OpenCodeClientFactory;
  private started = false;
  private stopped = false;
  private hasRun = false;
  private active?: ActiveRun;

  constructor(options: OpenCodeV1RuntimeOptions = {}) {
    this.logger = options.logger ?? nullLogger;
    this.policyVersion = options.policyVersion ?? "opencode-v1";
    this.renderedConfig = options.renderedConfig;
    this.renderError = options.renderError;
    this.clientEnvironment = buildOpenCodeEnvironment(options);
    this.reconciliationTimeoutMs = options.reconciliationTimeoutMs ?? 1_000;
    this.reconciliationMessageLimit = options.reconciliationMessageLimit ?? 100;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? this.reconciliationTimeoutMs;
    assertPositiveInteger(this.reconciliationTimeoutMs, "reconciliationTimeoutMs", "OpenCode");
    assertPositiveInteger(
      this.reconciliationMessageLimit,
      "reconciliationMessageLimit",
      "OpenCode",
    );
    assertPositiveInteger(this.requestTimeoutMs, "requestTimeoutMs", "OpenCode");
    assertPositiveInteger(this.cleanupTimeoutMs, "cleanupTimeoutMs", "OpenCode");
    this.supervisor =
      options.supervisor?.(options.renderedConfig) ??
      new OpenCodeServerSupervisor({
        logger: this.logger,
        ...(options.server ?? {}),
        ...(options.base === undefined ? {} : { base: options.base }),
        ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
        ...(options.passthrough === undefined ? {} : { passthrough: options.passthrough }),
        ...(options.noProxyHosts === undefined ? {} : { noProxyHosts: options.noProxyHosts }),
        ...(options.renderedConfig === undefined ? {} : { renderedConfig: options.renderedConfig }),
      });
    if (options.clientFactory) {
      this.clientFactory = options.clientFactory;
    } else {
      const clientFetch = createOpenCodeFetch();
      this.clientFactory = (server, directory) =>
        createOpencodeClient({
          baseUrl: server.baseUrl,
          directory,
          // Do not mutate process.env. Client requests stay on the OpenCode
          // loopback server; the child receives explicit proxy settings.
          fetch: clientFetch,
        });
    }
  }

  get serverInfo(): OpenCodeServerInfo | undefined {
    return this.supervisor.info;
  }

  get environment(): Readonly<Record<string, string>> {
    return this.clientEnvironment;
  }

  get renderedConfiguration(): RenderedOpenCodeV1Config | undefined {
    return this.renderedConfig;
  }

  async start(signal: AbortSignal): Promise<RuntimeCapabilities> {
    if (this.stopped) throw new Error("stopped runtime must not be restarted");
    if (signal.aborted) throw abortReason(signal);
    this.started = true;
    return CAPABILITIES;
  }

  async *run(
    input: RehorRun,
    signal: AbortSignal,
    context?: AgentRuntimeRunContext,
  ): AsyncIterable<RehorEvent> {
    if (!this.started) throw new Error("runtime must be started before run");
    if (this.stopped) throw new Error("stopped runtime must not stream events");
    if (this.hasRun) throw new Error("OpenCode V1 runtime supports one run per instance");
    this.hasRun = true;

    const renderedConfig = this.renderedConfig;
    const effectiveModel = renderedConfig?.effectiveModel;
    const renderError = this.renderError;
    const factory = createEventFactory(
      renderedConfig === undefined || effectiveModel === undefined
        ? input
        : withEffectiveModel(input, effectiveModel),
      this.policyVersion,
    );
    const active: ActiveRun = { controller: new AbortController() };
    const detachAbort = linkAbort(signal, active.controller);
    let detachCrash = (): void => undefined;
    this.active = active;
    const startedAt = Date.now();
    let outcome: RuntimeOutcome | undefined;
    let failure: unknown;
    let cleanupFailure: Error | undefined;
    let resultText = "";
    let turns = 0;
    let promptAttempted = false;
    let normalization!: NormalizationContext;
    let stream: AsyncGenerator<OpenCodeEvent> | undefined;
    try {
      // Emit before any setup can fail so every attempt, including one that
      // never reaches a session, has a started record.
      yield factory("run", { state: "started" });
      if (renderedConfig === undefined || effectiveModel === undefined) {
        throw renderError ?? new Error("OpenCode configuration could not be rendered");
      }
      const server = await this.supervisor.start(input.worktree.path, active.controller.signal);
      detachCrash = linkAbort(this.supervisor.crashSignal, active.controller, () =>
        context?.onAbortCause?.(OPENCODE_CRASH),
      );
      const directory = server.directory;
      const client = this.clientFactory(server, directory, this.clientEnvironment);
      active.client = client;
      active.directory = directory;

      const subscription = await boundedOperation(
        (requestSignal) =>
          client.event.subscribe({
            query: { directory },
            signal: requestSignal,
            sseMaxRetryAttempts: 0,
          }),
        active.controller.signal,
        Date.now() + this.requestTimeoutMs,
        "OpenCode event subscription",
      );
      stream = subscription.stream;
      active.stream = stream;
      const iterator = stream[Symbol.asyncIterator]();
      const connected = await boundedOperation(
        () => iterator.next(),
        active.controller.signal,
        Date.now() + this.requestTimeoutMs,
        "OpenCode event connection",
      );
      if (connected.done || connected.value.type !== "server.connected") {
        throw new Error("OpenCode event stream did not begin with server.connected");
      }

      const sessionResponse = await boundedOperation(
        (requestSignal) =>
          client.session.create({
            query: { directory },
            body: { title: `Rehor ${input.runId}` },
            signal: requestSignal,
            responseStyle: "data",
            throwOnError: true,
          }),
        active.controller.signal,
        Date.now() + this.requestTimeoutMs,
        "OpenCode session creation",
      );
      const session = record(unwrapSdkResponse(sessionResponse, "OpenCode session creation"));
      const sessionId = stringValue(session.id, "");
      if (!sessionId) throw new Error("OpenCode session creation returned no session");
      active.sessionId = sessionId;
      normalization = createNormalizationContext(sessionId, effectiveModel.value);

      promptAttempted = true;
      unwrapSdkResponse(
        await boundedOperation(
          (requestSignal) =>
            client.session.promptAsync({
              path: { id: sessionId },
              query: { directory },
              body: {
                model: {
                  providerID: effectiveModel.providerID,
                  modelID: effectiveModel.modelID,
                },
                parts: [{ type: "text", text: input.prompt }],
              },
              signal: requestSignal,
              responseStyle: "data",
              throwOnError: true,
            }),
          active.controller.signal,
          Date.now() + this.requestTimeoutMs,
          "OpenCode session prompt",
        ),
        "OpenCode session prompt",
      );

      for (;;) {
        const next = await boundedOperation(
          () => iterator.next(),
          active.controller.signal,
          undefined,
          "OpenCode event stream",
        );
        if (next.done) break;
        if (!isSessionEvent(next.value, normalization)) continue;
        if (beginsNewTurn(next.value, normalization)) {
          yield factory(
            "run",
            { state: "turn_started" },
            { runtimeSessionRef: normalization.rootSessionId },
          );
          if (signal.aborted) throw abortReason(signal);
        }

        const normalized = normalizeOpenCodeEvent(next.value, factory, normalization);
        if (
          next.value.type === "session.error" ||
          (next.value.type === "message.updated" && record(next.value.properties.info).error)
        ) {
          const error =
            next.value.type === "session.error"
              ? next.value.properties.error
              : record(next.value.properties.info).error;
          this.logger.log("ERROR", "OpenCode session error", {
            run_id: input.runId,
            attempt_id: input.attemptId,
            diagnostic: providerDiagnostic(error),
            server_diagnostics: this.supervisor.diagnostics,
          });
        }
        if (normalized.turns > 0) turns += normalized.turns;
        for (const event of normalized.events) yield event;
        if (normalized.resultText !== undefined) resultText = normalized.resultText;
        if (normalized.outcome) {
          outcome = {
            state: normalized.outcome,
            reason: normalized.reason,
          };
          break;
        }
      }

      if (!outcome) {
        if (this.supervisor.crashError) throw this.supervisor.crashError;
        if (active.controller.signal.aborted) throw abortReason(active.controller.signal);
        throw new Error("OpenCode event stream ended before the session became idle");
      }
    } catch (error) {
      this.logger.log("ERROR", "OpenCode operation failed", {
        run_id: input.runId,
        attempt_id: input.attemptId,
        diagnostic: providerDiagnostic(error),
        server_diagnostics: this.supervisor.diagnostics,
        exc_info: runtimeErrorDetails(error),
      });
      failure = error;
      if (
        promptAttempted &&
        !signal.aborted &&
        !this.supervisor.crashError &&
        !active.controller.signal.aborted
      ) {
        const reconciled = await reconcileSession(
          active,
          factory,
          normalization,
          this.reconciliationTimeoutMs,
          this.reconciliationMessageLimit,
        );
        for (const event of reconciled.events) yield event;
        if (reconciled.turns > 0) turns += reconciled.turns;
        if (reconciled.resultText !== undefined) resultText = reconciled.resultText;
        if (reconciled.outcome) {
          outcome = { state: reconciled.outcome, reason: reconciled.reason };
          failure = undefined;
        } else context?.onAbortCause?.(OPENCODE_CRASH);
      }
    } finally {
      detachAbort();
      detachCrash();
      cleanupFailure = await this.cleanup(active);
      if (!failure && cleanupFailure) failure = cleanupFailure;
      if (this.active === active) this.active = undefined;
    }

    if (!outcome) {
      outcome = {
        state: "failed",
        reason: errorMessage(failure) ?? "OpenCode runtime failed",
      };
    }
    if (outcome.state !== "completed") {
      yield factory(
        "persistence",
        {
          action: "partial-state",
          state: "not_resumable",
          reason:
            (this.supervisor.crashError?.message
              ? redactSensitiveText(this.supervisor.crashError.message)
              : undefined) ??
            errorMessage(failure) ??
            outcome.reason ??
            "OpenCode runtime ended without a completed result",
        },
        { runtimeSessionRef: active.sessionId },
      );
    }

    if (outcome.state === "completed") {
      // The session's work finished; a cleanup failure does not undo it. Report
      // it as a diagnostic so the event stream never pairs an `error` event
      // with a completed terminal.
      if (cleanupFailure) {
        yield factory(
          "cleanup",
          {
            state: "failed",
            message: errorMessage(cleanupFailure) ?? "OpenCode cleanup failed",
            ...(isResourceLeak(cleanupFailure) ? { resourceLeak: true } : {}),
          },
          { runtimeSessionRef: active.sessionId },
        );
      }
    } else if (failure && (this.supervisor.crashError || !active.controller.signal.aborted)) {
      yield factory(
        "error",
        { message: errorMessage(failure) ?? "OpenCode runtime failed" },
        { runtimeSessionRef: active.sessionId },
      );
    }

    yield factory(
      "terminal",
      buildTerminalPayload({
        state: outcome.state,
        reason: outcome.reason,
        resultText,
        turns,
        durationMs: Date.now() - startedAt,
        resourceLeak: isResourceLeak(failure) || isResourceLeak(cleanupFailure),
      }),
      { runtimeSessionRef: active.sessionId },
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.active?.controller.abort({ kind: "shutdown", reason: "runtime stopped" });
    await this.supervisor.stop();
  }

  private async cleanup(active: ActiveRun): Promise<Error | undefined> {
    const failures: Error[] = [];
    const deadline = Date.now() + this.cleanupTimeoutMs;
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadlineController.abort(new Error("OpenCode cleanup deadline exceeded")),
      this.cleanupTimeoutMs,
    );
    const cleanupSignal = deadlineController.signal;
    const runCleanup = async <T>(
      operation: (signal: AbortSignal) => Promise<T>,
      name: string,
    ): Promise<T> => boundedOperation(operation, cleanupSignal, deadline, name);

    try {
      if (active.stream) {
        const stream = active.stream;
        try {
          await runCleanup(() => stream.return(undefined), "stream return");
        } catch (error) {
          failures.push(toError(error));
        }
      }
      if (active.client && active.sessionId && active.directory) {
        const client = active.client;
        const sessionId = active.sessionId;
        const directory = active.directory;
        try {
          unwrapSdkResponse(
            await runCleanup(
              (requestSignal) =>
                client.session.delete({
                  path: { id: sessionId },
                  query: { directory },
                  signal: requestSignal,
                  responseStyle: "data",
                  throwOnError: true,
                }),
              "session delete",
            ),
            "OpenCode session delete",
          );
        } catch (error) {
          failures.push(toError(error));
        }
      }
    } finally {
      clearTimeout(deadlineTimer);
      try {
        await this.supervisor.stop();
      } catch (error) {
        failures.push(toError(error));
      }
    }
    return failures[0];
  }
}

function withEffectiveModel(input: RehorRun, model: EffectiveOpenCodeModel): RehorRun {
  return {
    ...input,
    provider: {
      ...input.provider,
      requestedModel: model.value,
    },
  };
}

const OPENCODE_CRASH = { kind: "shutdown", reason: "opencode_crash" } as const;

function linkAbort(source: AbortSignal, target: AbortController, before?: () => void): () => void {
  const onAbort = (): void => {
    target.abort(source.reason);
    before?.();
  };
  if (source.aborted) onAbort();
  else source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

function isResourceLeak(value: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = value; current instanceof Error && !seen.has(current); ) {
    if (current instanceof OpenCodeProcessLeakError) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

export type { ProxyEnvironment };

function toError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error(errorMessage(value) ?? "OpenCode cleanup failed");
}
