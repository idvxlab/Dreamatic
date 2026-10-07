import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {publishProject,publicationStatus,normalizeCreator,publicationEndpoint} from '../dist/project-publish.js';
const exec=promisify(execFile);
async function fixture(t){const workspace=await mkdtemp(join(tmpdir(),'dreamatic-publish-test-'));t.after(()=>rm(workspace,{recursive:true,force:true}));const run=join(workspace,'runs','project-test');for(const [file,value]of Object.entries({'run-state.json':JSON.stringify({stages:{build:'completed'}}),'brief.json':'{"title":"Test publication"}','artifacts/artifact-manifest.json':'{"presentation":{"entry":"artifacts/home/index.html"}}','artifacts/home/index.html':'<h1>Public design</h1>'})){await mkdir(dirname(join(run,file)),{recursive:true});await writeFile(join(run,file),value)}return {workspace,run}}
test('publishing requires explicit consent and a secure configured destination; attribution cannot forge identity',async t=>{
 const f=await fixture(t);assert.equal(normalizeCreator({userId:'forged'}).name,'');assert.equal('userId' in normalizeCreator({userId:'forged'}),false);
 assert.throws(()=>publicationEndpoint('http://example.com'),/HTTPS/);assert.throws(()=>publicationEndpoint('https://user:password@example.com'),/HTTPS/);assert.throws(()=>publicationEndpoint(''),/Settings/);
 assert.equal(publicationEndpoint('http://127.0.0.1:3000').pathname,'/api/gallery/publish');
 await assert.rejects(publishProject(f.workspace,'project-test',{creator:{}},'https://example.com'),/Confirm/);
});
test('publishing sends a complete ZIP with optional creator information, validates receipt and cleans temporary files',async t=>{
 const f=await fixture(t),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});const initialTemps=new Set((await readdir(tmpdir())).filter(name=>name.startsWith("dreamatic-export-")));let calls=0;
 globalThis.fetch=async(url,init)=>{calls++;assert.equal(String(url),'https://www.dreamatic.art/api/gallery/publish');assert.equal(init.headers['Content-Type'],'application/zip');assert.equal(init.redirect,'error');const zip=join(f.workspace,'received.zip');await writeFile(zip,Buffer.from(await new Response(init.body).arrayBuffer()));const {stdout}=await exec('unzip',['-p',zip,'project-test/publication.json']);const metadata=JSON.parse(stdout);assert.equal(metadata.creator.name,'Artist');assert.equal(metadata.creator.userId,undefined);const {stdout:files}=await exec('unzip',['-Z1',zip]);assert.match(files,/project-test\/artifacts\/home\/index.html/);return new Response(JSON.stringify({projectId:'published-test',previewUrl:'/gallery-assets/published-test/artifacts/home/index.html',galleryUrl:'/#gallery'}),{status:201,headers:{'Content-Type':'application/json'}})};
 const result=await publishProject(f.workspace,'project-test',{confirmed:true,publicationId:randomUUID(),creator:{name:'Artist'}},'https://www.dreamatic.art/');assert.equal(result.galleryUrl,'https://www.dreamatic.art/#gallery');assert.equal(calls,1);
 for(const name of (await readdir(tmpdir())).filter(name=>name.startsWith('dreamatic-export-'))) assert.ok(initialTemps.has(name),'Publish must remove its temporary export directory');
 globalThis.fetch=async()=>new Response(JSON.stringify({error:'Storage unavailable'}),{status:503});
 await assert.rejects(publishProject(f.workspace,'project-test',{confirmed:true,overwriteConfirmed:true,creator:{}},'https://www.dreamatic.art/'),/Storage unavailable/);
 for(const name of (await readdir(tmpdir())).filter(name=>name.startsWith('dreamatic-export-'))) assert.ok(initialTemps.has(name),'Failed publish must remove its temporary export directory');
 await writeFile(join(f.run,'run-state.json'),'{"stages":{"build":"pending"}}');await assert.rejects(publishProject(f.workspace,'project-test',{confirmed:true,overwriteConfirmed:true,creator:{}},'https://www.dreamatic.art/'),/completed build/);
});

test('publication identity survives reopening, replacement requires consent, credentials stay private and progress blocks duplicate submissions',async t=>{
 const f=await fixture(t),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
 let finish;const gate=new Promise(resolve=>{finish=resolve});let started;const ready=new Promise(resolve=>{started=resolve});const sent=[];
 globalThis.fetch=async(_url,init)=>{
  const zip=join(f.workspace,`received-${sent.length}.zip`);await writeFile(zip,Buffer.from(await new Response(init.body).arrayBuffer()));
  const publication=JSON.parse((await exec('unzip',['-p',zip,'project-test/publication.json'])).stdout);const list=(await exec('unzip',['-Z1',zip])).stdout;
  assert.doesNotMatch(list,/publications.json|\.performance/);assert.equal(publication.updateToken,undefined);
  sent.push({publication,token:init.headers['X-Dreamatic-Publish-Token']});started();await gate;
  return new Response(JSON.stringify({projectId:'published-'+publication.publicationId,previewUrl:'/gallery-assets/p/artifacts/home/index.html',galleryUrl:'/#gallery'}),{status:201});
 };
 assert.equal((await publicationStatus(f.workspace,'project-test','https://www.dreamatic.art')).mayExist,false);
 const pending=publishProject(f.workspace,'project-test',{confirmed:true,creator:{name:'Artist'}},'https://www.dreamatic.art');await ready;
 const progress=await publicationStatus(f.workspace,'project-test','https://www.dreamatic.art');assert.equal(progress.inProgress,true);assert.equal(progress.progress.phase,'deploying');assert.equal(progress.progress.uploadedBytes,progress.progress.totalBytes);assert.equal('updateToken' in progress,false);
 await assert.rejects(publishProject(f.workspace,'project-test',{confirmed:true,overwriteConfirmed:true},'https://www.dreamatic.art'),/already being published/);
 finish();const receipt=await pending;const status=await publicationStatus(f.workspace,'project-test','https://www.dreamatic.art');assert.equal(status.published,true);assert.equal(status.receipt.projectId,receipt.projectId);
 await assert.rejects(publishProject(f.workspace,'project-test',{confirmed:true},'https://www.dreamatic.art'),/confirm replacement/);
 await writeFile(join(f.run,'artifacts/home/index.html'),'<h1>Revised design</h1>');
 await publishProject(f.workspace,'project-test',{confirmed:true,overwriteConfirmed:true,creator:{name:'Artist'}},'https://www.dreamatic.art/');assert.equal(sent.length,2);assert.equal(sent[1].publication.publicationId,sent[0].publication.publicationId);assert.equal(sent[1].token,sent[0].token);assert.equal(sent[1].publication.overwrite,true);
});

test('independent installations allocate distinct cryptographic identities despite identical client ids and run names',async t=>{
 const first=await fixture(t),second=await fixture(t),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});const supplied=randomUUID(),ids=[],tokens=[];
 globalThis.fetch=async(_url,init)=>{await new Response(init.body).arrayBuffer();tokens.push(init.headers['X-Dreamatic-Publish-Token']);return new Response(JSON.stringify({projectId:'published-test',previewUrl:'/gallery-assets/published-test/artifacts/home/index.html',galleryUrl:'/#gallery'}),{status:201})};
 for(const f of [first,second]){await publishProject(f.workspace,'project-test',{confirmed:true,publicationId:supplied},'https://www.dreamatic.art');const ledger=JSON.parse(await readFile(join(f.run,'.performance/publications.json'),'utf8'));ids.push(ledger['https://www.dreamatic.art'].publicationId)}
 assert.notEqual(ids[0],supplied);assert.notEqual(ids[1],supplied);assert.notEqual(ids[0],ids[1]);assert.notEqual(tokens[0],tokens[1]);for(const id of ids)assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('HTML UX deliveries cannot publish, including mixed projects with a gallery presentation',async t=>{
 const f=await fixture(t),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});globalThis.fetch=()=>{throw new Error('Network must not be reached')};
 for(const metadata of [{presentation:{mode:'html',entry:'artifacts/home/index.html'}},{presentation:{mode:'gallery'},htmlEntries:['artifacts/home/index.html']},{presentation:{mode:'gallery'},artifacts:[{method:'html_generate'}]}]){
 await writeFile(join(f.run,'artifacts/artifact-manifest.json'),JSON.stringify(metadata));await assert.rejects(publishProject(f.workspace,'project-test',{confirmed:true},'https://www.dreamatic.art'),/HTML UX\/UI projects cannot/);
 }
 assert.equal((await publicationStatus(f.workspace,'project-test','https://www.dreamatic.art')).mayExist,false);
});

test('local packaging failures do not imply publication and legacy identities are checked against the website',async t=>{
 const f=await fixture(t),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
 await writeFile(join(f.run,'run-state.json'),'{"stages":{"build":"pending"}}');
 await assert.rejects(publishProject(f.workspace,'project-test',{confirmed:true},'https://www.dreamatic.art'),/completed build/);
 assert.equal((await publicationStatus(f.workspace,'project-test','https://www.dreamatic.art')).mayExist,false);
 const ledgerPath=join(f.run,'.performance/publications.json'),ledger=JSON.parse(await readFile(ledgerPath,'utf8'));delete ledger['https://www.dreamatic.art'].deliveryAttempted;await writeFile(ledgerPath,JSON.stringify(ledger));
 globalThis.fetch=async url=>{assert.equal(String(url),'https://www.dreamatic.art/api/gallery');return new Response(JSON.stringify({projects:[{id:'published-another-project'}]}),{status:200})};
 assert.equal((await publicationStatus(f.workspace,'project-test','https://www.dreamatic.art')).mayExist,false);
 assert.equal(JSON.parse(await readFile(ledgerPath,'utf8'))['https://www.dreamatic.art'].deliveryAttempted,false);
});

test('publication fills missing historical model groups from current configuration only in the ZIP snapshot',async t=>{
 const f=await fixture(t),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
 const existing={schemaVersion:1,reasoning:[{model:'historic-reason',provider:'historic',source:'assistant_response'}],generation:[]};
 await writeFile(join(f.run,'artifacts/artifact-manifest.json'),JSON.stringify({presentation:{entry:'artifacts/home/index.html'},modelUsage:existing}));
 globalThis.fetch=async(_url,init)=>{
 const zip=join(f.workspace,'model.zip');await writeFile(zip,Buffer.from(await new Response(init.body).arrayBuffer()));
 const usage=JSON.parse((await exec('unzip',['-p',zip,'project-test/artifacts/model-usage.json'])).stdout);
 assert.equal(usage.reasoning[0].model,'historic-reason');assert.equal(usage.generation[0].model,'current-image');assert.equal(usage.generation[0].source,'publication_config_fallback');
 const html=(await exec('unzip',['-p',zip,'project-test/artifacts/home/index.html'])).stdout;assert.match(html,/historic-reason/);assert.match(html,/current-image/);
 assert.deepEqual(JSON.parse((await exec('unzip',['-p',zip,'project-test/plan/model-usage.json'])).stdout),usage);
 return new Response(JSON.stringify({projectId:'published-test',previewUrl:'/gallery-assets/published-test/artifacts/home/index.html',galleryUrl:'/#gallery'}),{status:201});
 };
 await publishProject(f.workspace,'project-test',{confirmed:true},'https://www.dreamatic.art',{DREAMATIC_MODEL:'current-reason',DREAMATIC_IMAGE_MODEL:'current-image'});
 assert.deepEqual(JSON.parse(await readFile(join(f.run,'artifacts/artifact-manifest.json'),'utf8')).modelUsage,existing);assert.equal(await readFile(join(f.run,'artifacts/home/index.html'),'utf8'),'<h1>Public design</h1>');
});

test('legacy projects without any models receive current default and Agent override models',async t=>{
 const f=await fixture(t),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});
 globalThis.fetch=async(_url,init)=>{const zip=join(f.workspace,'legacy.zip');await writeFile(zip,Buffer.from(await new Response(init.body).arrayBuffer()));const manifest=JSON.parse((await exec('unzip',['-p',zip,'project-test/artifacts/artifact-manifest.json'])).stdout);assert.equal(manifest.modelUsage.reasoning.find(item=>item.role==='designer').model,'designer-current');assert.equal(manifest.modelUsage.reasoning.find(item=>item.role==='builder').model,'reason-current');assert.equal(manifest.modelUsage.generation[0].model,'image-current');assert.ok(manifest.modelUsage.reasoning.every(item=>item.source==='publication_config_fallback'));return new Response(JSON.stringify({projectId:'published-test',previewUrl:'/gallery-assets/published-test/artifacts/home/index.html',galleryUrl:'/#gallery'}),{status:201})};
 await publishProject(f.workspace,'project-test',{confirmed:true},'https://www.dreamatic.art',{DREAMATIC_MODEL:'reason-current',DREAMATIC_MODEL_DESIGNER:'designer-current',DREAMATIC_IMAGE_MODEL:'image-current'});
});

test('manual website deletion clears stale successful or uncertain publication status',async t=>{
 const f=await fixture(t),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});const dir=join(f.run,'.performance');await mkdir(dir,{recursive:true});const file=join(dir,'publications.json');
 for(const receipt of [undefined,{projectId:'published-old',previewUrl:'https://www.dreamatic.art/gallery-assets/old/a.html',galleryUrl:'https://www.dreamatic.art/#gallery'}]){
 await writeFile(file,JSON.stringify({'https://www.dreamatic.art':{publicationId:randomUUID(),updateToken:'a'.repeat(64),deliveryAttempted:true,...(receipt?{receipt,publishedAt:'2026-01-01'}:{})}}));
 globalThis.fetch=async()=>new Response(JSON.stringify({projects:[]}),{status:200});const status=await publicationStatus(f.workspace,'project-test','https://www.dreamatic.art');assert.equal(status.published,false);assert.equal(status.mayExist,false);assert.equal(status.receipt,undefined);
 }
});
test('rate-limit rejection does not mark a new project as possibly published',async t=>{
 const f=await fixture(t),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});globalThis.fetch=async(_url,init)=>{await new Response(init.body).arrayBuffer();return new Response(JSON.stringify({error:'Publication limit reached; try again later'}),{status:429})};await assert.rejects(publishProject(f.workspace,'project-test',{confirmed:true},'https://www.dreamatic.art'),/Publication limit/);assert.equal((await publicationStatus(f.workspace,'project-test','https://www.dreamatic.art')).mayExist,false);
});
