import assert from 'node:assert/strict';
import test from 'node:test';
import { Response } from 'undici';
import { extractArticle, publicAddress, fetchArticle, readProjectReference } from '../dist/reference-reader.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const paragraph = 'This is a substantial source paragraph that explains the research finding, its evidence, and why it matters to the design project. '.repeat(8);
const html = `<html><head><title>Research source</title><meta name="author" content="Source author"></head><body><nav>Navigation to ignore</nav><main><article><h1>Research source</h1><p>${paragraph}</p><p>Read <a href="../study">related research</a>.</p><img src="./figure.png" alt="Research figure" onerror="alert(1)"><p><a href="javascript:alert(1)">Unsafe link</a><a href="http://127.0.0.1/private">Private link</a></p><script>window.remoteScriptExecuted=true</script><iframe src="https://example.org/embed"></iframe></article></main></body></html>`;
function flat(nodes) { return nodes.flatMap(node => [node, ...flat(node.children ?? [])]); }

test('article extraction retains content and absolute links/images while stripping active HTML', () => {
  const article = extractArticle(html, 'https://example.org/research/article', { xFrameOptions: 'DENY' });
  assert.equal(article.embeddingBlocked, true); assert.match(article.title, /Research source/);
  const nodes = flat(article.nodes); assert.ok(nodes.some(node => node.text?.includes('substantial source paragraph')));
  assert.ok(nodes.some(node => node.tag === 'a' && node.href === 'https://example.org/study'));
  assert.ok(nodes.some(node => node.tag === 'img' && node.src === 'https://example.org/research/figure.png'));
  assert.ok(!nodes.some(node => ['script', 'iframe', 'form', 'svg'].includes(node.tag)));
  assert.ok(!JSON.stringify(nodes).includes('window.remoteScriptExecuted'));
  assert.ok(!nodes.some(node => node.href?.startsWith('javascript:') || node.href?.includes('127.0.0.1')));
  assert.ok(nodes.every(node => Object.keys(node).every(key => ['tag', 'text', 'href', 'src', 'alt', 'children'].includes(key))));
  assert.equal(extractArticle(html, 'https://example.org/a', { csp: "default-src 'self'; frame-ancestors 'none'" }).embeddingBlocked, true);
  assert.equal(extractArticle(html, 'https://example.org/a', { csp: 'frame-ancestors *' }).embeddingBlocked, false);
  assert.throws(() => extractArticle('<html><body><div id="root"></div><script>renderApp()</script></body></html>', 'https://example.org'), /No readable article/);
});
test('network address checks reject local, reserved and IPv4-mapped destinations', () => {
  for (const address of ['0.0.0.0', '127.0.0.1', '10.0.0.1', '172.16.1.2', '192.168.1.1', '169.254.169.254', '100.100.100.100', '198.18.0.1', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '2001:db8::1', '2002:7f00:1::', '3fff::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(publicAddress(address), true, address);
});
test('reference fetching checks every redirect, bounds content and reports source failures', async () => {
  const addresses = async () => [{ address: '8.8.8.8', family: 4 }];
  const urls = [];
  const article = await fetchArticle('https://example.org/initial', { resolve: addresses, request: async (url, options) => {
    urls.push(url.href); assert.equal(options.redirect, 'manual'); assert.ok(options.dispatcher); assert.ok(options.signal);
    return urls.length === 1 ? new Response('', { status: 302, headers: { location: '/final' } }) : new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'SAMEORIGIN' } });
  } });
  assert.deepEqual(urls, ['https://example.org/initial', 'https://example.org/final']); assert.equal(article.url, 'https://example.org/final'); assert.equal(article.embeddingBlocked, true);
  let calls = 0;
  await assert.rejects(fetchArticle('https://example.org', { resolve: async () => [{ address: '127.0.0.1', family: 4 }], request: async () => { calls++; } }), /Only public/); assert.equal(calls, 0);
  await assert.rejects(fetchArticle('https://example.org', { resolve: addresses, request: async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }) }), /Only public/);
  for (const url of ['http://127.1/', 'http://0x7f000001/', 'http://[::1]/', 'https://user:secret@example.org', 'file:///etc/passwd']) await assert.rejects(fetchArticle(url), /Only public/);
  await assert.rejects(fetchArticle('https://example.org', { resolve: addresses, request: async () => new Response('', { status: 403 }) }), /denied access/);
  await assert.rejects(fetchArticle('https://example.org', { resolve: addresses, request: async () => new Response('', { status: 429 }) }), /rate limiting/);
  await assert.rejects(fetchArticle('https://example.org', { resolve: addresses, request: async () => new Response('PDF', { headers: { 'content-type': 'application/pdf' } }) }), /not an HTML or text page/);
  await assert.rejects(fetchArticle('https://example.org', { resolve: addresses, request: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'text/html' } }) }), /too large/);
  const plain = await fetchArticle('https://example.org/note', { resolve: addresses, request: async () => new Response('Plain source content', { headers: { 'content-type': 'text/plain' } }) }); assert.equal(plain.nodes[0].children[0].text, 'Plain source content');
});
test('reader resolves only registered project references and rejects private URLs before fetching', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-reference-reader-')); t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'runs', 'project'); await mkdir(root, { recursive: true });
  await writeFile(join(root, 'research.md'), '## References\n[1] Private source http://127.0.0.1/private\n');
  await assert.rejects(readProjectReference(workspace, 'project', 'citation:research.md:0'), /Only public/);
  await assert.rejects(readProjectReference(workspace, 'project', 'https://example.org'), /selected reference is unavailable/);
  await assert.rejects(readProjectReference(workspace, '../project', 'citation:research.md:0'), /Invalid run id/);
});

test('real transport decodes a bounded gzip page and rejects encoding chains without stopping subsequent requests', { timeout: 15000 }, async t => {
  const { createServer } = await import('node:http');
  const { gzipSync } = await import('node:zlib');
  const { requestReferencePage } = await import('../dist/reference-reader.js');
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/bad-encoding') { res.setHeader('Content-Encoding', Array(50).fill('gzip').join(', ')); res.end('bad'); return; }
    res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync(req.url === '/too-large' ? 'x'.repeat(2 * 1024 * 1024 + 1) : html));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // The adapter uses a local fixture only; production always uses the validated/pinned URL.
  const transport = { resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: (url, options) => requestReferencePage(new URL(origin + url.pathname), options) };
  assert.match((await fetchArticle('https://example.org/good', transport)).title, /Research source/);
  await assert.rejects(fetchArticle('https://example.org/bad-encoding', transport), /unsupported content encoding/);
  await assert.rejects(fetchArticle('https://example.org/too-large', transport), /too large/);
  assert.match((await fetchArticle('https://example.org/still-good', transport)).title, /Research source/);
});
