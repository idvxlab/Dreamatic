import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';
import { browserExecutable } from '../../../scripts/browser-executable.mjs';

test('six workbench views preserve conversation, canvas and project isolation and share one document reader', { timeout: 60_000 }, async t => {
  const executablePath = await browserExecutable(); if (!executablePath) { t.skip('Chromium unavailable'); return; }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const entry = 'virtual:workbench-test';
  const app = fileURLToPath(new URL('../src/App.tsx', import.meta.url));
  const i18n = fileURLToPath(new URL('../src/i18n.tsx', import.meta.url));
  const bundle = await build({ root, configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic' }, plugins: [{ name: 'fixture', resolveId(id) { if (id === entry) return entry; }, load(id) { if (id === entry) return `import React from 'react';import {createRoot} from 'react-dom/client';import {App} from ${JSON.stringify(app)};import {I18nProvider} from ${JSON.stringify(i18n)};createRoot(document.getElementById('root')).render(React.createElement(I18nProvider,null,React.createElement(App)));`; } }], build: { write: false, rollupOptions: { input: entry }, minify: false } });
  const js = bundle.output.find(item => item.type === 'chunk').code;
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const a = { id: 'A', title: 'Project A', sessionId: 'session-A', status: 'completed', stages: { build: 'completed' }, createdAt: '', updatedAt: '', documents: ['research.md'], notes: [{ id: 'research', title: 'Research', path: 'research.md', text: 'Real research summary. '.repeat(100) }, { id: 'intent', title: 'Design intent', path: 'intent.md', text: 'Intent details. '.repeat(70) }, { id: 'plan', title: 'Design rationale', path: 'design.md', text: 'Design details. '.repeat(70) }], activity: [], agentSessions: [], assetCount: 1, showcasePath: 'runs/A/final/00-index.html' };
  const runs = [a]; const sessions = [{ id: 'session-A', projectId: 'A', title: a.title, messages: [], running: false }];
  const assets = [{ path: 'runs/A/artifacts/design.png', kind: 'png', role: 'other', label: 'Design image', size: 10, modifiedAt: '1' }];
  const files = [
    { id: 'research.md', path: 'research.md', title: 'research.md', kind: 'md', category: 'context', group: 'Design Context', modifiedAt: '1' },
    { id: 'slow.txt', path: 'slow.txt', title: 'slow.txt', kind: 'txt', category: 'context', group: 'Design Context', modifiedAt: '1' },
    { id: 'empty.txt', path: 'empty.txt', title: 'empty.txt', kind: 'txt', category: 'context', group: 'Design Context', modifiedAt: '1' },
    { id: 'broken.txt', path: 'broken.txt', title: 'broken.txt', kind: 'txt', category: 'context', group: 'Design Context', modifiedAt: '1' },
    { id: 'artifacts/design.png', path: 'artifacts/design.png', title: 'Design image', kind: 'png', category: 'assets', group: 'Generated works' },
    ...['pdf', 'mp4', 'html', 'docx'].map(kind => ({ id: `file.${kind}`, title: `file.${kind}`, kind, category: 'assets', group: 'Uploaded files' })),
    { id: 'citation:1', title: '[1] Source', kind: 'web', category: 'references', group: 'Bibliography', url: 'https://example.org/source', metadata: '[1] Actual source, 2024' },
  ];
  const summary = { schemaVersion: 1, runId: 'A', elapsedMs: 12000, executionMs: 10000, pausedMs: 2000, timingIncomplete: false, tokens: 500, unreportedCalls: 0, unreportedImageCalls: 0, deliverables: [{ kind: 'image', path: assets[0].path, label: 'Design image' }], stages: [{ stage: 'builder', durationMs: 10000, tokens: 500, attempts: 1, unreportedCalls: 0 }] };
  const workflow = [
    { id: 'image-progress', kind: 'tool', status: 'completed', actor: 'Builder', label: 'Saved image', imageProgress: { total: 1, items: { work: { ok: true, path: assets[0].path } } } },
    { id: 'summary', kind: 'message', status: 'completed', actor: 'Dreamatic', label: 'Summary', completion: summary },
  ];
  const saved = { version: 1, runId: 'A', updatedAt: '', camera: { x: 22, y: 33, zoom: 1 }, elements: [
    { id: 'canvas-overview-v3', kind: 'text', role: 'overview', text: 'Old overview', x: 0, y: 0, width: 100, height: 100 },
    { id: 'note-research', kind: 'text', text: 'Old context', x: 0, y: 0, width: 100, height: 100 },
    { id: 'custom-note', kind: 'text', text: 'My creative note', x: 75, y: 95, width: 240, height: 180 },
    { id: 'asset-runs/A/artifacts/design.png', kind: 'image', assetPath: assets[0].path, x: 500, y: 120, width: 350, height: 280 },
  ] };
  let persisted;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); return; }
    if (url.pathname === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); return; }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      const b = { ...a, id: 'B', title: 'Project B', sessionId: 'session-B', status: 'draft', stages: {}, notes: [], documents: [], showcasePath: undefined };
      const session = { id: b.sessionId, projectId: b.id, title: b.title, messages: [], running: false };
      runs.unshift(b); sessions.unshift(session); json(session); return;
    }
    if (url.pathname === '/api/health') { json({ ok: true }); return; }
    if (url.pathname === '/api/sessions') { json(sessions); return; }
    if (url.pathname === '/api/runs') { json(runs); return; }
    if (/^\/api\/runs\/[AB]$/.test(url.pathname)) { json(runs.find(run => run.id === url.pathname.split('/').at(-1))); return; }
    if (url.pathname.endsWith('/workflow/stream')) { res.setHeader('Content-Type', 'text/event-stream'); res.end('data: ' + JSON.stringify({ type: 'snapshot', workflow: url.pathname.includes('/A/') ? workflow : [] }) + '\n\n'); return; }
    if(url.pathname.endsWith('/media/edit/plan')) {
      let body='';for await(const part of req)body+=part;const input=JSON.parse(body);const target=input.sizeOptions?.target??{width:1086,height:1448};
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({sourceDimensions:{width:1086,height:1448},targetDimensions:target,requestSize:target.width+'x'+target.height,capabilitiesKnown:false,adapted:false,conflict:/2304/.test(input.prompt)&&target.height!==2304}));return;
    }
    if (url.pathname.endsWith('/media/edit')) {
      if(req.method==='GET'){json({enabled:true,configured:true,model:'fixture-editor',size:'auto'});return;}
      let body='';for await(const part of req)body+=part;const input=JSON.parse(body);assert.equal(input.id,'artifacts/design.png');assert.equal(input.prompt,'Use softer lighting');
      const file={id:'inputs/user-assets/refined.png',path:'inputs/user-assets/refined.png',title:'Refined image',kind:'png',category:'assets',group:'Uploaded files'};
      files.push(file);json(file);return;
    }
    if (url.pathname.endsWith('/media') && req.method === 'POST') {
      const name=url.searchParams.get('name');let bytes=0;for await(const chunk of req)bytes+=chunk.length;
      if(name==='broken.png'){res.statusCode=400;json({error:'Media upload failed. Please try again.'});return;}
      assert.ok(bytes>0);const path='inputs/user-assets/'+name;files.push({id:path,path,title:name,kind:name.split('.').at(-1),category:'assets',group:'Uploaded files'});json({id:path});return;
    }
    if (url.pathname.endsWith('/references/read')) { json({ title: 'Reference article', url: 'https://example.org/source', embeddingBlocked: false, nodes: [{ tag: 'p', children: [{ tag: 'text', text: 'Readable reference content' }] }] }); return; }
    if (url.pathname.endsWith('/publish')) { json({ published: false, mayExist: false, inProgress: false }); return; }
    if (url.pathname.endsWith('/canvas')) {
      if (req.method === 'PUT') { let body = ''; for await (const part of req) body += part; persisted = JSON.parse(body); json(persisted); }
      else json(url.pathname.includes('/A/') ? (persisted?.runId === 'A' ? persisted : saved) : null);
      return;
    }
    if (url.pathname.endsWith('/files/content')) {
      const id = url.searchParams.get('id');
      if (id === 'slow.txt') await new Promise(resolve => setTimeout(resolve, 500));
      if (id === 'broken.txt') { res.statusCode = 404; res.end('Missing'); return; }
      res.setHeader('Content-Type', 'text/plain');
      res.end(id === 'research.md' ? '# Full research\n\n| Topic | Value |\n|---|---|\n| Finding | Actual |\n\n[Unsafe](javascript:alert(1))\n\n<script>window.injected=true</script>\n\nFull text beyond summary.' : id === 'slow.txt' ? 'STALE FILE CONTENT' : ''); return;
    }
    if (url.pathname.endsWith('/files')) { json(url.pathname.includes('/A/') ? files : []); return; }
    if (url.pathname === '/api/assets' || url.pathname.endsWith('/assets')) { json(assets); return; }
    if (url.pathname.startsWith('/assets/')) { res.setHeader('Content-Type', url.pathname.endsWith('.png') ? 'image/png' : 'text/html'); res.end(url.pathname.endsWith('.png') ? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') : '<h1>Showcase work</h1>'); return; }
    res.setHeader('Content-Type', 'text/html'); res.end('<html><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/bundle.js"></script></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import('playwright-core'); const browser = await chromium.launch({ executablePath, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, locale: 'en-US' }); page.setDefaultTimeout(7000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('https://example.org/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Reference page</h1>' }));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const nav = label => page.locator('.sidebar nav').getByRole('button', { name: label, exact: true });
  await page.locator('.overview-heading h1').filter({ hasText: 'Project A' }).waitFor();
  await page.locator('.overview-images img').waitFor();
  assert.equal(await nav('Workbench').getAttribute('aria-current'), 'page');
  assert.equal(await page.locator('.sidebar nav button').count(), 6);
  const left = await page.locator('.sidebar').boundingBox(), tool = await page.locator('.workbench-tools').boundingBox(), right = await page.locator('.workspace').boundingBox();
  assert.ok(left.x + left.width <= tool.x + 1 && tool.x + tool.width <= right.x + 1);
  const sections = page.locator('.project-overview > details.overview-section');
  await page.locator('.project-overview .completion-summary').waitFor();
  assert.equal(await sections.count(), 4);
  assert.deepEqual(await sections.locator(':scope > summary h2').allTextContents(), ['Design Context', 'References', 'Generated Works', 'Runtime Summary']);
  const fonts = await sections.locator(':scope > summary h2').evaluateAll(nodes => nodes.map(node => { const s = getComputedStyle(node); return [s.fontSize, s.fontWeight, s.fontFamily].join('|'); }));
  assert.equal(new Set(fonts).size, 1);
  assert.equal(await page.locator('.project-overview .run-status-images').count(), 0);
  assert.equal(await page.locator('.agent-panel .run-status').count(), 0);
  assert.equal(await page.locator('.project-overview').getByText('Design task completed', { exact: true }).count(), 0);
  for (let i = 0; i < 4; i++) {
    const section = sections.nth(i);
    await section.locator(':scope > summary').click(); assert.equal(await section.getAttribute('open'), null);
    assert.equal(await section.locator('.overview-section-body').isVisible(), false);
    assert.equal(await sections.nth((i + 1) % 4).getAttribute('open'), '');
    await section.locator(':scope > summary').click(); assert.equal(await section.getAttribute('open'), '');
  }
  assert.deepEqual(await page.locator('.overview-note strong > span').allTextContents(), ['Research', 'Design Intent', 'Design Rationale']);
  const showcaseCard = page.locator('.overview-images').getByRole('button', {name: 'Showcase Page', exact: true});
  assert.equal(await showcaseCard.count(), 1);
  const notes = page.locator('.overview-context-grid .overview-note');
  assert.equal(await notes.count(), 3);
  const noteBoxes = await notes.evaluateAll(nodes => nodes.map(node => {const box=node.getBoundingClientRect();return {x:box.x,y:box.y,height:box.height};}));
  assert.ok(noteBoxes.every(box=>Math.abs(box.y-noteBoxes[0].y)<2), 'wide workspaces show context cards side by side');
  assert.ok(noteBoxes.every(box=>box.height<=180), 'context cards stay compact');
  const noteBody=notes.first().locator('.overview-note-body');
  const borderBefore=await notes.first().evaluate(node=>getComputedStyle(node).borderColor);
  const backgroundBefore=await notes.first().evaluate(node=>getComputedStyle(node).backgroundColor);
  assert.notEqual(backgroundBefore,await sections.first().evaluate(node=>getComputedStyle(node).backgroundColor));
  await notes.first().hover();await page.waitForTimeout(180);
  assert.equal(await notes.first().evaluate(node=>getComputedStyle(node).borderColor),borderBefore);
  assert.notEqual(await notes.first().evaluate(node=>getComputedStyle(node).backgroundColor),backgroundBefore);
  const overviewScroll=await page.locator('.project-overview').evaluate(node=>node.scrollTop);
  await noteBody.hover();await page.mouse.wheel(0,200);
  await page.waitForFunction(()=>document.querySelector('.overview-note-body').scrollTop>0);
  assert.equal(await page.locator('.project-overview').evaluate(node=>node.scrollTop),overviewScroll,'scrolling the card must not move the overview');
  await notes.first().focus();await page.keyboard.press('ArrowDown');
  assert.ok(await noteBody.evaluate(node=>node.scrollTop)>0);
  await page.screenshot({ animations: 'disabled', path: '/tmp/dreamatic-workbench-overview.png' });
  await page.getByRole('button',{name:'Hide tool panel',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  const narrowNotes=await notes.evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().x));
  assert.ok(narrowNotes.every(x=>Math.abs(x-narrowNotes[0])<2),'narrow workspaces stack context cards');
  assert.equal(await page.locator('.overview-context-grid').evaluate(node=>node.scrollWidth>node.clientWidth),false);
  await page.setViewportSize({width:1600,height:1000});
  await page.getByRole('button',{name:'Show tool panel',exact:true}).click();

  const resizer = page.getByRole('separator', { name: 'Resize tool panel' });
  const grip = await resizer.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 200); await page.mouse.down(); await page.mouse.move(grip.x + 103, grip.y + 200, { steps: 6 }); await page.mouse.up();
  const widened = await page.locator('.workbench-tools').boundingBox(); assert.ok(widened.width > tool.width + 90);
  await page.getByRole('button', { name: 'Hide tool panel', exact: true }).click();
  await page.getByRole('button', { name: 'Hide project panel', exact: true }).click();
  assert.equal(await page.locator('.sidebar').isVisible(), false); assert.equal(await page.locator('.workbench-tools').isVisible(), false);
  assert.ok((await page.locator('.workspace').boundingBox()).width >= 1599);
  await page.getByRole('button', { name: 'Show project panel', exact: true }).click();
  await page.getByRole('button', { name: 'Show tool panel', exact: true }).click();
  assert.ok(Math.abs((await page.locator('.workbench-tools').boundingBox()).width - widened.width) < 2);
  const movedGrip = await resizer.boundingBox(); await page.mouse.move(movedGrip.x + 3, movedGrip.y + 200); await page.mouse.down(); await page.mouse.move(0, movedGrip.y + 200, { steps: 6 }); await page.mouse.up();
  assert.equal(Math.round((await page.locator('.workbench-tools').boundingBox()).width), 320);
  await resizer.focus(); await page.keyboard.press('End');
  assert.ok((await page.locator('.workspace').boundingBox()).width >= 359);
  assert.equal(await page.locator('.workspace-header').evaluate(node => node.scrollWidth > node.clientWidth), false);
  await page.keyboard.press('Home'); assert.equal(Math.round((await page.locator('.workbench-tools').boundingBox()).width), 320);
  await resizer.dblclick();

  await showcaseCard.click();
  await page.frameLocator('.showcase-view iframe').getByRole('heading', {name: 'Showcase work'}).waitFor();
  await nav('Workbench').click();
  await page.locator('.composer textarea').fill('Unsent idea');
  await nav('Canvas').click(); await page.getByText('My creative note', { exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-files').isVisible(), true);
  assert.equal(await page.locator('.composer textarea').isVisible(), false);
  assert.equal(await page.locator('.document-viewer').count(), 0);
  assert.equal(await page.locator('.workspace-file-item').filter({hasText:'file.html'}).count(),0);
  assert.equal(await page.locator('.workspace-file-item').filter({hasText:'file.pdf'}).count(),0);
  const upload=page.getByLabel('Upload media files');
  const dropZone=page.getByRole('button',{name:'Upload media',exact:true});
  assert.equal(await page.locator('.workspace-files > .agent-header').getByRole('button',{name:'Upload media'}).count(),0);
  assert.ok((await dropZone.boundingBox()).y < (await page.locator('.workspace-file-group').first().boundingBox()).y);
  const chooser=page.waitForEvent('filechooser');await dropZone.click();await (await chooser).setFiles({name:'chosen.png',mimeType:'image/png',buffer:Buffer.from('chosen-image')});
  await page.locator('.workspace-file-item').filter({hasText:'chosen.png'}).waitFor();
  await dropZone.evaluate(node=>{
    const files=new DataTransfer();files.items.add(new File(['fixture'],'dropped.png',{type:'image/png'}));
    node.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:files}));
  });
  await page.getByText('Drop files to upload',{exact:true}).waitFor();
  await dropZone.evaluate(node=>{const files=new DataTransfer();files.items.add(new File(['fixture'],'dropped.png',{type:'image/png'}));node.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:files}));});
  await page.locator('.workspace-file-item').filter({hasText:'dropped.png'}).waitFor();
  await dropZone.evaluate(node=>{const data=new DataTransfer();data.setData('application/x-dreamatic-project-media',JSON.stringify({runId:'A',fileId:'artifacts/design.png'}));node.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data}));});
  assert.equal(await dropZone.evaluate(node=>node.classList.contains('drag-over')),false);
  await upload.setInputFiles({name:'not-media.html',mimeType:'text/html',buffer:Buffer.from('no')});
  await page.getByRole('alert').filter({hasText:'Only image and video files'}).waitFor();

  await upload.setInputFiles({name:'new-media.png',mimeType:'image/png',buffer:Buffer.from('fixture-image')});
  await page.locator('.workspace-file-item').filter({hasText:'new-media.png'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Upload media',exact:true}).getAttribute('aria-disabled'),'false');
  await page.locator('.workspace-file-item').filter({hasText:'new-media.png'}).dragTo(page.locator('.canvas-viewport'),{targetPosition:{x:220,y:180}});
  await page.locator('.canvas-artboard.selected strong').filter({hasText:'new-media.png'}).waitFor();
  await page.getByRole('button',{name:'Remove selected element'}).click();
  await upload.setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('bad')});
  await page.getByRole('alert').filter({hasText:'Media upload failed'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Upload media',exact:true}).getAttribute('aria-disabled'),'false');
  await page.getByRole('button', { name: 'Reset to 100%' }).click();
  assert.equal(await page.locator('.canvas-project-overview').count(), 0);
  assert.equal(await page.getByText('Old context', { exact: true }).count(), 0);
  assert.equal(await page.getByText('My creative note', { exact: true }).evaluate(node => node.style.left), '75px');
  for (let attempt = 0; !persisted && attempt < 30; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(persisted); assert.equal(persisted.camera.x, 22); assert.equal(persisted.elements.find(item => item.id === 'custom-note').y, 95);
  const initialMediaCount = await page.locator('.canvas-artboard').count();
  await page.locator('.workspace-file-item').filter({hasText:'Design image'}).dragTo(page.locator('.canvas-viewport'),{targetPosition:{x:220,y:180}});
  await page.waitForFunction(count => document.querySelectorAll('.canvas-artboard').length === count + 1, initialMediaCount);
  await nav('Workbench').click();
  assert.equal(await page.locator('.composer textarea').inputValue(), 'Unsent idea');
  await nav('Canvas').click();
  assert.equal(await page.locator('.canvas-artboard').count(), initialMediaCount + 1);
  await page.locator('.workspace-file-item').filter({ hasText: 'Design image' }).click();
  assert.equal(await page.locator('.document-viewer').count(), 0);
  await page.locator('.workspace-file-row').filter({has:page.locator('strong',{hasText:'Design image'})}).getByRole('button',{name:'Edit image: Design image',exact:true}).click();
  const editDialog=page.locator('dialog[open]');await editDialog.getByRole('tab',{name:'Edit with prompt',exact:true}).click();await editDialog.getByText('fixture-editor',{exact:true}).waitFor();
  await editDialog.getByLabel('Edit prompt',{exact:true}).fill('Use softer lighting');await editDialog.getByRole('button',{name:'Generate edit',exact:true}).click();
  await editDialog.getByText('Edited image saved to the asset list.',{exact:true}).waitFor();
  await page.locator('.workspace-file-label strong').filter({hasText:'Refined image'}).waitFor();
  assert.equal(await editDialog.isVisible(),true,'catalog refresh must preserve the open result preview');
  await editDialog.getByRole('button',{name:'Confirm',exact:true}).click();
  await page.locator('.canvas-artboard figcaption strong').filter({hasText:'Refined image'}).waitFor();
  await nav('Preview').click(); assert.equal(await page.locator('.workbench-tools').isVisible(), false);
  const expanded = await page.locator('.workspace').boundingBox(); assert.ok(expanded.width > right.width + 300);
  await page.frameLocator('.showcase-view iframe').getByRole('heading', { name: 'Showcase work' }).waitFor();
  const frameBox = await page.locator('.showcase-view iframe').boundingBox(); assert.ok(frameBox.width > 500 && frameBox.height > 500, 'Showcase must have a visible workspace-sized viewport');
  for (const name of ['Export', 'Portfolio PDF', 'Publish', 'Share']) {
    const button = page.locator('.preview-actions').getByRole('button', { name, exact: true });
    assert.equal(await button.isVisible(), true);
    const box = await button.boundingBox(); assert.ok(box.x >= expanded.x && box.x + box.width <= expanded.x + expanded.width && box.y >= expanded.y && box.y + box.height <= expanded.y + expanded.height);
  }
  await page.screenshot({ animations: 'disabled', path: '/tmp/dreamatic-workbench-preview.png' });
  await page.getByRole('button', { name: 'Show tool panel', exact: true }).click();
  assert.equal(await page.locator('.composer textarea').inputValue(), 'Unsent idea');
  assert.equal(await page.locator('.composer textarea').isVisible(), true);
  assert.equal(await page.locator('.workspace-files').count(), 0);
  assert.ok((await page.locator('.showcase-view iframe').boundingBox()).height > 500);
  await page.getByRole('button', { name: 'Hide tool panel', exact: true }).click();

  await nav('Workbench').click(); assert.equal(await page.locator('.composer textarea').inputValue(), 'Unsent idea'); assert.equal(await page.locator('.workbench-tools').isVisible(), true);
  await nav('Context').click(); await page.getByRole('heading', { name: 'Full research', exact: true }).waitFor();
  assert.equal(await page.locator('.document-viewer').count(), 1); assert.equal(await page.locator('.document-markdown table td').count(), 2); assert.equal(await page.locator('.document-markdown a[href^="javascript:"]').count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
  const file = label => page.locator('.workspace-file-item').filter({ has: page.locator('strong', { hasText: label }) });
  await file('slow.txt').click(); await file('research.md').click(); await page.getByRole('heading', { name: 'Full research', exact: true }).waitFor();
  await page.waitForTimeout(650); assert.equal(await page.getByText('STALE FILE CONTENT', { exact: true }).count(), 0);
  await file('empty.txt').click(); await page.getByText('This document is empty').waitFor();
  await file('broken.txt').click(); await page.getByRole('alert').filter({ hasText: 'Could not load this document' }).waitFor();
  await nav('Asset library').click(); await page.locator('.document-image').waitFor();
  await file('file.pdf').click(); assert.match(await page.locator('.document-frame').getAttribute('src'), /file.pdf/);
  await file('file.mp4').click(); await page.locator('video[controls]').waitFor();
  await file('file.html').click(); assert.equal(await page.locator('.document-frame').getAttribute('sandbox'), '');
  await file('file.docx').click(); await page.getByText('Preview is unavailable for this format. Open or download the original file.').waitFor();
  await nav('References').click(); assert.equal(await page.locator('.document-viewer').count(), 1); assert.equal(await page.getByRole('link', { name: 'Open original' }).getAttribute('href'), 'https://example.org/source');
  await page.getByRole('heading', { name: 'Reference article', exact: true }).waitFor();
  assert.equal(await page.locator('.document-frame').count(), 0);
  await page.getByRole('tab', { name: 'Original page', exact: true }).click();
  assert.match(await page.locator('.document-frame').getAttribute('sandbox'), /allow-scripts/);
  await page.getByText('Source details', { exact: true }).click(); await page.getByText('[1] Actual source, 2024', { exact: true }).waitFor();
  await page.screenshot({ animations: 'disabled', path: '/tmp/dreamatic-workbench-references.png' });
  await page.getByRole('button', { name: 'Hide tool panel', exact: true }).click();
  await page.setViewportSize({ width: 1024, height: 768 }); assert.equal(await page.locator('.workspace').evaluate(node => node.scrollWidth > node.clientWidth), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Show tool panel', exact: true }).click();
  const mobileTool = await page.locator('.workbench-tools').boundingBox(); assert.ok(mobileTool.width <= 390 && mobileTool.x >= 0);
  await page.getByRole('button', { name: 'Hide tool panel', exact: true }).click();
  await page.getByRole('button', { name: 'Show project panel', exact: true }).click();
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  await page.getByRole('button', { name: 'Hide project panel', exact: true }).click();
  await page.getByRole('button', { name: 'Show tool panel', exact: true }).click();
  await file('[1] Source').click(); assert.equal(await page.locator('.workbench-tools').isVisible(), false);
  await page.screenshot({ animations: 'disabled', path: '/tmp/dreamatic-workbench-mobile.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.locator('.workspace-header h2').filter({ hasText: 'Project B' }).waitFor();
  assert.equal(await nav('Workbench').getAttribute('aria-current'), 'page'); await page.locator('.overview-welcome svg').waitFor();
  assert.equal(await page.locator('.document-frame').count(), 0); assert.equal(await page.locator('.workbench-tools').isVisible(), true);
  await nav('Preview').click(); await page.getByRole('heading', { name: 'No works to preview yet' }).waitFor();
  await page.locator('.project-select').filter({ hasText: 'Project A' }).click();
  await nav('Canvas').click();
  await page.waitForFunction(count => document.querySelectorAll('.canvas-artboard').length === count + 2, initialMediaCount);
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.canvas-artboard').count(), initialMediaCount + 2, 'old add requests cannot replay after revisiting the project');
  // HTML-only deliveries must still appear in Generated Works without design images.
  assets.splice(0); files.splice(0); a.notes = []; a.documents = [];
  await page.reload();
  await page.locator('.project-select').filter({hasText:'Project A'}).click();
  await nav('Workbench').click();
  await page.locator('.overview-heading h1').filter({hasText:'Project A'}).waitFor();
  await page.locator('.overview-images').getByRole('button',{name:'Showcase Page',exact:true}).waitFor();
  assert.equal(await page.locator('.overview-images img').count(),0);
  assert.equal(await page.getByRole('heading',{name:'Generated Works',exact:true}).count(),1);
  assert.deepEqual(errors, []);
});
