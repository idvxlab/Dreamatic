import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('configuration and project records survive execution failures, saves and workspace changes', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamatic-config-apply-'));
  let child;
  try {
    await writeFile(join(root, '.env'), 'DREAMATIC_API_KEY=old-key\nDREAMATIC_MODEL=old-model\nDREAMATIC_PREVENT_IDLE_SLEEP=false\n');
    child = fork(resolve('apps/server/dist/index.js'), [], { cwd: root, env: { ...process.env, DREAMATIC_CONFIG_DIR: root, DREAMATIC_DESKTOP: '1', PI_CODING_AGENT_DIR: join(root, 'pi') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stderr.resume(); child.stdout.resume();
    const [ready] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Server exited before ready'); }), new Promise((_, reject) => setTimeout(() => reject(new Error('Server startup timeout')), 10000).unref())]);
    const origin = `http://127.0.0.1:${ready.port}`;
    const powerStates=[]; child.on('message', message=>{if(message.type==='dreamatic-power-state')powerStates.push(message.active);});
    const request = (path, method = 'GET', data) => fetch(origin + path, { signal: AbortSignal.timeout(10000), method, ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) });
    const session = await (await request('/api/sessions', 'POST', { title: 'Retained project' })).json();
    const saved = await (await request('/api/config', 'PUT', { values: { DREAMATIC_MODEL: 'new-model', DREAMATIC_IMAGE_CONCURRENCY: '3', PORT: '4321' }, secrets: { DREAMATIC_API_KEY: 'new-key' } })).json();
    assert.equal(saved.applied.port, ready.port); assert.equal(saved.applied.portChanged, false);
    assert.equal((await (await request('/api/health')).json()).model, 'new-model');
    assert.equal((await (await request(`/api/sessions/${session.id}`)).json()).projectId, session.projectId);
    const briefPath = join(root, 'workspace/runs', session.projectId, 'brief.json');
    const before = await readFile(briefPath, 'utf8');
    await request('/api/config', 'PUT', { values: { DREAMATIC_PREVENT_IDLE_SLEEP:'true' } });
    const prompt = await request(`/api/sessions/${session.id}/messages`, 'POST', { text: 'Design a page', projectId: session.projectId });
    assert.equal(prompt.status, 200); assert.match(await prompt.text(), /Configure reasoning provider/);
    // Even a failed run must acquire then release the task wake lock.
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.ok(powerStates.includes(true));assert.equal(powerStates.at(-1),false);
    await request('/api/config', 'PUT', { values: { DREAMATIC_PREVENT_IDLE_SLEEP:'false' } });
    powerStates.length=0;
    const disabledPrompt=await request(`/api/sessions/${session.id}/messages`, 'POST', { text:'Retry design',projectId:session.projectId });
    await disabledPrompt.text();await new Promise(resolve=>setTimeout(resolve,25));
    assert.ok(powerStates.length>=2);assert.ok(powerStates.every(value=>value===false));
    assert.equal(JSON.parse(await readFile(briefPath, 'utf8')).brief, 'Design a page\n\nUser revision:\nRetry design');
    assert.equal((await (await request(`/api/sessions/${session.id}`)).json()).messages.length, 2);
    await request('/api/config', 'PUT', { secrets: { DREAMATIC_API_KEY: '' } });
    assert.match(await readFile(join(root, '.env'), 'utf8'), /DREAMATIC_API_KEY=new-key/);
    const activeDisk = await readFile(join(root, '.env'), 'utf8');
    await writeFile(join(root, '.env'), activeDisk.replace('DREAMATIC_MODEL=new-model', 'DREAMATIC_MODEL=external-model'));
    assert.equal((await (await request('/api/config')).json()).pendingApply, true);
    assert.equal((await (await request('/api/health')).json()).model, 'new-model');
    await request('/api/config', 'PUT', { values: { DREAMATIC_MODEL: 'applied-model' } });
    assert.equal((await (await request('/api/health')).json()).model, 'applied-model');
    const changed = await (await request('/api/config', 'PUT', { values: { DREAMATIC_WORKSPACE: './other-workspace' } })).json();
    assert.equal(changed.applied.workspaceChanged, true);
    assert.deepEqual(await (await request('/api/sessions')).json(), []);
    await request('/api/config', 'PUT', { values: { DREAMATIC_WORKSPACE: './workspace' } });
    assert.ok((await (await request('/api/sessions')).json()).some(item => item.id === session.id));
  } finally {
    if (child && child.exitCode === null) { const timer = setTimeout(() => child.kill('SIGKILL'), 3000); child.kill('SIGTERM'); await once(child, 'exit'); clearTimeout(timer); }
    await rm(root, { recursive: true, force: true });
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
