import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';
import { browserExecutable } from '../../../scripts/browser-executable.mjs';

test('file rows prefer real thumbnails, distinguish file categories and recover failed previews across projects', { timeout: 30000 }, async t => {
  const executablePath = await browserExecutable(); if (!executablePath) { t.skip('Chromium unavailable'); return; }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const component = fileURLToPath(new URL('../src/components/WorkspaceFileList.tsx', import.meta.url));
  const entry = 'virtual:file-list-preview';
  const bundle = await build({ root, configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic' }, plugins: [{ name: 'fixture', resolveId(id) { if (id === entry) return entry; }, load(id) { if (id === entry) return `import React from 'react';import {createRoot} from 'react-dom/client';import {WorkspaceFileList} from ${JSON.stringify(component)};const root=createRoot(document.getElementById('root'));function Fixture(){const [runId,setRunId]=React.useState('A'),[selected,setSelected]=React.useState(),[files,setFiles]=React.useState(window.initialFiles);window.setRunId=setRunId;window.setFiles=setFiles;return React.createElement(WorkspaceFileList,{runId,files,selected,title:'Asset library',loading:false,onRetry(){},onSelect(file){setSelected(file.id);window.selectedFile=file.id}})}root.render(React.createElement(Fixture));`; } }], build: { write: false, minify: false, rollupOptions: { input: entry } } });
  const js = bundle.output.find(item => item.type === 'chunk').code;
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const kinds = ['md', 'txt', 'json', 'html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'mp4', 'webm', 'mov', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'glb', 'gltf', 'web', 'unknown'];
  const files = kinds.map(kind => ({ id: `file.${kind}`, title: `file.${kind}`, path: `inputs/user-assets/file.${kind}`, kind, category: 'assets', group: 'Uploaded files', ...(kind === 'web' ? { url: 'https://example.org/source' } : {}) }));
  files.unshift({ id: 'cover.pdf', title: 'Covered PDF', path: 'cover.pdf', kind: 'pdf', category: 'assets', group: 'Uploaded files', thumbnailUrl: '/covers/pdf.png' });
  files.unshift({ id: 'attachment:0', title: 'Uploaded image', kind: 'png', category: 'assets', group: 'Uploaded files' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); return; }
    if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); return; }
    if (req.url.startsWith('/assets/') || req.url.startsWith('/api/') || req.url.startsWith('/covers/')) {
      if ((req.url.includes('file.jpg') || req.url.includes('file.svg')) && req.url.includes('/runs/A/')) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', 'image/png'); res.end(png); return;
    }
    res.setHeader('Content-Type', 'text/html'); res.end(`<html><link rel="stylesheet" href="/style.css"><style>body{overflow:auto}#root{width:320px;height:700px}</style><div id="root"></div><script>window.initialFiles=${JSON.stringify(files)}</script><script type="module" src="/bundle.js"></script></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import('playwright-core'); const browser = await chromium.launch({ executablePath, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 380, height: 760 } }); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const row = title => page.locator('.workspace-file-item').filter({ has: page.locator('.workspace-file-label strong').getByText(title, { exact: true }) });
  async function loaded(title) {
    const image = row(title).locator('.file-list-preview img'); await image.scrollIntoViewIfNeeded();
    await image.evaluate(image => image.complete && image.naturalWidth > 0 ? undefined : new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; }));
    return image;
  }
  assert.match(await (await loaded('Uploaded image')).getAttribute('src'), /\/api\/runs\/A\/files\/content\?id=attachment%3A0/);
  assert.match(await (await loaded('Covered PDF')).getAttribute('src'), /\/covers\/pdf.png/);
  await loaded('file.png');
  const previewBox = await row('file.png').locator('.file-list-preview').boundingBox(); assert.equal(previewBox.width, 44); assert.equal(previewBox.height, 44);
  await row('file.jpg').scrollIntoViewIfNeeded(); await row('file.jpg').locator('.file-type-badge').waitFor();
  assert.equal(await row('file.jpg').locator('.file-list-preview img').count(), 0); assert.equal(await row('file.jpg').locator('.file-type-badge').textContent(), 'JPG');
  await row('file.svg').scrollIntoViewIfNeeded(); await row('file.svg').locator('.file-type-badge').waitFor();
  assert.equal(await row('file.svg').getByRole('img').getAttribute('aria-label'), 'Vector image');
  const expected = { md: 'Markdown document', txt: 'Plain text file', json: 'JSON data file', html: 'HTML document', htm: 'HTML document', pdf: 'PDF document', mp4: 'Video file', webm: 'Video file', mov: 'Video file', doc: 'Word document', docx: 'Word document', xls: 'Spreadsheet file', xlsx: 'Spreadsheet file', csv: 'Spreadsheet file', ppt: 'Presentation file', pptx: 'Presentation file', glb: '3D model', gltf: '3D model', web: 'Web reference', unknown: 'Other file' };
  for (const [kind, label] of Object.entries(expected)) {
    assert.equal(await row(`file.${kind}`).getByRole('img').getAttribute('aria-label'), label);
    assert.equal(await row(`file.${kind}`).locator('.file-type-badge').textContent(), kind === 'unknown' ? 'FILE' : kind.toUpperCase());
  }
  const icons = [];
  for (const kind of ['md', 'txt', 'json', 'html', 'pdf', 'svg', 'mp4', 'doc', 'xls', 'ppt', 'glb', 'web', 'unknown']) icons.push(await row(`file.${kind}`).locator('.file-list-preview > svg').getAttribute('class'));
  assert.equal(new Set(icons).size, icons.length, 'different file categories need different icon shapes');
  await row('file.pdf').click(); assert.equal(await page.evaluate(() => window.selectedFile), 'file.pdf'); assert.equal(await row('file.pdf').getAttribute('aria-pressed'), 'true');
  const long = { ...files[0], id: 'long.md', title: 'Long document title '.repeat(20), kind: 'md' };
  await page.evaluate(file => window.setFiles(current => [file, ...current]), long);
  const longRow = row(long.title); await longRow.scrollIntoViewIfNeeded();
  assert.equal(await longRow.evaluate(node => node.scrollWidth > node.clientWidth), false);
  assert.equal((await longRow.locator('.file-list-preview').boundingBox()).width, 44);
  await page.locator('.workspace-file-scroll').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: '/tmp/dreamatic-file-list-thumbnails.png', animations: 'disabled' });
  await page.evaluate(() => window.setRunId('B'));
  assert.match(await (await loaded('file.jpg')).getAttribute('src'), /\/runs\/B\//);
  assert.equal(await row('file.jpg').locator('.file-type-badge').count(), 0);
  assert.equal(requests.some(url => /content\?id=file\.(pdf|mp4|html)/u.test(url)), false, 'non-image files must not start heavy preview requests');
  assert.deepEqual(errors, []);
});
