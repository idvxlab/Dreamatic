import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Writable } from 'node:stream';
import { startRuntime, localTarget } from '../lifecycle.mjs';
const runtime = resolve('.desktop-runtime');
test('navigation allows app and isolated granted previews only', () => {
  const origin = 'http://127.0.0.1:54321';
  assert.equal(localTarget(`${origin}/assets/test.html`, origin), true);
  assert.equal(localTarget(`http://127.0.0.1:54322/${'a'.repeat(48)}/artifacts/page/index.html`, origin), true);
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'https://example.com', 'http://127.0.0.1:54322/api/config', 'http://127.0.0.1.evil.test:54322/'+ 'a'.repeat(48)+'/artifacts/index.html']) assert.equal(localTarget(value, origin), false);
});
test('packaged runtime starts without system Node, writes settings outside app, preserves settings, and stops', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dreamatic-desktop-'));
  const log = new Writable({ write(_chunk, _encoding, done) { done(); } });
  let service;
  try {
    service = await startRuntime({ runtime, dataDir, log });
    let config = await fetch(`${service.url}/api/config`).then(r => r.json());
    assert.equal(config.envPath, join(dataDir, '.env'));
    assert.equal((await stat(join(dataDir, '.env'))).mode & 0o777, 0o600);
    assert.equal(config.textApiKeyConfigured, false);
    const response = await fetch(`${service.url}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: { DREAMATIC_SEARCH_PROVIDER: 'duckduckgo' } }) });
    assert.equal(response.status, 200);
    assert.match(await readFile(join(dataDir, '.env'), 'utf8'), /DREAMATIC_SEARCH_PROVIDER=duckduckgo/);
    assert.equal((await fetch(`${service.url}/api/health`).then(r => r.json())).workspaceDir, join(dataDir, 'workspace'));
    assert.match(await fetch(service.url).then(r => r.text()), /<div id="root">/);
    assert.equal((await fetch(`${service.url}/api/config`, { headers: { Origin: 'https://example.com' } })).status, 403);
    const oldUrl = service.url;
    await Promise.all([service.stop(), service.stop()]);
    await assert.rejects(fetch(oldUrl));
    service = await startRuntime({ runtime, dataDir, log });
    config = await fetch(`${service.url}/api/config`).then(r => r.json());
    assert.equal(config.values.DREAMATIC_SEARCH_PROVIDER, 'duckduckgo');
    await assert.rejects(stat(join(runtime, '.env')), { code: 'ENOENT' });
  } finally { await service?.stop(); await rm(dataDir, { recursive: true, force: true }); }
});
