import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';
import { browserExecutable } from '../../../scripts/browser-executable.mjs';

test('web references default to safe article reading, retain script-capable original viewing and isolate delayed responses', { timeout: 30000 }, async t => {
  const executablePath = await browserExecutable(); if (!executablePath) { t.skip('Chromium unavailable'); return; }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const component = fileURLToPath(new URL('../src/components/DocumentViewer.tsx', import.meta.url));
  const i18n = fileURLToPath(new URL('../src/i18n.tsx', import.meta.url));
  const entry = 'virtual:reference-reader';
  const bundle = await build({ root, configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic' }, plugins: [{ name: 'fixture', resolveId(id) { if (id === entry) return entry; }, load(id) { if (id === entry) return `import React from 'react';import {createRoot} from 'react-dom/client';import {DocumentViewer} from ${JSON.stringify(component)};import {I18nProvider} from ${JSON.stringify(i18n)};function Fixture(){const [file,setFile]=React.useState(window.initialFile);window.setFile=setFile;return React.createElement(DocumentViewer,{runId:'A',file})}createRoot(document.getElementById('root')).render(React.createElement(I18nProvider,null,React.createElement(Fixture)));`; } }], build: { write: false, minify: false, rollupOptions: { input: entry } } });
  const js = bundle.output.find(item => item.type === 'chunk').code;
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  const file = id => ({ id, title: 'Reference ' + id, category: 'references', group: 'Bibliography', kind: 'web', url: 'https://example.org/' + id, metadata: '[1] Original citation' });
  let denied = true; const requests = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); return; }
    if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); return; }
    if (req.url.startsWith('/api/runs/A/references/read')) {
      requests.push(req.url); const id = new URL(req.url, 'http://fixture').searchParams.get('id');
      if (id === 'slow') await new Promise(resolve => setTimeout(resolve, 500));
      res.setHeader('Content-Type', 'application/json');
      if (id === 'denied' && denied) { res.statusCode = 400; res.end(JSON.stringify({ error: 'The source website denied access or requires sign-in.' })); return; }
      res.end(JSON.stringify({ title: 'Article ' + id, url: 'https://example.org/' + id, embeddingBlocked: id === 'blocked', byline: 'Source author', nodes: [
        { tag: 'p', children: [{ tag: 'text', text: 'Full readable content ' + id }] },
        { tag: 'a', href: 'https://example.org/related', children: [{ tag: 'text', text: 'Related source' }] },
        { tag: 'script', children: [{ tag: 'text', text: 'window.injectedArticle=true' }] },
        { tag: 'a', href: 'javascript:alert(1)', children: [{ tag: 'text', text: 'Unsafe source' }] },
      ] })); return;
    }
    res.setHeader('Content-Type', 'text/html'); res.end(`<html><link rel="stylesheet" href="/style.css"><style>body{overflow:hidden}#root{height:100vh}</style><div id="root"></div><script>localStorage.setItem('dreamatic-ui-language','zh');window.initialFile=${JSON.stringify(file('good'))}</script><script type="module" src="/bundle.js"></script></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const { chromium } = await import('playwright-core'); const browser = await chromium.launch({ executablePath, headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1050, height: 850 } }); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('https://example.org/**', route => route.fulfill({ contentType: 'text/html', body: '<h1 id="title">Loading</h1><script>document.getElementById("title").textContent="JavaScript original page"</script>' }));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading', { name: 'Article good', exact: true }).waitFor();
  assert.equal(await page.locator('iframe').count(), 0); assert.equal(await page.evaluate(() => window.injectedArticle), undefined);
  assert.equal(await page.locator('.reference-article script').count(), 0); assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Related source' }).getAttribute('href'), 'https://example.org/related');
  assert.equal(await page.getByRole('link', { name: '打开原文', exact: true }).getAttribute('href'), 'https://example.org/good');
  assert.equal(await page.getByText('Some websites block embedded reading. Use Open original if the page stays blank.').count(), 0);
  await page.screenshot({ path: '/tmp/dreamatic-reference-reader.png', animations: 'disabled' });
  await page.getByRole('tab', { name: '原网页', exact: true }).click();
  await page.frameLocator('iframe').getByRole('heading', { name: 'JavaScript original page' }).waitFor();
  const sandbox = await page.locator('iframe').getAttribute('sandbox'); assert.match(sandbox, /allow-scripts/); assert.match(sandbox, /allow-same-origin/); assert.ok(!sandbox.includes('allow-top-navigation'));
  assert.ok((await page.locator('iframe').boundingBox()).height >= 300);
  await page.getByRole('button', { name: '页面无法显示？切换正文阅读', exact: true }).click(); await page.getByRole('heading', { name: 'Article good' }).waitFor();
  await page.evaluate(next => window.setFile(next), file('blocked')); await page.getByRole('heading', { name: 'Article blocked' }).waitFor();
  await page.getByText('来源网站限制内嵌展示，以下为提取的网页正文。').waitFor();
  await page.getByRole('tab', { name: '原网页', exact: true }).click(); assert.equal(await page.locator('iframe').count(), 0);
  await page.getByText('来源网站禁止内嵌展示，请使用“正文阅读”或“打开原文”。').waitFor();
  await page.evaluate(next => window.setFile(next), file('denied')); await page.getByRole('alert').filter({ hasText: '来源网站拒绝访问，或需要登录后阅读。' }).waitFor();
  denied = false; await page.getByRole('button', { name: '重试', exact: true }).click(); await page.getByRole('heading', { name: 'Article denied' }).waitFor();
  assert.ok(requests.some(url => url.includes('id=denied') && url.includes('refresh=1')));
  await page.getByRole('button', { name: '重新加载文档' }).click(); await page.getByRole('heading', { name: 'Article denied' }).waitFor();
  await page.evaluate(next => window.setFile(next), file('slow')); await page.getByRole('status').filter({ hasText: '正在读取参考网页正文' }).waitFor();
  await page.evaluate(next => window.setFile(next), file('fast')); await page.getByRole('heading', { name: 'Article fast' }).waitFor(); await page.waitForTimeout(650);
  assert.equal(await page.getByText('Full readable content slow', { exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: '/tmp/dreamatic-reference-reader-mobile.png', animations: 'disabled' });
  assert.deepEqual(errors, []);
});
