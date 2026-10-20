import type { Event as OpenCodeEvent } from "@opencode-ai/sdk";

import {
  type createEventFactory,
  type RehorEvent,
  type RuntimeTerminalState,
  TOKEN_CLASSES,
  type TokenCounts,
} from "../../domain";
import type { UsageCost } from "../../domain/usage";
import {
  asObject,
  type JsonRecord,
  numberValue,
  record,
  redactSensitiveText,
  stringValue,
} from "../shared";
import { usageCost } from "./pricing";

export interface NormalizedEvents {
  events: RehorEvent[];
  outcome?: RuntimeTerminalState;
  reason?: string;
  resultText?: string;
  turns: number;
}

interface NormalizeOptions {
  suppressModel?: boolean;
  /** Refresh reconciled assistant/step usage without replaying lifecycle events. */
  usageOnly?: boolean;
}

interface UsageSnapshot {
  requestedModel: string;
  bucketModel: string;
  tokenCounts: Required<TokenCounts>;
  completed: boolean;
  returnedModel?: string;
  cost?: UsageCost;
  steps: Map<string, JsonRecord>;
  summary: string;
  hasTokens: boolean;
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
  pendingSteps: Map<string, Map<string, JsonRecord>>;
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
    pendingSteps: new Map(),
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
    const key = `${info.sessionID}:${messageId}`;
    context.seenMessages.add(key);
    if (typeof info.role === "string") context.messageRoles.set(key, info.role);
    if (asObject(info.time)?.completed) context.completedMessages.add(key);
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
      context.messageRoles.get(`${part.sessionID}:${messageId}`) === "assistant"
    ) {
      context.seenParts.add(partKey(part));
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
      const messageKey = `${withSession.runtimeSessionRef}:${messageId}`;
      let modelEvent: RehorEvent | undefined;
      if (!options.suppressModel && !options.usageOnly) {
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
        if (messageId && !context.modelEventIds.has(messageKey)) {
          context.modelEventIds.set(messageKey, modelEvent.eventId);
        }
      }
      const completed = Boolean(asObject(info.time)?.completed);
      const turns =
        !options.usageOnly &&
        eventSessionId(event) === context.rootSessionId &&
        completed &&
        messageId &&
        !context.countedMessages.has(messageKey)
          ? 1
          : 0;
      if (!options.usageOnly && completed && messageId) context.countedMessages.add(messageKey);
      const parentEventId = messageId
        ? (context.modelEventIds.get(messageKey) ?? modelEvent?.eventId)
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
          ...(error && !options.usageOnly
            ? [factory("error", { message: error }, withSession)]
            : []),
        ],
        turns,
      };
    }
    case "message.part.updated": {
      const part = record(properties.part);
      const partId = stringValue(part.id, "unknown-part");
      const messageId = stringValue(part.messageID, "unknown-message");
      if (part.type === "step-finish") {
        const key = `${withSession.runtimeSessionRef}:${messageId}`;
        const snapshot = context.usageSnapshots.get(key);
        const steps = snapshot?.steps ?? context.pendingSteps.get(key) ?? new Map();
        steps.set(partId, part);
        if (!snapshot) context.pendingSteps.set(key, steps);
        const stepEvent = options.usageOnly
          ? undefined
          : factory("run", { state: "step_finished", reason: part.reason }, withSession);
        const usage = snapshot ? snapshotUsage(snapshot, factory, withSession, context) : undefined;
        return {
          events: [...(stepEvent ? [stepEvent] : []), ...(usage ? [usage] : [])],
          turns: 0,
        };
      }
      if (
        context.messageRoles.get(`${withSession.runtimeSessionRef}:${messageId}`) !== "assistant"
      ) {
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
  const messageId = stringValue(info.id, "unknown-message");
  const key = `${overrides.runtimeSessionRef}:${messageId}`;
  const summary = JSON.stringify([
    info.tokens,
    info.cost,
    info.modelID,
    info.providerID,
    asObject(info.time)?.completed,
  ]);
  if (context.usageSnapshots.get(key)?.summary === summary) return undefined;
  const returnedModel = typeof info.modelID === "string" ? info.modelID : undefined;
  const bucketModel =
    qualifiedModel(info) ??
    (returnedModel
      ? `${context.requestedModel.split("/")[0]}/${returnedModel}`
      : context.requestedModel);
  const requestedModel =
    overrides.runtimeSessionRef === context.rootSessionId
      ? context.requestedModel
      : (qualifiedModel(info) ?? context.requestedModel);
  const snapshot: UsageSnapshot = {
    requestedModel,
    bucketModel,
    tokenCounts: nativeTokens(tokens),
    completed: Boolean(asObject(info.time)?.completed),
    ...(returnedModel ? { returnedModel } : {}),
    cost: usageCost(bucketModel, nativeTokens(tokens), info.cost),
    steps: context.usageSnapshots.get(key)?.steps ?? context.pendingSteps.get(key) ?? new Map(),
    summary,
    hasTokens: validTokens(tokens),
  };
  context.usageSnapshots.set(key, snapshot);
  context.pendingSteps.delete(key);
  if (!tokens && !snapshot.steps.size) return undefined;
  return snapshotUsage(snapshot, factory, overrides, context);
}

function nativeTokens(value: unknown): Required<TokenCounts> {
  const tokens = record(value);
  const cache = record(tokens.cache);
  return {
    input: nonNegativeInteger(tokens.input),
    output: nonNegativeInteger(tokens.output),
    reasoning: nonNegativeInteger(tokens.reasoning),
    cacheRead: nonNegativeInteger(cache.read),
    cacheWrite: nonNegativeInteger(cache.write),
  };
}

function validTokens(value: unknown): boolean {
  const tokens = record(value);
  const cache = record(tokens.cache);
  return [tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write].every(
    (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
  );
}

function snapshotUsage(
  snapshot: UsageSnapshot,
  factory: ReturnType<typeof createEventFactory>,
  overrides: { runtimeSessionRef: string; parentEventId?: string },
  context: NormalizationContext,
): RehorEvent {
  const tokenCounts: Required<TokenCounts> = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let cost = 0;
  let hasCost = false;
  let unknown = false;
  let estimated = false;
  let pricing: string | undefined;
  let final = true;
  for (const current of context.usageSnapshots.values()) {
    if (current.bucketModel !== snapshot.bucketModel) continue;
    final &&= current.completed;
    // Steps replace the assistant summary, whose tokens are only the last step
    // while its cost is cumulative. Repeated SSE/reconciliation records replace by ID.
    const entries = current.steps.size
      ? [...current.steps.values()].map((part, index) => {
          const counts = nativeTokens(part.tokens);
          // Native assistant cost is cumulative even when interrupted. Keep its
          // provider adjustments once; completion only controls completeness.
          const cost =
            current.cost?.source === "provider"
              ? { ...current.cost, amount: index === 0 ? current.cost.amount : 0 }
              : usageCost(current.bucketModel, counts, part.cost);
          unknown ||= !validTokens(part.tokens);
          return { counts, cost };
        })
      : [{ counts: current.tokenCounts, cost: current.cost }];
    if (!current.steps.size) {
      unknown ||= !current.hasTokens || current.cost?.source !== "provider";
    }
    for (const entry of entries) {
      for (const key of TOKEN_CLASSES) tokenCounts[key] += entry.counts[key];
      if (entry.cost) {
        cost += entry.cost.amount;
        hasCost = true;
        estimated ||= entry.cost.source === "estimated";
        pricing ??= entry.cost.pricing;
      } else {
        unknown = true;
      }
    }
  }

  return factory(
    "usage",
    {
      requestedModel: snapshot.requestedModel,
      modelKey: snapshot.bucketModel,
      ...(snapshot.returnedModel ? { returnedModel: snapshot.returnedModel } : {}),
      tokenCounts,
      partial: !final,
      final,
      estimated,
      incomplete: !final || unknown,
      ...(hasCost
        ? {
            cost: {
              amount: cost,
              currency: "USD",
              source: estimated ? "estimated" : "provider",
              ...(pricing ? { pricing } : {}),
            },
          }
        : {}),
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
      !context.seenMessages.has(`${info.sessionID}:${info.id}`)
    );
  }
  if (event.type === "message.part.updated") {
    const part = record(event.properties.part);
    return part.sessionID === context.rootSessionId && part.type === "step-start";
  }
  return false;
}

export function partKey(part: JsonRecord): string {
  return `${stringValue(part.sessionID, "unknown-session")}:${stringValue(part.messageID, "unknown-message")}:${stringValue(part.id, "unknown-part")}`;
}
