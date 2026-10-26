import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { CONFIG_FIELDS, readRuntimeConfig, saveRuntimeConfig } from '../dist/config-store.js';
async function fixture(t,text=''){const root=await mkdtemp(join(tmpdir(),'dreamatic-config-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'.env'),text);return root;}
test('configuration reads .env afresh, covers documented keys and never returns stored credentials',async(t)=>{
 const root=await fixture(t,'DREAMATIC_MODEL=disk-model\nDREAMATIC_API_KEY=private-text-key\nDREAMATIC_SEARCH_API_KEY=private-search-key\nDREAMATIC_IMAGE_API_KEY=private-image-key\n');const env={DREAMATIC_MODEL:'old-process-model'};
 const config=await readRuntimeConfig(root,env);assert.equal(config.values.DREAMATIC_MODEL,'disk-model');assert.equal(config.pendingApply,true);assert.equal(env.DREAMATIC_MODEL,'old-process-model');assert.equal(config.secretConfigured.DREAMATIC_API_KEY,true);assert.doesNotMatch(JSON.stringify(config),/private-(text|search|image)-key/);assert.equal(config.modules.length,4);assert.ok(config.fields.every(field=>field.example&&field.label&&config.modules.some(module=>module.id===field.module)));
 const documented=parseEnv(await readFile(new URL('../../../.env.example',import.meta.url),'utf8'));for(const key of Object.keys(documented))assert.ok(CONFIG_FIELDS.some(field=>field.key===key),key);
 await writeFile(join(root,'.env'),'DREAMATIC_MODEL=manual-edit\nDREAMATIC_API_KEY=\n');assert.equal((await readRuntimeConfig(root,env)).values.DREAMATIC_MODEL,'manual-edit');assert.equal((await readRuntimeConfig(root,env)).secretConfigured.DREAMATIC_API_KEY,false);
});
test('save preserves unrelated .env settings/comments, blank secrets and optional URLs, and round-trips quoted values',async(t)=>{
 const root=await fixture(t,'# Keep this comment\nUNRELATED_OPTION=keep\nDREAMATIC_API_KEY=original-key\nexport DREAMATIC_MODEL = first\nDREAMATIC_MODEL=duplicate\n');const env={};
 const saved=await saveRuntimeConfig(root,{values:{DREAMATIC_MODEL:'new-model',DREAMATIC_PROVIDER_NAME:'Design # lab',DREAMATIC_IMAGE_GENERATION_ENDPOINT:'',DREAMATIC_SEARCH_PROVIDER:'serper',PORT:'4311'},secrets:{DREAMATIC_API_KEY:'',DREAMATIC_SEARCH_API_KEY:'search#key'}},env);
 const text=await readFile(join(root,'.env'),'utf8'),disk=parseEnv(text);assert.match(text,/# Keep this comment/);assert.equal(disk.UNRELATED_OPTION,'keep');assert.equal(disk.DREAMATIC_API_KEY,'original-key');assert.equal(disk.DREAMATIC_SEARCH_API_KEY,'search#key');assert.equal(disk.DREAMATIC_PROVIDER_NAME,'Design # lab');assert.equal(disk.DREAMATIC_MODEL,'new-model');assert.equal(text.match(/^DREAMATIC_MODEL=/gm).length,1);assert.equal(env.DREAMATIC_MODEL,'new-model');assert.equal(saved.values.PORT,'4311');
});
test('invalid updates cannot partially modify disk/process or inject arbitrary environment variables',async(t)=>{
 const original='DREAMATIC_MODEL=approved-model\n';const root=await fixture(t,original),env={DREAMATIC_MODEL:'approved-model'};
 for(const input of [{values:{DREAMATIC_MODEL:'new-model',DREAMATIC_BASE_URL:'bad-url'}},{values:{PORT:'70000'}},{values:{DREAMATIC_IMAGE_CONCURRENCY:'0'}},{values:{DREAMATIC_MODEL:'injection\nOTHER=secret'}},{values:{HOME:'/tmp'}},{values:{DREAMATIC_API_KEY:'secret'}},{secrets:{DREAMATIC_MODEL:'secret'}}]){await assert.rejects(saveRuntimeConfig(root,input,env));assert.equal(await readFile(join(root,'.env'),'utf8'),original);assert.deepEqual(env,{DREAMATIC_MODEL:'approved-model'});}
});
test('concurrent saves are serialized and legacy API fields still work',async(t)=>{
 const root=await fixture(t),env={};await Promise.all([saveRuntimeConfig(root,{values:{DREAMATIC_MODEL:'model-a'}},env),saveRuntimeConfig(root,{values:{DREAMATIC_SEARCH_PROVIDER:'serper'}},env)]);const result=await readRuntimeConfig(root,env);assert.equal(result.values.DREAMATIC_MODEL,'model-a');assert.equal(result.values.DREAMATIC_SEARCH_PROVIDER,'serper');await saveRuntimeConfig(root,{imageGenerationEndpoint:'',model:'legacy-model'},env);assert.equal((await readRuntimeConfig(root,env)).model,'legacy-model');
});

test('response phase limits and explicit endpoint capabilities round-trip and reject invalid capability contracts',async t=>{
 const root=await fixture(t),env={};
 const capabilities='{"qwen3.7-plus":{"reasoning":true,"thinkingFormat":"qwen"}}';
 const saved=await saveRuntimeConfig(root,{values:{DREAMATIC_MODEL_CAPABILITIES:capabilities,DREAMATIC_MODEL_GENERATION_TIMEOUT_MS:'300000',DREAMATIC_MODEL_TOTAL_TIMEOUT_MS:''}},env);
 assert.equal(saved.values.DREAMATIC_MODEL_CAPABILITIES,capabilities);
 assert.equal(saved.values.DREAMATIC_MODEL_TOTAL_TIMEOUT_MS,'');
 const original=await readFile(join(root,'.env'),'utf8');
 await assert.rejects(saveRuntimeConfig(root,{values:{DREAMATIC_MODEL_CAPABILITIES:'{"model":{"reasoning":false,"thinkingFormat":"qwen"}}'}},env),/requires/);
 assert.equal(await readFile(join(root,'.env'),'utf8'),original);
});


test('reading external changes is pure and explicit apply activates the persisted snapshot',async t=>{
 const root=await fixture(t,'DREAMATIC_MODEL=running-model\nDREAMATIC_IMAGE_MODEL=running-image\n');
 const env={DREAMATIC_MODEL:'running-model',DREAMATIC_IMAGE_MODEL:'running-image'};
 assert.equal((await readRuntimeConfig(root,env)).pendingApply,false);
 await writeFile(join(root,'.env'),'DREAMATIC_MODEL=external-model\nDREAMATIC_IMAGE_MODEL=external-image\n');
 const before={...env};const disk=await readRuntimeConfig(root,env);
 assert.equal(disk.pendingApply,true);assert.deepEqual(env,before);
 const applied=await saveRuntimeConfig(root,{values:{DREAMATIC_SEARCH_PROVIDER:'serper'}},env);
 assert.equal(env.DREAMATIC_MODEL,'external-model');assert.equal(env.DREAMATIC_IMAGE_MODEL,'external-image');assert.equal(applied.pendingApply,false);
});

test('generic endpoint capabilities round-trip and invalid maps leave configuration unchanged',async t=>{
 const root=await fixture(t),env={};
 const capabilities=JSON.stringify({custom:{reasoning:true,thinkingFormat:'openrouter',supportsReasoningEffort:true,thinkingLevelMap:{off:null,low:'low'},thinkingTokenBudgetField:'thinking_budget',maxTokensField:'max_tokens',maxTokens:8192,contextWindow:32768}});
 assert.equal((await saveRuntimeConfig(root,{values:{DREAMATIC_MODEL_CAPABILITIES:capabilities}},env)).values.DREAMATIC_MODEL_CAPABILITIES,capabilities);
 const before=await readFile(join(root,'.env'),'utf8');
 await assert.rejects(saveRuntimeConfig(root,{values:{DREAMATIC_MODEL_CAPABILITIES:'{"custom":{"reasoning":true,"thinkingLevelMap":{"off":false}}}'}},env),/Invalid/);
 assert.equal(await readFile(join(root,'.env'),'utf8'),before);
 assert.equal(env.DREAMATIC_MODEL_CAPABILITIES,capabilities);
});


test('explicit apply validates externally edited fields before mutating disk or runtime',async t=>{
 const text='DREAMATIC_MODEL=external-model\nPORT=invalid\n';const root=await fixture(t,text),env={DREAMATIC_MODEL:'running-model',PORT:'4310'};
 await assert.rejects(saveRuntimeConfig(root,{values:{DREAMATIC_SEARCH_PROVIDER:'serper'}},env),/integer/);
 assert.equal(await readFile(join(root,'.env'),'utf8'),text);assert.deepEqual(env,{DREAMATIC_MODEL:'running-model',PORT:'4310'});
});


test('a valid ephemeral startup port remains applicable when saving another setting',async t=>{
 const root=await fixture(t,'PORT=0\nDREAMATIC_MODEL=running-model\n'),env={PORT:'0',DREAMATIC_MODEL:'running-model'};
 await saveRuntimeConfig(root,{values:{DREAMATIC_MODEL:'updated-model'}},env);
 assert.equal(env.PORT,'0');assert.equal(env.DREAMATIC_MODEL,'updated-model');
});

test('retired settings are hidden and rejected without deleting legacy disk values', async t => {
 const retired=['DREAMATIC_ACTIVE_PROFILE','DREAMATIC_MODEL_REVIEWER','DREAMATIC_THINKING_LEVEL_REVIEWER','DREAMATIC_TOOL_PATH','DREAMATIC_AGENT_RETRY_ATTEMPTS','DREAMATIC_OPERATION_ATTEMPT_BUDGET','DREAMATIC_IMAGE_EDIT_RETRY_ATTEMPTS','DREAMATIC_IMAGE_EDIT_TIMEOUT_MS','DREAMATIC_VISUAL_PREVIEW_MAX_EDGE','DREAMATIC_VISUAL_PREVIEW_MAX_BYTES','DREAMATIC_RESEARCH_CACHE_TTL_MS','DREAMATIC_STOP_AFTER_COMMIT','DREAMATIC_HTML_REQUIRE_BROWSER','DREAMATIC_HTML_BROWSER','DREAMATIC_HTML_BROWSER_EXECUTABLE'];
 const legacy=retired.map(key=>`${key}=legacy-value`).join('\n')+'\n';
 const root=await fixture(t,legacy),env={};
 const config=await readRuntimeConfig(root,env);
 for(const key of retired){assert.ok(!CONFIG_FIELDS.some(f=>f.key===key),key);assert.ok(!(key in config.values),key);await assert.rejects(saveRuntimeConfig(root,{values:{[key]:'new-value'}},env),/Unsupported/);}
 const saved=await saveRuntimeConfig(root,{values:{DREAMATIC_MODEL:'updated'}},env);
 assert.ok((await readFile(join(root,'.env'),'utf8')).startsWith(legacy));
 assert.equal(saved.values.DREAMATIC_MODEL,'updated');
 for(const key of retired)assert.equal(env[key],undefined);
 assert.equal(config.fields.some(f=>f.key==='DREAMATIC_PREVENT_IDLE_SLEEP'),false);
 const desktop=await readRuntimeConfig(root,{DREAMATIC_DESKTOP:'1'});
 for(const key of ['activeProfile','imageEditEndpoint'])await assert.rejects(saveRuntimeConfig(root,{[key]:'retired'},env),/Unsupported/);
 assert.equal(desktop.fields.some(f=>f.key==='DREAMATIC_PREVENT_IDLE_SLEEP'),true);
 assert.equal(desktop.fields.find(f=>f.key==='DREAMATIC_PROVIDER_NAME').label,'Connection name');
});

test('Serper legacy key fallback is shared by diagnostics and execution without exposing credentials', async t => {
 const {searchApiKey}=await import('../dist/config-store.js');
 const root=await fixture(t,'SERPER_API_KEY=legacy-secret\n');
 const env={SERPER_API_KEY:'legacy-secret',DREAMATIC_SEARCH_API_KEY:'  '};
 assert.equal(searchApiKey(env),'legacy-secret');
 assert.equal(searchApiKey({...env,DREAMATIC_SEARCH_API_KEY:' current-secret '}),'current-secret');
 const config=await readRuntimeConfig(root,env);
 assert.equal(config.searchApiKeyConfigured,true);assert.doesNotMatch(JSON.stringify(config),/legacy-secret/);
});

test('new runtime controls persist and invalid limits cannot partially apply', async t => {
 const root=await fixture(t),env={};
 const values={DREAMATIC_MODEL_IDLE_TIMEOUT_MS:'2000',DREAMATIC_IMAGE_RESPONSE_MAX_BYTES:'1024',DREAMATIC_PREVENT_IDLE_SLEEP:'false'};
 const saved=await saveRuntimeConfig(root,{values},env);
 for(const [key,value] of Object.entries(values)){assert.equal(env[key],value);assert.equal(saved.values[key],value);}
 const original=await readFile(join(root,'.env'),'utf8');
 for(const invalid of [{DREAMATIC_MODEL_IDLE_TIMEOUT_MS:'0'},{DREAMATIC_IMAGE_RESPONSE_MAX_BYTES:'1023'},{DREAMATIC_PREVENT_IDLE_SLEEP:'yes'}]){
  await assert.rejects(saveRuntimeConfig(root,{values:invalid},env));assert.equal(await readFile(join(root,'.env'),'utf8'),original);assert.deepEqual(env,values);
 }
});

test('image edit settings persist and validate without exposing image credentials', async t => {
 const root=await fixture(t,''),env={DREAMATIC_IMAGE_API_KEY:'private-edit-fixture-key'};
 const saved=await saveRuntimeConfig(root,{values:{DREAMATIC_IMAGE_EDIT_ENABLED:'true',DREAMATIC_IMAGE_EDIT_MODEL:'editing-model',DREAMATIC_IMAGE_EDIT_ENDPOINT:'https://example.org/v1/images/edits',DREAMATIC_IMAGE_EDIT_SIZE:'auto',DREAMATIC_IMAGE_EDIT_RESPONSE_FORMAT:'auto'}},env);
 assert.equal(saved.values.DREAMATIC_IMAGE_EDIT_MODEL,'editing-model');assert.equal(env.DREAMATIC_IMAGE_EDIT_SIZE,'auto');
 assert.ok(!JSON.stringify(saved).includes('private-edit-fixture-key'));
 await assert.rejects(saveRuntimeConfig(root,{values:{DREAMATIC_IMAGE_EDIT_SIZE:'wrong'}},env));
 await assert.rejects(saveRuntimeConfig(root,{values:{DREAMATIC_IMAGE_EDIT_ENABLED:'maybe'}},env));
 await assert.rejects(saveRuntimeConfig(root,{values:{DREAMATIC_IMAGE_EDIT_ENDPOINT:'file:///tmp/edit'}},env));
});

test('approved Skill paths persist per role while malformed or relative paths cannot partially apply', async t => {
 const root = await fixture(t), env = {};
 const paths = JSON.stringify({designer:['/approved/campaign-method'],editor:['~/skills/image-method']});
 const saved = await saveRuntimeConfig(root,{values:{DREAMATIC_SKILL_PATHS:paths}},env);
 assert.equal(saved.values.DREAMATIC_SKILL_PATHS,paths);assert.equal(env.DREAMATIC_SKILL_PATHS,paths);
 const before = await readFile(join(root,'.env'),'utf8');
 for (const value of ['[]','{"unknown":[]}','{"designer":["relative/path"]}','{"editor":"/path"}']) {
  await assert.rejects(saveRuntimeConfig(root,{values:{DREAMATIC_SKILL_PATHS:value}},env));
  assert.equal(await readFile(join(root,'.env'),'utf8'),before);assert.equal(env.DREAMATIC_SKILL_PATHS,paths);
 }
});

test('edit-only size capabilities validate before modifying settings',async t=>{
 const root=await fixture(t,''),env={};
 const value='{"sizes":["1024x1024","1024x1536"],"step":16,"maxPixels":4194304,"maxEdge":2048}';
 const saved=await saveRuntimeConfig(root,{values:{DREAMATIC_IMAGE_EDIT_CAPABILITIES:value}},env);
 assert.equal(saved.values.DREAMATIC_IMAGE_EDIT_CAPABILITIES,value);
 const original=await readFile(join(root,'.env'),'utf8');
 for(const invalid of ['{"sizes":["auto"]}','{"step":0}','{"maxPixels":-1}']) await assert.rejects(saveRuntimeConfig(root,{values:{DREAMATIC_IMAGE_EDIT_CAPABILITIES:invalid}},env));
 assert.equal(await readFile(join(root,'.env'),'utf8'),original);
});
