import assert from "node:assert/strict";
import test from "node:test";
import { buildInputEnvelope, INPUT_ENVIRONMENT, INPUT_FILE_PATH, INPUT_SCHEMA_VERSION, MAX_INPUT_BYTES } from "../dist/input-envelope.js";

const runId = "12345678-1234-1234-1234-123456789abc";
const start = (prompt) => ({ action: "start", prompt, scripts: [
  { name: "start.mjs", status: "start", content: "private start" },
  { name: "skip.mjs", status: "skip", content: "private skip" },
  { name: "error.mjs", status: "error", content: "private error" },
] });

test("envelope preserves original prompt and all script names/statuses, not script bodies", () => {
  const result = buildInputEnvelope(start("  prepared 🦊 prompt\n"), runId);
  assert.equal(result.status, "built");
  assert.equal(result.envelope.prompt, "  prepared 🦊 prompt\n");
  assert.equal(result.envelope.schemaVersion, INPUT_SCHEMA_VERSION);
  assert.equal(result.envelope.runId, runId);
  assert.deepEqual(result.envelope.metadata.scripts, start("").scripts.map(({ name, status }) => ({ name, status })));
  assert.equal(result.serialized.toString().includes("private"), false);
  assert.deepEqual(INPUT_ENVIRONMENT, { REHOR_INPUT_SOURCE: "sandbox", REHOR_INPUT_FILE: INPUT_FILE_PATH });
});

test("empty starts skip; non-start or malformed results are invalid", () => {
  for (const prompt of ["", " \n\t"]) assert.equal(buildInputEnvelope(start(prompt), runId).status, "skipped");
  for (const value of [undefined, { action: "skip", transcript: "not work", scripts: [] }, { action: "error", transcript: "error", scripts: [] }, { action: "no-scripts", scripts: [] }, { action: "start", prompt: 2, scripts: [] }, { action: "start", prompt: "x", scripts: [{}] }]) {
    assert.equal(buildInputEnvelope(value, runId).status, "invalid");
  }
});

test("64KiB limit applies to entire UTF-8 JSON, not prompt characters", () => {
  const fixed = buildInputEnvelope(start("".padEnd(1, "x")), runId).serialized.byteLength - 1;
  const exact = buildInputEnvelope(start("x".repeat(MAX_INPUT_BYTES - fixed)), runId);
  assert.equal(exact.status, "built");
  assert.equal(exact.serialized.byteLength, MAX_INPUT_BYTES);
  assert.equal(buildInputEnvelope(start(`${exact.envelope.prompt}x`), runId).status, "oversized");
  assert.equal(buildInputEnvelope(start("🦊".repeat(MAX_INPUT_BYTES / 3)), runId).status, "oversized");
});
