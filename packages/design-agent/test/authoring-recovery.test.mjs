import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDreamaticExtension } from '../dist/extension.js';
import { prepareContextChanges, contextUpdateDescription } from '../dist/context-tools.js';
import { unifiedDesignSpecificationProtocol } from '../dist/design-contract.js';
const cwd = fileURLToPath(new URL('../../..', import.meta.url));
function harness(workspaceDir, role) {
 const tools = new Map();
 createDreamaticExtension({workspaceDir,...(role?{parentInvocation:{id:role,agent:role,runId:'demo'}}:{})})({registerTool:t=>tools.set(t.name,t),on(){}});
 return {tools, async call(name,input={}) { const t=tools.get(name);return t.execute(name,t.prepareArguments?t.prepareArguments(input):input,undefined,undefined,{cwd}); }};
}
const content = r => JSON.parse(r.content[0].text);

test('C919 failure shape: misplaced named envelope fields preserve all values, conflicts never choose a winner', () => {
 const source={changes:{system:{system_thesis:'Sky Silk Road',palette:{blue:'#1E3A5F'},typography:{body:'sans-serif'}}},strategy:{design_intent:'Three themed cabins'},deliverables:[{id:'cabin',execution:{method:'image_generate',prompt_seed:'Original prompt'}}],presentation:{mode:'gallery',entry:'artifacts/00-gallery.html'}};
 const before=structuredClone(source);
 const result=prepareContextChanges(source,'designer',2);
 assert.deepEqual(result,{changes:{...source.changes,strategy:source.strategy,deliverables:source.deliverables,presentation:source.presentation}});
 assert.deepEqual(source,before);
 assert.deepEqual(prepareContextChanges({changes:{evidence:{target:'Aircraft'}},findings:'Original report',usageConditions:'Original gaps'},'researcher').changes,{evidence:{target:'Aircraft'},findings:'Original report',usageConditions:'Original gaps'});
 assert.throws(()=>prepareContextChanges({...source,changes:{...source.changes,strategy:{design_intent:'Conflicting'}}},'designer',2),/conflicting_field_change/);
 for(const field of ['runId','schemaVersion','revision','path','updates','tasks']) assert.throws(()=>prepareContextChanges({...source,[field]:[]},'designer',2));
 assert.deepEqual(prepareContextChanges({changes:{system:{},typography:{body:'Original'}}},'designer',2).changes,{system:{typography:{body:'Original'}}});
 assert.throws(()=>prepareContextChanges({changes:{system:{typography:{body:'Conflicting'}},typography:{body:'Original'}}},'designer',2),/conflicting_field_change/);
 for(const field of ['consistency_rules','asset_rules','consistency_anchor','prohibited']) {
  const input={changes:{system:{system_thesis:'Original'},[field]:['Original rule']},strategy:{design_intent:'Original intent'}};
  const before=structuredClone(input);
  assert.deepEqual(prepareContextChanges(input,'designer',2),{changes:{system:{system_thesis:'Original',[field]:['Original rule']},strategy:{design_intent:'Original intent'}}});
  assert.deepEqual(input,before);
  assert.throws(()=>prepareContextChanges({changes:{system:{[field]:['Conflicting']},[field]:['Original rule']}},'designer',2),/conflicting_field_change/);
 }
 assert.throws(()=>prepareContextChanges({changes:{unknown_creative_rules:['Original']}},'designer',2),/invalid_named_fields/);
 assert.throws(()=>prepareContextChanges({changes:{strategy:{skill_selection:[]}}},'designer',2),/runtime_owned_field/);
});

test('v2 model-visible instructions and loaded Skill agree with execution storage', async () => {
 const description=contextUpdateDescription('designer',2);
 assert.equal(/replaceTasks|removeTasks|assessment/.test(description),false);
 assert.match(description,/ALL named fields/);
 const protocol=unifiedDesignSpecificationProtocol('1536x1024',2);
 assert.deepEqual(protocol.typed.imageTaskFields,['method','prompt_seed','negative_prompt_seed','size','size_rationale']);
 assert.match(protocol.resourcePolicy.pageImages,/execution.uses/);
 const skill=await readFile(join(cwd,'.pi/skills/image-prompting/SKILL.md'),'utf8');
 assert.equal(skill.includes('In unified Context, every image is one `tasks` item'),false);
 assert.match(skill,/nested `execution`/);
});

test('real extension preserves partial design updates and parallel Skill receipts across C919 scope failures',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-c919-recovery-'));
 try {
  const root=harness(workspace);await root.call('run_init',{runIdOverride:'demo',projectTitle:'Cabin',brief:'Three cultural cabins',designScopes:[{id:'cabin-interior-system',category:'space',task:'Cabin space'},{id:'seat-fixture-cmf',category:'industrial',task:'Seat CMF'}]});
  const designer=harness(workspace,'designer');
  await assert.rejects(designer.call('use_skill',{name:'architecture-space',bindings:[{scopeId:'cabin-interior-system',role:'primary',rationale:'Cabin'},{scopeId:'seat-fixture-cmf',role:'primary',rationale:'Seats'}]}),error=>{
   const d=JSON.parse(error.message);assert.equal(d.selectionChanged,false);assert.deepEqual(d.eligiblePrimaryScopes,['cabin-interior-system']);assert.ok(d.suggestedCalls.some(c=>c.name==='industrial-design'&&c.scopeId==='seat-fixture-cmf'));return true;
  });
  await Promise.all([
   designer.call('use_skill',{name:'architecture-space',scopeId:'cabin-interior-system',role:'primary',rationale:'Cabin'}),
   designer.call('use_skill',{name:'industrial-design',scopeId:'seat-fixture-cmf',role:'primary',rationale:'Seats'}),
   designer.call('use_skill',{name:'image-prompting',bindings:[{scopeId:'cabin-interior-system',role:'supporting',rationale:'Cabin images'},{scopeId:'seat-fixture-cmf',role:'supporting',rationale:'Seat images'}]})
  ]);
  const receipt=JSON.parse(await readFile(join(workspace,'runs/demo/.performance/skills-designer.json'),'utf8'));
  assert.equal(receipt.activeSkills.length,4);
  await designer.call('design_context_read',{audience:'designer'});
  const first=content(await designer.call('update_design_context',{changes:{system:{system_thesis:'Original',palette:{},typography:{}}},strategy:{design_intent:'Three distinct themes'}}));
  assert.equal(first.saved,true);
  await designer.call('update_design_context',{changes:{strategy:{creative_decisions:[{why:'Original retained'}]}}});
  const working=content(await designer.call('update_design_context',{changes:{}}));
  assert.equal(working.data.system.system_thesis,'Original');assert.equal(working.data.strategy.design_intent,'Three distinct themes');assert.equal(working.data.strategy.creative_decisions[0].why,'Original retained');
  assert.equal(content(await designer.call('commit_design_context')).committed,false); // Syntax repair never approves missing outputs.
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('page dependencies and edit anchors are execution order, not copied HTML image resources',async()=>{
 const {designTasks}=await import('../dist/design-context-v2.js');
 const items=[{id:'image',file:'artifacts/image.png',execution:{method:'image_generate'}},{id:'detail',file:'artifacts/detail.html',execution:{method:'html_generate'}},{id:'home',file:'artifacts/index.html',execution:{method:'html_generate',uses:['image','detail']}},{id:'edit',file:'artifacts/edit.png',execution:{method:'image_edit',uses:['image']}}];
 const tasks=designTasks({deliverables:items});
 assert.deepEqual(tasks[2].dependencies,['image','detail']);
 assert.deepEqual(tasks[2].resources,[{source:'artifacts/image.png',output:'artifacts/image.png'}]);
 assert.deepEqual(tasks[3].dependencies,['image']);assert.deepEqual(tasks[3].resources,[]);
 const {contextSemanticIssues}=await import('../dist/context-schema.js');
 assert.ok(contextSemanticIssues('designer',{deliverables:[{id:'document',kind:'document',execution:{method:'html_generate',interaction_requirements:[]},presentation:{required:true,access:'embed'},user_requested:true,required:true}]}).some(i=>i.pointer==='/deliverables/0/kind'));
});

test('new v2 schema catches interaction syntax before saving, while descriptive outcomes remain notes',async()=>{
 const base={id:'page',execution:{method:'html_generate',interaction_checks:[{name:'Navigate',steps:[{action:'click',selector:'a'},{action:'expect_url',value:'#concept'}]}],interaction_requirements:[{id:'nav',goal:'Read section',outcome:['Section becomes visible']}]}};
 assert.doesNotThrow(()=>prepareContextChanges({changes:{deliverables:[base]}},'designer',2));
 for(const check of [{name:'Bad',steps:['click nav']},{name:'Bad',steps:[{action:'scroll',selector:'#concept'}]},{name:'Bad',viewport:{width:390,height:844},steps:[{action:'click',selector:'a'}]}]){
  assert.throws(()=>prepareContextChanges({changes:{deliverables:[{id:'page',execution:{interaction_checks:[check]}}]}},'designer',2),error=>JSON.parse(error.message).field.startsWith('/changes/deliverables/0/execution/interaction_checks'));
 }
 assert.throws(()=>prepareContextChanges({changes:{deliverables:[{id:'image',file:'bare-name.png'}]}},'designer',2),/\/file/);
});

test('redundant common Skill fields do not reject valid bindings; unchanged diagnostics stop after three calls',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-bounded-diagnostic-'));
 try{
  const root=harness(workspace);await root.call('run_init',{runIdOverride:'demo',projectTitle:'Coverage',brief:'A test',designScopes:[{id:'space',category:'space',task:'Space'},{id:'product',category:'industrial',task:'Product'}]});
  const designer=harness(workspace,'designer');
  const result=await designer.call('use_skill',{name:'image-prompting',role:'supporting',rationale:'Shared imagery',scopeId:'space',bindings:[{scopeId:'space',role:'supporting',rationale:'Spatial imagery'},{scopeId:'product',role:'supporting',rationale:'Product imagery'}]});
  assert.equal(result.details.bindings.length,2);
  const before=await readFile(join(workspace,'runs/demo/.performance/skills-designer.json'));
  await assert.rejects(designer.call('use_skill',{name:'image-prompting',role:'primary',bindings:[{scopeId:'space',role:'supporting',rationale:'Keep'}]}),/disagrees/);
  assert.deepEqual(await readFile(join(workspace,'runs/demo/.performance/skills-designer.json')),before);
  const tool=designer.tools.get('design_context_validate');
  for(let i=1;i<=3;i++){const result=await tool.execute(`diagnostic-${i}`,{});assert.equal(result.details.attempts,i);assert.equal(result.details.blocked,i===3);assert.equal(result.terminate===true,i===3);}
 }finally{await rm(workspace,{recursive:true,force:true});}
});
