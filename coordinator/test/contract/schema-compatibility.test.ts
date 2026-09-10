import { readFile } from "node:fs/promises";

import type { AnySchema, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import { parseRehorEvent, parseRehorRun } from "../../src/domain";

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
      "run does not match schema",
    );
    expect(() => parseRehorEvent({ ...eventFixture.events[0], occurredAt: "not-a-date" })).toThrow(
      "event does not match schema",
    );
    expect(() => parseRehorEvent({ ...eventFixture.events[0], sdk: { leaked: true } })).toThrow(
      "event does not match schema",
    );
  });

  it("accepts a taskless triage run", async () => {
    const fixture = (await readJson("../fixtures/rehor-run.v1.json")) as Record<string, unknown>;

    expect(parseRehorRun({ ...fixture, task: null }).task).toBeNull();
  });
});
