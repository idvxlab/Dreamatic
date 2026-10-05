import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';
import { browserExecutable } from '../../../packages/design-agent/dist/html-delivery.js';

// Render the actual React Canvas in a browser; API responses represent committed deliveries.
test('Preview opens the designed HTML with working interactions, retries failures and preserves Gallery routing', {timeout:60_000}, async (t) => {
  const executablePath = await browserExecutable();
  if (!executablePath) { t.skip('Chromium unavailable'); return; }
  const canvasPath = fileURLToPath(new URL('../src/components/Canvas.tsx', import.meta.url));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const entry = 'virtual:showcase-test';
  const bundle = await build({ root, configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic' },
    plugins: [{ name: 'showcase-fixture', resolveId(id) { if (id === entry) return entry; }, load(id) {
      if (id !== entry) return;
      return `import React from 'react'; import {createRoot} from 'react-dom/client'; import {Canvas} from ${JSON.stringify(canvasPath)};
const root = createRoot(document.getElementById('root'));
window.setRun = (run) => root.render(React.createElement(Canvas, {run, assets: [], onSelect() {}}));
window.setRun(window.initialRun);`;
    } }], build: { write: false, rollupOptions: { input: entry }, minify: false } });
  const js = bundle.output.find((item) => item.type === 'chunk').code;
  const baseRun = { id: 'ux', title: 'Academic homepage', status: 'complete', stages: { build: 'completed' }, notes: [], documents: [], activity: [], agentSessions: [], assetCount: 0 };
  const ux = { ...baseRun, presentation: { mode: 'html', entry: 'artifacts/academic/index.html' }, showcasePath: 'runs/ux/final/artifacts/academic/index.html' };
  let calls = 0, failNext = false, exportCalls = 0, failExport = false, invalidExport = undefined;
  const entries = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); return; }
    if (req.url.endsWith('/canvas')) { res.setHeader('Content-Type', 'application/json'); res.end('null'); return; }
    if (req.url.endsWith('/preview')) {
      calls++; let body = ''; for await (const chunk of req) body += chunk;
      entries.push(JSON.parse(body).entry);
      res.setHeader('Content-Type', 'application/json');
      if (failNext) { failNext = false; res.statusCode = 503; res.end(JSON.stringify({ error: 'Preview temporarily unavailable' })); return; }
      const origin = `http://127.0.0.1:${server.address().port}`;
      res.end(JSON.stringify({ url: origin + '/designed/index.html', entries: [{ path: ux.presentation.entry, url: origin + '/designed/index.html' }] })); return;
    }
    if (req.url.endsWith('/export')) {
      exportCalls++;
      if (failExport) { failExport = false; res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({error:'Export temporarily unavailable'})); return; }
      if (invalidExport === 'html') { invalidExport = undefined; res.setHeader('Content-Type','text/html'); res.end('<!doctype html><title>Dreamatic</title>'); return; }
      if (invalidExport === 'truncated') { invalidExport = undefined; res.setHeader('Content-Type','application/zip'); res.end(Buffer.from([0x50,0x4b,0x03,0x04,0,0])); return; }
      res.setHeader('Content-Type', 'application/zip'); res.end(Buffer.from('UEsDBBQAAAAIAK69RV2HWYxAHwAAAB8AAAASAAAAcHJvamVjdC9pbmRleC5odG1ss1FMyU8uqSxIVcgoyc2xs8kwtAsoSi3LTC230QeyAVBLAQIUAxQAAAAIAK69RV2HWYxAHwAAAB8AAAASAAAAAAAAAAAAAACAAQAAAABwcm9qZWN0L2luZGV4Lmh0bWxQSwUGAAAAAAEAAQBAAAAATwAAAAAA','base64')); return;
    }
    if (req.url === '/designed/index.html') { res.setHeader('Content-Type', 'text/html'); res.end('<html><head><link rel="stylesheet" href="style.css"></head><body><h1>Designed academic homepage</h1><button id="language">English</button><p id="greeting">你好</p><script src="app.js"></script></body></html>'); return; }
    if (req.url === '/designed/style.css') { res.setHeader('Content-Type', 'text/css'); res.end('h1{color:rgb(10,20,30)}'); return; }
    if (req.url === '/designed/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('document.querySelector("#language").onclick=()=>document.querySelector("#greeting").textContent="Hello"'); return; }
    if (req.url.startsWith('/assets/')) { res.setHeader('Content-Type', 'text/html'); res.end('<html><h1>Design Gallery</h1></html>'); return; }
    res.setHeader('Content-Type', 'text/html'); res.end(`<html><body><div id="root"></div><script>window.initialRun=${JSON.stringify(ux)}</script><script type="module" src="/bundle.js"></script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const showcase = page.getByRole('button', { name: 'Preview', exact: true });
    await showcase.waitFor(); assert.equal(calls, 0); // Fetch on click, using declared entry.
    await showcase.click();
    const frame = page.frameLocator('iframe');
    await frame.getByRole('heading', { name: 'Designed academic homepage' }).waitFor();
    assert.deepEqual(entries, [ux.presentation.entry]);
    assert.equal(await frame.locator('h1').evaluate((node) => getComputedStyle(node).color), 'rgb(10, 20, 30)');
    await frame.locator('#language').click(); assert.equal(await frame.locator('#greeting').textContent(), 'Hello');
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await page.getByRole('combobox', { name: 'Prototype viewport' }).count(), 0);
    assert.equal(await page.getByRole('link', {name:'Open',exact:true}).getAttribute('href'), `http://127.0.0.1:${server.address().port}/designed/index.html`);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', {name:'Export',exact:true}).click();
    const download = await downloadEvent; assert.equal(download.suggestedFilename(), 'ux.zip');
    assert.equal(exportCalls, 1);
    assert.equal((await readFile(await download.path())).readUInt32LE(0),0x04034b50);
    failExport = true; await page.getByRole('button', {name:'Export',exact:true}).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('alert').textContent(), 'Export temporarily unavailable');
    let invalidDownloads = 0;
    const onDownload = () => invalidDownloads++;
    page.on('download', onDownload);
    invalidExport = 'html'; await page.getByRole('button', {name:'Export',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Restart the Dreamatic server'}).waitFor();
    invalidExport = 'truncated'; await page.getByRole('button', {name:'Export',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'invalid or incomplete'}).waitFor();
    assert.equal(invalidDownloads,0); page.off('download',onDownload);
    failNext = true; await showcase.click();
    await page.getByRole('alert').waitFor();
    await page.getByRole('button', { name: 'Retry preview' }).click();
    await frame.getByRole('heading', { name: 'Designed academic homepage' }).waitFor();
    assert.equal(calls, 3);
    await page.evaluate((run) => window.setRun(run), { ...ux, id: 'pending', stages: { build: 'in_progress' } });
    await page.waitForFunction(() => document.querySelector('.canvas-view-switch button:last-child').disabled);
    await page.evaluate((run) => window.setRun(run), { ...baseRun, id: 'poster', showcasePath: 'runs/poster/artifacts/00-gallery.html', presentation: { mode: 'gallery', entry: 'artifacts/00-gallery.html' } });
    await page.waitForFunction(() => !document.querySelector('.canvas-view-switch button:last-child').disabled);
    await showcase.click();
    await frame.getByRole('heading', { name: 'Design Gallery' }).waitFor();
    assert.match(await page.locator('iframe').getAttribute('src'), /00-gallery.html$/);
    assert.match(await page.getByRole('link', {name:'Open',exact:true}).getAttribute('href'), /00-gallery.html$/);
    const galleryDownload = page.waitForEvent('download');
    await page.getByRole('button', {name:'Export',exact:true}).click();
    assert.equal((await galleryDownload).suggestedFilename(), 'poster.zip');
    assert.equal(exportCalls, 5);
    assert.equal(calls, 3); // Gallery never requests an HTML preview.
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  }
});
