import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('desktop configuration applies to existing empty and continued conversations without restarting; workspace changes apply', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamatic-config-apply-'));
  let child, release, called;
  const calls = [];
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); calls.push({ model: input.model, auth: req.headers.authorization });
    if (called) { called(); await new Promise(resolveWait => { release = resolveWait; }); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const delta of [{ role: 'assistant', content: 'Configuration test response.' }, {}]) res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: delta.content ? null : 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolveListen => provider.listen(0, '127.0.0.1', resolveListen));
  try {
    await writeFile(join(root, '.env'), `DREAMATIC_BASE_URL=http://127.0.0.1:${provider.address().port}/v1\nDREAMATIC_API_KEY=old-key\nDREAMATIC_MODEL=old-model\nDREAMATIC_PREVENT_IDLE_SLEEP=false\n`);
    child = fork(resolve('apps/server/dist/index.js'), [], { cwd: root, env: { ...process.env, DREAMATIC_CONFIG_DIR: root, DREAMATIC_DESKTOP: '1', PI_CODING_AGENT_DIR: join(root, 'pi') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let diagnostics = ''; child.stderr.on('data', value => { diagnostics += value; });child.stdout.resume();
    const ready = await Promise.race([once(child, 'message').then(([value]) => value), once(child, 'exit').then(() => { throw new Error(diagnostics); }), new Promise((_, reject)=>setTimeout(()=>reject(new Error('ready timeout')),10000).unref())]);
    const origin = `http://127.0.0.1:${ready.port}`;
    const request = (path, method = 'GET', data) => fetch(origin + path, { signal: AbortSignal.timeout(10000), method, ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) });
    const session = await (await request('/api/sessions', 'POST', { title: 'Retained project' })).json();
    const save = await request('/api/config', 'PUT', { values: { DREAMATIC_MODEL: 'new-model', DREAMATIC_IMAGE_CONCURRENCY: '3', PORT: '4321' }, secrets: { DREAMATIC_API_KEY: 'new-key' } });
    assert.equal(save.status, 200); const saved = await save.json(); assert.equal(saved.applied.port, ready.port); assert.equal(saved.applied.portChanged, false);
    assert.equal((await (await request('/api/health')).json()).processId, child.pid);
    assert.equal((await (await request(`/api/sessions/${session.id}`)).json()).projectId, session.projectId);
    const prompt = () => request(`/api/sessions/${session.id}/messages`, 'POST', { text: 'Reply briefly with one sentence.', projectId: session.projectId }).then(response => response.text());
    await prompt(); assert.deepEqual(calls.at(-1), { model: 'new-model', auth: 'Bearer new-key' });
    const firstMessages = (await (await request(`/api/sessions/${session.id}`)).json()).messages;
    assert.ok(firstMessages.some(message => message.role === 'assistant'));
    assert.equal((await request('/api/config', 'PUT', { values: { DREAMATIC_MODEL: 'latest-model' } })).status, 200);
    assert.equal((await (await request(`/api/sessions/${session.id}`)).json()).messages.length, firstMessages.length);
    const reached = new Promise(resolveReached => { called = resolveReached; });
    const pending = prompt(); await reached;
    const activeDisk = await readFile(join(root,'.env'),'utf8');
    await writeFile(join(root,'.env'),activeDisk.replace('DREAMATIC_MODEL=latest-model','DREAMATIC_MODEL=external-disk-model'));
    const external = await (await request('/api/config')).json();
    assert.equal(external.values.DREAMATIC_MODEL,'external-disk-model');assert.equal(external.pendingApply,true);
    assert.equal((await (await request('/api/health')).json()).model,'latest-model');
    const busySave = await request('/api/config', 'PUT', { values: { DREAMATIC_MODEL: 'blocked-model' } });
    assert.equal(busySave.status, 409); assert.doesNotMatch(await readFile(join(root, '.env'), 'utf8'), /blocked-model/);
    release(); called = undefined; await pending; assert.equal(calls.at(-1).model, 'latest-model');
    await writeFile(join(root,'.env'),activeDisk);
    const changed = await (await request('/api/config', 'PUT', { values: { DREAMATIC_WORKSPACE: './other-workspace' } })).json();
    assert.equal(changed.applied.workspaceChanged, true);
    assert.equal((await (await request('/api/health')).json()).workspaceDir, join(root, 'other-workspace'));
    assert.deepEqual(await (await request('/api/sessions')).json(), []);
    await request('/api/config', 'PUT', { values: { DREAMATIC_WORKSPACE: './workspace' } });
    assert.ok((await (await request('/api/sessions')).json()).some(item => item.id === session.id));
  } finally {
    release?.(); if (child && child.exitCode === null) { const killed=setTimeout(()=>child.kill('SIGKILL'),3000);child.kill('SIGTERM'); await once(child, 'exit');clearTimeout(killed); }
    provider.closeAllConnections(); await new Promise(resolveClose => provider.close(resolveClose)); await rm(root, { recursive: true, force: true });
  }
});

test('web server applies a new port without process restart and rolls back configuration when a port is occupied', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamatic-config-port-'));
  const occupied = createServer((_req, res) => res.end('occupied'));
  const probe = createServer(); let child;
  await new Promise(done => occupied.listen(0, done));
  await new Promise(done => probe.listen(0, '127.0.0.1', done)); const nextPort = probe.address().port;
  await new Promise(done => probe.close(done));
  try {
    await writeFile(join(root, '.env'), 'PORT=0\nDREAMATIC_PREVENT_IDLE_SLEEP=false\n');
    child = fork(resolve('apps/server/dist/index.js'), [], { cwd: root, env: { ...process.env, DREAMATIC_CONFIG_DIR: root, DREAMATIC_DESKTOP: '0', PI_CODING_AGENT_DIR: join(root, 'pi') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stderr.resume();
    const previousPort = await new Promise((done, fail) => {
      let output = ''; const timer = setTimeout(() => fail(new Error('Startup timeout')), 10000);
      child.stdout.on('data', chunk => { output += chunk; const match = output.match(/server: http:\/\/localhost:(\d+)/); if (match) { clearTimeout(timer); done(Number(match[1])); } });
      child.once('exit', () => { clearTimeout(timer); fail(new Error('Server exited')); });
    });
    const save = (port, values) => fetch(`http://127.0.0.1:${port}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }), signal: AbortSignal.timeout(10000) });
    const rejected = await save(previousPort, { PORT: String(occupied.address().port), DREAMATIC_MODEL: 'should-not-apply' });
    assert.equal(rejected.status, 400); assert.doesNotMatch(await readFile(join(root, '.env'), 'utf8'), /should-not-apply/);
    const applied = await (await save(previousPort, { PORT: String(nextPort) })).json();
    assert.equal(applied.applied.portChanged, true); assert.equal(applied.applied.port, nextPort);
    assert.equal((await fetch(`http://127.0.0.1:${nextPort}/api/health`).then(response => response.json())).processId, child.pid);
  } finally {
    if (child && child.exitCode === null) { const timer = setTimeout(() => child.kill('SIGKILL'), 3000);child.kill('SIGTERM'); await once(child, 'exit');clearTimeout(timer); }
    await new Promise(done => occupied.close(done)); await rm(root, { recursive: true, force: true });
  }
});
