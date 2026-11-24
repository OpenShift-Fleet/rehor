import { afterEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { toLegacyCostEntry } from "../src/adapters/compatibility";
import type { RehorEvent, RehorRun } from "../src/domain";
import type { CostRecord } from "../src/ports/compatibility";
import { LegacyCompatibilityProjection } from "../src/projections/compatibility";
import { createDefaultRuntimeRegistry, executeSelectedRun } from "../src/runtime-factory";
import { ClaudeAgentRuntime } from "../src/runtimes/claude-agent";
import { postToolUseHook } from "./contract/runtime-harnesses";

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
  limits: { timeoutMs: 60_000, budgetUsd: 5 },
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
        "claude-haiku-4-5": {
          inputTokens: 30,
          outputTokens: 4,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
          costUSD: 0.08,
        },
      },
      session_id: "session-01",
      uuid: "sdk-04",
    },
  ];
}

describe("ClaudeAgentRuntime", () => {
  afterEach(() => {
    queryMock.mockReset();
    vi.unstubAllEnvs();
  });

  it("projects actual Claude SDK usage as estimated without changing amounts or token accounting", async () => {
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
    const costs: CostRecord[] = [];
    const projection = new LegacyCompatibilityProjection({
      costs: { write: (record) => void costs.push(record) },
    });
    const result = await executeSelectedRun(registry, { runtimeId: "claude" }, run, { projection });
    const events = [...result.events];

    expect(captured).toMatchObject({
      cwd: "/work/rehor",
      model: "claude-opus-4-6",
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
      "usage",
      "terminal",
    ]);
    const modelEvent = events.find(({ kind }) => kind === "model");
    expect(modelEvent?.payload).not.toHaveProperty("message");
    const usageEvents = events.filter(({ kind }) => kind === "usage");
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]?.payload).toMatchObject({
      requestedModel: "claude-opus-4-6",
      returnedModel: "claude-opus-4-6",
      tokenCounts: { input: 100, output: 20, reasoning: 4, cacheRead: 10, cacheWrite: 5 },
      final: true,
      estimated: true,
      cost: { amount: 0.42, currency: "USD", source: "estimated" },
    });
    expect(usageEvents[1]?.payload).toMatchObject({
      requestedModel: "claude-opus-4-6",
      returnedModel: "claude-haiku-4-5",
      tokenCounts: { input: 30, output: 4, cacheRead: 2, cacheWrite: 1 },
      final: true,
      estimated: true,
      cost: { amount: 0.08, currency: "USD", source: "estimated" },
    });
    expect(events.at(-1)?.payload).toMatchObject({
      state: "completed",
      resultText: "Opened PR for REHOR-140",
      turns: 3,
      context: { taskId: 42, summary: "Opened PR for REHOR-140" },
    });
    expect(result.capabilities?.runtimeVersion).toBe("0.3.270");
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      sessionId: "claude-agent-sdk:session-01",
      model: "claude-opus-4-6",
      inputTokens: 130,
      outputTokens: 24,
      cacheReadTokens: 12,
      cacheWriteTokens: 6,
      costUsd: 0.5,
      costStatus: "estimated",
      costIncomplete: false,
      modelUsage: {
        "claude-opus-4-6": {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
        "claude-haiku-4-5": {
          input_tokens: 30,
          output_tokens: 4,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
      },
    });
    const cost = costs[0];
    if (!cost) throw new Error("Missing projected Claude cost");
    expect(toLegacyCostEntry(cost)).toMatchObject({
      cost_usd: 0.5,
      cost_status: "estimated",
      cost_incomplete: false,
      input_tokens: 130,
      output_tokens: 24, // thinkingTokens are already included in Claude output.
      cache_read_tokens: 12,
      cache_write_tokens: 6,
      model: "claude-opus-4-6",
    });
  });

  it("sanitizes inherited SDK environment variables", async () => {
    const sensitiveValues = {
      GH_TOKEN: "gh-secret",
      GITHUB_TOKEN: "github-secret",
      GITLAB_TOKEN: "gitlab-secret",
      JIRA_API_TOKEN: "jira-api-secret",
      JIRA_MCP_TOKEN: "jira-mcp-secret",
      JIRA_USERNAME: "jira-user",
      GPG_PRIVATE_KEY_B64: "private-key",
      GPG_SIGNING_KEY: "signing-key",
      SSO_USERNAME: "sso-user",
      SSO_PASSWORD: "sso-password",
      REHOR_MODEL_PROXY_TOKEN: "proxy-secret",
      GIT_AUTHOR_NAME: "author",
      GIT_AUTHOR_EMAIL: "author@example.com",
      GIT_COMMITTER_NAME: "committer",
      GIT_COMMITTER_EMAIL: "committer@example.com",
    };
    for (const [name, value] of Object.entries(sensitiveValues)) vi.stubEnv(name, value);
    vi.stubEnv("PATH", "/safe/path");
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/work/.gitconfig");

    let captured: Record<string, unknown> | undefined;
    queryMock.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      captured = options;
      return sdkQuery([
        {
          type: "result",
          subtype: "success",
          result: "done",
          session_id: "session-sanitized",
          uuid: "sdk-sanitized",
        },
      ]);
    });

    const runtime = new ClaudeAgentRuntime();
    await runtime.start(new AbortController().signal);
    await collect(runtime.run(run, new AbortController().signal));

    const environment = captured?.env as Record<string, string | undefined>;
    expect(environment).toMatchObject({
      PATH: "/safe/path",
      GIT_CONFIG_GLOBAL: "/work/.gitconfig",
    });
    for (const name of Object.keys(sensitiveValues)) {
      expect(environment).not.toHaveProperty(name);
    }
  });

  it("falls back to top-level usage when modelUsage is empty", async () => {
    queryMock.mockReturnValue(
      sdkQuery([
        {
          type: "result",
          subtype: "success",
          result: "done",
          usage: { input_tokens: 11, output_tokens: 7 },
          modelUsage: {},
          total_cost_usd: 0.15,
          session_id: "session-usage-fallback",
          uuid: "sdk-usage-fallback",
        },
      ]),
    );

    const runtime = new ClaudeAgentRuntime();
    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(run, new AbortController().signal));
    const usageEvents = events.filter(({ kind }) => kind === "usage");

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.payload).toMatchObject({
      requestedModel: "claude-opus-4-6",
      returnedModel: "claude-opus-4-6",
      tokenCounts: { input: 11, output: 7 },
      cost: { amount: 0.15, currency: "USD" },
      final: true,
    });
  });

  it("turns SDK failures into a failed terminal event and closes the query", async () => {
    const close = vi.fn();
    const iterator = (async function* (): AsyncGenerator<unknown> {
      yield { type: "system", subtype: "init", session_id: "session-02", uuid: "sdk-init" };
      throw new Error("SDK unavailable token=abc");
    })();
    queryMock.mockReturnValue(Object.assign(iterator, { close }));

    const runtime = new ClaudeAgentRuntime();
    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(run, new AbortController().signal));

    expect(events.at(-1)?.payload).toMatchObject({
      state: "failed",
      reason: "SDK unavailable token=[REDACTED]",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("queues coordinator policy notices and flushes them through the PostToolUse hook", async () => {
    let captured: Record<string, unknown> | undefined;
    const hookResults: Record<string, unknown>[] = [];
    queryMock.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
      captured = options;
      const postToolUse = postToolUseHook(options);
      return Object.assign(
        (async function* (): AsyncGenerator<unknown> {
          for (let index = 1; index <= 3; index += 1) {
            const toolUseId = `budget-tool-${index}`;
            yield {
              type: "assistant",
              message: {
                model: run.provider.requestedModel,
                content: [
                  { type: "tool_use", id: toolUseId, name: "Bash", input: { command: "true" } },
                ],
              },
              session_id: "session-budget",
            };
            if (!postToolUse) throw new Error("PostToolUse hook missing");
            hookResults.push(await postToolUse({}, toolUseId, {}));
            yield {
              type: "user",
              message: {
                content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
              },
              session_id: "session-budget",
            };
          }
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "done",
            num_turns: 3,
            session_id: "session-budget",
          };
        })(),
        { close: vi.fn() },
      );
    });

    const warning =
      "COST BUDGET WARNING: $3.75/5 used (~$1.25 remaining). Save progress soon via task_update " +
      "(summary + metadata with last_step, files_changed, next_step). Prioritize completing the current step.";
    const critical =
      "COST BUDGET CRITICAL: $4.5/5 used (~$0.5 remaining). Save progress NOW via task_update with " +
      "current summary, last_step, files_changed, and next_step. Then wrap up or stop.";

    const runtime = new ClaudeAgentRuntime();
    await runtime.start(new AbortController().signal);
    const context: { onPolicyNotice?: (text: string) => void } = {};
    const iterator = runtime
      .run(run, new AbortController().signal, context)
      [Symbol.asyncIterator]();

    await iterator.next(); // run started
    await iterator.next(); // first tool_use: generator suspends before its hook runs
    context.onPolicyNotice?.(warning);
    await iterator.next(); // hook flushes the queued warning with the tool result
    await iterator.next(); // second tool_use
    context.onPolicyNotice?.(critical);
    context.onPolicyNotice?.(warning);
    await iterator.next(); // hook flushes both queued notices joined together
    await iterator.next(); // third tool_use with an empty queue
    const done = await iterator.next(); // tool result, then the SDK result message
    await iterator.next();
    expect(done.done ?? false).toBe(false);

    expect(captured?.maxTurns).toBeUndefined();
    expect(hookResults.map((hook) => hook.systemMessage ?? null)).toEqual([
      warning,
      `${critical}\n\n${warning}`,
      null,
    ]);
  });

  it("reports no SDK-level turn enforcement", async () => {
    queryMock.mockReturnValue(sdkQuery(sdkMessages()));

    const result = await executeSelectedRun(
      createDefaultRuntimeRegistry(),
      { runtimeId: "claude" },
      run,
    );

    expect(result.capabilities?.enforcesTurnLimit).toBe(false);
    expect(result.terminal.payload.state).toBe("completed");
  });

  it("preserves partial usage through coordinator timeout handling", async () => {
    let sdkSignal: AbortSignal | undefined;
    let resolveAbortListenerReady!: () => void;
    const abortListenerReady = new Promise<void>((resolve) => {
      resolveAbortListenerReady = resolve;
    });
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
      const signal = sdkSignal;
      if (!signal) throw new Error("SDK signal not initialized");
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        resolveAbortListenerReady();
      });
      throw new Error("aborted by SDK");
    })();
    queryMock.mockImplementation(
      ({ options }: { options: { abortController: AbortController } }) => {
        sdkSignal = options.abortController.signal;
        return Object.assign(iterator, { close });
      },
    );

    const costs: Array<Record<string, unknown>> = [];
    const projection = new LegacyCompatibilityProjection({
      costs: { write: (record) => void costs.push(record as unknown as Record<string, unknown>) },
    });
    const controller = new AbortController();
    const promise = executeSelectedRun(
      createDefaultRuntimeRegistry(),
      { runtimeId: "claude" },
      run,
      { signal: controller.signal, projection },
    );
    await abortListenerReady;
    controller.abort({ kind: "timed_out", reason: "timeout" });
    const result = await promise;
    const usage = result.events.find(({ kind }) => kind === "usage");

    expect(usage?.payload).toMatchObject({
      partial: true,
      final: false,
      incomplete: true,
      tokenCounts: { input: 7, output: 3 },
    });
    expect(result.terminal.payload).toMatchObject({ state: "timed_out", reason: "timeout" });
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(close).toHaveBeenCalledOnce();
  });

  it("sums usage across API responses when a run fails before its result", async () => {
    const assistant = (id: string, usage: Record<string, number>, text: string) => ({
      type: "assistant",
      message: {
        id,
        model: "claude-opus-4-6",
        usage,
        content: [{ type: "text", text }],
      },
      session_id: "session-usage",
      uuid: `sdk-${id}-${text}`,
    });
    const iterator = (async function* (): AsyncGenerator<unknown> {
      // One API response streamed as two content-block messages repeats its usage.
      yield assistant("msg-1", { input_tokens: 100, output_tokens: 5 }, "first block");
      yield assistant("msg-1", { input_tokens: 100, output_tokens: 20 }, "second block");
      yield assistant(
        "msg-2",
        { input_tokens: 150, output_tokens: 30, cache_read_input_tokens: 90 },
        "next turn",
      );
      throw new Error("SDK subprocess exited");
    })();
    queryMock.mockReturnValue(Object.assign(iterator, { close: vi.fn() }));

    const runtime = new ClaudeAgentRuntime();
    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(run, new AbortController().signal));
    const usage = events.filter(({ kind }) => kind === "usage");

    expect(usage).toHaveLength(1);
    expect(usage[0]?.payload).toMatchObject({
      returnedModel: "claude-opus-4-6",
      tokenCounts: { input: 250, output: 50, cacheRead: 90 },
      partial: true,
      incomplete: true,
    });
    expect(events.at(-1)?.payload).toMatchObject({ state: "failed" });
  });

  it("reports summed usage when the SDK stream ends without a result", async () => {
    queryMock.mockReturnValue(
      sdkQuery([
        {
          type: "assistant",
          message: {
            id: "msg-1",
            model: "claude-opus-4-6",
            usage: { input_tokens: 10, output_tokens: 1 },
            content: [],
          },
        },
        {
          type: "assistant",
          message: {
            id: "msg-2",
            model: "claude-opus-4-6",
            usage: { input_tokens: 12, output_tokens: 2 },
            content: [],
          },
        },
      ]),
    );

    const runtime = new ClaudeAgentRuntime();
    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(run, new AbortController().signal));

    expect(events.find(({ kind }) => kind === "usage")?.payload).toMatchObject({
      tokenCounts: { input: 22, output: 3 },
      partial: true,
    });
    expect(events.at(-1)?.payload).toMatchObject({
      state: "failed",
      reason: "agent runtime ended without a result",
    });
  });

  it("records a process shutdown as interrupted, not cancelled", async () => {
    let sdkSignal: AbortSignal | undefined;
    let resolveWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      resolveWaiting = resolve;
    });
    const iterator = (async function* (): AsyncGenerator<unknown> {
      yield { type: "system", subtype: "init", session_id: "session-04", uuid: "sdk-init" };
      const signal = sdkSignal;
      if (!signal) throw new Error("SDK signal not initialized");
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        resolveWaiting();
      });
      throw new Error("aborted by SDK");
    })();
    queryMock.mockImplementation(
      ({ options }: { options: { abortController: AbortController } }) => {
        sdkSignal = options.abortController.signal;
        return Object.assign(iterator, { close: vi.fn() });
      },
    );

    const shutdown = new AbortController();
    const promise = executeSelectedRun(
      createDefaultRuntimeRegistry(),
      { runtimeId: "claude" },
      run,
      {
        shutdownSignal: shutdown.signal,
      },
    );
    await waiting;
    shutdown.abort("SIGTERM");
    const result = await promise;

    expect(result.terminal.payload).toMatchObject({ state: "interrupted" });
    expect(result.error).toBeUndefined();
  });

  it("reports runtime stop as failed", async () => {
    let resolveWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      resolveWaiting = resolve;
    });
    queryMock.mockImplementation(
      ({ options }: { options: { abortController: AbortController } }) => {
        const signal = options.abortController.signal;
        const iterator = (async function* (): AsyncGenerator<unknown> {
          yield { type: "system", subtype: "init", session_id: "session-05", uuid: "sdk-init" };
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
            resolveWaiting();
          });
          throw new Error("aborted by SDK");
        })();
        return Object.assign(iterator, { close: vi.fn() });
      },
    );

    const runtime = new ClaudeAgentRuntime();
    await runtime.start(new AbortController().signal);
    const promise = collect(runtime.run(run, new AbortController().signal));
    await waiting;
    await runtime.stop();
    const events = await promise;

    expect(events.at(-1)?.payload).toMatchObject({ state: "failed" });
  });
});
