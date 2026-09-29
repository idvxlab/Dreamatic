export function dreamaticProviderFromEnv() {
  const apiKey = process.env.DREAMATIC_API_KEY?.trim();
  const baseUrl = process.env.DREAMATIC_BASE_URL?.trim().replace(/\/$/, "");
  const modelId = process.env.DREAMATIC_MODEL?.trim();
  if (!apiKey || !baseUrl || !modelId) return undefined;

  const providerId = "dreamatic-profile";
  const providerType = process.env.DREAMATIC_PROVIDER_TYPE?.trim().toLowerCase() ?? "openai-compatible";
  const api = providerType.includes("responses") ? "openai-responses" as const : "openai-completions" as const;
  const displayName = process.env.DREAMATIC_PROVIDER_NAME?.trim() || "Dreamatic profile";
  const model = {
    id: modelId,
    name: modelId,
    api,
    provider: providerId,
    baseUrl,
    reasoning: false,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131_072,
    maxTokens: 16_384,
  };
  return {
    providerId,
    model,
    registration: {
      name: displayName,
      baseUrl,
      apiKey,
      api,
      models: [{
        id: modelId,
        name: modelId,
        api,
        reasoning: false,
        input: ["text", "image"] as ("text" | "image")[],
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }],
    },
  };
}
