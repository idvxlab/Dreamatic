import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { browserExecutable } from '../../../packages/design-agent/dist/html-delivery.js';

test('web Save configuration applies models to the current project, navigates to a new port, and reloads a changed workspace', { timeout: 60000 }, async t => {
  const executablePath = await browserExecutable(); if (!executablePath) { t.skip('Chromium unavailable'); return; }
  const root = await mkdtemp(join(tmpdir(), 'dreamatic-web-config-'));
  const modelCalls = [];
  const provider = createServer(async (request, response) => {
    let text = '';for await (const chunk of request) text += chunk;const input = JSON.parse(text);modelCalls.push(input.model);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const delta of [{ role: 'assistant', content: 'Web configuration applied.' }, {}]) response.write(`data: ${JSON.stringify({id:'web-test',object:'chat.completion.chunk',created:1,model:input.model,choices:[{index:0,delta,finish_reason:delta.content?null:'stop'}]})}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(done => provider.listen(0, '127.0.0.1', done));
  let child, browser; const probe = createServer();
  await new Promise(done => probe.listen(0, '127.0.0.1', done)); const nextPort = probe.address().port; await new Promise(done => probe.close(done));
  try {
    await writeFile(join(root, '.env'), `PORT=0\nDREAMATIC_PREVENT_IDLE_SLEEP=false\nDREAMATIC_MODEL=old-model\nDREAMATIC_API_KEY=test-key\nDREAMATIC_BASE_URL=http://127.0.0.1:${provider.address().port}/v1\n`);
    child = fork(resolve('apps/server/dist/index.js'), [], { cwd: root, env: { ...process.env, DREAMATIC_CONFIG_DIR: root, DREAMATIC_DESKTOP: '0', PI_CODING_AGENT_DIR: join(root, 'pi') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stderr.resume();
    const port = await new Promise((done, fail) => {
      let output = ''; const timer = setTimeout(() => fail(new Error('Server startup timeout')), 10000);
      child.stdout.on('data', chunk => { output += chunk; const match = output.match(/server: http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); done(Number(match[1])); } });
      child.once('exit', () => { clearTimeout(timer); fail(new Error('Server exited')); });
    });
    const { chromium } = await import('playwright-core'); browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' });page.setDefaultTimeout(10000);
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.composer textarea').disabled);
    const initialSessions = await page.evaluate(() => fetch('/api/sessions').then(response => response.json()));
    const health = await page.evaluate(() => fetch('/api/health').then(response => response.json()));
    const openSettings = async () => { await page.getByRole('button', { name: 'DreamaticArt menu', exact: true }).click();await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor(); };
    const save = () => page.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await openSettings();await page.getByRole('tab', { name: 'Reasoning models', exact: true }).click();
    await page.getByRole('textbox', { name: 'Default reasoning model', exact: true }).fill('web-reasoning-model');
    await page.getByRole('tab', { name: 'Image model', exact: true }).click();
    await page.getByRole('textbox', { name: 'Image model', exact: true }).fill('web-image-model');
    await save();await page.getByText('Settings saved and applied', { exact: true }).waitFor();
    const appliedHealth = await page.evaluate(() => fetch('/api/health').then(response => response.json()));
    assert.equal(appliedHealth.model, 'web-reasoning-model');assert.equal(appliedHealth.imageModel, 'web-image-model');assert.equal(appliedHealth.processId, health.processId);
    assert.equal((await page.evaluate(() => fetch('/api/sessions').then(response => response.json())))[0].id, initialSessions[0].id);
    await page.evaluate(async session => { const response = await fetch(`/api/sessions/${session.id}/messages`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'Reply briefly.',projectId:session.projectId})});await response.text(); }, initialSessions[0]);
    assert.equal(modelCalls.at(-1), 'web-reasoning-model');
    await openSettings();await page.getByRole('tab', { name: 'System parameters', exact: true }).click();await page.locator('.config-advanced summary').click();
    await page.getByRole('spinbutton', { name: 'Server port', exact: true }).fill(String(nextPort));
    await save();await page.waitForURL(`http://127.0.0.1:${nextPort}/`);await page.getByRole('button', { name: 'New project', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => fetch('/api/health').then(response => response.json()))).processId, health.processId);
    await openSettings();await page.getByRole('tab', { name: 'System parameters', exact: true }).click();
    await page.getByRole('textbox', { name: 'Workspace directory', exact: true }).fill('./new-workspace');
    await save();await page.waitForFunction(() => !document.querySelector('.settings-modal') && document.querySelector('.composer textarea')?.disabled);
    assert.equal((await page.evaluate(() => fetch('/api/health').then(response => response.json()))).workspaceDir, join(root, 'new-workspace'));
    assert.deepEqual(await page.evaluate(() => fetch('/api/sessions').then(response => response.json())), []);
    await openSettings();await page.getByRole('tab', { name: 'System parameters', exact: true }).click();
    await page.getByRole('textbox', { name: 'Workspace directory', exact: true }).fill('./workspace');
    await save();await page.waitForFunction(() => !document.querySelector('.settings-modal') && !document.querySelector('.composer textarea')?.disabled);
    assert.equal((await page.evaluate(() => fetch('/api/sessions').then(response => response.json())))[0].id, initialSessions[0].id);
  } finally {
    await browser?.close();if (child && child.exitCode === null) { const timer = setTimeout(() => child.kill('SIGKILL'), 3000);child.kill('SIGTERM');await once(child, 'exit');clearTimeout(timer); }
    provider.closeAllConnections();await new Promise(done => provider.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
