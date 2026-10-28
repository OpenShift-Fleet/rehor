import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import eventSchema from "../../schema/rehor-event.v1.json" with { type: "json" };
import runSchema from "../../schema/rehor-run.v1.json" with { type: "json" };
import { type RehorEvent, RuntimeContractError } from "./event";
import type { ContentHash, RehorRun } from "./run";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateRunSchema = ajv.compile<RehorRun>(runSchema);
const validateEventSchema = ajv.compile<RehorEvent>(eventSchema);

declare const validatedRehorRun: unique symbol;
export type ValidatedRehorRun = RehorRun & { readonly [validatedRehorRun]: true };

const lowerHash = (hash: ContentHash): ContentHash => ({
  algorithm: hash.algorithm,
  value: hash.value.toLowerCase(),
});

const optional = <T>(key: string, value: T | undefined) =>
  value === undefined ? {} : { [key]: value };

export function parseRehorRun(value: unknown): ValidatedRehorRun {
  const run = cloneInput(value, "run");
  assertSchema(validateRunSchema, run, "run");
  return {
    schemaVersion: run.schemaVersion,
    runId: run.runId,
    attemptId: run.attemptId,
    instanceId: run.instanceId,
    label: run.label,
    workflowId: run.workflowId,
    prompt: run.prompt,
    task: run.task === null ? null : { id: run.task.id, ...optional("key", run.task.key) },
    worktree: {
      path: run.worktree.path,
      repository: run.worktree.repository,
      snapshot: {
        ref: run.worktree.snapshot.ref,
        commitSha: run.worktree.snapshot.commitSha,
        dirty: run.worktree.snapshot.dirty,
      },
    },
    instructionHash: lowerHash(run.instructionHash),
    configHash: lowerHash(run.configHash),
    policyHash: lowerHash(run.policyHash),
    ...optional("runtimeId", run.runtimeId),
    provider: {
      id: run.provider.id,
      requestedModel: run.provider.requestedModel,
      ...optional("reasoningEffort", run.provider.reasoningEffort),
    },
    limits: {
      timeoutMs: run.limits.timeoutMs,
      maxTurns: run.limits.maxTurns,
      ...optional("maxOutputTokens", run.limits.maxOutputTokens),
    },
    preflightPayloadRef: run.preflightPayloadRef,
  } as ValidatedRehorRun;
}

export function parseRehorEvent(value: unknown): RehorEvent {
  const event = cloneInput(value, "event");
  assertSchema(validateEventSchema, event, "event");
  return {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    runId: event.runId,
    attemptId: event.attemptId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    kind: event.kind,
    ...optional("runtimeSessionRef", event.runtimeSessionRef),
    ...optional("parentEventId", event.parentEventId),
    workspace: {
      worktreePath: event.workspace.worktreePath,
      repository: event.workspace.repository,
      snapshot: event.workspace.snapshot,
    },
    provider: event.provider,
    model: event.model,
    policyVersion: event.policyVersion,
    payload: deepFreeze(event.payload),
    ...(event.rawEventRef === undefined
      ? {}
      : { rawEventRef: { reference: event.rawEventRef.reference, redacted: true } }),
  };
}

/**
 * Detaches the payload from the caller. Adapters may reuse or mutate a payload
 * buffer between events; a retained reference would corrupt ledger state and
 * break idempotent redelivery.
 */
function cloneInput(value: unknown, path: string): unknown {
  try {
    return structuredClone(value);
  } catch {
    throw new RuntimeContractError(`${path} must be structured-cloneable`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function assertSchema<T>(
  validate: ValidateFunction<T>,
  value: unknown,
  path: string,
): asserts value is T {
  if (validate(value)) return;
  const errors = (validate.errors ?? [])
    .filter(({ keyword }) => keyword !== "if")
    .map(({ instancePath, message }) => `${instancePath || "/"} ${message ?? "is invalid"}`);
  throw new RuntimeContractError(`${path} does not match schema: ${errors.join("; ")}`);
}
