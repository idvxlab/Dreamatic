import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { browserExecutable } from '../../../scripts/browser-executable.mjs';

test('canvas edits a multi-input graph, groups history, cascades outputs and never resurrects undone task results', { timeout: 60000 }, async t => {
  const executablePath = await browserExecutable(); if (!executablePath) { t.skip('Chromium unavailable'); return; }
  const root = fileURLToPath(new URL('..', import.meta.url)), canvas = fileURLToPath(new URL('../src/components/Canvas.tsx', import.meta.url));
  const entry = 'virtual:canvas-editor';
  const bundle = await build({ root, configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic' }, plugins: [{ name: 'fixture', resolveId(id) { if (id === entry) return entry; }, load(id) { if (id === entry) return `import React from 'react';import{createRoot}from'react-dom/client';import{Canvas}from ${JSON.stringify(canvas)};createRoot(document.getElementById('root')).render(React.createElement(Canvas,{run:{id:'demo'},files:window.fixtureFiles,visible:true,onSelectFile(){}}));`; } }], build: { write: false, rollupOptions: { input: entry } } });
  const js = bundle.output.find(item => item.type === 'chunk').code, css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const files = ['a', 'b', 'c'].map(id => ({ id: `artifacts/${id}.png`, path: `artifacts/${id}.png`, title: id, kind: 'png', category: 'assets', group: 'Generated works' }));
  let saved = { version: 1, runId: 'demo', camera: { x: 50, y: 30, zoom: .7 }, edges: [], elements: files.map((file, i) => ({ id: file.title, kind: 'image', fileId: file.id, text: file.title, x: 50, y: 40 + i * 250, width: 280, height: 200 })) };
  const tasks = new Map(), submissions = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/canvas')) {
      if (req.method === 'PUT') { let body = ''; for await (const chunk of req) body += chunk; saved = JSON.parse(body); }
      res.end(JSON.stringify(saved)); return;
    }
    if (url.pathname.endsWith('/editor')) {
      if (req.method === 'POST') { let body = ''; for await (const chunk of req) body += chunk; const input = JSON.parse(body); submissions.push(input); const task = { ...input, status: 'running', attempt: 1, createdAt: new Date().toISOString() }; tasks.set(task.id, task); res.end(JSON.stringify(task)); return; }
      res.end(JSON.stringify([...tasks.values()])); return;
    }
    if (url.pathname.endsWith('/files/content')) {
      if (url.searchParams.get('id') === 'inputs/user-assets/fused.png') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#96afc2"/></svg>'); return; }
      res.setHeader('Content-Type', 'image/png'); res.end(png); return;
    }
    if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js); return; }
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(`<style>${css}html,body,#root{margin:0;height:100%;}.canvas-shell{height:100vh;}</style><div id="root"></div><script>window.fixtureFiles=${JSON.stringify(files)}</script><script type="module" src="/fixture.js"></script>`); return; }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const card = id => page.locator(`[data-element-id="${id}"]`), edgeCount = () => page.locator('.canvas-connections path:not(.pending)').count();
  const undo = page.getByRole('button', { name: 'Undo', exact: true }), redo = page.getByRole('button', { name: 'Redo', exact: true });
  await card('a').waitFor();
  // Selection uses world coordinates at a non-default zoom and camera offset.
  const geometry = () => page.locator('[data-element-id]').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.elementId, { x: parseFloat(node.style.left), y: parseFloat(node.style.top) }])));
  const selected = () => page.locator('[data-element-id].selected').evaluateAll(nodes => nodes.map(node => node.dataset.elementId).sort());
  async function drag(from, to) { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up(); }
  const initialGeometry = await geometry(), initialCamera = await page.locator('.canvas-world').getAttribute('style');
  const aBox = await card('a').boundingBox(), bBox = await card('b').boundingBox(), cBox = await card('c').boundingBox();
  // Reverse-direction marquee intersects the first two cards only.
  await drag({ x: bBox.x + bBox.width + 12, y: bBox.y + bBox.height + 12 }, { x: aBox.x - 12, y: aBox.y - 12 });
  assert.deepEqual(await selected(), ['a', 'b']);
  assert.equal(await page.locator('.canvas-selection-box').count(), 0);
  assert.equal(await page.locator('.canvas-world').getAttribute('style'), initialCamera);
  assert.equal(await undo.isDisabled(), true, 'selection does not create history entries');
  await card('b').click({ position: { x: 50, y: 20 }, modifiers: ['Shift'] }); assert.deepEqual(await selected(), ['a']);
  await card('b').click({ position: { x: 50, y: 20 }, modifiers: ['Shift'] }); assert.deepEqual(await selected(), ['a', 'b']);
  await drag({ x: aBox.x + 30, y: aBox.y + 20 }, { x: aBox.x + 86, y: aBox.y + 48 });
  const movedGeometry = await geometry();
  for (const id of ['a', 'b']) { assert.ok(Math.abs(movedGeometry[id].x - initialGeometry[id].x - 80) < .1); assert.ok(Math.abs(movedGeometry[id].y - initialGeometry[id].y - 40) < .1); }
  assert.deepEqual(movedGeometry.c, initialGeometry.c); assert.deepEqual(await selected(), ['a', 'b']);
  await undo.click(); assert.deepEqual(await geometry(), initialGeometry);
  await redo.click(); assert.deepEqual(await geometry(), movedGeometry);
  await undo.click();
  // Shift-marquee appends to the existing selection; empty click clears it.
  await page.keyboard.down('Shift');
  await drag({ x: cBox.x - 12, y: cBox.y - 12 }, { x: cBox.x + cBox.width + 12, y: cBox.y + cBox.height + 12 });
  await page.keyboard.up('Shift'); assert.deepEqual(await selected(), ['a', 'b', 'c']);
  await page.mouse.click(650, 50); assert.deepEqual(await selected(), []);
  // Hand mode pans even when the gesture starts over a selected card.
  await card('a').click({ position: { x: 50, y: 20 } });
  await page.getByRole('button', { name: 'Pan canvas', exact: true }).click();
  await drag({ x: aBox.x + 30, y: aBox.y + 20 }, { x: aBox.x + 70, y: aBox.y + 50 });
  assert.notEqual(await page.locator('.canvas-world').getAttribute('style'), initialCamera);
  assert.deepEqual(await geometry(), initialGeometry); assert.deepEqual(await selected(), ['a']);
  await undo.click(); assert.equal(await page.locator('.canvas-world').getAttribute('style'), initialCamera);
  await page.getByRole('button', { name: 'Select and move elements', exact: true }).click();
  assert.deepEqual(await page.locator('.canvas-tool-group').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['Selection tools', 'Card actions', 'Edit history', 'Canvas view', 'Layout and guides']);
  await card('a').click({ position: { x: 50, y: 20 } }); await card('b').click({ position: { x: 50, y: 20 }, modifiers: ['Shift'] });
  assert.equal(await page.locator('.canvas-media.selected').count(), 2);
  await page.getByRole('button', { name: 'Create prompt card', exact: true }).click();
  const prompt = page.locator('.canvas-prompt').first(); await prompt.waitFor(); const promptId = await prompt.getAttribute('data-element-id');
  assert.equal(await edgeCount(), 2);
  assert.deepEqual(await prompt.getByLabel('Input images', {exact:true}).locator('span').allTextContents(), ['Image 1: a', 'Image 2: b']);
  // A prompt and image move together; connections track both endpoints.
  await card('a').click({ position: { x: 50, y: 20 } });
  await prompt.locator('header strong').click({ modifiers: ['Shift'] });
  assert.deepEqual(await selected(), ['a', promptId].sort());
  const mixedBefore = await geometry(), pathsBefore = await page.locator('.canvas-connections path').evaluateAll(nodes => nodes.map(node => node.getAttribute('d')));
  const headerBox = await prompt.locator('header strong').boundingBox();
  await drag({ x: headerBox.x + 10, y: headerBox.y + 5 }, { x: headerBox.x + 38, y: headerBox.y + 26 });
  const mixedAfter = await geometry();
  for (const id of ['a', promptId]) { assert.ok(Math.abs(mixedAfter[id].x - mixedBefore[id].x - 40) < .1); assert.ok(Math.abs(mixedAfter[id].y - mixedBefore[id].y - 30) < .1); }
  assert.deepEqual(mixedAfter.b, mixedBefore.b); assert.deepEqual(mixedAfter.c, mixedBefore.c);
  assert.notDeepEqual(await page.locator('.canvas-connections path').evaluateAll(nodes => nodes.map(node => node.getAttribute('d'))), pathsBefore);
  await page.waitForTimeout(800);
  for (const id of ['a', promptId]) { const node = saved.elements.find(node => node.id === id); assert.equal(node.x, mixedAfter[id].x); assert.equal(node.y, mixedAfter[id].y); }
  await undo.click(); assert.deepEqual(await geometry(), mixedBefore);
  assert.deepEqual(await page.locator('.canvas-connections path').evaluateAll(nodes => nodes.map(node => node.getAttribute('d'))), pathsBefore);
  await undo.click(); assert.equal(await page.locator('.canvas-prompt').count(), 0); assert.equal(await edgeCount(), 0);
  await redo.click(); assert.equal(await edgeCount(), 2);
  // Typing is one history transaction and restores text and graph together.
  await prompt.locator('textarea').fill('Fuse both sources'); await prompt.locator('textarea').blur();
  await undo.click(); assert.equal(await prompt.locator('textarea').inputValue(), '');
  await redo.click(); assert.equal(await prompt.locator('textarea').inputValue(), 'Fuse both sources');
  // A same-kind drag cannot add an edge; another image can share the same input port.
  await card('a').locator('.port-right').dragTo(card('b').locator('.port-left')); assert.equal(await edgeCount(), 2);
  await card('c').locator('.port-right').dragTo(prompt.locator('.port-left')); assert.equal(await edgeCount(), 3);
  // Select one line, delete it, undo/redo, then reconnect its source by dragging its handle.
  const path = page.locator('.canvas-connections path').first(); await path.focus(); await page.keyboard.press('Delete'); assert.equal(await edgeCount(), 2);
  await undo.click(); assert.equal(await edgeCount(), 3); await redo.click(); assert.equal(await edgeCount(), 2); await undo.click();
  const selectPath = page.locator('.canvas-connections path').first();
  await selectPath.evaluate(node => node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  const handle = page.getByRole('button', { name: 'Reconnect target', exact: true }); await handle.waitFor();
  await handle.dragTo(prompt.locator('.port-left')); assert.equal(await edgeCount(), 3);
  await prompt.getByRole('button', { name: 'Generate edit', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.canvas-prompt footer [role="status"]')?.getAttribute('data-task-status') === 'running');
  assert.equal(await prompt.locator('textarea').isDisabled(),true);assert.equal(await prompt.locator('textarea').inputValue(),'Fuse both sources');assert.equal(await prompt.locator('[role="status"] svg.spin').count(),1);assert.equal(await prompt.locator('[role="status"]').textContent(),'');
  assert.equal(submissions.length, 1); assert.deepEqual(new Set(submissions[0].inputIds), new Set(files.map(file => file.id))); assert.equal(submissions[0].upstream.length, 3);
  const firstTask = tasks.get(submissions[0].id);
  const output = { id: 'inputs/user-assets/fused.png', title: 'Fused image', kind: 'png', path: 'inputs/user-assets/fused.png', category: 'assets', group: 'Uploaded files' };
  tasks.set(firstTask.id, { ...firstTask, status: 'succeeded', output, size: '640x360', sizeSource: 'base-image', baseImageId: files[1].id });
  const outputCard = card(`editor-output-${firstTask.id}`); await outputCard.waitFor(); assert.equal(await edgeCount(), 4);
  assert.equal(await prompt.locator('textarea').isEnabled(),true);assert.equal(await prompt.locator('[role="status"] svg.spin').count(),0);
  assert.match(await prompt.locator('footer').textContent(), /Output size: 640x360/);
  assert.match(await prompt.locator('footer').textContent(), /Base image: b/);
  const outputSelector = `[data-element-id="editor-output-${firstTask.id}"]`;
  await page.waitForFunction(selector => { const node = document.querySelector(selector); return node && parseFloat(node.style.height) !== 280; }, outputSelector);
  const outputHeight = await outputCard.evaluate(node => parseFloat(node.style.height));
  const ratio = await outputCard.locator('img').evaluate(node => node.clientWidth / node.clientHeight);
  assert.ok(Math.abs(ratio - 640 / 360) < .02, 'image area matches the actual image aspect ratio');
  await undo.click(); assert.equal(await outputCard.count(), 0); assert.equal(await edgeCount(), 3);
  await page.waitForTimeout(1750); assert.equal(await outputCard.count(), 0, 'polling must not reinsert an undone output');
  await redo.click(); await outputCard.waitFor();
  assert.equal(await outputCard.evaluate(node => parseFloat(node.style.height)), outputHeight, 'redo restores measured geometry with the output insertion');
  // A generated image becomes an input to the next round with its task reference.
  await outputCard.click({ position: { x: 50, y: 20 } }); await page.getByRole('button', { name: 'Create prompt card', exact: true }).click();
  const nextPrompt = page.locator('.canvas-prompt').last(); await nextPrompt.locator('textarea').fill('Make a blue variant'); await nextPrompt.locator('textarea').blur();
  await page.getByRole('button', { name: 'Fit project', exact: true }).click();
  await nextPrompt.getByRole('button', { name: 'Generate edit', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.canvas-prompt footer [role="status"]')[1]?.getAttribute('data-task-status') === 'running');
  assert.equal(submissions.length, 2); assert.deepEqual(submissions[1].inputIds, [output.id]); assert.equal(submissions[1].upstream[0].taskId, firstTask.id);
  // Undo the task association, then the prompt itself before the provider returns.
  await undo.click(); await undo.click(); // fit camera, task association (ordering may include only these)
  const nextId = await nextPrompt.getAttribute('data-element-id');
  await nextPrompt.getByRole('button', { name: 'Delete prompt', exact: true }).click();
  const lastTask = tasks.get(submissions[1].id); tasks.set(lastTask.id, { ...lastTask, status: 'succeeded', output: { ...output, id: 'inputs/user-assets/blue.png', title: 'Blue variant' } });
  await page.waitForTimeout(1800);
  assert.equal(await card(nextId).count(), 0); assert.equal(await card(`editor-output-${lastTask.id}`).count(), 0);
  await page.waitForTimeout(800); assert.ok(saved.handledTaskIds.includes(lastTask.id)); assert.equal(saved.elements.some(node => node.id === nextId), false);
  await page.reload(); await card(promptId).waitFor(); await page.waitForTimeout(1800);
  assert.equal(await card(nextId).count(), 0); assert.equal(await card(`editor-output-${lastTask.id}`).count(), 0); assert.equal(await outputCard.count(), 1);
  assert.equal(await outputCard.evaluate(node => parseFloat(node.style.height)), outputHeight, 'reload preserves measured geometry');
  // Historical generated cards stuck at the placeholder size are measured when restored.
  saved = { ...saved, elements: saved.elements.map(node => node.outputTaskId === firstTask.id ? { ...node, width: 360, height: 280 } : node) };
  await page.reload(); await outputCard.waitFor();
  await page.waitForFunction(({ selector, height }) => Math.abs(parseFloat(document.querySelector(selector)?.style.height) - height) < 1, { selector: outputSelector, height: outputHeight });
  await page.waitForTimeout(800);
  // An explicitly resized card retains its dimensions on subsequent reloads.
  saved = { ...saved, elements: saved.elements.map(node => node.outputTaskId === firstTask.id ? { ...node, width: 500, height: 450 } : node) };
  await page.reload(); await outputCard.waitFor();
  await outputCard.locator('img').evaluate(image => image.decode());
  assert.equal(await outputCard.evaluate(node => parseFloat(node.style.height)), 450);
  assert.equal(await outputCard.evaluate(node => parseFloat(node.style.width)), 500);
  // Repeated shrinking must stop at the prompt minimum, including content-rich footers.
  await page.getByRole('button',{name:'Fit project',exact:true}).click();
  const promptCard=card(promptId), resizePrompt=promptCard.getByRole('button',{name:'Resize prompt',exact:true});
  async function resizePromptBy(dx,dy){const box=await resizePrompt.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+dx,box.y+box.height/2+dy,{steps:5});await page.mouse.up();}
  await resizePromptBy(-1000,-1000);
  const minimum=await promptCard.evaluate(node=>({width:parseFloat(node.style.width),height:parseFloat(node.style.height)}));
  assert.ok(minimum.width>=300&&minimum.height>=240);
  await resizePromptBy(-500,-500);
  assert.deepEqual(await promptCard.evaluate(node=>({width:parseFloat(node.style.width),height:parseFloat(node.style.height)})),minimum);
  assert.equal(await promptCard.evaluate(node=>{const card=node.getBoundingClientRect();return [...node.querySelectorAll('header,textarea,footer')].every(child=>{const rect=child.getBoundingClientRect();return rect.left>=card.left&&rect.right<=card.right+.5&&rect.bottom<=card.bottom+.5;});}),true);
  await resizePromptBy(45,45);assert.ok(await promptCard.evaluate((node,width)=>parseFloat(node.style.width)>width,minimum.width));
  await undo.click();assert.ok(Math.abs(await promptCard.evaluate(node=>parseFloat(node.style.width))-minimum.width)<.1);
  await redo.click();
  await page.waitForTimeout(800);
  saved={...saved,elements:saved.elements.map(node=>node.id===promptId?{...node,width:80,height:40}:node)};
  await page.reload();await card(promptId).waitFor();
  assert.ok(await card(promptId).evaluate(node=>parseFloat(node.style.width)>=300&&parseFloat(node.style.height)>=240));
  // Related toolbar buttons stay together inside a narrow viewport.
  await page.setViewportSize({ width: 520, height: 850 });
  await page.waitForTimeout(150);
  const toolbar = await page.locator('.canvas-toolbar').boundingBox();
  assert.ok(toolbar.x >= 0 && toolbar.x + toolbar.width <= 520 && toolbar.width > 400);
  assert.equal(await page.locator('.canvas-tool-group').evaluateAll(groups => groups.every(group => { const bounds = group.getBoundingClientRect(); return [...group.querySelectorAll('button')].every(button => { const rect = button.getBoundingClientRect(); return rect.top >= bounds.top && rect.bottom <= bounds.bottom; }); })), true);
  await page.screenshot({ path: '/tmp/dreamatic-canvas-toolbar-narrow.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1500, height: 1000 });
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/dreamatic-canvas-editor.png', animations: 'disabled' });
});
