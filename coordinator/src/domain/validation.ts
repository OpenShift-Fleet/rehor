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
  return {
    schemaVersion: run.schemaVersion,
    runId: run.runId,
    attemptId: run.attemptId,
    instanceId: run.instanceId,
    label: run.label,
    workflowId: run.workflowId,
    prompt: run.prompt,
    task:
      run.task === null
        ? null
        : { id: run.task.id, ...(run.task.key === undefined ? {} : { key: run.task.key }) },
    worktree: {
      path: run.worktree.path,
      repository: run.worktree.repository,
      snapshot: {
        ref: run.worktree.snapshot.ref,
        commitSha: run.worktree.snapshot.commitSha,
        dirty: run.worktree.snapshot.dirty,
      },
    },
    instructionHash: {
      algorithm: run.instructionHash.algorithm,
      value: run.instructionHash.value.toLowerCase(),
    },
    configHash: {
      algorithm: run.configHash.algorithm,
      value: run.configHash.value.toLowerCase(),
    },
    policyHash: {
      algorithm: run.policyHash.algorithm,
      value: run.policyHash.value.toLowerCase(),
    },
    ...(run.runtimeId === undefined ? {} : { runtimeId: run.runtimeId }),
    provider: {
      id: run.provider.id,
      requestedModel: run.provider.requestedModel,
      ...(run.provider.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: run.provider.reasoningEffort }),
    },
    limits: {
      timeoutMs: run.limits.timeoutMs,
      maxTurns: run.limits.maxTurns,
      ...(run.limits.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: run.limits.maxOutputTokens }),
    },
    preflightPayloadRef: run.preflightPayloadRef,
  };
}

export function parseRehorEvent(value: unknown): RehorEvent {
  assertSchema(validateEventSchema, value, "event");

  const event = structuredClone(value) as RehorEvent;
  return {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    runId: event.runId,
    attemptId: event.attemptId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    kind: event.kind,
    ...(event.runtimeSessionRef === undefined
      ? {}
      : { runtimeSessionRef: event.runtimeSessionRef }),
    ...(event.parentEventId === undefined ? {} : { parentEventId: event.parentEventId }),
    workspace: {
      worktreePath: event.workspace.worktreePath,
      repository: event.workspace.repository,
      snapshot: event.workspace.snapshot,
    },
    provider: event.provider,
    model: event.model,
    policyVersion: event.policyVersion,
    payload: clonePayload(event.payload as Record<string, unknown>),
    ...(event.rawEventRef === undefined
      ? {}
      : {
          rawEventRef: {
            reference: event.rawEventRef.reference,
            redacted: true,
          },
        }),
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
