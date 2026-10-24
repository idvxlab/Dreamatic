import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { browserExecutable } from '../../../scripts/browser-executable.mjs';
import { curatePortfolio } from '../dist/portfolio-plan.js';
import { generatePortfolio } from '../dist/portfolio-pdf.js';
const theme={background:'#fff',foreground:'#111',accent:'#555',serif:false};
const work=(id,section='System',role='work')=>({id,section,role,caption:id,width:1000,height:700,digest:id,source:'',signature:[]});
const direction=works=>({heroId:works[0].id,works:works.map(({id,role,section})=>({id,role,section,purpose:id})),markdown:'Project specific direction'});
test('PDF shares the hero and narrative but selects representative works without imposing HTML omissions',()=>{
 const works=[work('hero'),work('a'),work('b'),work('c'),work('d','Material','detail')];
 const d=direction(works);const plan=curatePortfolio({title:'Test',markdown:'## Concept\nA coherent object system.\n\n## Tasks\nDo not publish tasks.',direction:d,works,theme,warnings:[]});
 assert.equal(plan.pages[0].ids[0],'hero');assert.equal(plan.pages[0].text,'A coherent object system.');
 assert.ok(!plan.selected.includes('c'));assert.ok(plan.selected.includes('d'));assert.equal(d.works.length,5);
 assert.equal(plan.pages.at(-1).kind,'detail');
});
test('duplicate suppression and aspect-aware comparisons preserve narrative',()=>{
 const works=[work('hero'),{...work('copy'),digest:'hero'},work('wide1','Scene'),work('wide2','Context'), {...work('portrait1'),width:600,height:1000,section:'Series'}, {...work('portrait2'),width:600,height:1000,section:'Series'}];
 const plan=curatePortfolio({title:'Test',markdown:'',direction:direction(works),works,theme,warnings:[]});
 assert.deepEqual(plan.selected,['hero','wide1','wide2','portrait1','portrait2']);assert.deepEqual(plan.pages.find(page=>page.kind==='pair').ids,['portrait1','portrait2']);assert.match(plan.omitted[0].reason,/duplicate/);
 assert.throws(()=>curatePortfolio({title:'Test',markdown:'',direction:direction(works),works:[],theme,warnings:[]}),/No readable/);
});
test('short references stay with the closing work and preserve complete source addresses',()=>{
 const hero={...work('hero'),caption:'A material decision [7].'};
 const citation='[7] Author, Material study, 2026. https://example.org/source';
 const plan=curatePortfolio({title:'Test',markdown:`## References\n${citation}`,direction:direction([hero]),works:[hero],theme,warnings:[]});
 assert.equal(plan.pages.length,1);assert.deepEqual(plan.pages[0].notes,[citation]);assert.deepEqual(plan.warnings,[]);
});
test('independent PDF export embeds originals and fonts, validates pages and preserves Builder outputs',async t=>{
 const executable=await browserExecutable();if(!executable){t.skip('Chromium unavailable');return;}
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-portfolio-test-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
 const root=join(workspace,'runs','project');await mkdir(join(root,'artifacts'),{recursive:true});
 const browser=await chromium.launch({executablePath:executable,headless:true});
 let png;
 try {const page=await browser.newPage({viewport:{width:1000,height:700}});await page.setContent('<body style="margin:0;background:#5b7b8a"><div style="margin:100px;background:#f5f0e8;width:500px;height:400px;border-radius:90px"></div>');png=await page.screenshot();}finally{await browser.close();}
 const digest=createHash('sha256').update(png).digest('hex');
 const design='# 测试作品 · Design\n\n## Concept\n为日常生活构建安静、清晰的视觉语言。\n\n## Image: hero\n### Introduction\n完整作品与材料关系。\n### Size\n1000x700\n### Prompt\nA designed object';
 const files={'design.md':design,'run-state.json':JSON.stringify({stages:{build:'completed'}}),'artifacts/generated.json':JSON.stringify({hero:{path:'artifacts/hero.png',digest}}),'.showcase-direction.json':JSON.stringify({direction:direction([work('hero')])}),'artifacts/artifact-manifest.json':JSON.stringify({presentation:{entry:'artifacts/00-gallery.html'}}),'artifacts/00-gallery.html':'<html><style>body{background:#f5f0e8;color:#333}</style><body>Preserve this exhibition</body></html>','artifacts/hero.png':png};
 for(const [path,bytes]of Object.entries(files))await writeFile(join(root,path),bytes);
 const result=await generatePortfolio(workspace,'project');assert.equal(result.pages,1);assert.equal(result.selected,1);
 const pdf=await readFile(join(workspace,result.path));assert.equal(createHash('sha256').update(pdf).digest('hex'),result.sha256);assert.match(pdf.toString('latin1'),/\/FontFile|\/CharProcs/);
 for(const [path,bytes]of Object.entries(files))assert.deepEqual(await readFile(join(root,path)),Buffer.from(bytes));
 const second=await generatePortfolio(workspace,'project');assert.notEqual(second.path,result.path,'exports never overwrite one another');
 const server=spawn(process.execPath,['apps/server/dist/index.js'],{cwd:process.cwd(),env:{...process.env,PORT:'0',DREAMATIC_CONFIG_DIR:workspace,DREAMATIC_WORKSPACE:workspace,DREAMATIC_HTML_BROWSER_EXECUTABLE:executable},stdio:['ignore','pipe','pipe']});
 t.after(()=>server.kill('SIGTERM'));
 const base=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Server startup timeout')),10000);server.stdout.on('data',chunk=>{output+=chunk;const match=/DreamaticArt server: (http:\/\/localhost:\d+)/.exec(output);if(match){clearTimeout(timer);resolve(match[1]);}});server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Server exited ${code}`));});});
 const response=await fetch(`${base}/api/runs/project/portfolio`,{method:'POST'});assert.equal(response.status,201);const apiResult=await response.json();
 const download=await fetch(`${base}/assets/${apiResult.path}`);assert.match(download.headers.get('content-type'),/application\/pdf/);assert.equal(createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex'),apiResult.sha256);
 const extra={...work('missing'),section:'Context'};
 await writeFile(join(root,'design.md'),design+'\n## Image: missing\n### Introduction\nOptional context\n### Size\n1000x700\n### Prompt\nA context image');
 await writeFile(join(root,'.showcase-direction.json'),JSON.stringify({direction:direction([work('hero'),extra])}));
 await writeFile(join(root,'artifacts/generated.json'),JSON.stringify({hero:{path:'artifacts/hero.png',digest},missing:{path:'artifacts/missing.png',digest:'missing'}}));
 const degraded=await generatePortfolio(workspace,'project');assert.equal(degraded.selected,1);assert.ok(degraded.warnings.some(warning=>/Missing image omitted: missing/.test(warning)));
 for(const path of ['design.md','.showcase-direction.json','artifacts/generated.json'])await writeFile(join(root,path),files[path]);
 const configuredBrowser=process.env.DREAMATIC_HTML_BROWSER_EXECUTABLE;
 process.env.DREAMATIC_HTML_BROWSER_EXECUTABLE=join(workspace,'does-not-exist');
 try{await assert.rejects(generatePortfolio(workspace,'project'),/renderer unavailable/);}finally{if(configuredBrowser===undefined)delete process.env.DREAMATIC_HTML_BROWSER_EXECUTABLE;else process.env.DREAMATIC_HTML_BROWSER_EXECUTABLE=configuredBrowser;}
 await writeFile(join(root,'artifacts/hero.png'),'corrupt');
 await assert.rejects(generatePortfolio(workspace,'project'),/image changed/);
 assert.equal((await readdir(join(root,'artifacts'))).filter(name=>name.startsWith('.portfolio-')).length,0);
 await writeFile(join(root,'run-state.json'),JSON.stringify({stages:{build:'pending'}}));
 await assert.rejects(generatePortfolio(workspace,'project'),/completed/);
 await assert.rejects(generatePortfolio(workspace,'../project'),/Invalid run id/);
});
