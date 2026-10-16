import type { RehorEvent } from "./event";
import type { RehorRun } from "./run";
import type { TerminalEventPayload, TerminalWorkContext } from "./terminal-state";

type JsonRecord = Record<string, unknown>;

const WORK_SELECTION_TOOLS = new Set([
  "bot_status_update",
  "task_add",
  "task_update",
  "task_outcome_report",
  "task_remove",
]);

const NO_WORK_PATTERNS = [
  "NO_WORK_FOUND",
  "no actionable work",
  "no work found",
  "no work available",
  "nothing actionable",
  "nothing to do",
  "nothing to pick up",
  "no tickets",
  "no unassigned",
  "no assigned tickets",
  "0 unassigned",
];

/** Builds terminal work metadata and no-work state from normalized events. */
export class WorkContextTracker {
  private readonly context: TerminalWorkContext = {};
  private readonly startedTools = new Set<string>();

  constructor(run: RehorRun) {
    if (!run.task || run.runtimeId !== "opencode-v1") return;
    const taskId = Number(run.task.id);
    if (Number.isSafeInteger(taskId) && taskId > 0) this.context.taskId = taskId;
    if (run.task.key) this.context.externalKey = run.task.key;
  }

  observe(event: RehorEvent): void {
    if (event.kind !== "tool") return;
    const payload = event.payload;
    const id =
      typeof payload.toolUseId === "string" && payload.toolUseId
        ? payload.toolUseId
        : event.eventId;
    const name = stringValue(payload.name) ?? stringValue(payload.toolName) ?? "";
    const input = asRecord(payload.input);

    if (payload.state === "started") {
      extractToolContext(name, input, this.context);
      this.startedTools.add(id);
      return;
    }
    if (payload.state !== "completed") return;

    if (!this.startedTools.has(id)) extractToolContext(name, input, this.context);
    extractTaskResult(payload.content, this.context);
  }

  enrichTerminal<T extends RehorEvent>(event: T): T {
    if (event.kind !== "terminal") return event;

    const payload = event.payload as TerminalEventPayload;
    const previousContext = asRecord(payload.context);
    const resultText = typeof payload.resultText === "string" ? payload.resultText : "";
    if (!this.context.summary && !previousContext?.summary && resultText) {
      const summary = lastMeaningfulLine(resultText);
      if (summary) this.context.summary = summary;
    }
    const context = { ...previousContext, ...this.context };
    const noWork = payload.noWork === true || containsNoWork(resultText);
    const hasContext = Object.keys(context).length > 0;

    return {
      ...event,
      payload: {
        ...payload,
        ...(hasContext ? { context } : {}),
        ...(payload.noWork !== undefined || resultText.length > 0 ? { noWork } : {}),
      },
    } as T;
  }
}

export function extractToolContext(
  name: string,
  input: JsonRecord | undefined,
  context: TerminalWorkContext,
): void {
  if (!input) return;
  // Claude uses mcp__server__tool; OpenCode uses server_tool.
  const tool = name.startsWith("mcp__bot-memory__")
    ? name.slice("mcp__bot-memory__".length)
    : name.startsWith("bot-memory_")
      ? name.slice("bot-memory_".length)
      : undefined;
  if (tool && WORK_SELECTION_TOOLS.has(tool)) {
    const externalKey = input.external_key || input.jira_key;
    if (typeof externalKey === "string" && externalKey) {
      if (externalKey !== context.externalKey) context.taskId = undefined;
      context.externalKey = externalKey;
    }
    if (typeof input.repo === "string" && input.repo) context.repository = input.repo;
    if (typeof input.summary === "string") context.summary = input.summary.slice(0, 200);
  }

  if (tool === "task_add") {
    context.workType = context.workType ?? "new_ticket";
  } else if (tool === "task_update") {
    if (input.status === "pr_open") context.workType = "new_ticket";
    if (input.status === "pr_changes") context.workType = "pr_review";
    if (input.status === "done") context.workType = context.workType ?? "pr_review";
  } else if (name.toLowerCase() === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (command.includes("gh pr checks") || command.includes("glab ci view")) {
      context.workType = context.workType ?? "ci_fix";
    } else if (command.includes("gh pr view") || command.includes("glab mr view")) {
      context.workType = context.workType ?? "pr_review";
    }
  } else if (name.includes("jira_transition_issue")) {
    context.workType = context.workType ?? "new_ticket";
  } else if (name.endsWith("memory_delete")) {
    context.workType = context.workType ?? "memory_housekeeping";
  }

  const progress = tool === "progress_store" ? asRecord(input.progress) : undefined;
  if (progress) {
    const externalKey = progress.external_key || progress.jira_key;
    if (typeof externalKey === "string" && externalKey && !context.externalKey) {
      context.taskId = undefined;
      context.externalKey = externalKey;
    }
    if (
      typeof progress.repo === "string" &&
      progress.repo &&
      (!externalKey || externalKey === context.externalKey)
    ) {
      context.repository ??= progress.repo;
    }
  }
}

export function extractTaskResult(value: unknown, context: TerminalWorkContext): void {
  const texts: string[] = [];
  if (typeof value === "string") texts.push(value);
  if (Array.isArray(value)) {
    for (const part of value) {
      const object = asRecord(part);
      if (typeof object?.text === "string") texts.push(object.text);
    }
  }
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const object = asRecord(parsed);
      if (!object) continue;
      const externalKey = object.external_key || object.jira_key;
      if (context.externalKey && externalKey && externalKey !== context.externalKey) continue;
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

function containsNoWork(text: string): boolean {
  const lower = text.toLowerCase();
  return NO_WORK_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
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

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
