import assert from 'node:assert/strict';
import test from 'node:test';
import {responseTimeoutReason as reason, modelRecoveryTask, providerRequestSummary, modelResponseEvidence, reasoningRecoveryPlan} from '../dist/model-response-policy.js';
import {modelCapabilities, modelCapabilitySource} from '../dist/provider.js';
import {dreamaticSessionFailure} from '../dist/session-status.js';
import {withRetry} from '../dist/retry.js';
const limits={firstOutputMs:180000,idleMs:120000,generationMs:300000,totalMs:480000};
test('late first output receives generation allowance while stalls and total deadlines remain bounded',()=>{
 assert.equal(reason(179000,179000,undefined,limits),undefined);
 assert.equal(reason(180000,180000,undefined,limits),'first output deadline');
 assert.equal(reason(240000,20,115000,limits),undefined);
 assert.equal(reason(300000,120000,175000,limits),'stream stalled');
 assert.equal(reason(425000,20,300000,limits),'generation deadline');
 assert.equal(reason(480000,20,290000,limits),'model total deadline');
});
test('recovery distinguishes late start, long generation and connection errors without replaying partial calls',()=>{
 assert.match(modelRecoveryTask('first output deadline'),/did not produce/);
 assert.match(modelRecoveryTask('generation deadline'),/Never split required Context roots/);
 assert.match(modelRecoveryTask('stream stalled'),/connection failed/);
 for (const failure of ['model output token limit reached', 'generation deadline', 'model total deadline']) {
  const recovery = modelRecoveryTask(failure, 'designer');
  assert.match(recovery, /one file per response with path before content/);
  assert.match(recovery, /same deliverable execution.files/);
  assert.match(recovery, /Continue from successful writes/);
  assert.match(recovery, /Never split required Context roots/);
  assert.doesNotMatch(modelRecoveryTask(failure, 'builder'), /small HTML entry/);
 }
 assert.doesNotMatch(modelRecoveryTask('first output deadline', 'designer'), /split.*source/);
});
test('request telemetry exposes sizes and controls without content, headers or arbitrary fields',()=>{
 const result=providerRequestSummary({model:'mock',messages:[{content:'secret source text'}],apiKey:'secret-key',headers:{Authorization:'secret-auth'},enable_thinking:false,tools:[{}]});
 assert.equal(result.controls.enable_thinking,false);
 assert.equal(result.messageCount,1);
 assert.equal(result.toolCount,1);
 assert.doesNotMatch(JSON.stringify(result),/secret/);
});
test('model capabilities require explicit exact-id configuration and preserve unknown endpoint defaults',()=>{
 assert.deepEqual(modelCapabilities('unknown','{}'),{reasoning:false});
 const config='{"qwen3.7-plus":{"reasoning":true,"thinkingFormat":"qwen"}}';
 assert.equal(modelCapabilities('qwen3.7-plus',config).compat.thinkingFormat,'qwen');
 assert.throws(()=>modelCapabilities('mock','{"mock":{"reasoning":false,"thinkingFormat":"qwen"}}'),/requires/);
});

test('real Pi request construction sends an explicit Qwen thinking-off control before HTTP', async()=>{
 const {createRequire}=await import('node:module');
 const {pathToFileURL}=await import('node:url');
 const require=createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
 const {streamSimple}=await import(new URL('../pi-ai/dist/api/openai-completions.js',pathToFileURL(require.resolve('@earendil-works/pi-agent-core/package.json'))).href);
 let captured;
 const model={id:'mock-qwen',name:'mock-qwen',provider:'dreamatic-profile',api:'openai-completions',baseUrl:'https://unused.invalid/v1',reasoning:true,compat:{thinkingFormat:'qwen',supportsReasoningEffort:false},input:['text'],contextWindow:131072,maxTokens:16384,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 const stream=streamSimple(model,{messages:[{role:'user',content:'check',timestamp:Date.now()}]},{apiKey:'test-only',onPayload:payload=>{captured=payload;throw new Error('test capture: do not send HTTP');}});
 await stream.result();
 assert.equal(captured.enable_thinking,false);
});

test('strict capability is explicit and creative Context schemas remain open under Pi prefer', async()=>{
 assert.equal(modelCapabilities('mock','{"mock":{"reasoning":false,"supportsStrictMode":true}}').compat.supportsStrictMode,true);
 assert.throws(()=>modelCapabilities('mock','{"mock":{"reasoning":false,"supportsStrictMode":"true"}}'),/Invalid/);
 const {createRequire}=await import('node:module');
 const {pathToFileURL}=await import('node:url');
 const require=createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
 const {streamSimple}=await import(new URL('../pi-ai/dist/api/openai-completions.js',pathToFileURL(require.resolve('@earendil-works/pi-agent-core/package.json'))).href);
 const {roleContextChangesSchema}=await import('../dist/context-tools.js');
 async function capture(supportsStrictMode,parameters){
  let captured;
  const model={id:'mock',name:'mock',provider:'dreamatic-profile',api:'openai-completions',baseUrl:'https://unused.invalid/v1',reasoning:false,compat:{supportsStrictMode},input:['text'],contextWindow:131072,maxTokens:16384,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const stream=streamSimple(model,{messages:[{role:'user',content:'check',timestamp:Date.now()}],tools:[{name:'context_test',description:'Context contract',parameters,constrainedSampling:{type:'json_schema',strict:'prefer'}}]},{apiKey:'test-only',onPayload:payload=>{captured=payload;throw new Error('test capture: do not send HTTP');}});
  await stream.result();
  return captured.tools[0].function;
 }
 const closed={type:'object',properties:{},additionalProperties:false};
 assert.equal((await capture(false,closed)).strict,undefined);
 assert.equal((await capture(true,closed)).strict,true);
 const open=await capture(true,roleContextChangesSchema('designer'));
 assert.equal(open.strict,false);
 assert.notEqual(open.parameters.properties.strategy.additionalProperties,false);
 const {prepareContextChanges}=await import('../dist/context-tools.js');
 assert.doesNotThrow(()=>prepareContextChanges({changes:{strategy:{creative_rationale:{detail:'Custom design content'}}}},'designer'));
});

test('telemetry distinguishes serialized strict flags without exposing tool schemas',()=>{
 const result=providerRequestSummary({tools:[{function:{name:'commit',strict:true,parameters:{secret:'private'}}},{function:{strict:false}},{type:'function',strict:true},{function:{name:'unspecified'}}]});
 assert.deepEqual(result.toolConstraints,{strict:2,nonStrict:1,unspecified:1});
 assert.doesNotMatch(JSON.stringify(result),/private|secret|commit/);
});

test('capabilities validate exact-id Pi maps, formats, budgets and limits without model-name guessing',()=>{
 assert.equal(modelCapabilitySource('absent','{"other":{"reasoning":true}}'),'unspecified');
 const source=JSON.stringify({custom:{reasoning:true,thinkingFormat:'openrouter',supportsReasoningEffort:true,thinkingLevelMap:{off:null,low:'low'},thinkingTokenBudgetField:'thinking_budget',maxTokensField:'max_tokens',maxTokens:8192,contextWindow:32768}});
 const capabilities=modelCapabilities('custom',source);
 assert.equal(modelCapabilitySource('custom',source),'explicit_configuration');
 assert.equal(capabilities.maxTokens,8192);
 assert.equal(capabilities.compat.maxTokensField,'max_tokens');
 assert.equal(capabilities.thinkingLevelMap.off,null);
 for(const config of [
  {reasoning:true,thinkingFormat:'invented'},
  {reasoning:true,thinkingLevelMap:{off:false}},
  {reasoning:true,thinkingLevelMap:{unknown:'low'}},
  {reasoning:true,maxTokens:0},
  {reasoning:true,maxTokens:8192,contextWindow:4096},
  {reasoning:true,thinkingTokenBudgetField:'invented'},
  {reasoning:true,thinkingFormat:'chat-template',chatTemplateKwargs:{enable_thinking:{$var:'secret'}}},
  {reasoning:true,thinkingFormat:'qwen',chatTemplateKwargs:{enable_thinking:true}},
 ]) assert.throws(()=>modelCapabilities('custom',JSON.stringify({custom:config})),/Invalid/);
});

test('real Pi payloads honor verified formats and preserve answer space without sending HTTP',async()=>{
 const {createRequire}=await import('node:module');const {pathToFileURL}=await import('node:url');
 const require=createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
 const {streamSimple}=await import(new URL('../pi-ai/dist/api/openai-completions.js',pathToFileURL(require.resolve('@earendil-works/pi-agent-core/package.json'))).href);
 for(const [config,level,expected] of [
  [{reasoning:true,thinkingFormat:'openai',thinkingLevelMap:{off:'none'}},'off',{reasoning_effort:'none'}],
  [{reasoning:true,thinkingFormat:'zai'},'off',{thinking:{type:'disabled'}}],
  [{reasoning:true,thinkingFormat:'deepseek'},'off',{thinking:{type:'disabled'}}],
  [{reasoning:true,thinkingFormat:'openrouter'},'off',{reasoning:{effort:'none'}}],
  [{reasoning:true,thinkingFormat:'together'},'off',{reasoning:{enabled:false}}],
  [{reasoning:true,thinkingFormat:'qwen-chat-template'},'off',{chat_template_kwargs:{enable_thinking:false,preserve_thinking:true}}],
  [{reasoning:true,thinkingFormat:'chat-template',chatTemplateKwargs:{mode_flag:{$var:'thinking.enabled'}}},'off',{chat_template_kwargs:{mode_flag:false}}],
  [{reasoning:true,thinkingFormat:'qwen',thinkingTokenBudgetField:'thinking_budget',maxTokensField:'max_tokens'},'low',{enable_thinking:true,thinking_budget:2048,max_tokens:4096}],
  [{reasoning:true,thinkingFormat:'openai',thinkingLevelMap:{off:null,low:'low'}},'low',{reasoning_effort:'low'}],
  [{reasoning:false},'off',{}],
 ]) {
  const capability=modelCapabilities('mock',JSON.stringify({mock:config}));
  const model={id:'mock',name:'Mock',provider:'dreamatic-profile',api:'openai-completions',baseUrl:'https://unused.invalid/v1',input:['text'],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},...capability};
  let payload;
  await streamSimple(model,{messages:[{role:'user',content:'check',timestamp:Date.now()}]},{reasoning:level,apiKey:'test-only',onPayload:p=>{payload=p;throw new Error('captured; no HTTP');}}).result();
  for(const [key,value] of Object.entries(expected)) assert.deepEqual(payload[key],value,JSON.stringify(config));
  if(!config.reasoning) assert.equal(providerRequestSummary(payload).thinkingControl,'unspecified');
  if(config.thinkingFormat==='chat-template') assert.equal(providerRequestSummary(payload,capability.compat).controlState,'off_requested');
 }
});

test('response classification distinguishes reasoning exhaustion, partial output and unknown usage',()=>{
 const pure={role:'assistant',stopReason:'length',content:[{type:'thinking',thinking:'simulated reasoning'}],usage:{output:16384,reasoning:16384}};
 assert.equal(modelResponseEvidence(pure).truncationKind,'reasoning_exhausted');
 assert.equal(modelResponseEvidence({...pure,content:[]}).truncationKind,'reasoning_exhausted');
 assert.equal(modelResponseEvidence({...pure,usage:{}}).truncationKind,'reasoning_exhausted');
 for(const content of [[{type:'text',text:'partial output'}],[{type:'toolCall',name:'write',arguments:{content:'partial'}}]]) assert.equal(modelResponseEvidence({...pure,content}).truncationKind,'output_truncated');
 assert.equal(modelResponseEvidence({stopReason:'length'}).truncationKind,'output_truncated');
 assert.equal(modelResponseEvidence({stopReason:'stop'}).reasoningTokens,null);
 assert.match(dreamaticSessionFailure([pure]),/reasoning exhausted/);
 assert.doesNotMatch(modelRecoveryTask(dreamaticSessionFailure([pure]),'designer'),/small HTML entry/);
 assert.doesNotMatch(JSON.stringify(modelResponseEvidence(pure)),/simulated/);
});

test('reasoning recovery changes only verified controls once and never claims unknown off support',async()=>{
 const model={reasoning:true,api:'openai-completions',compat:{thinkingFormat:'qwen',supportsReasoningEffort:false}};
 const levels=['off','minimal','low','medium','high'];
 assert.equal(reasoningRecoveryPlan(model,'high',levels,0).nextLevel,'off');
 assert.equal(reasoningRecoveryPlan(model,'off',levels,0).retry,false);
 assert.equal(reasoningRecoveryPlan(model,'high',levels,1).retry,false);
 assert.equal(reasoningRecoveryPlan({...model,reasoning:false},'high',levels,0).retry,false);
 assert.equal(reasoningRecoveryPlan({...model,compat:{}},'high',levels,0).retry,false);
 assert.equal(reasoningRecoveryPlan({...model,thinkingLevelMap:{off:null}},'high',levels,0).retry,false);
 const effortOnly={...model,compat:{thinkingFormat:'openai',supportsReasoningEffort:true},thinkingLevelMap:{off:null,minimal:null,low:'low',high:'high'}};
 assert.equal(reasoningRecoveryPlan(effortOnly,'high',levels,0).nextLevel,'low');
 assert.equal(reasoningRecoveryPlan({...effortOnly,thinkingLevelMap:{off:null,minimal:null,low:'same',medium:'same',high:'same'}},'high',levels,0).retry,false);
 assert.equal(reasoningRecoveryPlan({...effortOnly,thinkingLevelMap:undefined},'high',levels,0).nextLevel,'minimal', 'OpenAI off requires an explicit emitted mapping');
 assert.equal(reasoningRecoveryPlan({...model,compat:{thinkingFormat:'qwen-chat-template',supportsReasoningEffort:true},thinkingLevelMap:{off:null}},'high',levels,0).retry,false, 'binary template ignores effort controls');
 assert.equal(reasoningRecoveryPlan({...model,compat:{thinkingFormat:'ant-ling'},thinkingLevelMap:{off:'none'}},'high',levels,0).retry,false, 'ant-ling does not emit off or unmapped lower effort');
 let attempts=0,recoveries=0,current='high',plan;
 await assert.rejects(withRetry(async()=>{
  attempts++;plan=reasoningRecoveryPlan(model,current,levels,recoveries);
  if(plan.retry){current=plan.nextLevel;recoveries++;}
  throw new Error('model output token limit reached: reasoning exhausted');
 },{attempts:5,sleep:async()=>{},shouldRetry:()=>plan.retry}),/reasoning exhausted/);
 assert.equal(attempts,2);
});

test('request controls distinguish off requests, unknown and conflicting settings without dumping templates',()=>{
 assert.equal(providerRequestSummary({enable_thinking:false}).controlState,'off_requested');
 assert.equal(providerRequestSummary({reasoning:{enabled:false}}).controlState,'off_requested');
 assert.equal(providerRequestSummary({reasoning:{effort:'none'}}).controlState,'off_requested');
 assert.equal(providerRequestSummary({thinking:{type:'adaptive',budget_tokens:2048}}).controlState,'on_requested');
 assert.equal(providerRequestSummary({enable_thinking:false,reasoning:{enabled:true}}).controlState,'conflicting');
 assert.equal(providerRequestSummary({max_completion_tokens:16384}).controlState,'unspecified');
 const summary=providerRequestSummary({chat_template_kwargs:{enable_thinking:false,private_key:'secret'},thinking_budget:2048});
 assert.equal(summary.controls.thinking_budget,2048);
 assert.doesNotMatch(JSON.stringify(summary),/secret|private_key/);
});
