import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {completionUsage,writeCompletionSummary} from '../dist/completion-summary.js';

test('usage counts all responses once, including retries, without double-counting reasoning/cache tokens',()=>{
 const events=[{type:'provider_request',requestId:'a'},{type:'provider_response_complete',requestId:'a',usage:{totalTokens:100,input:80,output:20,reasoning:10,cacheRead:30}}, {type:'provider_response_complete',requestId:'a',usage:{totalTokens:100,input:80,output:20}}, {type:'provider_response_complete',requestId:'retry',stopReason:'error',usage:{totalTokens:25,input:20,output:5}}, {type:'provider_request',requestId:'missing'}];
 assert.deepEqual(completionUsage(events),{totalTokens:125,inputTokens:100,outputTokens:25,reportedRequests:2,observedRequests:3,complete:false});
 assert.equal(completionUsage([]).totalTokens,null);
 assert.equal(completionUsage([{type:"provider_response_complete",requestId:"default-zero",usage:{totalTokens:0,input:0,output:0}}]).totalTokens,null);
 assert.equal(completionUsage([{type:'provider_response_complete',requestId:'empty',usage:{input:4}}]).complete,false);
});

test('summary persists only delivered works and recorded directions; revisions isolate usage and duplicate export is idempotent',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dreamatic-completion-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const name of ['plan','review','artifacts','.performance','final'])await mkdir(join(dir,name));
 const save=(path,data)=>writeFile(join(dir,path),JSON.stringify(data));
 await save('brief.json',{title:'测试项目',brief:'设计展示',createdAt:'2026-01-01T00:00:00Z'});
 await save('plan/design_plan.json',{implementation_readiness:{future_tests:['验证结构','测试交互']}});
 await save('plan/deliverable_manifest.json',{presentation:{mode:'html',entry:'artifacts/page/index.html'},deliverables:[{id:'page',kind:'html_page',file:'artifacts/page/index.html',purpose:'完整展示',required:true},{id:'extra',kind:'image',file:'artifacts/extra.png',required:false}]});
 await save('review/design-review.json',{remaining_risks:[{recommendation:'验证结构'}]});
 await save('artifacts/artifact-manifest.json',{artifacts:[{deliverableId:'page',path:'artifacts/page/index.html',bytes:200},{path:'artifacts/style.css',bytes:20}]});
 await save('final/package-manifest.json',{files:['artifacts/page/index.html']});
 await writeFile(join(dir,'bus.jsonl'),JSON.stringify({type:'design_categories_identified',at:'2026-01-01T01:00:00Z'})+'\n');
 await writeFile(join(dir,'.performance/model-requests.jsonl'),JSON.stringify({type:'provider_response_complete',requestId:'a',at:'2026-01-01T01:02:00Z',usage:{totalTokens:100}})+'\n');
 const first=await writeCompletionSummary(dir,'demo',join(dir,'final'),'2026-01-01T01:10:00Z');
 assert.equal(first.summary.elapsedMs,600000);assert.equal(first.summary.delivered.length,1);assert.equal(first.summary.missingOptional.length,1);assert.deepEqual(first.summary.directions,['验证结构','测试交互']);assert.match(first.summary.text,/图片 Token 未计入/);assert.match(first.summary.text,/1 项可选/);
 assert.equal(JSON.parse(await readFile(join(dir,'final/completion-summary.json'))).usage.totalTokens,100);
 assert.ok(JSON.parse(await readFile(join(dir,'final/package-manifest.json'))).files.includes('completion-summary.json'));
 await appendFile(join(dir,'bus.jsonl'),JSON.stringify(first.event)+'\n');
 assert.equal((await writeCompletionSummary(dir,'demo',join(dir,'final'),'2026-01-01T02:00:00Z')).fresh,false);
 await appendFile(join(dir,'bus.jsonl'),JSON.stringify({type:'run_revision_started',id:'revision-1',at:'2026-01-01T02:00:00Z'})+'\n');
 await appendFile(join(dir,'.performance/model-requests.jsonl'),JSON.stringify({type:'provider_response_complete',requestId:'b',at:'2026-01-01T02:02:00Z',usage:{totalTokens:20}})+'\n');
 const revised=await writeCompletionSummary(dir,'demo',join(dir,'final'),'2026-01-01T02:05:00Z');
 assert.equal(revised.summary.usage.totalTokens,20);assert.equal(revised.summary.cumulativeUsage.totalTokens,120);assert.equal(revised.summary.cumulativeElapsedMs,900000);assert.notEqual(first.event.id,revised.event.id);
});
