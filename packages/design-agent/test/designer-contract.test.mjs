import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createDreamaticExtension,DREAMATIC_PERSONA_TOOL_POLICY,dreamaticPersonaTools} from '../dist/extension.js';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const obsolete=/\blegacy\b|split-file|write_json|patch_json|save_design_context|patch_design_context|design_system_ref|image_generation_plan|execution_plan|plan\/design_system\.json|plan\/design_plan\.json|plan\/deliverable_manifest\.json/iu;
function harness(workspace,designer=false){const tools=new Map(),handlers=new Map(),active=[];createDreamaticExtension({workspaceDir:workspace,...(designer?{personaPath:join(repo,'.pi/agents/designer.md'),parentInvocation:{id:'designer-test',agent:'designer',runId:'demo'}}:{})})({registerTool:t=>tools.set(t.name,t),on:(name,fn)=>handlers.set(name,fn),setActiveTools:names=>active.push(names)});return{tools,handlers,active,async call(name,args={}){const t=tools.get(name);assert.ok(t,name);const r=await t.execute(name,t.prepareArguments?t.prepareArguments(args):args,undefined,undefined,{cwd:repo});return name === "use_skill" ? r : JSON.parse(r.content[0].text);}};}
test('Designer MD and exposed custom tools contain only the named Context and source contract',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-designer-contract-'));
 try{const md=await readFile(join(repo,'.pi/agents/designer.md'),'utf8');assert.doesNotMatch(md,obsolete);
 const declared=md.split('allowed_tools:')[1].split('---')[0].match(/- (\w+)/g).map(s=>s.slice(2));assert.deepEqual(dreamaticPersonaTools('designer',declared),DREAMATIC_PERSONA_TOOL_POLICY.designer);
 const d=harness(workspace,true);for(const name of d.tools.keys())assert.ok(DREAMATIC_PERSONA_TOOL_POLICY.designer.includes(name),name);
 assert.doesNotMatch(JSON.stringify([...d.tools.values()].map(t=>({name:t.name,description:t.description}))),obsolete);
 for(const name of ['write_json','patch_json','save_design_context','patch_design_context','image_generate','spawn_agent']){assert.equal(d.tools.has(name),false);assert.equal((await d.handlers.get('tool_call')({toolName:name,input:{}},{cwd:repo})).block,true);}
 }finally{await rm(workspace,{recursive:true,force:true});}
});
test('Designer can author and commit Context, write HTML sources and restore its tool set',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-designer-authoring-'));
 try{await harness(workspace).call('run_init',{runIdOverride:'demo',projectTitle:'Test',brief:'A static HTML page',designScopes:[{id:'ui',category:'ux',task:'A static page'}]});const d=harness(workspace,true);
 await d.call('design_context_read',{audience:'designer'});
 await d.call('use_skill',{name:'ui-web-design',scopeId:'ui',role:'primary',rationale:'Define the requested web page'});
 const saved=await d.call('update_design_context',{changes:{system:{system_thesis:'A clear design',palette:{},typography:{}},strategy:{design_intent:'A clear static page'},deliverables:[{id:'page',scope_id:'ui',skill_refs:['ui-web-design'],file:'artifacts/ui/index.html',kind:'html_page',purpose:'The requested page',acceptance_test:'Page is accessible',required:true,user_requested:true,presentation:{required:true,access:'embed'},execution:{method:'html_generate',files:[{source:'plan/html/ui/index.html',output:'artifacts/ui/index.html'}],resources:[],interaction_checks:[]}}],presentation:{mode:'html',entry:'artifacts/ui/index.html'}}});assert.equal(saved.saved,true);assert.equal((await d.call('commit_design_context')).committed,true);
 assert.equal(await d.handlers.get('tool_call')({toolName:'write',input:{path:join(workspace,'runs/demo/plan/html/ui/index.html'),content:'<!doctype html><title>Test</title>'}},{cwd:repo}),undefined);
 const prompt=await d.handlers.get('before_agent_start')({prompt:'Continue',systemPrompt:''});assert.deepEqual(d.active.at(-1),DREAMATIC_PERSONA_TOOL_POLICY.designer);assert.doesNotMatch(prompt.systemPrompt,obsolete);
 }finally{await rm(workspace,{recursive:true,force:true});}
});
test('Designer supporting Skills no longer teach split-file authoring',async()=>{
 for(const name of ['design-system','image-prompting','html-interface'])assert.doesNotMatch(await readFile(join(repo,'.pi/skills',name,'SKILL.md'),'utf8'),/split-file|write_json|patch_json|design_system_ref|image_generation_plan|execution_plan/iu);
});
