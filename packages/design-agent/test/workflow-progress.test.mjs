import test from 'node:test';import assert from 'node:assert/strict';import {imageProgress} from '../dist/workflow-progress.js';
test('image receipts count successful and failed items separately, deduplicate updates and exclude unsafe paths',()=>{
 let state=imageProgress(undefined,{total:3});assert.deepEqual(state,{total:3,items:{}});
 const saved={total:3,imageId:'a',result:{ok:true,path:'runs/project/artifacts/a.png'}};state=imageProgress(state,saved);state=imageProgress(state,saved);state=imageProgress(state,{total:3,imageId:'b',result:{ok:false,path:'runs/project/artifacts/b.png'}});state=imageProgress(state,{total:3,imageId:'c',result:{ok:true,path:'runs/project/artifacts/../secret.png'}});assert.equal(Object.keys(state.items).length,3);assert.equal(state.items.a.path,'runs/project/artifacts/a.png');assert.equal(state.items.b.path,undefined);assert.equal(state.items.c.path,undefined);assert.equal(imageProgress(state,{output:'heartbeat'}),state);
});
