import assert from 'node:assert/strict';import test from 'node:test';import {createServer} from 'node:http';import {fileURLToPath} from 'node:url';import {readFile} from 'node:fs/promises';import {build} from 'vite';import {browserExecutable} from '../../../packages/design-agent/dist/html-delivery.js';
test('fixed status displays live receipts without opening tool details and keeps successful thumbnails after completion',{timeout:60000},async t=>{
 const executablePath=await browserExecutable();if(!executablePath){t.skip('Chromium unavailable');return}
 const root=fileURLToPath(new URL('..',import.meta.url)),panel=fileURLToPath(new URL('../src/components/AgentPanel.tsx',import.meta.url)),entry='virtual:run-status';
 const bundle=await build({root,configFile:false,logLevel:'silent',esbuild:{jsx:'automatic'},plugins:[{name:'fixture',resolveId(id){if(id===entry)return id},load(id){if(id===entry)return `import React from 'react';import {createRoot} from 'react-dom/client';import {AgentPanel} from ${JSON.stringify(panel)};const root=createRoot(document.getElementById('root'));window.update=props=>root.render(React.createElement(AgentPanel,{timeline:[],streamingText:'',stopping:false,onSend(){},onStop(){},onAnswerClarification(){},onDismissClarification(){},...props}));window.update({running:true,workflow:[]});`;}}],build:{write:false,rollupOptions:{input:entry},minify:false}});
 const js=bundle.output.find(x=>x.type==='chunk').code,css=await readFile(new URL('../src/styles.css',import.meta.url),'utf8');
 const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':req.url==='/style.css'?'text/css':'text/html');res.end(req.url==='/bundle.js'?js:req.url==='/style.css'?css:'<html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>')});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
 const {chromium}=await import('playwright-core');const browser=await chromium.launch({executablePath,headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1100,height:800}});await page.goto('http://127.0.0.1:'+server.address().port);
 const event={id:'batch',kind:'tool',status:'running',actor:'Builder',label:'Generated design images',at:new Date(Date.now()-10000).toISOString(),updatedAt:new Date().toISOString(),output:'Image hero: receiving response',imageProgress:{total:3,items:{hero:{ok:true,path:'runs/p/artifacts/hero.png'},detail:{ok:false}}}};
 await page.evaluate(event=>window.update({running:true,workflow:[event]}),event);const status=page.getByRole('region',{name:'Run status'});await status.getByText('Saved: 1 · Failed: 1 · Pending: 1 · Total: 3',{exact:true}).waitFor();assert.equal(await status.locator('img').count(),1);assert.match(await status.textContent(),/receiving response/);assert.match(await status.textContent(),/Last status update/);assert.equal(await page.locator('.workflow-event-card').getAttribute('open'),null);assert.equal(await page.getByText('Pi runtime connected',{exact:true}).count(),0);
 const bounds=await status.boundingBox(),composer=await page.locator('.composer').boundingBox();assert.ok(bounds.y+bounds.height<composer.y);
 await page.evaluate(event=>window.update({running:false,workflow:[{...event,status:'completed'}]}),event);assert.equal(await status.locator('img').count(),1);assert.equal(await status.locator('.run-status-heading').count(),0);
 await page.evaluate(()=>window.update({running:false,workflow:[{id:'p-completion-initial',kind:'message',status:'completed',actor:'Dreamatic',label:'Project completion summary',stage:'completion',detail:'Project completed\nUsage: 100 text tokens',artifactRefs:['runs/p/final/artifacts/site/index.html']}]}));
 const message=page.locator('.workflow-message-bubble');await message.getByText(/Project completed/).waitFor();assert.equal(await message.locator('details').count(),0);assert.equal(await message.getByRole('link',{name:'View project'}).getAttribute('href'),'/assets/runs/p/final/artifacts/site/index.html');assert.equal(await message.getByRole('link',{name:'Download project'}).getAttribute('href'),'/api/runs/p/export');
 await t.test('nested actions keep the reading position and do not toggle their parent agent',async()=>{
  await page.evaluate(()=>window.update({running:false,workflow:[{id:'agent',kind:'agent',status:'running',actor:'Designer',label:'Designer actions',children:Array.from({length:45},(_,index)=>({id:`action-${index}`,kind:'tool',status:'completed',actor:'Designer',label:`Action ${index}`,input:'Action input',output:'Action result'}))}]}));
  const agent=page.locator('.workflow-agent-card'),action=page.locator('.workflow-event-card').nth(20),scroll=page.locator('.agent-scroll');
  await action.waitFor({state:'visible'});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await action.evaluate(element=>{
   const container=element.closest('.agent-scroll');
   container.scrollTop+=element.getBoundingClientRect().top-container.getBoundingClientRect().top-120;
  });
  const before=await scroll.evaluate(element=>element.scrollTop);
  assert.ok(before>200,'the parent heading must be above the viewport');
  await action.locator('summary').click();
  await page.waitForTimeout(500);
  assert.equal(await action.evaluate(element=>element.open),true);
  assert.ok(Math.abs(await scroll.evaluate(element=>element.scrollTop)-before)<1,'expanding an action must preserve scroll position');
  await action.locator('summary').click();
  await page.waitForTimeout(100);
  assert.equal(await action.evaluate(element=>element.open),false);
  assert.equal(await agent.evaluate(element=>element.open),true,'closing a nested action must leave its agent expanded');
  assert.ok(Math.abs(await scroll.evaluate(element=>element.scrollTop)-before)<1,'collapsing an action must preserve scroll position');
 });
});
