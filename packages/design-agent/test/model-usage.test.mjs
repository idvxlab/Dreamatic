import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {recordReasoningModel,collectModelUsage,annotateModelUsage,writeModelPreview} from '../dist/model-usage.js';
test('model receipts retain role-specific and concurrent usage; generation comes from completed output records',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dreamatic-models-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await Promise.all([recordReasoningModel(dir,'designer','reason-a','provider-a'),recordReasoningModel(dir,'reviewer','reason-b','provider-b'),recordReasoningModel(dir,'designer','reason-a','provider-a')]);
 await mkdir(join(dir,'artifacts'));
 await writeFile(join(dir,'artifacts/a.png.json'),JSON.stringify({tool:'image_generate',generationModel:{model:'image-a',provider:'example.com',source:'request'}}));
 const usage=await collectModelUsage(dir,[{path:'artifacts/a.png',deliverableId:'a'},{path:'artifacts/old.png',deliverableId:'old'}]);
 assert.equal(usage.reasoning.length,2);assert.deepEqual(usage.generation,[{model:'image-a',provider:'example.com',method:'image_generate',deliverableId:'a',source:'request'}]);
 assert.deepEqual((await collectModelUsage(dir,[])).generation,[]);
});
test('preview attribution escapes names, replaces its own block and leaves interactive source unchanged',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dreamatic-model-preview-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(join(dir,'artifacts/site'),{recursive:true});
 const usage={schemaVersion:1,reasoning:[{model:'reason<script>',provider:'p'}],generation:[]};
 const html=annotateModelUsage('<html><body><h1>Design</h1></body></html>',usage);assert.match(html,/reason&lt;script&gt;/);assert.match(html,/未记录/);assert.equal(annotateModelUsage(html,usage),html);
 const source='<button onclick="this.textContent=\'ready\'">Test</button>';await writeFile(join(dir,'artifacts/site/index.html'),source);
 const wrapper=await writeModelPreview(dir,'artifacts/site/index.html',usage);assert.match(await readFile(join(dir,wrapper),'utf8'),/src="site\/index.html"/);assert.equal(await readFile(join(dir,'artifacts/site/index.html'),'utf8'),source);
});
