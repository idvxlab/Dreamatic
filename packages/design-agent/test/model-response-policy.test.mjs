import assert from 'node:assert/strict';
import test from 'node:test';
import {responseTimeoutReason as reason, modelRecoveryTask, providerRequestSummary} from '../dist/model-response-policy.js';
import {modelCapabilities} from '../dist/provider.js';
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
