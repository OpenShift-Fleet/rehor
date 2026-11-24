import type { OpenCodeClient, OpenCodeEvent, SessionMessageInfo } from "@opencode/client";
import { describe, expect, it, vi } from "vitest";
import { executeRun } from "../src/coordinator";
import { createEventFactory, parseRehorEvent, parseRehorRun, type RehorEvent } from "../src/domain";
import { WorkContextTracker } from "../src/domain/work-context";
import type { CostRecord } from "../src/ports/compatibility";
import { LegacyCompatibilityProjection } from "../src/projections/compatibility";
import {
  createNormalizationContext,
  normalizeOpenCodeEvent,
  normalizeOpenCodeMessage,
} from "../src/runtimes/opencode/normalizer";
import { renderOpenCodeConfig } from "../src/runtimes/opencode/render";
import { OpenCodeRuntime } from "../src/runtimes/opencode/runtime";
import fixture from "./fixtures/rehor-run.v1.json";

const model = { providerID: "rehor-openai", id: "gpt-6.1-sol" };
const tokens = { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } };
const run = parseRehorRun({
  ...fixture,
  runtimeId: "opencode",
  task: null,
  provider: { id: model.providerID, requestedModel: `${model.providerID}/${model.id}` },
});
type Row = Record<string, unknown>;
const resultContent = [{ type: "text", text: '{"id":143,"external_key":"REHOR-143"}' }];
const input = { external_key: "REHOR-143", repo: "rehor", summary: "Code Mode work" };
const call = (index: number, status = "running", extra: Row = {}) => ({
  id: `root:msg:execute:nested:${index}`,
  name: "bot-memory_task_add",
  input,
  status,
  ...extra,
});
const metadata = (calls: Row[], toolCalls?: Row[]) => ({
  rehorCodeMode: { calls },
  ...(toolCalls ? { toolCalls } : {}),
});
let seq = 0;
const event = (type: string, data: Row) =>
  ({ id: `code-${++seq}`, created: seq, type, data }) as OpenCodeEvent;
const step = (messageID = "msg", sessionID = "root") =>
  event("session.step.started", {
    sessionID,
    assistantMessageID: messageID,
    model,
    started: 1,
  });
const end = (messageID = "msg", sessionID = "root") =>
  event("session.step.ended", {
    sessionID,
    assistantMessageID: messageID,
    cost: 0.25,
    tokens,
    finish: "stop",
  });
const tool = (type: string, data: Row = {}, sessionID = "root", messageID = "msg") =>
  event(`session.tool.${type}`, {
    sessionID,
    assistantMessageID: messageID,
    id: "execute",
    ...data,
  });
const opened = (sessionID = "root", messageID = "msg") => [
  tool("input.started", { name: "execute" }, sessionID, messageID),
  tool(
    "called",
    { input: { code: "/* results deliberately not printed */ return 'done'" }, executed: true },
    sessionID,
    messageID,
  ),
];
const projected = (value: Row, sessionID = "root", status = "completed") =>
  ({
    id: "msg",
    type: "assistant",
    agent: "build",
    model,
    cost: 0.25,
    tokens,
    time: { created: 1, completed: 10 },
    content: [
      {
        id: "execute",
        type: "tool",
        name: "execute",
        time: { created: 2, ran: 3, completed: 9 },
        state: {
          status,
          input: { code: "/* results deliberately not printed */ return 'done'" },
          metadata: value,
          content: [{ type: "text", text: "done" }],
        },
      },
    ],
    sessionID,
  }) as unknown as SessionMessageInfo;
const nested = (events: readonly RehorEvent[]) =>
  events.filter((e) => e.kind === "tool" && e.payload.codeMode === true);
const completed = (events: readonly RehorEvent[]) =>
  nested(events).filter((e) => e.payload.state === "completed");

function harness() {
  const factory = createEventFactory(run, "codemode");
  const context = createNormalizationContext("root", run.provider.requestedModel);
  const events: RehorEvent[] = [];
  const send = (value: OpenCodeEvent) => {
    const result = normalizeOpenCodeEvent(value, factory, context);
    events.push(...result.events.map(parseRehorEvent));
    return result;
  };
  const recover = (value: Row, sessionID = "root") => {
    const result = normalizeOpenCodeMessage(
      projected(value, sessionID),
      sessionID,
      factory,
      context,
    );
    events.push(...result.events.map(parseRehorEvent));
    return result;
  };
  return { factory, context, events, send, recover };
}

describe("Code Mode event identity and work context", () => {
  it.each([{ value: "opaque" }, { value: ["opaque"] }, { value: null }])(
    "preserves raw non-record bridge input %j",
    ({ value }) => {
      const h = harness();
      h.send(step());
      for (const e of opened()) h.send(e);
      const final = metadata(
        [call(0, "completed", { name: "plugin_echo", input: value, content: { returned: value } })],
        [
          {
            tool: "plugin.echo",
            status: "completed",
            ...(value === null ? {} : { input: { input: value } }),
          },
        ],
      );
      h.send(tool("success", { metadata: final }));
      expect(completed(h.events)).toHaveLength(1);
      expect(completed(h.events)[0]?.payload).toMatchObject({
        input: value,
        content: { returned: value },
      });
    },
  );
  it("enriches native rows with raw bridge results and deduplicates progress, final and projection", () => {
    const h = harness();
    h.send(step());
    for (const e of opened()) h.send(e);
    const row = {
      tool: "bot-memory.task_add",
      input: { summary: input.summary, repo: input.repo, external_key: input.external_key },
      status: "running",
    };
    h.send(tool("progress", { metadata: { toolCalls: [row] } }));
    const first = nested(h.events)[0];
    h.send(tool("progress", { metadata: metadata([call(0)], [row]) }));
    const final = metadata(
      [call(0, "completed", { content: resultContent })],
      [{ ...row, status: "completed" }],
    );
    const progress = tool("progress", { metadata: final });
    h.send(progress);
    h.send(progress);
    h.send(tool("success", { metadata: final, content: [{ type: "text", text: "done" }] }));
    h.recover(final);
    expect(completed(h.events)).toHaveLength(1);
    const result = completed(h.events)[0];
    expect(result?.payload).toMatchObject({
      toolUseId: "root:msg:execute:codemode:0",
      input,
      content: resultContent,
      workContextAvailable: true,
      resultUnavailable: false,
    });
    expect(result?.parentEventId).toBe(first?.eventId);
    const outer = h.events.filter((e) => e.kind === "tool" && e.payload.name === "execute");
    expect(outer.every((e) => e.payload.budgetUnit === "container")).toBe(true);
    const tracker = new WorkContextTracker(run);
    for (const e of h.events) tracker.observe(e);
    expect(
      tracker.enrichTerminal(h.factory("terminal", { state: "completed" })).payload.context,
    ).toMatchObject({
      taskId: 143,
      externalKey: "REHOR-143",
      repository: "rehor",
      summary: input.summary,
    });
    expect(h.recover(final).events).toEqual([]);
    expect(h.events.map((e) => e.sequence)).toEqual(
      [...h.events.map((e) => e.sequence)].sort((a, b) => a - b),
    );
  });

  it("uses occurrence order for identical parallel calls with an interleaved native fetch", () => {
    const h = harness();
    const rows = [
      { tool: "bot-memory.task_add", input, status: "running" },
      { tool: "fetch", input: { url: "https://example.invalid" }, status: "completed" },
      { tool: "bot-memory.task_add", input, status: "running" },
    ];
    h.send(step());
    for (const e of opened()) h.send(e);
    h.send(tool("progress", { metadata: { toolCalls: rows } }));
    h.send(
      tool("progress", {
        metadata: metadata([call(1, "completed", { content: '{"task_id":2}' }), call(0)], rows),
      }),
    );
    expect(
      completed(h.events).find((e) => e.payload.content === '{"task_id":2}')?.payload.toolUseId,
    ).toBe("root:msg:execute:codemode:2");
    const final = metadata(
      [
        call(1, "completed", { content: '{"task_id":2}' }),
        call(0, "completed", { content: '{"task_id":1}' }),
      ],
      rows.map((r) => ({ ...r, status: "completed" })),
    );
    h.send(tool("success", { metadata: final, content: [{ type: "text", text: "done" }] }));
    h.recover(final);
    expect(completed(h.events)).toHaveLength(3);
    expect(new Set(completed(h.events).map((e) => e.payload.toolUseId)).size).toBe(3);
    expect(
      completed(h.events).find((e) => e.payload.content === '{"task_id":1}')?.payload.toolUseId,
    ).toBe("root:msg:execute:codemode:0");
    const fetch = completed(h.events).find((e) => e.payload.name === "fetch");
    expect(fetch?.payload).toMatchObject({
      nativeOrdinal: 1,
      resultUnavailable: true,
      workContextAvailable: false,
    });
  });

  it("keeps bridge-only identity when native rows arrive later", () => {
    const h = harness();
    h.send(step());
    for (const e of opened()) h.send(e);
    h.send(tool("progress", { metadata: metadata([call(0)]) }));
    const id = nested(h.events)[0]?.payload.toolUseId;
    const final = metadata(
      [call(0, "completed", { content: resultContent })],
      [{ tool: "bot-memory.task_add", input, status: "completed" }],
    );
    h.send(tool("success", { metadata: final }));
    h.recover(final);
    expect(completed(h.events).map((e) => e.payload.toolUseId)).toEqual([id]);
  });

  it.each(["success", "failed"])(
    "does not infer nested success from outer execute %s",
    (status) => {
      const h = harness();
      h.send(step());
      for (const e of opened()) h.send(e);
      h.send(tool("progress", { metadata: metadata([call(0)]) }));
      h.send(
        tool(status, {
          metadata: { error: true },
          ...(status === "failed" ? { error: { message: "script interrupted" } } : {}),
          content: [{ type: "text", text: "script interrupted" }],
        }),
      );
      expect(completed(h.events)).toEqual([]);
      expect(h.events.filter((e) => e.payload.name === "execute").at(-1)?.payload).toMatchObject({
        isError: true,
        budgetUnit: "container",
      });
      h.send(tool("progress", { metadata: metadata([call(0)]) }));
      expect(completed(h.events)).toEqual([]);
    },
  );

  it("recovers root and child calls without ID collisions or invented fallback results", () => {
    const h = harness();
    h.send(event("session.created", { sessionID: "child", parentID: "root" }));
    const final = metadata(
      [call(0, "completed", { content: { id: 143, external_key: "REHOR-143" } })],
      [{ tool: "bot-memory.task_add", input, status: "completed" }],
    );
    h.recover(final);
    h.recover(final, "child");
    expect(new Set(completed(h.events).map((e) => e.payload.toolUseId)).size).toBe(2);
    for (const settled of completed(h.events)) {
      const start = h.events.find((e) => e.eventId === settled.parentEventId);
      expect(start?.payload).toMatchObject({
        state: "started",
        toolUseId: settled.payload.toolUseId,
      });
      expect(start?.runtimeSessionRef).toBe(settled.runtimeSessionRef);
      const container = h.events.find((e) => e.eventId === start?.parentEventId);
      expect(container?.payload.budgetUnit).toBe("container");
    }
    expect(h.recover(final, "child").events).toEqual([]);
    const fallback = harness();
    const value = { toolCalls: [{ tool: "bot-memory.task_add", input, status: "completed" }] };
    const message = projected(value);
    const part = (message as unknown as { content: { state: Row }[] }).content[0];
    if (part) part.state.content = [{ type: "text", text: '{"task_id":999}' }];
    const result = normalizeOpenCodeMessage(message, "root", fallback.factory, fallback.context);
    const tracker = new WorkContextTracker(run);
    for (const e of result.events) tracker.observe(e);
    expect(
      tracker.enrichTerminal(fallback.factory("terminal", { state: "completed" })).payload.context,
    ).toBeUndefined();
    expect(completed(result.events)[0]?.payload).toMatchObject({
      resultUnavailable: true,
      workContextAvailable: false,
    });
    expect(completed(result.events)[0]?.payload).not.toHaveProperty("content");
  });
});

function runtimeFor(
  events: OpenCodeEvent[],
  messages: SessionMessageInfo[] = [],
  streamError?: Error,
) {
  const reads = vi.fn(async () => ({ data: messages, cursor: {} }));
  const interrupt = vi.fn(async () => ({ interrupted: true }));
  const client = {
    event: {
      subscribe: async function* () {
        yield event("server.connected", {});
        yield* events;
        if (streamError) throw streamError;
      },
    },
    plugin: { list: async () => ({ data: [{ id: "rehor-policy", state: { status: "active" } }] }) },
    session: {
      create: async () => ({ id: "root" }),
      prompt: async () => ({}),
      interrupt,
      remove: async () => {},
      get: async () => ({ outcome: "succeeded", time: { idle: 100 } }),
      active: async () => ({}),
      list: async () => ({ data: [], cursor: {} }),
    },
    message: { list: reads },
  } as unknown as OpenCodeClient;
  const info = {
    baseUrl: "http://127.0.0.1:12345",
    hostname: "127.0.0.1",
    port: 12345,
    directory: run.worktree.path,
    healthy: true,
    version: "2.1.2",
    capabilities: { persistentPty: true },
  };
  return {
    runtime: new OpenCodeRuntime({
      renderedConfig: renderOpenCodeConfig({ providerId: model.providerID, model: model.id }),
      clientFactory: () => client,
      supervisor: () => ({
        info,
        crashSignal: new AbortController().signal,
        crashError: undefined,
        start: async () => info,
        stop: async () => {},
      }),
    }),
    reads,
    interrupt,
  };
}

describe("Code Mode executeRun accounting and boundaries", () => {
  it.each([
    [false, "root", false],
    [true, "root", false],
    [false, "child", false],
    [false, "root", true],
  ] as const)(
    "counts nested successes at next model boundary (fetch=%s session=%s nativeFirst=%s)",
    async (fetch, sessionID, nativeFirst) => {
      const calls = [
        call(0, "completed", { content: resultContent }),
        call(1, "completed", {
          name: "bot-memory_task_update",
          input: { ...input, status: "pr_open" },
          content: { task_id: 143 },
        }),
        call(2, "error", {
          name: "bot-memory_memory_store",
          error: { message: "failed" },
          content: '{"task_id":999}',
        }),
      ];
      const rows: Row[] = calls.map((c) => ({
        tool: String(c.name).replace("bot-memory_", "bot-memory."),
        input: c.input,
        status: c.status,
      }));
      if (fetch)
        rows.splice(1, 0, {
          tool: "fetch",
          input: { url: "https://example.invalid" },
          status: "completed",
        });
      const value = metadata(calls, rows);
      const events = [step()];
      if (sessionID === "child")
        events.push(
          event("session.created", { sessionID, parentID: "root" }),
          step("msg", sessionID),
        );
      events.push(...opened(sessionID));
      if (nativeFirst) events.push(tool("progress", { metadata: { toolCalls: rows } }, sessionID));
      events.push(
        tool("progress", { metadata: value }, sessionID),
        tool("success", { metadata: value, content: [{ type: "text", text: "done" }] }, sessionID),
        end("msg", sessionID),
      );
      if (sessionID === "child") events.push(end());
      events.push(
        step("next"),
        end("next"),
        event("session.execution.succeeded", { sessionID: "root" }),
      );
      const { runtime } = runtimeFor(events);
      const result = await executeRun(runtime, run);
      expect(result.error).toBeUndefined();
      expect(result.terminal.payload.state).toBe("completed");
      expect(result.terminal.payload.context).toMatchObject({
        taskId: 143,
        externalKey: "REHOR-143",
        workType: "new_ticket",
      });
      expect(
        new Set(
          completed(result.events)
            .filter((e) => e.payload.isError !== true)
            .map((e) => e.payload.toolUseId),
        ).size,
      ).toBe(fetch ? 3 : 2);
      expect(
        new Set(
          completed(result.events)
            .filter((e) => e.payload.isError === true)
            .map((e) => e.payload.toolUseId),
        ).size,
      ).toBe(1);
      expect(
        completed(result.events)
          .filter((e) => e.payload.bridgeId && e.payload.isError === true)
          .at(-1)?.payload.error,
      ).toEqual({ message: "failed" });
      expect(result.events.map((e) => e.sequence)).toEqual(result.events.map((_, i) => i + 1));
    },
  );

  it("reconciles final bridge results without replaying completed calls or atomically aborting the finished batch", async () => {
    const first = call(0, "completed", { content: resultContent });
    const second = call(1, "running", {
      name: "bot-memory_task_update",
      input: { ...input, status: "pr_open" },
    });
    const { runtime } = runtimeFor(
      [step(), ...opened(), tool("progress", { metadata: metadata([first, second]) })],
      [
        { id: "idle", type: "idle", outcome: "succeeded", time: { created: 100 } },
        projected(metadata([first, { ...second, status: "completed", content: { task_id: 143 } }])),
      ],
      new Error("stream disconnected"),
    );
    const result = await executeRun(runtime, run);
    expect(result.terminal.payload).toMatchObject({ state: "completed", context: { taskId: 143 } });
    expect(completed(result.events)).toHaveLength(2);
    expect(new Set(completed(result.events).map((e) => e.payload.toolUseId)).size).toBe(2);
  });

  it("cancels a pending nested operation without promoting outer or nested work to success", async () => {
    const controller = new AbortController();
    const costs: CostRecord[] = [];
    const projection = new LegacyCompatibilityProjection({
      costs: {
        write: (record) => {
          costs.push(record);
        },
      },
    });
    const { runtime, reads } = runtimeFor([
      step("priced"),
      end("priced"),
      step(),
      ...opened(),
      tool("progress", { metadata: metadata([call(0)]) }),
      tool("success", { metadata: metadata([call(0, "completed", { content: resultContent })]) }),
    ]);
    const result = await executeRun(runtime, run, {
      signal: controller.signal,
      projection: {
        onEvent: async (e, r) => {
          await projection.onEvent(e, r);
          if (e.payload.codeMode === true && e.payload.state === "started")
            controller.abort("cancel nested operation");
        },
        onTerminal: (e, r) => projection.onTerminal(e, r),
      },
    });
    expect(result.terminal.payload.state).toBe("cancelled");
    expect(completed(result.events)).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
    expect(costs[0]).toMatchObject({ costUsd: 0.25, costIncomplete: true });
    expect((result.terminal.payload.context as { taskId?: number })?.taskId).toBeUndefined();
  });
});
