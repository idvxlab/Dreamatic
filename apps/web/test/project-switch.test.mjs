import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';
import { browserExecutable } from '../../../packages/design-agent/dist/html-delivery.js';

test('project switches isolate live callbacks, completion, stop and delayed session creation', {timeout:60_000}, async t => {
  const executablePath = await browserExecutable();
  if (!executablePath) { t.skip('Chromium unavailable'); return; }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const app = fileURLToPath(new URL('../src/App.tsx', import.meta.url));
  const i18n = fileURLToPath(new URL('../src/i18n.tsx', import.meta.url));
  const entry = 'virtual:project-switch', mockApi = 'virtual:project-api';
  const api = `
    const runs = ['A','B','C'].map(id => ({id,title:'Project '+id,status:'draft',stages:{},activity:[],assetCount:0,documents:[],notes:[],agentSessions:[],...(id==='C'?{}:{sessionId:'session-'+id})}));
    const sessions = ['A','B'].map(id => ({id:'session-'+id,title:'Session '+id,projectId:id,running:false}));
    const prompts = new Map(), creations = new Map(), stopped = [];
    window.testApi = {prompts,creations,stopped,emit(id,text){prompts.get(id).callback({type:'event',event:{type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}}});},finish(id){sessions.find(s=>s.id===id).running=false;prompts.get(id).resolve();},finishCreation(id){const session={id:'session-'+id,projectId:id,title:'Session '+id,running:false};sessions.push(session);runs.find(run=>run.id===id).sessionId=session.id;creations.get(id)(session);}};
    export async function listSessions(){return structuredClone(sessions)}
    export async function listRuns(){return structuredClone(runs)}
    export async function getRun(id){return structuredClone(runs.find(run=>run.id===id))}
    export async function getHealth(){return {ok:true}}
    export async function listAssets(){return []}
    export async function listRunAssets(){return []}
    export async function getWorkflow(id){return [{id:'workflow-'+id,kind:'message',status:'completed',actor:'User',label:'Persisted '+id,at:new Date().toISOString()}]}
    export function streamWorkflow(id,callback){callback({type:'snapshot',workflow:[]});return ()=>{}}
    export function streamPrompt(id,text,images,callback){sessions.find(s=>s.id===id).running=true;return new Promise(resolve=>prompts.set(id,{callback,resolve}))}
    export async function createSession(id){return new Promise(resolve=>creations.set(id,resolve))}
    export async function abortSession(id){stopped.push(id);sessions.find(s=>s.id===id).running=false;return {id,interrupted:true}}
    export async function getPublicationStatus(){return {site:'test',published:false,mayExist:false,inProgress:false}}
    export async function getCanvasState(){return null}
    export async function saveCanvasState(id,state){return state}
    export async function getHtmlPreview(){return {url:'',entries:[]}}
    export async function downloadProject(){}
    export async function publishProject(){}
    export async function renameRun(){}
    export async function deleteRun(){}
    export async function getRuntimeConfig(){}
    export async function saveRuntimeConfig(){}
    export async function openProjectAssets(){}
  `;
  const bundle = await build({root,configFile:false,logLevel:'silent',esbuild:{jsx:'automatic'},plugins:[{
    name:'project-switch-fixture', enforce:'pre',
    resolveId(id,importer){if(id===entry || id===mockApi)return id;if(((id==='./api'||id==='../api')&&importer?.includes('/src/'))||id.endsWith('/src/api.ts'))return mockApi;},
    load(id){if(id===mockApi)return api;if(id===entry)return `import React from 'react';import {createRoot} from 'react-dom/client';import {App} from ${JSON.stringify(app)};import {I18nProvider} from ${JSON.stringify(i18n)};createRoot(document.getElementById('root')).render(React.createElement(I18nProvider,null,React.createElement(App)));`;}
  }],build:{write:false,minify:false,rollupOptions:{input:entry}}});
  const js = bundle.output.find(item=>item.type==='chunk').code;
  const css = await readFile(new URL('../src/styles.css',import.meta.url),'utf8');
  const server = createServer((request,response)=>{
    response.setHeader('Content-Type',request.url==='/bundle.js'?'text/javascript':request.url==='/style.css'?'text/css':'text/html');
    response.end(request.url==='/bundle.js'?js:request.url==='/style.css'?css:'<html><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/bundle.js"></script></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
  const {chromium}=await import('playwright-core');
  const browser=await chromium.launch({executablePath,headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(5000);
  page.on('pageerror',error=>console.error(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.waitForFunction(()=>!document.querySelector('.composer textarea')?.disabled).catch(async error=>{console.error(await page.locator('body').innerText());throw error});
  const select = id => page.locator('.project-select').filter({hasText:'Project '+id}).click();
  const heading = page.locator('.workspace-header h2');
  await page.locator('.composer textarea').fill('Run A');await page.locator('.composer .send').click();
  await page.waitForFunction(()=>window.testApi.prompts.has('session-A'));
  await page.evaluate(()=>window.testApi.emit('session-A','A visible text'));
  await page.getByText('A visible text',{exact:true}).waitFor();
  await select('B');await page.locator('.composer textarea').fill('Run B');await page.locator('.composer .send').click();
  await page.waitForFunction(()=>window.testApi.prompts.has('session-B'));
  await page.evaluate(()=>{window.testApi.emit('session-A','A stale text');window.testApi.emit('session-B','B visible text');});
  await page.getByText('B visible text',{exact:true}).waitFor();
  assert.equal(await page.getByText('A stale text',{exact:true}).count(),0);
  await select('A');await page.evaluate(()=>window.testApi.emit('session-A','A resumed text'));
  await page.getByText('A resumed text',{exact:true}).waitFor();
  await select('B');await page.evaluate(()=>window.testApi.emit('session-B','B visible text'));
  await page.getByText('B visible text',{exact:true}).waitFor();
  await page.evaluate(()=>window.testApi.finish('session-A'));
  await page.waitForTimeout(100);
  assert.equal(await heading.textContent(),'Project B');assert.equal(await page.locator('.agent-stop').count(),1);
  assert.equal(await page.getByText('B visible text',{exact:true}).count(),1);
  await page.locator('.agent-stop').click();
  assert.deepEqual(await page.evaluate(()=>window.testApi.stopped),['session-B']);
  await page.evaluate(()=>window.testApi.finish('session-B'));
  await select('C');await page.waitForFunction(()=>window.testApi.creations.has('C'));
  await select('B');await page.evaluate(()=>window.testApi.finishCreation('C'));await page.waitForTimeout(100);
  assert.equal(await heading.textContent(),'Project B');
  await page.locator('.composer textarea').fill('B remains selected');await page.locator('.composer .send').click();
  await page.waitForFunction(()=>window.testApi.prompts.get('session-B') && document.querySelector('.agent-stop'));
  assert.equal(await page.evaluate(()=>window.testApi.prompts.has('session-C')),false);
});
