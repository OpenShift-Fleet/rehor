import type { OpenCodeClient, SessionMessagesResponse, SessionsResponse } from "@opencode/client";
import type { createEventFactory, RehorEvent } from "../../domain";
import { boundedOperation } from "../shared";
import {
  type NormalizationContext,
  type NormalizedEvents,
  normalizeOpenCodeMessage,
  providerErrorMessage,
  resultText,
  updateRecoveryCoverage,
} from "./normalizer";

interface ReconcileActiveRun {
  controller: AbortController;
  client?: OpenCodeClient;
  sessionId?: string;
  directory?: string;
}

/** Recover from persisted V2 projections. Event payload logging is opt-in in CLI 2.1.2. */
export async function reconcileSession(
  { controller: activeController, client, sessionId }: ReconcileActiveRun,
  factory: ReturnType<typeof createEventFactory>,
  normalization: NormalizationContext,
  timeoutMs: number,
  messageLimit: number,
): Promise<NormalizedEvents> {
  if (!client || !sessionId) return { events: [], turns: 0 };
  const controller = new AbortController();
  const signal = AbortSignal.any([activeController.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort("reconciliation timeout"), timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const events: RehorEvent[] = [];
  let turns = 0;
  let terminal: Partial<NormalizedEvents> = {};
  let incomplete = false;
  const limit = Math.max(1, Math.floor(messageLimit));
  const call = <T>(operation: (signal: AbortSignal) => Promise<T>, name: string) =>
    boundedOperation(operation, signal, deadline, name);
  const fetchMessages = async (id: string) => {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    const messages = [];
    // messageLimit is a total per-session bound, not multiplied by page count.
    while (messages.length < limit && !signal.aborted) {
      const page: SessionMessagesResponse = await call(
        (signal) =>
          client.message.list(
            {
              sessionID: id,
              limit: limit - messages.length,
              ...(cursor ? { cursor } : { order: "desc" as const }),
            },
            { signal },
          ),
        "session messages reconciliation",
      ).catch((error: unknown) => {
        incomplete = true;
        if (messages.length) return { data: [], cursor: {} };
        throw error;
      });
      if (!Array.isArray(page.data)) {
        incomplete = true;
        break;
      }
      messages.push(...page.data.slice(0, limit - messages.length));
      const next = page.cursor?.next;
      if (!next) break;
      if (messages.length >= limit || cursors.has(next) || !page.data.length) {
        incomplete = true;
        break;
      }
      cursors.add(next);
      cursor = next;
    }
    return messages.reverse();
  };
  const processMessages = (messages: Awaited<ReturnType<typeof fetchMessages>>, id: string) => {
    for (const message of messages) {
      const normalized = normalizeOpenCodeMessage(message, id, factory, normalization);
      events.push(...normalized.events);
      turns += normalized.turns;
    }
  };
  try {
    // Root evidence completes before any child request can consume the budget.
    const [messages, info, active] = await Promise.allSettled([
      fetchMessages(sessionId),
      call(
        (signal) => client.session.get({ sessionID: sessionId }, { signal }),
        "session info reconciliation",
      ),
      call((signal) => client.session.active({ signal }), "session active reconciliation"),
    ]);
    const rootMessages = messages.status === "fulfilled" ? messages.value : [];
    processMessages(rootMessages, sessionId);
    const inactive = active.status === "fulfilled" && !active.value[sessionId];
    if (inactive) {
      // SessionInfo.outcome is projected from execution terminal events. Idle
      // messages carry the same evidence, including failures before any assistant.
      const idle = [...rootMessages].reverse().find((message) => message.type === "idle");
      // Native shutdown deliberately leaves the previous idle projection intact.
      // A fresh active-map read alone therefore cannot prove this execution ended.
      const projectedIdle = info.status === "fulfilled" ? info.value.time?.idle : undefined;
      const evidenceTime = Math.max(
        normalization.rootExecutionStartedAt ?? 0,
        ...rootMessages
          .filter((message) => message.type !== "idle")
          .map((message) =>
            Math.max(
              message.time.created,
              "completed" in message.time ? (message.time.completed ?? 0) : 0,
            ),
          ),
      );
      const freshIdle =
        idle &&
        idle.time.created >= evidenceTime &&
        (normalization.rootExecutionStartedAt === undefined ||
          idle.time.created > normalization.rootExecutionStartedAt)
          ? idle
          : undefined;
      const outcome =
        freshIdle?.outcome ??
        (!idle &&
        normalization.rootExecutionStartedAt === undefined &&
        typeof projectedIdle === "number" &&
        projectedIdle > evidenceTime &&
        info.status === "fulfilled"
          ? info.value.outcome
          : undefined);
      const error = freshIdle?.error
        ? providerErrorMessage(freshIdle.error)
        : (normalization.rootSessionError ?? normalization.rootAssistantError);
      if (outcome) {
        terminal = {
          outcome: outcome === "succeeded" ? "completed" : "failed",
          ...(outcome === "failed"
            ? { reason: error ?? "OpenCode execution failed" }
            : outcome === "interrupted"
              ? { reason: "OpenCode execution interrupted" }
              : {}),
        };
      }
    }

    // Recover missed creation events by paginating direct children recursively.
    // Each parent and cursor is visited once, and every request shares the deadline.
    const visited = new Set<string>();
    const visit = async (parentID: string): Promise<void> => {
      if (visited.has(parentID)) return;
      if (signal.aborted || Date.now() >= deadline) {
        incomplete = true;
        return;
      }
      visited.add(parentID);
      const descendants: Promise<void>[] = [];
      const usage =
        parentID === sessionId
          ? Promise.resolve()
          : fetchMessages(parentID).then((messages) => processMessages(messages, parentID));
      const discovery = (async () => {
        let cursor: string | undefined;
        const cursors = new Set<string>();
        try {
          do {
            const page: SessionsResponse = await call(
              (signal) =>
                client.session.list({ parentID, limit, ...(cursor ? { cursor } : {}) }, { signal }),
              "child sessions reconciliation",
            );
            if (!Array.isArray(page.data)) {
              incomplete = true;
              break;
            }
            for (const child of page.data) {
              if (child.parentID !== parentID || typeof child.id !== "string") continue;
              normalization.sessionIds.add(child.id);
              normalization.sessionParents.set(child.id, parentID);
              descendants.push(visit(child.id));
            }
            const next = page.cursor?.next;
            if (!next) break;
            if (cursors.has(next) || !page.data.length) {
              incomplete = true;
              break;
            }
            cursors.add(next);
            cursor = next;
          } while (!signal.aborted && Date.now() < deadline);
        } catch {
          incomplete = true;
          /* Discovery failure must not discard known children. */
        }
      })();
      await Promise.allSettled([usage, discovery]);
      await Promise.allSettled(descendants);
    };
    await Promise.allSettled([...normalization.sessionIds].map(visit));
  } finally {
    clearTimeout(timer);
  }
  events.push(...updateRecoveryCoverage(incomplete, factory, normalization));
  const text = resultText(normalization);
  return {
    events,
    turns,
    ...(!activeController.signal.aborted ? terminal : {}),
    ...(text === undefined ? {} : { resultText: text }),
  };
}
