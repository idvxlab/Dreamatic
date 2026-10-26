import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {editProjectImage,imageEditSettings} from '../dist/image-edit.js';
import {projectFiles,projectFileContent} from '../dist/project-files.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
async function fixture(t,handler){
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-edit-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
 const root=join(workspace,'runs','demo');await mkdir(join(root,'artifacts'),{recursive:true});
 await writeFile(join(root,'artifacts/source.png'),png);await writeFile(join(root,'artifacts/showcase.html'),'<img src="source.png">');
 await writeFile(join(root,'attachments.json'),JSON.stringify([{name:'source.png',mimeType:'image/png',data:png.toString('base64')}]));
 const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const env={DREAMATIC_IMAGE_API_KEY:'fixture-key',DREAMATIC_IMAGE_BASE_URL:origin,DREAMATIC_IMAGE_MODEL:'generation-model',DREAMATIC_IMAGE_EDIT_MODEL:'edit-model',DREAMATIC_IMAGE_EDIT_SIZE:'auto',DREAMATIC_IMAGE_TIMEOUT_MS:'2000'};
 return {workspace,root,origin,env};
}
test('edits send original image multipart bytes and persist separate media with provenance',async t=>{
 let calls=0;
 const f=await fixture(t,async(req,res)=>{
  calls++;assert.equal(req.url,'/images/edits');assert.equal(req.headers.authorization,'Bearer fixture-key');
  assert.match(req.headers['content-type'],/^multipart\/form-data; boundary=/);
  const parts=[];for await(const part of req)parts.push(part);
  const form=await new Request('http://fixture',{method:'POST',headers:{'content-type':req.headers['content-type']},body:Buffer.concat(parts)}).formData();
  assert.equal(form.get('model'),'edit-model');assert.match(form.get('prompt'),/^Make the background blue\r?\n\r?\nOutput geometry:/);assert.equal(form.get('size'),'1x1');assert.equal(form.has('response_format'),false);
  assert.deepEqual(Buffer.from(await form.get('image').arrayBuffer()),png);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}],usage:{total_tokens:7}}));
 });
 for(const source of ['artifacts/source.png','attachment:0']){
  const result=await editProjectImage(f.workspace,'demo',source,' Make the background blue ',new AbortController().signal,f.env);
  assert.notEqual(result.id,source);assert.match(result.path,/^inputs\/user-assets\/.+-edit-.+\.png$/);
  assert.deepEqual((await projectFileContent(f.workspace,'demo',result.id)).data,png);
 }
 assert.equal(calls,2);assert.deepEqual(await readFile(join(f.root,'artifacts/source.png')),png);
 assert.equal(await readFile(join(f.root,'artifacts/showcase.html'),'utf8'),'<img src="source.png">');
 const records=await readdir(join(f.root,'inputs/media-edits'));assert.equal(records.length,2);
 const record=JSON.parse(await readFile(join(f.root,'inputs/media-edits',records[0]),'utf8'));
 assert.equal(record.model,'edit-model');assert.equal(record.prompt,'Make the background blue');assert.equal(record.usage.total_tokens,7);
 assert.equal((await projectFiles(f.workspace,'demo')).filter(file=>file.id.startsWith('inputs/media-edits')).length,0);
 assert.deepEqual(imageEditSettings(f.env),{enabled:true,configured:true,model:'edit-model',size:'auto',capabilities:undefined});
 assert.ok(!JSON.stringify(record).includes('fixture-key'));
});
test('edit validation, provider failures, invalid outputs and cancellation preserve source assets',async t=>{
 let calls=0,mode='error',entered;
 const f=await fixture(t,(req,res)=>{calls++;entered?.();if(mode==='hang')return;if(mode==='invalid'){res.end(JSON.stringify({data:[{b64_json:Buffer.from('<html>not image</html>').toString('base64')}]}));return;}res.writeHead(400);res.end('secret details fixture-key');});
 const edit=(id,prompt='Change background',env=f.env,signal=new AbortController().signal)=>editProjectImage(f.workspace,'demo',id,prompt,signal,env);
 await assert.rejects(edit('artifacts/source.png',''),/prompt/);
 await assert.rejects(edit('../outside.png'),/supports project/);
 await assert.rejects(edit('artifacts/showcase.html'),/supports project/);
 await assert.rejects(edit('artifacts/source.png','Change',{...f.env,DREAMATIC_IMAGE_EDIT_ENABLED:'false'}),/disabled/);
 await assert.rejects(edit('artifacts/source.png','Change',{...f.env,DREAMATIC_IMAGE_API_KEY:''}),/API key/);
 assert.equal(calls,0);
 await assert.rejects(edit('artifacts/source.png'),error=>error.message.includes('HTTP 400')&&!error.message.includes('fixture-key'));
 mode='invalid';await assert.rejects(edit('artifacts/source.png'),/invalid image/);
 mode='hang';const controller=new AbortController();let started;const gate=new Promise(resolve=>{started=resolve});entered=started;
 const pending=edit('artifacts/source.png','Change',f.env,controller.signal);await gate;
 await assert.rejects(edit('artifacts/source.png'),/already being edited/);
 controller.abort();await assert.rejects(pending,error=>error.name==='AbortError');
 assert.equal((await readdir(join(f.root,'inputs/user-assets'))).length,0);
 assert.deepEqual(await readFile(join(f.root,'artifacts/source.png')),png);
});
test('output directory symlinks are rejected before contacting the edit provider',async t=>{
 let calls=0;const f=await fixture(t,()=>calls++);
 await mkdir(join(f.root,'inputs'));await symlink(join(f.root,'artifacts'),join(f.root,'inputs/user-assets'));
 await assert.rejects(editProjectImage(f.workspace,'demo','artifacts/source.png','Change',new AbortController().signal,f.env),/Invalid media directory/);
 assert.equal(calls,0);
});

test('HTTP edit routes expose safe settings and return a catalogued image without rewriting the source',{timeout:20000},async t=>{
 const {fork}=await import('node:child_process');const {once}=await import('node:events');const {resolve}=await import('node:path');
 const f=await fixture(t,(req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));});
 await writeFile(join(f.workspace,'.env'),'PORT=0\nDREAMATIC_PREVENT_IDLE_SLEEP=false\n');
 const child=fork(resolve('apps/server/dist/index.js'),[],{cwd:f.workspace,env:{...process.env,...f.env,DREAMATIC_CONFIG_DIR:f.workspace,DREAMATIC_WORKSPACE:f.workspace,DREAMATIC_DESKTOP:'1',PI_CODING_AGENT_DIR:join(f.workspace,'pi')},stdio:['ignore','pipe','pipe','ipc']});
 child.stdout.resume();child.stderr.resume();t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');const force=setTimeout(()=>child.kill('SIGKILL'),1000);child.kill();await exited;clearTimeout(force);}});
 const [ready]=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error('Server exited before ready')}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Startup timeout')),10000).unref())]);
 const endpoint=`http://127.0.0.1:${ready.port}/api/runs/demo/media/edit`;
 const settings=await fetch(endpoint).then(response=>response.json());assert.equal(settings.model,'edit-model');assert.ok(!JSON.stringify(settings).includes('fixture-key'));
 const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'artifacts/source.png',prompt:'Use warmer colors'})});
 assert.equal(response.status,201);const result=await response.json();
 const content=await fetch(`http://127.0.0.1:${ready.port}/api/runs/demo/files/content?id=${encodeURIComponent(result.id)}`);
 assert.equal(content.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await content.arrayBuffer()),png);
 assert.deepEqual(await readFile(join(f.root,'artifacts/source.png')),png);
 assert.equal((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'../source.png',prompt:'Change'})})).status,400);
});

test('edits preserve original pixel dimensions despite global settings, retain changed outputs, and honor explicit user resize', async t => {
 const {deflateSync}=await import('node:zlib');
 // Real PNG fixtures with valid CRCs and compressed scanlines.
 function image(width,height) {
  function chunk(type,data) {const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const value of body){crc^=value;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const header=Buffer.alloc(4),tail=Buffer.alloc(4);header.writeUInt32BE(data.length);tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([header,body,tail]);}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.alloc((width*4+1)*height))),chunk('IEND',Buffer.alloc(0))]);
 }
 const original=image(320,180), resized=image(640,360);let output=original;const requests=[];
 const f=await fixture(t,async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const form=await new Request('http://fixture',{method:'POST',headers:{'content-type':req.headers['content-type']},body:Buffer.concat(chunks)}).formData();requests.push({size:form.get('size'),prompt:form.get('prompt')});
  res.end(JSON.stringify({data:[{b64_json:output.toString('base64')}]}));
 });
 await writeFile(join(f.root,'artifacts/source.png'),original);
 await writeFile(join(f.root,'artifacts/second.png'),image(180,320));
 const env={...f.env,DREAMATIC_IMAGE_EDIT_SIZE:'1024x1024',DREAMATIC_IMAGE_DEFAULT_SIZE:'2048x2048'};
 const edit=(ids,prompt,provenance)=>editProjectImage(f.workspace,'demo',ids,prompt,new AbortController().signal,env,provenance);
 const first=await edit('artifacts/source.png','Make the background blue');assert.equal(first.editSize,'320x180');assert.equal(requests[0].size,'320x180');
 const fused=await edit(['artifacts/source.png','artifacts/second.png'],'Combine both images');assert.equal(fused.editSize,'320x180');
 output=image(180,320);
 const secondBase=await edit(['artifacts/source.png','artifacts/second.png'],'以图二为底图，参考图一的配色');
 assert.equal(secondBase.editSize,'180x320');assert.equal(secondBase.baseImageId,'artifacts/second.png');assert.equal(secondBase.sizeSource,'base-image');
 assert.match(requests.at(-1).prompt,/generate at 180x320/);
 const baseRecord=JSON.parse(await readFile(join(f.root,'inputs/media-edits',`${secondBase.editId}.json`),'utf8'));
 assert.equal(baseRecord.baseImageMethod,'explicit');assert.equal(baseRecord.sourceId,'artifacts/second.png');assert.deepEqual(baseRecord.outputDimensions,{width:180,height:320});
 const inferred=await edit(['artifacts/source.png','artifacts/second.png'],'保留图二的构图，融合图一的元素');assert.equal(inferred.editSize,'180x320');assert.equal(inferred.baseImageMethod,'inferred');
 const reordered=await edit(['artifacts/second.png','artifacts/source.png'],'以图二为底图',{taskId:'reordered',attempt:1,inputOrdinals:[2,1]});assert.equal(reordered.baseImageId,'artifacts/second.png');
 assert.match(requests.at(-1).prompt,/Input image 1: Image 2; material artifacts\/second.png/);
 assert.equal((await edit(['artifacts/source.png','artifacts/second.png'],'融合两张图')).dimensionStatus,'different-ratio');
 output=original;
 assert.equal((await edit(['artifacts/source.png','artifacts/second.png'],'以图二为底图')).dimensionStatus,'different-ratio');
 // Use the user's original reference, even if an agent rewrites it to a different base.
 const originalBase=await edit(['artifacts/source.png','artifacts/second.png'],'以图二为底图',{taskId:'base-rewrite',attempt:1,originalPrompt:'以图一为底图'});assert.equal(originalBase.baseImageId,'artifacts/source.png');
 output=resized;
 const overridden=await edit(['artifacts/source.png','artifacts/second.png'],'以图二为底图，输出尺寸640x360');assert.equal(overridden.sizeSource,'user');assert.equal(overridden.editSize,'640x360');

 output=resized;
 const count=(await readdir(join(f.root,'inputs/user-assets'))).length;
 assert.equal((await edit('artifacts/source.png','Make the background green')).dimensionStatus,'same-ratio');
 assert.equal((await readdir(join(f.root,'inputs/user-assets'))).length,count+1);
 // Rewritten agent instructions cannot authorize resizing on behalf of the user.
 assert.equal((await edit('artifacts/source.png','Resize the image to 640x360',{taskId:'rewrite',attempt:1,originalPrompt:'Change the background'})).dimensionStatus,'same-ratio');
 const changed=await edit('artifacts/source.png','请把图片尺寸改为640×360');assert.equal(changed.editSize,'640x360');assert.equal(requests.at(-1).size,'640x360');
 const record=JSON.parse(await readFile(join(f.root,'inputs/media-edits',`${changed.editId}.json`),'utf8'));
 assert.equal(record.sizeMode,'resize');assert.deepEqual(record.sourceDimensions,[{width:320,height:180}]);assert.deepEqual(record.outputDimensions,{width:640,height:360});
 assert.equal((await edit('artifacts/source.png','Resize the image to 800x600')).dimensionStatus,'different-ratio');
 assert.deepEqual(await readFile(join(f.root,'artifacts/source.png')),original);
});

test('generation enforces size confirmations before provider calls and retains adapted outputs',async t=>{
 let calls=0;const f=await fixture(t,(req,res)=>{calls++;res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));});
 const env={...f.env,DREAMATIC_IMAGE_EDIT_CAPABILITIES:'{"sizes":["16x16"],"step":16}'};
 const edit=(prompt,sizeOptions)=>editProjectImage(f.workspace,'demo','artifacts/source.png',prompt,new AbortController().signal,env,{taskId:'confirmation',attempt:1,sizeOptions});
 await assert.rejects(edit('Change background',{}),/Review and accept/);assert.equal(calls,0);
 await assert.rejects(edit('Output 32x32',{acceptAdaptation:true}),/conflicts/);assert.equal(calls,0);
 const result=await edit('Output 32x32',{confirmConflict:true,acceptAdaptation:true});assert.equal(calls,1);
 assert.equal(result.requestSize,'16x16');assert.deepEqual(result.targetDimensions,{width:1,height:1});assert.equal(result.dimensionStatus,'exact');
 const record=JSON.parse(await readFile(join(f.root,'inputs/media-edits',result.editId+'.json'),'utf8'));assert.equal(record.requestSize,'16x16');assert.equal(record.sizeOptions.confirmConflict,true);
});
