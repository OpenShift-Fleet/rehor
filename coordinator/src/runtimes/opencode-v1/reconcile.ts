import type { Event as OpenCodeEvent, OpencodeClient } from "@opencode-ai/sdk";
import type { createEventFactory, RehorEvent, RuntimeTerminalState } from "../../domain";
import { asObject, boundedOperation, record, stringValue } from "../shared";
import {
  type NormalizationContext,
  type NormalizedEvents,
  normalizeOpenCodeEvent,
  partKey,
  resultText,
  unwrapSdkResponse,
} from "./normalizer";

interface ReconcileActiveRun {
  controller: AbortController;
  client?: OpencodeClient;
  sessionId?: string;
  directory?: string;
}

export async function reconcileSession(
  { controller: activeController, client, sessionId, directory }: ReconcileActiveRun,
  factory: ReturnType<typeof createEventFactory>,
  normalization: NormalizationContext,
  timeoutMs: number,
  messageLimit: number,
): Promise<NormalizedEvents> {
  if (!client || !sessionId || !directory) {
    return { events: [], turns: 0 };
  }

  const controller = new AbortController();
  const signal = AbortSignal.any([activeController.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort("reconciliation timeout"), timeoutMs);
  const events: RehorEvent[] = [];
  let turns = 0;
  let outcome: RuntimeTerminalState | undefined;
  let reason: string | undefined;

  const result = (): NormalizedEvents => {
    const text = resultText(normalization);
    return {
      events,
      ...(outcome ? { outcome, reason } : {}),
      ...(text === undefined ? {} : { resultText: text }),
      turns,
    };
  };

  const processMessages = (data: unknown[], currentSession: string): void => {
    for (const entry of data) {
      const message = record(entry);
      const info = record(message.info);
      if (info.sessionID !== currentSession) continue;
      const messageId = typeof info.id === "string" ? info.id : undefined;
      const messageKey = `${info.sessionID}:${messageId}`;
      const isAssistant = info.role === "assistant";
      const completed = Boolean(asObject(info.time)?.completed);
      if (messageId && typeof info.role === "string") {
        normalization.messageRoles.set(messageKey, info.role);
      }
      if (isAssistant && messageId) {
        const unseen = !normalization.seenMessages.has(messageKey);
        const needsFinalUpdate = completed && !normalization.completedMessages.has(messageKey);
        const messageEvent = {
          type: "message.updated",
          properties: { info },
        } as unknown as OpenCodeEvent;
        const normalized = normalizeOpenCodeEvent(messageEvent, factory, normalization, {
          suppressModel: !unseen,
          usageOnly: !unseen && !needsFinalUpdate,
        });
        events.push(...normalized.events);
        turns += normalized.turns;
      }

      const parts = Array.isArray(message.parts) ? message.parts : [];
      for (const value of parts) {
        const part = record(value);
        if (part.sessionID !== currentSession || part.messageID !== messageId) continue;
        const partId = typeof part.id === "string" ? part.id : undefined;
        if (!partId) continue;
        const toolKey = partKey(part);
        const toolCompleted =
          part.type === "tool" && normalization.toolPhases.get(toolKey) === "completed";
        const seenPart = normalization.seenParts.has(toolKey);
        if (part.type === "text" && part.sessionID === sessionId) {
          const text = stringValue(part.text, "");
          const changed = normalization.resultTextParts.get(partId) !== text;
          normalization.resultTextParts.set(partId, text);
          if (!changed) {
            normalization.seenParts.add(toolKey);
            continue;
          }
        } else if (
          (seenPart && part.type !== "tool" && part.type !== "step-finish") ||
          (seenPart && toolCompleted)
        ) {
          continue;
        }
        const normalized = normalizeOpenCodeEvent(
          {
            type: "message.part.updated",
            properties: { part },
          } as unknown as OpenCodeEvent,
          factory,
          normalization,
          { usageOnly: seenPart && part.type === "step-finish" },
        );
        events.push(...normalized.events);
        normalization.seenParts.add(toolKey);
      }
    }
  };

  try {
    const reconciliationDeadline = Date.now() + timeoutMs;
    const fetchMessages = async (id: string): Promise<unknown[]> => {
      const response = await boundedOperation(
        (requestSignal) =>
          client.session.messages({
            path: { id },
            query: { directory, limit: messageLimit },
            signal: requestSignal,
            responseStyle: "data",
            throwOnError: true,
          }),
        signal,
        reconciliationDeadline,
        "session messages reconciliation",
      );
      const entries = unwrapSdkResponse(response, "OpenCode session messages");
      return Array.isArray(entries) ? entries : [];
    };
    // Root evidence determines the outcome. Children only enrich usage within
    // the remaining budget, and must never consume the status request's budget.
    const [messages, status] = await Promise.allSettled([
      fetchMessages(sessionId),
      boundedOperation(
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
      ),
    ]);
    const data = messages.status === "fulfilled" ? messages.value : [];
    processMessages(data, sessionId);
    if (status.status === "fulfilled") {
      const statuses = record(unwrapSdkResponse(status.value, "OpenCode session status"));
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
    }

    await Promise.allSettled(
      [...normalization.sessionIds]
        .filter((id) => id !== sessionId)
        .map(async (id) => processMessages(await fetchMessages(id), id)),
    );
    return result();
  } catch {
    return result();
  } finally {
    clearTimeout(timer);
  }
}

function isTerminalAssistantMessageEntry(value: unknown, sessionId: string): boolean {
  const info = record(record(value).info);
  if (info.sessionID !== sessionId || info.role !== "assistant") return false;
  if (!asObject(info.time)?.completed || typeof info.finish !== "string") return false;
  return info.finish !== "tool-calls" && info.finish !== "unknown";
}
