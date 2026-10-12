import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDreamaticExtension } from '../dist/extension.js';
import { compactPersistedHistory } from '../dist/context-history.js';
import { contextOverview } from '../dist/context-overview.js';

const cwd = fileURLToPath(new URL('../../..', import.meta.url));
const assistant = (...content) => ({ role: 'assistant', content });
const call = (id, name, args) => assistant({ type: 'toolCall', id, name, arguments: args });
const result = (id, name, text, isError = false) => ({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError });
const later = () => [assistant({ type: 'text', text: 'Continue' }), assistant({ type: 'text', text: 'Saved checkpoint' })];
const readResult = message => JSON.parse(message.content[0].text);
function harness(workspaceDir, agent) {
  const tools = new Map(), handlers = new Map();
  createDreamaticExtension({ workspaceDir, parentInvocation: { id: agent, agent, runId: 'demo' } })({ on: (name, fn) => handlers.set(name, fn), registerTool: tool => tools.set(tool.name, tool) });
  return { handlers, invoke: async (name, args) => tools.get(name).execute(name, args, undefined, undefined, { cwd }) };
}

test('role overview keeps every output identity and lossless section expansion without copying research into Builder', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-overview-'));
  try {
    const tools = new Map();
    createDreamaticExtension({ workspaceDir: workspace })({ on() {}, registerTool: tool => tools.set(tool.name, tool) });
    await tools.get('run_init').execute('init', { runIdOverride: 'demo', projectTitle: 'Example', brief: 'Design a page', designScopes: [{ id: 'ui', category: 'ux', task: 'Page' }] }, undefined, undefined, { cwd });
    const dir = join(workspace, 'runs/demo');
    const document = { schemaVersion: 2, runId: 'demo', revision: 1, system: { system_thesis: 'x'.repeat(20_000) }, strategy: { design_intent: 'Intent', exploration: 'y'.repeat(30_000) },
      deliverables: Array.from({ length: 30 }, (_, id) => ({ id: `d${id}`, scope_id: 'ui', file: `artifacts/${id}.png`, required: true, purpose: 'z'.repeat(2000), execution: { method: 'image_generate', prompt_seed: 'p'.repeat(4000), uses: id ? ['d0'] : [] } })), presentation: { mode: 'html', entry: 'artifacts/index.html' } };
    await writeFile(join(dir, 'context/design.json'), JSON.stringify(document));
    await writeFile(join(dir, 'context/research.json'), JSON.stringify({ schemaVersion: 1, runId: 'demo', revision: 1, evidence: { summary: 'Evidence' }, findings: 'f'.repeat(30_000) }));
    const h = harness(workspace, 'builder');
    const overview = readResult(await h.invoke('design_context_read', { runId: 'demo', audience: 'builder' }));
    assert.equal(overview.files.some(file => file.path === 'context/research.json'), false);
    assert.equal(overview.referenceInventory, undefined);
    const file = overview.files.find(file => file.path === 'context/design.json');
    assert.deepEqual(JSON.parse(file.content).deliverables.map(item => item.id), document.deliverables.map(item => item.id));
    assert.ok(file.sections.includes('deliverables'));
    assert.ok(file.content.length < JSON.stringify(document).length / 10);
    const expansion = file.expansionReads.find(args => args.select.section === 'deliverables');
    const selected = readResult(await h.invoke('design_context_read', { ...expansion, select: { section: 'deliverables', ids: ['d29'] } }));
    assert.deepEqual(JSON.parse(selected.files[0].content).deliverables, [document.deliverables[29]]);
    const full = readResult(await h.invoke('design_context_read', file.readArguments));
    assert.deepEqual(JSON.parse(full.files[0].content), document);
    assert.equal(full.authoringContract, undefined);
    assert.equal(await readFile(join(dir, 'context/design.json'), 'utf8'), JSON.stringify(document));
    const projection = contextOverview(document, 'reviewer', 8000);
    assert.equal(projection.content.deliverables.length, 30);
    assert.ok(projection.omittedPointers.includes('/deliverables'));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('provider history preserves complete write arguments even after successful persistence and later turns', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-history-'));
  try {
    const dir = join(workspace, 'runs/demo'); await mkdir(join(dir, 'plan/html'), { recursive: true });
    const path = join(dir, 'plan/html/app.js'), code = 'const source = 1;\n'.repeat(1000); await writeFile(path, code);
    const h = harness(workspace, 'designer');
    const messages = [call('saved', 'write', { path, content: code }), result('saved', 'write', 'Successfully wrote file'), ...later(),
      call('failed', 'write', { path, content: code }), result('failed', 'write', 'Truncated arguments', true),
      call('fresh', 'write', { path, content: code }), result('fresh', 'write', 'Successfully wrote file')];
    const original = structuredClone(messages);
    const compacted = (await h.handlers.get('context')({ messages }, { cwd })).messages;
    assert.deepEqual(compacted[0].content[0].arguments, { path, content: code });
    assert.equal(compacted[4].content[0].arguments.content, code);
    assert.equal(compacted[6].content[0].arguments.content, code);
    assert.deepEqual(messages, original);
    assert.deepEqual(compacted, original);
    assert.equal(await readFile(path, 'utf8'), code);
    await writeFile(path, 'Changed outside the session');
    const changed = (await h.handlers.get('context')({ messages }, { cwd })).messages;
    assert.equal(changed[0].content[0].arguments.content, code);
    const sibling = join(workspace, 'outside.js'); await writeFile(sibling, code);
    const link = join(dir, 'plan/html/link.js'); await symlink(sibling, link);
    const unsafe = [call('outside', 'write', { path: link, content: code }), result('outside', 'write', 'Written'), ...later()];
    await compactPersistedHistory(unsafe, { cwd, runDir: dir });
    assert.equal(unsafe[0].content[0].arguments.content, code);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('duplicate Skill bodies retain one complete copy per version and every activation receipt', async () => {
  const body = `---\nname: shared\n---\n# Knowledge\n${'Essential method\n'.repeat(2000)}`;
  const first = result('one', 'use_skill', `{"scopeId":"a"}\nLoaded Skill: shared\n${body}`);
  const second = result('two', 'use_skill', `{"scopeId":"b"}\nLoaded Skill: shared\n${body}`);
  const changed = result('three', 'use_skill', `{"scopeId":"c"}\nLoaded Skill: shared\n${body}Version two`);
  const native = result('native', 'read', `Other retained content\n${body}`);
  await compactPersistedHistory([native, first, second, changed], { cwd });
  assert.equal(first.content[0].text.endsWith(body), true);
  assert.match(second.content[0].text, /scopeId.*b/);
  assert.equal(second.content[0].text.includes(body), false);
  assert.equal(native.content[0].text.includes(body), false);
  assert.match(native.content[0].text, /Other retained content/);
  assert.equal(changed.content[0].text.endsWith(`${body}Version two`), true);
  const afterCompaction = result('reload', 'use_skill', `Loaded Skill: shared\n${body}`);
  await compactPersistedHistory([afterCompaction], { cwd });
  assert.equal(afterCompaction.content[0].text.endsWith(body), true);
});

test('research originals remain until findings and matching provenance are actually saved; recent evidence stays intact', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-research-memory-'));
  try {
    const dir = join(workspace, 'runs/demo'); await mkdir(join(dir, 'research/sources'), { recursive: true }); await mkdir(join(dir, '.performance'));
    const url = 'https://example.org/source', path = join(dir, 'research/sources/source.txt');
    const source = `Source\n${url}\n\n${'Full scientific evidence. '.repeat(500)}`; await writeFile(path, source);
    const evidence = [call('read', 'read', { path }), result('read', 'read', source), ...later()];
    await compactPersistedHistory(evidence, { cwd, runDir: dir, role: 'researcher' });
    assert.equal(evidence[1].content[0].text, source);
    await writeFile(join(dir, '.performance/context-draft-researcher.json'), JSON.stringify({ data: { findings: 'Verified findings', evidence: { official_sources: [{ url }] } } }));
    const saved = [...evidence, call('save', 'update_design_context', { changes: { findings: 'Verified findings' } }), result('save', 'update_design_context', '{"saved":true}'), ...later(), call('fresh', 'read', { path }), result('fresh', 'read', source)];
    await compactPersistedHistory(saved, { cwd, runDir: dir, role: 'researcher' });
    assert.match(saved[1].content[0].text, /findings.*saved/i);
    assert.equal(saved.at(-1).content[0].text, source);
    assert.equal(await readFile(path, 'utf8'), source);
    await writeFile(path, `Source\n${url}\n\nDifferent source version`);
    const changed = [call('old-read', 'read', { path }), result('old-read', 'read', source), ...later(),
      call('save', 'update_design_context', { changes: { findings: 'Verified findings' } }), result('save', 'update_design_context', '{"saved":true}'), ...later()];
    await compactPersistedHistory(changed, { cwd, runDir: dir, role: 'researcher' });
    assert.equal(changed[1].content[0].text, source);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('repeated Context reads compact only identical selectors and never failed reads', async () => {
  const args = { audience: 'reviewer', paths: ['context/design.json'], select: { section: 'deliverables', ids: ['one'] } };
  const detail = JSON.stringify({ ok: true, files: [{ content: 'x'.repeat(5000) }] });
  const messages = [call('old', 'design_context_read', args), result('old', 'design_context_read', detail), ...later(),
    call('different', 'design_context_read', { ...args, select: { section: 'deliverables', ids: ['two'] } }), result('different', 'design_context_read', detail)];
  await compactPersistedHistory(messages, { cwd });
  assert.equal(messages[1].content[0].text, detail);
  const failed = [...messages, call('failed', 'design_context_read', args), result('failed', 'design_context_read', '{"ok":false}', false)];
  await compactPersistedHistory(failed, { cwd }); assert.equal(failed[1].content[0].text, detail);
  const repeated = [...messages, call('new', 'design_context_read', args), result('new', 'design_context_read', detail)];
  await compactPersistedHistory(repeated, { cwd });
  assert.match(repeated[1].content[0].text, /superseded/);
  assert.equal(repeated.at(-1).content[0].text, detail);
});

test('Pi compaction invalidates body reuse without losing scoped selections', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-skill-memory-'));
  try {
    const h = harness(workspace, 'designer');
    const args = { name: 'html-interface', scopeId: 'project', role: 'supporting' };
    const first = await h.invoke('use_skill', args); assert.equal(first.details.reused, false);
    assert.equal((await h.invoke('use_skill', args)).details.reused, true);
    await h.handlers.get('session_compact')({});
    const restored = await h.invoke('use_skill', args);
    assert.equal(restored.details.reused, false);
    assert.equal(restored.details.bindings[0].scope, 'project');
    assert.match(restored.content[0].text, /# /);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
