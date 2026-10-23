import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {publishCompletionSummary,imageUsageTokens} from '../dist/completion-summary.js';
import {workflowInventory} from '../dist/workflow-store.js';
const date=s=>new Date(Date.UTC(2026,0,1)+s*1000).toISOString();
test('completion counts retries, excludes user/interrupt pauses, counts reported image usage, and deduplicates resume',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dreamatic-completion-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const runRoot=join(root,'runs/p');await mkdir(join(runRoot,'final'),{recursive:true});await writeFile(join(runRoot,'final/00-index.html'),'<html></html>');
 const rows=[];const add=(s,type,extra={})=>rows.push({at:date(s),type,...extra});
 const start=(s,agent,id)=>add(s,'agent_started',{agent,invocationId:id});const finish=(s,agent,id,type='agent_finished')=>add(s,type,{agent,invocationId:id});
 add(0,'run_status',{status:'active'});start(0,'orchestrator','o1');finish(10,'orchestrator','o1','agent_waiting');add(10,'run_status',{status:'waiting_for_user'});
 add(30,'run_status',{status:'active'});start(30,'orchestrator','o2');finish(40,'orchestrator','o2');start(40,'researcher','r');finish(55,'researcher','r');start(55,'designer','d1');finish(65,'designer','d1','agent_interrupted');add(65,'run_status',{status:'interrupted'});
 add(85,'run_status',{status:'active'});start(85,'designer','d2');finish(100,'designer','d2');start(100,'builder','b');
 add(110,'agent_progress',{imageItems:{a:{state:'generating',startedAt:date(100)}}});
 add(120,'agent_progress',{imageUsage:{imageId:'a',startedAt:date(100),tokens:60}});
 add(125,'agent_progress',{imageItems:{b:{state:'generating',startedAt:date(120)}}});finish(140,'builder','b');
 const busPath=join(runRoot,'bus.jsonl');await writeFile(busPath,rows.map(JSON.stringify).join('\n')+'\n');
 for(const [stage,messages] of Object.entries({orchestrator:[[5,35],[35,15]],researcher:[[50,50]],designer:[[60,100],[95,200]],builder:[[135,80]]})){
  await mkdir(join(runRoot,'sessions',stage),{recursive:true});await writeFile(join(runRoot,'sessions',stage,'one.jsonl'),messages.map(([s,total])=>JSON.stringify({timestamp:date(s),message:{role:'assistant',stopReason:'stop',usage:{input:1,output:1,cacheRead:1,cacheWrite:0,reasoning:99,totalTokens:total}}})).join('\n')+'\n');
 }
 const emit=async e=>{await appendFile(busPath,JSON.stringify(e)+'\n')};
 const options={root:runRoot,runId:'p',completionKey:'first',completedAt:date(140),deliverables:[{kind:'page',path:'final/00-index.html',label:'Showcase page'}],save:(path,data)=>writeFile(path,JSON.stringify(data)),emit};
 const summary=await publishCompletionSummary(options);
 assert.equal(summary.elapsedMs,140000);assert.equal(summary.executionMs,100000);assert.equal(summary.pausedMs,40000);
 assert.deepEqual(summary.stages.map(stage=>stage.durationMs),[20000,15000,25000,40000]);
 assert.deepEqual(summary.stages.map(stage=>stage.tokens),[50,50,300,140]);assert.equal(summary.tokens,540);assert.equal(summary.unreportedImageCalls,1);assert.equal(summary.unreportedCalls,1);assert.equal(summary.timingIncomplete,false);
 assert.deepEqual(summary.stages.map(stage=>stage.attempts),[2,1,2,1]);
 assert.deepEqual(await publishCompletionSummary({...options,completedAt:date(150)}),summary);
 assert.equal((await readFile(busPath,'utf8')).split('\n').filter(line=>line.includes('"project_completed"')).length,1);
 const restored=(await workflowInventory(root,'p')).filter(e=>e.stage==='completion');assert.equal(restored.length,1);assert.deepEqual(restored[0].completion,summary);
 // New revision excludes prior usage, including images now reused from disk.
 await appendFile(busPath,[{at:date(200),type:'run_status',status:'active'},{at:date(200),type:'agent_started',agent:'builder',invocationId:'b2'},{at:date(220),type:'agent_finished',agent:'builder',invocationId:'b2'}].map(JSON.stringify).join('\n')+'\n');
 await appendFile(join(runRoot,'sessions/builder/one.jsonl'),JSON.stringify({timestamp:date(210),message:{role:'assistant',stopReason:'stop',usage:{totalTokens:12}}})+'\n');
 const revised=await publishCompletionSummary({...options,completionKey:'second',completedAt:date(220)});assert.equal(revised.tokens,12);assert.equal(revised.unreportedImageCalls,0);assert.equal(revised.executionMs,20000);assert.equal(revised.elapsedMs,20000);
});
test('image usage never invents token counts or double-counts reasoning details',()=>{
 assert.equal(imageUsageTokens(undefined),undefined);assert.equal(imageUsageTokens({}),undefined);
 assert.equal(imageUsageTokens({total_tokens:100,input_tokens:30,output_tokens:70,output_tokens_details:{reasoning_tokens:10}}),100);
 assert.equal(imageUsageTokens({input_tokens:30,output_tokens:70}),100);assert.equal(imageUsageTokens({total_tokens:0}),0);
 assert.equal(imageUsageTokens({total_tokens:-1}),undefined);
});
