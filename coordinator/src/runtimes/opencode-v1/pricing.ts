import type { TokenCounts, UsageCost } from "../../domain/usage";
import catalog from "./pricing.json";

interface Rates {
  input: number;
  output: number;
  cache: { read: number; write: number };
}

export interface ModelPricing extends Rates {
  tiers?: (Rates & { tier: { type: string; size: number } })[];
  experimentalOver200K?: Rates;
}

const models: Readonly<Record<string, ModelPricing>> = catalog.models;
const providerAliases: Readonly<Record<string, string>> = {
  "rehor-openai": "openai",
  "rehor-openai-chat": "openai",
  vertex: "google-vertex-anthropic",
};
const vertexAliases: Readonly<Record<string, string>> = {
  "claude-haiku-4-5": "claude-haiku-4-5@20251001",
  "claude-opus-4-6": "claude-opus-4-6@default",
  "claude-sonnet-4-6": "claude-sonnet-4-6@default",
};

export function pricingModel(model: string): string {
  const slash = model.indexOf("/");
  if (slash < 0) return model;
  const provider = model.slice(0, slash);
  let id = model.slice(slash + 1);
  const canonical = providerAliases[provider] ?? provider;
  if (canonical === "google-vertex-anthropic") id = vertexAliases[id] ?? id;
  return `${canonical}/${id}`;
}

/** Native normalized tokens already exclude cache from input and reasoning from output. */
export function priceTokens(tokens: TokenCounts, price: ModelPricing): number {
  const { input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0 } = tokens;
  const context = input + cacheRead + cacheWrite;
  // Explicit tiers are authoritative. Native V1 incorrectly applies the legacy 200K
  // fallback below the first explicit tier (e.g. OpenAI's 272K threshold).
  const rates = price.tiers
    ? (price.tiers
        .filter((item) => item.tier.type === "context" && context > item.tier.size)
        .sort((a, b) => b.tier.size - a.tier.size)[0] ?? price)
    : context > 200_000
      ? (price.experimentalOver200K ?? price)
      : price;
  return (
    (input * rates.input +
      (output + reasoning) * rates.output +
      cacheRead * rates.cache.read +
      cacheWrite * rates.cache.write) /
    1_000_000
  );
}

export function usageCost(
  model: string,
  tokens: TokenCounts,
  native: unknown,
): UsageCost | undefined {
  // A positive native amount can include provider-specific billing adjustments.
  // Intentional even for builtin providers: do not silently replace a native
  // report (including V1 tier bugs) with our estimate. "provider" is not invoice proof.
  // Native zero is also the default for unpriced custom models, not proof of free usage.
  if (typeof native === "number" && Number.isFinite(native) && native > 0) {
    return { amount: native, currency: "USD", source: "provider" };
  }
  const price = models[pricingModel(model)];
  if (!price) return undefined;
  return {
    amount: priceTokens(tokens, price),
    currency: "USD",
    source: "estimated",
    pricing: `opencode/${catalog.source.version}:${catalog.source.pricingSha256}`,
  };
}
