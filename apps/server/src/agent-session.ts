import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { modelCapabilities } from '@dreamatic/project-data';
import { CONFIG_FIELDS } from './config-store.js';

/** Shared Pi lifecycle/provider setup for design specialists and Editor. */
export async function createDreamaticAgent(options: { root: string; role: string; systemPrompt: string; skills?: string[]; tools: ToolDefinition[]; textOnly?: boolean; env?: NodeJS.ProcessEnv }) {
  const env = options.env ?? process.env;
  const setting = (key: string) => env[key]?.trim() || CONFIG_FIELDS.find(field => field.key === key)?.defaultValue || '';
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd: options.root, agentDir: join(options.root, '.pi'), settingsManager: settings, noExtensions: true, noContextFiles: true, noPromptTemplates: true, additionalSkillPaths: options.skills ?? [], noSkills: !options.skills?.length, systemPrompt: options.systemPrompt });
  await loader.reload();
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  const id = setting(`DREAMATIC_MODEL_${options.role.toUpperCase()}`) || setting('DREAMATIC_MODEL');
  if (!id || !setting('DREAMATIC_BASE_URL') || !setting('DREAMATIC_API_KEY')) throw new Error('Configure reasoning provider, model and API key in System Settings');
  const caps = modelCapabilities(id), catalog = runtime.getModels().find(model => model.id === id);
  const contextWindow = caps.contextWindow || catalog?.contextWindow || Number(setting('DREAMATIC_CONTEXT_WINDOW'));
  const maxTokens = caps.maxTokens || catalog?.maxTokens || Number(setting('DREAMATIC_MAX_TOKENS'));
  if (!contextWindow || !maxTokens) throw new Error('Configure custom model context window and output limit in System Settings');
  runtime.registerProvider('dreamatic', { baseUrl: setting('DREAMATIC_BASE_URL'), apiKey: setting('DREAMATIC_API_KEY'), api: setting('DREAMATIC_PROVIDER_TYPE') === 'openai-responses' ? 'openai-responses' : 'openai-completions', models: [{ id, name: id, input: options.textOnly ? ['text'] : ['text', 'image'], cost: catalog?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens, ...caps }] });
  return createAgentSession({ cwd: options.root, modelRuntime: runtime, model: runtime.getModel('dreamatic', id)!, thinkingLevel: (setting(`DREAMATIC_THINKING_LEVEL_${options.role.toUpperCase()}`) || 'off') as AgentSession['thinkingLevel'], settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.create(options.root, join(options.root, 'sessions', options.role)), tools: ['read', ...options.tools.map(tool => tool.name)], customTools: options.tools });
}
