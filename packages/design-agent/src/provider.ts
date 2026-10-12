const THINKING_FORMATS = ["openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
type TemplateValue = string | number | boolean | null | { $var: "thinking.enabled" | "thinking.effort" | "thinking.budget"; omitWhenOff?: boolean };
interface Compat {
  thinkingFormat?: typeof THINKING_FORMATS[number];
  supportsReasoningEffort?: boolean;
  supportsStrictMode?: boolean;
  thinkingTokenBudgetField?: "thinking_budget" | "thinking_token_budget" | "thinking_budget_tokens";
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  chatTemplateKwargs?: Record<string, TemplateValue>;
  chatTemplateArgs?: Record<string, TemplateValue>;
}

/** Capability declarations are scoped to the active endpoint/profile, never inferred from ids. */
function configuredCapabilities(id: string, source: string | undefined): Record<string, unknown> | undefined {
  if (!source?.trim()) return undefined;
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("DREAMATIC_MODEL_CAPABILITIES must be a JSON object keyed by exact model id");
  if (!Object.hasOwn(parsed, id)) return undefined;
  const entry = (parsed as Record<string, unknown>)[id];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid model capabilities for ${id}`);
  return entry as Record<string, unknown>;
}

export function modelCapabilitySource(id: string, source = process.env.DREAMATIC_MODEL_CAPABILITIES) {
  return configuredCapabilities(id, source) ? "explicit_configuration" : "unspecified";
}

/** Explicit endpoint capabilities; do not infer unsupported controls from model names. */
export function modelCapabilities(id: string, source = process.env.DREAMATIC_MODEL_CAPABILITIES) {
  const config = configuredCapabilities(id, source);
  if (!config) return { reasoning: false };
  const allowed = ["reasoning", "thinkingFormat", "thinkingLevelMap", "supportsStrictMode", "supportsReasoningEffort", "thinkingTokenBudgetField", "maxTokensField", "maxTokens", "contextWindow", "chatTemplateKwargs", "chatTemplateArgs"];
  const invalid = (field: string): never => { throw new Error(`Invalid model capabilities for ${id}: ${field}`); };
  if (typeof config.reasoning !== "boolean" || Object.keys(config).some(key => !allowed.includes(key))) invalid("use reasoning:boolean and only supported Pi capability fields");
  if (config.thinkingFormat !== undefined && !THINKING_FORMATS.includes(config.thinkingFormat as typeof THINKING_FORMATS[number])) invalid("unknown thinkingFormat");
  for (const field of ["supportsStrictMode", "supportsReasoningEffort"]) if (config[field] !== undefined && typeof config[field] !== "boolean") invalid(`${field} must be boolean`);
  if (!config.reasoning && config.thinkingFormat) throw new Error(`thinkingFormat requires reasoning:true for ${id}`);
  if (!config.reasoning && ["thinkingLevelMap", "thinkingTokenBudgetField", "chatTemplateKwargs", "chatTemplateArgs"].some(field => config[field] !== undefined)) invalid("thinking controls require reasoning:true");
  for (const field of ["maxTokens", "contextWindow"]) if (config[field] !== undefined && (!Number.isSafeInteger(config[field]) || Number(config[field]) <= 0)) invalid(`${field} must be a positive integer`);
  if (config.maxTokens !== undefined && config.contextWindow !== undefined && Number(config.maxTokens) > Number(config.contextWindow)) invalid("maxTokens exceeds contextWindow");
  if (config.maxTokensField !== undefined && !["max_tokens", "max_completion_tokens"].includes(String(config.maxTokensField))) invalid("unknown maxTokensField");
  if (config.thinkingTokenBudgetField !== undefined && !["thinking_budget", "thinking_token_budget", "thinking_budget_tokens"].includes(String(config.thinkingTokenBudgetField))) invalid("unknown thinkingTokenBudgetField");
  if (config.thinkingLevelMap !== undefined) {
    const map = config.thinkingLevelMap;
    if (!map || typeof map !== "object" || Array.isArray(map) || Object.entries(map).some(([level, value]) => !THINKING_LEVELS.includes(level as ThinkingLevel) || (value !== null && (typeof value !== "string" || !value.trim() || value.length > 64)))) invalid("thinkingLevelMap requires supported level keys and nonempty string/null values");
  }
  for (const field of ["chatTemplateKwargs", "chatTemplateArgs"]) {
    const template = config[field];
    if (template === undefined) continue;
    if (!template || typeof template !== "object" || Array.isArray(template)) invalid(`${field} must be an object`);
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) invalid(`${field} has an invalid key`);
      if (value === null || ["string", "boolean"].includes(typeof value) || (typeof value === "number" && Number.isFinite(value))) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field}.${key} has an invalid value`);
      const variable = value as Record<string, unknown>;
      if (!["thinking.enabled", "thinking.effort", "thinking.budget"].includes(String(variable.$var)) || Object.keys(variable).some(key => !["$var", "omitWhenOff"].includes(key)) || (variable.omitWhenOff !== undefined && typeof variable.omitWhenOff !== "boolean")) invalid(`${field}.${key} requires a supported Pi thinking variable`);
    }
    if (config.thinkingFormat !== (field === "chatTemplateKwargs" ? "chat-template" : "baseten")) invalid(`${field} requires the matching thinkingFormat`);
  }
  const compat: Compat = {};
  if (config.thinkingFormat) { compat.thinkingFormat = config.thinkingFormat as NonNullable<Compat["thinkingFormat"]>; compat.supportsReasoningEffort = config.thinkingFormat === "openai"; }
  for (const field of ["supportsStrictMode", "supportsReasoningEffort", "thinkingTokenBudgetField", "maxTokensField", "chatTemplateKwargs", "chatTemplateArgs"] as const) {
    if (config[field] !== undefined) Object.assign(compat, { [field]: config[field] });
  }
  return { reasoning: config.reasoning as boolean,
    ...(Object.keys(compat).length ? { compat } : {}),
    ...(config.thinkingLevelMap ? { thinkingLevelMap: config.thinkingLevelMap as Partial<Record<ThinkingLevel, string | null>> } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: Number(config.maxTokens) } : {}),
    ...(config.contextWindow !== undefined ? { contextWindow: Number(config.contextWindow) } : {}),
  };
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
    input: ["text", "image"] as ("text" | "image")[],
    cost,
    contextWindow: 131_072,
    maxTokens: 16_384,
    ...verifiedCapabilities(id),
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
        input: ["text", "image"] as ("text" | "image")[],
        cost,
        contextWindow: 131_072,
        maxTokens: 16_384,
        ...verifiedCapabilities(id),
      })),
    },
  };
}
