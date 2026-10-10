import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createDreamaticExtension,orchestratorHandoffIssue,DREAMATIC_PERSONA_TOOL_POLICY} from '../dist/extension.js';
import {createDreamaticSession} from '../dist/runtime.js';
import {ORCHESTRATOR_TOOLS} from '../dist/orchestrator-contract.js';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const forbidden=/\blegacy\b|split-file|research\/research-findings\.md|research\/evidence\.json|plan\/design_plan\.json|save_design_context|patch_design_context|write_json|patch_json|expectedSha256/iu;
function harness(workspace){const tools=new Map(),handlers=new Map(),active=[];createDreamaticExtension({workspaceDir:workspace,personaPath:join(repo,'.pi/agents/orchestrator.md')})({registerTool:t=>tools.set(t.name,t),registerProvider(){},on:(name,fn)=>handlers.set(name,fn),setActiveTools:names=>active.push(names)});return{tools,handlers,active,async call(name,args={}){const t=tools.get(name);const r=await t.execute(name,t.prepareArguments?t.prepareArguments(args):args,undefined,undefined,{cwd:repo,model:{id:'mock'}});return JSON.parse(r.content[0].text);}};}

test('Orchestrator MD, registered tools and restored active tools contain only coordinator capabilities',async()=>{
 const md=await readFile(join(repo,'.pi/agents/orchestrator.md'),'utf8');assert.doesNotMatch(md,forbidden);
 assert.deepEqual(DREAMATIC_PERSONA_TOOL_POLICY.orchestrator,ORCHESTRATOR_TOOLS);
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-coordinator-'));
 try{const h=harness(workspace);assert.deepEqual([...h.tools.keys()].sort(),[...ORCHESTRATOR_TOOLS].sort());
 const response=await h.handlers.get('before_agent_start')({prompt:'Current task',systemPrompt:'Base\n<!-- DREAMATIC_ACTIVE_PERSONA -->old persona<!-- /DREAMATIC_ACTIVE_PERSONA -->'});
 assert.deepEqual(h.active.at(-1),ORCHESTRATOR_TOOLS);assert.doesNotMatch(response.systemPrompt,forbidden);
 for(const name of ['read','write','edit','write_json','patch_json','ls','grep','find','design_bus_post'])assert.equal((await h.handlers.get('tool_call')({toolName:name,input:{}})).block,true);
 const initialized=await h.call('run_init',{runIdOverride:'demo',projectTitle:'Current task',brief:'Cabin',designScopes:[{id:'cabin',category:'space',task:'Cabin'}]});
 assert.equal(initialized.contextFiles.research,'context/research.json');assert.equal(initialized.researchDir,undefined);
 const context=await h.call('design_context_read',{runId:'demo',audience:'orchestrator'});assert.equal(context.ok,true);
 assert.doesNotMatch(JSON.stringify(context.authoringContract),forbidden);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('recorded obsolete handoff is rejected before starting a specialist; canonical handoffs remain valid',async()=>{
 for(const text of ['研究叙事文档：research/research-findings.md','证据数据：research/evidence.json','Write with write_json','Save with save_design_context'])assert.ok(orchestratorHandoffIssue(text));
 assert.equal(orchestratorHandoffIssue('Research the confirmed request; author context/research.json and publish research_done.'),undefined);
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-handoff-'));
 try{const h=harness(workspace);const response=await h.call('spawn_agent',{agent:'researcher',runId:'demo',task:'输出研究叙事文档：research/research-findings.md'});assert.equal(response.code,'invalid_context_handoff');assert.doesNotMatch(response.instruction,forbidden);
 await mkdir(join(workspace,'runs/historical'),{recursive:true});await writeFile(join(workspace,'runs/historical/brief.json'),'{}');
 const historical=await h.call('spawn_agent',{agent:'researcher',runId:'historical',task:'Author context/research.json'});assert.equal(historical.code,'context_migration_required');
 await assert.rejects(h.call('design_context_read',{runId:'historical',audience:'orchestrator'}),/explicit data migration/);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('coordinator lifecycle and Context reads support research, design, review, build, export and revision without file tools',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-coordinator-pipeline-'));
 function specialist(role){const tools=new Map();createDreamaticExtension({workspaceDir:workspace,...(["designer","reviewer","builder"].includes(role) ? {personaPath:join(repo,".pi/agents",`${role}.md`)} : {}),parentInvocation:{id:role,agent:role,runId:'demo'}})({registerTool:t=>tools.set(t.name,t),registerProvider(){},on(){}});return async(name,args={})=>{const t=tools.get(name);const r=await t.execute(name,t.prepareArguments?t.prepareArguments(args):args,undefined,undefined,{cwd:repo});return name==='use_skill'?r:JSON.parse(r.content[0].text);};}
 try{const root=harness(workspace);await root.call('run_init',{runIdOverride:'demo',projectTitle:'Concept',brief:'Concept page',designScopes:[{id:'ui',category:'ux',task:'Concept page'}]});
 await root.call('todo_write',{runId:'demo',items:[{id:'research',status:'in_progress',text:'Research'}]});
 const research=specialist('researcher');await research('update_design_context',{changes:{evidence:{target:'Concept',summary:'No factual claims',official_sources:[],open_questions:[]},findings:'Concept-only fixture',usageConditions:'No external assets'}});assert.equal((await research('commit_design_context')).committed,true);await research('design_bus_post',{runId:'demo',type:'research_done',summary:'Concept assumptions'});
 const evidence=await root.call('design_context_read',{runId:'demo',audience:'orchestrator',paths:['context/research.json'],select:{section:'findings'}});assert.match(evidence.files[0].content,/Concept-only fixture/);
 const designer=specialist('designer');await designer('use_skill',{name:'ui-web-design',scopeId:'ui',role:'primary',rationale:'Concept page'});
 const source='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Concept</title></head><body><h1>Concept</h1></body></html>';
 // Fixture source is authored by Designer; coordinator has no file tools.
 await mkdir(join(workspace,'runs/demo/plan/html/ui'),{recursive:true});await writeFile(join(workspace,'runs/demo/plan/html/ui/index.html'),source);
 await designer('update_design_context',{changes:{system:{system_thesis:'Readable concept',palette:{},typography:{}},strategy:{design_intent:'Present concept'},deliverables:[{id:'page',scope_id:'ui',skill_refs:['ui-web-design'],file:'artifacts/ui/index.html',kind:'html_page',purpose:'Present concept',acceptance_test:'Readable title',required:true,user_requested:true,presentation:{required:true,access:'embed'},execution:{method:'html_generate',files:[{source:'plan/html/ui/index.html',output:'artifacts/ui/index.html'}],resources:[],interaction_checks:[]}}],presentation:{mode:'html',entry:'artifacts/ui/index.html'}}});assert.equal((await designer('commit_design_context')).committed,true);await designer('design_bus_post',{runId:'demo',type:'design_spec_ready',summary:'Concept ready',requestedAction:'review'});
 const design=await root.call('design_context_read',{runId:'demo',audience:'orchestrator',paths:['context/design.json'],select:{section:'tasks',ids:['page']}});assert.equal(JSON.parse(design.files[0].content).tasks[0].id,'page');
 const reviewer=specialist('reviewer');await reviewer('update_design_context',{changes:{assessment:{review_stage:'design_context',verdict:'pass',round:1,summary:'Fixture approved',scores:{},issues:[],resolved_issue_ids:[],remaining_risks:[]}}});assert.equal((await reviewer('commit_design_context')).committed,true);await reviewer('design_bus_post',{runId:'demo',type:'design_review_pass',summary:'Fixture approval'});
 const review=await root.call('design_context_read',{runId:'demo',audience:'orchestrator',paths:['context/review.json'],full:true});assert.equal(JSON.parse(review.files[0].content).assessment.verdict,'pass');
 const builder=specialist('builder');assert.equal((await builder('execute_design_plan',{runId:'demo'})).succeeded,1);assert.equal((await builder('build_finalize',{runId:'demo'})).ok,true);
 assert.equal((await root.call('export_package',{runId:'demo'})).ok,true);
 assert.equal((await root.call('run_revision',{runId:'demo',feedback:'User requests revised title'})).ok,true);
 assert.equal((await root.call('run_brief_update',{runId:'demo',feedback:'User confirms students as audience',brief:'Concept for students'})).ok,true);
 assert.equal(root.tools.has('write_json'),false);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('actual Pi session request hides file tools and specialist storage instructions even after tool reactivation',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-coordinator-session-'));let session;const previousKey=process.env.OPENAI_API_KEY,previousAgentDir=process.env.PI_CODING_AGENT_DIR;process.env.OPENAI_API_KEY='isolated-test-key';process.env.PI_CODING_AGENT_DIR=join(workspace,'agent');
 try{({session}=await createDreamaticSession({repoRoot:repo,workspaceDir:workspace,inMemory:true}));
 session.agent.state.model={id:'mock',name:'Mock',provider:'openai',api:'openai-completions',contextWindow:100000,maxTokens:1024,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 session.setActiveToolsByName(['read','design_context_read']);let requests=0;
 session.agent.streamFunction=(_model,context)=>{requests++;assert.deepEqual(context.tools.map(t=>t.name).sort(),[...ORCHESTRATOR_TOOLS].sort());assert.doesNotMatch(context.systemPrompt,forbidden);assert.doesNotMatch(JSON.stringify(context.tools),forbidden);
 const message={role:'assistant',api:'openai-completions',provider:'mock',model:'mock',content:[{type:'text',text:'Ready'}],stopReason:'stop',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};return{async *[Symbol.asyncIterator](){yield{type:'done',reason:'stop',message};},result:async()=>message};};
 await session.prompt('Explain current routing.');assert.equal(requests,1,JSON.stringify(session.messages.map(m=>({role:m.role,error:m.errorMessage}))));
 }finally{session?.dispose();if(previousKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previousKey;if(previousAgentDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousAgentDir;await rm(workspace,{recursive:true,force:true});}
});
