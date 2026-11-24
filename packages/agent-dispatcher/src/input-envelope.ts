import { randomUUID } from "node:crypto";
import type { WorkPreflightResult } from "./preflight-engine-ts.js";

/** Fixed delivery path inside the sandbox (mode 0600, see REHOR-226 contract). */
export const INPUT_FILE_PATH = "/tmp/rehor-input.json";
export const INPUT_ENVIRONMENT = Object.freeze({ REHOR_INPUT_SOURCE: "sandbox", REHOR_INPUT_FILE: INPUT_FILE_PATH });
/** Contract size cap: oversized preflight output is a dispatch error, no launch. */
export const MAX_INPUT_BYTES = 64 * 1024;
export const INPUT_SCHEMA_VERSION = 1;

/** UTF-8 JSON envelope delivered to the agent runner. Prompt content is
 * sensitive: never logged, never placed in env, argv, or the sandbox spec. */
export type InputEnvelope = {
  schemaVersion: typeof INPUT_SCHEMA_VERSION;
  runId: string;
  /** Prepared initial prompt, consumed without rerunning preflights. */
  prompt: string;
  metadata: {
    action: "start";
    /** Script names and statuses only; script content stays in the prompt. */
    scripts: { name: string; status: "start" | "skip" | "error" }[];
  };
};

export type BuiltInputEnvelope =
  | { status: "built"; envelope: InputEnvelope; serialized: Buffer }
  | { status: "skipped" | "invalid" | "oversized" };

export function buildInputEnvelope(result: WorkPreflightResult, runId = randomUUID()): BuiltInputEnvelope {
  if (!result || result.action !== "start") return { status: "invalid" };
  const prompt = result.prompt;
  if (typeof prompt !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)
    || !Array.isArray(result.scripts) || result.scripts.some((script) => !script || typeof script.name !== "string" || !["start", "skip", "error"].includes(script.status))) return { status: "invalid" };
  if (!prompt.trim()) return { status: "skipped" };
  const envelope: InputEnvelope = {
    schemaVersion: INPUT_SCHEMA_VERSION,
    runId,
    prompt,
    metadata: {
      action: result.action,
      scripts: result.scripts.map((script) => ({ name: script.name, status: script.status })),
    },
  };
  const serialized = Buffer.from(JSON.stringify(envelope), "utf8");
  if (serialized.byteLength > MAX_INPUT_BYTES) return { status: "oversized" };
  return { status: "built", envelope, serialized };
}
