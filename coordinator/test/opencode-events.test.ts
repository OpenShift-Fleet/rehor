import type { OpenCodeClient, OpenCodeEvent, SessionMessageAssistant } from "@opencode/client";
import { describe, expect, it, vi } from "vitest";
import { createEventFactory, parseRehorEvent, parseRehorRun } from "../src/domain";
import { WorkContextTracker } from "../src/domain/work-context";
import {
  beginsNewTurn,
  createNormalizationContext,
  eventSessionId,
  isSessionEvent,
  normalizeOpenCodeEvent,
  normalizeOpenCodeMessage,
} from "../src/runtimes/opencode/normalizer";
import { reconcileSession } from "../src/runtimes/opencode/reconcile";
import fixture from "./fixtures/rehor-run.v1.json";

const tokens = { input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 40 } };
const model = { providerID: "rehor-openai", id: "gpt-6.1-sol" };
const assistant = (
  id = "msg",
  content: SessionMessageAssistant["content"] = [],
): SessionMessageAssistant => ({
  id,
  type: "assistant",
  agent: "build",
  model,
  time: { created: 1, completed: 2 },
  content,
  tokens,
  cost: 0,
  finish: "stop",
});

function harness(run = parseRehorRun(fixture)) {
  const factory = createEventFactory(run, "v2");
  const context = createNormalizationContext("root", "rehor-openai/gpt-6.1-sol");
  let seq = 0;
  const event = (type: string, data: Record<string, unknown>, id = `evt-${++seq}`) =>
    ({ id, created: seq, type, data }) as OpenCodeEvent;
  const send = (type: string, data: Record<string, unknown>) =>
    normalizeOpenCodeEvent(event(type, data), factory, context);
  return { factory, context, event, send };
}

describe("V2 event normalization", () => {
  it("counts root turns at step completion and detects starts before normalization", () => {
    const h = harness();
    const start = h.event("session.step.started", {
      sessionID: "root",
      assistantMessageID: "msg",
      model,
      started: 1,
    });
    expect(beginsNewTurn(start, h.context)).toBe(true);
    expect(eventSessionId(start)).toBe("root");
    expect(normalizeOpenCodeEvent(start, h.factory, h.context).turns).toBe(0);
    expect(beginsNewTurn(start, h.context)).toBe(false);
    expect(normalizeOpenCodeEvent(start, h.factory, h.context).events).toEqual([]);
    const end = h.send("session.step.ended", {
      sessionID: "root",
      assistantMessageID: "msg",
      tokens,
      cost: 0,
      finish: "stop",
    });
    expect(end.turns).toBe(1);
    expect(end.events.map((event) => event.sequence)).toEqual(
      [...end.events.map((event) => event.sequence)].sort((a, b) => a - b),
    );
    expect(end.events.find((event) => event.kind === "usage")?.parentEventId).toBe(
      h.context.modelEventIds.get("root:msg"),
    );
    expect(normalizeOpenCodeMessage(assistant(), "root", h.factory, h.context).turns).toBe(0);
    for (const event of end.events) expect(() => parseRehorEvent(event)).not.toThrow();
  });

  it("tracks descendants recursively, including out-of-order creation edges", () => {
    const h = harness();
    expect(
      isSessionEvent(
        h.event("session.created", { sessionID: "grandchild", parentID: "child" }),
        h.context,
      ),
    ).toBe(false);
    expect(h.send("session.created", { sessionID: "child", parentID: "root" }).events).toHaveLength(
      1,
    );
    expect([...h.context.sessionIds]).toEqual(["root", "child", "grandchild"]);
    for (const type of [
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.idle",
      "permission.asked",
    ]) {
      expect(
        h.send(type, { sessionID: "grandchild", error: { message: "child failure" } }).outcome,
      ).toBeUndefined();
    }
    expect(h.send("session.execution.succeeded", { sessionID: "unrelated" }).events).toEqual([]);
  });

  it("never infers success from idle or terminal assistant alone", () => {
    const h = harness();
    expect(h.send("session.idle", { sessionID: "root" }).outcome).toBeUndefined();
    normalizeOpenCodeMessage(assistant(), "root", h.factory, h.context);
    expect(
      h.send("session.status", { sessionID: "root", status: { type: "idle" } }).outcome,
    ).toBeUndefined();
    expect(h.send("session.execution.succeeded", { sessionID: "root" }).outcome).toBe("completed");
    expect(h.send("session.idle", { sessionID: "root" }).outcome).toBe("completed");
  });

  it("retains native retry usage and stable correlation for the same assistant ID", () => {
    const h = harness();
    h.send("session.step.started", {
      sessionID: "root",
      assistantMessageID: "msg",
      model,
      started: 1,
    });
    const first = h.send("session.step.failed", {
      sessionID: "root",
      assistantMessageID: "msg",
      tokens,
      cost: 0.25,
      error: { type: "provider.unknown", message: "retryable" },
    });
    const parent = first.events.find((event) => event.kind === "usage")?.parentEventId;
    // Native step.started clears completion/error but preserves existing content/usage.
    const retry = h.send("session.step.started", {
      sessionID: "root",
      assistantMessageID: "msg",
      model,
      started: 3,
    });
    expect(retry.events.find((event) => event.kind === "usage")?.payload).toMatchObject({
      partial: true,
      final: false,
      incomplete: true,
      cost: { amount: 0.25 },
    });
    const final = h.send("session.step.failed", {
      sessionID: "root",
      assistantMessageID: "msg",
      error: { type: "provider.unknown", message: "stream lost before new usage" },
    });
    expect(h.context.modelEventIds.get("root:msg")).toBe(parent);
    expect(h.context.messages.get("root:msg")).toMatchObject({ tokens, cost: 0.25 });
    const usages = [...first.events, ...final.events].filter((event) => event.kind === "usage");
    expect(usages.at(-1)?.payload).toMatchObject({
      tokenCounts: { input: 10 },
      cost: { amount: 0.25 },
    });
    expect(usages.every((event) => event.parentEventId === parent)).toBe(true);
  });

  it("fails execution errors before assistant creation and clears errors on new execution", () => {
    const h = harness();
    expect(
      h.send("session.execution.failed", {
        sessionID: "root",
        error: { type: "ProviderNotFoundError", message: "provider missing" },
      }),
    ).toMatchObject({ outcome: "failed", reason: "provider missing" });
    expect(h.send("session.idle", { sessionID: "root" })).toMatchObject({
      outcome: "failed",
      reason: "provider missing",
    });
    h.send("session.execution.started", { sessionID: "root" });
    expect(h.send("session.idle", { sessionID: "root" }).outcome).toBeUndefined();
    expect(
      h.send("session.execution.interrupted", { sessionID: "root", reason: "shutdown" }),
    ).toMatchObject({ outcome: "failed", reason: "OpenCode execution interrupted: shutdown" });
  });

  it("replaces text/reasoning deltas with authoritative snapshots without duplicate result text", () => {
    const h = harness();
    const data = { sessionID: "root", assistantMessageID: "msg", ordinal: 0 };
    h.send("session.text.started", data);
    const delta = h.event("session.text.delta", { ...data, delta: "hel" });
    normalizeOpenCodeEvent(delta, h.factory, h.context);
    expect(normalizeOpenCodeEvent(delta, h.factory, h.context).events).toEqual([]);
    h.send("session.reasoning.delta", { ...data, delta: "think" });
    expect(h.send("session.text.ended", { ...data, text: "hello" }).resultText).toBe("hello");
    const projected = normalizeOpenCodeMessage(
      assistant("msg", [
        { type: "reasoning", text: "think" },
        { type: "text", text: "hello" },
      ]),
      "root",
      h.factory,
      h.context,
    );
    expect(projected.resultText).toBe("hello");
    expect(
      projected.events.filter((e) => e.payload.phase === "text" || e.payload.phase === "reasoning"),
    ).toEqual([]);
    h.context.sessionIds.add("child");
    expect(
      h.send("session.text.ended", { ...data, sessionID: "child", text: "private child" })
        .resultText,
    ).toBe("hello");
  });

  it("preserves V2 tool input, structured results, error, duration, and completed phase during reconciliation", () => {
    const h = harness();
    const data = { sessionID: "root", assistantMessageID: "msg", id: "call" };
    h.send("session.tool.input.started", { ...data, name: "shell" });
    h.send("session.tool.called", { ...data, input: { command: "pwd" }, executed: true });
    const result = h.send("session.tool.success", {
      ...data,
      content: [{ type: "text", text: "/work" }],
      executed: true,
    });
    expect(result.events[0]?.payload).toMatchObject({
      name: "shell",
      state: "completed",
      input: { command: "pwd" },
      content: "/work",
      durationMs: 1,
    });
    const projected = assistant("msg", [
      {
        type: "tool",
        id: "call",
        name: "shell",
        state: {
          status: "completed",
          input: { command: "pwd" },
          content: [{ type: "text", text: "/work" }],
        },
        time: { created: 1, ran: 2, completed: 3 },
      },
    ]);
    expect(
      normalizeOpenCodeMessage(projected, "root", h.factory, h.context).events.filter(
        (e) => e.kind === "tool",
      ),
    ).toEqual([]);
    expect(h.send("session.tool.called", { ...data, input: { command: "pwd" } }).events).toEqual(
      [],
    );
    expect(
      h.send("session.tool.failed", {
        ...data,
        id: "error",
        error: { type: "ToolError", message: "denied" },
      }).events[0]?.payload,
    ).toMatchObject({ isError: true, content: "denied" });
  });
});

describe.each(["direct", "codemode"])("V2 native shell work context (%s)", (path) => {
  it.each([
    ["gh pr checks 582", "ci_fix"],
    ["gh pr view 582 --comments", "pr_review"],
  ])("preserves %s as terminal %s", (command, workType) => {
    const run = parseRehorRun({ ...fixture, runtimeId: "opencode", task: null });
    const tracker = new WorkContextTracker(run);
    const h = harness(run);
    const input = { command };
    const data = { sessionID: "root", assistantMessageID: "msg", id: "call" };
    const send = (type: string, fields: Record<string, unknown>) => {
      const result = h.send(type, { ...data, ...fields });
      for (const event of result.events) tracker.observe(parseRehorEvent(event));
      return result.events;
    };
    send("session.tool.input.started", { name: path === "direct" ? "shell" : "execute" });
    if (path === "direct") {
      send("session.tool.called", { input, executed: true });
      send("session.tool.success", { content: [{ type: "text", text: "done" }] });
    } else {
      send("session.tool.called", { input: { code: "await tools.shell(input)" }, executed: true });
      const row = { tool: "shell", input, status: "running" };
      // Native-only metadata is display fallback until the bridge confirms context.
      send("session.tool.progress", { metadata: { toolCalls: [row] } });
      expect(
        tracker.enrichTerminal(h.factory("terminal", { state: "completed" })).payload.context,
      ).toBeUndefined();
      const events = send("session.tool.success", {
        metadata: {
          toolCalls: [{ ...row, status: "completed" }],
          rehorCodeMode: {
            calls: [
              {
                id: "root:msg:call:nested:0",
                name: "shell",
                input,
                status: "completed",
                content: "done",
              },
            ],
          },
        },
        content: [{ type: "text", text: "done" }],
      });
      expect(events.find((event) => event.payload.codeMode === true)?.payload).toMatchObject({
        name: "shell",
        input,
        workContextAvailable: true,
        nativeOrdinal: 0,
      });
    }
    expect(
      tracker.enrichTerminal(h.factory("terminal", { state: "completed" })).payload.context,
    ).toEqual({ workType });
  });
});

describe("V2 projected reconciliation", () => {
  it.each(["succeeded", "failed", "interrupted", undefined] as const)(
    "requires terminal execution evidence: %s",
    async (outcome) => {
      const h = harness();
      const client = {
        message: { list: async () => ({ data: [assistant()], cursor: {} }) },
        session: {
          get: async () => ({ outcome, time: { idle: 3 } }),
          active: async () => ({}),
          list: async () => ({ data: [], cursor: {} }),
        },
      } as unknown as OpenCodeClient;
      const result = await reconcileSession(
        { client, sessionId: "root", controller: new AbortController() },
        h.factory,
        h.context,
        100,
        10,
      );
      expect(result.outcome).toBe(
        outcome === "succeeded" ? "completed" : outcome ? "failed" : undefined,
      );
    },
  );

  it("recovers projected success without any assistant", async () => {
    const h = harness();
    const client = {
      message: { list: async () => ({ data: [], cursor: {} }) },
      session: {
        get: async () => ({ outcome: "succeeded", time: { idle: 3 } }),
        active: async () => ({}),
        list: async () => ({ data: [], cursor: {} }),
      },
    } as unknown as OpenCodeClient;
    expect(
      await reconcileSession(
        { client, sessionId: "root", controller: new AbortController() },
        h.factory,
        h.context,
        100,
        10,
      ),
    ).toMatchObject({ outcome: "completed", turns: 0 });
  });

  it.each(["started", "started-same-time", "started-watermark", "assistant", "user"])(
    "rejects prior idle success after newer %s evidence, including shutdown without new idle",
    async (evidence) => {
      const h = harness();
      const oldIdle = evidence === "started-same-time" ? 10 : 3;
      if (evidence.startsWith("started"))
        normalizeOpenCodeEvent(
          {
            id: "new-execution",
            created: 10,
            type: "session.execution.started",
            data: { sessionID: "root" },
          } as OpenCodeEvent,
          h.factory,
          h.context,
        );
      const latest =
        evidence === "assistant"
          ? { ...assistant("new"), time: { created: 10 }, tokens: undefined, cost: undefined }
          : evidence === "user"
            ? { id: "new-user", type: "user", time: { created: 10 } }
            : undefined;
      const client = {
        message: {
          list: async () => ({
            data: [
              latest,
              { id: "old-idle", type: "idle", outcome: "succeeded", time: { created: oldIdle } },
            ].filter(Boolean),
            cursor: {},
          }),
        },
        session: {
          get: async () => ({
            outcome: "succeeded",
            time: { idle: evidence === "started-watermark" ? 100 : oldIdle },
          }),
          active: async () => ({}),
          list: async () => ({ data: [], cursor: {} }),
        },
      } as unknown as OpenCodeClient;
      expect(
        (
          await reconcileSession(
            { client, sessionId: "root", controller: new AbortController() },
            h.factory,
            h.context,
            100,
            10,
          )
        ).outcome,
      ).toBeUndefined();
    },
  );

  it("does not return recovered completion if caller cancels during child recovery", async () => {
    const h = harness();
    const controller = new AbortController();
    h.context.sessionIds.add("child");
    const client = {
      message: {
        list: async ({ sessionID }: { sessionID: string }) => {
          if (sessionID === "child") controller.abort("cancelled");
          return { data: [assistant()], cursor: {} };
        },
      },
      session: {
        get: async () => ({ outcome: "succeeded", time: { idle: 3 } }),
        active: async () => ({}),
        list: async () => ({ data: [], cursor: {} }),
      },
    } as unknown as OpenCodeClient;
    const result = await reconcileSession(
      { client, sessionId: "root", controller },
      h.factory,
      h.context,
      100,
      10,
    );
    expect(result.outcome).toBeUndefined();
    expect(result.events.some((event) => event.kind === "usage")).toBe(true);
  });

  it("recovers idle failure with no assistant even if session.get fails", async () => {
    const h = harness();
    const client = {
      message: {
        list: async () => ({
          data: [
            {
              id: "idle",
              type: "idle",
              outcome: "failed",
              error: { type: "ProviderNotFoundError", message: "missing provider" },
              time: { created: 1 },
            },
          ],
          cursor: {},
        }),
      },
      session: {
        get: async () => {
          throw new Error("unavailable");
        },
        active: async () => ({}),
        list: async () => ({ data: [], cursor: {} }),
      },
    } as unknown as OpenCodeClient;
    expect(
      await reconcileSession(
        { client, sessionId: "root", controller: new AbortController() },
        h.factory,
        h.context,
        100,
        10,
      ),
    ).toMatchObject({ outcome: "failed", reason: "missing provider", turns: 0 });
  });

  it("does not use stale terminal projection while session remains active", async () => {
    const h = harness();
    const client = {
      message: { list: async () => ({ data: [assistant()], cursor: {} }) },
      session: {
        get: async () => ({ outcome: "succeeded", time: { idle: 3 } }),
        active: async () => ({ root: { type: "running" } }),
        list: async () => ({ data: [], cursor: {} }),
      },
    } as unknown as OpenCodeClient;
    expect(
      (
        await reconcileSession(
          { client, sessionId: "root", controller: new AbortController() },
          h.factory,
          h.context,
          100,
          10,
        )
      ).outcome,
    ).toBeUndefined();
  });

  it("paginates missed descendants and messages recursively; refreshes usage without replay", async () => {
    const h = harness();
    const calls: unknown[] = [];
    const client = {
      message: {
        list: vi.fn(async (input: { sessionID: string; cursor?: string }) => {
          calls.push(["messages", input.sessionID, input.cursor]);
          return {
            data: [
              assistant(input.cursor ? "older" : "msg", [{ type: "text", text: input.sessionID }]),
            ],
            cursor: input.sessionID === "root" && !input.cursor ? { next: "page2" } : {},
          };
        }),
      },
      session: {
        get: async () => ({ outcome: "succeeded", time: { idle: 3 } }),
        active: async () => ({}),
        list: vi.fn(async (input: { parentID: string; cursor?: string }) => {
          calls.push(["children", input.parentID, input.cursor]);
          return {
            data:
              input.parentID === "root"
                ? [{ id: input.cursor ? "child2" : "child", parentID: "root" }]
                : input.parentID === "child"
                  ? [{ id: "grandchild", parentID: "child" }]
                  : [],
            cursor: input.parentID === "root" && !input.cursor ? { next: "children2" } : {},
          };
        }),
      },
    } as unknown as OpenCodeClient;
    const result = await reconcileSession(
      { client, sessionId: "root", controller: new AbortController() },
      h.factory,
      h.context,
      1000,
      10,
    );
    expect(result).toMatchObject({ outcome: "completed", turns: 2, resultText: "rootroot" });
    expect(h.context.sessionIds).toEqual(new Set(["root", "child", "child2", "grandchild"]));
    expect(calls).toContainEqual(["messages", "root", "page2"]);
    expect(client.message.list).toHaveBeenCalledWith(
      expect.objectContaining({ sessionID: "root", cursor: "page2" }),
      expect.anything(),
    );
    for (const [input] of vi.mocked(client.message.list).mock.calls) {
      if (input.cursor) expect(input.order).toBeUndefined();
    }
    expect(calls).toContainEqual(["children", "root", "children2"]);
    const usage = result.events.filter((event) => event.kind === "usage").at(-1)?.payload;
    expect(usage).toMatchObject({ tokenCounts: { input: 50 }, incomplete: false });
    const replay = await reconcileSession(
      { client, sessionId: "root", controller: new AbortController() },
      h.factory,
      h.context,
      1000,
      10,
    );
    expect(replay.events).toEqual([]);
    expect(replay.turns).toBe(0);
  });

  it("preserves root and valid sibling evidence while slow children ignore cancellation", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.context.sessionIds.add("slow");
      h.context.sessionIds.add("valid");
      const calls: string[] = [];
      let childSignal: AbortSignal | undefined;
      const client = {
        message: {
          list: async (
            { sessionID }: { sessionID: string },
            { signal }: { signal: AbortSignal },
          ) => {
            calls.push(sessionID);
            if (sessionID === "slow") {
              childSignal = signal;
              return new Promise(() => {});
            }
            return { data: [assistant()], cursor: {} };
          },
        },
        session: {
          get: async () => ({ outcome: "succeeded", time: { idle: 3 } }),
          active: async () => {
            calls.push("active");
            await new Promise((r) => setTimeout(r, 10));
            return {};
          },
          list: async () => ({ data: [], cursor: {} }),
        },
      } as unknown as OpenCodeClient;
      const pending = reconcileSession(
        { client, sessionId: "root", controller: new AbortController() },
        h.factory,
        h.context,
        100,
        10,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(["root", "active"]);
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toContain("valid");
      await vi.advanceTimersByTimeAsync(90);
      const result = await pending;
      expect(childSignal?.aborted).toBe(true);
      expect(result.outcome).toBe("completed");
      expect(
        result.events.filter((e) => e.kind === "usage").at(-1)?.payload.tokenCounts,
      ).toMatchObject({ input: 20 });
      expect(
        result.events.filter((event) => event.kind === "usage").at(-1)?.payload.incomplete,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds total messages and breaks repeated pagination cursors", async () => {
    const h = harness();
    const list = vi.fn(async () => ({ data: [assistant()], cursor: { next: "same" } }));
    const client = {
      message: { list },
      session: {
        get: async () => ({}),
        active: async () => ({}),
        list: async () => ({ data: [], cursor: {} }),
      },
    } as unknown as OpenCodeClient;
    await reconcileSession(
      { client, sessionId: "root", controller: new AbortController() },
      h.factory,
      h.context,
      100,
      10,
    );
    expect(list).toHaveBeenCalledTimes(2);
    list.mockClear();
    await reconcileSession(
      { client, sessionId: "root", controller: new AbortController() },
      h.factory,
      h.context,
      100,
      1,
    );
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("marks truncated history incomplete and clears coverage gap after full recovery", async () => {
    const h = harness();
    let truncated = true;
    const client = {
      message: {
        list: async () => ({ data: [assistant()], cursor: truncated ? { next: "older" } : {} }),
      },
      session: {
        get: async () => ({ outcome: "succeeded", time: { idle: 3 } }),
        active: async () => ({}),
        list: async () => ({ data: [], cursor: {} }),
      },
    } as unknown as OpenCodeClient;
    const recover = () =>
      reconcileSession(
        { client, sessionId: "root", controller: new AbortController() },
        h.factory,
        h.context,
        100,
        1,
      );
    const first = await recover();
    expect(first.events.filter((event) => event.kind === "usage").at(-1)?.payload.incomplete).toBe(
      true,
    );
    truncated = false;
    const second = await recover();
    const usage = second.events.find((event) => event.kind === "usage");
    expect(usage?.payload).toMatchObject({ incomplete: false, tokenCounts: { input: 10 } });
    expect(usage?.parentEventId).toBe(h.context.modelEventIds.get("root:msg"));
    expect(second.turns).toBe(0);
  });
});
