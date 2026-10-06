const PERSONAS = ["orchestrator", "researcher", "designer", "reviewer", "builder"] as const;

function personaModelId(persona: string, fallback: string): string {
  return process.env[`DREAMATIC_MODEL_${persona.toUpperCase()}`]?.trim() || fallback;
}

export function dreamaticThinkingLevel(persona: string, fallback?: string) {
  const configured = process.env[`DREAMATIC_THINKING_LEVEL_${persona.toUpperCase()}`]?.trim().toLowerCase();
  const value = configured || fallback;
  if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value ?? "")) {
    return value as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  }
  return undefined;
}

export function dreamaticProviderFromEnv() {
  const apiKey = process.env.DREAMATIC_API_KEY?.trim();
  const baseUrl = process.env.DREAMATIC_BASE_URL?.trim().replace(/\/$/, "");
  const defaultModelId = process.env.DREAMATIC_MODEL?.trim();
  if (!apiKey || !baseUrl || !defaultModelId) return undefined;

  const providerId = "dreamatic-profile";
  const providerType = process.env.DREAMATIC_PROVIDER_TYPE?.trim().toLowerCase() ?? "openai-compatible";
  const api = providerType.includes("responses") ? "openai-responses" as const : "openai-completions" as const;
  const displayName = process.env.DREAMATIC_PROVIDER_NAME?.trim() || "DreamaticArt profile";
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const modelDescriptor = (id: string) => ({
    id,
    name: id,
    api,
    provider: providerId,
    baseUrl,
    reasoning: false,
    input: ["text", "image"] as ("text" | "image")[],
    cost,
    contextWindow: 131_072,
    maxTokens: 16_384,
  });
  const modelIds = [...new Set([
    defaultModelId,
    ...PERSONAS.map((persona) => personaModelId(persona, defaultModelId)),
  ])];

  return {
    providerId,
    model: modelDescriptor(defaultModelId),
    modelForPersona: (persona: string) => modelDescriptor(personaModelId(persona, defaultModelId)),
    registration: {
      name: displayName,
      baseUrl,
      apiKey,
      api,
      models: modelIds.map((id) => ({
        id,
        name: id,
        api,
        reasoning: false,
        input: ["text", "image"] as ("text" | "image")[],
        cost,
        contextWindow: 131_072,
        maxTokens: 16_384,
      })),
    },
  };
}
