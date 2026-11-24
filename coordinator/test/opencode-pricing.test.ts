import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client";
import { describe, expect, it } from "vitest";
import { toLegacyCostEntry } from "../src/adapters/compatibility";
import {
  createEventFactory,
  parseRehorEvent,
  parseRehorRun,
  type RehorEvent,
  type TerminalState,
  type Usage,
} from "../src/domain";
import type { CostRecord } from "../src/ports/compatibility";
import { LegacyCompatibilityProjection } from "../src/projections/compatibility";
import {
  createNormalizationContext,
  normalizeOpenCodeEvent,
  normalizeOpenCodeMessage,
} from "../src/runtimes/opencode/normalizer";
import {
  type ModelPricing,
  priceTokens,
  pricingModel,
  usageCost,
} from "../src/runtimes/opencode/pricing";
import catalog from "../src/runtimes/opencode/pricing.json";
import runFixture from "./fixtures/rehor-run.v1.json";

const run = {
  ...parseRehorRun(runFixture),
  provider: { id: "rehor-openai", requestedModel: "rehor-openai/gpt-6.1-sol" },
};
const counts = (input = 1000, output = 100, read = 2000, write = 3000, reasoning = 50) => ({
  input,
  output,
  reasoning,
  cache: { read, write },
});

function harness() {
  const factory = createEventFactory(run, "test");
  const context = createNormalizationContext("root", run.provider.requestedModel);
  const events: RehorEvent[] = [];
  let seq = 0;
  const send = (type: string, data: Record<string, unknown>) => {
    const event = { id: `evt-${++seq}`, created: seq, type, data } as OpenCodeEvent;
    const result = normalizeOpenCodeEvent(event, factory, context);
    events.push(...result.events.map(parseRehorEvent));
    return result;
  };
  const message = (
    id = "msg",
    sessionID = "root",
    providerID = "rehor-openai",
    model = "gpt-6.1-sol",
    tokens: unknown = counts(),
    cost = 0,
    completed = true,
  ) => {
    context.sessionIds.add(sessionID);
    const value = {
      id,
      type: "assistant",
      agent: "build",
      model: { id: model, providerID },
      tokens,
      cost,
      content: [],
      time: { created: 1, ...(completed ? { completed: 2 } : {}) },
      finish: "stop",
    } as unknown as SessionMessageInfo;
    const result = normalizeOpenCodeMessage(value, sessionID, factory, context);
    events.push(...result.events.map(parseRehorEvent));
    return value;
  };
  const latest = () => events.filter((event) => event.kind === "usage").at(-1)?.payload as Usage;
  const project = async (state: TerminalState = "completed") => {
    const records: CostRecord[] = [];
    const projection = new LegacyCompatibilityProjection({
      costs: {
        write: (record) => {
          records.push(record);
        },
      },
    });
    for (const event of events) await projection.onEvent(event, run);
    await projection.onTerminal({ ...factory("terminal", { state }), kind: "terminal" }, run);
    const record = records[0];
    if (!record) throw new Error("cost record missing");
    return record;
  };
  return { factory, context, events, send, message, latest, project };
}

describe("canonical OpenCode pricing", () => {
  it.each([
    ["rehor-openai/gpt-6.1-sol", 0.0112],
    ["rehor-openai/gpt-6.1-terra", 0.0056],
    ["rehor-openai-chat/gpt-6-luna", 0.00057],
    ["vertex/claude-opus-4-6", 0.0285],
    ["vertex/claude-sonnet-4-6", 0.0171],
    ["vertex/claude-haiku-4-5", 0.0057],
    ["vertex/claude-haiku-4-5@20251001", 0.0057],
  ])("prices %s cache and visible/reasoning output", (model, amount) => {
    expect(
      usageCost(
        model,
        { input: 1000, output: 100, reasoning: 50, cacheRead: 2000, cacheWrite: 3000 },
        0,
      )?.amount,
    ).toBeCloseTo(amount, 10);
    expect(usageCost(model, {}, 0)?.source).toBe("estimated");
  });

  it("uses exact provider-qualified Vertex aliases", () => {
    expect(pricingModel("vertex/claude-opus-4-6")).toBe(
      "google-vertex-anthropic/claude-opus-4-6@default",
    );
    expect(pricingModel("vertex/claude-haiku-4-5")).toBe(
      "google-vertex-anthropic/claude-haiku-4-5@20251001",
    );
    expect(pricingModel("google-vertex-anthropic/claude-haiku-4-5")).toBe(
      "google-vertex-anthropic/claude-haiku-4-5@20251001",
    );
    for (const model of [
      "vertex/claude-haiku-4-5@other",
      "anthropic/claude-opus-4-6",
      "unknown/gpt-6.1-sol",
    ])
      expect(usageCost(model, {}, 0)).toBeUndefined();
  });

  it.each(["gpt-6.1-sol", "claude-haiku-4-5", ""])("does not guess provider for %s", (model) => {
    expect(pricingModel(model)).toBe(model);
    expect(usageCost(model, { input: 1000 }, 0)).toBeUndefined();
    expect(usageCost(model, {}, 0.25)).toMatchObject({
      amount: 0.25,
      source: "estimated",
      pricing: "opencode/2.1.2:native-catalog",
    });
  });

  it("honors explicit context thresholds including cache and legacy fallback", () => {
    const sol = catalog.models["openai/gpt-6.1-sol"];
    expect(priceTokens({ input: 1000, cacheRead: 271000 }, sol)).toBeCloseTo(0.0291);
    expect(priceTokens({ input: 1000, cacheRead: 271001 }, sol)).toBeCloseTo(0.0582002);
    const luna = catalog.models["openai/gpt-6-luna"];
    expect(priceTokens({ input: 250000 }, luna)).toBeCloseTo(0.025);
    expect(usageCost("openai/gpt-6-luna", { input: 250000 }, 0.05)).toMatchObject({
      amount: 0.05,
      source: "estimated",
    });
    expect(priceTokens({ input: 272001 }, luna)).toBeCloseTo(0.0544002);
    const sonnet = catalog.models["google-vertex-anthropic/claude-sonnet-4-6@default"];
    expect(
      priceTokens({ input: 1000, cacheWrite: 200000, output: 100, reasoning: 50 }, sonnet),
    ).toBeCloseTo(1.509375);
    const terra = catalog.models["openai/gpt-6.1-terra"];
    expect(priceTokens({ input: 1000, cacheRead: 271000 }, terra)).toBeCloseTo(0.01455);
    expect(priceTokens({ input: 1000, cacheRead: 271001 }, terra)).toBeCloseTo(0.0291001);
    const { tiers: _tiers, ...legacy } = sol;
    expect(priceTokens({ input: 200001 }, legacy)).toBeCloseTo(0.800004);
  });

  it("distinguishes unknown zero from explicit free prices", async () => {
    expect(usageCost("openai/unpriced", { input: 10 }, 0)).toBeUndefined();
    const models = catalog.models as Record<string, ModelPricing>;
    models["openai/test-free"] = { input: 0, output: 0, cache: { read: 0, write: 0 } };
    try {
      const h = harness();
      h.message("msg", "root", "openai", "test-free");
      expect(await h.project()).toMatchObject({
        costUsd: 0,
        costStatus: "estimated",
        costIncomplete: false,
      });
    } finally {
      delete models["openai/test-free"];
    }
  });
});

describe("V2 message and step usage", () => {
  it.each([
    ["root", "cancelled"],
    ["child", "cancelled"],
    ["root", "interrupted"],
    ["child", "interrupted"],
  ] as const)(
    "preserves incomplete subtotal when %s step is left pending by %s",
    async (sessionID, state) => {
      const h = harness();
      h.message("first");
      if (sessionID === "child") h.send("session.created", { sessionID, parentID: "root" });
      const started = h.send("session.step.started", {
        sessionID,
        assistantMessageID: "pending",
        model: { providerID: "rehor-openai", id: "gpt-6.1-sol" },
        started: 3,
      });
      expect(started.turns).toBe(0);
      const usage = started.events.find((event) => event.kind === "usage");
      expect(usage?.payload).toMatchObject({
        modelKey: "rehor-openai/gpt-6.1-sol",
        tokenCounts: { input: 1000, output: 100, reasoning: 50 },
        cost: { amount: 0.0112 },
        partial: true,
        final: false,
        incomplete: true,
      });
      expect(usage?.parentEventId).toBe(
        started.events.find((event) => event.kind === "model")?.eventId,
      );
      expect(h.events.map((event) => event.sequence)).toEqual(
        h.events.map((_, index) => index + 1),
      );
      // No step terminal or reconciliation occurs before cancellation/server crash.
      expect(await h.project(state)).toMatchObject({
        costUsd: 0.0112,
        inputTokens: 1000,
        costStatus: "estimated",
        costIncomplete: true,
      });
    },
  );

  it.each(["root", "child"])(
    "replaces %s pending usage with streamed completion or persisted projection",
    async (sessionID) => {
      for (const recovery of [false, true]) {
        const h = harness();
        h.message("first");
        h.context.sessionIds.add(sessionID);
        h.send("session.step.started", {
          sessionID,
          assistantMessageID: "pending",
          model: { providerID: "rehor-openai", id: "gpt-6.1-sol" },
          started: 3,
        });
        if (recovery) h.message("pending", sessionID);
        else {
          const completed = h.send("session.step.ended", {
            sessionID,
            assistantMessageID: "pending",
            tokens: counts(),
            cost: 0,
            finish: "stop",
          });
          expect(completed.turns).toBe(sessionID === "root" ? 1 : 0);
        }
        expect(h.latest()).toMatchObject({ partial: false, final: true, incomplete: false });
        expect(await h.project()).toMatchObject({
          costUsd: 0.0224,
          inputTokens: 2000,
          costIncomplete: false,
        });
        const before = h.events.length;
        h.message("pending", sessionID);
        expect(h.events).toHaveLength(before);
      }
    },
  );

  it.each([true, false])(
    "accounts compaction once across stream/projection (start observed=%s)",
    async (withStart) => {
      const h = harness();
      h.message();
      if (withStart)
        h.send("session.compaction.started", {
          sessionID: "root",
          inputID: "compact",
          reason: "manual",
        });
      h.send("session.compaction.ended", {
        sessionID: "root",
        reason: "manual",
        model: { providerID: "rehor-openai", id: "gpt-6-luna" },
        tokens: counts(),
        cost: 0,
        text: "summary",
      });
      const recovered = normalizeOpenCodeMessage(
        {
          id: "compact",
          type: "compaction",
          status: "completed",
          reason: "manual",
          model: { providerID: "rehor-openai", id: "gpt-6-luna" },
          tokens: counts(),
          cost: 0,
          summary: "summary",
          time: { created: 1 },
        } as SessionMessageInfo,
        "root",
        h.factory,
        h.context,
      );
      h.events.push(...recovered.events);
      expect(recovered.turns).toBe(0);
      expect(recovered.resultText).toBeUndefined();
      expect(await h.project()).toMatchObject({
        costUsd: 0.01177,
        inputTokens: 2000,
        costIncomplete: false,
      });
    },
  );

  it("keeps distinct identical compactions when starts are missed", async () => {
    const h = harness();
    for (let i = 0; i < 2; i++) {
      h.send("session.compaction.ended", {
        sessionID: "root",
        reason: "auto",
        model: { providerID: "rehor-openai", id: "gpt-6-luna" },
        tokens: counts(),
        cost: 0,
        text: "summary",
      });
    }
    for (const id of ["first", "second"]) {
      // The native projection ID derives from its start, not its terminal event.
      const recovered = normalizeOpenCodeMessage(
        {
          id,
          type: "compaction",
          status: "completed",
          reason: "auto",
          model: { providerID: "rehor-openai", id: "gpt-6-luna" },
          tokens: counts(),
          cost: 0,
          summary: "summary",
          time: { created: 1 },
        } as SessionMessageInfo,
        "root",
        h.factory,
        h.context,
      );
      h.events.push(...recovered.events);
    }
    expect(await h.project()).toMatchObject({ costUsd: 0.00114, inputTokens: 2000 });
  });

  it("keeps unmeasured failed root/child steps unknown alongside priced siblings", async () => {
    for (const sessionID of ["root", "child"]) {
      const h = harness();
      h.message();
      h.context.sessionIds.add(sessionID);
      h.send("session.step.started", {
        sessionID,
        assistantMessageID: "failed",
        model: { providerID: "rehor-openai", id: "gpt-6.1-sol" },
        started: 3,
      });
      // V2 publishStepFailure permits neither tokens nor cost when streaming fails.
      h.send("session.step.failed", {
        sessionID,
        assistantMessageID: "failed",
        error: { type: "provider.unknown", message: "stream lost" },
      });
      expect(await h.project()).toMatchObject({
        costUsd: 0.0112,
        inputTokens: 1000,
        costStatus: "estimated",
        costIncomplete: true,
      });
    }
  });

  it("withdraws old model attribution when authoritative projection corrects it", async () => {
    const h = harness();
    h.message("msg", "root", "rehor-openai", "gpt-6.1-sol");
    h.message("msg", "root", "vertex", "claude-sonnet-4-6");
    expect(await h.project()).toMatchObject({ costUsd: 0.0171, inputTokens: 1000 });
    const usage = h.events.filter((event) => event.kind === "usage");
    expect(usage.at(-2)?.payload).toMatchObject({
      modelKey: "rehor-openai/gpt-6.1-sol",
      tokenCounts: { input: 0, output: 0 },
      cost: { amount: 0 },
    });
  });

  it("does not assign a missed child step start to the root model", async () => {
    const h = harness();
    h.context.sessionIds.add("child");
    h.send("session.step.ended", {
      sessionID: "child",
      assistantMessageID: "missed-start",
      tokens: counts(),
      cost: 0,
      finish: "stop",
    });
    expect(h.latest().modelKey).not.toBe(run.provider.requestedModel);
    expect(await h.project()).toMatchObject({ costStatus: "unknown", costIncomplete: true });
    h.message("missed-start", "child", "vertex", "claude-sonnet-4-6");
    expect(await h.project()).toMatchObject({
      costUsd: 0.0171,
      inputTokens: 1000,
      costIncomplete: false,
    });
  });

  it("keeps reattributed unknown-only usage unknown and clears withdrawals after pricing recovers", async () => {
    const h = harness();
    h.message("msg", "root", "unknown", "unknown");
    h.message("msg", "root", "custom", "unpriced");
    expect(await h.project()).toMatchObject({
      costUsd: 0,
      inputTokens: 1000,
      costStatus: "unknown",
      costIncomplete: true,
    });
    h.message("msg", "root", "custom", "unpriced", counts(), 2);
    expect(await h.project()).toMatchObject({
      costUsd: 2,
      inputTokens: 1000,
      costStatus: "estimated",
      costIncomplete: false,
    });
    h.message("msg", "root", "another", "unpriced");
    expect(await h.project()).toMatchObject({ costUsd: 0, costStatus: "unknown" });
  });

  it("deduplicates streamed step usage and persisted projection without cumulative V1 logic", async () => {
    const h = harness();
    h.send("session.step.started", {
      sessionID: "root",
      assistantMessageID: "a",
      model: { providerID: "rehor-openai", id: "gpt-6.1-sol" },
      started: 1,
    });
    const a = counts(200000, 100, 10000, 0);
    const b = counts(100000, 100, 200000, 0);
    h.send("session.step.ended", {
      sessionID: "root",
      assistantMessageID: "a",
      tokens: a,
      cost: 0,
      finish: "tool-calls",
    });
    h.message("a", "root", "rehor-openai", "gpt-6.1-sol", a);
    h.message("b", "root", "rehor-openai", "gpt-6.1-sol", b);
    h.message("a", "root", "rehor-openai", "gpt-6.1-sol", a);
    const record = await h.project();
    expect(record.costUsd).toBeCloseTo(0.4025 + 0.44225);
    expect(record).toMatchObject({
      inputTokens: 300000,
      outputTokens: 300,
      cacheReadTokens: 210000,
      costStatus: "estimated",
      costIncomplete: false,
    });
    expect(toLegacyCostEntry(record)).toMatchObject({
      cost_status: "estimated",
      cost_incomplete: false,
    });
  });

  it("adds per-message native catalog estimates once rather than using a cumulative assistant total", async () => {
    const h = harness();
    h.message("a", "root", "custom", "model", counts(), 2);
    h.message("b", "root", "custom", "model", counts(), 3);
    h.message("a", "root", "custom", "model", counts(), 2);
    expect(h.latest()).toMatchObject({
      cost: { amount: 5, source: "estimated" },
      tokenCounts: { input: 2000 },
      incomplete: false,
    });
    expect(await h.project()).toMatchObject({ costUsd: 5, costStatus: "estimated" });
  });

  it("corrects snapshots and keeps incomplete estimates through interruption", async () => {
    const h = harness();
    h.message("msg", "root", "rehor-openai", "gpt-6.1-sol", counts(), 2, false);
    expect(h.latest()).toMatchObject({
      cost: { amount: 2, source: "estimated" },
      final: false,
      incomplete: true,
    });
    h.message("msg", "root", "rehor-openai", "gpt-6.1-sol", counts(2000), 3, false);
    expect(await h.project()).toMatchObject({
      costUsd: 3,
      inputTokens: 2000,
      costIncomplete: true,
    });
    h.message("msg", "root", "rehor-openai", "gpt-6.1-sol", counts(2000), 3);
    expect(h.latest()).toMatchObject({ final: true, incomplete: false });
  });

  it.each([
    ["reasoning", undefined],
    ["reasoning", -1],
    ["reasoning", Number.NaN],
    ["cache.read", undefined],
    ["cache.read", 1.5],
    ["cache.read", Number.POSITIVE_INFINITY],
    ["cache.write", undefined],
    ["cache.write", "10"],
    ["cache.write", Number.MAX_SAFE_INTEGER + 1],
    ["cache", undefined],
  ])("marks malformed %s=%s incomplete, recovers corrected projection", async (field, value) => {
    const tokens: Record<string, unknown> = counts();
    if (field.startsWith("cache."))
      (tokens.cache as Record<string, unknown>)[field.slice(6)] = value;
    else tokens[field] = value;
    const h = harness();
    h.message("msg", "root", "custom", "model", tokens, 1);
    expect(h.latest()).toMatchObject({ final: true, incomplete: true });
    expect(await h.project()).toMatchObject({ costUsd: 1, costIncomplete: true });
    h.message("msg", "root", "custom", "model", counts(), 1);
    expect(h.latest()).toMatchObject({ incomplete: false });
  });

  it.each([
    ["rehor-openai", "gpt-6.1-sol", 0.0224, 1],
    ["rehor-openai-chat", "gpt-6.1-sol", 0.0224, 2],
    ["vertex", "claude-sonnet-4-6", 0.0283, 2],
    ["rehor-openai", "gpt-6-luna", 0.01177, 2],
  ])("buckets root/child %s/%s correctly", async (provider, model, amount, buckets) => {
    const h = harness();
    h.message();
    h.message("msg", "child", provider, model);
    const record = await h.project();
    expect(record.costUsd).toBeCloseTo(amount);
    expect(record.inputTokens).toBe(2000);
    expect(Object.keys(record.modelUsage)).toHaveLength(buckets);
  });

  it("retains priced siblings with unknown usage and reports unknown-only runs", async () => {
    const h = harness();
    h.message();
    h.message("unknown", "child", "vertex", "missing");
    expect(await h.project()).toMatchObject({
      costUsd: 0.0112,
      costStatus: "estimated",
      costIncomplete: true,
    });
    const unknown = harness();
    unknown.message("msg", "root", "other", "missing");
    expect(await unknown.project()).toMatchObject({
      costUsd: 0,
      costStatus: "unknown",
      costIncomplete: true,
    });
  });
});
