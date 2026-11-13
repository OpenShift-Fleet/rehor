import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createPreflightRegistry, definePreflight } from "@rehor/preflights";
import { SessionDispatcher } from "../dist/dispatch-sessions.js";
import { runTsPreflight } from "../dist/preflight-engine-ts.js";
import { MAX_INPUT_BYTES } from "../dist/input-envelope.js";

const start = (prompt = "work") => ({ action: "start", prompt, scripts: [] });
const skip = { action: "skip", transcript: "no work", scripts: [] };
const error = { action: "error", transcript: "preflight failed", scripts: [] };
const noScripts = { action: "no-scripts", scripts: [] };

test("empty start skips and invalid or oversized input errors before reservation", async () => {
  const dispatcher = new SessionDispatcher();
  let calls = 0;
  const run = () => { calls++; return "gone"; };
  for (const prompt of ["", " \n\t "]) {
    assert.deepEqual(dispatcher.dispatch("a", start(prompt), run), { status: "skip" });
    assert.equal(dispatcher.size, 0);
  }
  for (const decision of [
    { ...start(), prompt: undefined },
    { ...start(), prompt: 123 },
    { ...start(), scripts: null },
    start("x".repeat(MAX_INPUT_BYTES)),
    { ...start(), scripts: [{ name: "x".repeat(MAX_INPUT_BYTES), status: "start" }] },
  ]) {
    assert.deepEqual(dispatcher.dispatch("a", decision, run), { status: "error" });
    assert.equal(dispatcher.size, 0);
  }
  await Promise.resolve();
  assert.equal(calls, 0);
  const admitted = dispatcher.dispatch("a", start(), run);
  assert.equal(admitted.status, "started");
  assert.equal(await admitted.completion, "gone");
  assert.equal(calls, 1);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("only start launches work; decisions and prompts are not logged", async () => {
  const dispatcher = new SessionDispatcher();
  const calls = [];
  const run = (prompt) => { calls.push(prompt); return "gone"; };
  for (const [result, status] of [[skip, "skip"], [error, "error"], [noScripts, "no-scripts"]]) {
    assert.deepEqual(dispatcher.dispatch("a", result, run), { status });
  }
  assert.equal(dispatcher.size, 0);
  const launched = dispatcher.dispatch("a", start("sensitive prompt"), run);
  assert.equal(launched.status, "started");
  assert.equal(dispatcher.isInFlight("a"), true);
  assert.equal(dispatcher.status("a"), "running");
  assert.deepEqual(calls, []);
  assert.equal(await launched.completion, "gone");
  assert.deepEqual(calls, ["sensitive prompt"]);
  assert.equal(dispatcher.size, 0);
  assert.equal(dispatcher.status("a"), undefined);
});

test("caller can run preflights sequentially while different agent sessions overlap", async () => {
  const dispatcher = new SessionDispatcher();
  const waiting = deferred();
  const events = [];
  const preflight = async (agent) => { events.push(`preflight:${agent}`); return start(agent); };
  const first = dispatcher.dispatch("a", await preflight("a"), async () => {
    events.push("session:a");
    await waiting.promise;
    return "gone";
  });
  assert.equal(first.status, "started");
  const duplicate = dispatcher.dispatch("a", start(), () => { throw new Error("must not run"); });
  assert.deepEqual(duplicate, { status: "busy" });
  const second = dispatcher.dispatch("b", await preflight("b"), () => {
    events.push("session:b");
    return "gone";
  });
  assert.equal(second.status, "started");
  assert.equal(await second.completion, "gone");
  assert.deepEqual(events, ["preflight:a", "preflight:b", "session:a", "session:b"]);
  assert.equal(dispatcher.isInFlight("a"), true);
  waiting.resolve();
  assert.equal(await first.completion, "gone");
  assert.equal(dispatcher.size, 0);
});

test("real sequential work preflights dispatch only start results", async () => {
  // One mutable fake preflight: the run outcome changes between dispatches.
  let outcome = { status: "start", content: "work" };
  const registry = createPreflightRegistry([
    definePreflight({ id: "decision", input: z.strictObject({}), run: async () => outcome }),
  ]);
  const options = {
    profile: { name: "agent", workflow: "custom", preflights: ["decision"] },
    wiring: { instanceId: "fixture-instance", memory: { baseUrl: "https://memory.example", token: "fixture-token" } },
    registry,
  };
  const dispatcher = new SessionDispatcher();
  const session = deferred();
  let launches = 0;
  const run = () => { launches++; return session.promise; };

  const first = dispatcher.dispatch("a", await runTsPreflight(options), run);
  assert.equal(first.status, "started");
  outcome = { status: "skip", content: "nothing" };
  assert.equal(dispatcher.dispatch("b", await runTsPreflight(options), run).status, "skip");
  outcome = { status: "error", content: "failure" };
  assert.equal(dispatcher.dispatch("c", await runTsPreflight(options), run).status, "error");
  assert.equal(launches, 1);
  session.resolve("gone");
  assert.equal(await first.completion, "gone");
});

test("reservation is visible to reentrant session callbacks", async () => {
  const dispatcher = new SessionDispatcher();
  let nested;
  const first = dispatcher.dispatch("a", start(), () => {
    nested = dispatcher.dispatch("a", start(), () => "gone");
    return "not-created";
  });
  assert.equal(await first.completion, "not-created");
  assert.deepEqual(nested, { status: "busy" });
});

test("accepted delete or ambiguous create retain reservation until confirmed", async () => {
  const dispatcher = new SessionDispatcher();
  const first = dispatcher.dispatch("a", start(), () => "unknown");
  assert.equal(first.confirm("gone"), false); // Callback has not settled.
  assert.equal(await first.completion, "unknown");
  assert.equal(dispatcher.status("a"), "retained");
  assert.deepEqual(dispatcher.dispatch("a", start(), () => "gone"), { status: "busy" });
  assert.equal(first.confirm("accepted"), false);
  assert.equal(dispatcher.isInFlight("a"), true);
  assert.equal(first.confirm("gone"), true);
  assert.equal(first.confirm("gone"), false);
  const next = dispatcher.dispatch("a", start(), () => "unknown");
  assert.equal(await next.completion, "unknown");
  assert.equal(first.confirm("gone"), false); // Stale handle cannot release next run.
  assert.equal(dispatcher.isInFlight("a"), true);
  assert.equal(next.confirm("not-created"), true);
  assert.equal(dispatcher.size, 0);
});

test("definite pre-admission failure releases, unexpected failures retain without unhandled rejection", async () => {
  const dispatcher = new SessionDispatcher();
  const failed = dispatcher.dispatch("a", start(), () => "not-created");
  assert.equal(await failed.completion, "not-created");
  assert.equal(dispatcher.isInFlight("a"), false);
  const thrown = dispatcher.dispatch("a", start(), () => { throw new Error("sensitive error"); });
  assert.equal(await thrown.completion, "unknown");
  assert.equal(dispatcher.status("a"), "retained");
  assert.equal(thrown.confirm("not-created"), true);
  const rejected = dispatcher.dispatch("a", start(), async () => { throw new Error("sensitive rejection"); });
  // No completion handler is attached; the dispatcher still consumes rejection.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatcher.status("a"), "retained");
  assert.equal(rejected.confirm("gone"), true);
  const invalid = dispatcher.dispatch("a", start(), () => undefined);
  assert.equal(await invalid.completion, "unknown");
  assert.equal(invalid.confirm("gone"), true);
});

test("drain tracks later admissions; shutdown rejects new work and waits for confirmed cleanup", async () => {
  const dispatcher = new SessionDispatcher();
  const wait = deferred();
  const first = dispatcher.dispatch("a", start(), () => wait.promise);
  let drained = false;
  const draining = dispatcher.drain().then(() => { drained = true; });
  const second = dispatcher.dispatch("b", start(), () => "unknown");
  assert.equal(await second.completion, "unknown");
  wait.resolve("gone");
  assert.equal(await first.completion, "gone");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  let stopped = false;
  const stopping = dispatcher.shutdown().then(() => { stopped = true; });
  assert.deepEqual(dispatcher.dispatch("c", start(), () => "gone"), { status: "shutdown" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(second.confirm("gone"), true);
  await Promise.all([draining, stopping]);
  assert.equal(drained, true);
  assert.equal(stopped, true);
  assert.equal(dispatcher.size, 0);
});
