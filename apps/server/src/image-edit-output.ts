import sharp from 'sharp';
import { readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dimensionStatus, validDimensions } from './image-edit-plan.js';
import { imageDimensions } from './image-edit-size.js';
import { projectFileContent } from './project-files.js';
import { projectInputDirectory, storeProjectMedia } from './media-upload.js';
/** User-selected postprocessing produces another asset and receipt; never mutates the provider original. */
export async function finalizeImageEdit(workspace: string, runId: string, editId: unknown, method: unknown) {
  if (typeof editId !== 'string' || !/^[a-f0-9-]{36}$/u.test(editId) || !['scale','crop','pad'].includes(String(method))) throw new Error('Invalid image processing request');
  const folder = await projectInputDirectory(workspace,runId,'media-edits');
  const receiptPath=join(folder,`${editId}.json`);
  if(await realpath(receiptPath)!==receiptPath) throw new Error('Invalid edit receipt path');
  const receipt = JSON.parse(await readFile(receiptPath,'utf8'));
  const target = receipt.targetDimensions;
  if (!validDimensions(target) || typeof receipt.outputId !== 'string') throw new Error('This edit has no target dimensions. Historical results are unchanged.');
  const source = await projectFileContent(workspace,runId,receipt.outputId);
  const dimensions = imageDimensions(source.data);
  if (!dimensions) throw new Error('Could not read the generated image dimensions.');
  if (method === 'scale' && !['exact','same-ratio'].includes(dimensionStatus(dimensions,target))) throw new Error('Aspect ratios differ. Choose crop or padding instead of stretching.');
  const bytes = await sharp(source.data,{limitInputPixels:40_000_000}).rotate().resize(target.width,target.height,{fit:method==='crop'?'cover':method==='pad'?'contain':'fill',position:'centre',background:{r:255,g:255,b:255,alpha:1}}).png().toBuffer();
  const actual = imageDimensions(bytes);
  if (actual?.width!==target.width || actual.height!==target.height) throw new Error('Processed image dimensions are incorrect');
  const saved = await storeProjectMedia(workspace,runId,`edit-${method}.png`,bytes);
  const id = randomUUID(), path=join(folder,`${id}.json`);
  try { await writeFile(path,JSON.stringify({version:1,id,createdAt:new Date().toISOString(),parentEditId:editId,providerOutputId:receipt.outputId,outputId:saved.id,method,targetDimensions:target,outputDimensions:actual,upscaled:target.width>dimensions.width||target.height>dimensions.height},null,2),{flag:'wx',mode:0o600}); }
  catch(error) {await rm(path,{force:true});const output=await projectInputDirectory(workspace,runId,'user-assets');await rm(join(output,saved.title),{force:true});throw error;}
  return {...saved,path:saved.id,category:'assets' as const,group:'Uploaded files',editId:id,targetDimensions:target,outputDimensions:actual,dimensionStatus:'exact' as const};
}
