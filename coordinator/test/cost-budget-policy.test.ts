import { describe, expect, it } from "vitest";

import { CostBudgetPolicy } from "../src/coordinator";
import { type RehorRun, type Usage, UsageLedger } from "../src/domain";
import fixture from "./fixtures/rehor-run.v1.json";

const run: RehorRun = {
  ...(fixture as unknown as RehorRun),
  limits: { timeoutMs: 60_000, budgetUsd: 1 },
};

/** Cumulative same-model snapshot, mirroring OpenCode cost reporting. */
function usage(amount: number, extra: Partial<Usage> = {}): Usage {
  return {
    requestedModel: run.provider.requestedModel,
    modelKey: "vertex/claude-opus-4-6",
    tokenCounts: { input: 100, output: 20 },
    partial: false,
    final: true,
    estimated: false,
    incomplete: false,
    cost: { amount, currency: "USD", source: "provider" },
    ...extra,
  };
}

describe("CostBudgetPolicy", () => {
  it("emits each threshold event once, in order", () => {
    const policy = new CostBudgetPolicy(run);
    const states = [0.5, 0.75, 0.9, 1.0, 1.2, 1.5].map(
      (amount) => policy.observe(usage(amount))?.state,
    );

    expect(states).toEqual(["info", "warning", "critical", "exhausted", undefined, undefined]);
  });

  it("emits only the highest applicable state when spend jumps", () => {
    const policy = new CostBudgetPolicy(run);

    expect(policy.observe(usage(0.97))?.state).toBe("critical");
    // The jump past 100% emits exhausted; the skipped info/warning stay silent.
    expect(policy.observe(usage(1.1))?.state).toBe("exhausted");
    expect(policy.observe(usage(1.2))).toBeUndefined();
  });

  it("keeps the grace window open at 100% and aborts at 115%", () => {
    const exhausted = new CostBudgetPolicy(run);
    exhausted.observe(usage(1.0));
    expect(exhausted.hardLimitReached()).toBe(false);

    const hardLimit = new CostBudgetPolicy(run);
    hardLimit.observe(usage(1.15));
    expect(hardLimit.hardLimitReached()).toBe(true);
  });

  it("fails open once when pricing is affirmatively unknown", () => {
    const policy = new CostBudgetPolicy(run);
    const unknown = (amount: number): Usage =>
      usage(0, { cost: { amount, currency: "USD", source: "unknown" } });

    const first = policy.observe(unknown(0.6));
    expect(first).toMatchObject({ state: "warning" });
    expect(first?.message).toContain("COST BUDGET INACTIVE");
    expect(policy.observe(unknown(0.8))).toBeUndefined();
    expect(policy.hardLimitReached()).toBe(false);

    // Budget enforcement resumes as soon as any snapshot reports known cost.
    expect(policy.observe(usage(1.2))?.state).toBe("exhausted");
    expect(policy.hardLimitReached()).toBe(true);
  });

  it("does not treat a not-yet-settled snapshot as unknown pricing", () => {
    const policy = new CostBudgetPolicy(run);

    // In-flight OpenCode snapshots carry no cost before their step settles.
    expect(
      policy.observe(usage(0, { cost: undefined, partial: true, final: false })),
    ).toBeUndefined();
    expect(policy.observe(usage(0.5))?.state).toBe("info");
  });

  it("rounds event amounts to four decimals", () => {
    const policy = new CostBudgetPolicy(run);
    const event = policy.observe(usage(0.500004));

    expect(event).toMatchObject({ usedUsd: 0.5, budgetUsd: 1 });
    expect(event?.message).toContain("$0.5 of $1 used");
  });
});

describe("UsageLedger", () => {
  it("lets modelKey partial snapshots accumulate after a final snapshot", () => {
    const ledger = new UsageLedger();
    ledger.record(usage(0.25));
    ledger.record(usage(0.5, { partial: true, final: false }));

    expect(ledger.totalCostUsd()).toBe(0.5);
    expect(ledger.hasKnownCost()).toBe(true);
  });

  it("prefers final snapshots for legacy runs without modelKey", () => {
    const ledger = new UsageLedger();
    const legacy = (amount: number, partial: boolean): Usage => ({
      ...usage(amount),
      modelKey: undefined,
      partial,
      final: !partial,
    });
    ledger.record(legacy(0.4, true));
    ledger.record(legacy(0.9, false));
    ledger.record(legacy(0.6, true));

    expect(ledger.totalCostUsd()).toBe(0.9);
  });

  it("sums the latest snapshot per model and skips unknown pricing", () => {
    const ledger = new UsageLedger();
    ledger.record(usage(0.25, { modelKey: "provider/model-a" }));
    ledger.record(usage(0.75, { modelKey: "provider/model-b" }));
    ledger.record(
      usage(5, {
        modelKey: "provider/model-c",
        cost: { amount: 5, currency: "USD", source: "unknown" },
      }),
    );

    expect(ledger.totalCostUsd()).toBe(1);
    expect(ledger.hasKnownCost()).toBe(true);
  });

  it("reports no known cost while pricing is absent", () => {
    const ledger = new UsageLedger();
    ledger.record(usage(0, { cost: undefined }));

    expect(ledger.hasKnownCost()).toBe(false);
    expect(ledger.totalCostUsd()).toBe(0);
  });
});
