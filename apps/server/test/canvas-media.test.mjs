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
