import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client";
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
  record,
  redactSensitiveText,
  stableJson,
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
  usageOnly?: boolean;
  streamed?: boolean;
}

interface UsageSnapshot {
  sessionID: string;
  messageID: string;
  requestedModel: string;
  bucketModel: string;
  returnedModel?: string;
  tokenCounts: Required<TokenCounts>;
  completed: boolean;
  valid: boolean;
  cost?: UsageCost;
}

interface CodeModeState {
  native: Map<number, JsonRecord>;
  bridge: Map<string, JsonRecord>;
  nativeIds: Map<number, string>;
  bridgeIds: Map<string, string>;
}

interface NestedToolOptions {
  parentEventId?: string;
  workContextAvailable: boolean;
  nativeOrdinal?: number;
  bridgeId?: string;
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
  retiredBuckets: Map<string, UsageSnapshot>;
  messages: Map<string, JsonRecord>;
  sessionParents: Map<string, string>;
  seenEvents: Set<string>;
  partSnapshots: Map<string, string>;
  tools: Map<string, JsonRecord>;
  toolEventIds: Map<string, string>;
  codeMode: Map<string, CodeModeState>;
  recoveryIncomplete: boolean;
  activeCompactions: Map<string, string>;
  unmatchedCompactions: Set<string>;
  rootAssistantError?: string;
  rootSessionError?: string;
  rootExecutionOutcome?: RuntimeTerminalState;
  rootExecutionReason?: string;
  rootExecutionStartedAt?: number;
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
    retiredBuckets: new Map(),
    messages: new Map(),
    sessionParents: new Map(),
    seenEvents: new Set(),
    partSnapshots: new Map(),
    tools: new Map(),
    toolEventIds: new Map(),
    codeMode: new Map(),
    recoveryIncomplete: false,
    activeCompactions: new Map(),
    unmatchedCompactions: new Set(),
  };
}

/** Retain parent edges even when creation events arrive out of order. */
function trackSession(data: JsonRecord, context: NormalizationContext): void {
  if (typeof data.sessionID === "string" && typeof data.parentID === "string") {
    context.sessionParents.set(data.sessionID, data.parentID);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, parent] of context.sessionParents) {
      if (context.sessionIds.has(parent) && !context.sessionIds.has(id)) {
        context.sessionIds.add(id);
        changed = true;
      }
    }
  }
}

export function foldOpenCodeEvent(event: OpenCodeEvent, context: NormalizationContext): void {
  const data = record(event.data);
  if (event.type === "session.created") trackSession(data, context);
  const sessionID = eventSessionId(event);
  if (!sessionID || !context.sessionIds.has(sessionID)) return;
  if (event.type === "session.step.started") {
    const id = stringValue(data.assistantMessageID, "");
    if (!id) return;
    const key = `${sessionID}:${id}`;
    context.seenMessages.add(key);
    context.messageRoles.set(key, "assistant");
    context.messages.set(key, {
      ...context.messages.get(key),
      id,
      type: "assistant",
      model: data.model,
      content: context.messages.get(key)?.content ?? [],
      error: undefined,
      finish: undefined,
      rawFinish: undefined,
      native: undefined,
      time: { created: data.started },
    });
    context.completedMessages.delete(key);
    if (sessionID === context.rootSessionId) {
      context.rootAssistantError = undefined;
      context.rootSessionError = undefined;
      context.rootExecutionOutcome = undefined;
      context.rootExecutionReason = undefined;
      context.rootExecutionStartedAt =
        typeof data.started === "number"
          ? Math.max(context.rootExecutionStartedAt ?? 0, data.started)
          : context.rootExecutionStartedAt;
    }
  }
}

export function normalizeOpenCodeEvent(
  event: OpenCodeEvent,
  factory: ReturnType<typeof createEventFactory>,
  context: NormalizationContext,
  options: NormalizeOptions = {},
): NormalizedEvents {
  const empty: NormalizedEvents = { events: [], turns: 0 };
  if (!isSessionEvent(event, context)) return empty;
  if (context.seenEvents.has(event.id)) return empty;
  context.seenEvents.add(event.id);
  foldOpenCodeEvent(event, context);
  const data = record(event.data);
  const sessionID = eventSessionId(event) ?? context.rootSessionId;
  const withSession = { runtimeSessionRef: sessionID };
  const root = sessionID === context.rootSessionId;
  const messageID = stringValue(data.assistantMessageID, "");
  const messageKey = `${sessionID}:${messageID}`;
  switch (event.type) {
    case "session.created":
      return root
        ? empty
        : { events: [factory("run", { state: "child_session_started" }, withSession)], turns: 0 };
    case "session.execution.started":
      if (root) {
        context.rootExecutionOutcome = undefined;
        context.rootExecutionReason = undefined;
        context.rootSessionError = undefined;
        context.rootAssistantError = undefined;
        context.rootExecutionStartedAt = event.created;
      }
      return { events: [factory("run", { state: "running" }, withSession)], turns: 0 };
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted": {
      const outcome = event.type === "session.execution.succeeded" ? "completed" : "failed";
      const reason =
        event.type === "session.execution.failed"
          ? providerErrorMessage(data.error)
          : event.type === "session.execution.interrupted"
            ? `OpenCode execution interrupted: ${data.reason}`
            : undefined;
      if (root) {
        context.rootExecutionOutcome = outcome;
        context.rootExecutionReason = reason;
        context.rootSessionError = outcome === "failed" ? reason : undefined;
      }
      return {
        events: [
          factory("run", { state: event.type }, withSession),
          ...(outcome === "failed" ? [factory("error", { message: reason }, withSession)] : []),
        ],
        ...(root ? { outcome, ...(reason ? { reason } : {}) } : {}),
        turns: 0,
      };
    }
    case "session.status":
    case "session.idle": {
      const status = record(data.status);
      const idle = event.type === "session.idle" || status.type === "idle";
      return {
        events: [
          factory("run", { state: event.type === "session.idle" ? "idle" : status }, withSession),
        ],
        ...(root && idle ? rootIdleOutcome(context) : {}),
        turns: 0,
      };
    }
    case "session.step.started": {
      const model = record(data.model);
      const modelEvent = factory(
        "model",
        { phase: "updated", messageId: messageID },
        {
          ...withSession,
          ...(typeof model.id === "string" ? { model: model.id } : {}),
        },
      );
      if (!context.modelEventIds.has(messageKey))
        context.modelEventIds.set(messageKey, modelEvent.eventId);
      const started = factory("run", { state: "step_started" }, withSession);
      // Cancellation/crash can skip recovery and never deliver a step terminal.
      // Publish the pending assistant now so cumulative usage retains its known
      // subtotal while becoming partial until this message's usage is settled.
      const pending = normalizeOpenCodeMessage(
        context.messages.get(messageKey) as unknown as SessionMessageInfo,
        sessionID,
        factory,
        context,
        { ...options, usageOnly: true },
      );
      return {
        events: [modelEvent, started, ...pending.events],
        turns: 0,
      };
    }
    case "session.step.ended":
    case "session.step.failed": {
      const previous = context.messages.get(messageKey) ?? { id: messageID, type: "assistant" };
      const message = {
        ...previous,
        ...data,
        id: messageID,
        type: "assistant",
        time: { ...record(previous.time), completed: event.created },
      };
      const stepEvent = !options.usageOnly
        ? factory(
            "run",
            {
              state: event.type === "session.step.failed" ? "step_failed" : "step_finished",
              reason: data.finish,
            },
            withSession,
          )
        : undefined;
      const normalized = normalizeOpenCodeMessage(
        message as unknown as SessionMessageInfo,
        sessionID,
        factory,
        context,
        options,
      );
      if (stepEvent) normalized.events.unshift(stepEvent);
      return normalized;
    }
    case "session.compaction.started":
    case "session.compaction.ended":
    case "session.compaction.failed": {
      const running = event.type === "session.compaction.started";
      const knownId = context.activeCompactions.get(sessionID);
      const id = running
        ? stringValue(data.inputID, event.id.replace(/^evt_/, "msg_"))
        : (knownId ?? stringValue(data.inputID, event.id.replace(/^evt_/, "msg_")));
      const key = `${sessionID}:${id}`;
      const normalized = normalizeOpenCodeMessage(
        {
          ...context.messages.get(key),
          ...data,
          id,
          type: "compaction",
          status: running
            ? "running"
            : event.type === "session.compaction.failed"
              ? "failed"
              : "completed",
          time:
            record(context.messages.get(key)?.time).created === undefined
              ? { created: event.created }
              : context.messages.get(key)?.time,
        } as unknown as SessionMessageInfo,
        sessionID,
        factory,
        context,
        { ...options, streamed: true },
      );
      if (!running && !knownId) context.unmatchedCompactions.add(key);
      return normalized;
    }
    case "session.text.started":
    case "session.text.delta":
    case "session.text.ended":
    case "session.reasoning.started":
    case "session.reasoning.delta":
    case "session.reasoning.ended": {
      const phase = event.type.startsWith("session.text.") ? "text" : "reasoning";
      const partId = `${sessionID}:${messageID}:${phase}:${data.ordinal}`;
      const previous = context.partSnapshots.get(partId) ?? "";
      const text =
        typeof data.text === "string" ? data.text : previous + stringValue(data.delta, "");
      return normalizeText(partId, text, phase, sessionID, factory, context, data.delta);
    }
    case "session.tool.input.started":
    case "session.tool.input.ended":
    case "session.tool.called":
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed": {
      const key = `${messageKey}:${data.id}`;
      const previous = context.tools.get(key) ?? {
        id: data.id,
        name: data.name,
        time: { created: event.created },
      };
      const oldState = record(previous.state);
      const finished =
        event.type === "session.tool.success" || event.type === "session.tool.failed";
      const state = {
        ...oldState,
        status: finished
          ? event.type === "session.tool.failed"
            ? "error"
            : "completed"
          : "running",
        ...(data.input ? { input: data.input } : {}),
        ...(data.content ? { content: data.content } : {}),
        ...(data.error ? { error: data.error } : {}),
        ...(asObject(data.metadata)
          ? { metadata: { ...record(oldState.metadata), ...record(data.metadata) } }
          : {}),
      };
      const tool = {
        ...previous,
        type: "tool",
        state,
        time: {
          ...record(previous.time),
          ...(finished
            ? { completed: event.created }
            : event.type === "session.tool.called"
              ? { ran: event.created }
              : {}),
        },
      };
      return normalizeTool(tool, sessionID, messageID, factory, context);
    }
    case "permission.asked": {
      const reason = "OpenCode permission request cannot be handled in headless mode";
      return {
        events: [
          factory("policy", { state: "permission_requested", ...data }, withSession),
          factory("error", { message: reason }, withSession),
        ],
        ...(root ? { outcome: "failed" as const, reason } : {}),
        turns: 0,
      };
    }
    default:
      return empty;
  }
}

/** Consume V2's persisted message projection, not synthetic V1 events. */
export function normalizeOpenCodeMessage(
  value: SessionMessageInfo,
  sessionID: string,
  factory: ReturnType<typeof createEventFactory>,
  context: NormalizationContext,
  options: NormalizeOptions = {},
): NormalizedEvents {
  const message = record(value);
  const assistant = message.type === "assistant";
  if ((!assistant && message.type !== "compaction") || typeof message.id !== "string")
    return { events: [], turns: 0 };
  const key = `${sessionID}:${message.id}`;
  if (!assistant) {
    context.unmatchedCompactions.delete(key);
    // Compaction terminal events omit the projected message ID. If start was
    // missed, match their authoritative projection once, then use its real ID.
    if (!options.streamed && !context.messages.has(key)) {
      const fields = ["status", "reason", "cost"];
      for (const candidate of context.unmatchedCompactions) {
        const previous = context.messages.get(candidate);
        const snapshot = context.usageSnapshots.get(candidate);
        if (
          snapshot?.sessionID !== sessionID ||
          !fields.every((field) => previous?.[field] === message[field]) ||
          record(previous?.model).providerID !== record(message.model).providerID ||
          record(previous?.model).id !== record(message.model).id ||
          JSON.stringify(snapshot.tokenCounts) !== JSON.stringify(nativeTokens(message.tokens)) ||
          validTokens(previous?.tokens) !== validTokens(message.tokens) ||
          providerErrorMessage(previous?.error) !== providerErrorMessage(message.error)
        )
          continue;
        context.messages.delete(candidate);
        context.usageSnapshots.delete(candidate);
        const parent = context.modelEventIds.get(candidate);
        if (parent) context.modelEventIds.set(key, parent);
        context.modelEventIds.delete(candidate);
        context.unmatchedCompactions.delete(candidate);
        break;
      }
    }
    if (message.status === "running") context.activeCompactions.set(sessionID, message.id);
    else if (context.activeCompactions.get(sessionID) === message.id)
      context.activeCompactions.delete(sessionID);
  }
  const previous = context.messages.get(key);
  context.messages.set(key, message);
  context.messageRoles.set(key, assistant ? "assistant" : "compaction");
  context.seenMessages.add(key);
  const completed = assistant
    ? typeof record(message.time).completed === "number"
    : message.status === "completed" || message.status === "failed";
  if (completed) context.completedMessages.add(key);
  const error = message.error ? providerErrorMessage(message.error) : undefined;
  if (assistant && sessionID === context.rootSessionId) context.rootAssistantError = error;
  const model = record(message.model);
  const returnedModel = typeof model.id === "string" ? model.id : undefined;
  const bucketModel =
    typeof model.providerID === "string" && returnedModel
      ? `${model.providerID}/${returnedModel}`
      : "unknown/unknown";
  const overrides = {
    runtimeSessionRef: sessionID,
    ...(returnedModel ? { model: returnedModel } : {}),
  };
  const events: RehorEvent[] = [];
  if (!options.usageOnly && !options.suppressModel && !context.modelEventIds.has(key)) {
    const event = factory(
      "model",
      {
        phase: "updated",
        messageId: message.id,
        ...(message.finish ? { finish: message.finish } : {}),
      },
      overrides,
    );
    context.modelEventIds.set(key, event.eventId);
    events.push(event);
  }
  const tokenCounts = nativeTokens(message.tokens);
  const snapshot: UsageSnapshot = {
    sessionID,
    messageID: message.id,
    requestedModel: sessionID === context.rootSessionId ? context.requestedModel : bucketModel,
    bucketModel,
    ...(returnedModel ? { returnedModel } : {}),
    tokenCounts,
    completed,
    valid: validTokens(message.tokens),
    cost: usageCost(
      bucketModel,
      message.tokens === undefined ? undefined : tokenCounts,
      message.cost,
    ),
  };
  // Step end and message projection describe the same usage. Replace by message ID.
  const previousSnapshot = context.usageSnapshots.get(key);
  const changed = JSON.stringify(previousSnapshot) !== JSON.stringify(snapshot);
  context.usageSnapshots.set(key, snapshot);
  // A projection may supply a model missed on the stream or correct an earlier
  // attribution. Withdraw that message from its old cumulative model bucket.
  if (changed) {
    context.retiredBuckets.delete(snapshot.bucketModel);
    if (previousSnapshot && previousSnapshot.bucketModel !== snapshot.bucketModel) {
      const populated = [...context.usageSnapshots.values()].some(
        (current) => current.bucketModel === previousSnapshot.bucketModel,
      );
      if (!populated) context.retiredBuckets.set(previousSnapshot.bucketModel, previousSnapshot);
      else
        events.push(
          snapshotUsage(
            previousSnapshot,
            factory,
            sessionID,
            context,
            context.modelEventIds.get(key),
          ),
        );
    }
    // Refresh withdrawn buckets too: a neutral zero must not turn an unknown-only
    // run into an estimated run, or leave a stale unknown after pricing recovers.
    for (const retired of context.retiredBuckets.values())
      events.push(
        snapshotUsage(
          retired,
          factory,
          retired.sessionID,
          context,
          context.modelEventIds.get(`${retired.sessionID}:${retired.messageID}`),
        ),
      );
    events.push(
      snapshotUsage(snapshot, factory, sessionID, context, context.modelEventIds.get(key)),
    );
  }
  if (
    error &&
    !options.usageOnly &&
    JSON.stringify(previous?.error) !== JSON.stringify(message.error)
  ) {
    events.push(factory("error", { message: error }, overrides));
  }
  if (assistant && !options.usageOnly)
    events.push(
      ...normalizeContent(message.content, sessionID, message.id, factory, context).events,
    );
  const turns =
    assistant &&
    completed &&
    sessionID === context.rootSessionId &&
    !context.countedMessages.has(key)
      ? 1
      : 0;
  if (assistant && completed) context.countedMessages.add(key);
  const text = resultText(context);
  return { events, turns, ...(text === undefined ? {} : { resultText: text }) };
}

function normalizeContent(
  value: unknown,
  sessionID: string,
  messageID: string,
  factory: ReturnType<typeof createEventFactory>,
  context: NormalizationContext,
): NormalizedEvents {
  const events: RehorEvent[] = [];
  const ordinals = { text: 0, reasoning: 0 };
  for (const valuePart of Array.isArray(value) ? value : []) {
    const part = record(valuePart);
    if (part.type === "text" || part.type === "reasoning") {
      const phase = part.type;
      const id = `${sessionID}:${messageID}:${phase}:${ordinals[phase]++}`;
      events.push(
        ...normalizeText(id, stringValue(part.text, ""), phase, sessionID, factory, context).events,
      );
    } else if (part.type === "tool")
      events.push(...normalizeTool(part, sessionID, messageID, factory, context).events);
  }
  return { events, turns: 0 };
}

function normalizeText(
  partId: string,
  text: string,
  phase: "text" | "reasoning",
  sessionID: string,
  factory: ReturnType<typeof createEventFactory>,
  context: NormalizationContext,
  delta?: unknown,
): NormalizedEvents {
  if (context.partSnapshots.get(partId) === text) return { events: [], turns: 0 };
  context.partSnapshots.set(partId, text);
  context.seenParts.add(partId);
  if (phase === "text" && sessionID === context.rootSessionId)
    context.resultTextParts.set(partId, text);
  const result = resultText(context);
  return {
    events: [
      factory(
        "model",
        { phase, partId, text, ...(typeof delta === "string" ? { delta } : {}) },
        { runtimeSessionRef: sessionID },
      ),
    ],
    turns: 0,
    ...(result === undefined ? {} : { resultText: result }),
  };
}

function normalizeTool(
  part: JsonRecord,
  sessionID: string,
  messageID: string,
  factory: ReturnType<typeof createEventFactory>,
  context: NormalizationContext,
): NormalizedEvents {
  const key = `${sessionID}:${messageID}:${part.id}`;
  const metadata = record(record(part.state).metadata);
  const name = part.name ?? context.tools.get(key)?.name;
  const container =
    name === "execute" ||
    (name === undefined &&
      (Array.isArray(metadata.toolCalls) || asObject(metadata.rehorCodeMode) !== undefined));
  if (!container) return normalizeSingleTool(part, sessionID, messageID, factory, context);
  const outer = normalizeSingleTool(
    { ...part, name: "execute" },
    sessionID,
    messageID,
    factory,
    context,
  );
  outer.events.push(...normalizeCodeMode(part, sessionID, messageID, factory, context));
  return outer;
}

function normalizeSingleTool(
  part: JsonRecord,
  sessionID: string,
  messageID: string,
  factory: ReturnType<typeof createEventFactory>,
  context: NormalizationContext,
  nested?: NestedToolOptions,
): NormalizedEvents {
  const key = `${sessionID}:${messageID}:${part.id}`;
  const state = record(part.state);
  const old = context.tools.get(key);
  const finished = state.status === "completed" || state.status === "error";
  if (context.toolPhases.get(key) === "completed" && !finished) return { events: [], turns: 0 };
  context.tools.set(key, part);
  const phase = finished ? "completed" : "started";
  const name = stringValue(part.name ?? old?.name, "unknown");
  const container = !nested && name === "execute";
  const isError = state.status === "error" || (container && record(state.metadata).error === true);
  const signature = stableJson([
    phase,
    state.input,
    state.content,
    state.error,
    isError,
    nested?.workContextAvailable,
  ]);
  if (context.partSnapshots.get(key) === signature) return { events: [], turns: 0 };
  context.partSnapshots.set(key, signature);
  context.toolPhases.set(key, phase);
  context.seenParts.add(key);
  const time = record(part.time);
  const start = time.ran ?? time.created;
  const end = time.completed;
  const content = nested
    ? state.content
    : Array.isArray(state.content)
      ? state.content
          .map((value) => {
            const item = record(value);
            return item.type === "text" ? stringValue(item.text, "") : stringValue(item.uri, "");
          })
          .join("\n")
      : undefined;
  const event = factory(
    "tool",
    {
      partId: key,
      toolUseId: part.id,
      state: phase,
      name,
      toolName: name,
      ...(container ? { budgetUnit: "container", workContextAvailable: false } : {}),
      ...(nested
        ? {
            codeMode: true,
            workContextAvailable: nested.workContextAvailable,
            resultUnavailable: state.content === undefined,
            ...(state.error === undefined ? {} : { error: state.error }),
            ...(nested.nativeOrdinal === undefined ? {} : { nativeOrdinal: nested.nativeOrdinal }),
            ...(nested.bridgeId ? { bridgeId: nested.bridgeId } : {}),
          }
        : {}),
      ...((nested ? state.input !== undefined : asObject(state.input))
        ? { input: state.input }
        : {}),
      ...(typeof start === "number" && typeof end === "number"
        ? { durationMs: Math.max(0, end - start) }
        : {}),
      ...(isError ? { isError: true } : {}),
      ...(content !== undefined
        ? { content }
        : state.error
          ? { content: providerErrorMessage(state.error) }
          : {}),
    },
    {
      runtimeSessionRef: sessionID,
      ...(nested
        ? {
            parentEventId:
              phase === "completed"
                ? (context.toolEventIds.get(key) ?? nested.parentEventId)
                : nested.parentEventId,
          }
        : {}),
    },
  );
  if (!context.toolEventIds.has(key)) context.toolEventIds.set(key, event.eventId);
  return { events: [event], turns: 0 };
}

/** Native rows carry identity/status, while the bridge preserves unfiltered results. */
function normalizeCodeMode(
  part: JsonRecord,
  sessionID: string,
  messageID: string,
  factory: ReturnType<typeof createEventFactory>,
  context: NormalizationContext,
): RehorEvent[] {
  const outer = `${sessionID}:${messageID}:${part.id}`;
  const metadata = record(record(part.state).metadata);
  let state = context.codeMode.get(outer);
  if (!state) {
    state = { native: new Map(), bridge: new Map(), nativeIds: new Map(), bridgeIds: new Map() };
    context.codeMode.set(outer, state);
  }
  const retain = (previous: JsonRecord | undefined, next: JsonRecord): JsonRecord =>
    previous && previous.status !== "running" && next.status === "running" ? previous : next;
  const valid = (row: JsonRecord) => ["running", "completed", "error"].includes(String(row.status));
  if (Array.isArray(metadata.toolCalls))
    metadata.toolCalls.forEach((value, index) => {
      const row = record(value);
      if (typeof row.tool === "string" && valid(row))
        state.native.set(index, retain(state.native.get(index), row));
    });
  const calls = record(metadata.rehorCodeMode).calls;
  if (Array.isArray(calls))
    for (const value of calls) {
      const row = record(value);
      if (typeof row.id === "string" && typeof row.name === "string" && valid(row))
        state.bridge.set(row.id, retain(state.bridge.get(row.id), row));
    }
  const canonicalName = (name: unknown) =>
    stringValue(name, "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  // Native displayInput wraps non-record arguments and omits empty/null input.
  const identity = (name: unknown, input: unknown) =>
    stableJson([
      canonicalName(name),
      input === undefined || input === null ? {} : (asObject(input) ?? { input }),
    ]);
  // The bridge's ordinal is independent of native fetch rows. Match repeated
  // equal calls by allocation order, not completion order or input key order.
  const bridge = [...state.bridge.values()].sort((a, b) => {
    const ordinal = (row: JsonRecord) => Number(String(row.id).match(/:nested:(\d+)$/)?.[1] ?? 0);
    return ordinal(a) - ordinal(b);
  });
  const used = new Set<string>();
  const events: RehorEvent[] = [];
  const emit = (id: string, row: JsonRecord, nativeOrdinal?: number, bridgeId?: string) => {
    const nested: NestedToolOptions = {
      parentEventId: context.toolEventIds.get(outer),
      workContextAvailable: bridgeId !== undefined,
      ...(nativeOrdinal === undefined ? {} : { nativeOrdinal }),
      ...(bridgeId ? { bridgeId } : {}),
    };
    const tool = {
      id,
      name: row.name,
      type: "tool",
      state: {
        status:
          row.status === "running" ? "running" : row.status === "error" ? "error" : "completed",
        ...(row.input === undefined ? {} : { input: row.input }),
        ...(row.content === undefined ? {} : { content: row.content }),
        ...(row.error === undefined ? {} : { error: row.error }),
      },
    };
    const key = `${sessionID}:${messageID}:${id}`;
    if (!context.toolEventIds.has(key) && row.status !== "running")
      events.push(
        ...normalizeSingleTool(
          {
            ...tool,
            state: { ...tool.state, status: "running", content: undefined, error: undefined },
          },
          sessionID,
          messageID,
          factory,
          context,
          nested,
        ).events,
      );
    events.push(
      ...normalizeSingleTool(tool, sessionID, messageID, factory, context, nested).events,
    );
  };
  for (const [index, row] of [...state.native].sort(([a], [b]) => a - b)) {
    const match = bridge.find(
      (candidate) =>
        !used.has(String(candidate.id)) &&
        identity(candidate.name, candidate.input) === identity(row.tool, row.input),
    );
    const bridgeId = match ? String(match.id) : undefined;
    const id =
      state.nativeIds.get(index) ??
      (bridgeId ? state.bridgeIds.get(bridgeId) : undefined) ??
      `${outer}:codemode:${index}`;
    state.nativeIds.set(index, id);
    if (bridgeId) {
      used.add(bridgeId);
      state.bridgeIds.set(bridgeId, id);
    }
    emit(id, match ?? { ...row, name: canonicalName(row.tool) }, index, bridgeId);
  }
  for (const row of bridge) {
    const bridgeId = String(row.id);
    if (used.has(bridgeId)) continue;
    const id = state.bridgeIds.get(bridgeId) ?? `${outer}:bridge:${bridgeId}`;
    state.bridgeIds.set(bridgeId, id);
    emit(id, row, undefined, bridgeId);
  }
  return events;
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
  sessionID: string,
  context: NormalizationContext,
  parentEventId?: string,
): RehorEvent {
  const tokenCounts = nativeTokens(undefined);
  let amount = 0;
  let hasCost = false;
  let unknown = context.recoveryIncomplete;
  let final = true;
  let pricing: string | undefined;
  let populated = false;
  for (const current of context.usageSnapshots.values()) {
    if (current.bucketModel !== snapshot.bucketModel) continue;
    populated = true;
    final &&= current.completed;
    unknown ||= !current.valid || !current.cost;
    for (const key of TOKEN_CLASSES) tokenCounts[key] += current.tokenCounts[key];
    if (current.cost) {
      amount += current.cost.amount;
      hasCost = true;
      pricing ??= current.cost.pricing;
    }
  }
  // Empty buckets are exact zero after reattribution, including formerly unknown
  // buckets. Consumers replace cumulative snapshots rather than removing keys.
  if (!populated)
    hasCost = [...context.usageSnapshots.values()].some((current) => current.cost !== undefined);
  return factory(
    "usage",
    {
      requestedModel: snapshot.requestedModel,
      modelKey: snapshot.bucketModel,
      ...(snapshot.returnedModel ? { returnedModel: snapshot.returnedModel } : {}),
      tokenCounts,
      partial: !final,
      final,
      estimated: hasCost,
      incomplete: !final || unknown,
      ...(hasCost
        ? {
            cost: { amount, currency: "USD", source: "estimated", ...(pricing ? { pricing } : {}) },
          }
        : {}),
    },
    {
      runtimeSessionRef: sessionID,
      ...(parentEventId ? { parentEventId } : {}),
      ...(snapshot.returnedModel ? { model: snapshot.returnedModel } : {}),
    },
  );
}

/** Refresh cumulative buckets when recovery coverage changes without new messages. */
export function updateRecoveryCoverage(
  incomplete: boolean,
  factory: ReturnType<typeof createEventFactory>,
  context: NormalizationContext,
): RehorEvent[] {
  if (context.recoveryIncomplete === incomplete) return [];
  context.recoveryIncomplete = incomplete;
  const buckets = new Set<string>();
  const events: RehorEvent[] = [];
  for (const [key, snapshot] of context.usageSnapshots) {
    if (buckets.has(snapshot.bucketModel)) continue;
    buckets.add(snapshot.bucketModel);
    events.push(
      snapshotUsage(snapshot, factory, snapshot.sessionID, context, context.modelEventIds.get(key)),
    );
  }
  for (const snapshot of context.retiredBuckets.values())
    events.push(
      snapshotUsage(
        snapshot,
        factory,
        snapshot.sessionID,
        context,
        context.modelEventIds.get(`${snapshot.sessionID}:${snapshot.messageID}`),
      ),
    );
  return events;
}

export function resultText(context: NormalizationContext): string | undefined {
  return context.resultTextParts.size ? [...context.resultTextParts.values()].join("") : undefined;
}

export function unwrapSdkResponse(value: unknown, operation: string): unknown {
  const response = asObject(value);
  if (response?.error !== undefined)
    throw new Error(`${operation} failed: ${providerErrorMessage(response.error)}`);
  return response && "data" in response ? response.data : value;
}

export function providerErrorMessage(value: unknown): string {
  if (typeof value === "string") return redactSensitiveText(value);
  const error = record(value);
  return redactSensitiveText(
    stringValue(error.message ?? record(error.data).message, "OpenCode session error"),
  );
}

function rootIdleOutcome(context: NormalizationContext): Partial<NormalizedEvents> {
  if (context.rootExecutionOutcome)
    return {
      outcome: context.rootExecutionOutcome,
      ...(context.rootExecutionReason ? { reason: context.rootExecutionReason } : {}),
    };
  const reason = context.rootSessionError ?? context.rootAssistantError;
  return reason ? { outcome: "failed", reason } : {};
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function isSessionEvent(event: OpenCodeEvent, context: NormalizationContext): boolean {
  if (event.type === "session.created") trackSession(record(event.data), context);
  const id = eventSessionId(event);
  return id !== undefined && context.sessionIds.has(id);
}

export function eventSessionId(event: OpenCodeEvent): string | undefined {
  const id = record(event.data).sessionID;
  return typeof id === "string" ? id : undefined;
}

export function beginsNewTurn(event: OpenCodeEvent, context: NormalizationContext): boolean {
  return (
    event.type === "session.step.started" &&
    eventSessionId(event) === context.rootSessionId &&
    !context.seenEvents.has(event.id) &&
    !context.seenMessages.has(`${context.rootSessionId}:${event.data.assistantMessageID}`)
  );
}

export function partKey(part: JsonRecord): string {
  return `${stringValue(part.sessionID, "unknown-session")}:${stringValue(part.messageID ?? part.assistantMessageID, "unknown-message")}:${stringValue(part.id, "unknown-part")}`;
}
