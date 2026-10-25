import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { submitEditorTask, listEditorTasks, waitEditorTask, cancelEditorTask } from '../dist/editor.js';
import { projectFiles, projectFileContent } from '../dist/project-files.js';
import { writeCanvasState } from '../dist/canvas-store.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-editor-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'runs/demo');
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(join(root, 'artifacts/a.png'), png); await writeFile(join(root, 'artifacts/b.png'), png);
  let calls = 0, mode = 'success', release, entered;
  const server = createServer(async (req, res) => {
    calls++;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const form = await new Request('http://fixture', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
    const images = form.getAll('image[]').length ? form.getAll('image[]') : form.getAll('image');
    for (const image of images) assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    entered?.(images.length);
    if (mode === 'hang') await new Promise(resolve => { release = resolve; });
    if (mode === 'error') { res.writeHead(503); res.end('secret-provider-body'); return; }
    if (mode === 'invalid') { res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('bad output').toString('base64') }] })); return; }
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { release?.(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const env = { DREAMATIC_IMAGE_API_KEY: 'fixture-secret', DREAMATIC_IMAGE_BASE_URL: `http://127.0.0.1:${server.address().port}`, DREAMATIC_IMAGE_MODEL: 'generation', DREAMATIC_IMAGE_EDIT_MODEL: 'edit', DREAMATIC_IMAGE_EDIT_SIZE: 'auto', DREAMATIC_IMAGE_TIMEOUT_MS: '10000' };
  const input = (id, inputIds = ['artifacts/a.png', 'artifacts/b.png']) => ({ id, prompt: 'Combine all images, preserve the subjects', source: 'canvas', inputIds, promptNodeId: 'prompt', upstream: inputIds.map((fileId, index) => ({ nodeId: `source-${index}`, fileId })) });
  return { workspace, root, env, input, calls: () => calls, mode: value => { mode = value; }, entered: callback => { entered = callback; }, release: () => release?.() };
}
test('Editor deduplicates concurrent requests, persists all fusion inputs, and traces cascade outputs independently of canvas history', async t => {
  const f = await fixture(t); let inputCount;
  f.entered(count => { inputCount = count; });
  const request = f.input('fusion');
  const [first, duplicate] = await Promise.all([submitEditorTask(f.workspace, 'demo', request, false, f.env), submitEditorTask(f.workspace, 'demo', request, false, f.env)]);
  assert.equal(first.id, duplicate.id);
  const result = await waitEditorTask(f.workspace, 'demo', request.id);
  assert.equal(result.status, 'succeeded'); assert.equal(inputCount, 2); assert.equal(f.calls(), 1);
  assert.deepEqual(result.inputIds, request.inputIds);
  assert.equal(result.baseImageId, request.inputIds[0]); assert.equal(result.baseImageMethod, 'fallback'); assert.equal(result.sizeSource, 'first-input');
  assert.deepEqual(result.outputDimensions, {width:1,height:1});
  assert.deepEqual((await projectFileContent(f.workspace, 'demo', result.output.id)).data, png);
  await submitEditorTask(f.workspace, 'demo', request, false, f.env); assert.equal(f.calls(), 1);
  await assert.rejects(submitEditorTask(f.workspace, 'demo', { ...request, prompt: 'Another instruction' }, false, f.env), /different edit/);
  await assert.rejects(submitEditorTask(f.workspace, 'demo', { ...request, originalPrompt: '以图二为底图' }, false, f.env), /different edit/);
  await assert.rejects(submitEditorTask(f.workspace, 'demo', { ...request, inputOrdinals: [2,1] }, false, f.env), /different edit/);
  await assert.rejects(submitEditorTask(f.workspace, 'demo', { ...request, inputOrdinals: [1] }, false, f.env), /numbering/);
  const next = { ...f.input('cascade', [result.output.id]), upstream: [{ nodeId: 'generated', fileId: result.output.id, taskId: result.id }] };
  await submitEditorTask(f.workspace, 'demo', next, false, f.env);
  const cascaded = await waitEditorTask(f.workspace, 'demo', next.id); assert.equal(cascaded.status, 'succeeded');
  const before = await readFile(join(f.root, 'context/edit.md'), 'utf8');
  for (const text of ['fusion', 'cascade', 'artifacts/a.png', 'artifacts/b.png', result.output.id, cascaded.output.id, 'task fusion']) assert.ok(before.includes(text), text);
  assert.ok(!before.includes('fixture-secret'));
  assert.equal((before.match(/- Status: succeeded/g) || []).length, 2);
  assert.ok(before.includes('- Base image: artifacts/a.png')); assert.ok(before.includes('- Base selection: fallback')); assert.ok(before.includes('- Size source: first-input'));
  assert.ok((await projectFiles(f.workspace, 'demo')).some(file => file.id === 'context/edit.md' && file.category === 'context'));
  await writeCanvasState(f.workspace, 'demo', { elements: [], edges: [] });
  assert.equal(await readFile(join(f.root, 'context/edit.md'), 'utf8'), before);
  await listEditorTasks(f.workspace, 'demo'); assert.equal(await readFile(join(f.root, 'context/edit.md'), 'utf8'), before);
  await rm(join(f.root, 'context/edit.md')); await listEditorTasks(f.workspace, 'demo');
  assert.equal(await readFile(join(f.root, 'context/edit.md'), 'utf8'), before);
});
test('Editor records failure, retries under the same task id, and retains invalid/cancelled attempts without outputs', async t => {
  const f = await fixture(t), request = f.input('retry', ['artifacts/a.png']);
  f.mode('error'); await submitEditorTask(f.workspace, 'demo', request, false, f.env);
  const failed = await waitEditorTask(f.workspace, 'demo', request.id); assert.equal(failed.status, 'failed'); assert.match(failed.error, /503/); assert.equal(failed.output, undefined);
  f.mode('success'); await submitEditorTask(f.workspace, 'demo', request, true, f.env);
  const retried = await waitEditorTask(f.workspace, 'demo', request.id); assert.equal(retried.status, 'succeeded'); assert.equal(retried.attempt, 2); assert.equal(retried.error, undefined);
  f.mode('invalid'); await submitEditorTask(f.workspace, 'demo', f.input('invalid'), false, f.env);
  assert.equal((await waitEditorTask(f.workspace, 'demo', 'invalid')).status, 'failed');
  f.mode('hang'); let entered; const gate = new Promise(resolve => { entered = resolve; }); f.entered(entered);
  await submitEditorTask(f.workspace, 'demo', f.input('cancel'), false, f.env); await gate;
  const cancelled = await cancelEditorTask(f.workspace, 'demo', 'cancel'); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.output, undefined); f.release();
  const history = await readFile(join(f.root, 'context/edit.md'), 'utf8');
  for (const status of ['failed', 'cancelled', 'succeeded']) assert.ok(history.includes(`- Status: ${status}`));
  assert.ok(!history.includes('secret-provider-body'));
});
test('Editor recovers interrupted tasks and saved receipts without issuing new provider requests', async t => {
  const f = await fixture(t); await listEditorTasks(f.workspace, 'demo');
  const folder = join(f.root, 'inputs/media-edits'), path = join(folder, 'editor-tasks.json');
  const saved = { ...f.input('recovered'), status: 'running', attempt: 1, createdAt: new Date().toISOString() };
  const interrupted = { ...f.input('interrupted'), status: 'submitted', attempt: 1, createdAt: saved.createdAt };
  await writeFile(path, JSON.stringify({ tasks: [saved, interrupted], events: [{ at: saved.createdAt, task: saved }, { at: saved.createdAt, task: interrupted }] }));
  await writeFile(join(folder, 'receipt.json'), JSON.stringify({ taskId: saved.id, attempt: 1, id: 'receipt', outputId: 'artifacts/b.png', model: 'edit', size: 'auto' }));
  const tasks = await listEditorTasks(f.workspace, 'demo');
  assert.equal(tasks[0].status, 'succeeded'); assert.equal(tasks[0].output.id, 'artifacts/b.png'); assert.equal(tasks[1].status, 'interrupted'); assert.equal(f.calls(), 0);
  assert.equal((await readFile(join(f.root, 'context/edit.md'), 'utf8')).includes('Execution was interrupted'), true);
});

test('natural-language editing delegates through Pi Editor, shares task receipts, and does not rebuild the design pipeline', async t => {
  const { runDesign } = await import('../dist/design-pipeline.js');
  const f = await fixture(t), previousEnv = { ...process.env }, roles = [];
  t.after(() => { process.env = previousEnv; });
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body), system = data.messages.find(message => message.role === 'system')?.content ?? '';
    const editor = system.includes('You are Editor'); roles.push(editor ? 'editor' : 'orchestrator');
    const tool = editor ? 'image_edit' : 'edit_materials';
    assert.ok(data.tools.some(item => item.function.name === tool));
    const called = data.messages.some(message => message.role === 'tool');
    if (editor) assert.ok(JSON.stringify(data.messages).includes('## Input materials'));
    const delta = called ? { content: '# Editing result\nThe edited material was saved. See context/edit.md.' } : { tool_calls: [{ index: 0, id: editor ? 'execute' : 'delegate', type: 'function', function: { name: tool, arguments: JSON.stringify(editor ? { prompt: 'Combine the two subjects with a blue background' } : { instruction: '# Request\nFuse both images with a blue background', inputIds: ['artifacts/a.png', 'artifacts/b.png'] }) } }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choice of [{ delta: { role: 'assistant', ...delta }, finish_reason: null }, { delta: {}, finish_reason: called ? 'stop' : 'tool_calls' }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, ...choice }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  Object.assign(process.env, f.env, { DREAMATIC_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, DREAMATIC_API_KEY: 'fixture-reasoning-key', DREAMATIC_MODEL: 'fixture', DREAMATIC_CONTEXT_WINDOW: '32768', DREAMATIC_MAX_TOKENS: '8192', DREAMATIC_PROVIDER_TYPE: 'openai-compatible', DREAMATIC_MODEL_CAPABILITIES: '' });
  const brief = { title: 'Existing project', brief: 'Original creative direction' }, pipeline = { request: 'Original creative direction', completed: { builder: 'preserved-checkpoint' } };
  await writeFile(join(f.root, 'brief.json'), JSON.stringify(brief)); await writeFile(join(f.root, 'pipeline-state.json'), JSON.stringify(pipeline));
  await runDesign({ repoRoot: process.cwd(), workspaceDir: f.workspace, runId: 'demo', text: 'Fuse a and b with a blue background', signal: new AbortController().signal, emit() {} });
  const tasks = await listEditorTasks(f.workspace, 'demo'); assert.equal(tasks.length, 1); assert.equal(tasks[0].source, 'natural-language'); assert.equal(tasks[0].status, 'succeeded'); assert.deepEqual(tasks[0].inputOrdinals, [1,2]);
  assert.deepEqual(tasks[0].inputIds, ['artifacts/a.png', 'artifacts/b.png']); assert.equal(f.calls(), 1);
  assert.ok(roles.includes('editor')); assert.ok(roles.includes('orchestrator')); assert.equal(roles.length, 4);
  assert.equal((await readFile(join(f.root, 'context/edit.md'), 'utf8')).includes('Fuse a and b with a blue background'), true);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'brief.json'), 'utf8')), brief);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'pipeline-state.json'), 'utf8')), pipeline);
  const bus = await readFile(join(f.root, 'bus.jsonl'), 'utf8'); assert.ok(bus.includes('"agent":"editor"'));
  assert.equal(JSON.parse(await readFile(join(f.root, 'run-state.json'), 'utf8')).stages.build, 'completed');
});

test('saved outputs and the durable journal survive a failed Markdown publication and repair without duplicate success events', async t => {
  const f = await fixture(t); f.mode('hang'); let entered; const gate = new Promise(resolve => { entered = resolve; }); f.entered(entered);
  await submitEditorTask(f.workspace, 'demo', f.input('history-repair'), false, f.env); await gate;
  const historyPath = join(f.root, 'context/edit.md');
  await rm(historyPath); await mkdir(historyPath);
  f.release();
  await assert.rejects(waitEditorTask(f.workspace, 'demo', 'history-repair'));
  const journal = JSON.parse(await readFile(join(f.root, 'inputs/media-edits/editor-tasks.json'), 'utf8'));
  assert.equal(journal.tasks[0].status, 'succeeded'); assert.ok(journal.tasks[0].output);
  await rm(historyPath, { recursive: true });
  const [task] = await listEditorTasks(f.workspace, 'demo');
  assert.equal(task.status, 'succeeded'); assert.deepEqual((await projectFileContent(f.workspace, 'demo', task.output.id)).data, png);
  assert.equal(((await readFile(historyPath, 'utf8')).match(/- Status: succeeded/g) || []).length, 1);
  await rm(join(f.root, task.output.id));
  const [unavailable] = await listEditorTasks(f.workspace, 'demo'); assert.equal(unavailable.outputAvailable, false); assert.equal(unavailable.output.id, task.output.id);
  const history = await readFile(historyPath, 'utf8'); assert.ok(history.includes('output material is unavailable')); assert.ok(history.includes(task.output.id));
});

test('Editor records reasoning setup failures before image execution', async t => {
  const { editorTool } = await import('../dist/editor-agent.js');
  const f = await fixture(t), previousEnv = { ...process.env };
  t.after(() => { process.env = previousEnv; });
  Object.assign(process.env, { DREAMATIC_API_KEY: '', DREAMATIC_BASE_URL: '', DREAMATIC_MODEL: '' });
  const result = await editorTool({ repoRoot: process.cwd(), workspaceDir: f.workspace, runId: 'demo', signal: new AbortController().signal, emit() {} }).execute('planning', { instruction: 'Change the background', inputIds: ['artifacts/a.png'] });
  assert.equal(result.details.status, 'failed'); assert.equal(f.calls(), 0);
  const [task] = await listEditorTasks(f.workspace, 'demo'); assert.equal(task.status, 'failed'); assert.equal(task.toolInvoked, false);
  assert.ok((await readFile(join(f.root, 'context/edit.md'), 'utf8')).includes('planning failed before image execution'));
});

test('later message attachments append without changing historical attachment identifiers', async t => {
  const { runDesign } = await import('../dist/design-pipeline.js');
  const f = await fixture(t), original = { data: png.toString('base64'), mimeType: 'image/png' }, next = { data: Buffer.from('new image bytes').toString('base64'), mimeType: 'image/png' };
  await writeFile(join(f.root, 'attachments.json'), JSON.stringify([original]));
  const options = { repoRoot: process.cwd(), workspaceDir: f.workspace, runId: 'demo', text: 'Continue workflow', signal: new AbortController().signal, emit() {}, images: [next] };
  await assert.rejects(runDesign(options), /No original request/);
  await assert.rejects(runDesign(options), /No original request/);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'attachments.json'), 'utf8')), [original, next]);
  assert.deepEqual((await projectFileContent(f.workspace, 'demo', 'attachment:0')).data, png);
});


test('natural-language material numbering prioritizes current-message image references over historical assets', async t => {
  const { editorMaterials, editorInventory } = await import('../dist/editor-agent.js');
  const f = await fixture(t);
  const files = await editorMaterials(f.workspace, 'demo', ['artifacts/b.png', 'artifacts/a.png']);
  assert.deepEqual(files.map(file => file.id), ['artifacts/b.png', 'artifacts/a.png']);
  const markdown = await editorInventory(f.workspace, 'demo', files);
  assert.match(markdown, /Image 1: artifacts\/b.png/); assert.match(markdown, /Image 2: artifacts\/a.png/);
});
