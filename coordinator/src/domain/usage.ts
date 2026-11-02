export const TOKEN_CLASSES = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;

export type TokenClass = (typeof TOKEN_CLASSES)[number];

export type TokenCounts = Partial<Record<TokenClass, number>>;

export interface UsageCost {
  amount: number;
  currency: string;
  source: "provider" | "estimated" | "unknown";
  pricing?: string;
}

/** Usage can be emitted incrementally and may remain incomplete after interruption. */
export interface Usage extends Readonly<Record<string, unknown>> {
  requestedModel: string;
  returnedModel?: string;
  /** Provider-qualified snapshot key; legacy runtimes may omit it. */
  modelKey?: string;
  tokenCounts: TokenCounts;
  partial: boolean;
  final: boolean;
  estimated: boolean;
  incomplete: boolean;
  cost?: UsageCost;
}

/**
 * Accumulates usage snapshots with the shared per-model override rules so the
 * coordinator cost budget and the compatibility projection agree on totals.
 */
export class UsageLedger {
  private readonly byModel = new Map<string, Usage>();

  record(usage: Usage): void {
    const model = usage.modelKey ?? usage.returnedModel ?? usage.requestedModel;
    const previous = this.byModel.get(model);
    // Legacy snapshots prefer final over partial. OpenCode modelKey snapshots
    // already include all root/child messages, so a later partial snapshot can
    // legitimately add a new step/message after an earlier final snapshot.
    if (usage.modelKey || !previous || usage.final || !previous.final) {
      this.byModel.set(model, usage);
    }
  }

  /** Latest recorded snapshot per model. */
  usages(): Iterable<Usage> {
    return this.byModel.values();
  }

  /** Sum of latest-per-model cost amounts, skipping unknown-pricing snapshots. */
  totalCostUsd(): number {
    let total = 0;
    for (const usage of this.byModel.values()) {
      if (usage.cost?.source === "unknown") continue;
      total += usage.cost?.amount ?? 0;
    }
    return total;
  }

  /** True when any recorded snapshot carries a cost with usable pricing. */
  hasKnownCost(): boolean {
    for (const usage of this.byModel.values()) {
      if (usage.cost !== undefined && usage.cost.source !== "unknown") return true;
    }
    return false;
  }
}
