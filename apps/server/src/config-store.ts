import { editCapabilities } from './image-edit-plan.js';
import { parseSkillSources } from './skill-sources.js';
import { modelCapabilities } from "@dreamatic/project-data";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

export interface ConfigField { key: string; label: string; module: string; example: string; description: string; type: string; defaultValue: string; options?: string[]; min?: number; max?: number; restartRequired?: boolean }
export const CONFIG_FIELDS: ConfigField[] = [
  { key: 'DREAMATIC_IMAGE_EDIT_CAPABILITIES', label: 'Image edit capabilities (JSON)', module: 'image', example: '{"sizes":["1024x1024","1536x1024","1024x1536"],"step":16,"maxPixels":4194304}', description: 'Verified edit endpoint constraints for the configured provider and model. Leave blank when unknown. Supports sizes, step, maxPixels and maxEdge.', type: 'text', defaultValue: '' },
  { key: 'DREAMATIC_SKILL_PATHS', label: 'Approved Skill paths by role (JSON)', module: 'system', example: '{"designer":["/absolute/path/to/my-skill"]}', description: 'Optional per-role paths to individual Skill directories or SKILL.md files. Ambient user/project Skills are disabled. Approval grants knowledge reading, not tools or dependency installation.', type: 'text', defaultValue: '' },
  { key: 'DREAMATIC_MODEL_EDITOR', label: 'Editor model', module: 'reasoning', example: 'your-text-model', description: 'Optional. Leave blank to use the default reasoning model.', type: 'text', defaultValue: '' },
  { key: 'DREAMATIC_THINKING_LEVEL_EDITOR', label: 'Editor thinking level', module: 'reasoning', example: 'high', description: 'Optional. Applies only to models that support thinking levels.', type: 'select', defaultValue: '', options: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { key: 'DREAMATIC_IMAGE_EDIT_ENABLED', label: 'Image editing', module: 'image', example: 'true', description: 'Enable prompt-based edits using a source image. Requires an image model that supports editing.', type: 'select', defaultValue: 'true', options: ['true', 'false'] },
  { key: 'DREAMATIC_IMAGE_EDIT_MODEL', label: 'Image edit model', module: 'image', example: 'your-image-edit-model', description: 'Optional. Leave blank to use the image generation model.', type: 'text', defaultValue: '' },
  { key: 'DREAMATIC_IMAGE_EDIT_ENDPOINT', label: 'Edit endpoint', module: 'image', example: 'https://api.example.com/v1/images/edits', description: 'Optional. Leave blank to use /images/edits under the image API base URL.', type: 'url', defaultValue: '' },
  { key: 'DREAMATIC_IMAGE_EDIT_SIZE', label: 'Image edit size', module: 'image', example: '1024x1024', description: 'Fallback only when the user explicitly requests resizing without exact dimensions. Otherwise edits preserve the intended base image dimensions (first input when unclear). Use auto or WIDTHxHEIGHT. Blank uses the image size ceiling.', type: 'text', defaultValue: '' },
  { key: 'DREAMATIC_IMAGE_EDIT_RESPONSE_FORMAT', label: 'Image edit response format', module: 'image', example: 'auto', description: 'Auto omits response_format for GPT image models. Select b64_json or url only if required by your provider.', type: 'select', defaultValue: 'auto', options: ['auto', 'b64_json', 'url'] },
  { key: "DREAMATIC_CONTEXT_WINDOW", label: "Custom model context window", module: "reasoning", example: "32768", description: "Required for models absent from the Pi catalog unless supplied in model capabilities.", type: "number", defaultValue: "", min: 1 },
  { key: "DREAMATIC_MAX_TOKENS", label: "Custom model output limit", module: "reasoning", example: "8192", description: "Required for models absent from the Pi catalog unless supplied in model capabilities.", type: "number", defaultValue: "", min: 1 },

  { key: "DREAMATIC_IMAGE_CAPABILITIES", label: "Verified image capabilities (JSON)", module: "image", example: '{"sizes":["1024x1024"]}', description: "Verified endpoint limits: sizes array. Used when model metadata does not expose supported_sizes. Scoped to the configured provider and model.", type: "text", defaultValue: "" },
  { key: "DREAMATIC_IMAGE_CAPABILITY_TTL_MS", label: "Image capability cache lifetime (ms)", module: "image", example: "604800000", description: "Lifetime of verified metadata cached outside projects.", type: "number", defaultValue: "604800000", min: 1000 },

  { key: "DREAMATIC_MODEL_GENERATION_TIMEOUT_MS", label: "Model generation timeout (ms)", module: "system", example: "300000", description: "Per model response allowance after the first nonempty output. Tool execution time is excluded.", type: "number", defaultValue: "300000", min: 30000, max: 86400000 },
  { key: "DREAMATIC_MODEL_TOTAL_TIMEOUT_MS", label: "Model total response timeout (ms)", module: "system", example: "600000", description: "Optional absolute cap per model response, including first-output wait and generation, excluding tool execution. Blank uses the separate first-output and generation allowances.", type: "number", defaultValue: "", min: 30000, max: 86400000 },
  { key: "DREAMATIC_MODEL_CAPABILITIES", label: "Endpoint model capabilities (JSON)", module: "reasoning", example: '{"exact-model-id":{"reasoning":true,"thinkingFormat":"openai","supportsReasoningEffort":true,"thinkingLevelMap":{"off":null,"low":"low"}}}', description: "Verified capabilities for exact model ids on this profile's endpoint; do not reuse across proxies without verification. Supports Pi thinkingFormat, thinkingLevelMap (null marks unsupported), supportsReasoningEffort, thinkingTokenBudgetField, maxTokensField, maxTokens/contextWindow, and chatTemplateKwargs/Args. Unknown capabilities do not mean thinking is off. supportsStrictMode:true only after endpoint verification.", type: "text", defaultValue: "" },
  { key: "DREAMATIC_SITE_URL", label: "DreamaticSite URL", module: "system", example: "https://www.dreamatic.art/", description: "Official website for Publish. Use HTTPS; localhost HTTP is allowed for development. No login is required.", type: "url", defaultValue: "https://www.dreamatic.art/" },
  {
    "key": "DREAMATIC_SEARCH_PROVIDER",
    "label": "Search provider",
    "module": "search",
    "example": "serper",
    "description": "DuckDuckGo needs no API key. Existing Serper settings remain supported.",
    "type": "select",
    "defaultValue": "",
    "options": [
      "",
      "duckduckgo",
      "serper"
    ]
  },
  {
    "key": "DREAMATIC_SEARCH_API_KEY",
    "label": "Search API key",
    "module": "search",
    "example": "your-serper-api-key",
    "description": "Used by Serper; falls back to legacy SERPER_API_KEY. Leave blank to keep the current key.",
    "type": "secret",
    "defaultValue": ""
  },
  {
    "key": "DREAMATIC_PROVIDER_NAME",
    "label": "Connection name",
    "module": "reasoning",
    "example": "Design studio",
    "description": "Optional display label for this connection; does not switch providers or profiles.",
    "type": "text",
    "defaultValue": ""
  },
  {
    "key": "DREAMATIC_PROVIDER_TYPE",
    "label": "Provider protocol",
    "module": "reasoning",
    "example": "openai-compatible",
    "description": "Select the protocol supported by your provider.",
    "type": "select",
    "defaultValue": "openai-compatible",
    "options": [
      "openai-compatible",
      "openai-responses"
    ]
  },
  {
    "key": "DREAMATIC_BASE_URL",
    "label": "Reasoning API base URL",
    "module": "reasoning",
    "example": "https://api.example.com/v1",
    "description": "Enter the API base URL.",
    "type": "url",
    "defaultValue": ""
  },
  {
    "key": "DREAMATIC_API_KEY",
    "label": "Reasoning API key",
    "module": "reasoning",
    "example": "your-text-api-key",
    "description": "Leave blank to keep the current key.",
    "type": "secret",
    "defaultValue": ""
  },
  {
    "key": "DREAMATIC_MODEL",
    "label": "Default reasoning model",
    "module": "reasoning",
    "example": "your-text-model",
    "description": "Enter the model ID supplied by your provider.",
    "type": "text",
    "defaultValue": ""
  },
  {
    "key": "DREAMATIC_MODEL_ORCHESTRATOR",
    "label": "Orchestrator model",
    "module": "reasoning",
    "example": "your-text-model",
    "description": "Optional. Leave blank to use the default reasoning model.",
    "type": "text",
    "defaultValue": ""
  },
  {
    "key": "DREAMATIC_THINKING_LEVEL_ORCHESTRATOR",
    "label": "Orchestrator thinking level",
    "module": "reasoning",
    "example": "high",
    "description": "Optional. Applies only to models that support thinking levels.",
    "type": "select",
    "defaultValue": "",
    "options": [
      "",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]
  },
  {
    "key": "DREAMATIC_MODEL_RESEARCHER",
    "label": "Researcher model",
    "module": "reasoning",
    "example": "your-text-model",
    "description": "Optional. Leave blank to use the default reasoning model.",
    "type": "text",
    "defaultValue": ""
  },
  {
    "key": "DREAMATIC_THINKING_LEVEL_RESEARCHER",
    "label": "Researcher thinking level",
    "module": "reasoning",
    "example": "high",
    "description": "Optional. Applies only to models that support thinking levels.",
    "type": "select",
    "defaultValue": "",
    "options": [
      "",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]
  },
  {
    "key": "DREAMATIC_MODEL_DESIGNER",
    "label": "Designer model",
    "module": "reasoning",
    "example": "your-text-model",
    "description": "Optional. Leave blank to use the default reasoning model.",
    "type": "text",
    "defaultValue": ""
  },
  {
    "key": "DREAMATIC_THINKING_LEVEL_DESIGNER",
    "label": "Designer thinking level",
    "module": "reasoning",
    "example": "high",
    "description": "Optional. Applies only to models that support thinking levels.",
    "type": "select",
    "defaultValue": "",
    "options": [
      "",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]
  },
  {
    "key": "DREAMATIC_MODEL_BUILDER",
    "label": "Builder model",
    "module": "reasoning",
    "example": "your-text-model",
    "description": "Optional. Leave blank to use the default reasoning model.",
    "type": "text",
    "defaultValue": ""
  },
  {
    "key": "DREAMATIC_THINKING_LEVEL_BUILDER",
    "label": "Builder thinking level",
    "module": "reasoning",
    "example": "high",
    "description": "Optional. Applies only to models that support thinking levels.",
    "type": "select",
    "defaultValue": "",
    "options": [
      "",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]
  },
  {
    "key": "DREAMATIC_IMAGE_BASE_URL",
    "label": "Image API base URL",
    "module": "image",
    "example": "https://api.example.com/v1",
    "description": "",
    "type": "url",
    "defaultValue": "https://api.openai.com/v1"
  },
  {
    "key": "DREAMATIC_IMAGE_API_KEY",
    "label": "Image API key",
    "module": "image",
    "example": "your-image-api-key",
    "description": "Leave blank to keep the current key. Falls back to the reasoning key when not configured separately.",
    "type": "secret",
    "defaultValue": ""
  },
  {
    "key": "DREAMATIC_IMAGE_MODEL",
    "label": "Image model",
    "module": "image",
    "example": "your-image-model",
    "description": "Enter the image model ID supplied by your provider.",
    "type": "text",
    "defaultValue": "gpt-image-1"
  },
  {
    "key": "DREAMATIC_IMAGE_DEFAULT_SIZE",
    "label": "Image size ceiling",
    "module": "image",
    "example": "1536x1024",
    "description": "Each image planned by Designer must fit within this size ceiling.",
    "type": "text",
    "defaultValue": "1024x1024"
  },
  {
    "key": "DREAMATIC_IMAGE_GENERATION_ENDPOINT",
    "label": "Generation endpoint",
    "module": "image",
    "example": "https://api.example.com/v1/images/generations",
    "description": "Optional. Leave blank to use /images/generations under the image API base URL.",
    "type": "url",
    "defaultValue": ""
  },
  {
    "key": "DREAMATIC_IMAGE_RESPONSE_FORMAT",
    "label": "Image response format",
    "module": "image",
    "example": "b64_json",
    "description": "Select the response format supported by your provider.",
    "type": "select",
    "defaultValue": "b64_json",
    "options": [
      "b64_json",
      "url"
    ]
  },
  {
    "key": "PORT",
    "label": "Server port",
    "module": "system",
    "example": "4310",
    "description": "Web server port. Desktop uses an automatically assigned port.",
    "type": "number",
    "defaultValue": "4310",
    "min": 0,
    "max": 65535,
    "restartRequired": false
  },
  {
    "key": "DREAMATIC_WORKSPACE",
    "label": "Workspace directory",
    "module": "system",
    "example": "./workspace",
    "description": "Relative paths resolve from the configuration directory. Applied automatically after saving.",
    "type": "text",
    "defaultValue": "./workspace",
    "restartRequired": false
  },
  {
    "key": "DREAMATIC_IMAGE_RETRY_ATTEMPTS",
    "label": "Image generation retry attempts",
    "module": "system",
    "example": "3",
    "description": "Maximum provider attempts per image in one Builder run, including the initial request. Temporary errors use backoff; exhausted images wait for explicit user retry. Successful images are reused.",
    "type": "number",
    "defaultValue": "3",
    "min": 1,
    "max": 20
  },
  {
    "key": "DREAMATIC_IMAGE_TIMEOUT_MS",
    "label": "Image generation timeout (ms)",
    "module": "system",
    "example": "300000",
    "description": "",
    "type": "number",
    "defaultValue": "300000",
    "min": 1000,
    "max": 86400000
  },
  {
    "key": "DREAMATIC_IMAGE_BODY_IDLE_TIMEOUT_MS",
    "label": "Image body idle timeout (ms)",
    "module": "system",
    "example": "60000",
    "description": "",
    "type": "number",
    "defaultValue": "60000",
    "min": 1000,
    "max": 86400000
  },
  {
    "key": "DREAMATIC_IMAGE_CONCURRENCY",
    "label": "Image batch concurrency",
    "module": "system",
    "example": "2",
    "description": "",
    "type": "number",
    "defaultValue": "2",
    "min": 1,
    "max": 8
  },
  {
    "key": "DREAMATIC_IMAGE_GLOBAL_CONCURRENCY",
    "label": "Global image concurrency",
    "module": "system",
    "example": "4",
    "description": "",
    "type": "number",
    "defaultValue": "4",
    "min": 1,
    "max": 32
  },
  {
    "key": "DREAMATIC_MODEL_TURN_TIMEOUT_MS",
    "label": "Model first output timeout (ms)",
    "module": "system",
    "example": "300000",
    "description": "Wait for the first model output. Researcher has a separate override; tool execution is excluded.",
    "type": "number",
    "defaultValue": "300000",
    "min": 1000,
    "max": 86400000
  },
  {
    "key": "DREAMATIC_MODEL_TURN_TIMEOUT_MS_RESEARCHER",
    "label": "Researcher first output timeout (ms)",
    "module": "system",
    "example": "180000",
    "description": "Researcher first-output wait, independent of the general first-output timeout.",
    "type": "number",
    "defaultValue": "180000",
    "min": 1000,
    "max": 86400000
  },
  {
    "key": "DREAMATIC_MODEL_IDLE_TIMEOUT_MS",
    "label": "Model streaming idle timeout (ms)",
    "module": "system",
    "example": "120000",
    "description": "Maximum silence after the first model output. Resets on nonempty text, thinking or tool-call output; excludes tool execution.",
    "type": "number",
    "defaultValue": "120000",
    "min": 1000,
    "max": 86400000
  },
  {
    "key": "DREAMATIC_IMAGE_RESPONSE_MAX_BYTES",
    "label": "Image response byte limit",
    "module": "system",
    "example": "67108864",
    "description": "Maximum bytes per image API response (including base64 JSON) and per image download. Exceeding the limit is not retried automatically.",
    "type": "number",
    "defaultValue": "67108864",
    "min": 1024,
    "max": 1073741824
  },
  {
    "key": "DREAMATIC_PREVENT_IDLE_SLEEP",
    "label": "Prevent idle sleep during tasks",
    "module": "system",
    "example": "true",
    "description": "Desktop only (macOS and Windows). Prevents idle system sleep while tasks run; releases while waiting or after completion. Does not keep the display awake.",
    "type": "select",
    "defaultValue": "true",
    "options": [
      "true",
      "false"
    ]
  },
];
export const CONFIG_MODULES = [
  { id: "search", title: "Search engine", description: "Search services and API keys" },
  { id: "reasoning", title: "Reasoning models", description: "Default models, Agent overrides and thinking levels" },
  { id: "image", title: "Image model", description: "Generation endpoint, model and image settings" },
  { id: "system", title: "System parameters", description: "Workspace, concurrency, response limits and retries" },
];
const LEGACY_KEYS = { providerName: "DREAMATIC_PROVIDER_NAME", providerType: "DREAMATIC_PROVIDER_TYPE", baseUrl: "DREAMATIC_BASE_URL", model: "DREAMATIC_MODEL", searchProvider: "DREAMATIC_SEARCH_PROVIDER", imageBaseUrl: "DREAMATIC_IMAGE_BASE_URL", imageModel: "DREAMATIC_IMAGE_MODEL", imageGenerationEndpoint: "DREAMATIC_IMAGE_GENERATION_ENDPOINT", imageDefaultSize: "DREAMATIC_IMAGE_DEFAULT_SIZE", imageResponseFormat: "DREAMATIC_IMAGE_RESPONSE_FORMAT" };
async function source(path: string) { return readFile(path, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; }); }
export function searchApiKey(env: NodeJS.ProcessEnv = process.env): string { return env.DREAMATIC_SEARCH_API_KEY?.trim() || env.SERPER_API_KEY?.trim() || ""; }
export async function readRuntimeConfig(repoRoot: string, env: NodeJS.ProcessEnv = process.env) {
  const envPath = join(repoRoot, ".env"), disk = parseEnv(await source(envPath));
  // Explicit .env values win, including intentional blanks. Do not expose secret values.
  const values = Object.fromEntries(CONFIG_FIELDS.filter((field) => field.type !== "secret").map((field) => [field.key, disk[field.key] ?? env[field.key] ?? field.defaultValue]));
  const secretConfigured = Object.fromEntries(CONFIG_FIELDS.filter((field) => field.type === "secret").map((field) => [field.key, Boolean((disk[field.key] ?? env[field.key])?.trim())]));
  const merged = { ...env, ...disk };
  const pendingApply = CONFIG_FIELDS.some(field => Object.hasOwn(disk, field.key) && disk[field.key] !== (env[field.key] ?? field.defaultValue));
  return { ...Object.fromEntries(Object.entries(LEGACY_KEYS).map(([field, key]) => [field, values[key] ?? ""])), envPath, pendingApply, modules: CONFIG_MODULES, fields: CONFIG_FIELDS.filter(field => field.key !== "DREAMATIC_PREVENT_IDLE_SLEEP" || env.DREAMATIC_DESKTOP === "1"), values, secretConfigured,
    textApiKeyConfigured: secretConfigured.DREAMATIC_API_KEY,
    searchApiKeyConfigured: Boolean(searchApiKey(merged)),
    imageApiKeyConfigured: secretConfigured.DREAMATIC_IMAGE_API_KEY || secretConfigured.DREAMATIC_API_KEY,
  };
}
function validate(field: ConfigField, value: unknown): string {
  if (typeof value !== "string" || /[\r\n\0]/u.test(value)) throw new Error(`${field.label}: Values must be single-line text`);
  const trimmed = value.trim();
  if (field.options && !field.options.includes(trimmed)) throw new Error(`${field.label}: Unsupported option`);
  if (field.type === "url" && trimmed) { let url; try { url = new URL(trimmed); } catch { throw new Error(`${field.label}: Enter a complete HTTP(S) URL`); } if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`${field.label}: Enter an HTTP(S) URL without embedded credentials`); }
  if (field.key === 'DREAMATIC_SKILL_PATHS') parseSkillSources(trimmed);
  const validSize = (size: unknown) => typeof size === "string" && /^([1-9]\d*)x([1-9]\d*)$/.test(size) && size.split("x").every(part => Number.isSafeInteger(Number(part)));
  if (field.key === 'DREAMATIC_IMAGE_EDIT_SIZE' && trimmed && trimmed !== 'auto' && !validSize(trimmed)) throw new Error('Image edit size must use auto or WIDTHxHEIGHT');
  if (field.key === 'DREAMATIC_IMAGE_EDIT_CAPABILITIES') editCapabilities(trimmed);
  if (field.key === "DREAMATIC_IMAGE_DEFAULT_SIZE" && !validSize(trimmed)) throw new Error("Image ceiling must use WIDTHxHEIGHT with positive integer dimensions");
  if (field.key === "DREAMATIC_IMAGE_CAPABILITIES" && trimmed) {
    const data = JSON.parse(trimmed);
    if (!Array.isArray(data?.sizes) || !data.sizes.length || !data.sizes.every(validSize)) throw new Error("Image capabilities require a nonempty sizes array of WIDTHxHEIGHT values");
  }
  if (field.key === "DREAMATIC_MODEL_CAPABILITIES" && trimmed) {
    const capabilities: unknown = JSON.parse(trimmed);
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) throw new Error("Model capabilities must be a JSON object");
    for (const id of Object.keys(capabilities)) modelCapabilities(id, trimmed);
  }
  if (field.type === "number" && !trimmed && field.defaultValue === "") return "";
  if (field.type === "number" && (!/^\d+$/u.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) < field.min! || Number(trimmed) > field.max!)) throw new Error(`${field.label}: Enter an integer between ${field.min} and ${field.max}`);
  return trimmed;
}
function encode(value: string): string {
  if (/^[a-z0-9_./:@?&%=+,\-]*$/iu.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  throw new Error("Values cannot contain both single and double quotes");
}
const queues = new Map<string, Promise<unknown>>();
export async function saveRuntimeConfig(repoRoot: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env) {
  for (const key of ['activeProfile', 'imageEditEndpoint']) if (Object.hasOwn(input, key)) throw new Error(`Unsupported configuration field: ${key}`);
  const path = join(repoRoot, ".env");
  const operation = (queues.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const updates = new Map<string, string>();
    for (const [field, key] of Object.entries(LEGACY_KEYS)) if (input.values === undefined && input[field] !== undefined) updates.set(key, validate(CONFIG_FIELDS.find((item) => item.key === key)!, input[field]));
    const legacySecrets = { textApiKey: "DREAMATIC_API_KEY", searchApiKey: "DREAMATIC_SEARCH_API_KEY", imageApiKey: "DREAMATIC_IMAGE_API_KEY" };
    for (const [field, key] of Object.entries(legacySecrets)) if (input[field]) updates.set(key, validate(CONFIG_FIELDS.find((item) => item.key === key)!, input[field]));
    for (const group of ["values", "secrets"]) if (input[group] !== undefined) {
      const entries = input[group];
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error(`${group} must be an object`);
      for (const [key, value] of Object.entries(entries)) {
        const field = CONFIG_FIELDS.find((item) => item.key === key);
        if (!field || (field.type === "secret") !== (group === "secrets")) throw new Error(`Unsupported configuration field: ${key}`);
        const normalized = validate(field, value);
        if (group !== "secrets" || normalized) updates.set(key, normalized);
      }
    }
    // Validate/encode every update before mutating either disk or process environment.
    const encoded = new Map([...updates].map(([key, value]) => [key, encode(value)]));
    const text = await source(path), lines: string[] = [], written = new Set<string>();
    for (const line of text.split(/\r?\n/u)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/u), key = match?.[1];
      if (!key || !encoded.has(key)) lines.push(line);
      else if (!written.has(key)) { lines.push(`${key}=${encoded.get(key)}`); written.add(key); }
    }
    for (const [key, value] of encoded) if (!written.has(key)) lines.push(`${key}=${value}`);
    const nextText = `${lines.join("\n").replace(/\n+$/u, "")}\n`;
    const persisted = parseEnv(nextText);
    for (const field of CONFIG_FIELDS) if (Object.hasOwn(persisted, field.key)) validate(field, persisted[field.key]);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const mode = await stat(path).then((info) => info.mode & 0o777).catch((error) => { if (error.code === "ENOENT") return 0o600; throw error; });
      await writeFile(temporary, nextText, { mode });
      await rename(temporary, path);
      // Applying settings explicitly activates the entire persisted snapshot.
      for (const field of CONFIG_FIELDS) if (Object.hasOwn(persisted, field.key)) env[field.key] = persisted[field.key];
      return await readRuntimeConfig(repoRoot, env);
    } finally { await rm(temporary, { force: true }); }
  });
  queues.set(path, operation);
  try { return await operation; } finally { if (queues.get(path) === operation) queues.delete(path); }
}
