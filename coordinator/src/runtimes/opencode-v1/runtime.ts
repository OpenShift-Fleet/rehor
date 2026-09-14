import {
  createOpencodeClient,
  type Event as OpenCodeEvent,
  type OpencodeClient,
} from "@opencode-ai/sdk";

import { createEventFactory, type RehorEvent, type RehorRun } from "../../domain";
import type { RuntimeCapabilities } from "../../domain/capabilities";
import type { TerminalState } from "../../domain/terminal-state";
import type { AgentRuntime } from "../../ports";
import type { ProxyEnvironment } from "./environment";
import { buildOpenCodeEnvironment, type OpenCodeEnvironmentOptions } from "./environment";
import {
  type OpenCodeServerController,
  type OpenCodeServerInfo,
  OpenCodeServerSupervisor,
  type OpenCodeSupervisorOptions,
} from "./process-supervisor";

export interface OpenCodeV1RuntimeOptions extends OpenCodeEnvironmentOptions {
  policyVersion?: string;
  reconciliationTimeoutMs?: number;
  reconciliationMessageLimit?: number;
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

const CAPABILITIES: RuntimeCapabilities = {
  runtimeId: "opencode-v1",
  runtimeVersion: "1",
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
    assertPositiveInteger(this.reconciliationTimeoutMs, "reconciliationTimeoutMs");
    assertPositiveInteger(this.reconciliationMessageLimit, "reconciliationMessageLimit");
    this.supervisor =
      options.supervisor ??
      new OpenCodeServerSupervisor({
        ...options,
        ...(options.server ?? {}),
        base: options.base,
        proxy: options.proxy,
        passthrough: options.passthrough,
        noProxyHosts: options.noProxyHosts,
      });
    this.clientFactory =
      options.clientFactory ??
      ((server, directory, environment) =>
        createOpencodeClient({
          baseUrl: server.baseUrl,
          directory,
          // Do not mutate process.env. The client receives the same explicit
          // proxy environment used to launch the child process.
          fetch: (request) => fetchWithEnvironment(request, environment),
        }));
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
    let promptSubmitted = false;
    let streamLost = false;
    let maxTurnsReached = false;
    const resultTextParts = new Map<string, string>();
    const messageRoles = new Map<string, string>();
    const countedMessages = new Set<string>();
    const seenMessages = new Set<string>();
    const seenParts = new Set<string>();
    const completedMessages = new Set<string>();
    const sessionIds = new Set<string>();
    let normalization!: NormalizationContext;
    let stream: AsyncGenerator<OpenCodeEvent> | undefined;
    const timeout = setTimeout(() => active.controller.abort("timeout"), input.limits.timeoutMs);

    try {
      const server = await this.supervisor.start(input.worktree.path, active.controller.signal);
      detachCrash = linkAbort(this.supervisor.crashSignal, active.controller);
      const client = this.clientFactory(server, input.worktree.path, this.clientEnvironment);
      active.client = client;
      active.directory = input.worktree.path;
      await assertClientReady(client, input.worktree.path);

      const subscription = await client.event.subscribe({
        query: { directory: input.worktree.path },
        signal: active.controller.signal,
        sseMaxRetryAttempts: 0,
      });
      stream = subscription.stream;
      active.stream = stream;
      const iterator = stream[Symbol.asyncIterator]();

      const sessionResponse = await client.session.create({
        query: { directory: input.worktree.path },
        body: { title: `Rehor ${input.runId}` },
        signal: active.controller.signal,
        responseStyle: "data",
        throwOnError: true,
      });
      const session = record(unwrapSdkResponse(sessionResponse, "OpenCode session creation"));
      const sessionId = stringValue(session.id, "");
      if (!sessionId) throw new Error("OpenCode session creation returned no session");
      active.sessionId = sessionId;
      sessionIds.add(sessionId);
      normalization = {
        rootSessionId: sessionId,
        requestedModel: input.provider.requestedModel,
        resultTextParts,
        messageRoles,
        countedMessages,
        modelEventIds: new Map(),
        usageSnapshots: new Map(),
      };

      yield factory("run", { state: "started" }, { runtimeSessionRef: sessionId });
      unwrapSdkResponse(
        await client.session.promptAsync({
          path: { id: sessionId },
          query: { directory: input.worktree.path },
          body: {
            model: resolveModel(input),
            parts: [{ type: "text", text: input.prompt }],
          },
          signal: active.controller.signal,
          responseStyle: "data",
          throwOnError: true,
        }),
        "OpenCode session prompt",
      );
      promptSubmitted = true;

      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          streamLost = true;
          break;
        }
        if (!isSessionEvent(next.value, sessionIds, sessionId)) continue;
        if (maxTurnsReached && beginsNewTurn(next.value, seenMessages)) {
          active.controller.abort("max_turns");
          throw abortReason(active.controller.signal);
        }
        observeOpenCodeEvent(
          next.value,
          sessionIds,
          seenMessages,
          seenParts,
          completedMessages,
          messageRoles,
        );

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
      if (promptSubmitted && !signal.aborted && shouldReconcile(active.controller.signal.reason)) {
        streamLost = true;
        const reconciled = await reconcileSession(
          active,
          factory,
          normalization,
          seenMessages,
          seenParts,
          completedMessages,
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
      const cleanupFailure = await this.cleanup(active, outcome);
      if (!failure && cleanupFailure) failure = cleanupFailure;
      if (cleanupFailure && outcome?.state === "completed") {
        outcome = { state: "failed", reason: cleanupFailure.message };
      }
      if (this.active === active) this.active = undefined;
    }

    if (!outcome) {
      outcome = {
        state: classifyAbort(
          signal,
          failure,
          this.supervisor.crashError,
          active.controller.signal.reason,
          streamLost,
        ),
        reason: errorMessage(failure) ?? "OpenCode runtime failed",
      };
    }

    if (outcome.state !== "completed") {
      yield factory(
        "persistence",
        {
          action: "partial-state",
          state: "persisted",
          reason:
            this.supervisor.crashError?.message ??
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
        ...(terminalContext(input) ? { context: terminalContext(input) } : {}),
      },
      { runtimeSessionRef: active.sessionId },
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.active?.controller.abort("shutdown");
    await this.supervisor.stop();
  }

  private async cleanup(active: ActiveRun, outcome?: RuntimeOutcome): Promise<Error | undefined> {
    const failures: Error[] = [];
    if (active.stream) {
      try {
        await active.stream.return(undefined);
      } catch (error) {
        failures.push(toError(error));
      }
    }
    if (active.client && active.sessionId && active.directory) {
      if (outcome?.state !== "completed") {
        try {
          unwrapSdkResponse(
            await active.client.session.abort({
              path: { id: active.sessionId },
              query: { directory: active.directory },
              responseStyle: "data",
              throwOnError: true,
            }),
            "OpenCode session abort",
          );
        } catch (error) {
          failures.push(toError(error));
        }
      }
      try {
        unwrapSdkResponse(
          await active.client.session.delete({
            path: { id: active.sessionId },
            query: { directory: active.directory },
            responseStyle: "data",
            throwOnError: true,
          }),
          "OpenCode session delete",
        );
      } catch (error) {
        failures.push(toError(error));
      }
    }
    try {
      await this.supervisor.stop();
    } catch (error) {
      failures.push(toError(error));
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

interface UsageSnapshot {
  requestedModel: string;
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
  resultTextParts: Map<string, string>;
  messageRoles: Map<string, string>;
  countedMessages: Set<string>;
  modelEventIds: Map<string, string>;
  usageSnapshots: Map<string, UsageSnapshot>;
  rootAssistantError?: string;
}

function observeOpenCodeEvent(
  event: OpenCodeEvent,
  sessionIds: Set<string>,
  seenMessages: Set<string>,
  seenParts: Set<string>,
  completedMessages: Set<string>,
  messageRoles: Map<string, string>,
): void {
  const properties = event.properties as Record<string, unknown>;
  if (event.type === "session.created" || event.type === "session.updated") {
    const info = record(properties.info);
    const sessionId = typeof info.id === "string" ? info.id : undefined;
    const parentId = typeof info.parentID === "string" ? info.parentID : undefined;
    if (sessionId && (sessionIds.has(sessionId) || sessionIds.has(parentId ?? ""))) {
      sessionIds.add(sessionId);
    }
    return;
  }
  if (event.type === "message.updated") {
    const info = record(properties.info);
    const messageId = typeof info.id === "string" ? info.id : undefined;
    if (!messageId) return;
    seenMessages.add(messageId);
    if (typeof info.role === "string") messageRoles.set(messageId, info.role);
    if (recordOrUndefined(info.time)?.completed) completedMessages.add(messageId);
    return;
  }
  if (event.type === "message.part.updated") {
    const part = record(properties.part);
    const partId = part.id;
    const messageId = part.messageID;
    if (
      typeof partId === "string" &&
      typeof messageId === "string" &&
      messageRoles.get(messageId) === "assistant"
    ) {
      seenParts.add(partId);
    }
  }
}

async function reconcileSession(
  active: ActiveRun,
  factory: ReturnType<typeof createEventFactory>,
  normalization: NormalizationContext,
  seenMessages: Set<string>,
  seenParts: Set<string>,
  completedMessages: Set<string>,
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
  const timer = setTimeout(() => controller.abort("reconciliation timeout"), timeoutMs);
  const events: RehorEvent[] = [];
  let turns = 0;

  try {
    const response = await client.session.messages({
      path: { id: sessionId },
      query: { directory, limit: messageLimit },
      signal: controller.signal,
      responseStyle: "data",
      throwOnError: true,
    });
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
        const unseen = !seenMessages.has(messageId);
        const needsFinalUpdate = completed && !completedMessages.has(messageId);
        if (unseen || needsFinalUpdate) {
          const normalized = normalizeOpenCodeEvent(
            {
              type: "message.updated",
              properties: { info },
            } as unknown as OpenCodeEvent,
            factory,
            normalization,
          );
          events.push(
            ...(unseen
              ? normalized.events
              : normalized.events.filter((event) => event.kind !== "model")),
          );
          turns += normalized.turns;
        }
        if (unseen) seenMessages.add(messageId);
        if (completed) completedMessages.add(messageId);
      }

      const parts = Array.isArray(message.parts) ? message.parts : [];
      for (const value of parts) {
        const part = record(value);
        const partId = typeof part.id === "string" ? part.id : undefined;
        if (!partId || seenParts.has(partId)) continue;
        const normalized = normalizeOpenCodeEvent(
          {
            type: "message.part.updated",
            properties: { part },
          } as unknown as OpenCodeEvent,
          factory,
          normalization,
        );
        events.push(...normalized.events);
        seenParts.add(partId);
      }
    }

    const statusResponse = await client.session.status({
      query: { directory },
      signal: controller.signal,
      responseStyle: "data",
      throwOnError: true,
    });
    const statuses = record(unwrapSdkResponse(statusResponse, "OpenCode session status"));
    const rootStatus = statuses[sessionId];
    const rootIsIdle = rootStatus === undefined || record(rootStatus).type === "idle";
    if (rootIsIdle) {
      const completedError =
        data
          .map((entry) => providerErrorFromMessageEntry(entry, sessionId))
          .find((message) => message !== undefined) ?? normalization.rootAssistantError;
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
  const message = errorMessage(reason)?.toLowerCase() ?? "";
  return (
    !message.includes("timeout") &&
    !message.includes("shutdown") &&
    !message.includes("cancel") &&
    !message.includes("max_turns")
  );
}

function normalizeOpenCodeEvent(
  event: OpenCodeEvent,
  factory: ReturnType<typeof createEventFactory>,
  context: NormalizationContext,
): NormalizedEvents {
  const properties = event.properties as Record<string, unknown>;
  const withSession = { runtimeSessionRef: eventSessionId(event) ?? context.rootSessionId };
  switch (event.type) {
    case "server.connected":
      return { events: [factory("run", { state: "server_connected" }, withSession)], turns: 0 };
    case "session.created":
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
          ? context.rootAssistantError
            ? { outcome: "failed" as const, reason: context.rootAssistantError }
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
          ? context.rootAssistantError
            ? { outcome: "failed" as const, reason: context.rootAssistantError }
            : { outcome: "completed" as const }
          : {}),
        turns: 0,
      };
    }
    case "session.error": {
      const message = providerErrorMessage(properties.error);
      const isRoot = properties.sessionID === context.rootSessionId;
      return {
        events: [factory("error", { message }, withSession)],
        ...(isRoot ? { outcome: "failed" as const, reason: message } : {}),
        turns: 0,
      };
    }
    case "message.updated": {
      const info = record(properties.info);
      if (info.role !== "assistant") return { events: [], turns: 0 };
      const model = typeof info.modelID === "string" ? info.modelID : undefined;
      const error = info.error ? providerErrorMessage(info.error) : undefined;
      if (eventSessionId(event) === context.rootSessionId) context.rootAssistantError = error;
      const messageId = typeof info.id === "string" ? info.id : undefined;
      const modelEvent = factory(
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
      const completed = Boolean(recordOrUndefined(info.time)?.completed);
      const turns = completed && messageId && !context.countedMessages.has(messageId) ? 1 : 0;
      if (completed && messageId) context.countedMessages.add(messageId);
      const usage = assistantUsage(
        info,
        factory,
        {
          ...withSession,
          parentEventId: messageId
            ? (context.modelEventIds.get(messageId) ?? modelEvent.eventId)
            : modelEvent.eventId,
          ...(model ? { model } : {}),
        },
        context,
      );
      return {
        events: [
          modelEvent,
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
        return {
          events: [
            factory(
              "tool",
              {
                partId,
                tool: stringValue(part.tool, "unknown"),
                callId: stringValue(part.callID, "unknown"),
                state: state.status,
                ...(state.input ? { input: state.input } : {}),
                ...(state.output ? { output: state.output } : {}),
                ...(state.error ? { error: state.error } : {}),
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
    case "permission.updated":
      return {
        events: [factory("policy", { state: "permission_requested", ...properties }, withSession)],
        turns: 0,
      };
    default:
      return {
        events: [
          factory(
            "runtime-exit",
            { state: "unknown_event", eventType: boundedString(event.type, "unknown-event") },
            withSession,
          ),
        ],
        turns: 0,
      };
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
  const requestedModel =
    overrides.runtimeSessionRef === context.rootSessionId
      ? context.requestedModel
      : (qualifiedModel(info) ?? context.requestedModel);
  const snapshot: UsageSnapshot = {
    requestedModel,
    tokenCounts: {
      input: nonNegativeInteger(tokens.input),
      output: nonNegativeInteger(tokens.output),
      reasoning: nonNegativeInteger(tokens.reasoning),
      cacheRead: nonNegativeInteger(cache?.read),
      cacheWrite: nonNegativeInteger(cache?.write),
    },
    completed: Boolean(recordOrUndefined(info.time)?.completed),
    ...(typeof info.modelID === "string" ? { returnedModel: info.modelID } : {}),
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
  let returnedModel: string | undefined;
  for (const current of context.usageSnapshots.values()) {
    if (current.requestedModel !== requestedModel) continue;
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
    if (current.returnedModel !== undefined) returnedModel = current.returnedModel;
  }

  return factory(
    "usage",
    {
      requestedModel,
      ...(returnedModel ? { returnedModel } : {}),
      tokenCounts,
      partial: !final,
      final,
      estimated: false,
      incomplete: !final,
      ...(hasCost ? { cost: { amount: cost, currency: "USD", source: "provider" } } : {}),
    },
    { ...overrides, ...(returnedModel ? { model: returnedModel } : {}) },
  );
}

async function assertClientReady(client: OpencodeClient, directory: string): Promise<void> {
  const result = await client.path.get({
    query: { directory },
    responseStyle: "data",
    throwOnError: true,
  });
  const path = record(unwrapSdkResponse(result, "OpenCode path readiness"));
  if (path.directory !== directory) {
    throw new Error(`OpenCode client readiness resolved wrong worktree for ${directory}`);
  }
}

function unwrapSdkResponse(value: unknown, operation: string): unknown {
  const response = recordOrUndefined(value);
  if (response?.error !== undefined) {
    throw new Error(`${operation} failed: ${providerErrorMessage(response.error)}`);
  }
  return response && "data" in response ? response.data : value;
}

function providerErrorFromMessageEntry(value: unknown, sessionId: string): string | undefined {
  const info = record(record(value).info);
  if (info.sessionID !== sessionId || info.role !== "assistant" || !info.error) return undefined;
  return providerErrorMessage(info.error);
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

function isSessionEvent(
  event: OpenCodeEvent,
  sessionIds: Set<string>,
  rootSessionId: string,
): boolean {
  const properties = event.properties as Record<string, unknown>;
  if (event.type === "server.connected") return true;
  if (event.type === "session.created" || event.type === "session.updated") {
    const info = record(properties.info);
    return (
      info.id === rootSessionId ||
      (typeof info.id === "string" && sessionIds.has(info.id)) ||
      (typeof info.parentID === "string" && sessionIds.has(info.parentID))
    );
  }
  const sessionId = eventSessionId(event);
  return sessionId !== undefined && sessionIds.has(sessionId);
}

function beginsNewTurn(event: OpenCodeEvent, seenMessages: Set<string>): boolean {
  if (event.type === "message.updated") {
    const info = record(event.properties.info);
    return info.role === "assistant" && typeof info.id === "string" && !seenMessages.has(info.id);
  }
  if (event.type === "message.part.updated") {
    return record(event.properties.part).type === "step-start";
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

function terminalContext(input: RehorRun): Record<string, unknown> | undefined {
  if (!input.task) return undefined;
  const taskId = Number(input.task.id);
  return {
    ...(Number.isSafeInteger(taskId) && taskId > 0 ? { taskId } : {}),
    ...(input.task.key ? { externalKey: input.task.key } : {}),
  };
}

function isNoWork(resultText: string): boolean {
  return /\b(no actionable work|no work found|nothing actionable)\b/i.test(resultText);
}

function classifyAbort(
  signal: AbortSignal,
  failure: unknown,
  crash: Error | undefined,
  controllerReason: unknown,
  streamLost: boolean,
): TerminalState {
  if (signal.aborted || controllerReason !== undefined || failure instanceof Error) {
    const reason =
      errorMessage(signal.aborted ? signal.reason : (controllerReason ?? failure))?.toLowerCase() ??
      "";
    if (
      reason.includes("timeout") ||
      reason.includes("timed_out") ||
      reason.includes("max_turns")
    ) {
      return "timed_out";
    }
    if (reason.includes("cancel")) return "cancelled";
    if (reason.includes("shutdown") || reason.includes("interrupt")) return "interrupted";
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

function fetchWithEnvironment(
  request: Request,
  environment: Readonly<Record<string, string>>,
): Promise<Response> {
  // Node's built-in fetch does not consume proxy variables. The client is
  // loopback-scoped, so enforce the explicit NO_PROXY contract here rather than
  // mutating process.env; a proxy-aware fetch can replace this wrapper later.
  const hostname = new URL(request.url).hostname;
  const noProxy = environment.NO_PROXY ?? environment.no_proxy ?? "";
  if (!noProxy.split(",").some((entry) => matchesNoProxy(hostname, entry.trim()))) {
    return Promise.reject(
      new Error(`OpenCode client URL ${hostname} is absent from explicit NO_PROXY configuration`),
    );
  }
  return globalThis.fetch(request);
}

function matchesNoProxy(hostname: string, entry: string): boolean {
  if (!entry) return false;
  if (entry === "*") return true;
  const normalized = entry.toLowerCase();
  const value = hostname.toLowerCase();
  return normalized.startsWith(".")
    ? value.endsWith(normalized)
    : value === normalized || value.endsWith(`.${normalized}`);
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

function boundedString(value: unknown, fallback: string, maxLength = 128): string {
  const text = stringValue(value, fallback);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function providerErrorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  const error = record(value);
  const data = record(error.data);
  return stringValue(data.message ?? error.message, "OpenCode session error");
}

function errorMessage(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return undefined;
}

function toError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error(errorMessage(value) ?? "OpenCode cleanup failed");
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`OpenCode ${name} must be a positive safe integer`);
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error
    ? reason
    : new Error(typeof reason === "string" ? reason : "OpenCode runtime aborted");
}

export type { ProxyEnvironment };
