import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
async function loadApi(){const source=await readFile(new URL('../src/api.ts',import.meta.url),'utf8');const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});return import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64')+'#'+Math.random());}
function blocked(signal){return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));}
test('project creation times out without retries, then a successful request remains usable',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 t.mock.method(globalThis,'fetch',(_url,{signal})=>{calls++;return blocked(signal)});
 const api=await loadApi();const pending=assert.rejects(api.createSession(),/Reconnect to refresh the project list/);
 t.mock.timers.tick(15000);await pending;assert.equal(calls,1);
 globalThis.fetch=async()=>new Response(JSON.stringify({id:'created'}),{status:201});
 assert.equal((await api.createSession()).id,'created');
});
test('timeout includes stalled response bodies and clears deduplicated GET state for reconnect',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let bodyStarted=false;
 t.mock.method(globalThis,'fetch',async(_url,{signal})=>({status:200,ok:true,json(){bodyStarted=true;return blocked(signal)}}));
 const api=await loadApi();const pending=assert.rejects(api.listRuns(),/server took too long/);
 while(!bodyStarted)await Promise.resolve();t.mock.timers.tick(15000);await pending;
 globalThis.fetch=async()=>new Response(JSON.stringify([{id:'recovered'}]),{headers:{etag:'"one"'}});
 assert.equal((await api.listRuns())[0].id,'recovered');
 globalThis.fetch=async(_url,init)=>{assert.equal(init.headers['If-None-Match'],'"one"');return new Response(null,{status:304})};
 assert.equal((await api.listRuns())[0].id,'recovered');
});
test('ordinary HTTP errors keep their original explanation',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:'Disk unavailable'}),{status:500}));
 const api=await loadApi();await assert.rejects(api.createSession(),/Disk unavailable/);
});
