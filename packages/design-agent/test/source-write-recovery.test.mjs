import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceWriteRecovery } from '../dist/source-write-recovery.js';
import { createDreamaticExtension } from '../dist/extension.js';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

const body = '<html>' + 'private-source'.repeat(3000);
const raw = `Validation failed for tool "write":\n  - path: must have required properties path\n\nReceived arguments:\n${JSON.stringify({content:body})}`;
const message = (output, args = {content:body}) => ({role:'assistant',content:[{type:'toolCall',id:'write-1',name:'write',arguments:args}],usage:{output},stopReason:'toolUse'});

test('cap plus missing argument yields bounded suspected-truncation guidance without altering source', () => {
  const recovery = new SourceWriteRecovery();
  const original = message(16384);
  recovery.observe(original, 16384);
  const result = recovery.summarize('write-1', raw);
  assert.equal(result.code, 'source_write_output_limit_suspected');
  assert.deepEqual(result.missingFields, ['path']);
  assert.equal(result.saved, false);
  assert.ok(JSON.stringify(result).length < 1600);
  assert.doesNotMatch(JSON.stringify(result), /private-source|Received arguments/);
  assert.match(result.instruction, /Split.*one file per response/);
  assert.equal(original.content[0].arguments.content, body);
});

test('missing arguments without cap evidence remain parameter errors; unrelated failures pass through', () => {
  for (const limit of [undefined, 20000]) {
    const recovery = new SourceWriteRecovery();
    recovery.observe(message(16384), limit);
    assert.equal(recovery.summarize('write-1', raw).code, 'source_write_invalid_arguments');
  }
  const recovery = new SourceWriteRecovery();
  recovery.observe(message(16384, {path:'plan/html/bridge/index.html',content:body}), 16384);
  assert.equal(recovery.summarize('write-1', 'Permission denied'), undefined);
  recovery.observe(message(16384), 16384);
  recovery.clear();
  assert.equal(recovery.summarize('write-1', raw).code, 'source_write_invalid_arguments');
});

test('Designer message_end compacts native validation errors even when tool_result was bypassed', async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'dreamatic-source-recovery-'));
  try {
    const handlers = new Map();
    await createDreamaticExtension({workspaceDir,parentInvocation:{id:'designer',agent:'designer',runId:'demo'}})({
      on(name, handler) { handlers.set(name, handler); }, registerTool() {}, setActiveTools() {},
    });
    await handlers.get('before_provider_request')({payload:{max_completion_tokens:16384}});
    const assistant = {...message(16384),model:'mock',provider:'mock'};
    await handlers.get('message_end')({message:assistant});
    const failed = {role:'toolResult',toolName:'write',toolCallId:'write-1',isError:true,content:[{type:'text',text:raw}]};
    const replacement = await handlers.get('message_end')({message:failed});
    assert.equal(replacement.message.isError, true);
    assert.equal(replacement.message.details.code, 'source_write_output_limit_suspected');
    assert.ok(replacement.message.content[0].text.length < 1600);
    assert.equal(assistant.content[0].arguments.content, body);
    assert.equal(await handlers.get('message_end')({message:{...failed,isError:false}}), undefined);
  } finally { await rm(workspaceDir,{recursive:true,force:true}); }
});

test('real Pi validation bypasses tool hooks but message_end replacement reaches history and next request', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dreamatic-pi-source-recovery-'));
  let session;
  try {
    let toolHooks = 0, calls = 0;
    const recovery = new SourceWriteRecovery();
    const settingsManager = SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
    const resourceLoader = new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
      extensionFactories:[pi => {
        pi.on('tool_call', () => { toolHooks++; });
        pi.on('tool_result', () => { toolHooks++; });
        pi.on('message_end', event => {
          const m = event.message;
          if (m.role === 'assistant') recovery.observe(m, 16384);
          if (m.role === 'toolResult' && m.isError) {
            const detail = recovery.summarize(m.toolCallId, m.content[0].text);
            if (detail) return {message:{...m,content:[{type:'text',text:JSON.stringify(detail)}],details:detail}};
          }
        });
      }],
    });
    await resourceLoader.reload();
    const model = {id:'mock',name:'mock',provider:'mock',api:'openai-completions',baseUrl:'https://unused.invalid',reasoning:false,input:['text'],contextWindow:131072,maxTokens:16384,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
    ({session} = await createAgentSession({cwd,agentDir:cwd,model,resourceLoader,settingsManager,sessionManager:SessionManager.inMemory(cwd),tools:['write']}));
    await session.bindExtensions({});
    session.agent.getApiKey = async () => 'test-only';
    session.agent.streamFunction = (_model, context) => {
      calls++;
      if (calls === 2) {
        assert.ok(context.messages.at(-1).content[0].text.length < 1600);
        assert.doesNotMatch(context.messages.at(-1).content[0].text, /private-source/);
        assert.equal(context.messages.find(m => m.role === 'assistant').content[0].arguments.content, body);
      }
      assert.ok(calls <= 2);
      const m = {...message(16384),api:'openai-completions',provider:'mock',model:'mock',timestamp:Date.now(),
        usage:{input:0,output:16384,cacheRead:0,cacheWrite:0,totalTokens:16384,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
        ...(calls === 2 ? {stopReason:'stop',content:[{type:'text',text:'done'}]} : {})};
      return {async *[Symbol.asyncIterator]() { yield {type:'done',reason:m.stopReason,message:m}; },result:async () => m};
    };
    await session.agent.prompt('check validation');
    assert.equal(toolHooks, 0);
    assert.equal(calls, 2);
    const persisted = session.sessionManager.buildSessionContext().messages.find(m => m.role === 'toolResult');
    assert.equal(JSON.parse(persisted.content[0].text).code, 'source_write_output_limit_suspected');
  } finally { session?.dispose(); await rm(cwd,{recursive:true,force:true}); }
});
