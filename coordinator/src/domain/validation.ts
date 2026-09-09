import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import eventSchema from "../../schema/rehor-event.v1.json" with { type: "json" };
import runSchema from "../../schema/rehor-run.v1.json" with { type: "json" };
import {
  assertTerminalPayload,
  assertUsagePayload,
  type RawEventReference,
  type RehorEvent,
  RuntimeContractError,
} from "./event";
import { type ContentHash, REHOR_SCHEMA_VERSION, type RehorRun, type TaskIdentity } from "./run";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateRunSchema = ajv.compile(runSchema);
const validateEventSchema = ajv.compile(eventSchema);

export function parseRehorRun(value: unknown): RehorRun {
  const object = record(value, "run");
  if (object.schemaVersion !== REHOR_SCHEMA_VERSION)
    throw new RuntimeContractError("unsupported run schema version");
  assertSchema(validateRunSchema, value, "run");

  const task = parseTask(object.task);
  const worktree = record(object.worktree, "run.worktree");
  const snapshot = record(worktree.snapshot, "run.worktree.snapshot");
  const provider = record(object.provider, "run.provider");
  const limits = record(object.limits, "run.limits");

  return {
    schemaVersion: REHOR_SCHEMA_VERSION,
    runId: requiredString(object, "runId"),
    attemptId: requiredString(object, "attemptId"),
    instanceId: requiredString(object, "instanceId"),
    label: requiredString(object, "label"),
    workflowId: requiredString(object, "workflowId"),
    prompt: requiredString(object, "prompt"),
    task,
    worktree: {
      path: requiredString(worktree, "path", "run.worktree"),
      repository: requiredString(worktree, "repository", "run.worktree"),
      snapshot: {
        ref: requiredString(snapshot, "ref", "run.worktree.snapshot"),
        commitSha: requiredString(snapshot, "commitSha", "run.worktree.snapshot"),
        dirty: requiredBoolean(snapshot, "dirty", "run.worktree.snapshot"),
      },
    },
    instructionHash: parseHash(object.instructionHash, "run.instructionHash"),
    configHash: parseHash(object.configHash, "run.configHash"),
    policyHash: parseHash(object.policyHash, "run.policyHash"),
    provider: {
      id: requiredString(provider, "id", "run.provider"),
      requestedModel: requiredString(provider, "requestedModel", "run.provider"),
      ...(provider.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: requiredString(provider, "reasoningEffort", "run.provider") }),
    },
    limits: {
      timeoutMs: positiveInteger(limits, "timeoutMs", "run.limits"),
      maxTurns: positiveInteger(limits, "maxTurns", "run.limits"),
      ...(limits.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: positiveInteger(limits, "maxOutputTokens", "run.limits") }),
    },
    preflightPayloadRef:
      object.preflightPayloadRef === null ? null : requiredString(object, "preflightPayloadRef"),
  };
}

export function parseRehorEvent(value: unknown): RehorEvent {
  const object = record(value, "event");
  if (object.schemaVersion !== REHOR_SCHEMA_VERSION)
    throw new RuntimeContractError("unsupported event schema version");
  const payload = clonePayload(record(object.payload, "event.payload"));
  if (object.kind === "terminal") assertTerminalPayload(payload);
  if (object.kind === "usage") assertUsagePayload(payload);
  assertSchema(validateEventSchema, value, "event");

  const workspace = record(object.workspace, "event.workspace");

  return {
    schemaVersion: REHOR_SCHEMA_VERSION,
    eventId: requiredString(object, "eventId"),
    runId: requiredString(object, "runId"),
    attemptId: requiredString(object, "attemptId"),
    sequence: object.sequence as number,
    occurredAt: requiredString(object, "occurredAt"),
    kind: requiredString(object, "kind"),
    ...(object.runtimeSessionRef === undefined
      ? {}
      : { runtimeSessionRef: requiredString(object, "runtimeSessionRef") }),
    ...(object.parentEventId === undefined
      ? {}
      : { parentEventId: requiredString(object, "parentEventId") }),
    workspace: {
      worktreePath: requiredString(workspace, "worktreePath", "event.workspace"),
      repository: requiredString(workspace, "repository", "event.workspace"),
      snapshot: requiredString(workspace, "snapshot", "event.workspace"),
    },
    provider: requiredString(object, "provider"),
    model: requiredString(object, "model"),
    policyVersion: requiredString(object, "policyVersion"),
    payload,
    ...(object.rawEventRef === undefined
      ? {}
      : { rawEventRef: parseRawEventReference(object.rawEventRef) }),
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

function parseTask(value: unknown): TaskIdentity | null {
  if (value === null) return null;
  const task = record(value, "run.task");
  return {
    id: requiredString(task, "id", "run.task"),
    ...(task.key === undefined ? {} : { key: requiredString(task, "key", "run.task") }),
  };
}

function parseHash(value: unknown, path: string): ContentHash {
  const hash = record(value, path);
  const algorithm = requiredString(hash, "algorithm", path);
  const hashValue = requiredString(hash, "value", path);
  if (algorithm !== "sha256" || !/^[a-f0-9]{64}$/i.test(hashValue)) {
    throw new RuntimeContractError(`${path} must be a sha256 hex hash`);
  }
  // Hashes exist to be compared; uppercase hex must not read as drift.
  return { algorithm: "sha256", value: hashValue.toLowerCase() };
}

function parseRawEventReference(value: unknown): RawEventReference {
  const reference = record(value, "event.rawEventRef");
  if (reference.redacted !== true)
    throw new RuntimeContractError("event.rawEventRef.redacted must be true");
  return { reference: requiredString(reference, "reference", "event.rawEventRef"), redacted: true };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new RuntimeContractError(`${path} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(object: Record<string, unknown>, key: string, path = "value"): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0)
    throw new RuntimeContractError(`${path}.${key} must be a non-empty string`);
  return value;
}

function requiredBoolean(object: Record<string, unknown>, key: string, path: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean")
    throw new RuntimeContractError(`${path}.${key} must be a boolean`);
  return value;
}

function positiveInteger(object: Record<string, unknown>, key: string, path: string): number {
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RuntimeContractError(`${path}.${key} must be a positive safe integer`);
  }
  return value as number;
}

function assertSchema(validate: ValidateFunction, value: unknown, path: string): void {
  if (validate(value)) return;
  throw new RuntimeContractError(
    `${path} does not match schema: ${ajv.errorsText(validate.errors)}`,
  );
}
