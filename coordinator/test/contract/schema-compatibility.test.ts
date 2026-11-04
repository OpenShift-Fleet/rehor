import { readFile } from "node:fs/promises";

import type { AnySchema, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { parseRehorEvent, parseRehorRun, RuntimeContractError } from "../../src/domain";
import eventFixtureJson from "../fixtures/rehor-event.v1.json" with { type: "json" };
import runFixtureJson from "../fixtures/rehor-run.v1.json" with { type: "json" };

const runFx = runFixtureJson as Record<string, unknown> & {
  provider: Record<string, unknown>;
  limits: Record<string, unknown>;
};
const eventFx = eventFixtureJson.events[0] as Record<string, unknown>;

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, nested]) => [key, reverseKeys(nested)]),
    );
  }
  return value;
}

function inherited(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const result = Object.assign(Object.create({ [key]: input[key] }), input);
  delete result[key];
  return result;
}

function withThrowingGetter(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const result = { ...input };
  Object.defineProperty(result, key, {
    enumerable: true,
    get() {
      throw new TypeError("getter failed");
    },
  });
  return result;
}

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

function schemaValidator(schema: unknown): ValidateFunction {
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  return ajv.compile(schema as AnySchema);
}

describe("versioned Rehor fixtures", () => {
  it("preserves historical runtime identifiers when parsing stored runs", () => {
    const stored = { ...runFx, runtimeId: "opencode-v1" };
    expect(parseRehorRun(stored).runtimeId).toBe("opencode-v1");
    expect(stored.runtimeId).toBe("opencode-v1");
  });

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
    const run = parseRehorRun(
      reverseKeys({
        ...runFx,
        runtimeId: undefined,
        provider: { ...runFx.provider, reasoningEffort: undefined },
        limits: { ...runFx.limits, maxOutputTokens: undefined },
      }),
    );
    expect(JSON.stringify(run)).toBe(JSON.stringify(runFx));
    expect(run).toStrictEqual(runFx);

    const claudeEvent = parseRehorEvent(
      reverseKeys({ ...eventFx, parentEventId: "parent-event-01" }),
    );
    const expectedClaudeEvent = {
      schemaVersion: "1",
      eventId: "event-fixture-01",
      runId: "run-fixture-01",
      attemptId: "attempt-fixture-01",
      sequence: 1,
      occurredAt: "2026-09-07T12:00:00.000Z",
      kind: "model",
      runtimeSessionRef: "rehor-session-ref-01",
      parentEventId: "parent-event-01",
      workspace: {
        worktreePath: "/work/rehor",
        repository: "https://github.com/OpenShift-Fleet/rehor.git",
        snapshot: "abc123",
      },
      provider: "vertex",
      model: "claude-opus-4-6",
      policyVersion: "policy-1",
      payload: { text: "partial output" },
      rawEventRef: { reference: "sha256:fixture", redacted: true },
    };
    expect(JSON.stringify(claudeEvent)).toBe(JSON.stringify(expectedClaudeEvent));
    expect(claudeEvent).toStrictEqual(expectedClaudeEvent);

    const plainEvent = parseRehorEvent(
      reverseKeys({
        ...eventFixtureJson.events[1],
        parentEventId: undefined,
        rawEventRef: undefined,
      }),
    );
    const expectedPlainEvent = eventFixtureJson.events[1];
    expect(JSON.stringify(plainEvent)).toBe(JSON.stringify(expectedPlainEvent));
    expect(plainEvent).toStrictEqual(expectedPlainEvent);
  });

  it.each([
    [parseRehorRun, runFx, "runId"],
    [parseRehorEvent, eventFx, "eventId"],
  ] as const)(
    "clones before validating inherited properties and getters",
    (parse, fixture, key) => {
      expect(() => parse(inherited(fixture, key))).toThrow(RuntimeContractError);
      expect(() => parse(withThrowingGetter(fixture, key))).toThrow(RuntimeContractError);
    },
  );

  it("accepts a taskless triage run", async () => {
    const fixture = (await readJson("../fixtures/rehor-run.v1.json")) as Record<string, unknown>;

    expect(parseRehorRun({ ...fixture, task: null }).task).toBeNull();
  });
});
