import { describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import type { RehorEvent, RehorRun } from "../src/domain";
import { LegacyCompatibilityProjection } from "../src/projections/compatibility";
import { createDefaultRuntimeRegistry, executeSelectedRun } from "../src/runtime-factory";
import { ClaudeAgentRuntime } from "../src/runtimes/claude-agent";

const run: RehorRun = {
  schemaVersion: "1",
  runId: "run-01",
  attemptId: "attempt-01",
  instanceId: "instance-01",
  label: "hcc-ai-framework",
  workflowId: "jira-sprint",
  prompt: "Handle the preflight data.",
  task: { id: "task-01", key: "REHOR-140" },
  worktree: {
    path: "/work/rehor",
    repository: "https://github.com/OpenShift-Fleet/rehor.git",
    snapshot: { ref: "refs/heads/rehor-140", commitSha: "abc123", dirty: false },
  },
  instructionHash: { algorithm: "sha256", value: "1".repeat(64) },
  configHash: { algorithm: "sha256", value: "2".repeat(64) },
  policyHash: { algorithm: "sha256", value: "3".repeat(64) },
  provider: { id: "vertex", requestedModel: "claude-opus-4-6" },
  limits: { timeoutMs: 60_000, maxTurns: 20 },
  preflightPayloadRef: "memory://preflight/run-01",
};

function sdkQuery(messages: unknown[]): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const iterator = (async function* (): AsyncGenerator<unknown> {
    for (const message of messages) yield message;
  })();
  return Object.assign(iterator, { close });
}

async function collect(events: AsyncIterable<RehorEvent>): Promise<RehorEvent[]> {
  const result: RehorEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function sdkMessages(): unknown[] {
  return [
    {
      type: "system",
      subtype: "init",
      model: "claude-opus-4-6",
      cwd: "/work/rehor",
      tools: ["Bash", "Read"],
      mcp_servers: [{ name: "mcp-atlassian", status: "connected" }],
      permissionMode: "acceptEdits",
      session_id: "session-01",
      uuid: "sdk-01",
    },
    {
      type: "assistant",
      message: {
        model: "claude-opus-4-6",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
        content: [
          { type: "text", text: "I will inspect the issue." },
          {
            type: "tool_use",
            id: "tool-01",
            name: "mcp__mcp-atlassian__jira_get_issue",
            input: { key: "REHOR-140" },
          },
        ],
      },
      session_id: "session-01",
      uuid: "sdk-02",
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-01",
            content: [{ type: "text", text: '{"id":42,"external_key":"REHOR-140"}' }],
          },
        ],
      },
      session_id: "session-01",
      uuid: "sdk-03",
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Opened PR for REHOR-140",
      num_turns: 3,
      duration_ms: 321,
      total_cost_usd: 0.42,
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 100,
          outputTokens: 20,
          thinkingTokens: 4,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 5,
          costUSD: 0.42,
        },
      },
      session_id: "session-01",
      uuid: "sdk-04",
    },
  ];
}

describe("ClaudeAgentRuntime", () => {
  it("configures the SDK and normalizes representative Claude cycles", async () => {
    let captured: Record<string, unknown> | undefined;
    queryMock.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      captured = options;
      return sdkQuery(sdkMessages());
    });

    const registry = createDefaultRuntimeRegistry({
      sdkVersion: "0.3.270",
      allowedTools: ["Bash", "Read", "Edit"],
      mcpServers: {
        "mcp-atlassian": { type: "http", url: "http://jira-mcp" },
      },
    });
    const costs: Array<Record<string, unknown>> = [];
    const projection = new LegacyCompatibilityProjection({
      costs: { write: (record) => void costs.push(record as unknown as Record<string, unknown>) },
    });
    const result = await executeSelectedRun(registry, { runtimeId: "claude" }, run, { projection });
    const events = [...result.events];

    expect(captured).toMatchObject({
      cwd: "/work/rehor",
      model: "claude-opus-4-6",
      maxTurns: 20,
      permissionMode: "acceptEdits",
      allowedTools: ["Bash", "Read", "Edit"],
      mcpServers: { "mcp-atlassian": { type: "http", url: "http://jira-mcp" } },
    });
    expect(events.map(({ kind }) => kind)).toEqual([
      "run",
      "run",
      "model",
      "tool",
      "tool",
      "usage",
      "terminal",
    ]);
    expect(events.find(({ kind }) => kind === "model")).not.toHaveProperty("message");
    expect(events.find(({ kind }) => kind === "usage")?.payload).toMatchObject({
      requestedModel: "claude-opus-4-6",
      returnedModel: "claude-opus-4-6",
      tokenCounts: { input: 100, output: 20, reasoning: 4, cacheRead: 10, cacheWrite: 5 },
      final: true,
      estimated: true,
    });
    expect(events.at(-1)?.payload).toMatchObject({
      state: "completed",
      resultText: "Opened PR for REHOR-140",
      turns: 3,
      context: { taskId: 42 },
    });
    expect(result.capabilities?.runtimeVersion).toBe("0.3.270");
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      sessionId: "claude-agent-sdk:session-01",
      model: "claude-opus-4-6",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      costUsd: 0.42,
    });
  });

  it("turns SDK failures into a failed terminal event and closes the query", async () => {
    const close = vi.fn();
    const iterator = (async function* (): AsyncGenerator<unknown> {
      yield { type: "system", subtype: "init", session_id: "session-02", uuid: "sdk-init" };
      throw new Error("SDK unavailable");
    })();
    queryMock.mockReturnValue(Object.assign(iterator, { close }));

    const runtime = new ClaudeAgentRuntime();
    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(run, new AbortController().signal));

    expect(events.at(-1)?.payload).toMatchObject({ state: "failed", reason: "SDK unavailable" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves partial usage and maps timeout aborts", async () => {
    let sdkSignal!: AbortSignal;
    const close = vi.fn();
    const iterator = (async function* (): AsyncGenerator<unknown> {
      yield {
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          usage: { input_tokens: 7, output_tokens: 3 },
          content: [{ type: "text", text: "working" }],
        },
        session_id: "session-03",
        uuid: "sdk-partial",
      };
      await new Promise<void>((resolve) =>
        sdkSignal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new Error("aborted by SDK");
    })();
    queryMock.mockImplementation(
      ({ options }: { options: { abortController: AbortController } }) => {
        sdkSignal = options.abortController.signal;
        return Object.assign(iterator, { close });
      },
    );

    const runtime = new ClaudeAgentRuntime();
    await runtime.start(new AbortController().signal);
    const controller = new AbortController();
    const promise = collect(runtime.run(run, controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort("timeout");
    const events = await promise;

    expect(events.find(({ kind }) => kind === "usage")?.payload).toMatchObject({
      partial: true,
      final: false,
      incomplete: true,
      tokenCounts: { input: 7, output: 3 },
    });
    expect(events.at(-1)?.payload).toMatchObject({ state: "timed_out", reason: "timeout" });
    expect(close).toHaveBeenCalledOnce();
  });
});
