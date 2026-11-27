import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createPreflightRegistry, definePreflight } from "@rehor/preflights";
import { runTsPreflight } from "../dist/preflight-engine-ts.js";
import { createSecretValueLedger, renderSandboxEnvironment, SecretRenderError } from "../dist/secret-rendering.js";

// The engine consumes only the preflights/workflow fields of a profile.
const profile = (extra = {}) => ({ name: "agent", workflow: "custom", ...extra });
const wiring = () => ({ instanceId: "fixture-instance", memory: { baseUrl: "https://memory.example/mcp", token: "fixture-token" } });

const secret = (entries) => new Map(Object.entries(entries).map(([key, value]) => [key, Buffer.from(value, "utf8")]));

/** A reader serving one payload per call, in order: per-entry freshness tests
 * rotate values by exhausting the queue. Records every read. */
function sequencingReader(payloads) {
  const reads = [];
  const read = async (name) => {
    reads.push(name);
    const payload = payloads.shift();
    if (payload === undefined) throw new SecretRenderError(`Secret '${name}' was not found`, "configuration", "missing-secret");
    if (payload instanceof Error) throw payload;
    return payload;
  };
  return { read, reads };
}

/** Registry of parameterized fakes recording every run with its params.
 * `outcomes` maps id → result status (default skip). */
function fakeRegistry(spec, outcomes = {}) {
  const calls = [];
  const preflights = Object.entries(spec).map(([id, input]) =>
    definePreflight({
      id,
      input,
      run: async (ctx, params) => {
        calls.push({ id, ctx, params });
        return { status: outcomes[id] ?? "skip", content: `ran:${id}` };
      },
    }),
  );
  return { registry: createPreflightRegistry(preflights), calls };
}

const fielded = z.strictObject({ teamFieldId: z.string().regex(/^customfield_\d+$/), note: z.string().optional() });

test("unknown ids and malformed entries fail closed before any Secret read or execution", async () => {
  const { registry, calls } = fakeRegistry({ fielded });
  const { read, reads } = sequencingReader([]);
  const result = await runTsPreflight({
    profile: profile({ preflights: ["nope", { id: "fielded", with: { teamFieldId: "${{ secret('settings', 'team') }}" } }, 42] }),
    wiring: wiring(),
    registry,
    readSecret: read,
  });
  assert.equal(result.action, "error");
  assert.equal(result.reason, "configuration");
  assert.deepEqual(result.scripts, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(reads, []);
});

test("a placeholder in a non-string parameter fails closed before any Secret read", async () => {
  const { registry, calls } = fakeRegistry({ numeric: z.strictObject({ limit: z.number() }) });
  const { read, reads } = sequencingReader([]);
  const result = await runTsPreflight({
    profile: profile({ preflights: [{ id: "numeric", with: { limit: "${{ secret('settings', 'limit') }}" } }] }),
    wiring: wiring(),
    registry,
    readSecret: read,
  });
  assert.equal(result.action, "error");
  assert.equal(result.reason, "configuration");
  assert.equal(result.transcript, 'agent: numeric: invalid parameter "limit"');
  assert.deepEqual(calls, []);
  assert.deepEqual(reads, []);
});

test("malformed placeholders fail closed without any Secret read", async () => {
  const { registry, calls } = fakeRegistry({ fielded });
  const { read, reads } = sequencingReader([secret({ team: "customfield_1" })]);
  for (const template of ["${{ secret('settings') }}", "${{ nosuchvar }}", "${{ secret('settings' }}"]) {
    const result = await runTsPreflight({
      profile: profile({ preflights: [{ id: "fielded", with: { teamFieldId: template } }] }),
      wiring: wiring(),
      registry,
      readSecret: read,
    });
    assert.equal(result.action, "error", template);
    assert.equal(result.reason, "configuration", template);
    // The failing entry is reported as an errored script result with a
    // stable message; the entry never executed.
    assert.deepEqual(result.scripts.map((script) => [script.name, script.status]), [["fielded", "error"]], template);
    assert.ok(result.scripts[0].content.length > 0, template);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(reads, []);
});

test("each entry reads its referenced Secret fresh, immediately before it executes", async () => {
  const { registry, calls } = fakeRegistry({ fielded, second: fielded });
  const { read, reads } = sequencingReader([secret({ team: "customfield_111" }), secret({ team: "customfield_222" })]);
  const result = await runTsPreflight({
    profile: profile({ preflights: [
      { id: "fielded", with: { teamFieldId: "${{ secret('settings', 'team') }}" } },
      { id: "second", with: { teamFieldId: "${{ secret('settings', 'team') }}" } },
    ] }),
    wiring: wiring(),
    registry,
    readSecret: read,
  });
  assert.equal(result.action, "skip");
  // One read per entry — values rotate between entries by design.
  assert.deepEqual(reads, ["settings", "settings"]);
  assert.deepEqual(calls.map((call) => call.params.teamFieldId), ["customfield_111", "customfield_222"]);
  assert.deepEqual(calls.map((call) => call.id), ["fielded", "second"]);
});

test("the per-entry prefetch deduplicates only within that entry", async () => {
  const { registry, calls } = fakeRegistry({ fielded });
  const { read, reads } = sequencingReader([secret({ team: "customfield_333", note: "n" })]);
  const result = await runTsPreflight({
    profile: profile({ preflights: [{ id: "fielded", with: {
      teamFieldId: "${{ secret('settings', 'team') }}",
      note: "pre-${{ secret('settings', 'note') }}-post",
    } }] }),
    wiring: wiring(),
    registry,
    readSecret: read,
  });
  assert.equal(result.action, "skip");
  assert.deepEqual(reads, ["settings"]);
  assert.deepEqual(calls[0].params, { teamFieldId: "customfield_333", note: "pre-n-post" });
});

test("entries without references never read Secrets and need no reader", async () => {
  const defaulted = z.strictObject({ teamFieldId: z.string().regex(/^customfield_\d+$/), flag: z.boolean().default(false) });
  const { registry, calls } = fakeRegistry({ defaulted });
  const fail = async () => { throw new Error("no Secret may be read for literal entries"); };
  const result = await runTsPreflight({
    profile: profile({ preflights: [{ id: "defaulted", with: { teamFieldId: "customfield_9" } }] }),
    wiring: wiring(),
    registry,
    readSecret: fail,
  });
  assert.equal(result.action, "skip");
  // Literal params pass through with schema defaults applied, byte-identical
  // to the pre-rendering engine.
  assert.deepEqual(calls[0].params, { teamFieldId: "customfield_9", flag: false });
  assert.deepEqual(result.scripts, [{ name: "defaulted", status: "skip", content: "ran:defaulted" }]);
  // And with no reader wired at all.
  const bare = await runTsPreflight({
    profile: profile({ preflights: [{ id: "defaulted", with: { teamFieldId: "customfield_9" } }] }),
    wiring: wiring(),
    registry,
  });
  assert.equal(bare.action, "skip");
});

test("a referencing entry without a reader fails closed as a configuration error", async () => {
  const { registry, calls } = fakeRegistry({ fielded });
  const result = await runTsPreflight({
    profile: profile({ preflights: [{ id: "fielded", with: { teamFieldId: "${{ secret('settings', 'team') }}" } }] }),
    wiring: wiring(),
    registry,
  });
  assert.equal(result.action, "error");
  assert.equal(result.reason, "configuration");
  assert.equal(result.transcript, "agent: Preflight secret rendering is not configured");
  assert.deepEqual(calls, []);
});

test("a rendered value failing the preflight schema prevents dispatch without executing the entry", async () => {
  const { registry, calls } = fakeRegistry({ fielded });
  const { read, reads } = sequencingReader([secret({ team: "not-a-field" })]);
  const result = await runTsPreflight({
    profile: profile({ preflights: [{ id: "fielded", with: { teamFieldId: "${{ secret('settings', 'team') }}" } }] }),
    wiring: wiring(),
    registry,
    readSecret: read,
  });
  assert.equal(result.action, "error");
  assert.equal(result.reason, "configuration");
  assert.equal(result.transcript, 'agent: fielded: invalid parameter "teamFieldId"');
  assert.deepEqual(calls, []);
  assert.deepEqual(reads, ["settings"]);
  // No rendered value appears anywhere in the result.
  assert.ok(!JSON.stringify(result).includes("not-a-field"));
});

test("a render failure prevents dispatch even after earlier entries executed", async () => {
  const { registry, calls } = fakeRegistry({ fielded, second: fielded });
  const { read, reads } = sequencingReader([secret({ team: "customfield_5" }), new SecretRenderError("Kubernetes Secret read failed", "network", "transport")]);
  const result = await runTsPreflight({
    profile: profile({ preflights: [
      { id: "fielded", with: { teamFieldId: "${{ secret('settings', 'team') }}" } },
      { id: "second", with: { teamFieldId: "${{ secret('settings', 'team') }}" } },
    ] }),
    wiring: wiring(),
    registry,
    readSecret: read,
  });
  assert.equal(result.action, "error");
  assert.equal(result.reason, "execution");
  assert.equal(result.transcript, "agent: Kubernetes Secret read failed");
  // The first entry's result stays in the cycle report; the second never ran.
  assert.deepEqual(result.scripts.map((script) => [script.name, script.status]), [["fielded", "skip"], ["second", "error"]]);
  assert.deepEqual(calls.map((call) => call.id), ["fielded"]);
  assert.deepEqual(reads, ["settings", "settings"]);
});

test("missing Secrets and keys fail closed with stable value-free messages", async () => {
  const { registry, calls } = fakeRegistry({ fielded });
  const missing = new SecretRenderError("Secret 'settings' was not found", "configuration", "missing-secret");
  const { read } = sequencingReader([missing]);
  const missingResult = await runTsPreflight({
    profile: profile({ preflights: [{ id: "fielded", with: { teamFieldId: "${{ secret('settings', 'team') }}" } }] }),
    wiring: wiring(),
    registry,
    readSecret: read,
  });
  assert.equal(missingResult.action, "error");
  assert.equal(missingResult.reason, "configuration");
  assert.equal(missingResult.transcript, "agent: Secret 'settings' was not found");

  const { read: keyRead } = sequencingReader([secret({ other: "customfield_7" })]);
  const keyResult = await runTsPreflight({
    profile: profile({ preflights: [{ id: "fielded", with: { teamFieldId: "${{ secret('settings', 'team') }}" } }] }),
    wiring: wiring(),
    registry,
    readSecret: keyRead,
  });
  assert.equal(keyResult.action, "error");
  assert.equal(keyResult.transcript, "agent: Secret 'settings' is missing key 'team'");
  assert.deepEqual(calls, []);
});

test("two starts observing different values for one reference never dispatch", async () => {
  const { registry, calls } = fakeRegistry({ fielded: fielded, second: fielded }, { fielded: "start", second: "start" });
  const valueA = "customfield_111";
  const valueB = "customfield_222";
  const { read } = sequencingReader([secret({ team: valueA }), secret({ team: valueB })]);
  const ledger = createSecretValueLedger();
  const result = await runTsPreflight({
    profile: profile({ preflights: [
      { id: "fielded", with: { teamFieldId: "${{ secret('settings', 'team') }}" } },
      { id: "second", with: { teamFieldId: "${{ secret('settings', 'team') }}" } },
    ] }),
    wiring: wiring(),
    registry,
    readSecret: read,
    secretLedger: ledger,
  });
  // A prompt assembled from two different values for one reference is a
  // mixed start state: the dispatch fails closed as a transient error.
  assert.equal(result.action, "error");
  assert.equal(result.reason, "execution");
  assert.equal(result.transcript, "agent: Preflight entries observed different values for one secret during this run");
  assert.deepEqual(result.scripts.map((script) => [script.name, script.status]), [["fielded", "start"], ["second", "start"]]);
  assert.ok(!JSON.stringify(result).includes(valueA));
  assert.ok(!JSON.stringify(result).includes(valueB));
  assert.deepEqual(calls.map((call) => call.id), ["fielded", "second"]);
});

test("start then skip with rotation: the start binds and a rotated launch value is refused", async () => {
  const { registry } = fakeRegistry({ fielded: fielded, second: fielded }, { fielded: "start", second: "skip" });
  const valueA = "customfield_111";
  const valueB = "customfield_222";
  const { read } = sequencingReader([secret({ team: valueA }), secret({ team: valueB })]);
  const ledger = createSecretValueLedger();
  const result = await runTsPreflight({
    profile: profile({ preflights: [
      { id: "fielded", with: { teamFieldId: "${{ secret('settings', 'team') }}" } },
      { id: "second", with: { teamFieldId: "${{ secret('settings', 'team') }}" } },
    ] }),
    wiring: wiring(),
    registry,
    readSecret: read,
    secretLedger: ledger,
  });
  // The prompt carries the start entry's A-derived content only; the engine
  // returns start because the skip's B observation does not bind.
  assert.equal(result.action, "start");
  assert.equal(result.prompt, "ran:fielded");
  // The launch path renders fresh and verifies against the bound start
  // value: a B launch is refused — the sandbox would disagree with the prompt.
  const launchRead = async () => secret({ team: valueB });
  await assert.rejects(
    renderSandboxEnvironment({ X: "${{ secret('settings', 'team') }}" }, launchRead, {
      onResolved: (reference, value) => ledger.verify(reference, value),
    }),
    (error) => error instanceof SecretRenderError && error.failure === "rotated",
  );
  assert.ok(!JSON.stringify(result).includes(valueA));
  assert.ok(!JSON.stringify(result).includes(valueB));
});

test("skip then start with rotation: only the start's value binds", async () => {
  const { registry } = fakeRegistry({ fielded: fielded, second: fielded }, { fielded: "skip", second: "start" });
  const valueA = "customfield_111";
  const valueB = "customfield_222";
  const valueC = "customfield_333";
  const { read } = sequencingReader([secret({ team: valueA }), secret({ team: valueB })]);
  const ledger = createSecretValueLedger();
  const result = await runTsPreflight({
    profile: profile({ preflights: [
      { id: "fielded", with: { teamFieldId: "${{ secret('settings', 'team') }}" } },
      { id: "second", with: { teamFieldId: "${{ secret('settings', 'team') }}" } },
    ] }),
    wiring: wiring(),
    registry,
    readSecret: read,
    secretLedger: ledger,
  });
  // The prompt carries the start entry's B-derived content only, so the
  // bound value is B: the earlier skip's A observation never constrains.
  assert.equal(result.action, "start");
  assert.equal(result.prompt, "ran:second");
  const launch = (served) => renderSandboxEnvironment({ X: "${{ secret('settings', 'team') }}" }, async () => secret({ team: served }), {
    onResolved: (reference, value) => ledger.verify(reference, value),
  });
  // A matching B launch proceeds; a later rotation to C is refused.
  assert.deepEqual(await launch(valueB), { X: valueB });
  await assert.rejects(launch(valueC), (error) => error instanceof SecretRenderError && error.failure === "rotated");
});

test("unchanged values across start entries dispatch and verify at launch", async () => {
  const { registry, calls } = fakeRegistry({ fielded: fielded, second: fielded }, { fielded: "start", second: "start" });
  const value = "customfield_64";
  const { read } = sequencingReader([secret({ team: value }), secret({ team: value })]);
  const ledger = createSecretValueLedger();
  const result = await runTsPreflight({
    profile: profile({ preflights: [
      { id: "fielded", with: { teamFieldId: "${{ secret('settings', 'team') }}" } },
      { id: "second", with: { teamFieldId: "${{ secret('settings', 'team') }}" } },
    ] }),
    wiring: wiring(),
    registry,
    readSecret: read,
    secretLedger: ledger,
  });
  assert.equal(result.action, "start");
  assert.deepEqual(calls.map((call) => call.params.teamFieldId), [value, value]);
  // The ledger carries the rendered value for the launch-time guard...
  ledger.verify({ name: "settings", key: "team" }, value);
  assert.throws(() => ledger.verify({ name: "settings", key: "team" }, "customfield_999"), (error) => {
    assert.ok(error instanceof SecretRenderError);
    assert.equal(error.failure, "rotated");
    return true;
  });
  // ...while the engine result carries neither the value nor the ledger.
  assert.ok(!JSON.stringify(result).includes(value));
  assert.ok(!JSON.stringify(result).includes("ledger"));
});

test("abort while the reader is pending never executes the entry", async () => {
  const controller = new AbortController();
  const { registry, calls } = fakeRegistry({ fielded });
  const read = async () => {
    // The signal fires while this read is pending; it still resolves.
    controller.abort();
    return secret({ team: "customfield_1" });
  };
  const result = await runTsPreflight({
    profile: profile({ preflights: [{ id: "fielded", with: { teamFieldId: "${{ secret('settings', 'team') }}" } }] }),
    wiring: wiring(),
    registry,
    readSecret: read,
    signal: controller.signal,
    secretLedger: createSecretValueLedger(),
  });
  assert.equal(result.action, "error");
  assert.equal(result.reason, "execution");
  assert.equal(result.transcript, "agent: Preflight cancelled");
  assert.deepEqual(result.scripts, []);
  assert.deepEqual(calls, []);
});

test("placeholder-bearing entries invoke input transforms and refinements exactly once, on rendered values", async () => {
  let transforms = 0;
  let refines = 0;
  const refineInputs = [];
  const counted = z.strictObject({
    teamFieldId: z.string().regex(/^customfield_\d+$/),
    label: z.string().transform((value) => {
      transforms += 1;
      return `[${value}]`;
    }),
  }).refine((value) => {
    refines += 1;
    refineInputs.push(value);
    return true;
  }, { message: "never" });
  const { registry, calls } = fakeRegistry({ counted });
  const value = "customfield_77";
  const { read } = sequencingReader([secret({ team: value })]);
  const result = await runTsPreflight({
    profile: profile({ preflights: [{ id: "counted", with: {
      teamFieldId: "${{ secret('settings', 'team') }}",
      label: "plain",
    } }] }),
    wiring: wiring(),
    registry,
    readSecret: read,
  });
  assert.equal(result.action, "skip");
  // Exactly one invocation, on the rendered map: the transform ran before the
  // refinement (label already bracketed) and the refinement saw the rendered
  // value, never the declaration placeholder.
  assert.equal(transforms, 1);
  assert.equal(refines, 1);
  assert.deepEqual(refineInputs, [{ teamFieldId: value, label: "[plain]" }]);
  assert.deepEqual(calls[0].params, { teamFieldId: value, label: "[plain]" });
});

test("a whole-map refinement failing on the rendered value prevents dispatch", async () => {
  const refined = z.strictObject({ teamFieldId: z.string() }).refine(
    (params) => /^customfield_\d+$/.test(params.teamFieldId),
    { message: "team field must be a customfield id" },
  );
  const { registry, calls } = fakeRegistry({ refined });
  const { read, reads } = sequencingReader([secret({ team: "not-a-field" })]);
  const result = await runTsPreflight({
    profile: profile({ preflights: [{ id: "refined", with: { teamFieldId: "${{ secret('settings', 'team') }}" } }] }),
    wiring: wiring(),
    registry,
    readSecret: read,
  });
  assert.equal(result.action, "error");
  assert.equal(result.reason, "configuration");
  assert.equal(result.transcript, "agent: refined: invalid parameters");
  assert.deepEqual(calls, []);
  assert.deepEqual(reads, ["settings"]);
  assert.ok(!JSON.stringify(result).includes("not-a-field"));
});

test("placeholders inside list elements defer to post-render validation of rendered elements", async () => {
  const listed = z.strictObject({ tags: z.array(z.string().regex(/^t\d+$/)) });
  const { registry, calls } = fakeRegistry({ listed });
  const good = sequencingReader([secret({ tag: "t5" })]);
  const accepted = await runTsPreflight({
    profile: profile({ preflights: [{ id: "listed", with: { tags: ["${{ secret('settings', 'tag') }}"] } }] }),
    wiring: wiring(),
    registry,
    readSecret: good.read,
  });
  assert.equal(accepted.action, "skip");
  assert.deepEqual(calls[0].params, { tags: ["t5"] });
  const bad = sequencingReader([secret({ tag: "bad" })]);
  const rejected = await runTsPreflight({
    profile: profile({ preflights: [{ id: "listed", with: { tags: ["${{ secret('settings', 'tag') }}"] } }] }),
    wiring: wiring(),
    registry,
    readSecret: bad.read,
  });
  assert.equal(rejected.action, "error");
  assert.equal(rejected.reason, "configuration");
  assert.equal(rejected.transcript, 'agent: listed: invalid parameter "tags"');
  assert.ok(!JSON.stringify(rejected).includes("bad"));
});

test("missing required parameters fail closed before any Secret read in placeholder-bearing entries", async () => {
  const required = z.strictObject({ teamFieldId: z.string().regex(/^customfield_\d+$/), note: z.string().optional() });
  const { registry, calls } = fakeRegistry({ required });
  const { read, reads } = sequencingReader([]);
  const result = await runTsPreflight({
    profile: profile({ preflights: [{ id: "required", with: { note: "${{ secret('settings', 'note') }}" } }] }),
    wiring: wiring(),
    registry,
    readSecret: read,
  });
  assert.equal(result.action, "error");
  assert.equal(result.reason, "configuration");
  assert.equal(result.transcript, 'agent: required: missing required parameter "teamFieldId"');
  assert.deepEqual(calls, []);
  assert.deepEqual(reads, []);
});

test("entries with rendered parameters share one run context and per-run state", async () => {
  const { registry, calls } = fakeRegistry({ fielded, second: fielded });
  const { read } = sequencingReader([secret({ team: "customfield_1" }), secret({ team: "customfield_2" })]);
  const result = await runTsPreflight({
    profile: profile({ preflights: [
      { id: "fielded", with: { teamFieldId: "${{ secret('settings', 'team') }}" } },
      { id: "second", with: { teamFieldId: "${{ secret('settings', 'team') }}" } },
    ] }),
    wiring: wiring(),
    registry,
    readSecret: read,
  });
  assert.equal(result.action, "skip");
  assert.equal(calls.length, 2);
  assert.strictEqual(calls[0].ctx, calls[1].ctx);
  assert.equal(calls[0].ctx.instanceId, "fixture-instance");
});

test("a placeholder in a coercing parameter defers and the rendered string coerces once", async () => {
  const coercing = z.strictObject({ limit: z.coerce.number(), note: z.string().optional() });
  const { registry, calls } = fakeRegistry({ coercing });
  const { read, reads } = sequencingReader([secret({ limit: "5" })]);
  const result = await runTsPreflight({
    profile: profile({ preflights: [{ id: "coercing", with: { limit: "${{ secret('settings', 'limit') }}" } }] }),
    wiring: wiring(),
    registry,
    readSecret: read,
  });
  assert.equal(result.action, "skip");
  // The single post-render parse performed Zod's own coercion.
  assert.deepEqual(calls[0].params, { limit: 5 });
  assert.deepEqual(reads, ["settings"]);
});

test("a literal containing ${{ no longer passes through verbatim: it renders or fails closed", async () => {
  const { registry, calls } = fakeRegistry({ fielded });
  const { read, reads } = sequencingReader([]);
  // Before secret references existed, a literal like this reached the
  // preflight verbatim. It is now a render template, exactly like a
  // sandbox.env value: a span that is not a valid secret() reference renders
  // through the template engine or fails closed — verbatim passthrough
  // cannot be offered, because a malformed intended reference would then be
  // delivered to the preflight as if it were the configured value.
  const result = await runTsPreflight({
    profile: profile({ preflights: [{ id: "fielded", with: { teamFieldId: "literal ${{ nosuchvar }} value" } }] }),
    wiring: wiring(),
    registry,
    readSecret: read,
  });
  assert.equal(result.action, "error");
  assert.equal(result.reason, "configuration");
  assert.equal(result.transcript, "agent: Preflight parameter value is not a valid template");
  assert.deepEqual(calls, []);
  assert.deepEqual(reads, []);
  // An evaluable span renders — the value the preflight receives is the
  // rendered text, not the declaration. Use an unconstrained string field;
  // the reader is wired but never read (the span carries no reference).
  const plain = fakeRegistry({ plain: z.strictObject({ note: z.string() }) });
  const neverRead = async () => {
    throw new Error("no Secret may be read for a reference-free template");
  };
  const rendered = await runTsPreflight({
    profile: profile({ preflights: [{ id: "plain", with: { note: "v${{ 1 }}" } }] }),
    wiring: wiring(),
    registry: plain.registry,
    readSecret: neverRead,
  });
  assert.equal(rendered.action, "skip");
  assert.equal(plain.calls[0].params.note, "v1");
});
