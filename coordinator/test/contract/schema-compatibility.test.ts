import { readFile } from "node:fs/promises";

import type { AnySchema, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import { parseRehorEvent, parseRehorRun, RuntimeContractError } from "../../src/domain";

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

function schemaValidator(schema: unknown): ValidateFunction {
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  return ajv.compile(schema as AnySchema);
}

describe("versioned Rehor fixtures", () => {
  it("validates the v1 run fixture against its schema and parser", async () => {
    const fixture = await readJson("../fixtures/rehor-run.v1.json");
    const validate = schemaValidator(await readJson("../../schema/rehor-run.v1.json"));

    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    expect(parseRehorRun(fixture).schemaVersion).toBe("1");
  });

  it("validates known and unknown v1 event fixtures against their schema and parser", async () => {
    const fixture = await readJson("../fixtures/rehor-event.v1.json");
    const validate = schemaValidator(await readJson("../../schema/rehor-event.v1.json"));
    const rawEvents = (fixture as { events: unknown[] }).events;
    const events = rawEvents.map(parseRehorEvent);

    for (const rawEvent of rawEvents)
      expect(validate(rawEvent), JSON.stringify(validate.errors)).toBe(true);
    expect(events.map(({ kind }) => kind)).toEqual(["model", "runtime.future.v2"]);
  });

  it("rejects values forbidden by the published schemas", async () => {
    const run = (await readJson("../fixtures/rehor-run.v1.json")) as Record<string, unknown>;
    const eventFixture = (await readJson("../fixtures/rehor-event.v1.json")) as {
      events: Record<string, unknown>[];
    };

    expect(() => parseRehorRun({ ...run, sdk: { leaked: true } })).toThrow(
      /run does not match schema: \/ must NOT have additional properties/,
    );
    expect(() => parseRehorEvent({ ...eventFixture.events[0], occurredAt: "not-a-date" })).toThrow(
      /event does not match schema: \/occurredAt must match format "date-time"/,
    );
    expect(() => parseRehorEvent({ ...eventFixture.events[0], sdk: { leaked: true } })).toThrow(
      /event does not match schema: \/ must NOT have additional properties/,
    );
  });

  it("rebuilds parsed runs and events in the original fixed key order", async () => {
    const run = parseRehorRun({
      limits: { maxOutputTokens: undefined, maxTurns: 20, timeoutMs: 60_000 },
      provider: { reasoningEffort: undefined, requestedModel: "claude-opus-4-6", id: "vertex" },
      runtimeId: undefined,
      preflightPayloadRef: "memory://preflight/run-fixture-01",
      policyHash: {
        value: "3".repeat(64),
        algorithm: "sha256",
      },
      configHash: {
        value: "2".repeat(64),
        algorithm: "sha256",
      },
      instructionHash: {
        value: "1".repeat(64),
        algorithm: "sha256",
      },
      worktree: {
        snapshot: { dirty: false, commitSha: "abc123", ref: "refs/heads/rehor-138" },
        repository: "https://github.com/OpenShift-Fleet/rehor.git",
        path: "/work/rehor",
      },
      task: { key: "REHOR-138", id: "task-fixture-01" },
      prompt: "Follow the instructions and handle the preflight data.",
      workflowId: "jira-sprint",
      label: "hcc-ai-framework",
      instanceId: "instance-fixture-01",
      attemptId: "attempt-fixture-01",
      runId: "run-fixture-01",
      schemaVersion: "1",
    });

    expect(JSON.stringify(run)).toBe(
      JSON.stringify({
        schemaVersion: "1",
        runId: "run-fixture-01",
        attemptId: "attempt-fixture-01",
        instanceId: "instance-fixture-01",
        label: "hcc-ai-framework",
        workflowId: "jira-sprint",
        prompt: "Follow the instructions and handle the preflight data.",
        task: { id: "task-fixture-01", key: "REHOR-138" },
        worktree: {
          path: "/work/rehor",
          repository: "https://github.com/OpenShift-Fleet/rehor.git",
          snapshot: { ref: "refs/heads/rehor-138", commitSha: "abc123", dirty: false },
        },
        instructionHash: { algorithm: "sha256", value: "1".repeat(64) },
        configHash: { algorithm: "sha256", value: "2".repeat(64) },
        policyHash: { algorithm: "sha256", value: "3".repeat(64) },
        provider: { id: "vertex", requestedModel: "claude-opus-4-6" },
        limits: { timeoutMs: 60_000, maxTurns: 20 },
        preflightPayloadRef: "memory://preflight/run-fixture-01",
      }),
    );
    expect(Object.hasOwn(run, "runtimeId")).toBe(false);
    expect(Object.hasOwn(run.provider, "reasoningEffort")).toBe(false);
    expect(Object.hasOwn(run.limits, "maxOutputTokens")).toBe(false);

    const claudeEvent = {
      rawEventRef: { redacted: true, reference: "claude-agent-sdk:uuid-01" },
      payload: { text: "partial output" },
      policyVersion: "policy-1",
      model: "claude-opus-4-6",
      provider: "vertex",
      workspace: {
        snapshot: "abc123",
        repository: "https://github.com/OpenShift-Fleet/rehor.git",
        worktreePath: "/work/rehor",
      },
      parentEventId: undefined,
      runtimeSessionRef: "claude-session-01",
      kind: "agent",
      occurredAt: "2026-09-07T12:00:00.000Z",
      sequence: 1,
      attemptId: "attempt-fixture-01",
      runId: "run-fixture-01",
      eventId: "claude-event-01",
      schemaVersion: "1",
    };
    expect(JSON.stringify(parseRehorEvent(claudeEvent))).toBe(
      JSON.stringify({
        schemaVersion: "1",
        eventId: "claude-event-01",
        runId: "run-fixture-01",
        attemptId: "attempt-fixture-01",
        sequence: 1,
        occurredAt: "2026-09-07T12:00:00.000Z",
        kind: "agent",
        runtimeSessionRef: "claude-session-01",
        workspace: {
          worktreePath: "/work/rehor",
          repository: "https://github.com/OpenShift-Fleet/rehor.git",
          snapshot: "abc123",
        },
        provider: "vertex",
        model: "claude-opus-4-6",
        policyVersion: "policy-1",
        payload: { text: "partial output" },
        rawEventRef: { reference: "claude-agent-sdk:uuid-01", redacted: true },
      }),
    );

    const openCodeEvent = {
      payload: { input: "hello", tool: "bash" },
      rawEventRef: undefined,
      policyVersion: "policy-2",
      model: "rehor-openai/gpt-5.6-luna",
      provider: "rehor-openai",
      workspace: {
        snapshot: "def456",
        repository: "https://github.com/OpenShift-Fleet/rehor.git",
        worktreePath: "/work/rehor",
      },
      parentEventId: "opencode-call-01",
      runtimeSessionRef: "opencode-session-01",
      kind: "tool",
      occurredAt: "2026-09-07T12:00:01.000Z",
      sequence: 2,
      attemptId: "attempt-fixture-01",
      runId: "run-fixture-01",
      eventId: "opencode-event-01",
      schemaVersion: "1",
    };
    expect(JSON.stringify(parseRehorEvent(openCodeEvent))).toBe(
      JSON.stringify({
        schemaVersion: "1",
        eventId: "opencode-event-01",
        runId: "run-fixture-01",
        attemptId: "attempt-fixture-01",
        sequence: 2,
        occurredAt: "2026-09-07T12:00:01.000Z",
        kind: "tool",
        runtimeSessionRef: "opencode-session-01",
        parentEventId: "opencode-call-01",
        workspace: {
          worktreePath: "/work/rehor",
          repository: "https://github.com/OpenShift-Fleet/rehor.git",
          snapshot: "def456",
        },
        provider: "rehor-openai",
        model: "rehor-openai/gpt-5.6-luna",
        policyVersion: "policy-2",
        payload: { input: "hello", tool: "bash" },
      }),
    );
  });

  it("clones before validating inherited properties and getters", async () => {
    const runFixture = (await readJson("../fixtures/rehor-run.v1.json")) as Record<string, unknown>;
    const eventFixture = (await readJson("../fixtures/rehor-event.v1.json")) as {
      events: Record<string, unknown>[];
    };
    const runWithInheritedId = Object.assign(
      Object.create({ runId: runFixture.runId }) as Record<string, unknown>,
      runFixture,
    );
    delete runWithInheritedId.runId;
    const eventInput = eventFixture.events[0];
    if (!eventInput) throw new Error("event fixture is empty");
    const eventWithInheritedId = Object.assign(
      Object.create({ eventId: eventInput.eventId }) as Record<string, unknown>,
      eventInput,
    );
    delete eventWithInheritedId.eventId;

    expect(() => parseRehorRun(runWithInheritedId)).toThrow(RuntimeContractError);
    expect(() => parseRehorEvent(eventWithInheritedId)).toThrow(RuntimeContractError);

    const withThrowingGetter = (input: Record<string, unknown>, key: string) => {
      const result = { ...input };
      Object.defineProperty(result, key, {
        enumerable: true,
        get() {
          throw new TypeError("getter failed");
        },
      });
      return result;
    };

    expect(() => parseRehorRun(withThrowingGetter(runFixture, "runId"))).toThrow(
      RuntimeContractError,
    );
    expect(() => parseRehorEvent(withThrowingGetter(eventInput, "eventId"))).toThrow(
      RuntimeContractError,
    );
  });

  it("accepts a taskless triage run", async () => {
    const fixture = (await readJson("../fixtures/rehor-run.v1.json")) as Record<string, unknown>;

    expect(parseRehorRun({ ...fixture, task: null }).task).toBeNull();
  });
});
