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
 const config=await readRuntimeConfig(root,env);assert.equal(config.values.DREAMATIC_MODEL,'disk-model');assert.equal(env.DREAMATIC_MODEL,'disk-model');assert.equal(config.secretConfigured.DREAMATIC_API_KEY,true);assert.doesNotMatch(JSON.stringify(config),/private-(text|search|image)-key/);assert.equal(config.modules.length,4);assert.ok(config.fields.every(field=>field.example&&field.label&&config.modules.some(module=>module.id===field.module)));
 const documented=parseEnv(await readFile(new URL('../../../.env.example',import.meta.url),'utf8'));for(const key of Object.keys(documented))assert.ok(CONFIG_FIELDS.some(field=>field.key===key),key);
 await writeFile(join(root,'.env'),'DREAMATIC_MODEL=manual-edit\nDREAMATIC_API_KEY=\n');assert.equal((await readRuntimeConfig(root,env)).values.DREAMATIC_MODEL,'manual-edit');assert.equal((await readRuntimeConfig(root,env)).secretConfigured.DREAMATIC_API_KEY,false);
});
test('save preserves unrelated .env settings/comments, blank secrets and optional URLs, and round-trips quoted values',async(t)=>{
 const root=await fixture(t,'# Keep this comment\nUNRELATED_OPTION=keep\nDREAMATIC_API_KEY=original-key\nexport DREAMATIC_MODEL = first\nDREAMATIC_MODEL=duplicate\n');const env={};
 const saved=await saveRuntimeConfig(root,{values:{DREAMATIC_MODEL:'new-model',DREAMATIC_PROVIDER_NAME:'Design # lab',DREAMATIC_IMAGE_EDIT_ENDPOINT:'',DREAMATIC_IMAGE_GENERATION_ENDPOINT:'',DREAMATIC_SEARCH_PROVIDER:'serper',PORT:'4311'},secrets:{DREAMATIC_API_KEY:'',DREAMATIC_SEARCH_API_KEY:'search#key'}},env);
 const text=await readFile(join(root,'.env'),'utf8'),disk=parseEnv(text);assert.match(text,/# Keep this comment/);assert.equal(disk.UNRELATED_OPTION,'keep');assert.equal(disk.DREAMATIC_API_KEY,'original-key');assert.equal(disk.DREAMATIC_SEARCH_API_KEY,'search#key');assert.equal(disk.DREAMATIC_PROVIDER_NAME,'Design # lab');assert.equal(disk.DREAMATIC_MODEL,'new-model');assert.equal(text.match(/^DREAMATIC_MODEL=/gm).length,1);assert.equal(disk.DREAMATIC_IMAGE_EDIT_ENDPOINT,'');assert.equal(env.DREAMATIC_MODEL,'new-model');assert.equal(saved.values.PORT,'4311');
});
test('invalid updates cannot partially modify disk/process or inject arbitrary environment variables',async(t)=>{
 const original='DREAMATIC_MODEL=approved-model\n';const root=await fixture(t,original),env={DREAMATIC_MODEL:'approved-model'};
 for(const input of [{values:{DREAMATIC_MODEL:'new-model',DREAMATIC_BASE_URL:'bad-url'}},{values:{PORT:'70000'}},{values:{DREAMATIC_IMAGE_CONCURRENCY:'0'}},{values:{DREAMATIC_MODEL:'injection\nOTHER=secret'}},{values:{HOME:'/tmp'}},{values:{DREAMATIC_API_KEY:'secret'}},{secrets:{DREAMATIC_MODEL:'secret'}}]){await assert.rejects(saveRuntimeConfig(root,input,env));assert.equal(await readFile(join(root,'.env'),'utf8'),original);assert.deepEqual(env,{DREAMATIC_MODEL:'approved-model'});}
});
test('concurrent saves are serialized and legacy API fields still work',async(t)=>{
 const root=await fixture(t),env={};await Promise.all([saveRuntimeConfig(root,{values:{DREAMATIC_MODEL:'model-a'}},env),saveRuntimeConfig(root,{values:{DREAMATIC_SEARCH_PROVIDER:'serper'}},env)]);const result=await readRuntimeConfig(root,env);assert.equal(result.values.DREAMATIC_MODEL,'model-a');assert.equal(result.values.DREAMATIC_SEARCH_PROVIDER,'serper');await saveRuntimeConfig(root,{imageGenerationEndpoint:'',model:'legacy-model'},env);assert.equal((await readRuntimeConfig(root,env)).model,'legacy-model');
});
