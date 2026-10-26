import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {finalizeImageEdit} from '../dist/image-edit-output.js';
import {projectFileContent} from '../dist/project-files.js';
test('scale, crop and padding save exact-sized separate assets, retain original and record processing',async t=>{
 const workspace=await mkdtemp(join(tmpdir(),'edit-output-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
 const root=join(workspace,'runs','demo');await mkdir(join(root,'inputs/media-edits'),{recursive:true});await mkdir(join(root,'inputs/user-assets'));
 const original=await sharp({create:{width:1728,height:2304,channels:4,background:'#ff0000'}}).png().toBuffer();
 await writeFile(join(root,'inputs/user-assets/original.png'),original);
 const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';const receipt=join(root,'inputs/media-edits',id+'.json');
 const record={outputId:'inputs/user-assets/original.png',targetDimensions:{width:1086,height:1448}};
 await writeFile(receipt,JSON.stringify(record));
 const scaled=await finalizeImageEdit(workspace,'demo',id,'scale');assert.equal(scaled.outputDimensions.width,1086);assert.equal(scaled.dimensionStatus,'exact');
 const scaledBytes=(await projectFileContent(workspace,'demo',scaled.id)).data;assert.equal((await sharp(scaledBytes).metadata()).height,1448);
 record.targetDimensions={width:1086,height:2304};await writeFile(receipt,JSON.stringify(record));
 await assert.rejects(finalizeImageEdit(workspace,'demo',id,'scale'),/Aspect ratios differ/);
 for(const method of ['crop','pad']){const output=await finalizeImageEdit(workspace,'demo',id,method);const bytes=(await projectFileContent(workspace,'demo',output.id)).data;const info=await sharp(bytes).metadata();assert.equal(info.width,1086);assert.equal(info.height,2304);const provenance=JSON.parse(await readFile(join(root,'inputs/media-edits',output.editId+'.json'),'utf8'));assert.equal(provenance.method,method);assert.equal(provenance.providerOutputId,record.outputId);}
 assert.deepEqual(await readFile(join(root,'inputs/user-assets/original.png')),original);
 await assert.rejects(finalizeImageEdit(workspace,'demo','../../outside','crop'));
 await assert.rejects(finalizeImageEdit(workspace,'demo',id,'stretch'));
});
