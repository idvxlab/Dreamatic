import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {publishProject,normalizeCreator,publicationEndpoint} from '../dist/project-publish.js';
const exec=promisify(execFile);
async function fixture(t){const workspace=await mkdtemp(join(tmpdir(),'dreamatic-publish-test-'));t.after(()=>rm(workspace,{recursive:true,force:true}));const run=join(workspace,'runs','project-test');for(const [file,value]of Object.entries({'run-state.json':JSON.stringify({stages:{build:'completed'}}),'brief.json':'{"title":"Test publication"}','artifacts/artifact-manifest.json':'{"presentation":{"entry":"artifacts/home/index.html"}}','artifacts/home/index.html':'<h1>Public design</h1>'})){await mkdir(dirname(join(run,file)),{recursive:true});await writeFile(join(run,file),value)}return {workspace,run}}
test('publishing requires explicit consent and a secure configured destination; attribution cannot forge identity',async t=>{
 const f=await fixture(t);assert.equal(normalizeCreator({userId:'forged'}).name,'');assert.equal('userId' in normalizeCreator({userId:'forged'}),false);
 assert.throws(()=>publicationEndpoint('http://example.com'),/HTTPS/);assert.throws(()=>publicationEndpoint('https://user:password@example.com'),/HTTPS/);assert.throws(()=>publicationEndpoint(''),/Settings/);
 assert.equal(publicationEndpoint('http://127.0.0.1:3000').pathname,'/api/gallery/publish');
 await assert.rejects(publishProject(f.workspace,'project-test',{creator:{}},'https://example.com'),/Confirm/);
});
test('publishing sends a complete ZIP with optional creator information, validates receipt and cleans temporary files',async t=>{
 const f=await fixture(t),original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});const initialTemps=new Set((await readdir(tmpdir())).filter(name=>name.startsWith("dreamatic-export-")));let calls=0;
 globalThis.fetch=async(url,init)=>{calls++;assert.equal(String(url),'https://www.dreamatic.art/api/gallery/publish');assert.equal(init.headers['Content-Type'],'application/zip');assert.equal(init.redirect,'error');const zip=join(f.workspace,'received.zip');await writeFile(zip,Buffer.from(await init.body.arrayBuffer()));const {stdout}=await exec('unzip',['-p',zip,'project-test/publication.json']);const metadata=JSON.parse(stdout);assert.equal(metadata.creator.name,'Artist');assert.equal(metadata.creator.userId,undefined);const {stdout:files}=await exec('unzip',['-Z1',zip]);assert.match(files,/project-test\/artifacts\/home\/index.html/);return new Response(JSON.stringify({projectId:'published-test',previewUrl:'/gallery-assets/published-test/artifacts/home/index.html',galleryUrl:'/#gallery'}),{status:201,headers:{'Content-Type':'application/json'}})};
 const result=await publishProject(f.workspace,'project-test',{confirmed:true,publicationId:randomUUID(),creator:{name:'Artist'}},'https://www.dreamatic.art/');assert.equal(result.galleryUrl,'https://www.dreamatic.art/#gallery');assert.equal(calls,1);
 for(const name of (await readdir(tmpdir())).filter(name=>name.startsWith('dreamatic-export-'))) assert.ok(initialTemps.has(name),'Publish must remove its temporary export directory');
 globalThis.fetch=async()=>new Response(JSON.stringify({error:'Storage unavailable'}),{status:503});
 await assert.rejects(publishProject(f.workspace,'project-test',{confirmed:true,creator:{}},'https://www.dreamatic.art/'),/Storage unavailable/);
 for(const name of (await readdir(tmpdir())).filter(name=>name.startsWith('dreamatic-export-'))) assert.ok(initialTemps.has(name),'Failed publish must remove its temporary export directory');
 await writeFile(join(f.run,'run-state.json'),'{"stages":{"build":"pending"}}');await assert.rejects(publishProject(f.workspace,'project-test',{confirmed:true,creator:{}},'https://www.dreamatic.art/'),/completed build/);
});
