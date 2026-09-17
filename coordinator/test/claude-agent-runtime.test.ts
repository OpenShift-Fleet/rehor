import { afterEach, describe, expect, it, vi } from "vitest";

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
    });
    expect(usageEvents[1]?.payload).toMatchObject({
      requestedModel: "claude-opus-4-6",
      returnedModel: "claude-haiku-4-5",
      tokenCounts: { input: 30, output: 4, cacheRead: 2, cacheWrite: 1 },
      final: true,
      estimated: true,
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
  });

  it("sanitizes inherited SDK environment variables", async () => {
    const sensitiveValues = {
      GH_TOKEN: "gh-secret",
      GITHUB_TOKEN: "github-secret",
      GITLAB_TOKEN: "gitlab-secret",
      GPG_PRIVATE_KEY_B64: "private-key",
      GPG_SIGNING_KEY: "signing-key",
      SSO_USERNAME: "sso-user",
      SSO_PASSWORD: "sso-password",
      GIT_AUTHOR_NAME: "author",
      GIT_AUTHOR_EMAIL: "author@example.com",
      GIT_COMMITTER_NAME: "committer",
      GIT_COMMITTER_EMAIL: "committer@example.com",
    };
    for (const [name, value] of Object.entries(sensitiveValues)) vi.stubEnv(name, value);
    vi.stubEnv("PATH", "/safe/path");

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
    expect(environment).toMatchObject({ PATH: "/safe/path" });
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
      throw new Error("SDK unavailable");
    })();
    queryMock.mockReturnValue(Object.assign(iterator, { close }));

    const runtime = new ClaudeAgentRuntime();
    await runtime.start(new AbortController().signal);
    const events = await collect(runtime.run(run, new AbortController().signal));

    expect(events.at(-1)?.payload).toMatchObject({ state: "failed", reason: "SDK unavailable" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("counts successful tools for detailed turn-budget policy events", async () => {
    type TestHook = (...args: unknown[]) => Promise<Record<string, unknown>>;
    type TestSdkOptions = {
      hooks: Record<string, Array<{ hooks: TestHook[] }>>;
    };
    const metrics: Array<Record<string, unknown>> = [];
    queryMock.mockImplementation(({ options }: { options: TestSdkOptions }) => {
      const postToolUse = options.hooks.PostToolUse?.[0]?.hooks[0];
      const postToolUseFailure = options.hooks.PostToolUseFailure?.[0]?.hooks[0];
      if (!postToolUse || !postToolUseFailure) throw new Error("turn-budget hooks not configured");
      const hookResults: Array<Promise<Record<string, unknown>>> = [];
      for (let index = 0; index < 5; index += 1) {
        hookResults.push(postToolUse({}, `success-${index}`, {}));
      }
      hookResults.push(postToolUseFailure({}, "failure-1", {}));
      hookResults.push(postToolUse({}, "success-5", {}));
      const close = vi.fn();
      const iterator = (async function* (): AsyncGenerator<unknown> {
        await Promise.all(hookResults);
        yield {
          type: "result",
          subtype: "success",
          result: "Saved progress",
          num_turns: 6,
          session_id: "session-budget",
          uuid: "sdk-budget",
        };
      })();
      return Object.assign(iterator, { close });
    });

    const projection = new LegacyCompatibilityProjection({
      metrics: {
        observe: (point) => void metrics.push(point as unknown as Record<string, unknown>),
      },
    });
    const budgetRun = {
      ...run,
      runId: "run-budget",
      attemptId: "attempt-budget",
      limits: { ...run.limits, maxTurns: 8 },
    };
    const result = await executeSelectedRun(
      createDefaultRuntimeRegistry(),
      { runtimeId: "claude" },
      budgetRun,
      { projection },
    );
    const policies = result.events.filter(({ kind }) => kind === "policy");

    expect(policies).toHaveLength(1);
    expect(policies[0]?.payload).toMatchObject({
      state: "warning",
      usedTurns: 6,
      maxTurns: 8,
      message: expect.stringContaining(
        "Save progress via task_update soon (summary + metadata with last_step, files_changed, next_step)",
      ),
    });
    expect(metrics).toContainEqual({
      name: "devbot_turn_budget_event_total",
      value: 1,
      labels: { label: run.label, level: "warning" },
    });
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
    controller.abort("timeout");
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
});
