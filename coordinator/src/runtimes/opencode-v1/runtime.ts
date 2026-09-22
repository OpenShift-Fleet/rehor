import {
  createOpencodeClient,
  type Event as OpenCodeEvent,
  type OpencodeClient,
} from "@opencode-ai/sdk";

import { createEventFactory, type RehorEvent, type RehorRun } from "../../domain";
import type { RuntimeCapabilities } from "../../domain/capabilities";
import type { TerminalState, TerminalWorkContext } from "../../domain/terminal-state";
import type { AgentRuntime } from "../../ports";
import {
  abortKind,
  abortReason,
  assertPositiveInteger,
  boundedOperation,
  extractTaskResult,
  extractToolContext,
  isNoWork,
  lastMeaningfulLine,
  redactSensitiveText,
} from "../shared";
import type { ProxyEnvironment } from "./environment";
import {
  buildOpenCodeEnvironment,
  createOpenCodeFetch,
  type OpenCodeEnvironmentOptions,
} from "./environment";
import {
  OPENCODE_VERSION,
  type OpenCodeServerController,
  type OpenCodeServerInfo,
  OpenCodeServerSupervisor,
  type OpenCodeSupervisorOptions,
} from "./process-supervisor";

export interface OpenCodeV1RuntimeOptions extends OpenCodeEnvironmentOptions {
  policyVersion?: string;
  reconciliationTimeoutMs?: number;
  reconciliationMessageLimit?: number;
  requestTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  server?: OpenCodeSupervisorOptions;
  supervisor?: OpenCodeServerController;
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
  state: TerminalState;
  reason?: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const CAPABILITIES: RuntimeCapabilities = {
  runtimeId: "opencode-v1",
  runtimeVersion: OPENCODE_VERSION,
  configVersion: "1",
  streaming: true,
  interruption: true,
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
  private readonly policyVersion: string;
  private readonly supervisor: OpenCodeServerController;
  private readonly clientEnvironment: Record<string, string>;
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
    this.policyVersion = options.policyVersion ?? "opencode-v1";
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
      options.supervisor ??
      new OpenCodeServerSupervisor({
        ...(options.server ?? {}),
        ...(options.base === undefined ? {} : { base: options.base }),
        ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
        ...(options.passthrough === undefined ? {} : { passthrough: options.passthrough }),
        ...(options.noProxyHosts === undefined ? {} : { noProxyHosts: options.noProxyHosts }),
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

  async start(signal: AbortSignal): Promise<RuntimeCapabilities> {
    if (this.stopped) throw new Error("stopped runtime must not be restarted");
    if (signal.aborted) throw abortReason(signal);
    this.started = true;
    return CAPABILITIES;
  }

  async *run(input: RehorRun, signal: AbortSignal): AsyncIterable<RehorEvent> {
    if (!this.started) throw new Error("runtime must be started before run");
    if (this.stopped) throw new Error("stopped runtime must not stream events");
    if (this.hasRun) throw new Error("OpenCode V1 runtime supports one run per instance");
    this.hasRun = true;

    const factory = createEventFactory(input, this.policyVersion);
    const active: ActiveRun = { controller: new AbortController() };
    const detachAbort = linkAbort(signal, active.controller);
    let detachCrash = (): void => undefined;
    this.active = active;
    const startedAt = Date.now();
    let outcome: RuntimeOutcome | undefined;
    let failure: unknown;
    let resultText = "";
    let turns = 0;
    let promptAttempted = false;
    let streamLost = false;
    let maxTurnsReached = false;
    const workContext = initialTerminalContext(input);
    let normalization!: NormalizationContext;
    let stream: AsyncGenerator<OpenCodeEvent> | undefined;
    const timeout = setTimeout(
      () => active.controller.abort({ kind: "timeout", reason: "run timeout" }),
      input.limits.timeoutMs,
    );

    try {
      const server = await this.supervisor.start(input.worktree.path, active.controller.signal);
      detachCrash = linkAbort(this.supervisor.crashSignal, active.controller);
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
      normalization = {
        rootSessionId: sessionId,
        requestedModel: input.provider.requestedModel,
        workContext,
        resultTextParts: new Map(),
        messageRoles: new Map(),
        countedMessages: new Set(),
        completedMessages: new Set(),
        seenMessages: new Set(),
        seenParts: new Set(),
        sessionIds: new Set([sessionId]),
        toolPhases: new Map(),
        modelEventIds: new Map(),
        usageSnapshots: new Map(),
      };

      yield factory("run", { state: "started" }, { runtimeSessionRef: sessionId });
      promptAttempted = true;
      unwrapSdkResponse(
        await boundedOperation(
          (requestSignal) =>
            client.session.promptAsync({
              path: { id: sessionId },
              query: { directory },
              body: {
                model: resolveModel(input),
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
        if (next.done) {
          streamLost = true;
          break;
        }
        if (!isSessionEvent(next.value, normalization)) continue;
        if (maxTurnsReached && beginsNewTurn(next.value, normalization)) {
          active.controller.abort({
            kind: "max_turns",
            reason: "maximum turn limit reached",
          });
          throw abortReason(active.controller.signal);
        }

        const normalized = normalizeOpenCodeEvent(next.value, factory, normalization);
        if (normalized.turns > 0) turns += normalized.turns;
        for (const event of normalized.events) yield event;
        if (normalized.resultText !== undefined) resultText = normalized.resultText;
        if (normalized.turns > 0) maxTurnsReached = turns >= input.limits.maxTurns;
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
      failure = error;
      if (
        promptAttempted &&
        !signal.aborted &&
        !this.supervisor.crashError &&
        shouldReconcile(active.controller.signal.reason)
      ) {
        streamLost = true;
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
        }
      }
    } finally {
      clearTimeout(timeout);
      detachAbort();
      detachCrash();
      const cleanupFailure = await this.cleanup(active);
      if (!failure && cleanupFailure) failure = cleanupFailure;
      if (this.active === active) this.active = undefined;
    }

    if (!outcome) {
      outcome = {
        state: classifyAbort(
          signal,
          this.supervisor.crashError,
          active.controller.signal.reason,
          streamLost,
        ),
        reason: errorMessage(failure) ?? "OpenCode runtime failed",
      };
    }
    if (!workContext.summary && resultText) {
      const summary = lastMeaningfulLine(resultText);
      if (summary) workContext.summary = summary;
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

    if (failure && outcome.state !== "cancelled" && outcome.state !== "timed_out") {
      yield factory(
        "error",
        { message: errorMessage(failure) ?? "OpenCode runtime failed" },
        { runtimeSessionRef: active.sessionId },
      );
    }

    yield factory(
      "terminal",
      {
        state: outcome.state,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        ...(resultText ? { resultText } : {}),
        noWork: isNoWork(resultText),
        turns,
        durationMs: Date.now() - startedAt,
        ...(Object.keys(workContext).length > 0 ? { context: workContext } : {}),
      },
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

interface NormalizedEvents {
  events: RehorEvent[];
  outcome?: TerminalState;
  reason?: string;
  resultText?: string;
  turns: number;
}

interface NormalizeOptions {
  suppressModel?: boolean;
}

interface UsageSnapshot {
  requestedModel: string;
  bucketModel: string;
  tokenCounts: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  completed: boolean;
  returnedModel?: string;
  cost?: number;
}

interface NormalizationContext {
  rootSessionId: string;
  requestedModel: string;
  workContext: TerminalWorkContext;
  resultTextParts: Map<string, string>;
  messageRoles: Map<string, string>;
  countedMessages: Set<string>;
  completedMessages: Set<string>;
  seenMessages: Set<string>;
  seenParts: Set<string>;
  sessionIds: Set<string>;
  toolPhases: Map<string, "started" | "completed">;
  modelEventIds: Map<string, string>;
  usageSnapshots: Map<string, UsageSnapshot>;
  rootAssistantError?: string;
  rootSessionError?: string;
}

async function reconcileSession(
  active: ActiveRun,
  factory: ReturnType<typeof createEventFactory>,
  normalization: NormalizationContext,
  timeoutMs: number,
  messageLimit: number,
): Promise<NormalizedEvents> {
  if (!active.client || !active.sessionId || !active.directory) {
    return { events: [], turns: 0 };
  }
  const sessionId = active.sessionId;
  const directory = active.directory;
  const client = active.client;

  const controller = new AbortController();
  const signal = AbortSignal.any([active.controller.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort("reconciliation timeout"), timeoutMs);
  const events: RehorEvent[] = [];
  let turns = 0;

  try {
    const reconciliationDeadline = Date.now() + timeoutMs;
    const response = await boundedOperation(
      (requestSignal) =>
        client.session.messages({
          path: { id: sessionId },
          query: { directory, limit: messageLimit },
          signal: requestSignal,
          responseStyle: "data",
          throwOnError: true,
        }),
      signal,
      reconciliationDeadline,
      "session messages reconciliation",
    );
    const data: unknown = unwrapSdkResponse(response, "OpenCode session messages");
    if (!Array.isArray(data)) {
      return {
        events,
        ...(normalization.resultTextParts.size > 0
          ? { resultText: [...normalization.resultTextParts.values()].join("") }
          : {}),
        turns,
      };
    }

    let outcome: TerminalState | undefined;
    let reason: string | undefined;

    for (const entry of data) {
      const message = record(entry);
      const info = record(message.info);
      const messageId = typeof info.id === "string" ? info.id : undefined;
      const isAssistant = info.role === "assistant";
      const completed = Boolean(recordOrUndefined(info.time)?.completed);
      if (messageId && typeof info.role === "string") {
        normalization.messageRoles.set(messageId, info.role);
      }
      if (isAssistant && messageId) {
        const unseen = !normalization.seenMessages.has(messageId);
        const needsFinalUpdate = completed && !normalization.completedMessages.has(messageId);
        const messageEvent = {
          type: "message.updated",
          properties: { info },
        } as unknown as OpenCodeEvent;
        if (!unseen && !needsFinalUpdate) {
          foldOpenCodeEvent(messageEvent, normalization);
        } else {
          const normalized = normalizeOpenCodeEvent(messageEvent, factory, normalization, {
            suppressModel: !unseen,
          });
          events.push(...normalized.events);
          turns += normalized.turns;
        }
      }

      const parts = Array.isArray(message.parts) ? message.parts : [];
      for (const value of parts) {
        const part = record(value);
        const partId = typeof part.id === "string" ? part.id : undefined;
        if (!partId) continue;
        const toolKey = partKey(part);
        const toolCompleted =
          part.type === "tool" && normalization.toolPhases.get(toolKey) === "completed";
        const seenPart = normalization.seenParts.has(partId);
        if (part.type === "text" && part.sessionID === sessionId) {
          const text = stringValue(part.text, "");
          const changed = normalization.resultTextParts.get(partId) !== text;
          normalization.resultTextParts.set(partId, text);
          if (!changed) {
            normalization.seenParts.add(partId);
            continue;
          }
        } else if ((seenPart && part.type !== "tool") || (seenPart && toolCompleted)) {
          continue;
        }
        const normalized = normalizeOpenCodeEvent(
          {
            type: "message.part.updated",
            properties: { part },
          } as unknown as OpenCodeEvent,
          factory,
          normalization,
        );
        events.push(...normalized.events);
        normalization.seenParts.add(partId);
      }
    }

    const statusResponse = await boundedOperation(
      (requestSignal) =>
        client.session.status({
          query: { directory },
          signal: requestSignal,
          responseStyle: "data",
          throwOnError: true,
        }),
      signal,
      reconciliationDeadline,
      "session status reconciliation",
    );
    const statuses = record(unwrapSdkResponse(statusResponse, "OpenCode session status"));
    const rootStatus = statuses[sessionId];
    const rootIsIdle = rootStatus === undefined || record(rootStatus).type === "idle";
    if (rootIsIdle) {
      const completedError = normalization.rootSessionError ?? normalization.rootAssistantError;
      if (completedError) {
        outcome = "failed";
        reason = completedError;
      } else if (data.some((entry) => isTerminalAssistantMessageEntry(entry, sessionId))) {
        outcome = "completed";
      }
    }

    return {
      events,
      ...(outcome ? { outcome, reason } : {}),
      ...(normalization.resultTextParts.size > 0
        ? { resultText: [...normalization.resultTextParts.values()].join("") }
        : {}),
      turns,
    };
  } catch {
    return {
      events,
      ...(normalization.resultTextParts.size > 0
        ? { resultText: [...normalization.resultTextParts.values()].join("") }
        : {}),
      turns,
    };
  } finally {
    clearTimeout(timer);
  }
}

function shouldReconcile(reason: unknown): boolean {
  const kind = abortKind(reason);
  return (
    kind !== "timeout" &&
    kind !== "shutdown" &&
    kind !== "cancel" &&
    kind !== "cancelled" &&
    kind !== "interrupt" &&
    kind !== "interrupted" &&
    kind !== "max_turns"
  );
}

function foldOpenCodeEvent(event: OpenCodeEvent, context: NormalizationContext): void {
  const properties = event.properties as Record<string, unknown>;
  if (event.type === "session.created" || event.type === "session.updated") {
    const info = record(properties.info);
    const sessionId = typeof info.id === "string" ? info.id : undefined;
    const parentId = typeof info.parentID === "string" ? info.parentID : undefined;
    if (
      sessionId &&
      (context.sessionIds.has(sessionId) || context.sessionIds.has(parentId ?? ""))
    ) {
      context.sessionIds.add(sessionId);
    }
    return;
  }
  if (event.type === "message.updated") {
    const info = record(properties.info);
    const messageId = typeof info.id === "string" ? info.id : undefined;
    if (!messageId) return;
    context.seenMessages.add(messageId);
    if (typeof info.role === "string") context.messageRoles.set(messageId, info.role);
    if (recordOrUndefined(info.time)?.completed) context.completedMessages.add(messageId);
    if (eventSessionId(event) === context.rootSessionId && info.role === "assistant") {
      context.rootAssistantError = info.error ? providerErrorMessage(info.error) : undefined;
    }
    return;
  }
  if (event.type === "message.part.updated") {
    const part = record(properties.part);
    const partId = part.id;
    const messageId = part.messageID;
    if (
      typeof partId === "string" &&
      typeof messageId === "string" &&
      context.messageRoles.get(messageId) === "assistant"
    ) {
      context.seenParts.add(partId);
    }
  }
}

function normalizeOpenCodeEvent(
  event: OpenCodeEvent,
  factory: ReturnType<typeof createEventFactory>,
  context: NormalizationContext,
  options: NormalizeOptions = {},
): NormalizedEvents {
  const properties = event.properties as Record<string, unknown>;
  foldOpenCodeEvent(event, context);
  const withSession = { runtimeSessionRef: eventSessionId(event) ?? context.rootSessionId };
  switch (event.type) {
    case "session.created":
      if (eventSessionId(event) === context.rootSessionId) return { events: [], turns: 0 };
      return {
        events: [factory("run", { state: "child_session_started" }, withSession)],
        turns: 0,
      };
    case "session.updated":
    case "session.deleted":
      return { events: [], turns: 0 };
    case "session.status": {
      const status = record(properties.status);
      const isRoot = properties.sessionID === context.rootSessionId;
      return {
        events: [factory("run", { state: status }, withSession)],
        ...(isRoot && status.type === "idle"
          ? (context.rootSessionError ?? context.rootAssistantError)
            ? {
                outcome: "failed" as const,
                reason: context.rootSessionError ?? context.rootAssistantError,
              }
            : { outcome: "completed" as const }
          : {}),
        turns: 0,
      };
    }
    case "session.idle": {
      const isRoot = properties.sessionID === context.rootSessionId;
      return {
        events: [factory("run", { state: "idle" }, withSession)],
        ...(isRoot
          ? (context.rootSessionError ?? context.rootAssistantError)
            ? {
                outcome: "failed" as const,
                reason: context.rootSessionError ?? context.rootAssistantError,
              }
            : { outcome: "completed" as const }
          : {}),
        turns: 0,
      };
    }
    case "session.error": {
      const message = providerErrorMessage(properties.error);
      if (properties.sessionID === context.rootSessionId) context.rootSessionError = message;
      return {
        events: [factory("error", { message }, withSession)],
        turns: 0,
      };
    }
    case "message.updated": {
      const info = record(properties.info);
      if (info.role !== "assistant") return { events: [], turns: 0 };
      const model = typeof info.modelID === "string" ? info.modelID : undefined;
      const error = info.error ? providerErrorMessage(info.error) : undefined;
      const messageId = typeof info.id === "string" ? info.id : undefined;
      let modelEvent: RehorEvent | undefined;
      if (!options.suppressModel) {
        modelEvent = factory(
          "model",
          {
            phase: "updated",
            messageId: info.id,
            ...(info.finish ? { finish: info.finish } : {}),
            ...(error ? { error } : {}),
          },
          { ...withSession, ...(model ? { model } : {}) },
        );
        if (messageId && !context.modelEventIds.has(messageId)) {
          context.modelEventIds.set(messageId, modelEvent.eventId);
        }
      }
      const completed = Boolean(recordOrUndefined(info.time)?.completed);
      const turns =
        eventSessionId(event) === context.rootSessionId &&
        completed &&
        messageId &&
        !context.countedMessages.has(messageId)
          ? 1
          : 0;
      if (completed && messageId) context.countedMessages.add(messageId);
      const parentEventId = messageId
        ? (context.modelEventIds.get(messageId) ?? modelEvent?.eventId)
        : modelEvent?.eventId;
      const usage = assistantUsage(
        info,
        factory,
        {
          ...withSession,
          ...(parentEventId ? { parentEventId } : {}),
          ...(model ? { model } : {}),
        },
        context,
      );
      return {
        events: [
          ...(modelEvent ? [modelEvent] : []),
          ...(usage ? [usage] : []),
          ...(error ? [factory("error", { message: error }, withSession)] : []),
        ],
        turns,
      };
    }
    case "message.part.updated": {
      const part = record(properties.part);
      const partId = stringValue(part.id, "unknown-part");
      const messageId = stringValue(part.messageID, "unknown-message");
      if (context.messageRoles.get(messageId) !== "assistant") {
        return { events: [], turns: 0 };
      }
      if (part.type === "text" || part.type === "reasoning") {
        const text = stringValue(part.text, "");
        if (part.type === "text" && part.sessionID === context.rootSessionId) {
          context.resultTextParts.set(partId, text);
        }
        return {
          events: [
            factory(
              "model",
              {
                phase: part.type,
                partId,
                text,
                ...(typeof properties.delta === "string" ? { delta: properties.delta } : {}),
              },
              withSession,
            ),
          ],
          ...(context.resultTextParts.size > 0
            ? { resultText: [...context.resultTextParts.values()].join("") }
            : {}),
          turns: 0,
        };
      }
      if (part.type === "tool") {
        const state = record(part.state);
        const name = stringValue(part.tool, "unknown");
        const input = recordOrUndefined(state.input);
        const finished = state.status === "completed" || state.status === "error";
        extractToolContext(name, input, context.workContext);
        if (state.status === "completed") extractTaskResult(state.output, context.workContext);
        const start = numberValue(recordOrUndefined(state.time)?.start);
        const end = numberValue(recordOrUndefined(state.time)?.end);
        const phase = finished ? "completed" : "started";
        const key = partKey(part);
        if (context.toolPhases.get(key) === phase) return { events: [], turns: 0 };
        context.toolPhases.set(key, phase);
        return {
          events: [
            factory(
              "tool",
              {
                partId,
                state: finished ? "completed" : "started",
                name,
                toolName: name,
                ...(typeof part.callID === "string" ? { toolUseId: part.callID } : {}),
                ...(input ? { input } : {}),
                ...(finished && start !== undefined && end !== undefined
                  ? { durationMs: Math.max(0, end - start) }
                  : {}),
                ...(state.status === "error" ? { isError: true } : {}),
                ...(typeof state.output === "string" ? { content: state.output } : {}),
                ...(typeof state.error === "string" ? { content: state.error } : {}),
              },
              withSession,
            ),
          ],
          turns: 0,
        };
      }
      if (part.type === "step-finish") {
        return {
          events: [factory("run", { state: "step_finished", reason: part.reason }, withSession)],
          turns: 0,
        };
      }
      if (part.type === "step-start") {
        return {
          events: [factory("run", { state: "step_started" }, withSession)],
          turns: 0,
        };
      }
      return { events: [], turns: 0 };
    }
    case "permission.updated": {
      const reason = "OpenCode permission request cannot be handled in headless mode";
      return {
        events: [
          factory("policy", { state: "permission_requested", ...properties }, withSession),
          factory("error", { message: reason }, withSession),
        ],
        outcome: "failed",
        reason,
        turns: 0,
      };
    }
    default:
      return { events: [], turns: 0 };
  }
}

function assistantUsage(
  info: Record<string, unknown>,
  factory: ReturnType<typeof createEventFactory>,
  overrides: {
    runtimeSessionRef: string;
    parentEventId?: string;
  },
  context: NormalizationContext,
): RehorEvent | undefined {
  const tokens = recordOrUndefined(info.tokens);
  if (!tokens) return undefined;
  const cache = recordOrUndefined(tokens.cache);
  const messageId = stringValue(info.id, "unknown-message");
  const returnedModel = typeof info.modelID === "string" ? info.modelID : undefined;
  const bucketModel = returnedModel ?? context.requestedModel;
  const requestedModel =
    overrides.runtimeSessionRef === context.rootSessionId
      ? context.requestedModel
      : (qualifiedModel(info) ?? context.requestedModel);
  const snapshot: UsageSnapshot = {
    requestedModel,
    bucketModel,
    tokenCounts: {
      input: nonNegativeInteger(tokens.input),
      output: nonNegativeInteger(tokens.output),
      reasoning: nonNegativeInteger(tokens.reasoning),
      cacheRead: nonNegativeInteger(cache?.read),
      cacheWrite: nonNegativeInteger(cache?.write),
    },
    completed: Boolean(recordOrUndefined(info.time)?.completed),
    ...(returnedModel ? { returnedModel } : {}),
    ...(typeof info.cost === "number" && Number.isFinite(info.cost) ? { cost: info.cost } : {}),
  };
  context.usageSnapshots.set(`${overrides.runtimeSessionRef}:${messageId}`, snapshot);

  const tokenCounts = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let cost = 0;
  let hasCost = false;
  let final = true;
  for (const current of context.usageSnapshots.values()) {
    if (current.bucketModel !== snapshot.bucketModel) continue;
    tokenCounts.input += current.tokenCounts.input;
    tokenCounts.output += current.tokenCounts.output;
    tokenCounts.reasoning += current.tokenCounts.reasoning;
    tokenCounts.cacheRead += current.tokenCounts.cacheRead;
    tokenCounts.cacheWrite += current.tokenCounts.cacheWrite;
    final &&= current.completed;
    if (current.cost !== undefined) {
      cost += current.cost;
      hasCost = true;
    }
  }

  return factory(
    "usage",
    {
      requestedModel,
      ...(snapshot.returnedModel ? { returnedModel: snapshot.returnedModel } : {}),
      tokenCounts,
      partial: !final,
      final,
      estimated: false,
      incomplete: !final,
      ...(hasCost ? { cost: { amount: cost, currency: "USD", source: "provider" } } : {}),
    },
    { ...overrides, ...(snapshot.returnedModel ? { model: snapshot.returnedModel } : {}) },
  );
}

function unwrapSdkResponse(value: unknown, operation: string): unknown {
  const response = recordOrUndefined(value);
  if (response?.error !== undefined) {
    throw new Error(`${operation} failed: ${providerErrorMessage(response.error)}`);
  }
  return response && "data" in response ? response.data : value;
}

function isTerminalAssistantMessageEntry(value: unknown, sessionId: string): boolean {
  const info = record(record(value).info);
  if (info.sessionID !== sessionId || info.role !== "assistant") return false;
  if (!recordOrUndefined(info.time)?.completed || typeof info.finish !== "string") return false;
  return info.finish !== "tool-calls" && info.finish !== "unknown";
}

function qualifiedModel(info: Record<string, unknown>): string | undefined {
  if (typeof info.providerID !== "string" || typeof info.modelID !== "string") return undefined;
  return `${info.providerID}/${info.modelID}`;
}

function resolveModel(input: RehorRun): { providerID: string; modelID: string } {
  const slash = input.provider.requestedModel.indexOf("/");
  if (slash > 0 && slash < input.provider.requestedModel.length - 1) {
    return {
      providerID: input.provider.requestedModel.slice(0, slash),
      modelID: input.provider.requestedModel.slice(slash + 1),
    };
  }
  return { providerID: input.provider.id, modelID: input.provider.requestedModel };
}

function isSessionEvent(event: OpenCodeEvent, context: NormalizationContext): boolean {
  const properties = event.properties as Record<string, unknown>;
  if (event.type === "session.created" || event.type === "session.updated") {
    const info = record(properties.info);
    return (
      info.id === context.rootSessionId ||
      (typeof info.id === "string" && context.sessionIds.has(info.id)) ||
      (typeof info.parentID === "string" && context.sessionIds.has(info.parentID))
    );
  }
  const sessionId = eventSessionId(event);
  return sessionId !== undefined && context.sessionIds.has(sessionId);
}

function beginsNewTurn(event: OpenCodeEvent, context: NormalizationContext): boolean {
  if (event.type === "message.updated") {
    const info = record(event.properties.info);
    return (
      eventSessionId(event) === context.rootSessionId &&
      info.role === "assistant" &&
      typeof info.id === "string" &&
      !context.seenMessages.has(info.id)
    );
  }
  if (event.type === "message.part.updated") {
    const part = record(event.properties.part);
    return part.sessionID === context.rootSessionId && part.type === "step-start";
  }
  return false;
}

function eventSessionId(event: OpenCodeEvent): string | undefined {
  const properties = event.properties as Record<string, unknown>;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  if (event.type === "message.updated") {
    const sessionId = record(properties.info).sessionID;
    return typeof sessionId === "string" ? sessionId : undefined;
  }
  if (event.type === "message.part.updated") {
    const sessionId = record(properties.part).sessionID;
    return typeof sessionId === "string" ? sessionId : undefined;
  }
  if (event.type === "session.created" || event.type === "session.updated") {
    const sessionId = record(properties.info).id;
    return typeof sessionId === "string" ? sessionId : undefined;
  }
  return undefined;
}

function initialTerminalContext(input: RehorRun): TerminalWorkContext {
  if (!input.task) return {};
  const taskId = Number(input.task.id);
  return {
    ...(Number.isSafeInteger(taskId) && taskId > 0 ? { taskId } : {}),
    ...(input.task.key ? { externalKey: input.task.key } : {}),
  };
}

function partKey(part: JsonRecord): string {
  return `${stringValue(part.sessionID, "unknown-session")}:${stringValue(part.id, "unknown-part")}`;
}

function classifyAbort(
  signal: AbortSignal,
  crash: Error | undefined,
  controllerReason: unknown,
  streamLost: boolean,
): TerminalState {
  const reason = signal.aborted ? signal.reason : controllerReason;
  const kind = abortKind(reason);
  if (kind === "timeout" || kind === "timed_out" || kind === "max_turns") return "timed_out";
  if (kind === "cancel" || kind === "cancelled") return "cancelled";
  if (kind === "shutdown" || kind === "interrupt" || kind === "interrupted") {
    return "interrupted";
  }
  if (crash || streamLost) return "interrupted";
  return "failed";
}

function linkAbort(source: AbortSignal, target: AbortController): () => void {
  const onAbort = (): void => target.abort(source.reason);
  if (source.aborted) onAbort();
  else source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return recordOrUndefined(value) ?? {};
}

function recordOrUndefined(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function providerErrorMessage(value: unknown): string {
  if (typeof value === "string") return redactSensitiveText(value);
  const error = record(value);
  const data = record(error.data);
  return redactSensitiveText(stringValue(data.message ?? error.message, "OpenCode session error"));
}

function errorMessage(value: unknown): string | undefined {
  if (value instanceof Error) return redactSensitiveText(value.message);
  if (typeof value === "string") return redactSensitiveText(value);
  return undefined;
}

function toError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error(errorMessage(value) ?? "OpenCode cleanup failed");
}

export type { ProxyEnvironment };
