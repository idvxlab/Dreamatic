import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plannedImages, dimensions, imageCapabilities, imageCapabilityInfo, recordSuccessfulImageSize, runDesign } from '../dist/design-pipeline.js';

const design = `# Work\n## Image: hero\n### Introduction\nOriginal hero\n### Size\n768x1024\n### Prompt\nA complete portrait image\n## Image: detail\n### Introduction\nMaterial study\n### Size\n1024x1024\n### Prompt\nClose-up of materials\n`;
test('Markdown image contract keeps independent prompts and dimensions', () => {
 assert.deepEqual(plannedImages(design), [{id:'hero',introduction:'Original hero',size:'768x1024',prompt:'A complete portrait image'},{id:'detail',introduction:'Material study',size:'1024x1024',prompt:'Close-up of materials'}]);
 assert.throws(()=>plannedImages(design.replace('Image: detail','Image: hero')), /distinct/);
 assert.throws(()=>dimensions('0x1024'), /Invalid/);
 assert.throws(()=>plannedImages('# empty'), /distinct/);
});
test('verified capabilities persist outside runs and remain scoped to model settings', async t => {
 const root = await mkdtemp(join(tmpdir(), 'dreamatic-caps-')); const old = {...process.env};
 t.after(async()=>{process.env = old; await rm(root,{recursive:true,force:true});});
 process.env.DREAMATIC_CONFIG_DIR = root;
 process.env.DREAMATIC_IMAGE_CAPABILITIES = '{"sizes":["768x1024","1024x1024"]}';
 assert.deepEqual(await imageCapabilities(), ['768x1024','1024x1024']);
 assert.deepEqual(await imageCapabilities(), ['768x1024','1024x1024']);
 assert.equal((await readdir(join(root,'cache/image-capabilities'))).length,1);
 process.env.DREAMATIC_IMAGE_MODEL = 'different-model';
 await imageCapabilities();
 assert.equal((await readdir(join(root,'cache/image-capabilities'))).length,2);
 process.env.DREAMATIC_IMAGE_CAPABILITIES = '{"sizes":["bad"]}';
 await assert.rejects(imageCapabilities(), /Invalid/);
});
test('resume without an original request fails before model calls', async t => {
 const root = await mkdtemp(join(tmpdir(),'dreamatic-resume-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await assert.rejects(runDesign({repoRoot:root,workspaceDir:root,runId:'missing',text:'继续完成',signal:new AbortController().signal,emit(){}}),/No original request/);
});

test('Pi SDK completes four stages, reuses a valid run and recovers a changed Markdown document', async t => {
 const { createServer } = await import('node:http');
 const { readFile } = await import('node:fs/promises');
 const root = await mkdtemp(join(tmpdir(),'dreamatic-pipeline-')); const old = {...process.env};
 const calls = [];
 let shouldClarify = true;
 let skipPlan = false, imageRequests = 0, brokenReferences = false, failHero = false, heroFailureRequests = 0, onlyMissingOnResume = false;
 const server = createServer(async (req,res) => {
  let body=''; for await(const chunk of req) body += chunk;
  const data = JSON.parse(body || '{}');
  if (req.method === 'GET') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({id:'fixture',object:'model'})); return; }
  if(req.url.endsWith('/images/generations')) { imageRequests++; if(failHero && data.prompt.includes('portrait')) {heroFailureRequests++;res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'upstream unavailable'}));return;} await new Promise(resolve=>setTimeout(resolve,1000)); res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='}]})); return; }
  const system = data.messages.find(m=>m.role==='system')?.content || '';
  const stage = system.includes('Understand the request') ? 'orchestrator' : system.includes('Read intent.md. Use search') ? 'researcher' : system.includes('Produce only design.md') ? 'designer' : 'builder';
  if (stage === 'designer' && JSON.stringify(data.messages).includes('/skill:pipeline-method')) assert.match(JSON.stringify(data.messages.filter(message => message.role === 'user')), /Explicit campaign anchor: copper moon/);
  else assert.doesNotMatch(JSON.stringify(data.messages), /Explicit campaign anchor: copper moon/);
  assert.match(system,/Dreamatic saves your final response/);
  assert.match(system,/Never call unavailable tools/);
  assert.ok(!data.tools.some(tool=>['write','edit'].includes(tool.function.name)));
  if (stage==='builder') {
   assert.ok(!data.tools.some(tool=>tool.function.name==='inspect_showcase_images'));
   assert.ok(data.tools.some(tool=>tool.function.name==='plan_showcase'));
   for (const message of data.messages) if (Array.isArray(message.content)) assert.ok(message.content.every(block=>block.type==='text'),'text-only provider rejects image input');
   assert.ok(JSON.stringify(data.messages).includes('Material study'),'image descriptions must reach Builder');
  }
  calls.push(stage);
  if (stage==='orchestrator' && shouldClarify) {
   shouldClarify=false;
   const args={title:'Choose the intended setting',context:'This changes the design direction.',questions:[{id:'audience',header:'Audience',question:'Who is this for?',options:[{label:'Home',description:'Domestic use'},{label:'Office',description:'Workplace use'}],multiple:false,custom:true,required:true}]};
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   for(const choice of [{delta:{role:'assistant',tool_calls:[{index:0,id:'clarify',type:'function',function:{name:'ask_user',arguments:JSON.stringify(args)}}]},finish_reason:null},{delta:{},finish_reason:'tool_calls'}]) res.write(`data: ${JSON.stringify({id:'clarification',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,...choice}]})}\n\n`);
   res.end('data: [DONE]\n\n');return;
  }

  const generationText=data.messages.find(m=>m.role==='tool' && m.tool_call_id==='generate')?.content || '';
  const imageTags=['hero','detail'].map(id=>`<img src="${generationText.match(new RegExp(id+': (dreamatic-image:[^\\s]+)'))?.[1] || 'dreamatic-image:'+id}">`).join('');
  const result = stage==='orchestrator' ? '# Aurora\nA sustainable lamp.' : stage==='researcher' ? (brokenReferences ? '# Research\nUncertain evidence [8].\n## References\n[1] Known source. https://example.org/background\n[1] Different source with the same id. URL unavailable\n' : '# Research\nBackground source: https://example.org/background\n\n## References\n[1] Supporting evidence. https://example.org/support\n[2] Background reading. https://example.org/background\n') : stage==='designer' ? (brokenReferences ? '# Concept\nUnresolved evidence [77].\n' : '')+design.replace('768x1024','1024x1024')+'\n## References\n[2] Rewritten bibliography. https://wrong.example/source\n' : "Now I will compose the complete exhibition HTML.\n\n```html\n"+`<!doctype html><html><body>${imageTags}</body></html>`+"\n```\nThe exhibition is ready.";
  const needsRead = !data.messages.some(m=>m.role==='tool' && m.tool_call_id===`read-${stage}`);
  const classify = ['orchestrator','designer'].includes(stage) && !data.messages.some(m=>m.role==='tool' && m.tool_call_id==='classification');
  const tool = stage === 'builder' && !data.messages.some(m=>m.role==='tool' && m.tool_call_id==='generate');
  const plan = stage==='builder' && !skipPlan && !data.messages.some(m=>m.role==='tool' && m.tool_call_id==='plan');
  const toolCall=(id,name,args)=>({tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  const delta = needsRead ? toolCall(`read-${stage}`,'read',{path:join(process.cwd(),'apps/server/prompts',`${stage}.md`)})
    : classify ? toolCall('classification','set_project_classification',{primary:stage==='designer'?'product':'visual',secondary:[]})
    : tool ? toolCall('generate','image_generate',{ids:onlyMissingOnResume?['hero']:['hero','detail']})
    : plan ? toolCall('plan','plan_showcase',{heroId:'hero',works:[{id:'hero',role:'hero',section:'Everyday light',purpose:'Introduce the concept'},{id:'detail',role:'detail',section:'Material logic',purpose:'Explain construction'}],direction:'## Thesis\nA sustainable lamp in everyday use.\n## Art direction\nA warm light field, quiet typography and a dominant full-view hero.\n## Sequence\nHero followed by the complete detail study and concise material rationale.'})
    : {content:result};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const chunk = {id:'test',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',...delta},finish_reason:null}]};
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write(`data: ${JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:needsRead||classify||tool||plan?'tool_calls':'stop'}]})}\n\n`);
  res.end('data: [DONE]\n\n');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{process.env=old;await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}/v1`;
 Object.assign(process.env,{DREAMATIC_CONFIG_DIR:root,DREAMATIC_BASE_URL:base,DREAMATIC_API_KEY:'fixture',DREAMATIC_MODEL:'fixture',DREAMATIC_CONTEXT_WINDOW:'32768',DREAMATIC_MAX_TOKENS:'8192',DREAMATIC_IMAGE_BASE_URL:base,DREAMATIC_IMAGE_CAPABILITIES:'',DREAMATIC_IMAGE_DEFAULT_SIZE:'1024x1024',DREAMATIC_PROVIDER_TYPE:'openai-compatible',DREAMATIC_MODEL_TOTAL_TIMEOUT_MS:'750'});
 const { mkdir, writeFile, copyFile } = await import('node:fs/promises');
 const method = join(root, 'pipeline-method'); await mkdir(join(method, 'agents'), {recursive:true});
 await writeFile(join(method, 'SKILL.md'), '---\nname: pipeline-method\ndescription: Campaign knowledge for this fixture.\n---\nExplicit campaign anchor: copper moon.');
 await writeFile(join(method, 'agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
 process.env.DREAMATIC_SKILL_PATHS = JSON.stringify({designer:[method]});
 await mkdir(join(root,'apps/server/prompts'),{recursive:true});
 for(const role of ['orchestrator','researcher','designer','builder']) await copyFile(join(process.cwd(),'apps/server/prompts',`${role}.md`),join(root,'apps/server/prompts',`${role}.md`));
 await mkdir(join(root,'runs','project'),{recursive:true});
 const emitted=[];
 const options={repoRoot:root,workspaceDir:root,runId:'project',text:'/skill:pipeline-method Design a lamp',signal:new AbortController().signal,emit(event){emitted.push(event)}};
 let pending;
 await runDesign({...options,onQuestion:request=>{pending=request;}});
 assert.equal(pending.title,'Choose the intended setting');
 assert.equal(pending.questions[0].options.length,2);
 assert.equal(pending.id,'clarify');
 assert.equal(JSON.parse(await readFile(join(root,'runs/project/run-state.json'),'utf8')).status,'waiting_for_user');
 assert.ok(emitted.some(item=>item.type==='workflow_event' && item.event.type==='agent_waiting'));
 assert.ok(!emitted.some(item=>item.type==='workflow_event' && item.event.type==='agent_interrupted'));
 const {workflowInventory:waitingInventory}=await import('../dist/workflow-store.js');
 const waiting=(await waitingInventory(root,'project')).find(item=>item.agent==='orchestrator');
 assert.equal(waiting.status,'waiting');
 assert.ok(!waiting.children.some(item=>item.kind==='error'));
 await runDesign({...options,text:'Home use'});
 assert.deepEqual([...new Set(calls)],['orchestrator','researcher','designer','builder']);
 assert.equal(JSON.parse(await readFile(join(root,'runs/project/brief.json'),'utf8')).title,'Work');
 assert.equal(JSON.parse(await readFile(join(root,'runs/project/brief.json'),'utf8')).classification.primary,'product');
 assert.ok(emitted.some(item=>item.type==='workflow_event' && item.event.type==='project_classified' && item.event.classification.primary==='product'));
 assert.ok(emitted.some(item=>item.type==='workflow_event' && item.event.type==='project_renamed' && item.event.title==='Work'));
 const titleIndex=emitted.findIndex(item=>item.type==='workflow_event' && item.event.type==='project_renamed' && item.event.title==='Work');
 const builderIndex=emitted.findIndex(item=>item.type==='workflow_event' && item.event.type==='agent_started' && item.event.agent==='builder');
 assert.ok(titleIndex>=0 && titleIndex<builderIndex,'final name is published before Builder starts');
 assert.equal(JSON.parse(await readFile(join(root,'runs/project/run-state.json'),'utf8')).status,'completed');
 const completionEvents=emitted.filter(item=>item.type==='workflow_event' && item.event.type==='project_completed');
 assert.equal(completionEvents.length,1);assert.equal(completionEvents[0].event.completion.deliverables.filter(item=>item.kind==='image').length,2);
 assert.equal(completionEvents[0].event.completion.unreportedImageCalls,2);
 assert.equal(JSON.parse(await readFile(join(root,'runs/project/completion-summary.json'),'utf8')).stages.length,4);

 assert.ok(!emitted.some(item=>item.type==='workflow_event' && item.event.toolName==='inspect_showcase_images'));
 const manifest=JSON.parse(await readFile(join(root,'runs/project/artifacts/artifact-manifest.json'),'utf8'));
 assert.equal(manifest.artifacts.length,2,'all images are generated and exhibited');
 assert.equal(manifest.classification.primary,'product');
 assert.deepEqual(manifest.showcase.imageIds,['hero','detail']);
 assert.match(await readFile(join(root,'runs/project/showcase.md'),'utf8'),/Art direction/);
 assert.equal(manifest.showcase.works.length,2);
 const originalDesign=await readFile(join(root,'runs/project/design.md'),'utf8');
 assert.match(originalDesign,/\[2\] Background reading/,'research entries are copied rather than rewritten by Designer');
 assert.match(originalDesign,/\[1\] Supporting evidence/,'all research entries are included even if Designer omitted them');
 assert.ok(!originalDesign.includes('https://wrong.example/source'));
 assert.match(JSON.parse(await readFile(join(root,'runs/project/.design-draft.json'),'utf8')).text,/https:\/\/wrong\.example\/source/,'raw draft remains unchanged for audit and recovery');
 const firstDesignerFinish=emitted.find(item=>item.type==='workflow_event' && item.event.type==='agent_finished' && item.event.agent==='designer');
 assert.match(firstDesignerFinish.event.output,/Citation note:.*\[2\]/);
 assert.ok(!emitted.some(item=>item.type==='workflow_event' && item.event.type==='agent_interrupted'));

 assert.equal(((await readFile(join(root,'runs/project/final/00-index.html'),'utf8')).match(/<img /g)||[]).length,2);
 assert.ok((await readFile(join(root,'runs/project/final/00-index.html'),'utf8')).startsWith('<!doctype html>'));
 assert.match(JSON.parse(await readFile(join(root,'runs/project/.builder-output.json'),'utf8')).text,/Now I will compose/);
 assert.ok(!(await readFile(join(root,'runs/project/final/00-index.html'),'utf8')).includes('dreamatic-image:'));
 const {prepareProjectExport}=await import('../dist/project-export.js');
 const {promisify}=await import('node:util');const {execFile}=await import('node:child_process');
 const archive=await prepareProjectExport(root,'project');
 try {
  const {stdout}=await promisify(execFile)('unzip',['-p',archive.path,'project/artifacts/00-gallery.html']);
  assert.ok(!stdout.includes('dreamatic-image:'));assert.ok(!stdout.includes('../artifacts/'));
  for(const item of manifest.artifacts)assert.ok(stdout.includes('./'+item.path.slice('artifacts/'.length)));
 } finally {await archive.cleanup();}


 const { workflowInventory } = await import('../dist/workflow-store.js');
 const restored = await workflowInventory(root, 'project');
 const progressEvents=emitted.filter(item=>item.type==='workflow_event' && item.event.type==='agent_progress');
 assert.ok(progressEvents.length>=4);
 for(const item of progressEvents) {
   assert.ok(item.event.agent && item.event.invocationId);
   assert.ok(item.event.output.length<=1200);
 }

 for (const role of ['orchestrator','researcher','designer','builder']) {
   const raw = emitted.filter(item=>item.type==='agent_event' && item.agent===role && item.event.type==='tool_execution_start');
   assert.ok(raw.some(item=>item.event.toolName==='read'), `${role} must emit attributed read events`);
   assert.ok(raw.every(item=>typeof item.invocationId==='string'));
   const parent=restored.findLast(item=>item.agent===role);
   assert.ok(parent.children.some(item=>item.tool==='read' && item.actor.toLowerCase()===role));
   assert.equal(parent.children.filter(item=>item.id===`read-${role}`).length,1);
   assert.ok(emitted.some(item=>item.type==='workflow_event' && item.event.type==='tool_finished' && item.event.agent===role));
   const saved=emitted.find(item=>item.type==='workflow_event' && item.event.type==='agent_finished' && item.event.agent===role);
   assert.match(saved.event.output,/Completed and saved:/);
   assert.ok(saved.event.artifactRefs[0].startsWith('runs/project/'));
   const file=saved.event.artifactRefs[0].replace('runs/project/','');
   assert.ok((await readFile(join(root,'runs/project',file),'utf8')).length>0);

 }
 const imageUpdates=emitted.filter(item=>item.type==='workflow_event' && item.event.type==='agent_progress' && item.event.imageItems);
 assert.ok(imageUpdates.some(item=>Object.values(item.event.imageItems).some(image=>image.state==='generating')));
 const savedImages=imageUpdates.at(-1).event.imageItems;
 assert.equal(Object.values(savedImages).filter(image=>image.ok).length,2);
 assert.ok(Object.values(savedImages).every(image=>image.durationMs>=1000 && image.reused===false));
 const imageToolFinish=emitted.findIndex(item=>item.type==='workflow_event' && item.event.type==='tool_finished' && item.event.toolName==='image_generate');
 assert.ok(emitted.findIndex(item=>item.type==='workflow_event' && item.event.imageItems && Object.values(item.event.imageItems).some(image=>image.ok))<imageToolFinish);
 const count=calls.length;
 await runDesign({...options,text:'继续完成'}); assert.equal(calls.length,count);
 assert.equal(emitted.filter(item=>item.type==='workflow_event' && item.event.type==='project_completed').length,1,'completed resume must not emit duplicate summaries');
 const checkpointPath=join(root,'runs/project/pipeline-state.json');
 const checkpoint=JSON.parse(await readFile(checkpointPath,'utf8'));
 // Simulate an older successful checkpoint made before the delivery-policy update.
 const {setting}=await import('../dist/design-pipeline.js');
 const {createHash}=await import('node:crypto');const hash=value=>createHash('sha256').update(value).digest('hex');
 const oldInstruction=await readFile(join(root,'apps/server/prompts/orchestrator.md'),'utf8');
 const legacyValues=[checkpoint.request,hash(JSON.stringify([])),[],oldInstruction,...['DREAMATIC_MODEL_ORCHESTRATOR','DREAMATIC_MODEL','DREAMATIC_BASE_URL','DREAMATIC_MODEL_CAPABILITIES','DREAMATIC_IMAGE_MODEL','DREAMATIC_IMAGE_BASE_URL','DREAMATIC_IMAGE_DEFAULT_SIZE','DREAMATIC_IMAGE_CAPABILITIES','DREAMATIC_PROVIDER_TYPE','DREAMATIC_THINKING_LEVEL_ORCHESTRATOR'].map(setting)];
 checkpoint.completed.orchestrator=hash(hash(JSON.stringify(legacyValues))+await readFile(join(root,'runs/project/intent.md'),'utf8'));
 for(const role of ['orchestrator','researcher','designer','builder']) {
   const path=join(root,'apps/server/prompts',`${role}.md`);
   await writeFile(path,(await readFile(path,'utf8'))+'\nMaintenance: Dreamatic handles persistence.\n');
 }

 // Simulate the old citation failure: complete saved draft, no Designer/Builder checkpoint.
 delete checkpoint.completed.designer;delete checkpoint.completed.builder;
 await writeFile(checkpointPath,JSON.stringify(checkpoint));
 await rm(join(root,'runs/project/design.md'));
 const beforeRecovery=calls.length;
 await runDesign({...options,text:'继续完成'});
 assert.ok(!calls.slice(beforeRecovery).some(role=>['orchestrator','researcher','designer'].includes(role)),'prompt maintenance and legacy checkpoint migration must reuse valid upstream stages and draft');
 assert.ok(JSON.parse(await readFile(checkpointPath,'utf8')).completed.orchestrator.startsWith('v2:'));
 assert.equal(await readFile(join(root,'runs/project/design.md'),'utf8'),originalDesign,'resume must preserve the exact design and two planned images');
 assert.ok(emitted.some(item=>item.type==='workflow_event' && item.event.type==='agent_finished' && item.event.agent==='designer' && item.event.output.includes('revalidated draft') && item.event.output.includes('Citation note:')));


 assert.ok((await readFile(join(root,'runs/project/design.md'),'utf8')).includes('## Image: hero'));
 const interrupted=JSON.parse(await readFile(checkpointPath,'utf8'));
 delete interrupted.completed.designer;delete interrupted.completed.builder;
 await writeFile(checkpointPath,JSON.stringify(interrupted));
 await rm(join(root,'runs/project/.design-draft.json'));
 const beforeDesigner=calls.length;
 await runDesign({...options,text:'继续完成'});
 assert.equal(calls[beforeDesigner],'designer','unfinished Designer must resume directly after prompt maintenance');
 assert.ok(!calls.slice(beforeDesigner).some(role=>role==='orchestrator'||role==='researcher'));


 // A typo in a saved Builder draft is repaired locally without any new model calls.
 const localCount=calls.length, generatedCount=imageRequests;
 let retryCheckpoint=JSON.parse(await readFile(checkpointPath,'utf8'));delete retryCheckpoint.completed.builder;
 await writeFile(checkpointPath,JSON.stringify(retryCheckpoint));
 const generated=JSON.parse(await readFile(join(root,'runs/project/artifacts/generated.json'),'utf8'));
 const rawBuilder=JSON.parse(await readFile(join(root,'runs/project/.builder-output.json'),'utf8'));
 const expected='../'+generated.hero.path, typo=expected.replace(/([a-f0-9]{12})(\.png)$/,(_,hash,extension)=>hash.slice(0,8)+hash.slice(9)+extension);
 rawBuilder.text=rawBuilder.text.replace('dreamatic-image:hero',typo);
 await writeFile(join(root,'runs/project/.builder-output.json'),JSON.stringify(rawBuilder));
 await runDesign({...options,text:'继续完成'});
 assert.equal(calls.length,localCount,'valid saved HTML and direction must not restart a model session');assert.equal(imageRequests,generatedCount);
 assert.match(await readFile(join(root,'runs/project/final/00-index.html'),'utf8'),new RegExp(generated.hero.path.replaceAll('.','\\.')));
 assert.equal(JSON.parse(await readFile(join(root,'runs/project/.builder-delivery.json'),'utf8')).repairs[0].from,typo);
 assert.equal(JSON.parse(await readFile(join(root,'runs/project/.builder-output.json'),'utf8')).text,rawBuilder.text,'raw model output is retained');
 // Without any matching saved direction, the plan gate remains mandatory.
 const beforeMissingPlan=calls.length;
 const savedPage=await readFile(join(root,'runs/project/final/00-index.html'),'utf8');
 retryCheckpoint=JSON.parse(await readFile(checkpointPath,'utf8'));delete retryCheckpoint.completed.builder;
 await writeFile(checkpointPath,JSON.stringify(retryCheckpoint));
 await rm(join(root,'runs/project/.builder-output.json'));await rm(join(root,'runs/project/.showcase-direction.json'));
 skipPlan=true;
 await assert.rejects(runDesign({...options,text:'继续完成'}),/Record the exhibition direction/);
 assert.equal(await readFile(join(root,'runs/project/final/00-index.html'),'utf8'),savedPage);
 skipPlan=false;
 await runDesign({...options,text:'继续完成'});
 assert.ok(calls.slice(beforeMissingPlan).every(role=>role==='builder'));
 assert.equal(imageRequests,generatedCount,'resume must reuse all matching generated images');
 assert.equal(JSON.parse(await readFile(join(root,'runs/project/run-state.json'),'utf8')).status,'completed');

 brokenReferences=true;
 const beforeAdvisory=emitted.length;
 await writeFile(join(root,'runs/project/research.md'),'# Changed evidence');
 await runDesign({...options,text:'继续完成'});
 assert.ok(calls.length>count);
 assert.ok(calls.slice(beforeRecovery).includes('researcher'));
 assert.equal(JSON.parse(await readFile(join(root,'runs/project/run-state.json'),'utf8')).status,'completed');
 assert.ok(!emitted.slice(beforeAdvisory).some(item=>item.type==='workflow_event' && item.event.type==='agent_interrupted'));
 const report=JSON.parse(await readFile(join(root,'runs/project/.citation-report.json'),'utf8'));
 assert.ok(report.researcher.issues.length && report.designer.issues.length);
 const advisoryDesign=await readFile(join(root,'runs/project/design.md'),'utf8');
 assert.match(advisoryDesign,/## Citation verification/);
 assert.match(advisoryDesign,/Unresolved evidence \[77\]/);
 assert.ok(emitted.slice(beforeAdvisory).some(item=>item.type==='workflow_event' && item.event.type==='agent_finished' && item.event.output.includes('workflow continues')));
 const advisoryCheckpoint=JSON.parse(await readFile(checkpointPath,'utf8'));
 delete advisoryCheckpoint.completed.designer;delete advisoryCheckpoint.completed.builder;
 await writeFile(checkpointPath,JSON.stringify(advisoryCheckpoint));
 await rm(join(root,'runs/project/design.md'));
 const callsBeforeAdvisoryRecovery=calls.length;
 await runDesign({...options,text:'继续完成'});
 assert.equal(calls.length,callsBeforeAdvisoryRecovery,'citation problems must not force model calls on draft recovery');
 assert.equal(await readFile(join(root,'runs/project/design.md'),'utf8'),advisoryDesign);
 const advisoryWorkflow=await workflowInventory(root,'project');
 assert.equal(advisoryWorkflow.filter(node=>node.id==='project-citations-designer').length,1);
 assert.equal(advisoryWorkflow.find(node=>node.id==='project-citations-designer').kind,'message');
 assert.match(advisoryWorkflow.find(node=>node.id==='project-citations-designer').detail,/workflow will continue/);
 assert.equal(JSON.parse(await readFile(join(root,'runs/project/run-state.json'),'utf8')).status,'completed');

 // An exhausted first image must not discard or prevent subsequent successful work.
 failHero=true;process.env.DREAMATIC_IMAGE_RETRY_ATTEMPTS='2';process.env.DREAMATIC_IMAGE_CONCURRENCY='1';
 const beforeImagePause=emitted.length;
 await runDesign({...options,runId:'image-retry',text:'Design another lamp'});
 const retryRoot=join(root,'runs/image-retry');
 const paused=JSON.parse(await readFile(join(retryRoot,'run-state.json'),'utf8'));
 assert.equal(paused.status,'waiting_for_images');assert.equal(heroFailureRequests,2);
 const receipt=JSON.parse(await readFile(join(retryRoot,'.image-generation-state.json'),'utf8'));
 assert.deepEqual(receipt.saved,['detail']);assert.deepEqual(receipt.missing,['hero']);
 assert.equal(receipt.failed[0].attempts,2);assert.equal(receipt.failed[0].error.code,'HTTP_502');
 const pauseEvents=emitted.slice(beforeImagePause).filter(item=>item.type==='workflow_event').map(item=>item.event);
 assert.ok(!pauseEvents.some(event=>event.type==='agent_interrupted'));
 assert.ok(!pauseEvents.some(event=>event.type==='tool_started'&&event.toolName==='plan_showcase'));
 assert.match(pauseEvents.find(event=>event.type==='agent_waiting').output,/1\/2 images saved/);
 const toolReceipt=pauseEvents.find(event=>event.type==='tool_finished'&&event.toolName==='image_generate');
 assert.equal(toolReceipt.isError,false);assert.match(toolReceipt.output,/HTTP_502/);assert.match(toolReceipt.output,/dreamatic-image:detail/);
 const pausedWorkflow=await workflowInventory(root,'image-retry');
 assert.equal(pausedWorkflow.find(node=>node.id==='image-retry-image-generation').kind,'message');
 assert.equal(pausedWorkflow.findLast(node=>node.agent==='builder').status,'waiting');
 assert.equal(pausedWorkflow.findLast(node=>node.agent==='builder').waitReason,'images');
 const beforeImageResume=calls.length,requestsBeforeResume=imageRequests,eventsBeforeImageResume=emitted.length;
 failHero=false;onlyMissingOnResume=true;
 await runDesign({...options,runId:'image-retry',text:'继续完成'});
 assert.ok(calls.slice(beforeImageResume).every(role=>role==='builder'));
 assert.equal(imageRequests,requestsBeforeResume+1,'only the missing image may call the provider');
 assert.ok(emitted.slice(eventsBeforeImageResume).some(item=>item.type==='workflow_event' && item.event.imageItems?.hero?.state==='generating' && item.event.imageItems?.detail?.state==='saved' && item.event.imageItems.detail.reused),'progress must show saved works even if the tool requests only missing ids');
 assert.equal(JSON.parse(await readFile(join(retryRoot,'run-state.json'),'utf8')).status,'completed');
 const resumedWorkflow=await workflowInventory(root,'image-retry');
 assert.equal(resumedWorkflow.filter(node=>node.id==='image-retry-image-generation').length,1);
 assert.match(resumedWorkflow.find(node=>node.id==='image-retry-image-generation').detail,/All 2 design images/);

});

test('IEEE citations reject missing entries and unresearched sources', async () => {
 const { validateCitations } = await import('../dist/design-pipeline.js');
 validateCitations('Original work', '');
 validateCitations('Material [1].\n## References\n[1] A. Author, "Title," 2026. https://example.org/source', 'https://example.org/source');
 assert.throws(()=>validateCitations('Material [2]', ''), /Missing IEEE/);
 assert.throws(()=>validateCitations('Material [1]\n## References\n[1] Unknown https://example.org/missing', ''), /traceable/);
});

test('optional metadata falls back to unverified budget and only accepted generation sizes enter cache', async t => {
 const root = await mkdtemp(join(tmpdir(),'dreamatic-optional-metadata-'));
 const old = {...process.env}; const original = globalThis.fetch;
 t.after(async()=>{process.env=old;globalThis.fetch=original;await rm(root,{recursive:true,force:true});});
 Object.assign(process.env,{DREAMATIC_CONFIG_DIR:root,DREAMATIC_IMAGE_MODEL:'metadata-free',DREAMATIC_IMAGE_CAPABILITIES:'',DREAMATIC_IMAGE_DEFAULT_SIZE:'768x512'});
 for (const response of [new Response(JSON.stringify({id:'metadata-free',object:'model'})),new Response('Not found',{status:404}),new Response('Unauthorized',{status:401}),new Response('<html>proxy error</html>'),new Response(JSON.stringify({supported_sizes:['bad']}))]) {
   globalThis.fetch=async()=>response;
   assert.deepEqual(await imageCapabilityInfo(),{sizes:['768x512'],source:'budget',verified:false});
   assert.deepEqual(await readdir(join(root,'cache/image-capabilities')),[]);
 }
 globalThis.fetch=async()=>{throw new TypeError('metadata unavailable');};
 assert.equal((await imageCapabilityInfo()).verified,false);
 await Promise.all([recordSuccessfulImageSize('768x512'),recordSuccessfulImageSize('512x768')]);
 let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('must use cache');};
 const info=await imageCapabilityInfo();
 assert.equal(calls,0);assert.equal(info.source,'generation');assert.equal(info.verified,true);
 assert.deepEqual(new Set(info.sizes),new Set(['768x512','512x768']));
 process.env.DREAMATIC_IMAGE_MODEL='another-model';
 assert.equal((await imageCapabilityInfo()).verified,false);
 const controller=new AbortController();controller.abort();
 await assert.rejects(imageCapabilityInfo(controller.signal),/abort/i);
});

test('references may appear between design sections with citations both before and after', async () => {
 const {validateCitations}=await import('../dist/design-pipeline.js');
 const refs='## References\n[1] Author. https://example.org/one\n[2] Author.\n https://example.org/two\n';
 const first='# Design\nConcept [1].\n',last='## Image: products\n### Introduction\nMaterials [2].\n';
 const research='https://example.org/one https://example.org/two';
 for (const doc of [refs+first+last,first+refs+last,first+last+refs]) validateCitations(doc,research);
 assert.deepEqual(validateCitations(first+refs+'## Uncited section',research).unusedReferences,[2]);
 assert.throws(()=>validateCitations(first+last+refs+'[2] Duplicate https://example.org/two',research),/Duplicate/);
});

test('IEEE adjacent, grouped and ranged citations are checked without counting reference definitions or code', async()=>{
 const {validateCitations}=await import('../dist/design-pipeline.js');
 const references='\n## References\n'+Array.from({length:5},(_,i)=>`[${i+1}] Author. https://example.org/${i+1}`).join('\n');
 const research=references;
 for (const citations of ['[1][2][3][4][5]','[1, 2, 3, 4, 5]','[1]–[5]','[1]-[5]','[1–3, 4, 5]','[1, 2-5]']) validateCitations('# Design\n'+citations+references,research);
 assert.throws(()=>validateCitations('[1]–[6]'+references,research),/Missing IEEE reference \[6\]/);
 assert.throws(()=>validateCitations('[5]–[1]'+references,research),/Invalid IEEE citation range/);
 assert.deepEqual(validateCitations('`[2]`\n```md\n[3]\n```\n[1]'+references,research).unusedReferences,[2,3,4,5]);
 assert.throws(()=>validateCitations('[0]'+references,research),/Invalid IEEE reference number/);
});

test('system saving publishes exact content atomically and preserves existing data on failure', async t=>{
 const {saveStageOutput}=await import('../dist/design-pipeline.js');
 const {readFile,writeFile,mkdir}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'dreamatic-save-output-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'research.md');
 await writeFile(path,'Prior valid report');
 await assert.rejects(saveStageOutput(path,''),/empty/);
 assert.equal(await readFile(path,'utf8'),'Prior valid report');
 const content='# Research\n\n完整研究报告\n';
 await saveStageOutput(path,content);
 assert.equal(await readFile(path,'utf8'),content);
 const directory=join(root,'design.md');await mkdir(directory);await writeFile(join(directory,'preserved'),'keep');
 await assert.rejects(saveStageOutput(directory,'New design'),/Failed to save/);
 assert.equal(await readFile(join(directory,'preserved'),'utf8'),'keep');
 assert.ok(!(await readdir(root)).some(name=>name.endsWith('.tmp')));
});

test('resume inputs ignore prompt maintenance but track request, attachments and upstream changes',async t=>{
 const {stageFingerprint}=await import('../dist/design-pipeline.js');
 const old={...process.env};t.after(()=>{process.env=old;});
 const baseline=stageFingerprint('researcher','Brief',[],['Intent'],'Original role instructions');
 assert.equal(stageFingerprint('researcher','Brief',[],['Intent'],'Updated save instructions'),baseline);
 assert.notEqual(stageFingerprint('researcher','New brief',[],['Intent'],'Original role instructions'),baseline);
 assert.notEqual(stageFingerprint('researcher','Brief',[{data:'new',mimeType:'image/png'}],['Intent'],'Original role instructions'),baseline);
 assert.notEqual(stageFingerprint('researcher','Brief',[],['New intent'],'Original role instructions'),baseline);
 const design=stageFingerprint('designer','Brief',[],['Intent','Research'],'Role');
 process.env.DREAMATIC_IMAGE_DEFAULT_SIZE='512x512';
 assert.equal(stageFingerprint('researcher','Brief',[],['Intent'],'Role'),baseline,'image budget changes should not repeat research');
 assert.notEqual(stageFingerprint('designer','Brief',[],['Intent','Research'],'Role'),design);
});
