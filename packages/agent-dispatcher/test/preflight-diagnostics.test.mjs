import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createPreflightRegistry, definePreflight } from "@rehor/preflights";
import {
  isPreflightDiagnostic,
  preflightConfigurationDiagnostics,
  preflightEntryDiagnostics,
} from "../dist/preflight-diagnostics.js";

/** Registry with one parameterized, one bare, and one permissive preflight,
 * mirroring the engine test fixtures. */
const registry = createPreflightRegistry([
  definePreflight({
    id: "needs-params",
    input: z.strictObject({ label: z.string().min(1), limit: z.number().int() }),
    run: async () => ({ status: "skip", content: "" }),
  }),
  definePreflight({
    id: "no-params",
    input: z.strictObject({}),
    run: async () => ({ status: "skip", content: "" }),
  }),
  definePreflight({
    id: "permissive-params",
    input: z.object({ label: z.string() }),
    run: async () => ({ status: "skip", content: "" }),
  }),
]);

test("valid declarations produce no diagnostics", () => {
  assert.deepEqual(preflightConfigurationDiagnostics(
    ["no-params", { id: "needs-params", with: { label: "x", limit: 3 } }],
    registry,
  ), []);
});

test("malformed entries keep full path, code, message and received detail", () => {
  assert.deepEqual(preflightConfigurationDiagnostics([{ id: 5 }, { id: "x", extra: true }], registry), [
    { path: "preflights[0].id", code: "invalid_type", message: "Invalid input: expected string, received number", received: "5" },
    { path: "preflights[1]", code: "unrecognized_keys", message: 'Unrecognized key: "extra"', received: "object" },
  ]);
  assert.deepEqual(preflightConfigurationDiagnostics([{ id: "x", with: 7 }, 42], registry), [
    { path: "preflights[0].with", code: "invalid_type", message: "Invalid input: expected record, received number", received: "7" },
    { path: "preflights[1]", code: "invalid_type", message: "Invalid input: expected object, received number", received: "42" },
  ]);
});

test("non-list declarations report the list shape", () => {
  assert.deepEqual(preflightConfigurationDiagnostics("jira-triage", registry), [
    { path: "preflights", code: "invalid_type", message: "preflights must be a list of preflight entries", received: '"jira-triage"' },
  ]);
});

test("unknown preflight ids are identifiable", () => {
  assert.deepEqual(preflightConfigurationDiagnostics(["nope-unknown-id", { id: "also-nope" }], registry), [
    { path: "preflights[0].id", code: "unknown_preflight", message: "nope-unknown-id: unknown preflight id", received: '"nope-unknown-id"' },
    { path: "preflights[1].id", code: "unknown_preflight", message: "also-nope: unknown preflight id", received: '"also-nope"' },
  ]);
});

test("semantic parameter failures preserve every Zod issue", () => {
  assert.deepEqual(preflightConfigurationDiagnostics(
    [{ id: "needs-params", with: { label: 7, limit: "many", bogus: true } }],
    registry,
  ), [
    { path: "preflights[0].with.label", code: "invalid_type", message: "Invalid input: expected string, received number", received: "7" },
    { path: "preflights[0].with.limit", code: "invalid_type", message: "Invalid input: expected number, received string", received: '"many"' },
    { path: "preflights[0].with", code: "unrecognized_keys", message: 'Unrecognized key: "bogus"', received: "object" },
  ]);
});

test("missing required parameters are identifiable", () => {
  assert.deepEqual(preflightConfigurationDiagnostics(["needs-params"], registry), [
    { path: "preflights[0].with.label", code: "invalid_type", message: "Invalid input: expected string, received undefined", received: "undefined" },
    { path: "preflights[0].with.limit", code: "invalid_type", message: "Invalid input: expected number, received undefined", received: "undefined" },
  ]);
});

test("the entry-shape pass is registry-blind", () => {
  assert.deepEqual(preflightEntryDiagnostics(["nope-unknown-id"]), []);
  assert.deepEqual(preflightEntryDiagnostics([{ id: "nope-unknown-id", with: { label: 7 } }]), []);
});

test("unknown parameters on permissive schemas are visible", () => {
  // A permissive z.object strips unknown keys without failing, so the
  // stripped keys are reported from the supplied map directly.
  assert.deepEqual(preflightConfigurationDiagnostics(
    [{ id: "permissive-params", with: { label: "ok", bogus: 1, extra: true } }],
    registry,
  ), [
    { path: "preflights[0].with.bogus", code: "unrecognized_keys", message: 'Unrecognized key: "bogus"', received: "1" },
    { path: "preflights[0].with.extra", code: "unrecognized_keys", message: 'Unrecognized key: "extra"', received: "true" },
  ]);
  // A strict schema reports through the parse issue; the known-key check
  // adds nothing, so no key is reported twice.
  assert.deepEqual(preflightConfigurationDiagnostics(
    [{ id: "needs-params", with: { label: "ok", limit: 1, bogus: 2 } }],
    registry,
  ), [
    { path: "preflights[0].with", code: "unrecognized_keys", message: 'Unrecognized key: "bogus"', received: "object" },
  ]);
});

test("long received values retain full detail", () => {
  const unknown = `nope-${"x".repeat(300)}`;
  assert.deepEqual(preflightConfigurationDiagnostics([unknown], registry), [
    { path: "preflights[0].id", code: "unknown_preflight", message: `${unknown}: unknown preflight id`, received: JSON.stringify(unknown) },
  ]);
  const long = "y".repeat(500);
  assert.deepEqual(preflightConfigurationDiagnostics([{ id: "needs-params", with: { label: "ok", limit: long } }], registry), [
    { path: "preflights[0].with.limit", code: "invalid_type", message: "Invalid input: expected number, received string", received: JSON.stringify(long) },
  ]);
});

test("every control character is escaped across path, message and received", () => {
  assert.deepEqual(preflightConfigurationDiagnostics([
    { id: "needs-params", with: { label: "ok", limit: 1, "a\u0001b\u0002c": 2 } },
    { id: "permissive-params", with: { label: "ok", "p\u0001q\u0002r": 3 } },
    { id: "needs-params", with: { label: "ok", limit: "d\u007fe\u007ff" } },
  ], registry), [
    { path: "preflights[0].with", code: "unrecognized_keys", message: 'Unrecognized key: "a\\u{1}b\\u{2}c"', received: "object" },
    { path: "preflights[1].with.p\\u{1}q\\u{2}r", code: "unrecognized_keys", message: 'Unrecognized key: "p\\u{1}q\\u{2}r"', received: "3" },
    { path: "preflights[2].with.limit", code: "invalid_type", message: "Invalid input: expected number, received string", received: '"d\\u{7f}e\\u{7f}f"' },
  ]);
  // No raw control character survives in any field (JSON.stringify keeps
  // DEL unescaped, so a missed escape would be visible here).
  const all = preflightConfigurationDiagnostics([
    { id: "needs-params", with: { label: "ok", limit: 1, "a\u0001b\u0002c": 2 } },
    { id: "permissive-params", with: { label: "ok", "p\u0001q\u0002r": 3 } },
    { id: "needs-params", with: { label: "ok", limit: "d\u007fe\u007ff" } },
  ], registry);
  assert.ok(!all.some((item) => Object.values(item).some((field) => /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(field))));
});

test("diagnostic contract accepts exactly four non-empty control-free string fields", () => {
  const valid = { path: "preflights[0].with.label", code: "invalid_type", message: "Invalid input: expected string, received number", received: "123" };
  assert.equal(isPreflightDiagnostic(valid), true);
  assert.equal(isPreflightDiagnostic({ ...valid, message: "x".repeat(10_000) }), true);
  assert.equal(isPreflightDiagnostic({ ...valid, received: "y".repeat(10_000) }), true);
  for (const value of [
    null, "string", 7, [], {},
    { ...valid, extra: "x" },
    { path: "p", code: "c", message: "m" },
    { path: "", code: "c", message: "m", received: "r" },
    { path: 7, code: "c", message: "m", received: "r" },
    { ...valid, message: "m\u0001" },
  ]) {
    assert.equal(isPreflightDiagnostic(value), false, JSON.stringify(value));
  }
});

test("deferred entries mirror structural issues without invoking schema callbacks", () => {
  let transforms = 0;
  let refines = 0;
  const counted = createPreflightRegistry([
    definePreflight({
      id: "counted",
      input: z.strictObject({
        teamFieldId: z.string().regex(/^customfield_\d+$/),
        limit: z.number(),
        label: z.string().transform((value) => {
          transforms += 1;
          return `[${value}]`;
        }),
      }).refine(() => {
        refines += 1;
        return true;
      }),
      run: async () => ({ status: "skip", content: "" }),
    }),
  ]);
  const isPlaceholder = (value) => typeof value === "string" && value.includes("${{");
  const diagnostics = preflightConfigurationDiagnostics(
    [
      // Deferred entry with a missing required parameter (limit) and an
      // incompatible placeholder in a number field: structural issues only.
      { id: "counted", with: { teamFieldId: "${{ secret('settings', 'team') }}", label: "x" } },
      { id: "counted", with: { limit: "${{ secret('settings', 'limit') }}" } },
    ],
    counted,
    isPlaceholder,
  );
  assert.deepEqual(diagnostics, [
    {
      path: "preflights[0].with.limit",
      code: "missing_required_parameter",
      message: 'counted: missing required parameter "limit"',
      received: "undefined",
    },
    {
      path: "preflights[1].with.teamFieldId",
      code: "missing_required_parameter",
      message: 'counted: missing required parameter "teamFieldId"',
      received: "undefined",
    },
    {
      path: "preflights[1].with.label",
      code: "missing_required_parameter",
      message: 'counted: missing required parameter "label"',
      received: "undefined",
    },
    {
      path: "preflights[1].with.limit",
      code: "incompatible_placeholder",
      message: "counted: invalid parameter \"limit\"",
      received: "\"${{ secret('settings', 'limit') }}\"",
    },
  ]);
  // No schema callback ran on the declaration while building diagnostics.
  assert.equal(transforms, 0);
  assert.equal(refines, 0);
  // A deferred entry without structural issues reports nothing at all.
  const compatible = createPreflightRegistry([
    definePreflight({
      id: "compatible",
      input: z.strictObject({ teamFieldId: z.string().transform((value) => { transforms += 1; return value; }) }),
      run: async () => ({ status: "skip", content: "" }),
    }),
  ]);
  assert.deepEqual(
    preflightConfigurationDiagnostics(
      [{ id: "compatible", with: { teamFieldId: "${{ secret('settings', 'team') }}" } }],
      compatible,
      isPlaceholder,
    ),
    [],
  );
  assert.equal(transforms, 0);
});

test("deferred-entry diagnostics report unknown keys and reserved keys never leak the sentinel", () => {
  const registry = createPreflightRegistry([
    definePreflight({
      id: "fielded",
      input: z.strictObject({ teamFieldId: z.string() }),
      run: async () => ({ status: "skip", content: "" }),
    }),
  ]);
  const isPlaceholder = (value) => typeof value === "string" && value.includes("${{");
  // Unknown keys in deferred entries are reported, mirroring the validator.
  const diagnostics = preflightConfigurationDiagnostics(
    [{ id: "fielded", with: { teamFieldId: "${{ secret('settings', 'team') }}", unknownParam: "x" } }],
    registry,
    isPlaceholder,
  );
  assert.deepEqual(diagnostics, [
    {
      path: "preflights[0].with.unknownParam",
      code: "unrecognized_keys",
      message: 'Unrecognized key: "unknownParam"',
      received: '"x"',
    },
  ]);
  // A reserved `with:` key fails entry-shape parsing through a symbol
  // sentinel: the diagnostics may describe the failure by type only, and the
  // sentinel itself (or any value) must never appear.
  const reserved = preflightConfigurationDiagnostics(
    [JSON.parse('{"id":"fielded","with":{"__proto__":5}}')],
    registry,
    isPlaceholder,
  );
  assert.ok(reserved.length > 0);
  const text = JSON.stringify(reserved);
  assert.ok(!text.includes("Symbol"), "diagnostics leaked the sentinel description");
  assert.ok(!text.includes("reserved with"), "diagnostics leaked the sentinel name");
  for (const diagnostic of reserved) {
    // The runtime contract check (four well-formed fields, no control
    // characters) accepts every emitted diagnostic.
    assert.ok(isPreflightDiagnostic(diagnostic));
  }
});
