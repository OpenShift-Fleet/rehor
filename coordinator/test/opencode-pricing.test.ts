import { createHash } from "node:crypto";
import type { Event as OpenCodeEvent, OpencodeClient } from "@opencode-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { toLegacyCostEntry } from "../src/adapters/compatibility";
import {
  createEventFactory,
  parseRehorEvent,
  parseRehorRun,
  type RehorEvent,
  type Usage,
} from "../src/domain";
import type { CostRecord } from "../src/ports/compatibility";
import { LegacyCompatibilityProjection } from "../src/projections/compatibility";
import {
  createNormalizationContext,
  normalizeOpenCodeEvent,
} from "../src/runtimes/opencode-v1/normalizer";
import {
  type ModelPricing,
  priceTokens,
  pricingModel,
  usageCost,
} from "../src/runtimes/opencode-v1/pricing";
import catalog from "../src/runtimes/opencode-v1/pricing.json";
import { reconcileSession } from "../src/runtimes/opencode-v1/reconcile";
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
  const send = (type: string, properties: Record<string, unknown>) => {
    const result = normalizeOpenCodeEvent({ type, properties } as OpenCodeEvent, factory, context);
    for (const event of result.events) events.push(parseRehorEvent(event));
    return result;
  };
  const info = (
    id = "msg",
    sessionID = "root",
    providerID = "rehor-openai",
    modelID = "gpt-6.1-sol",
    completed = true,
    cost = 0,
  ) => ({
    id,
    sessionID,
    providerID,
    modelID,
    role: "assistant",
    tokens: counts(),
    cost,
    time: { created: 1, ...(completed ? { completed: 2 } : {}) },
  });
  const message = (...args: Parameters<typeof info>) => {
    const value = info(...args);
    send("message.updated", { info: value });
    return value;
  };
  const step = (
    id = "step",
    tokens = counts(),
    sessionID = "root",
    messageID = "msg",
    cost = 0,
  ) => {
    const part = { id, sessionID, messageID, type: "step-finish", tokens, cost, reason: "stop" };
    send("message.part.updated", { part });
    return part;
  };
  const latest = () => events.filter((event) => event.kind === "usage").at(-1)?.payload as Usage;
  const project = async () => {
    const records: CostRecord[] = [];
    const projection = new LegacyCompatibilityProjection({
      costs: {
        write: (record) => {
          records.push(record);
        },
      },
    });
    for (const event of events) await projection.onEvent(event, run);
    await projection.onTerminal(
      { ...factory("terminal", { state: "completed" }), kind: "terminal" },
      run,
    );
    const record = records[0];
    if (!record) throw new Error("cost record missing");
    return record;
  };
  return { factory, context, events, send, info, message, step, latest, project };
}

describe("canonical OpenCode pricing", () => {
  it("retains reproducible generated catalog provenance", () => {
    const sorted = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sorted);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, sorted(v)]),
        );
      return value;
    };
    const hash = createHash("sha256")
      .update(JSON.stringify(sorted(catalog.models)))
      .digest("hex");
    expect(hash).toBe(catalog.source.pricingSha256);
    expect(catalog.source.version).toBe("1.18.35");
  });

  it.each([
    ["rehor-openai/gpt-6.1-sol", 0.0112],
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

  it("uses exact Vertex aliases without direct Anthropic substitution", () => {
    expect(pricingModel("vertex/claude-opus-4-6")).toBe(
      "google-vertex-anthropic/claude-opus-4-6@default",
    );
    expect(pricingModel("vertex/claude-haiku-4-5")).toBe(
      "google-vertex-anthropic/claude-haiku-4-5@20251001",
    );
    expect(pricingModel("google-vertex-anthropic/claude-haiku-4-5")).toBe(
      "google-vertex-anthropic/claude-haiku-4-5@20251001",
    );
    expect(usageCost("vertex/claude-haiku-4-5@other", {}, 0)).toBeUndefined();
    expect(usageCost("anthropic/claude-opus-4-6", {}, 0)).toBeUndefined();
    expect(usageCost("unknown/gpt-6.1-sol", {}, 0)).toBeUndefined();
  });

  it.each(["gpt-6.1-sol", "claude-haiku-4-5", ""])(
    "leaves unqualified %s unchanged without guessing provider pricing",
    (model) => {
      expect(pricingModel(model)).toBe(model);
      expect(usageCost(model, { input: 1000 }, 0)).toBeUndefined();
      expect(usageCost(model, { input: 1000 }, 0.25)).toMatchObject({
        amount: 0.25,
        source: "provider",
      });
    },
  );

  it("honors explicit thresholds including cached context, not legacy 200K fallback", () => {
    const sol = catalog.models["openai/gpt-6.1-sol"];
    expect(priceTokens({ input: 1000, cacheRead: 271000 }, sol)).toBeCloseTo(0.0291);
    expect(priceTokens({ input: 1000, cacheRead: 271001 }, sol)).toBeCloseTo(0.0582002);
    const luna = catalog.models["openai/gpt-6-luna"];
    expect(priceTokens({ input: 250000 }, luna)).toBeCloseTo(0.025);
    // Intentional native precedence, even for V1's premature legacy-tier charge.
    expect(usageCost("openai/gpt-6-luna", { input: 250000 }, 0.05)).toMatchObject({
      amount: 0.05,
      source: "provider",
    });
    expect(priceTokens({ input: 272001 }, luna)).toBeCloseTo(0.0544002);
    const sonnet = catalog.models["google-vertex-anthropic/claude-sonnet-4-6@default"];
    expect(
      priceTokens({ input: 1000, cacheWrite: 200000, output: 100, reasoning: 50 }, sonnet),
    ).toBeCloseTo(1.509375);
    const { tiers: _tiers, ...legacy } = sol;
    expect(priceTokens({ input: 200001 }, legacy)).toBeCloseTo(0.800004);
  });

  it("distinguishes unpriced native zero from an explicitly free catalog entry", async () => {
    expect(usageCost("openai/unpriced", { input: 10 }, 0)).toBeUndefined();
    const models = catalog.models as Record<string, ModelPricing>;
    models["openai/test-free"] = { input: 0, output: 0, cache: { read: 0, write: 0 } };
    try {
      expect(usageCost("openai/test-free", { input: 10 }, 0)).toMatchObject({
        amount: 0,
        source: "estimated",
      });
      const h = harness();
      h.message("msg", "root", "openai", "test-free");
      h.step();
      expect(await h.project()).toMatchObject({
        costUsd: 0,
        costStatus: "estimated",
        costIncomplete: false,
      });
    } finally {
      delete models["openai/test-free"];
    }
    expect(usageCost("custom/model", {}, 0.15)).toMatchObject({ amount: 0.15, source: "provider" });
  });
});

describe("per-step usage and compatibility", () => {
  it.each(["completed", "failed"])(
    "preserves %s root outcome and valid sibling usage while children time out or fail",
    async (outcome) => {
      vi.useFakeTimers();
      try {
        const h = harness();
        for (const id of ["slow", "unavailable", "malformed", "nonarray", "invalid-entry", "valid"])
          h.context.sessionIds.add(id);
        const calls: string[] = [];
        let childSignal: AbortSignal | undefined;
        const client = {
          session: {
            messages: async ({ path, signal }: { path: { id: string }; signal: AbortSignal }) => {
              calls.push(path.id);
              if (path.id === "slow") {
                childSignal = signal;
                return new Promise(() => {}); // Deliberately ignores cancellation.
              }
              if (path.id === "unavailable") throw new Error("session deleted");
              if (path.id === "malformed") return { error: { message: "invalid response" } };
              if (path.id === "nonarray") return { data: { unexpected: true } };
              if (path.id === "invalid-entry") return [null, { info: h.info(), parts: [] }];
              const root = path.id === "root";
              return [
                {
                  info: {
                    ...h.info("msg", path.id),
                    finish: "stop",
                    ...(root && outcome === "failed" ? { error: { message: "root failed" } } : {}),
                  },
                  parts: [
                    {
                      id: "step",
                      messageID: "msg",
                      sessionID: path.id,
                      type: "step-finish",
                      tokens: counts(),
                      cost: 0,
                    },
                  ],
                },
              ];
            },
            status: async () => {
              calls.push("status");
              await new Promise((resolve) => setTimeout(resolve, 30));
              return { root: { type: "idle" } };
            },
          },
        } as unknown as OpencodeClient;
        const pending = reconcileSession(
          { client, sessionId: "root", directory: "/tmp", controller: new AbortController() },
          h.factory,
          h.context,
          100,
          100,
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toEqual(["root", "status"]);
        await vi.advanceTimersByTimeAsync(30);
        expect(calls).toContain("valid");
        expect(childSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(69);
        expect(childSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const result = await pending;
        expect(result.outcome).toBe(outcome);
        expect(result.reason).toBe(outcome === "failed" ? "root failed" : undefined);
        expect(result.turns).toBe(1);
        expect(childSignal?.aborted).toBe(true);
        h.events.push(...result.events);
        const record = await h.project();
        expect(record).toMatchObject({ inputTokens: 2000, costIncomplete: false });
        expect(record.costUsd).toBeCloseTo(0.0224);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("bounds child reconciliation by active cancellation while retaining root outcome", async () => {
    const h = harness();
    h.context.sessionIds.add("child");
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    const client = {
      session: {
        messages: async ({ path, signal }: { path: { id: string }; signal: AbortSignal }) => {
          if (path.id === "root") return [{ info: { ...h.info(), finish: "stop" }, parts: [] }];
          childSignal = signal;
          controller.abort("cancelled");
          return new Promise(() => {});
        },
        status: async () => ({}),
      },
    } as unknown as OpencodeClient;
    const result = await reconcileSession(
      { client, sessionId: "root", directory: "/tmp", controller },
      h.factory,
      h.context,
      1000,
      100,
    );
    expect(childSignal?.aborted).toBe(true);
    expect(result.outcome).toBe("completed");
    expect(result.events.some((event) => event.kind === "usage")).toBe(true);
  });

  it("refreshes seen errored assistants and steps without replaying lifecycle events", async () => {
    const h = harness();
    const info = { ...h.info(), error: { message: "provider failed" }, finish: "stop" };
    h.send("message.updated", { info });
    const step = h.step();
    const correctedInfo = { ...info, cost: 0.5, tokens: counts(2000) };
    const correctedStep = { ...step, tokens: counts(2000) };
    const client = {
      session: {
        messages: async () => [{ info: correctedInfo, parts: [correctedStep] }],
        status: async () => ({}),
      },
    } as unknown as OpencodeClient;
    for (let i = 0; i < 2; i++) {
      const result = await reconcileSession(
        { client, sessionId: "root", directory: "/tmp", controller: new AbortController() },
        h.factory,
        h.context,
        1000,
        100,
      );
      expect(result).toMatchObject({ outcome: "failed", reason: "provider failed", turns: 0 });
      expect(result.events.every((event) => event.kind === "usage")).toBe(true);
      h.events.push(...result.events);
    }
    expect(h.events.filter((event) => event.kind === "error")).toHaveLength(1);
    expect(h.events.filter((event) => event.kind === "model")).toHaveLength(1);
    expect(h.events.filter((event) => event.payload.state === "step_finished")).toHaveLength(1);
    expect(await h.project()).toMatchObject({
      costUsd: 0.5,
      inputTokens: 2000,
      costStatus: "provider",
    });
  });

  it("retains unseen messages, final completions, and unseen step lifecycle events", async () => {
    const h = harness();
    h.message("msg", "root", "rehor-openai", "gpt-6.1-sol", false);
    const client = {
      session: {
        messages: async () => [
          {
            info: { ...h.info(), finish: "stop" },
            parts: [
              {
                id: "final-step",
                messageID: "msg",
                sessionID: "root",
                type: "step-finish",
                tokens: counts(),
                cost: 0,
              },
            ],
          },
          { info: { ...h.info("unseen"), error: { message: "new error" } }, parts: [] },
        ],
        status: async () => ({}),
      },
    } as unknown as OpencodeClient;
    const result = await reconcileSession(
      { client, sessionId: "root", directory: "/tmp", controller: new AbortController() },
      h.factory,
      h.context,
      1000,
      100,
    );
    expect(result.turns).toBe(2);
    expect(result.events.filter((event) => event.kind === "model")).toHaveLength(1);
    expect(result.events.filter((event) => event.kind === "error")).toHaveLength(1);
    expect(result.events.filter((event) => event.payload.state === "step_finished")).toHaveLength(
      1,
    );
    expect(h.context.countedMessages.size).toBe(2);
  });

  it("retains reconciled root usage when a known child is unavailable", async () => {
    const h = harness();
    h.context.sessionIds.add("child");
    const client = {
      session: {
        messages: async ({ path }: { path: { id: string } }) => {
          if (path.id === "child") throw new Error("session deleted");
          return [
            {
              info: h.info(),
              parts: [
                {
                  id: "step",
                  type: "step-finish",
                  sessionID: "root",
                  messageID: "msg",
                  tokens: counts(),
                  cost: 0,
                },
              ],
            },
          ];
        },
        status: async () => ({}),
      },
    } as unknown as OpencodeClient;
    const result = await reconcileSession(
      { client, sessionId: "root", directory: "/tmp", controller: new AbortController() },
      h.factory,
      h.context,
      1000,
      100,
    );
    h.events.push(...result.events);
    expect((await h.project()).costUsd).toBeCloseTo(0.0112);
  });

  it("reconciles observed child sessions and replaces stale step snapshots", async () => {
    const h = harness();
    const root = h.message();
    const child = h.message("msg", "child", "vertex", "claude-opus-4-6");
    h.context.sessionIds.add("child");
    const rootStep = h.step();
    h.step("step", counts(10), "child");
    const corrected = { ...rootStep, sessionID: "child", tokens: counts(2000) };
    const sessions: string[] = [];
    const client = {
      session: {
        messages: async ({ path }: { path: { id: string } }) => {
          sessions.push(path.id);
          return path.id === "root"
            ? [{ info: root, parts: [rootStep] }]
            : [{ info: child, parts: [corrected] }];
        },
        status: async () => ({}),
      },
    } as unknown as OpencodeClient;
    const result = await reconcileSession(
      { client, sessionId: "root", directory: "/tmp", controller: new AbortController() },
      h.factory,
      h.context,
      1000,
      100,
    );
    h.events.push(...result.events);
    expect(sessions).toEqual(["root", "child"]);
    const record = await h.project();
    expect(record.costUsd).toBeCloseTo(0.0112 + 0.0335);
    expect(record).toMatchObject({ inputTokens: 3000, costIncomplete: false });
  });
  it("deduplicates steps and reconciles multi-step assistants without double counting summaries", async () => {
    const h = harness();
    const info = h.message();
    const a = h.step("a", counts(200000, 100, 10000, 0));
    const b = h.step("b", counts(100000, 100, 200000, 0));
    h.step("a", a.tokens);
    const expected = 0.4025 + 0.44225;
    expect(h.latest().cost?.amount).toBeCloseTo(expected);
    const client = {
      session: {
        messages: async () => [{ info, parts: [a, b] }],
        status: async () => ({}),
      },
    } as unknown as OpencodeClient;
    const reconciled = await reconcileSession(
      { client, sessionId: "root", directory: "/tmp", controller: new AbortController() },
      h.factory,
      h.context,
      1000,
      100,
    );
    h.events.push(...reconciled.events);
    const record = await h.project();
    expect(record.costUsd).toBeCloseTo(expected);
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

  it("accepts late step corrections and preserves partial estimates", async () => {
    const h = harness();
    h.message("msg", "root", "rehor-openai", "gpt-6.1-sol", false);
    h.step();
    h.step("step", counts(2000));
    expect(h.latest()).toMatchObject({
      final: false,
      incomplete: true,
      estimated: true,
      tokenCounts: { input: 2000 },
    });
    h.message();
    expect(h.latest()).toMatchObject({
      final: true,
      incomplete: false,
      tokenCounts: { input: 2000 },
    });
    expect((await h.project()).costUsd).toBeCloseTo(0.0132);
  });

  it("uses authoritative positive native assistant totals once, despite zero-cost steps", async () => {
    const h = harness();
    h.message("msg", "root", "custom", "model", true, 2);
    h.step("a");
    h.step("b");
    expect(h.latest()).toMatchObject({
      cost: { amount: 2, source: "provider" },
      tokenCounts: { input: 2000 },
    });
    expect(await h.project()).toMatchObject({ costUsd: 2, costStatus: "provider" });
  });

  it.each(["custom", "rehor-openai"])(
    "retains interrupted cumulative native %s costs through updates and reconciliation",
    async (provider) => {
      const h = harness();
      h.message("msg", "root", provider, "gpt-6.1-sol", false, 2);
      const a = h.step("a");
      h.step("a");
      const b = h.step("b");
      expect(h.latest()).toMatchObject({
        cost: { amount: 2, source: "provider" },
        incomplete: true,
        final: false,
      });
      const info = h.message("msg", "root", provider, "gpt-6.1-sol", false, 3);
      const client = {
        session: {
          messages: async () => [{ info, parts: [a, b] }],
          status: async () => ({ root: { type: "busy" } }),
        },
      } as unknown as OpencodeClient;
      const result = await reconcileSession(
        { client, sessionId: "root", directory: "/tmp", controller: new AbortController() },
        h.factory,
        h.context,
        1000,
        100,
      );
      h.events.push(...result.events);
      expect(await h.project()).toMatchObject({
        costUsd: 3,
        costStatus: "provider",
        costIncomplete: true,
        inputTokens: 2000,
      });
      h.message("msg", "root", provider, "gpt-6.1-sol", true, 3);
      expect(h.latest()).toMatchObject({ cost: { amount: 3 }, incomplete: false });
    },
  );

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
  ])("marks malformed native %s=%s incomplete in steps and summaries", async (field, value) => {
    const tokens: Record<string, unknown> = counts();
    const path = String(field);
    if (path.startsWith("cache.")) (tokens.cache as Record<string, unknown>)[path.slice(6)] = value;
    else tokens[path] = value;
    const h = harness();
    h.send("message.updated", { info: { ...h.info(), tokens, cost: 1 } });
    expect(h.latest()).toMatchObject({ final: true, incomplete: true });
    h.send("message.part.updated", {
      part: {
        id: "step",
        sessionID: "root",
        messageID: "msg",
        type: "step-finish",
        tokens,
        cost: 0,
      },
    });
    expect(await h.project()).toMatchObject({ costUsd: 1, costIncomplete: true });
    h.step();
    expect(h.latest()).toMatchObject({ incomplete: false });
  });

  it.each([
    ["rehor-openai", "gpt-6.1-sol", 0.0224, 1],
    ["rehor-openai-chat", "gpt-6.1-sol", 0.0224, 2],
    ["vertex", "claude-sonnet-4-6", 0.0283, 2],
    ["rehor-openai", "gpt-6-luna", 0.01177, 2],
  ])("accounts for root/child provider %s model %s", async (provider, model, amount, buckets) => {
    const h = harness();
    h.message();
    h.step();
    h.message("msg", "child", provider, model);
    h.step("step", counts(), "child");
    const record = await h.project();
    expect(record.costUsd).toBeCloseTo(amount);
    expect(record.inputTokens).toBe(2000);
    expect(Object.keys(record.modelUsage)).toHaveLength(buckets);
  });

  it("retains steps received before message metadata and labels unknown/incomplete usage", async () => {
    const h = harness();
    h.step();
    h.message();
    expect(h.latest().cost?.amount).toBeCloseTo(0.0112);
    h.message("unknown", "child", "vertex", "claude-missing");
    h.step("unpriced", counts(), "child", "unknown");
    const record = await h.project();
    expect(record).toMatchObject({ costStatus: "estimated", costIncomplete: true });
    expect(record.costUsd).toBeCloseTo(0.0112);
    const unknown = harness();
    unknown.message("msg", "root", "other", "missing");
    unknown.step();
    expect(await unknown.project()).toMatchObject({
      costUsd: 0,
      costStatus: "unknown",
      costIncomplete: true,
    });
  });
});
