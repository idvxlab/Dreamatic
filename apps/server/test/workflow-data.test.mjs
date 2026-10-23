import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { publicWorkflowData } from '../dist/workflow-data.js';
import { collectPaths } from '../dist/workflow-store.js';

test('public workflow data strips native and JSON-encoded image results without changing model data',()=>{
 const original={content:[{type:'text',text:'Saved: artifacts/work.png'},{type:'image',mimeType:'image/png',data:'A'.repeat(5000)}],details:{output:{type:'image',data:'B'.repeat(5000)},b64_json:'C'.repeat(5000)}};
 const safe=publicWorkflowData({output:JSON.stringify(original),event:{result:original}});
 assert.ok(JSON.stringify(safe).length<1000);assert.match(safe.output,/artifacts\/work.png/);
 assert.ok(!JSON.stringify(safe).includes('A'.repeat(100)));
 assert.equal(original.content[1].data.length,5000,'native model result is not mutated');
 assert.ok(JSON.stringify(publicWorkflowData({imageData:'secret',text:'See data:image/png;base64,AAAA and artifacts/work.png'})).includes('artifacts/work.png'));
});
test('path recovery retains Unix, Windows, Markdown and nested JSON references while ignoring image payload fields',()=>{
 assert.deepEqual([...collectPaths('runs/project/final/artifacts/index.html','project')],['runs/project/final/artifacts/index.html']);
 const refs=collectPaths({text:'![Work](../artifacts/work.png) C:\\runs\\project\\final\\00-index.html /tmp/runs/project/research/evidence.md',output:JSON.stringify({content:[{type:'text',text:'artifacts/second.webp'},{type:'image',data:'artifacts/fake.png'}],details:{b64_json:'artifacts/another-fake.png'}})},'project');
 assert.deepEqual([...refs].sort(),['runs/project/artifacts/second.webp','runs/project/artifacts/work.png','runs/project/final/00-index.html','runs/project/research/evidence.md']);
});
test('multi-megabyte historical read results restore under an external deadline, without altering the source log',{timeout:15000},async t=>{
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-large-workflow-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
 const runDir=join(workspace,'runs/project');await mkdir(runDir,{recursive:true});
 const payload='A'.repeat(4_356_968);
 const output=JSON.stringify({content:[{type:'text',text:'Read artifacts/work.png'},{type:'image',data:payload,mimeType:'image/png'}],details:{output:{type:'image',data:payload}}});
 const records=[{type:'agent_started',agent:'builder',invocationId:'build',at:'2026-01-01T00:00:00Z'},{type:'tool_started',agent:'builder',invocationId:'build',toolCallId:'read',toolName:'read',input:JSON.stringify({path:'artifacts/work.png'})},{type:'tool_finished',agent:'builder',invocationId:'build',toolCallId:'read',toolName:'read',output}];
 const log=records.map(row=>JSON.stringify(row)).join('\n')+'\n';const path=join(runDir,'bus.jsonl');await writeFile(path,log);
 // A child deadline can terminate a regressed synchronous regex; a test timer cannot.
 const script=`import {workflowInventory,collectPaths} from ${JSON.stringify('file://'+resolve('apps/server/dist/workflow-store.js'))};
 import {indexedJsonl} from ${JSON.stringify('file://'+resolve('apps/server/dist/jsonl-index.js'))};
 const start=performance.now();const index=await indexedJsonl(${JSON.stringify(path)});const nodes=await workflowInventory(${JSON.stringify(workspace)},'project');
 const raw=collectPaths('A'.repeat(8_714_159)+' artifacts/tail.png','project');
 console.log(JSON.stringify({ms:performance.now()-start,bytes:index.source.length,refs:nodes[0].children[0].artifactRefs,raw:[...raw]}));`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{timeout:10000,maxBuffer:4096});
 const result=JSON.parse(stdout);assert.ok(result.ms<8000);assert.ok(result.bytes<3000);assert.ok(result.refs.includes('runs/project/artifacts/work.png'));assert.deepEqual(result.raw,['runs/project/artifacts/tail.png']);
 assert.equal(await readFile(path,'utf8'),log,'historical binary data stays untouched on disk');
});
