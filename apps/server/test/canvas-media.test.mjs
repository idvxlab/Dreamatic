import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeCanvasState, readCanvasState, writeCanvasState } from '../dist/canvas-store.js';

test('video and uploaded attachment instances round-trip with independent geometry alongside historical canvas elements', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-canvas-media-')); t.after(() => rm(workspace, {recursive:true,force:true}));
  const elements = [
    { id:'video-1', kind:'video', fileId:'inputs/user-assets/clip.mp4', assetPath:'runs/A/inputs/user-assets/clip.mp4', text:'Clip', x:150,y:300,width:360,height:268 },
    { id:'video-2', kind:'video', fileId:'inputs/user-assets/clip.mp4', x:-100,y:0,width:720,height:536 },
    { id:'attachment', kind:'image', fileId:'attachment:0',text:'Upload',x:20,y:40,width:300,height:400 },
    { id:'legacy',kind:'image',assetPath:'runs/A/artifacts/work.png',x:1,y:2,width:350,height:280 },
    { id:'note',kind:'text',text:'Creative note',x:5,y:6,width:200,height:100 },
  ];
  await writeCanvasState(workspace,'A',{camera:{x:40,y:80,zoom:.6},elements});
  const restored = await readCanvasState(workspace,'A'); assert.deepEqual(restored.elements,elements); assert.equal(restored.camera.zoom,.6);
  const next = {...restored,elements:restored.elements.filter(item=>item.id!=='video-1')}; await writeCanvasState(workspace,'A',next);
  assert.equal((await readCanvasState(workspace,'A')).elements.filter(item=>item.kind==='video').length,1);
  assert.ok(JSON.parse(await readFile(join(workspace,'runs/A/canvas/canvas-state.json'),'utf8')).elements.some(item=>item.fileId==='attachment:0'));
  assert.equal(await readCanvasState(workspace,'B'),null);
  const normalized=normalizeCanvasState('A',{elements:[{id:'bad',kind:'video',width:Infinity,height:NaN,x:NaN,y:Infinity,fileId:'attachment:0'}]});
  assert.equal(normalized.elements[0].width,320);assert.equal(normalized.elements[0].x,0);
});


test('native media byte ranges support seeking, suffixes and reject invalid ranges', async () => {
  const { mediaRange } = await import('../dist/media-range.js');
  assert.deepEqual(mediaRange('bytes=2-5',10),{start:2,end:5});
  assert.deepEqual(mediaRange('bytes=5-',10),{start:5,end:9});
  assert.deepEqual(mediaRange('bytes=-3',10),{start:7,end:9});
  assert.deepEqual(mediaRange('bytes=2-99',10),{start:2,end:9});
  for (const value of ['bytes=20-','bytes=5-2','bytes=-0','bytes=-','bytes=0-2,5-9','other=1-2']) assert.equal(mediaRange(value,10),undefined);
});

test('canvas graph supports multi-input ports and rejects dangling, duplicate, same-kind and cyclic connections', async () => {
  const { validCanvasConnection } = await import('@dreamatic/project-data/canvas-graph');
  const nodes = ['a','b','out'].map(id => ({ id, kind:'image',fileId:`artifacts/${id}.png`, x:0,y:0,width:320,height:200 }));
  nodes.push({ id:'p', kind:'prompt',text:'Fuse',taskId:'fusion',x:400,y:0,width:320,height:240 });
  const edges = [{id:'a-p',source:'a',target:'p'},{id:'b-p',source:'b',target:'p'},{id:'p-out',source:'p',target:'out'}];
  assert.equal(validCanvasConnection(nodes, [], 'a','b'), false);
  assert.equal(validCanvasConnection(nodes, edges, 'a','p'), false);
  assert.equal(validCanvasConnection(nodes, edges, 'out','p'), false);
  const state=normalizeCanvasState('demo',{elements:nodes,edges:[...edges,{id:'duplicate',source:'a',target:'p'},{id:'bad',source:'missing',target:'p'},{id:'cycle',source:'out',target:'p'}],handledTaskIds:['fusion']});
  assert.deepEqual(state.edges,edges);assert.equal(state.elements[3].taskId,'fusion');assert.deepEqual(state.handledTaskIds,['fusion']);
});

test('corrupted canvas snapshots fail visibly instead of becoming empty saved boards', async t => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const workspace=await mkdtemp(join(tmpdir(),'dreamatic-canvas-corrupt-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  await mkdir(join(workspace,'runs/demo/canvas'),{recursive:true});
  await writeFile(join(workspace,'runs/demo/canvas/canvas-state.json'),'{broken');
  await assert.rejects(readCanvasState(workspace,'demo'),SyntaxError);
  assert.equal(await readFile(join(workspace,'runs/demo/canvas/canvas-state.json'),'utf8'),'{broken');
});
