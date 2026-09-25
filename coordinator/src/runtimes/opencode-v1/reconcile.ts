import type { Event as OpenCodeEvent, OpencodeClient } from "@opencode-ai/sdk";
import type { createEventFactory, RehorEvent, RuntimeTerminalState } from "../../domain";
import { boundedOperation, stringValue } from "../shared";
import {
  foldOpenCodeEvent,
  type NormalizationContext,
  type NormalizedEvents,
  normalizeOpenCodeEvent,
  partKey,
} from "./normalizer";
import {
  isTerminalAssistantMessageEntry,
  record,
  recordOrUndefined,
  unwrapSdkResponse,
} from "./sdk-helpers";

interface ReconcileActiveRun {
  controller: AbortController;
  client?: OpencodeClient;
  sessionId?: string;
  directory?: string;
}

export async function reconcileSession(
  active: ReconcileActiveRun,
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

    let outcome: RuntimeTerminalState | undefined;
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
