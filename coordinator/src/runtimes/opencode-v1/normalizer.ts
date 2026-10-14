import type { Event as OpenCodeEvent } from "@opencode-ai/sdk";

import {
  type createEventFactory,
  type RehorEvent,
  type RuntimeTerminalState,
  TOKEN_CLASSES,
  type TokenCounts,
} from "../../domain";
import {
  asObject,
  type JsonRecord,
  numberValue,
  record,
  redactSensitiveText,
  stringValue,
} from "../shared";

export interface NormalizedEvents {
  events: RehorEvent[];
  outcome?: RuntimeTerminalState;
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
  tokenCounts: Required<TokenCounts>;
  completed: boolean;
  returnedModel?: string;
  cost?: number;
}

export interface NormalizationContext {
  rootSessionId: string;
  requestedModel: string;
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

export function createNormalizationContext(
  rootSessionId: string,
  requestedModel: string,
): NormalizationContext {
  return {
    rootSessionId,
    requestedModel,
    resultTextParts: new Map(),
    messageRoles: new Map(),
    countedMessages: new Set(),
    completedMessages: new Set(),
    seenMessages: new Set(),
    seenParts: new Set(),
    sessionIds: new Set([rootSessionId]),
    toolPhases: new Map(),
    modelEventIds: new Map(),
    usageSnapshots: new Map(),
  };
}

export function foldOpenCodeEvent(event: OpenCodeEvent, context: NormalizationContext): void {
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
    if (asObject(info.time)?.completed) context.completedMessages.add(messageId);
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

export function normalizeOpenCodeEvent(
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
        ...(isRoot && status.type === "idle" ? rootIdleOutcome(context) : {}),
        turns: 0,
      };
    }
    case "session.idle": {
      const isRoot = properties.sessionID === context.rootSessionId;
      return {
        events: [factory("run", { state: "idle" }, withSession)],
        ...(isRoot ? rootIdleOutcome(context) : {}),
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
      const completed = Boolean(asObject(info.time)?.completed);
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
        const input = asObject(state.input);
        const finished = state.status === "completed" || state.status === "error";
        const start = numberValue(asObject(state.time)?.start);
        const end = numberValue(asObject(state.time)?.end);
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
  const tokens = asObject(info.tokens);
  if (!tokens) return undefined;
  const cache = asObject(tokens.cache);
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
    completed: Boolean(asObject(info.time)?.completed),
    ...(returnedModel ? { returnedModel } : {}),
    ...(typeof info.cost === "number" && Number.isFinite(info.cost) ? { cost: info.cost } : {}),
  };
  context.usageSnapshots.set(`${overrides.runtimeSessionRef}:${messageId}`, snapshot);

  const tokenCounts: Required<TokenCounts> = {
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
    for (const key of TOKEN_CLASSES) tokenCounts[key] += current.tokenCounts[key];
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

export function resultText(context: NormalizationContext): string | undefined {
  return context.resultTextParts.size > 0
    ? [...context.resultTextParts.values()].join("")
    : undefined;
}

export function unwrapSdkResponse(value: unknown, operation: string): unknown {
  const response = asObject(value);
  if (response?.error !== undefined) {
    throw new Error(`${operation} failed: ${providerErrorMessage(response.error)}`);
  }
  return response && "data" in response ? response.data : value;
}

export function providerErrorMessage(value: unknown): string {
  if (typeof value === "string") return redactSensitiveText(value);
  const error = record(value);
  const data = record(error.data);
  return redactSensitiveText(stringValue(data.message ?? error.message, "OpenCode session error"));
}

function rootIdleOutcome(
  context: NormalizationContext,
): { outcome: "failed"; reason: string } | { outcome: "completed" } {
  const reason = context.rootSessionError ?? context.rootAssistantError;
  return reason ? { outcome: "failed", reason } : { outcome: "completed" };
}

function qualifiedModel(info: Record<string, unknown>): string | undefined {
  if (typeof info.providerID !== "string" || typeof info.modelID !== "string") return undefined;
  return `${info.providerID}/${info.modelID}`;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function isSessionEvent(event: OpenCodeEvent, context: NormalizationContext): boolean {
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

export function eventSessionId(event: OpenCodeEvent): string | undefined {
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

export function beginsNewTurn(event: OpenCodeEvent, context: NormalizationContext): boolean {
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

export function partKey(part: JsonRecord): string {
  return `${stringValue(part.sessionID, "unknown-session")}:${stringValue(part.id, "unknown-part")}`;
}
