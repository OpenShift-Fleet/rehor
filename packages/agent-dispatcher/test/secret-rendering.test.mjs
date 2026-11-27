import test from "node:test";
import assert from "node:assert/strict";
import {
  containsSecretTemplate,
  createSecretValueLedger,
  MAX_SECRET_VALUE_BYTES,
  renderSandboxEnvironment,
  renderSecretTemplates,
  scanSecretReferences,
  SecretRenderError,
} from "../dist/secret-rendering.js";

const secret = (entries) => new Map(Object.entries(entries).map(([key, value]) => [key, Buffer.from(value, "utf8")]));

/** A reader serving fixed Secret payloads and recording every read. */
function reader(payloads) {
  const reads = [];
  const read = async (name) => {
    reads.push(name);
    const payload = payloads[name];
    if (payload === undefined) throw new SecretRenderError(`Secret '${name}' was not found`, "configuration", "missing-secret");
    if (payload instanceof Error) throw payload;
    return payload;
  };
  return { read, reads };
}

const assertFails = (promise, failure, category, leaked = []) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof SecretRenderError, `expected SecretRenderError, got ${error}`);
    assert.equal(error.failure, failure);
    if (category) assert.equal(error.category, category);
    for (const value of leaked) assert.ok(!error.message.includes(value), `error message leaked ${value}`);
    return true;
  });

test("renders secret shorthand, mixed static text, and plain values in one set", async () => {
  const { read, reads } = reader({ "slack-webhook": secret({ url: "https://hooks.example/T000/B000/XYZ" }) });
  const rendered = await renderSandboxEnvironment(
    {
      SLACK_WEBHOOK_URL: "${{ secret('slack-webhook', 'url') }}",
      MIXED: "prefix-${{ secret('slack-webhook', 'url') }}/suffix",
      SOME_STATIC_FLAG: "plain value",
    },
    read,
  );
  assert.deepEqual(rendered, {
    SLACK_WEBHOOK_URL: "https://hooks.example/T000/B000/XYZ",
    MIXED: "prefix-https://hooks.example/T000/B000/XYZ/suffix",
    SOME_STATIC_FLAG: "plain value",
  });
  assert.deepEqual(reads, ["slack-webhook"]);
});

test("plain values pass through unrendered without any Secret reads", async () => {
  const fail = async () => {
    throw new Error("no Secret may be read for plain values");
  };
  assert.deepEqual(await renderSandboxEnvironment({ A: "plain", B: "${VAR}" }, fail), { A: "plain", B: "${VAR}" });
  assert.deepEqual(await renderSandboxEnvironment({}, fail), {});
});

test("${VAR} envsubst syntax passes through untouched next to placeholders", async () => {
  const { read } = reader({ "slack-webhook": secret({ url: "https://hooks.example/XYZ" }) });
  const rendered = await renderSandboxEnvironment(
    { A: "${VAR}-${{ secret('slack-webhook', 'url') }}-${OTHER}" },
    read,
  );
  assert.equal(rendered.A, "${VAR}-https://hooks.example/XYZ-${OTHER}");
});

test("tolerates whitespace and either quote style inside placeholders", async () => {
  const { read, reads } = reader({ "slack-webhook": secret({ url: "value-a", b: "value-b" }) });
  const rendered = await renderSandboxEnvironment(
    {
      A: "${{   secret(  'slack-webhook' ,  'url' )   }}",
      B: '${{ secret("slack-webhook", "b") }}',
      C: "${{ secret('slack-webhook','url') ~ secret('slack-webhook','b') }}",
    },
    read,
  );
  assert.deepEqual(rendered, { A: "value-a", B: "value-b", C: "value-avalue-b" });
  assert.deepEqual(reads, ["slack-webhook"]);
});

test("secret() rejects wrong arity and non-string arguments", async () => {
  const value = "SUPER-SECRET-VALUE";
  const { read } = reader({ "slack-webhook": secret({ url: value }) });
  for (const template of [
    "${{ secret('slack-webhook') }}",
    "${{ secret() }}",
    "${{ secret('slack-webhook', 'url', 'extra') }}",
    "${{ secret(1, 'url') }}",
    "${{ secret('slack-webhook', null) }}",
    "${{ secret(name, 'url') }}",
    "${{ secret('slack-webhook', '') }}",
  ]) {
    await assertFails(renderSandboxEnvironment({ A: template }, read), "invalid-reference", "configuration", [value]);
  }
});

test("render-time references that were not prefetched fail closed", async () => {
  const { read, reads } = reader({ "slack-webhook": secret({ url: "value-a" }) });
  // Dynamic argument: the scanner cannot prefetch it, so the wrapper must
  // reject the reference instead of rendering an arbitrary lookup.
  await assertFails(
    renderSandboxEnvironment({ A: "${{ secret('slack' ~ '-webhook', 'url') }}" }, read),
    "invalid-reference",
    "configuration",
  );
  assert.deepEqual(reads, []);
});

test("unknown variables and syntax errors fail closed", async () => {
  const { read } = reader({ "slack-webhook": secret({ url: "value-a" }) });
  for (const template of ["${{ nosuchvar }}", "${{ secret('slack-webhook' }}", "${{ secret.upper('a','b') }}"]) {
    await assertFails(renderSandboxEnvironment({ A: template }, read), "invalid-reference", "configuration", ["value-a"]);
  }
});

test("missing secret and missing key fail the whole value set with no partial rendering", async () => {
  const value = "SUPER-SECRET-VALUE";
  const missing = new SecretRenderError("Secret 'absent' was not found", "configuration", "missing-secret");
  const { read } = reader({ absent: missing, "slack-webhook": secret({ other: value }) });
  await assertFails(
    renderSandboxEnvironment(
      { A: "${{ secret('slack-webhook', 'url') }}", B: "${{ secret('absent', 'url') }}", C: "plain" },
      read,
    ),
    "missing-secret",
    "configuration",
    [value],
  );
  await assertFails(
    renderSandboxEnvironment({ A: "${{ secret('slack-webhook', 'url') }}", B: "plain" }, read),
    "missing-key",
    "configuration",
    [value],
  );
});

test("resolved values must be non-empty, control-free, valid UTF-8, and bounded", async () => {
  const cases = [
    secret({ url: "" }),
    secret({ url: "line-one\nline-two" }),
    secret({ url: "x".repeat(MAX_SECRET_VALUE_BYTES + 1) }),
    new Map([["url", Buffer.from([0xff, 0xfe, 0xfd])]]),
  ];
  for (const data of cases) {
    const { read } = reader({ "slack-webhook": data });
    await assertFails(
      renderSandboxEnvironment({ A: "${{ secret('slack-webhook', 'url') }}" }, read),
      "invalid-value",
      "response",
      ["line-one", "xxxx"],
    );
  }
});

test("prefetch reads each referenced Secret once before rendering", async () => {
  const { read, reads } = reader({
    one: secret({ a: "value-one-a", b: "value-one-b" }),
    two: secret({ a: "value-two-a" }),
  });
  const rendered = await renderSandboxEnvironment(
    {
      A: "${{ secret('one', 'a') }}",
      B: "${{ secret('one', 'b') }}",
      C: "${{ secret('two', 'a') }}${{ secret('one', 'a') }}",
    },
    read,
  );
  assert.deepEqual(rendered, { A: "value-one-a", B: "value-one-b", C: "value-two-avalue-one-a" });
  assert.deepEqual(reads.sort(), ["one", "two"]);
});

test("invalid reference names and keys fail before any read", async () => {
  const { read, reads } = reader({});
  for (const template of [
    "${{ secret('../devbot-secrets', 'url') }}",
    "${{ secret('UPPER', 'url') }}",
    "${{ secret('a b', 'url') }}",
    "${{ secret('slack-webhook', 'no key') }}",
    "${{ secret('slack-webhook', '') }}",
  ]) {
    await assertFails(renderSandboxEnvironment({ A: template }, read), "invalid-reference", "configuration");
  }
  assert.deepEqual(reads, []);
});

test("scanner finds literal references inside placeholder spans only", () => {
  assert.deepEqual(scanSecretReferences("${{ secret('a','b') }}"), [{ name: "a", key: "b" }]);
  assert.deepEqual(scanSecretReferences("${{ secret( 'a' , 'b' ) }}"), [{ name: "a", key: "b" }]);
  assert.deepEqual(scanSecretReferences("literal secret('a','b') without delimiters"), []);
  assert.deepEqual(scanSecretReferences("${{ mysecret('a','b') }}"), []);
  assert.deepEqual(scanSecretReferences("${{ other('a','b') ~ secret('c','d') }}"), [{ name: "c", key: "d" }]);
  assert.deepEqual(scanSecretReferences("${{ secret('a','b') }} ${{ secret('a','b') }}"), [
    { name: "a", key: "b" },
    { name: "a", key: "b" },
  ]);
});

// --- generic literal-tree rendering, hooks, and the rotation ledger ---

test("renderSecretTemplates renders strings across the literal tree and reads nothing without placeholders", async () => {
  const { read, reads } = reader({ settings: secret({ team: "customfield_101", mode: "daily" }) });
  const plain = { a: "plain", b: 3, c: true, d: ["x", "y"] };
  assert.deepEqual(await renderSecretTemplates(plain, read), plain);
  assert.deepEqual(await renderSecretTemplates("plain", read), "plain");
  assert.deepEqual(await renderSecretTemplates([], read), []);
  assert.deepEqual(reads, []);

  const tree = {
    teamFieldId: "${{ secret('settings', 'team') }}",
    plain: "literal",
    nested: ["${{ secret('settings', 'mode') }}-", { inner: "${{ secret('settings', 'team') }}" }],
  };
  assert.deepEqual(await renderSecretTemplates(tree, read), {
    teamFieldId: "customfield_101",
    plain: "literal",
    nested: ["daily-", { inner: "customfield_101" }],
  });
  assert.deepEqual(reads, ["settings"]);
});

test("containsSecretTemplate finds placeholders at any depth and none in plain trees", () => {
  assert.equal(containsSecretTemplate("${{ secret('a','b') }}"), true);
  assert.equal(containsSecretTemplate({ a: { b: ["${{ x }}"] } }), true);
  assert.equal(containsSecretTemplate({ a: { b: ["plain"] }, c: 1 }), false);
  assert.equal(containsSecretTemplate("plain ${VAR}"), false);
  assert.equal(containsSecretTemplate(null), false);
});

test("renderSecretTemplates failure messages use the preflight parameter subject", async () => {
  const { read, reads } = reader({});
  await assertFails(renderSecretTemplates({ a: "${{ secret('../bad', 'k') }}" }, read), "invalid-reference", "configuration");
  await assertFails(renderSecretTemplates({ a: "${{ nosuchvar }}" }, read), "invalid-reference", "configuration");
  assert.deepEqual(reads, []);
});

test("the ledger keeps per-entry observations, binds starts only, and detects divergence without leaking values", async () => {
  const valueA = "SUPER-SECRET-VALUE-A";
  const valueB = "SUPER-SECRET-VALUE-B";
  const ledger = createSecretValueLedger();
  // Entries 0 and 1 observe the SAME reference with different values; entry
  // 2 observes a different reference entirely.
  ledger.observe(0, { name: "settings", key: "team" }, valueA);
  ledger.observe(1, { name: "settings", key: "team" }, valueB);
  ledger.observe(2, { name: "settings", key: "other" }, valueB);
  // Conflicting start observations fail closed with a fixed message.
  assert.throws(() => ledger.bindStartEntries([0, 1, 2]), (error) => {
    assert.ok(error instanceof SecretRenderError);
    assert.equal(error.failure, "rotated");
    assert.ok(!error.message.includes(valueA), "message leaked a rendered value");
    assert.ok(!error.message.includes(valueB), "message leaked a rendered value");
    return true;
  });
  // Binding is atomic: the conflicting run bound nothing, so verify stays
  // vacuous rather than trusting either value.
  ledger.verify({ name: "settings", key: "team" }, valueA);
  // Consistent observations bind one value per start-observed reference;
  // skip-only observations (entry 2) never bind, so their reference
  // verifies vacuously.
  const consistent = createSecretValueLedger();
  consistent.observe(0, { name: "settings", key: "team" }, valueA);
  consistent.observe(1, { name: "settings", key: "team" }, valueA);
  consistent.observe(2, { name: "settings", key: "other" }, valueB);
  consistent.bindStartEntries([0]);
  consistent.verify({ name: "settings", key: "team" }, valueA);
  assert.throws(() => consistent.verify({ name: "settings", key: "team" }, valueB), (error) => {
    assert.ok(error instanceof SecretRenderError);
    assert.equal(error.failure, "rotated");
    return true;
  });
  consistent.verify({ name: "settings", key: "other" }, valueB);
  // Unbound references verify vacuously; the ledger never serializes values.
  consistent.verify({ name: "absent", key: "team" }, valueA);
  const serialized = JSON.stringify(consistent);
  assert.ok(!serialized.includes(valueA));
  assert.ok(!serialized.includes(valueB));
  // A later divergent start observation on an already-bound reference still
  // fails closed when both entries count as starts.
  consistent.observe(9, { name: "settings", key: "team" }, valueB);
  assert.throws(() => consistent.bindStartEntries([0, 9]), /different values/);
});

test("renderSandboxEnvironment verifies against the ledger: rotation fails the whole set", async () => {
  const first = "value-one";
  const second = "value-two";
  let served = first;
  const read = async () => secret({ url: served });
  const ledger = createSecretValueLedger();
  const verify = { onResolved: (reference, value) => ledger.verify(reference, value) };
  const values = { A: "${{ secret('slack-webhook', 'url') }}", B: "plain" };
  // First render records nothing; verification is vacuous and passes.
  assert.deepEqual(await renderSandboxEnvironment(values, read, verify), { A: first, B: "plain" });
  // Bind a start observation, then serve the same value: still passes.
  await renderSecretTemplates({ A: "${{ secret('slack-webhook', 'url') }}" }, read, {
    onResolved: (reference, value) => ledger.observe(0, reference, value),
  });
  ledger.bindStartEntries([0]);
  assert.deepEqual(await renderSandboxEnvironment(values, read, verify), { A: first, B: "plain" });
  // Rotation between the preflight read and the launch read fails closed.
  served = second;
  await assertFails(renderSandboxEnvironment(values, read, verify), "rotated", "configuration", [first, second]);
});
