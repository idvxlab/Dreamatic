type ThinkingFormat = "openai" | "qwen" | "qwen-chat-template" | "zai";

/** Explicit endpoint capabilities; do not infer unsupported controls from model names. */
export function modelCapabilities(id: string, source = process.env.DREAMATIC_MODEL_CAPABILITIES) {
  if (!source?.trim()) return { reasoning: false };
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("DREAMATIC_MODEL_CAPABILITIES must be a JSON object keyed by exact model id");
  const entry = Object.hasOwn(parsed, id) ? (parsed as Record<string, unknown>)[id] : undefined;
  if (entry === undefined) return { reasoning: false };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid model capabilities for ${id}`);
  const config = entry as Record<string, unknown>;
  if (typeof config.reasoning !== "boolean" || (config.thinkingFormat !== undefined && !["openai", "qwen", "qwen-chat-template", "zai"].includes(String(config.thinkingFormat))) || (config.supportsStrictMode !== undefined && typeof config.supportsStrictMode !== "boolean") || Object.keys(config).some(key => !["reasoning", "thinkingFormat", "supportsStrictMode"].includes(key))) throw new Error(`Invalid model capabilities for ${id}: use reasoning:boolean, optional thinkingFormat and verified supportsStrictMode:boolean`);
  if (!config.reasoning && config.thinkingFormat) throw new Error(`thinkingFormat requires reasoning:true for ${id}`);
  return { reasoning: config.reasoning, ...((config.thinkingFormat || config.supportsStrictMode !== undefined) ? { compat: { ...(config.thinkingFormat ? { thinkingFormat: config.thinkingFormat as ThinkingFormat, supportsReasoningEffort: config.thinkingFormat === "openai" } : {}), ...(config.supportsStrictMode !== undefined ? { supportsStrictMode: config.supportsStrictMode as boolean } : {}) } } : {}) };
}

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
  const verifiedCapabilities = (id: string) => { const capability = modelCapabilities(id); return { ...capability, compat: { supportsStrictMode: false, ...capability.compat } }; };
  const modelDescriptor = (id: string) => ({
    id,
    name: id,
    api,
    provider: providerId,
    baseUrl,
    ...verifiedCapabilities(id),
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
        ...verifiedCapabilities(id),
        input: ["text", "image"] as ("text" | "image")[],
        cost,
        contextWindow: 131_072,
        maxTokens: 16_384,
      })),
    },
  };
}
