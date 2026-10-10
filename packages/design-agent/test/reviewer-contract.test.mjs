import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createReadTool} from '@earendil-works/pi-coding-agent';
import {createDreamaticExtension,DREAMATIC_PERSONA_TOOL_POLICY,dreamaticPersonaTools} from '../dist/extension.js';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const obsolete=/\blegacy\b|split-file|write_json|patch_json|save_design_context|patch_design_context|review\/design-review\.(json|md)/iu;
function harness(workspace,reviewer=false){const tools=new Map(),handlers=new Map(),active=[];createDreamaticExtension({workspaceDir:workspace,...(reviewer?{personaPath:join(repo,'.pi/agents/reviewer.md'),parentInvocation:{id:'reviewer-test',agent:'reviewer',runId:'demo'}}:{})})({registerTool:t=>tools.set(t.name,t),on:(name,fn)=>handlers.set(name,fn),setActiveTools:names=>active.push(names)});return{tools,handlers,active,async call(name,args={}){const t=tools.get(name);assert.ok(t,name);const r=await t.execute(name,t.prepareArguments?t.prepareArguments(args):args,undefined,undefined,{cwd:repo,model:{id:'mock'}});return JSON.parse(r.content[0].text);}};}
test('Reviewer exposes only Context assessment, read and event tools; restores permissions and rejects writes',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-reviewer-contract-'));
 try{const md=await readFile(join(repo,'.pi/agents/reviewer.md'),'utf8');assert.doesNotMatch(md,obsolete);
 const declared=md.split('allowed_tools:')[1].split('---')[0].match(/- (\w+)/g).map(s=>s.slice(2));assert.deepEqual(dreamaticPersonaTools('reviewer',declared),DREAMATIC_PERSONA_TOOL_POLICY.reviewer);
 const r=harness(workspace,true);assert.deepEqual([...r.tools.keys()].sort(),DREAMATIC_PERSONA_TOOL_POLICY.reviewer.filter(n=>n!=='read').sort());
 assert.doesNotMatch(JSON.stringify([...r.tools.values()].map(t=>({name:t.name,description:t.description,parameters:t.parameters}))),obsolete);
 for(const name of ['write','edit','write_json','patch_json','ls','save_design_context','patch_design_context','use_skill','spawn_agent']){assert.equal(r.tools.has(name),false);assert.equal((await r.handlers.get('tool_call')({toolName:name,input:{}},{cwd:repo})).block,true);}
 const prompt=await r.handlers.get('before_agent_start')({prompt:'Review current specification',systemPrompt:''});assert.deepEqual(r.active.at(-1),DREAMATIC_PERSONA_TOOL_POLICY.reviewer);assert.doesNotMatch(prompt.systemPrompt,obsolete);
 }finally{await rm(workspace,{recursive:true,force:true});}
});
test('Reviewer reads exact sources and commits nested assessment without changing the design source',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-reviewer-assessment-'));
 try{await harness(workspace).call('run_init',{runIdOverride:'demo',projectTitle:'Test',brief:'A page review',designScopes:[{id:'ui',category:'ux',task:'A page'}]});const r=harness(workspace,true);
 const path=join(workspace,'runs/demo/plan/html/ui/index.html'),source='<!doctype html><title>Requested page</title><main>Ready</main>';await mkdir(join(path,'..'),{recursive:true});await writeFile(path,source);
 assert.equal(await r.handlers.get('tool_call')({toolName:'read',input:{path}},{cwd:repo}),undefined);
 const read=await createReadTool(repo).execute('read-source',{path});assert.ok(read.content.some(c=>c.type==='text'&&c.text.includes('Requested page')));
 await r.call('design_context_read',{audience:'reviewer'});
 const saved=await r.call('update_design_context',{changes:{assessment:{review_stage:'design_context',verdict:'fail',round:1,summary:'Missing accessible requested output',scores:{},issues:[{id:'missing-access',severity:'major',status:'open',owner:'designer',impact:'User cannot access the requested output'}],resolved_issue_ids:[],remaining_risks:[]}}});assert.equal(saved.saved,true);assert.equal((await r.call('commit_design_context')).committed,true);
 const review=JSON.parse(await readFile(join(workspace,'runs/demo/context/review.json'),'utf8'));assert.equal(review.assessment.verdict,'fail');assert.equal(await readFile(path,'utf8'),source);
 for(const p of ['review/design-review.json','review/design-review.md'])await assert.rejects(readFile(join(workspace,'runs/demo',p)),/ENOENT/);
 }finally{await rm(workspace,{recursive:true,force:true});}
});
test('Reviewer dispatch preserves a split-file Run and requires explicit migration',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-reviewer-migration-'));
 try{const path=join(workspace,'runs/demo/brief.json'),brief='{"runId":"demo"}';await mkdir(join(path,'..'),{recursive:true});await writeFile(path,brief);
 const result=await harness(workspace).call('spawn_agent',{runId:'demo',agent:'reviewer',task:'Review the current specification'});assert.equal(result.code,'context_migration_required');assert.equal(await readFile(path,'utf8'),brief);
 }finally{await rm(workspace,{recursive:true,force:true});}
});
