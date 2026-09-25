import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import eventSchema from "../../schema/rehor-event.v1.json" with { type: "json" };
import runSchema from "../../schema/rehor-run.v1.json" with { type: "json" };
import { type RehorEvent, RuntimeContractError } from "./event";
import type { RehorRun } from "./run";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateRunSchema = ajv.compile(runSchema);
const validateEventSchema = ajv.compile(eventSchema);

export function parseRehorRun(value: unknown): RehorRun {
  assertSchema(validateRunSchema, value, "run");

  const run = structuredClone(value) as RehorRun;
  // Hashes exist to be compared; uppercase hex must not read as drift.
  run.instructionHash.value = run.instructionHash.value.toLowerCase();
  run.configHash.value = run.configHash.value.toLowerCase();
  run.policyHash.value = run.policyHash.value.toLowerCase();
  return run;
}

export function parseRehorEvent(value: unknown): RehorEvent {
  assertSchema(validateEventSchema, value, "event");

  const { payload, ...fields } = value as RehorEvent;
  return {
    ...structuredClone(fields),
    payload: clonePayload(payload as Record<string, unknown>),
  };
}

/**
 * Detaches the payload from the caller. Adapters may reuse or mutate a payload
 * buffer between events; a retained reference would corrupt ledger state and
 * break idempotent redelivery.
 */
function clonePayload(payload: Record<string, unknown>): Readonly<Record<string, unknown>> {
  let copy: Record<string, unknown>;
  try {
    copy = structuredClone(payload);
  } catch {
    throw new RuntimeContractError("event.payload must be structured-cloneable");
  }
  return deepFreeze(copy);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function assertSchema(validate: ValidateFunction, value: unknown, path: string): void {
  if (validate(value)) return;
  const errors = (validate.errors ?? []).map(
    ({ instancePath, message }) => `${instancePath || "/"} ${message ?? "is invalid"}`,
  );
  throw new RuntimeContractError(`${path} does not match schema: ${errors.join("; ")}`);
}
