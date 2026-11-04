import type { OpenCodeProviderConfig } from "./types";

export function parseVertexAllowedModels(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

/** Pick utility model only when provider declaration and deployment allowlist both permit it. */
export function resolveDefaultSmallModel(
  providerId: string,
  model: string,
  providers: readonly OpenCodeProviderConfig[],
  vertexAllowedModels: readonly string[] = [],
): string | undefined {
  const provider = providers.find((item) => item.id === providerId);
  const selectedModel = model.includes("/") ? model : `${providerId}/${model}`;

  if (providerId === "vertex") {
    const preferredModel = "claude-sonnet-4-6";
    return provider?.models?.[preferredModel] !== undefined &&
      vertexAllowedModels.includes(preferredModel)
      ? `vertex/${preferredModel}`
      : selectedModel;
  }

  if (providerId === "rehor-openai" || providerId === "rehor-openai-chat") {
    return selectedModel;
  }

  return undefined;
}
