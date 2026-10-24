import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';
import { browserExecutable } from '../../../scripts/browser-executable.mjs';

test('canvas accepts project media drops, preserves duplicate instances, edits geometry and restores saved content', {timeout:60000}, async t => {
  const executablePath=await browserExecutable();if(!executablePath){t.skip('Chromium unavailable');return;}
  const root=fileURLToPath(new URL('..',import.meta.url));
  const canvas=fileURLToPath(new URL('../src/components/Canvas.tsx',import.meta.url));
  const list=fileURLToPath(new URL('../src/components/WorkspaceFileList.tsx',import.meta.url));
  const entry='virtual:canvas-media';
  const bundle=await build({root,configFile:false,logLevel:'silent',esbuild:{jsx:'automatic'},plugins:[{name:'fixture',resolveId(id){if(id===entry)return entry},load(id){if(id===entry)return `import React from 'react';import{createRoot}from'react-dom/client';import{Canvas}from ${JSON.stringify(canvas)};import{WorkspaceFileList}from ${JSON.stringify(list)};function Fixture(){const[runId,setRunId]=React.useState('A'),[selected,setSelected]=React.useState(),[request,setRequest]=React.useState(),[visible,setVisible]=React.useState(true);window.selectProject=setRunId;window.hideCanvas=()=>setVisible(false);window.showCanvas=()=>setVisible(true);const files=window.fixtureFiles;return React.createElement('div',{style:{display:'grid',gridTemplateColumns:'320px 1fr',height:'100vh'}},React.createElement(WorkspaceFileList,{runId,files,selected: selected?.id,title:'Asset library',loading:false,canvasMode:true,onSelect:setSelected,onAdd:file=>setRequest({runId,fileId:file.id,nonce:crypto.randomUUID()}),onRetry(){}}),React.createElement('div',{className:'canvas-container',hidden:!visible},React.createElement(Canvas,{key:runId,run:{id:runId,title:'Project '+runId},files,visible,addRequest:request?.runId===runId?request:undefined,onSelectFile:setSelected})));}createRoot(document.getElementById('root')).render(React.createElement(Fixture));`}}],build:{write:false,minify:false,rollupOptions:{input:entry}}});
  const js=bundle.output.find(item=>item.type==='chunk').code;
  const css=await readFile(new URL('../src/styles.css',import.meta.url),'utf8');
  const files=[
    {id:'inputs/user-assets/photo.png',path:'inputs/user-assets/photo.png',title:'Photo',kind:'png',category:'assets',group:'Uploaded files'},
    {id:'attachment:0',title:'Original upload',kind:'png',category:'assets',group:'Uploaded files'},
    {id:'inputs/user-assets/clip.webm',path:'inputs/user-assets/clip.webm',title:'Clip',kind:'webm',category:'assets',group:'Uploaded files'},
    {id:'paper.pdf',path:'paper.pdf',title:'Paper',kind:'pdf',category:'assets',group:'Uploaded files'},
  ];
  const saved=new Map([['A',{version:1,runId:'A',updatedAt:'',camera:{x:100,y:200,zoom:.5},elements:[
    {id:'group-other',kind:'group',text:'Project assets',x:40,y:40,width:1098,height:42},
    {id:'group-generated',kind:'group',text:'Design development',x:40,y:40,width:1098,height:42},
    {id:'asset-runs/A/inputs/user-assets/photo.png',kind:'image',assetPath:'runs/A/inputs/user-assets/photo.png',x:40,y:100,width:350,height:280},
    {id:'canvas-overview-v3',kind:'text',text:'Old project overview',x:40,y:40,width:1098,height:172},
  ]}]]); const writes=[]; let failLoad=false,failSave=false;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  let clip;
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture');
    if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(js);return;}
    if(url.pathname==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
    const match=url.pathname.match(/^\/api\/runs\/([^/]+)\/canvas$/);
    if(match){res.setHeader('Content-Type','application/json');const id=match[1];
      if(req.method==='PUT'){let body='';for await(const part of req)body+=part;if(failSave){res.statusCode=500;res.end('{"error":"Disk unavailable"}');return;}const state=JSON.parse(body);writes.push(state);saved.set(id,state);res.end(body);return;}
      if(failLoad){res.statusCode=500;res.end('{"error":"Read failed"}');return;}res.end(JSON.stringify(saved.get(id)??null));return;}
    if(url.pathname.endsWith('.webm')||url.searchParams.get('id')?.endsWith('.webm')){res.setHeader('Content-Type','video/webm');res.end(clip??Buffer.alloc(0));return;}
    if(url.pathname.startsWith('/assets/')||url.pathname.endsWith('/files/content')){res.setHeader('Content-Type','image/png');res.end(png);return;}
    res.setHeader('Content-Type','text/html');res.end(`<html><link rel="stylesheet" href="/style.css"><div id="root"></div><script>window.fixtureFiles=${JSON.stringify(files)}</script><script type="module" src="/bundle.js"></script></html>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
  const{chromium}=await import('playwright-core');const browser=await chromium.launch({executablePath,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1400,height:960}});page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  // Generate a real, tiny playable video locally without third-party fixtures.
  const bytes=await page.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const context=canvas.getContext('2d');const stream=canvas.captureStream(10),recorder=new MediaRecorder(stream,{mimeType:'video/webm'}),chunks=[];const done=new Promise(resolve=>{recorder.ondataavailable=e=>chunks.push(e.data);recorder.onstop=async()=>resolve([...new Uint8Array(await new Blob(chunks).arrayBuffer())])});recorder.start();context.fillStyle='#c9e46b';context.fillRect(0,0,160,90);await new Promise(resolve=>setTimeout(resolve,300));context.fillStyle='#d76942';context.fillRect(20,20,60,30);await new Promise(resolve=>setTimeout(resolve,300));recorder.stop();stream.getTracks().forEach(track=>track.stop());return done;});clip=Buffer.from(bytes);
  const area=page.getByRole('region',{name:'Canvas editing area'});
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Zoom in"]').disabled);
  assert.equal(await page.locator('.canvas-world, .canvas-empty-state, .canvas-group-label').count(),0);
  assert.equal(await page.getByText('Project assets',{exact:true}).count(),0);
  assert.match(await area.evaluate(node=>getComputedStyle(node).backgroundImage),/rgb\(184, 188, 180\)/);
  assert.equal(await page.locator('.canvas-artboard').count(),0); assert.equal(writes.length,0,'loading a new board must not automatically add or save assets');
  const row=name=>page.locator('.workspace-file-item').filter({has:page.getByText(name,{exact:true})});
  assert.equal(await row('Paper').getAttribute('draggable'),'false');assert.equal(await row('Photo').getAttribute('draggable'),'true');
  const box=await area.boundingBox();
  await row('Photo').dragTo(area,{targetPosition:{x:190,y:150}});
  await page.locator('.canvas-artboard').waitFor();
  let card=page.locator('.canvas-artboard').first();
  const x=parseFloat(await card.evaluate(node=>node.style.left)),y=parseFloat(await card.evaluate(node=>node.style.top));
  assert.ok(Math.abs(x-(190-72)/.78)<2);assert.ok(Math.abs(y-(150-72)/.78)<2);
  const firstId=await card.getAttribute('data-element-id');
  await row('Photo').dragTo(area,{targetPosition:{x:530,y:150}});
  assert.equal(await page.locator('.canvas-artboard').count(),2);assert.notEqual(await page.locator('.canvas-artboard').last().getAttribute('data-element-id'),firstId);
  assert.equal(await page.locator('.canvas-artboard.selected').count(),1);
  await page.getByRole('button',{name:'Add to canvas: Original upload',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.canvas-artboard').length===3);assert.equal(await page.locator('.canvas-artboard').count(),3);assert.match(await page.locator('.canvas-artboard.selected img').getAttribute('src'),/attachment%3A0/);
  await page.getByRole('button',{name:'Reflow project cards'}).click();await page.getByRole('button',{name:'Fit project'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.canvas-artboard').length===3);assert.equal(await page.locator('.canvas-artboard').count(),3);
  // Move one instance; the duplicate keeps its own geometry.
  card=page.locator(`[data-element-id="${firstId}"]`);const before=parseFloat(await card.evaluate(node=>node.style.left));
  const caption=await card.locator('figcaption').boundingBox();await page.mouse.move(caption.x+40,caption.y+15);await page.mouse.down();await page.mouse.move(caption.x+95,caption.y+45,{steps:5});await page.mouse.up();assert.ok(parseFloat(await card.evaluate(node=>node.style.left))>before);
  const grip=page.getByRole('button',{name:'Resize selected media'});const oldSize=await card.evaluate(node=>({w:parseFloat(node.style.width),h:parseFloat(node.style.height)}));const handle=await grip.boundingBox();
  await page.mouse.move(handle.x+7,handle.y+7);await page.mouse.down();await page.mouse.move(handle.x+50,handle.y+45,{steps:5});await page.mouse.up();
  const newSize=await card.evaluate(node=>({w:parseFloat(node.style.width),h:parseFloat(node.style.height)}));assert.ok(newSize.w>oldSize.w);assert.ok(Math.abs(newSize.w/newSize.h-oldSize.w/oldSize.h)<.001);
  await page.getByRole('button',{name:'Add to canvas: Clip',exact:true}).click();await page.locator('video').waitFor();await page.locator('video').evaluate(video=>video.readyState>=1?undefined:new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('Video fixture failed to load'));setTimeout(()=>reject(new Error('Video fixture metadata timeout')),5000)}));
  assert.equal(await page.locator('video').getAttribute('controls'),'');
  await page.locator('video').evaluate(video=>video.play());assert.equal(await page.locator('video').evaluate(video=>video.paused),false);
  // Clicking native video controls must not initiate movement or panning.
  const cameraBefore=await page.locator('.canvas-world').getAttribute('style');const videoBox=await page.locator('video').boundingBox();await page.mouse.click(videoBox.x+20,videoBox.y+videoBox.height-20);assert.equal(await page.locator('.canvas-world').getAttribute('style'),cameraBefore);
  await page.getByRole('button',{name:'Reflow project cards'}).click();assert.equal(await page.locator('video').count(),1);assert.equal(await page.locator('.canvas-artboard').count(),4);
  await page.getByRole('button',{name:'Fit project'}).click();await page.screenshot({path:'/tmp/dreamatic-canvas-media.png',animations:'disabled'});
  await page.locator('video').evaluate(video=>video.play());
  await page.evaluate(()=>window.hideCanvas());assert.equal(await page.locator('video').evaluate(video=>video.paused),true);await page.evaluate(()=>window.showCanvas());
  await page.waitForTimeout(900);assert.ok(saved.get('A').elements.some(item=>item.kind==='video'&&item.fileId===files[2].id));
  const count=saved.get('A').elements.length;await page.reload();await page.locator('video').waitFor();assert.equal(await page.locator('.canvas-artboard').count(),count);
  // Invalid/cross-project/external drops cannot add items.
  async function fakeDrop(payload,type='application/x-dreamatic-project-media'){await area.evaluate((node,{payload,type})=>{const data=new DataTransfer();data.setData(type,JSON.stringify(payload));node.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientX:700,clientY:300}))},{payload,type});}
  for(const payload of [{runId:'B',fileId:files[0].id},{runId:'A',fileId:'paper.pdf'},{runId:'A',fileId:'../secret.png'}])await fakeDrop(payload);
  assert.equal(await page.locator('.canvas-artboard').count(),count);
  // Add under another zoom and verify world-space drop coordinates.
  await page.getByRole('button',{name:'Reset to 100%'}).click();const style=await page.locator('.canvas-world').getAttribute('style');const transform=style.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/);const cameraX=Number(transform[1]),cameraY=Number(transform[2]);
  await row('Photo').dragTo(area,{targetPosition:{x:400,y:250}});const added=page.locator('.canvas-artboard.selected');assert.ok(Math.abs(parseFloat(await added.evaluate(node=>node.style.left))-(400-cameraX))<2);assert.ok(Math.abs(parseFloat(await added.evaluate(node=>node.style.top))-(250-cameraY))<2);
  await page.getByRole('button',{name:'Remove selected element'}).click();assert.equal(await page.locator('.canvas-artboard').count(),count);
  // Immediate project switches flush the latest board, and a fresh project stays empty.
  await page.getByRole('button',{name:'Add to canvas: Photo',exact:true}).click();await page.waitForFunction(count=>document.querySelectorAll('.canvas-artboard').length===count+1,count);await page.evaluate(()=>window.selectProject('B'));await page.waitForFunction(()=>!document.querySelector('[aria-label="Zoom in"]').disabled);
  await page.waitForTimeout(150);assert.equal(saved.get('A').elements.length,count+1);
  assert.equal(await page.locator('.canvas-artboard').count(),0);
  failLoad=true;await page.evaluate(()=>window.selectProject('C'));await page.getByText('Could not restore the canvas. Retry before editing.').waitFor();await page.waitForTimeout(750);assert.equal(saved.has('C'),false);
  failLoad=false;await page.getByRole('button',{name:'Retry',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[aria-label="Zoom in"]').disabled);
  failSave=true;await page.getByRole('button',{name:'Add to canvas: Photo',exact:true}).click();await page.getByText('Could not save the canvas. Please retry.').waitFor();failSave=false;await page.getByRole('button',{name:'Retry',exact:true}).click();await page.waitForTimeout(150);assert.ok(saved.has('C'));
  const dots=page.getByRole('button',{name:'Positioning dots',exact:true}),grid=page.getByRole('button',{name:'Grid lines',exact:true});
  assert.equal(await dots.getAttribute('aria-pressed'),'true');assert.equal(await grid.getAttribute('aria-pressed'),'false');
  const originalSpacing=await area.evaluate(node=>parseFloat(node.style.backgroundSize));
  await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  const zoomedSpacing=await area.evaluate(node=>parseFloat(node.style.backgroundSize));assert.ok(zoomedSpacing>originalSpacing);
  await grid.click();assert.equal(await grid.getAttribute('aria-pressed'),'true');
  assert.equal(await area.evaluate(node=>(node.style.backgroundImage.match(/gradient/g)||[]).length),3);
  const readPosition=()=>area.evaluate(node=>node.style.backgroundPosition.split(',').map(layer=>layer.trim().split(' ').map(parseFloat)));
  const beforePan=await readPosition();
  await page.getByRole('button',{name:'Pan canvas',exact:true}).click();
  const panBox=await area.boundingBox();await page.mouse.move(panBox.x+20,panBox.y+20);await page.mouse.down();await page.mouse.move(panBox.x+77,panBox.y+63,{steps:5});await page.mouse.up();
  const afterPan=await readPosition();
  afterPan.forEach((layer,index)=>{assert.ok(Math.abs(layer[0]-beforePan[index][0]-57)<.1);assert.ok(Math.abs(layer[1]-beforePan[index][1]-43)<.1);});
  // Grid intersections and dots at world origin remain aligned with the camera.
  const worldStyle=await page.locator('.canvas-world').getAttribute('style');const guideCamera=worldStyle.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/);
  const originX=Number(guideCamera[1]),originY=Number(guideCamera[2]),zoom=Number(guideCamera[3]);
  assert.ok(Math.abs(afterPan[0][0]+18*zoom/2-originX)<.1);assert.ok(Math.abs(afterPan[0][1]+18*zoom/2-originY)<.1);
  assert.ok(Math.abs(afterPan[1][0]+Math.max(.5,.75*zoom)/2-originX)<.1);
  await dots.click();assert.equal(await area.evaluate(node=>(node.style.backgroundImage.match(/gradient/g)||[]).length),2);
  await grid.click();assert.equal(await area.evaluate(node=>node.style.backgroundImage),'none');
  await dots.focus();await page.keyboard.press('Space');await grid.click();
  await page.screenshot({path:'/tmp/dreamatic-canvas-guides.png',animations:'disabled'});
  await page.waitForTimeout(800);await page.reload();await page.locator('.canvas-artboard').first().waitFor();
  assert.equal(await dots.getAttribute('aria-pressed'),'true');assert.equal(await grid.getAttribute('aria-pressed'),'true');
  await page.setViewportSize({width:680,height:844});
  const toolbarBox=await page.locator('.canvas-toolbar').boundingBox();const areaBox=await area.boundingBox();assert.ok(toolbarBox.x>=areaBox.x&&toolbarBox.x+toolbarBox.width<=areaBox.x+areaBox.width);
  assert.deepEqual(errors,[]);
});
