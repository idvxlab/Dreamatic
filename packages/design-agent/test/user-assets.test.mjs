import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importUserAsset, recordUserMaterialSources, userMaterialInventory, validateUserAsset } from "../dist/user-assets.js";
import { prepareDreamaticPrompt } from "../dist/prompt.js";
import { deliveryContract, designSourceFiles, validateDeliveryContract, htmlTask } from "../dist/design-contract.js";
import { HTML_PREVIEW_CSP, lintHtmlSourceDependencies, materializeHtml } from "../dist/html-delivery.js";
import { finalizeDelivery } from "../dist/finalize-delivery.js";

async function workspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), "dreamatic-user-assets-"));
  try { const runDir = join(dir, "runs", "demo"); await mkdir(runDir, {recursive:true}); await fn(dir, runDir); }
  finally { await rm(dir, {recursive:true, force:true}); }
}
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("uploaded originals survive import, approval mappings, mechanical build and finalization", async () => workspace(async (dir, runDir) => {
  const originals = [ {name:"logo.png", mimeType:"image/png", bytes:png}, {name:"intro.mp4", mimeType:"video/mp4", bytes:Buffer.from("test-video-original")}, {name:"brief.pdf", mimeType:"application/pdf", bytes:Buffer.from("%PDF-1.7 original") } ];
  const prepared = await prepareDreamaticPrompt({workspaceDir:dir,scopeId:"web-demo",text:"Use the uploaded logo, video and document unchanged",images:originals.map(({bytes,...item})=>({type:"image",data:bytes.toString("base64"),...item}))});
  assert.equal(prepared.images.length,1); assert.equal(prepared.references.length,3);
  await recordUserMaterialSources(runDir,[prepared.text]);
  const assets = [];
  for (const reference of prepared.references) assets.push(await importUserAsset(dir,{runId:"demo",source:reference.path}));
  for (const [index,asset] of assets.entries()) assert.deepEqual(await readFile(join(runDir,asset.source)), originals[index].bytes);
  const task = {id:"page",method:"html_generate",files:[{source:"plan/html/demo/index.html",output:"artifacts/demo/index.html"}], resources:assets.map((asset,index)=>({source:asset.source,output:`artifacts/demo/assets/${originals[index].name}`})),dependencies:[],interaction_checks:[],viewports:[{width:390,height:844}]};
  const plan = {schemaVersion:2,execution_plan:[task]};
  const manifest = {schemaVersion:2,presentation:{mode:"html",entry:"artifacts/demo/index.html"},deliverables:[{id:"page",method:"html_generate",kind:"html_page",file:"artifacts/demo/index.html",required:true}]};
  await mkdir(join(runDir,"plan/html/demo"),{recursive:true});
  await writeFile(join(runDir,"plan/html/demo/index.html"),'<html><title>Originals</title><img src="assets/logo.png"><video controls src="assets/intro.mp4"></video><a download href="assets/brief.pdf">Brief</a></html>');
  await writeFile(join(runDir,"plan/design_plan.json"),JSON.stringify(plan)); await writeFile(join(runDir,"plan/deliverable_manifest.json"),JSON.stringify(manifest));
  const contract = deliveryContract(plan,manifest); await validateDeliveryContract(runDir,contract);
  assert.deepEqual(await lintHtmlSourceDependencies(runDir,contract),[]);
  assert.ok((await designSourceFiles(runDir)).includes(".performance/user-materials.json"));
  const result = await materializeHtml(runDir,htmlTask(task)); assert.equal(result.ok,true);
  for (const [index,mapping] of task.resources.entries()) assert.deepEqual(await readFile(join(runDir,mapping.output)),originals[index].bytes);
  assert.equal((await materializeHtml(runDir,htmlTask(task))).reused,true);
  assert.equal((await finalizeDelivery(runDir,"demo")).lint.ok,true);
  assert.match(HTML_PREVIEW_CSP,/media-src 'self'/);
  await writeFile(join(runDir,task.resources[0].output),"tampered build");
  await assert.rejects(finalizeDelivery(runDir,"demo"),/differs from approved source/);
  await writeFile(join(runDir,assets[0].source),"tampered source");
  await assert.rejects(validateDeliveryContract(runDir,contract),/changed/);
}));

test("research sources, forged paths and symlink escapes cannot become user material", async () => workspace(async(dir,runDir)=>{
  await recordUserMaterialSources(runDir,["Use https://93.184.216.34/logo.png"]);
  let calls=0; const fake=async()=>{calls++;return new Response(png,{headers:{"content-type":"image/png"}})};
  await assert.rejects(importUserAsset(dir,{runId:"demo",source:"https://93.184.216.34/research.png"},undefined,fake),/not explicitly user-provided/); assert.equal(calls,0);
  await assert.rejects(validateUserAsset(runDir,"inputs/user-assets/forged.png"),/no trusted import receipt/);
  await mkdir(join(dir,"references/web-demo"),{recursive:true}); await writeFile(join(dir,"outside.png"),png);
  await symlink(join(dir,"outside.png"),join(dir,"references/web-demo/escape.png"));
  await recordUserMaterialSources(runDir,["references/web-demo/escape.png"]);
  await assert.rejects(importUserAsset(dir,{runId:"demo",source:"references/web-demo/escape.png"}),/escapes/);
}));

test("user page-linked material verified, extensionless image URL imported and HTML error rejected", async()=>workspace(async(dir,runDir)=>{
  const page="https://93.184.216.34/user-page";
  await recordUserMaterialSources(runDir,[`Use images from ${page}`]);
  let calls=0;
  const fake=async(url)=>{calls++; return url===page ? new Response('<img src="/asset?id=1"><a href="/brief.pdf">Brief</a>',{headers:{"content-type":"text/html"}}) : new Response(png,{headers:{"content-type":"image/png"}});};
  const asset=await importUserAsset(dir,{runId:"demo",source:"https://93.184.216.34/asset?id=1",sourcePageUrl:page},undefined,fake);
  assert.match(asset.source,/inputs\/user-assets\/.+\.png$/); assert.equal(calls,2);
  await importUserAsset(dir,{runId:"demo",source:"https://93.184.216.34/asset?id=1",sourcePageUrl:page},undefined,()=>{throw new Error("cache must avoid network")});
  await assert.rejects(importUserAsset(dir,{runId:"demo",source:"https://93.184.216.34/not-linked.png",sourcePageUrl:page},undefined,fake),/not linked/);
  await recordUserMaterialSources(runDir,["https://93.184.216.34/error.png"]);
  await assert.rejects(importUserAsset(dir,{runId:"demo",source:"https://93.184.216.34/error.png"},undefined,async()=>new Response("<html>Error</html>",{headers:{"content-type":"text/html"}})),/HTML page/);
  assert.equal((await userMaterialInventory(runDir)).assets.length,1);
}));

test("private redirects and unsupported executable material are rejected before copying", async()=>workspace(async(dir,runDir)=>{
  await recordUserMaterialSources(runDir,["https://93.184.216.34/redirect.png https://93.184.216.34/code.js"]);
  let calls=0;
  await assert.rejects(importUserAsset(dir,{runId:"demo",source:"https://93.184.216.34/redirect.png"},undefined,async()=>{calls++; return new Response(null,{status:302,headers:{location:"http://127.0.0.1/private.png"}})}),/private\/local/);
  assert.equal(calls,1);
  await assert.rejects(importUserAsset(dir,{runId:"demo",source:"https://93.184.216.34/code.js"},undefined,async()=>new Response("alert(1)",{headers:{"content-type":"application/javascript"}})),/supported/);
}));
