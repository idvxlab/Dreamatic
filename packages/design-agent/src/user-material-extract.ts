import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {extname,join} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {rejectVerificationPage} from './research.js';
import {resolveInside,safeRunId} from './paths.js';
import {readUserMaterial,githubMaterial,materialLinks,importUserAsset,recordMaterialLinks,saveImportedUserAsset} from './user-assets.js';

const decode = (value: string) => value.replace(/&#(x[0-9a-f]+|[0-9]+);/giu, (_, code: string) => { const point=Number.parseInt(code.replace(/^x/iu,''),/^x/iu.test(code)?16:10); return point<=0x10ffff?String.fromCodePoint(point):'�'; }).replace(/&(?:amp|lt|gt|quot|apos|#39);/gu, token => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'"}[token]!));
const readable = (value: string) => decode(value.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/giu,' ').replace(/<\/(?:p|div|h[1-6]|li|tr|w:p|a:p)>/giu,'\n').replace(/<[^>]+>/gu,' ').replace(/[ \t]+/gu,' ').replace(/\n\s*\n/gu,'\n').trim());
/** Read only text entries from OOXML. No extraction to disk or executable document code. */
function officeContent(bytes: Buffer, extension: string) {
 let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--) if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
 if(end<0) throw new Error('Invalid Office ZIP directory');
 const count=bytes.readUInt16LE(end+10);let offset=bytes.readUInt32LE(end+16),total=0;
 if(count>4096) throw new Error('Office document has too many entries');
 const texts: string[]=[], images: Array<{name: string;bytes: Buffer;extension: string}>=[];
 for(let i=0;i<count;i++) {
  if(offset+46>bytes.length||bytes.readUInt32LE(offset)!==0x02014b50) throw new Error('Invalid Office ZIP entry');
  const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),size=bytes.readUInt32LE(offset+24),compressed=bytes.readUInt32LE(offset+20),nameLength=bytes.readUInt16LE(offset+28),local=bytes.readUInt32LE(offset+42);
  const name=bytes.subarray(offset+46,offset+46+nameLength).toString();offset+=46+nameLength+bytes.readUInt16LE(offset+30)+bytes.readUInt16LE(offset+32);
  const selected=extension==='.docx'?/^word\/(?:document|header\d*|footer\d*)\.xml$/u.test(name):extension==='.pptx'?/^ppt\/slides\/slide\d+\.xml$/u.test(name):/^xl\/(?:sharedStrings|worksheets\/sheet\d+)\.xml$/u.test(name);
  const image=/^(?:word|ppt|xl)\/media\/[^/]+\.(?:png|jpe?g|webp|gif|svg)$/iu.test(name);
  if(!selected&&!image) continue;
  total+=size;
  if(flags&1||size>(image?20:8)*1024*1024||total>64*1024*1024||local+30>bytes.length||bytes.readUInt32LE(local)!==0x04034b50) throw new Error('Office text entry exceeds safe extraction limits');
  const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
  if(start+compressed>bytes.length) throw new Error('Truncated Office text entry');
  const payload=bytes.subarray(start,start+compressed);
  const expanded=method===0?payload:method===8?inflateRawSync(payload,{maxOutputLength:(image?20:8)*1024*1024}):undefined;
  if(!expanded||expanded.length!==size) throw new Error('Unsupported or corrupt Office text entry');
  if(image) images.push({name,bytes:expanded,extension:extname(name).toLowerCase()});
  else texts.push(readable(expanded.toString('utf8')));
 }
 return {text:texts.join('\n'),images};
}
export async function extractUserMaterial(workspaceDir: string, params: {runId: string;source: string;sourcePageUrl?: string;imageUrls?: string[]}, signal?: AbortSignal, fetcher: typeof fetch=fetch) {
 const runDir=resolveInside(workspaceDir,join('runs',safeRunId(params.runId)));
 const timeout=AbortSignal.timeout(60_000),bounded=signal?AbortSignal.any([signal,timeout]):timeout;
 const result=await readUserMaterial(workspaceDir,params,bounded,fetcher);
 const extension=extname(new URL(params.source,'https://upload.invalid').pathname).toLowerCase();
 const office=['.docx','.pptx','.xlsx'].includes(extension);
 if(!office&&result.bytes.length>12*1024*1024) throw new Error('Readable source exceeds 12 MB; provide a smaller content document');
 const raw=office?'':result.bytes.toString('utf8');
 const html=/text\/html/iu.test(result.type)||['.html','.htm'].includes(extension)||/^\s*(?:<!doctype html|<html)/iu.test(raw);
 if(!office&&!html&&!['.txt','.md','.csv'].includes(extension)&&!/text\/(?:plain|markdown|csv)|application\/json/iu.test(result.type)) throw new Error('Text extraction supports HTML, Markdown, plain text, CSV and DOCX/PPTX/XLSX. PDF/scanned or legacy Office content requires an accessible text version; do not claim it was read.');
 const document=office?officeContent(result.bytes,extension):undefined;
 const text=document?document.text:html?readable(raw):raw;
 if(html) rejectVerificationPage(readable(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1]??''),text);
 const base=/^https?:/u.test(params.source)?(githubMaterial(params.source)?params.source:result.url):'https://upload.invalid/';
 const links=office?[]:materialLinks(raw,base).filter(link=>new URL(link).hostname!=='upload.invalid');
 const images=links.filter(link=>/\.(?:png|jpe?g|webp|gif|svg)(?:[?#]|$)/iu.test(link));
 // Include extensionless HTML images as concrete source candidates too.
 if(html&&/^https?:/u.test(params.source)) for(const match of raw.matchAll(/<img\b[^>]*>/giu)) for(const link of materialLinks(match[0],base)) if(!images.includes(link)) images.push(link);
 await recordMaterialLinks(workspaceDir,params.runId,params.source,links,params.sourcePageUrl);
 const assets: Array<Record<string,unknown>>=[];
 for(const image of document?.images??[]) assets.push({ok:true,embeddedFile:image.name,...await saveImportedUserAsset(workspaceDir,{...params,embeddedFile:image.name},image.bytes,image.extension)});
 for(const url of params.imageUrls??[]) {
  if(!images.includes(url)) throw new Error('Selected image URL was not discovered in this source');
  try{assets.push({ok:true,...await importUserAsset(workspaceDir,{runId:params.runId,source:url,sourcePageUrl:params.sourcePageUrl??params.source},bounded,fetcher)});}catch(error){bounded.throwIfAborted();assets.push({ok:false,url,error:error instanceof Error?error.message:String(error)});}
 }
 const key=createHash('sha256').update(params.source).digest('hex');
 const path=`research/user-materials/${key}.json`;
 await mkdir(resolveInside(runDir,'research/user-materials'),{recursive:true});
 const report={source:params.source,sourcePageUrl:params.sourcePageUrl??null,fetchedAt:new Date().toISOString(),text,images,links,assets,limitations:[] as string[]};
 await writeFile(resolveInside(runDir,path),JSON.stringify(report,null,2));
 return {ok:true,path,text:text.slice(0,16000),truncated:text.length>16000,images,links,assets,limitations:report.limitations,instruction:'Use the cached full text for requested content. Images are user-source candidates, including identity assets; select needed originals with user_asset_import, preserve returned receipts, and hand their inputs/user-assets/ paths to Designer. Never substitute invented text/images for inaccessible required content.'};
}
