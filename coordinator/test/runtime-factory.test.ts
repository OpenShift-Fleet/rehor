import { describe, expect, it } from "vitest";

import {
  executeSelectedRun,
  type RehorEvent,
  type RehorRun,
  RuntimeFactoryError,
  RuntimeFactoryRegistry,
  resolveRuntimeSelection,
} from "../src";
import { FakeAgentRuntime } from "../src/testing/fake-agent-runtime";

const run: RehorRun = {
  schemaVersion: "1",
  runId: "run-factory",
  attemptId: "attempt-factory",
  instanceId: "instance-01",
  label: "hcc-ai-framework",
  workflowId: "jira-sprint",
  prompt: "Run the cycle.",
  task: null,
  worktree: {
    path: "/work/rehor",
    repository: "https://github.com/OpenShift-Fleet/rehor.git",
    snapshot: { ref: "refs/heads/rehor-139", commitSha: "abc123", dirty: false },
  },
  instructionHash: { algorithm: "sha256", value: "1".repeat(64) },
  configHash: { algorithm: "sha256", value: "2".repeat(64) },
  policyHash: { algorithm: "sha256", value: "3".repeat(64) },
  provider: { id: "vertex", requestedModel: "claude-opus-4-6" },
  limits: { timeoutMs: 100, maxTurns: 20 },
  preflightPayloadRef: null,
};

function event(sequence: number, terminal = false): RehorEvent {
  return {
    schemaVersion: "1",
    eventId: terminal ? "terminal-factory" : "run-factory-event",
    runId: run.runId,
    attemptId: run.attemptId,
    sequence,
    occurredAt: "2026-09-07T12:00:00.000Z",
    kind: terminal ? "terminal" : "run",
    workspace: {
      worktreePath: run.worktree.path,
      repository: run.worktree.repository,
      snapshot: run.worktree.snapshot.commitSha,
    },
    provider: run.provider.id,
    model: run.provider.requestedModel,
    policyVersion: "policy-1",
    payload: terminal ? { state: "completed", resultText: "done", turns: 1 } : { state: "started" },
  } as RehorEvent;
}

describe("runtime selection", () => {
  it("defaults to the current Claude runtime and accepts named runtimes", () => {
    expect(resolveRuntimeSelection()).toEqual({ runtimeId: "claude" });
    expect(resolveRuntimeSelection("opencode")).toEqual({ runtimeId: "opencode" });
    expect(() => resolveRuntimeSelection("bad runtime")).toThrow(RuntimeFactoryError);
  });

  it("registers and resolves factories without coupling to providers", async () => {
    const contexts: string[] = [];
    const runtime = new FakeAgentRuntime();
    const registry = new RuntimeFactoryRegistry([
      {
        runtimeId: "opencode",
        create(context) {
          contexts.push(`${context.selection.runtimeId}:${context.run.provider.id}`);
          return runtime;
        },
      },
    ]);

    expect(registry.has("opencode")).toBe(true);
    expect(registry.runtimeIds).toEqual(["opencode"]);
    expect(await registry.create({ runtimeId: "opencode" }, run)).toBe(runtime);
    expect(contexts).toEqual(["opencode:vertex"]);
    expect(() => registry.register({ runtimeId: "opencode", create: () => runtime })).toThrow(
      "already registered",
    );
  });

  it("reports unknown runtime IDs with available adapters", async () => {
    const registry = new RuntimeFactoryRegistry([
      { runtimeId: "claude", create: () => new FakeAgentRuntime() },
    ]);

    await expect(registry.create({ runtimeId: "opencode" }, run)).rejects.toThrow(
      "available: claude",
    );
  });

  it("runs a selected adapter through the coordinator lifecycle", async () => {
    let createdFor: string | undefined;
    const registry = new RuntimeFactoryRegistry([
      {
        runtimeId: "claude",
        create(context) {
          createdFor = context.run.runId;
          return new FakeAgentRuntime({ events: [event(1), event(2, true)] });
        },
      },
    ]);

    const result = await executeSelectedRun(registry, { runtimeId: "claude" }, run);

    expect(createdFor).toBe("run-factory");
    expect(result.terminal.payload.state).toBe("completed");
  });
});
