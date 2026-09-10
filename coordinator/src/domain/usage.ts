export const TOKEN_CLASSES = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const;

export type TokenClass = (typeof TOKEN_CLASSES)[number];

export type TokenCounts = Partial<Record<TokenClass, number>>;

export interface UsageCost {
  amount: number;
  currency: string;
  source: "provider" | "estimated" | "unknown";
}

/** Usage can be emitted incrementally and may remain incomplete after interruption. */
export interface Usage extends Readonly<Record<string, unknown>> {
  requestedModel: string;
  returnedModel?: string;
  tokenCounts: TokenCounts;
  partial: boolean;
  final: boolean;
  estimated: boolean;
  incomplete: boolean;
  cost?: UsageCost;
}
