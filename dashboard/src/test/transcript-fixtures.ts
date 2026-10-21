// Synthetic records matching the compatibility writer's flattened event format.
export function coordinatorEvent(
  sequence: number,
  kind: string,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: "1",
    eventId: `event-${sequence}`,
    runId: "run-test",
    attemptId: "attempt-test",
    sequence,
    occurredAt: "2026-01-01T00:00:00Z",
    runtimeSessionRef: "session-root",
    workspace: { worktreePath: "/workspace", repository: "example", snapshot: "test" },
    provider: "example-provider",
    model: "example-model",
    policyVersion: "test",
    kind,
    payload,
    ...overrides,
  };
}

export function jsonl(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

export const viewerAnswer = `Completed synthetic review. ${"Details verified. ".repeat(34)}`;
export const coordinatorTranscript = jsonl([
  coordinatorEvent(1, "run", { state: "started" }),
  coordinatorEvent(2, "model", { phase: "updated", messageId: "message-test" }),
  coordinatorEvent(3, "model", {
    phase: "reasoning",
    partId: "reasoning-test",
    text: "Check synthetic inputs first.",
  }),
  coordinatorEvent(4, "model", { phase: "text", partId: "answer-test", text: "Completed" }),
  coordinatorEvent(5, "tool", {
    state: "started",
    partId: "tool-test",
    toolUseId: "call-test",
    name: "inspect",
    input: {},
  }),
  coordinatorEvent(6, "tool", {
    state: "completed",
    partId: "tool-test",
    toolUseId: "call-test",
    name: "inspect",
    input: { path: "example.ts" },
    content: "Synthetic inspection passed",
  }),
  coordinatorEvent(7, "model", {
    phase: "text",
    partId: "answer-test",
    text: viewerAnswer,
    delta: "Details verified.",
  }),
  coordinatorEvent(8, "usage", { tokenCounts: { input: 100, output: 20 } }),
  coordinatorEvent(9, "terminal", { state: "completed", resultText: viewerAnswer }),
]);
