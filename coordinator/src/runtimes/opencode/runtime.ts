import { setTimeout as delay } from "node:timers/promises";
import { OpenCode, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client";
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
import type { EffectiveOpenCodeModel, RenderedOpenCodeConfig } from "./types";

export type OpenCodeServerOptions = Omit<OpenCodeSupervisorOptions, "renderedConfig">;
export type OpenCodeSupervisorFactory = (
  renderedConfig: RenderedOpenCodeConfig | undefined,
) => OpenCodeServerController;

export interface OpenCodeRuntimeOptions extends OpenCodeEnvironmentOptions {
  logger?: Logger;
  policyVersion?: string;
  reconciliationTimeoutMs?: number;
  reconciliationMessageLimit?: number;
  requestTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  /** Immutable configuration rendered by the runtime factory for this run. */
  renderedConfig?: RenderedOpenCodeConfig;
  /** Configuration failures are emitted through the normal runtime lifecycle. */
  renderError?: unknown;
  server?: OpenCodeServerOptions;
  /** Build an injected supervisor with this run's immutable rendered snapshot. */
  supervisor?: OpenCodeSupervisorFactory;
  clientFactory?: OpenCodeClientFactory;
}

export type OpenCodeClientFactory = (
  server: OpenCodeServerInfo,
  directory: string,
  environment: Readonly<Record<string, string>>,
) => OpenCodeClient;

interface ActiveRun {
  controller: AbortController;
  client?: OpenCodeClient;
  sessionId?: string;
  directory?: string;
  stream?: AsyncIterator<OpenCodeEvent>;
}

interface RuntimeOutcome {
  state: RuntimeTerminalState;
  reason?: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const CAPABILITIES: RuntimeCapabilities = {
  runtimeId: "opencode",
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
 * OpenCode runtime adapter backed by the V2 client/server contract.
 * OpenCode SDK values are consumed here and never cross
 * the AgentRuntime port; callers receive only Rehor-owned events.
 */
export class OpenCodeRuntime implements AgentRuntime {
  private readonly logger: Logger;
  private readonly policyVersion: string;
  private readonly supervisor: OpenCodeServerController;
  private readonly clientEnvironment: Record<string, string>;
  private readonly renderedConfig?: RenderedOpenCodeConfig;
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

  constructor(options: OpenCodeRuntimeOptions = {}) {
    this.logger = options.logger ?? nullLogger;
    this.policyVersion = options.policyVersion ?? "opencode";
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
      this.clientFactory = (server) =>
        OpenCode.make({
          baseUrl: server.baseUrl,
          headers:
            server.password === undefined
              ? undefined
              : {
                  authorization: `Basic ${Buffer.from(`opencode:${server.password}`).toString("base64")}`,
                },
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

  get renderedConfiguration(): RenderedOpenCodeConfig | undefined {
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
    if (this.hasRun) throw new Error("OpenCode runtime supports one run per instance");
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

      const iterator = client.event
        .subscribe({ signal: active.controller.signal })
        [Symbol.asyncIterator]();
      active.stream = iterator;
      const connected = await boundedOperation(
        () => iterator.next(),
        active.controller.signal,
        Date.now() + this.requestTimeoutMs,
        "OpenCode event connection",
      );
      if (connected.done || connected.value.type !== "server.connected") {
        throw new Error("OpenCode event stream did not begin with server.connected");
      }

      // Location inventory loads the policy plugin before admitting any prompt.
      // A plugin that failed to load must never silently turn enforcement off.
      await this.assertPolicyActive(client, directory, active.controller.signal);

      const session = await boundedOperation(
        (requestSignal) =>
          client.session.create(
            {
              title: `Rehor ${input.runId}`,
              location: { directory },
              model: { providerID: effectiveModel.providerID, id: effectiveModel.modelID },
            },
            { signal: requestSignal },
          ),
        active.controller.signal,
        Date.now() + this.requestTimeoutMs,
        "OpenCode session creation",
      );
      const sessionId = stringValue(session.id, "");
      if (!sessionId) throw new Error("OpenCode session creation returned no session");
      active.sessionId = sessionId;
      normalization = createNormalizationContext(sessionId, effectiveModel.value);

      promptAttempted = true;
      await boundedOperation(
        (requestSignal) =>
          client.session.prompt(
            { sessionID: sessionId, text: input.prompt },
            { signal: requestSignal },
          ),
        active.controller.signal,
        Date.now() + this.requestTimeoutMs,
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
        const data = record(next.value.data);
        const waitingSession =
          next.value.type === "form.created" ? record(data.form).sessionID : data.sessionID;
        if (
          (next.value.type === "permission.asked" || next.value.type === "form.created") &&
          typeof waitingSession === "string" &&
          normalization.sessionIds.has(waitingSession)
        ) {
          const reason =
            next.value.type === "permission.asked"
              ? "OpenCode permission request cannot be handled in headless mode"
              : "OpenCode form request cannot be handled in headless mode";
          yield factory(
            "policy",
            {
              state:
                next.value.type === "permission.asked" ? "permission_requested" : "form_requested",
            },
            { runtimeSessionRef: waitingSession },
          );
          yield factory("error", { message: reason }, { runtimeSessionRef: waitingSession });
          outcome = { state: "failed", reason };
          break;
        }
        if (!isSessionEvent(next.value, normalization)) continue;
        const startsTurn = beginsNewTurn(next.value, normalization);
        const normalized = normalizeOpenCodeEvent(next.value, factory, normalization);
        if (
          next.value.type === "session.execution.failed" ||
          next.value.type === "session.step.failed"
        ) {
          this.logger.log("ERROR", "OpenCode session error", {
            run_id: input.runId,
            attempt_id: input.attemptId,
            diagnostic: providerDiagnostic(data.error),
            server_diagnostics: this.supervisor.diagnostics,
          });
        }
        if (normalized.turns > 0) turns += normalized.turns;
        for (const event of normalized.events) yield event;
        if (startsTurn) {
          // The next native step already exists. Publish its pending usage before
          // the coordinator can abort on this budget notification and skip recovery.
          yield factory(
            "run",
            { state: "turn_started" },
            { runtimeSessionRef: normalization.rootSessionId },
          );
          if (signal.aborted) throw abortReason(signal);
        }
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

  private async assertPolicyActive(
    client: OpenCodeClient,
    directory: string,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.requestTimeoutMs;
    const inactiveError = new Error("OpenCode required policy plugin rehor-policy is not active");
    for (;;) {
      const inventory = await boundedOperation(
        (signal) => client.plugin.list({ location: { directory } }, { signal }),
        signal,
        deadline,
        "OpenCode policy plugin inventory",
        inactiveError,
      );
      const policies = Array.isArray(inventory.data)
        ? inventory.data.filter((plugin) => plugin.id === "rehor-policy")
        : [];
      if (policies.length) {
        if (policies.every((plugin) => plugin.state?.status === "active")) return;
        throw inactiveError;
      }
      // Native Plugin.list is a non-blocking inventory read: the first request
      // may precede asynchronous source activation. Missing is never admission;
      // allow it only a bounded startup window, while explicit failures stop now.
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw inactiveError;
      await delay(Math.min(25, remaining), undefined, { signal });
      if (Date.now() >= deadline) throw inactiveError;
    }
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
      if (active.client && active.sessionId) {
        const client = active.client;
        const sessionID = active.sessionId;
        try {
          await runCleanup(
            (signal) => client.session.interrupt({ sessionID, resume: false }, { signal }),
            "session interrupt",
          );
        } catch (error) {
          failures.push(toError(error));
        }
      }
      if (active.stream) {
        const stream = active.stream;
        try {
          await runCleanup(() => Promise.resolve(stream.return?.()), "stream return");
        } catch (error) {
          failures.push(toError(error));
        }
      }
      if (active.client && active.sessionId) {
        const client = active.client;
        const sessionId = active.sessionId;
        try {
          await runCleanup(
            (requestSignal) =>
              client.session.remove({ sessionID: sessionId }, { signal: requestSignal }),
            "session remove",
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
