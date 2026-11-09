/**
 * Dispatcher sandbox input consumption (REHOR-233).
 *
 * Contract source: packages/agent-dispatcher/src/input-envelope.ts. The
 * dispatcher delivers one UTF-8 JSON envelope at a fixed path and execs the
 * runner entrypoint with REHOR_INPUT_SOURCE=sandbox and
 * REHOR_INPUT_FILE=/tmp/rehor-input.json. Prompt content is sensitive: it is
 * never logged, placed in env or argv, or included in errors — only the
 * source/path pointers live in the environment.
 */
import { open } from "node:fs/promises";

export const INPUT_SOURCE_ENVIRONMENT = "REHOR_INPUT_SOURCE";
export const INPUT_FILE_ENVIRONMENT = "REHOR_INPUT_FILE";
/** Fixed delivery path inside the sandbox (mode 0600, see REHOR-226 contract). */
export const DEFAULT_INPUT_FILE_PATH = "/tmp/rehor-input.json";
/** Contract size cap: the complete serialized envelope, in bytes. */
export const MAX_INPUT_BYTES = 64 * 1024;
export const SUPPORTED_INPUT_SCHEMA_VERSION = 1;

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCRIPT_STATUSES = ["start", "skip", "error"] as const;

export type SandboxInputMode = "sandbox" | "legacy";

export type SandboxInputOutcome =
  | { status: "ok"; runId: string; prompt: string }
  | { status: "skip" }
  | { status: "error"; reason: string };

export class SandboxInputModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxInputModeError";
  }
}

/** Resolve REHOR_INPUT_SOURCE: unset/empty/"legacy" keeps the polling loop. */
export function resolveSandboxInputMode(environment: NodeJS.ProcessEnv): SandboxInputMode {
  const source = environment[INPUT_SOURCE_ENVIRONMENT] ?? "";
  if (source === "" || source === "legacy") return "legacy";
  if (source === "sandbox") return "sandbox";
  throw new SandboxInputModeError(
    `unsupported ${INPUT_SOURCE_ENVIRONMENT} value (expected 'sandbox' or 'legacy')`,
  );
}

/**
 * Compose the environment handed to the coordinator run (REHOR-237). In
 * sandbox mode the OpenCode provider apiKey references
 * REHOR_MODEL_PROXY_TOKEN, and only the supervisor can substitute the real
 * credential binding: the BOT_MEMORY_TOKEN placeholder is mapped over any
 * ambient value, because a deployment cannot deliver the real token into a
 * sandbox. Legacy mode returns the input environment unchanged.
 */
export function resolveCoordinatorEnvironment(
  inputMode: SandboxInputMode,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (inputMode !== "sandbox" || !environment.BOT_MEMORY_TOKEN) return environment;
  return { ...environment, REHOR_MODEL_PROXY_TOKEN: environment.BOT_MEMORY_TOKEN };
}

/** Read and validate the delivered envelope without exposing its prompt. */
export async function loadSandboxInput(
  environment: NodeJS.ProcessEnv,
): Promise<SandboxInputOutcome> {
  const path = environment[INPUT_FILE_ENVIRONMENT] || DEFAULT_INPUT_FILE_PATH;
  let raw: Buffer;
  try {
    raw = await readInputFile(path);
  } catch {
    return { status: "error", reason: `input file unreadable: ${path}` };
  }
  if (raw.byteLength > MAX_INPUT_BYTES) {
    return { status: "error", reason: `input exceeds ${MAX_INPUT_BYTES} bytes: ${path}` };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { status: "error", reason: `input is not valid UTF-8: ${path}` };
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { status: "error", reason: `input is not valid JSON: ${path}` };
  }

  const reason = validateEnvelope(envelope);
  if (reason !== null) return { status: "error", reason };

  const prompt = (envelope as { prompt: string }).prompt;
  if (!prompt.trim()) return { status: "skip" };
  return { status: "ok", runId: (envelope as { runId: string }).runId, prompt };
}

/** Read at most MAX_INPUT_BYTES + 1 bytes so oversize is detected, not loaded. */
async function readInputFile(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Return a failure reason, or null when the envelope shape is valid. */
function validateEnvelope(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "envelope is not a JSON object";
  }
  const envelope = value as Record<string, unknown>;
  const version = envelope.schemaVersion;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version !== SUPPORTED_INPUT_SCHEMA_VERSION
  ) {
    return `unsupported schemaVersion (expected ${SUPPORTED_INPUT_SCHEMA_VERSION})`;
  }
  const runId = envelope.runId;
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    return "runId is not a UUID";
  }
  if (typeof envelope.prompt !== "string") {
    return "prompt is not a string";
  }
  const metadata = envelope.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return "metadata is not an object";
  }
  if ((metadata as Record<string, unknown>).action !== "start") {
    return "metadata.action is not 'start'";
  }
  const scripts = (metadata as Record<string, unknown>).scripts;
  if (!Array.isArray(scripts)) {
    return "metadata.scripts is not a list";
  }
  for (const script of scripts) {
    if (typeof script !== "object" || script === null || Array.isArray(script)) {
      return "metadata.scripts entry is not an object";
    }
    const entry = script as Record<string, unknown>;
    if (typeof entry.name !== "string") {
      return "metadata.scripts entry name is not a string";
    }
    if (!SCRIPT_STATUSES.includes(entry.status as (typeof SCRIPT_STATUSES)[number])) {
      return "metadata.scripts entry status is invalid";
    }
  }
  return null;
}
