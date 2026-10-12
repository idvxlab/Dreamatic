import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDreamaticExtension } from '../dist/extension.js';
import { dreamaticProviderFromEnv } from '../dist/provider.js';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
function harness(workspaceDir, options = {}) {
  const tools = new Map(), handlers = new Map();
  createDreamaticExtension({ workspaceDir, ...options })({ registerTool: tool => tools.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn), registerProvider() {} });
  return { tools, handlers };
}
async function isolated(callback) {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-model-recovery-'));
  const values = { DREAMATIC_API_KEY: 'test-only', DREAMATIC_BASE_URL: 'https://unused.invalid/v1', DREAMATIC_MODEL: 'test-model', DREAMATIC_PROVIDER_TYPE: 'openai-compatible', DREAMATIC_MODEL_CAPABILITIES: '', DREAMATIC_AGENT_RETRY_ATTEMPTS: '5', DREAMATIC_THINKING_LEVEL_DESIGNER: 'high', PI_CODING_AGENT_DIR: join(workspace, 'agent') };
  const keys = [...Object.keys(values), ...['ORCHESTRATOR', 'RESEARCHER', 'REVIEWER', 'BUILDER'].map(role => `DREAMATIC_MODEL_${role}`), 'DREAMATIC_MODEL_DESIGNER'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, values);
    await callback(workspace);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(workspace, { recursive: true, force: true });
  }
}

test('specialist reasoning exhaustion changes a verified control once and stops repeated or unadjustable failures', async () => {
  for (const scenario of [
    { declared: true, level: 'high', calls: 2 },
    { declared: true, level: 'off', calls: 1 },
    { declared: false, level: 'off', calls: 1 },
  ]) await isolated(async workspace => {
    process.env.DREAMATIC_THINKING_LEVEL_DESIGNER = scenario.level;
    if (scenario.declared) process.env.DREAMATIC_MODEL_CAPABILITIES = JSON.stringify({ 'test-model': { reasoning: true, thinkingFormat: 'qwen' } });
    const requests = [];
    globalThis.fetch = async (input, init) => {
      assert.ok(String(input instanceof Request ? input.url : input).startsWith('https://unused.invalid/'), 'unexpected external request');
      requests.push(JSON.parse(init?.body ?? await input.text()));
      const chunks = [
        { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Simulated reasoning only.' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 16384, total_tokens: 16394, completion_tokens_details: { reasoning_tokens: 16384 } } },
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    const { tools } = harness(workspace);
    const context = { cwd: repo, model: dreamaticProviderFromEnv().model };
    await tools.get('run_init').execute('init', { runIdOverride: 'demo', projectTitle: 'Concept', brief: 'Concept design', designScopes: [{ id: 'concept', category: 'industrial', task: 'Design concept' }] }, undefined, undefined, context);
    await assert.rejects(tools.get('spawn_agent').execute('designer-1', { agent: 'designer', runId: 'demo', task: 'Design the assigned concept using Context.' }, undefined, undefined, context), /Reasoning recovery stopped/);
    assert.equal(requests.length, scenario.calls);
    if (scenario.calls === 2) {
      assert.equal(requests[0].enable_thinking, true);
      assert.equal(requests[1].enable_thinking, false);
      assert.ok(JSON.stringify(requests[1].messages).includes('exhausted its allowance on reasoning'));
    }
    assert.equal(process.env.DREAMATIC_THINKING_LEVEL_DESIGNER, scenario.level, 'recovery must not change role configuration');
    const rows = (await readFile(join(workspace, 'runs/demo/.performance/model-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(rows.some(row => row.truncationKind === 'reasoning_exhausted'));
    if (scenario.declared) assert.ok(rows.some(row => row.thinkingObservation === 'reasoning_observed_despite_off_request'));
    else {
      const request = rows.find(row => row.type === 'provider_request');
      assert.equal(request.capabilitySource, 'unspecified');
      assert.equal(request.reasoningCapability, 'unknown');
      assert.equal(request.controlState, 'unspecified');
      assert.equal(request.offControlUnconfirmed, true);
    }
  });
});

test('request telemetry preserves unknown role settings and scopes capability source to the actual model', async () => {
  await isolated(async workspace => {
    delete process.env.DREAMATIC_THINKING_LEVEL_DESIGNER;
    process.env.DREAMATIC_MODEL_CAPABILITIES = JSON.stringify({ unrelated: { reasoning: true, thinkingFormat: 'qwen' }, 'test-model': { reasoning: true, thinkingFormat: 'openai', maxTokens: 8192, contextWindow: 32768 } });
    const profile = dreamaticProviderFromEnv();
    assert.equal(profile.model.maxTokens, 8192);
    assert.equal(profile.registration.models[0].contextWindow, 32768);
    const { handlers } = harness(workspace, { parentInvocation: { id: 'designer', agent: 'designer', runId: 'demo' } });
    await handlers.get('before_provider_request')({ payload: { model: 'other', max_completion_tokens: 16384 } }, { model: { ...profile.model, id: 'other' }, thinkingLevel: 'off' });
    const [request] = (await readFile(join(workspace, 'runs/demo/.performance/model-requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(request.configuredThinkingLevel, null);
    assert.equal(request.sessionThinkingLevel, 'off');
    assert.equal(request.capabilitySource, 'unspecified');
    assert.match(request.endpointFingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(request), /test-only|unused.invalid/);
  });
});
