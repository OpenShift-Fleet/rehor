import type { TerminalWorkContext } from "../domain/terminal-state";

type JsonRecord = Record<string, unknown>;

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

/** Stable JSON for hashes and deterministic diagnostics. Undefined object fields are omitted. */
export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const object = value as JsonRecord;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

const REDACTED = "[REDACTED]";

/** Removes common credential forms before runtime text enters the event stream. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /((?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b(bearer\s+)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/(https?:\/\/)([^/\s@]+)@/gi, `$1${REDACTED}@`)
    .replace(
      /([?&](?:api[-_]?key|access[-_]?token|authorization|password|secret|token)=)[^&#\s]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /((?:["']?(?:api[-_]?key|access[-_]?token|auth(?:orization)?|password|secret|token)["']?)\s*[:=]\s*["']?)[^"',\s}&]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, REDACTED);
}

/** Runs an operation until it settles, the caller aborts, or its deadline expires. */
export function boundedOperation<T>(
  operation: (signal: AbortSignal) => Promise<T> | T,
  signal: AbortSignal,
  deadline: number | undefined,
  name: string,
  deadlineError: Error = new Error(`${name} exceeded deadline`),
): Promise<T> {
  const deadlineController = new AbortController();
  const operationSignal = AbortSignal.any([signal, deadlineController.signal]);
  let timer: NodeJS.Timeout | undefined;
  if (deadline !== undefined) {
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      timer = setTimeout(() => deadlineController.abort(deadlineError), remaining);
    } else {
      deadlineController.abort(deadlineError);
    }
  }

  return new Promise<T>((resolve, reject) => {
    let pending: Promise<T> | undefined;
    let settled = false;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      operationSignal.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = (): void => settle(() => reject(abortReason(operationSignal)));

    if (operationSignal.aborted) {
      onAbort();
    } else {
      operationSignal.addEventListener("abort", onAbort, { once: true });
      pending = Promise.resolve().then(() => {
        if (operationSignal.aborted) throw abortReason(operationSignal);
        return operation(operationSignal);
      });
      void pending.catch(() => undefined);
      pending.then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    }
  });
}

export function assertPositiveInteger(value: number, name: string, prefix = "Runtime"): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${prefix} ${name} must be a positive safe integer`);
  }
}

export function abortReasonText(reason: unknown, fallback = "runtime aborted"): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  const object = asObject(reason);
  if (!object) return fallback;
  const kind = typeof object.kind === "string" ? object.kind : "";
  const detail = "reason" in object ? abortReasonText(object.reason, fallback) : "";
  return [kind, detail].filter(Boolean).join(": ") || fallback;
}

export function abortKind(reason: unknown): string | undefined {
  if (typeof reason === "string") return reason;
  const object = asObject(reason);
  if (!object) return undefined;
  if (typeof object.kind === "string") return object.kind;
  return "reason" in object ? abortKind(object.reason) : undefined;
}

export function abortCauseReason(reason: unknown): unknown {
  const object = asObject(reason);
  return object && "reason" in object ? object.reason : reason;
}

export function abortReason(signal: AbortSignal, fallback = "runtime aborted"): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(abortReasonText(signal.reason, fallback));
}

export function abortError(reason: unknown, fallback = "runtime aborted"): Error {
  const error = new Error(abortReasonText(reason, fallback));
  error.name = "AbortError";
  return error;
}

export function extractToolContext(
  name: string,
  input: JsonRecord | undefined,
  context: TerminalWorkContext,
): void {
  if (!input) return;
  if (typeof input.jira_key === "string" && input.jira_key) context.externalKey = input.jira_key;
  if (typeof input.repo === "string" && input.repo) context.repository = input.repo;
  if (typeof input.summary === "string") context.summary = input.summary.slice(0, 200);

  if (name.endsWith("task_add")) {
    context.workType = context.workType ?? "new_ticket";
  } else if (name.endsWith("task_update")) {
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

  const progress = asObject(input.progress);
  if (progress) {
    if (typeof progress.jira_key === "string" && progress.jira_key) {
      context.externalKey ??= progress.jira_key;
    }
    if (typeof progress.repo === "string" && progress.repo) context.repository ??= progress.repo;
  }
}

export function extractTaskResult(value: unknown, context: TerminalWorkContext): void {
  const texts: string[] = [];
  if (typeof value === "string") texts.push(value);
  if (Array.isArray(value)) {
    for (const part of value) {
      const object = asObject(part);
      if (typeof object?.text === "string") texts.push(object.text);
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

export function lastMeaningfulLine(text: string): string | undefined {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  return last ? last.slice(0, 200) : undefined;
}

export function isNoWork(text: string): boolean {
  const lower = text.toLowerCase();
  return NO_WORK_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

function asObject(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}
