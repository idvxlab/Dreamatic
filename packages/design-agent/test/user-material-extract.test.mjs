import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateRawSync} from 'node:zlib';
import test from 'node:test';
import {extractUserMaterial} from '../dist/user-material-extract.js';
import {importUserAsset,recordUserMaterialSources,userMaterialInventory,validateUserAsset} from '../dist/user-assets.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
async function fixture(fn){const dir=await mkdtemp(join(tmpdir(),'dreamatic-content-'));const run=join(dir,'runs/demo');await mkdir(run,{recursive:true});try{await fn(dir,run)}finally{await rm(dir,{recursive:true,force:true})}}
function zip(entries){
 const local=[],central=[];let offset=0;
 for(const [name,raw] of entries){const nameBytes=Buffer.from(name),bytes=Buffer.from(raw),compressed=deflateRawSync(bytes);let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let n=0;n<8;n++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1}crc=(crc^0xffffffff)>>>0;
 const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(8,8);header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(nameBytes.length,26);
 const cd=Buffer.alloc(46);cd.writeUInt32LE(0x02014b50);cd.writeUInt16LE(20,4);cd.writeUInt16LE(20,6);cd.writeUInt16LE(8,10);cd.writeUInt32LE(crc,16);cd.writeUInt32LE(compressed.length,20);cd.writeUInt32LE(bytes.length,24);cd.writeUInt16LE(nameBytes.length,28);cd.writeUInt32LE(offset,42);local.push(header,nameBytes,compressed);central.push(cd,nameBytes);offset+=header.length+nameBytes.length+compressed.length;
 }
 const index=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,index,end]);
}
test('user webpage content retains logo/gallery images and imports originals from the acquired snapshot',()=>fixture(async(dir,run)=>{
 const page='https://93.184.216.34/home';await recordUserMaterialSources(run,[page]);let pageFetches=0;
 const fetcher=async url=>url===page?(pageFetches++,new Response('<html><header><img src="/logo.svg"></header><main><h1>Dreamatic &#x827A;&#26415;</h1><p>Install &amp; configure</p><img src="/work.png"><img src="/render?id=1"></main><script>doNotExtract()</script></html>',{headers:{'content-type':'text/html'}})):new Response(png,{headers:{'content-type':'image/png'}});
 const result=await extractUserMaterial(dir,{runId:'demo',source:page,imageUrls:['https://93.184.216.34/work.png']},undefined,fetcher);
 assert.match(result.text,/Dreamatic 艺术/);assert.match(result.text,/Install & configure/);assert.doesNotMatch(result.text,/doNotExtract/);assert.ok(result.images.includes('https://93.184.216.34/logo.svg'));assert.ok(result.images.includes('https://93.184.216.34/render?id=1'));
 const asset=await importUserAsset(dir,{runId:'demo',source:'https://93.184.216.34/render?id=1',sourcePageUrl:page},undefined,fetcher);assert.equal(pageFetches,1);await validateUserAsset(run,asset.source);assert.deepEqual(await readFile(join(run,asset.source)),png);
 await assert.rejects(importUserAsset(dir,{runId:'demo',source:'https://93.184.216.34/not-linked.png',sourcePageUrl:page},undefined,fetcher),/not linked/);
}));
test('GitHub tree README and blob images use file content API with repository/ref confinement',()=>fixture(async(dir,run)=>{
 const page='https://github.com/idvxlab/Dreamatic/tree/dev';await recordUserMaterialSources(run,[page]);const requests=[];
 const fetcher=async url=>{requests.push(url);return new Response(url.includes('README.md')?'# Features\nInstall this system.\n![Gallery](examples/one/final/hero.png)':png,{headers:{'content-type':'application/vnd.github.raw+json; charset=utf-8'}})};
 const report=await extractUserMaterial(dir,{runId:'demo',source:page},undefined,fetcher);assert.match(report.text,/Install this system/);assert.ok(report.images.includes('https://raw.githubusercontent.com/idvxlab/Dreamatic/dev/examples/one/final/hero.png'));
 const asset=await importUserAsset(dir,{runId:'demo',source:'https://github.com/idvxlab/Dreamatic/blob/dev/examples/one/final/hero.png',sourcePageUrl:page},undefined,fetcher);assert.deepEqual(await readFile(join(run,asset.source)),png);assert.ok(requests.every(url=>url.startsWith('https://api.github.com/repos/idvxlab/Dreamatic/contents/')));
 for(const source of ['https://github.com/other/Dreamatic/blob/dev/hero.png','https://raw.githubusercontent.com/idvxlab/Dreamatic/main/hero.png']) await assert.rejects(importUserAsset(dir,{runId:'demo',source,sourcePageUrl:page},undefined,fetcher),/not linked/);
}));
test('uploaded HTML and modern Office text/images become verifiable source material without executing code',()=>fixture(async(dir,run)=>{
 await mkdir(join(dir,'references/content'),{recursive:true});const html='references/content/brief.html',doc='references/content/brief.docx';
 await writeFile(join(dir,html),'<h1>Required homepage copy</h1><img src="relative.png"><script>malicious()</script>');const bytes=zip([['word/document.xml','<w:document><w:p><w:r><w:t>Required Gallery content</w:t></w:r></w:p></w:document>'],['word/media/image1.png',png]]);await writeFile(join(dir,doc),bytes);await recordUserMaterialSources(run,[html+' '+doc]);
 const page=await extractUserMaterial(dir,{runId:'demo',source:html});assert.match(page.text,/Required homepage/);assert.doesNotMatch(page.text,/malicious/);assert.deepEqual(page.images,[]);
 const report=await extractUserMaterial(dir,{runId:'demo',source:doc});assert.match(report.text,/Required Gallery/);assert.equal(report.assets.length,1);assert.equal(report.assets[0].embeddedFile,'word/media/image1.png');await validateUserAsset(run,report.assets[0].source);assert.deepEqual(await readFile(join(run,report.assets[0].source)),png);
 const original=await importUserAsset(dir,{runId:'demo',source:doc});assert.match(original.source,/\.docx$/);assert.deepEqual(await readFile(join(run,original.source)),bytes);
}));
test('unsupported, forged and verification-page sources cannot masquerade as extracted user content',()=>fixture(async(dir,run)=>{
 await assert.rejects(extractUserMaterial(dir,{runId:'demo',source:'https://93.184.216.34/not-user'}),/not explicitly/);
 const page='https://93.184.216.34/blocked';await recordUserMaterialSources(run,[page]);await assert.rejects(extractUserMaterial(dir,{runId:'demo',source:page},undefined,async()=>new Response('<title>Just a moment</title><p>Enable JavaScript and cookies to continue</p>',{headers:{'content-type':'text/html'}})),/verification page/);
 await mkdir(join(dir,'references/doc'),{recursive:true});await writeFile(join(dir,'references/doc/scan.pdf'),'%PDF-1.7');await recordUserMaterialSources(run,['references/doc/scan.pdf']);await assert.rejects(extractUserMaterial(dir,{runId:'demo',source:'references/doc/scan.pdf'}),/PDF\/scanned/);assert.equal((await userMaterialInventory(run)).assets.length,0);
}));
test('linked user content pages retain verified provenance through selected child images',()=>fixture(async(dir,run)=>{
 const root='https://93.184.216.34/home',child='https://93.184.216.34/gallery',image='https://93.184.216.34/design.png';await recordUserMaterialSources(run,[root]);
 const fetcher=async url=>new Response(url===root?'<a href="/gallery">Gallery</a>':url===child?'<h1>Real projects</h1><img src="/design.png">':png,{headers:{'content-type':url===image?'image/png':'text/html'}});
 await extractUserMaterial(dir,{runId:'demo',source:root},undefined,fetcher);
 const result=await extractUserMaterial(dir,{runId:'demo',source:child,sourcePageUrl:root,imageUrls:[image]},undefined,fetcher);assert.equal(result.assets[0].ok,true);await validateUserAsset(run,result.assets[0].source);
}));
test('redirected webpages resolve relative image links against the actual acquired page',()=>fixture(async(dir,run)=>{
 const source='https://93.184.216.34/old',actual='https://93.184.216.34/content/index.html',image='https://93.184.216.34/content/hero.png';await recordUserMaterialSources(run,[source]);
 const fetcher=async url=>url===source?new Response(null,{status:302,headers:{location:actual}}):new Response(url===actual?'<h1>Requested content</h1><img src="hero.png">':png,{headers:{'content-type':url===actual?'text/html':'image/png'}});
 const result=await extractUserMaterial(dir,{runId:'demo',source,imageUrls:[image]},undefined,fetcher);assert.deepEqual(result.images,[image]);assert.equal(result.assets[0].ok,true);await validateUserAsset(run,result.assets[0].source);
}));
