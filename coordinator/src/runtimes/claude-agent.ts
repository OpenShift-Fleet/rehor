import { query } from "@anthropic-ai/claude-agent-sdk";

import {
  createEventFactory,
  type RehorEvent,
  type RehorRun,
  type RuntimeCapabilities,
  type TokenCounts,
  type Usage,
} from "../domain";
import type { AgentRuntime, McpServerConfig } from "../ports";
import type { AgentRuntimeFactory } from "../runtime-factory";

export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "auto";
export type ClaudeSettingSource = "user" | "project" | "local";
export type ClaudeMcpServer = McpServerConfig;

/** Configuration owned by the adapter; Claude SDK types do not cross this boundary. */
export interface ClaudeAgentRuntimeOptions {
  sdkVersion?: string;
  configVersion?: string;
  policyVersion?: string;
  allowedTools?: readonly string[];
  mcpServers?: Readonly<Record<string, ClaudeMcpServer>>;
  settingSources?: readonly ClaudeSettingSource[];
  permissionMode?: ClaudePermissionMode;
  persistSession?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  additionalDirectories?: readonly string[];
}

const CAPABILITIES: RuntimeCapabilities = {
  runtimeId: "claude-agent-sdk",
  runtimeVersion: "unknown",
  configVersion: "claude-agent-sdk-options-v1",
  streaming: true,
  interruption: true,
  childSessions: true,
  toolSupport: true,
  mcpSupport: true,
  structuredOutput: true,
  usageGuarantee: "partial-and-final",
};

const NO_WORK_PATTERNS = [
  "NO_WORK_FOUND",
  "no work found",
  "no work available",
  "nothing to do",
  "nothing to pick up",
  "no tickets",
  "no unassigned",
  "no assigned tickets",
  "0 unassigned",
];

const SANITIZED_ENV_VARS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "GPG_PRIVATE_KEY_B64",
  "GPG_SIGNING_KEY",
  "SSO_USERNAME",
  "SSO_PASSWORD",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
]);

type JsonObject = Record<string, unknown>;
type RuntimeQuery = { close(): void };
type RuntimeState = {
  controller: AbortController;
  query?: RuntimeQuery;
  stopped: boolean;
};

type WorkContext = {
  taskId?: number;
  externalKey?: string;
  repository?: string;
  workType?: string;
  summary?: string;
};

type UsageSnapshot = {
  model: string;
  counts: TokenCounts;
  cost?: number;
};

/** Claude Agent SDK implementation of the provider-neutral AgentRuntime port. */
export class ClaudeAgentRuntime implements AgentRuntime {
  private readonly options: ClaudeAgentRuntimeOptions;
  private started = false;
  private stopped = false;
  private active?: RuntimeState;

  constructor(options: ClaudeAgentRuntimeOptions = {}) {
    this.options = options;
  }

  async start(signal: AbortSignal): Promise<RuntimeCapabilities> {
    if (this.stopped) throw new Error("stopped runtime must not be restarted");
    if (signal.aborted) throw abortError(signal.reason);
    this.started = true;
    return {
      ...CAPABILITIES,
      runtimeVersion: this.options.sdkVersion ?? CAPABILITIES.runtimeVersion,
      configVersion: this.options.configVersion ?? CAPABILITIES.configVersion,
    };
  }

  run(input: RehorRun, signal: AbortSignal): AsyncIterable<RehorEvent> {
    const runtime = this;

    return (async function* stream(): AsyncGenerator<RehorEvent> {
      if (!runtime.started) throw new Error("runtime must be started before run");
      if (runtime.stopped) throw new Error("stopped runtime must not stream events");
      if (runtime.active) throw new Error("runtime already has an active run");

      const startedAt = Date.now();
      const controller = new AbortController();
      const state: RuntimeState = { controller, stopped: false };
      runtime.active = state;
      const createEvent = createEventFactory(
        input,
        runtime.options.policyVersion ?? "claude-agent-sdk-v1",
      );
      const context: WorkContext = {};
      const usage = new Map<string, UsageSnapshot>();
      const toolStarts = new Map<string, number>();
      const pendingPolicyEvents: RehorEvent[] = [];
      let sessionRef: string | undefined;
      let turns = 0;
      let terminalEmitted = false;

      const onAbort = (): void => {
        if (!controller.signal.aborted) controller.abort(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const refFor = (message: unknown): string | undefined => {
        const record = asObject(message);
        const sessionId = stringValue(record?.session_id);
        if (sessionId) sessionRef = `claude-agent-sdk:${sessionId}`;
        return sessionRef;
      };

      const makeSdkEvent = (
        kind: string,
        payload: JsonObject,
        message: unknown,
        model?: string,
      ): RehorEvent => {
        const record = asObject(message);
        const uuid = stringValue(record?.uuid);
        return createEvent(kind, payload, {
          model: model ?? input.provider.requestedModel,
          ...(sessionRef ? { runtimeSessionRef: sessionRef } : {}),
          ...(uuid
            ? { rawEventRef: { reference: `claude-agent-sdk:${uuid}`, redacted: true } }
            : {}),
        });
      };

      const drainPolicyEvents = function* (): Generator<RehorEvent> {
        while (pendingPolicyEvents.length > 0) yield pendingPolicyEvents.shift() as RehorEvent;
      };

      const emitUsage = (
        snapshot: UsageSnapshot,
        partial: boolean,
        incomplete: boolean,
      ): RehorEvent => {
        const payload: Usage = {
          requestedModel: input.provider.requestedModel,
          ...(snapshot.model ? { returnedModel: snapshot.model } : {}),
          tokenCounts: snapshot.counts,
          partial,
          final: !partial,
          estimated: true,
          incomplete,
          ...(snapshot.cost === undefined
            ? {}
            : {
                cost: {
                  amount: Math.max(0, snapshot.cost),
                  currency: "USD",
                  source: "estimated" as const,
                },
              }),
        };
        return makeSdkEvent(
          "usage",
          payload,
          undefined,
          snapshot.model || input.provider.requestedModel,
        );
      };

      const terminal = (
        stateName: "completed" | "failed" | "interrupted" | "cancelled" | "timed_out",
        resultText?: string,
        reason?: string,
        durationMs = Date.now() - startedAt,
      ): RehorEvent => {
        terminalEmitted = true;
        const payload: JsonObject = {
          state: stateName,
          ...(reason ? { reason } : {}),
          ...(resultText ? { resultText } : {}),
          ...(resultText ? { noWork: isNoWork(resultText) } : {}),
          turns,
          durationMs: Math.max(0, durationMs),
          ...(Object.keys(context).length > 0 ? { context } : {}),
        };
        return makeSdkEvent("terminal", payload, undefined);
      };

      try {
        yield createEvent("run", { state: "started" });

        if (signal.aborted) {
          yield terminal(abortState(signal.reason), undefined, abortReason(signal.reason));
          return;
        }

        const sdkQuery = query({
          prompt: input.prompt,
          options: {
            abortController: controller,
            cwd: input.worktree.path,
            model: input.provider.requestedModel,
            maxTurns: input.limits.maxTurns,
            permissionMode: runtime.options.permissionMode ?? "acceptEdits",
            settingSources: [...(runtime.options.settingSources ?? ["project"])],
            mcpServers: toSdkMcpServers(runtime.options.mcpServers ?? {}),
            ...(runtime.options.allowedTools === undefined
              ? {}
              : { allowedTools: [...runtime.options.allowedTools] }),
            persistSession: runtime.options.persistSession ?? true,
            env: sanitizedSdkEnvironment(runtime.options.env),
            ...(runtime.options.additionalDirectories === undefined
              ? {}
              : { additionalDirectories: [...runtime.options.additionalDirectories] }),
            hooks: createHooks(
              input.limits.maxTurns,
              input.label,
              pendingPolicyEvents,
              createEvent,
              toolStarts,
            ),
          },
        });
        state.query = sdkQuery;

        for await (const message of sdkQuery) {
          const reference = refFor(message);

          if (isResultMessage(message)) {
            for (const event of drainPolicyEvents()) yield event;
            const result = asObject(message);
            const resultUsage = collectResultUsage(result, input.provider.requestedModel);
            for (const snapshot of resultUsage) {
              usage.set(snapshot.model, snapshot);
              yield emitUsage(snapshot, false, result?.is_error === true);
            }
            if (resultUsage.length === 0) {
              for (const snapshot of usage.values())
                yield emitUsage(snapshot, false, result?.is_error === true);
            }

            turns = numberValue(result?.num_turns) ?? turns;
            const resultText = stringValue(result?.result);
            if (!context.summary && resultText) {
              context.summary = lastMeaningfulLine(resultText);
            }
            const successful = result?.subtype === "success" && result?.is_error !== true;
            yield terminal(
              successful ? "completed" : "failed",
              resultText,
              successful ? undefined : (stringValue(result?.subtype) ?? "agent runtime failed"),
              numberValue(result?.duration_ms) ?? Date.now() - startedAt,
            );
            return;
          }

          for (const event of translateMessage(message, {
            makeEvent: (kind, payload, model) => makeSdkEvent(kind, payload, message, model),
            reference,
            context,
            toolStarts,
            usage,
            requestedModel: input.provider.requestedModel,
          })) {
            yield event;
          }
          for (const event of drainPolicyEvents()) yield event;
        }

        if (!terminalEmitted) {
          const wasAborted = signal.aborted || controller.signal.aborted;
          yield terminal(
            wasAborted
              ? abortState(signal.aborted ? signal.reason : controller.signal.reason)
              : "failed",
            undefined,
            wasAborted
              ? abortReason(signal.aborted ? signal.reason : controller.signal.reason)
              : "agent runtime ended without a result",
          );
        }
      } catch (error) {
        for (const event of drainPolicyEvents()) yield event;
        for (const snapshot of usage.values()) yield emitUsage(snapshot, true, true);
        if (!terminalEmitted) {
          const errorReason = errorMessage(error);
          const wasAborted = signal.aborted || controller.signal.aborted || isAbortError(error);
          const reason = wasAborted
            ? abortReason(signal.aborted ? signal.reason : controller.signal.reason)
            : errorReason;
          yield terminal(
            wasAborted
              ? abortState(signal.aborted ? signal.reason : controller.signal.reason)
              : "failed",
            undefined,
            reason,
          );
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        const query = state.query;
        state.query = undefined;
        if (query) {
          try {
            query.close();
          } catch {
            // Query cleanup is best effort; the SDK owns subprocess teardown.
          }
        }
        runtime.active = undefined;
      }
    })();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (!this.active) return;
    this.active.stopped = true;
    if (!this.active.controller.signal.aborted) this.active.controller.abort("runtime stopped");
    const query = this.active.query;
    this.active.query = undefined;
    try {
      query?.close();
    } catch {
      // Stop remains idempotent even when the SDK query has already closed.
    }
  }
}

export const CLAUDE_RUNTIME_ID = "claude";

/** Factory used by the coordinator registry for the production Claude path. */
export function createClaudeAgentRuntimeFactory(
  options: ClaudeAgentRuntimeOptions = {},
): AgentRuntimeFactory {
  return {
    runtimeId: CLAUDE_RUNTIME_ID,
    create: () => new ClaudeAgentRuntime(options),
  };
}

function createHooks(
  maxTurns: number,
  label: string,
  pendingEvents: RehorEvent[],
  createEvent: ReturnType<typeof createEventFactory>,
  toolStarts: Map<string, number>,
): Record<string, Array<{ hooks: Array<(...args: unknown[]) => Promise<JsonObject>> }>> {
  let count = 0;
  let warned = false;
  let critical = false;
  const warningAt = Math.max(1, Math.floor(maxTurns * 0.75));
  const criticalAt = Math.max(1, Math.floor(maxTurns * 0.9));

  const hook = async (): Promise<JsonObject> => {
    count += 1;
    const remaining = Math.max(0, maxTurns - count);
    if (count >= criticalAt && !critical) {
      critical = true;
      pendingEvents.push(
        createEvent("policy", {
          state: "critical",
          label,
          usedTurns: count,
          maxTurns,
          message:
            `TURN BUDGET CRITICAL: ~${count}/${maxTurns} tool calls used, ` +
            `~${remaining} remaining. You MUST save progress NOW via ` +
            "task_update with current summary, last_step, files_changed, and next_step. " +
            "Then wrap up or stop.",
        }),
      );
      return {
        systemMessage:
          `TURN BUDGET CRITICAL: ~${count}/${maxTurns} tool calls used, ` +
          `~${remaining} remaining. You MUST save progress NOW via ` +
          "task_update with current summary, last_step, files_changed, and next_step. " +
          "Then wrap up or stop.",
      };
    }
    if (count >= warningAt && !warned) {
      warned = true;
      pendingEvents.push(
        createEvent("policy", {
          state: "warning",
          label,
          usedTurns: count,
          maxTurns,
          message:
            `TURN BUDGET WARNING: ~${count}/${maxTurns} tool calls used, ` +
            `~${remaining} remaining. Save progress via task_update soon ` +
            "(summary + metadata with last_step, files_changed, next_step). " +
            "Prioritize completing current step and saving state.",
        }),
      );
      return {
        systemMessage:
          `TURN BUDGET WARNING: ~${count}/${maxTurns} tool calls used, ` +
          `~${remaining} remaining. Save progress via task_update soon ` +
          "(summary + metadata with last_step, files_changed, next_step). " +
          "Prioritize completing current step and saving state.",
      };
    }
    return {};
  };

  const failedToolCleanup = async (...args: unknown[]): Promise<JsonObject> => {
    const input = asObject(args[0]);
    const toolUseId = stringValue(args[1]) ?? stringValue(input?.tool_use_id);
    if (toolUseId) toolStarts.delete(toolUseId);
    return {};
  };

  return {
    // Match Python: failed tool calls clean up timing state but do not consume
    // a turn-budget count.
    PostToolUse: [{ hooks: [hook] }],
    PostToolUseFailure: [{ hooks: [failedToolCleanup] }],
  };
}

function translateMessage(
  message: unknown,
  state: {
    makeEvent: (kind: string, payload: JsonObject, model?: string) => RehorEvent;
    reference?: string;
    context: WorkContext;
    toolStarts: Map<string, number>;
    usage: Map<string, UsageSnapshot>;
    requestedModel: string;
  },
): RehorEvent[] {
  const record = asObject(message);
  if (!record) return [];
  const type = stringValue(record.type);

  if (type === "system") {
    const subtype = stringValue(record.subtype) ?? "system";
    if (subtype === "init") {
      const servers = Array.isArray(record.mcp_servers)
        ? record.mcp_servers.map((server) => {
            const value = asObject(server);
            return {
              name: stringValue(value?.name) ?? "unknown",
              status: stringValue(value?.status) ?? "unknown",
            };
          })
        : [];
      return [
        state.makeEvent(
          "run",
          {
            state: "initialized",
            runtime: "claude-agent-sdk",
            model: stringValue(record.model) ?? state.requestedModel,
            tools: arrayOfStrings(record.tools),
            mcpServers: servers,
            permissionMode: stringValue(record.permissionMode) ?? "unknown",
          },
          stringValue(record.model) ?? state.requestedModel,
        ),
      ];
    }
    return [state.makeEvent("runtime-exit", { type, subtype })];
  }

  if (type === "assistant") {
    const assistant = asObject(record.message);
    const model = stringValue(assistant?.model) ?? state.requestedModel;
    const blocks = Array.isArray(assistant?.content) ? assistant.content : [];
    const events: RehorEvent[] = [];
    const partialUsage = usageFromRecord(model, asObject(assistant?.usage));
    if (partialUsage) state.usage.set(model, partialUsage);

    for (const block of blocks) {
      const value = asObject(block);
      const blockType = stringValue(value?.type);
      if (blockType === "text") {
        const text = stringValue(value?.text);
        if (text) events.push(state.makeEvent("model", { role: "assistant", text }, model));
      } else if (blockType === "thinking") {
        const thinking = stringValue(value?.thinking);
        if (thinking) events.push(state.makeEvent("model", { role: "assistant", thinking }, model));
      } else if (blockType === "tool_use" || blockType === "server_tool_use") {
        const id = stringValue(value?.id);
        const name = stringValue(value?.name) ?? blockType;
        if (id) state.toolStarts.set(id, Date.now());
        extractToolContext(name, asObject(value?.input), state.context);
        events.push(
          state.makeEvent(
            "tool",
            {
              state: "started",
              name,
              toolName: name,
              ...(id ? { toolUseId: id } : {}),
              ...(value?.input === undefined ? {} : { input: jsonValue(value.input) }),
            },
            model,
          ),
        );
      }
    }
    return events;
  }

  if (type === "user") {
    const content = Array.isArray(record.message)
      ? record.message
      : (asObject(record.message)?.content ?? record.content);
    if (!Array.isArray(content)) return [];
    const events: RehorEvent[] = [];
    for (const block of content) {
      const value = asObject(block);
      if (stringValue(value?.type) !== "tool_result") continue;
      const id = stringValue(value?.tool_use_id);
      const started = id ? state.toolStarts.get(id) : undefined;
      if (id) state.toolStarts.delete(id);
      extractTaskResult(value?.content, state.context);
      events.push(
        state.makeEvent("tool", {
          state: "completed",
          ...(id ? { toolUseId: id } : {}),
          ...(started === undefined ? {} : { durationMs: Math.max(0, Date.now() - started) }),
          ...(value?.is_error === undefined ? {} : { isError: value.is_error === true }),
          ...(value?.content === undefined ? {} : { content: jsonValue(value.content) }),
        }),
      );
    }
    return events;
  }

  return [
    state.makeEvent("runtime-exit", {
      type: type ?? "unknown",
      ...(stringValue(record.subtype) ? { subtype: stringValue(record.subtype) } : {}),
      ...(state.reference ? { reference: state.reference } : {}),
    }),
  ];
}

function collectResultUsage(
  record: JsonObject | undefined,
  requestedModel: string,
): UsageSnapshot[] {
  if (!record) return [];
  const modelUsage = asObject(record.modelUsage);
  const entries = modelUsage ? Object.entries(modelUsage) : [];
  if (entries.length > 0) {
    const totalCost = numberValue(record.total_cost_usd);
    const snapshots = entries
      .map(([model, value]) => {
        const modelRecord = asObject(value);
        const cost =
          numberValue(modelRecord?.costUSD) ?? (entries.length === 1 ? totalCost : undefined);
        return usageFromRecord(model, modelRecord, cost);
      })
      .filter((value): value is UsageSnapshot => value !== undefined);
    if (snapshots.length > 0) return snapshots;
  }
  const usage = usageFromRecord(
    requestedModel,
    asObject(record.usage),
    numberValue(record.total_cost_usd),
  );
  return usage ? [usage] : [];
}

function usageFromRecord(
  model: string,
  value: JsonObject | undefined,
  cost?: number,
): UsageSnapshot | undefined {
  if (!value) return undefined;
  const counts: TokenCounts = {};
  addCount(counts, "input", value.inputTokens ?? value.input_tokens);
  addCount(counts, "output", value.outputTokens ?? value.output_tokens);
  addCount(counts, "reasoning", value.thinkingTokens ?? value.thinking_tokens);
  addCount(counts, "cacheRead", value.cacheReadInputTokens ?? value.cache_read_input_tokens);
  addCount(
    counts,
    "cacheWrite",
    value.cacheCreationInputTokens ?? value.cache_creation_input_tokens,
  );
  if (Object.keys(counts).length === 0 && cost === undefined) return undefined;
  return { model, counts, ...(cost === undefined ? {} : { cost }) };
}

function sanitizedSdkEnvironment(
  overrides?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const environment = { ...(overrides ?? process.env) };
  for (const variable of SANITIZED_ENV_VARS) delete environment[variable];
  return environment;
}

function addCount(counts: TokenCounts, key: keyof TokenCounts, value: unknown): void {
  const number = numberValue(value);
  if (number !== undefined && number >= 0) counts[key] = number;
}

function toSdkMcpServers(servers: Readonly<Record<string, ClaudeMcpServer>>) {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      if ("command" in server) {
        return [
          name,
          {
            ...(server.type === undefined ? {} : { type: server.type }),
            command: server.command,
            ...(server.args ? { args: [...server.args] } : {}),
            ...(server.env ? { env: { ...server.env } } : {}),
            ...(server.timeout === undefined ? {} : { timeout: server.timeout }),
            ...(server.alwaysLoad === undefined ? {} : { alwaysLoad: server.alwaysLoad }),
          },
        ];
      }
      return [
        name,
        {
          type: server.type,
          url: server.url,
          ...(server.headers ? { headers: { ...server.headers } } : {}),
          ...(server.timeout === undefined ? {} : { timeout: server.timeout }),
          ...(server.alwaysLoad === undefined ? {} : { alwaysLoad: server.alwaysLoad }),
        },
      ];
    }),
  );
}

function extractToolContext(
  name: string,
  input: JsonObject | undefined,
  context: WorkContext,
): void {
  if (!input) return;
  if (typeof input.jira_key === "string") context.externalKey = input.jira_key;
  if (typeof input.repo === "string") context.repository = input.repo;
  if (typeof input.summary === "string") context.summary = input.summary.slice(0, 200);
  if (name === "Bash" && typeof input.command === "string") {
    if (input.command.includes("gh pr checks") || input.command.includes("glab ci view")) {
      context.workType = context.workType ?? "ci_fix";
    } else if (input.command.includes("gh pr view") || input.command.includes("glab mr view")) {
      context.workType = context.workType ?? "pr_review";
    }
  }
  if (name.endsWith("task_add")) context.workType = context.workType ?? "new_ticket";
  if (name.endsWith("task_update")) {
    if (input.status === "pr_open") context.workType = "new_ticket";
    if (input.status === "pr_changes") context.workType = "pr_review";
    if (input.status === "done") context.workType = context.workType ?? "pr_review";
  }
  if (name.includes("jira_transition_issue")) context.workType = context.workType ?? "new_ticket";
  if (name.endsWith("memory_delete")) context.workType = context.workType ?? "memory_housekeeping";
  const progress = asObject(input.progress);
  if (progress) {
    if (typeof progress.jira_key === "string") context.externalKey ??= progress.jira_key;
    if (typeof progress.repo === "string") context.repository ??= progress.repo;
  }
}

function extractTaskResult(value: unknown, context: WorkContext): void {
  const texts: string[] = [];
  if (typeof value === "string") texts.push(value);
  if (Array.isArray(value)) {
    for (const part of value) {
      const record = asObject(part);
      if (typeof record?.text === "string") texts.push(record.text);
    }
  }
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const object = asObject(parsed);
      if (!object) continue;
      if (
        typeof object.id === "number" &&
        object.id > 0 &&
        ("external_key" in object || "jira_key" in object)
      ) {
        context.taskId = object.id;
      } else if (typeof object.task_id === "number" && object.task_id > 0) {
        context.taskId = object.task_id;
      }
    } catch {
      // Tool output is not required to be JSON.
    }
  }
}

function isResultMessage(message: unknown): boolean {
  return stringValue(asObject(message)?.type) === "result";
}

function lastMeaningfulLine(text: string): string | undefined {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  return last ? last.slice(0, 200) : undefined;
}

function isNoWork(text: string): boolean {
  const lower = text.toLowerCase();
  return NO_WORK_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

function abortState(reason: unknown): "interrupted" | "cancelled" | "timed_out" {
  const text = errorMessage(abortCauseReason(reason)).toLowerCase();
  if (text.includes("timeout") || text.includes("timed_out") || text.includes("timed out"))
    return "timed_out";
  if (text.includes("interrupt")) return "interrupted";
  return "cancelled";
}

function abortReason(reason: unknown): string {
  return errorMessage(abortCauseReason(reason)) || "runtime aborted";
}

function abortCauseReason(reason: unknown): unknown {
  const record = asObject(reason);
  return record && "reason" in record ? record.reason : reason;
}

function abortError(reason: unknown): Error {
  const error = new Error(abortReason(reason));
  error.name = "AbortError";
  return error;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function jsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]));
  }
  return String(value);
}
