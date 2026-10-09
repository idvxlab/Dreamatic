import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createDreamaticExtension } from '../dist/extension.js';
import { CONTEXT_FILES, contextProjections, assertContextDocument, saveContextDocument, readRunContext, CONTEXT_PROJECTIONS } from '../dist/context-model.js';

const cwd = fileURLToPath(new URL('../../..', import.meta.url));
const value = result => JSON.parse(result.content[0].text);
function harness(workspaceDir, agent) {
  const tools = new Map(), handlers = new Map();
  createDreamaticExtension({ workspaceDir, ...(agent ? { parentInvocation: { id: agent, agent, runId: 'demo' } } : {}) })({ registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => handlers.set(name, handler) });
  return { tools, handlers, invoke: async (name, args) => { const tool = tools.get(name); const result = await tool.execute(name, tool.prepareArguments ? tool.prepareArguments(args) : args, undefined, undefined, { cwd }); return name === 'use_skill' ? result : value(result); } };
}
async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-unified-'));
  const root = harness(workspace);
  await root.invoke('run_init', { runIdOverride: 'demo', projectTitle: 'A coherent page', brief: 'Build an academic page', designScopes: [{ id: 'ui', category: 'ux', task: 'Academic page' }] });
  return { workspace, runDir: join(workspace, 'runs/demo'), root };
}
const research = { schemaVersion: 1, runId: 'demo', revision: 1, evidence: { target: 'Academic page', summary: 'Research complete', official_sources: [], open_questions: [] }, findings: '# Findings\nNo supplied materials.', usageConditions: 'No restricted materials.' };
const design = {
  schemaVersion: 1, runId: 'demo', revision: 1,
  system: { system_thesis: 'Readable academic presentation', palette: {}, typography: {} },
  strategy: { design_intent: 'Present research clearly', skill_selection: [{ scope_id: 'ui', name: 'ui-web-design', role: 'primary', rationale: 'Academic interface' }] },
  tasks: [{ id: 'page', scope_id: 'ui', category: 'ux', method: 'html_generate', files: [{ source: 'plan/html/ui/index.html', output: 'artifacts/ui/index.html' }], resources: [], dependencies: [], interaction_checks: [] }],
  deliverables: [{ id: 'page', scope_id: 'ui', category: 'ux', skill_refs: ['ui-web-design'], kind: 'html_page', purpose: 'Academic research', acceptance_test: 'Research title is readable', required: true, file: 'artifacts/ui/index.html' }],
  presentation: { mode: 'html', entry: 'artifacts/ui/index.html' },
  acceptanceNotes: 'Preserve the supplied research title.', executionNotes: 'Execute the approved source.'
};
const review = { schemaVersion: 1, runId: 'demo', revision: 1, assessment: { review_stage: 'design_context', verdict: 'pass', round: 1, summary: 'Executable specification', scores: {}, issues: [], resolved_issue_ids: [], remaining_risks: [] } };
const completion = (type, summary) => ({ runId: 'demo', type, summary });

test('unified research/design/review publish, seal exact sources and mechanically deliver; revisions archive canonical context', async () => {
  const { workspace, runDir, root } = await setup();
  const oldBrowser = process.env.DREAMATIC_HTML_BROWSER;
  process.env.DREAMATIC_HTML_BROWSER = 'off';
  try {
    const researcher = harness(workspace, 'researcher');
    await researcher.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.research, data: research });
    await researcher.invoke('design_bus_post', completion('research_done', 'Researched'));
    const designer = harness(workspace, 'designer');
    await designer.invoke('use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary' });
    await mkdir(join(runDir, 'plan/html/ui'), { recursive: true });
    await writeFile(join(runDir, 'plan/html/ui/index.html'), '<!doctype html><html><head><title>Research</title></head><body><h1>Research</h1></body></html>');
    await designer.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.design, data: design });
    const spec = await designer.invoke('design_bus_post', completion('design_spec_ready', 'Designed'));
    assert.equal(spec.ok, true);
    assert.ok(spec.event.artifactRefs.includes(CONTEXT_FILES.design));
    const reviewer = harness(workspace, 'reviewer');
    await reviewer.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.review, data: review });
    await reviewer.invoke('design_bus_post', completion('design_review_pass', 'Reviewed'));
    const events = (await readFile(join(runDir, 'bus.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const approved = events.findLast(event => event.type === 'design_review_pass');
    assert.ok(approved.commitReceipt.files[CONTEXT_FILES.design]);
    assert.ok(approved.commitReceipt.files[CONTEXT_FILES.review]);
    assert.ok(approved.commitReceipt.files['plan/html/ui/index.html']);
    const builder = harness(workspace, 'builder');
    const context = await builder.invoke('design_context_read', { runId: 'demo', audience: 'builder' });
    assert.equal(context.contextFormat, 'unified-v1');
    assert.ok(context.files.some(file => file.path === CONTEXT_FILES.design));
    assert.equal(context.files.some(file => file.path === 'plan/design_plan.json'), false);
    const approvedDesign = await readFile(join(runDir, CONTEXT_FILES.design), 'utf8');
    await writeFile(join(runDir, CONTEXT_FILES.design), approvedDesign + '\n');
    await assert.rejects(builder.invoke('execute_design_plan', { runId: 'demo' }), /changed after/);
    await writeFile(join(runDir, CONTEXT_FILES.design), approvedDesign);
    await builder.invoke('execute_design_plan', { runId: 'demo' });
    await builder.invoke('build_finalize', { runId: 'demo' });
    assert.equal(await readFile(join(runDir, 'artifacts/ui/index.html'), 'utf8'), await readFile(join(runDir, 'plan/html/ui/index.html'), 'utf8'));
    const index = JSON.parse(await readFile(join(runDir, 'design-context.json'), 'utf8'));
    assert.equal(index.sections.design, CONTEXT_FILES.design);
    for (const path of Object.values(CONTEXT_PROJECTIONS).flat()) await assert.rejects(readFile(join(runDir, path)), /ENOENT/, `Retired file must not exist: ${path}`);
    for (const event of events.filter(event => event.commitReceipt)) for (const path of Object.keys(event.commitReceipt.files)) assert.equal(Object.values(CONTEXT_PROJECTIONS).flat().includes(path), false);
    const contract = await designer.invoke('design_context_read', { runId: 'demo', audience: 'designer' });
    assert.equal(contract.outputContract.storage.path, CONTEXT_FILES.design);
    assert.equal(contract.outputContract.typed.imageTasks, 'context/design.json.tasks');
    // An earlier unified release may have left split files; exporting ignores them.
    await writeFile(join(runDir, 'plan/design_plan.json'), '{stale}');
    await root.invoke('export_package', { runId: 'demo', runDir });
    await assert.rejects(readFile(join(runDir, 'final/plan/design_plan.json')), /ENOENT/);
    assert.ok(await readFile(join(runDir, 'final', CONTEXT_FILES.design)));
    const revision = await root.invoke('run_revision', { runId: 'demo', feedback: 'Update title', preserve: ['Layout'] });
    assert.ok(await readFile(join(runDir, revision.revisionRequest.baseSnapshot, CONTEXT_FILES.design)));
    const project = JSON.parse(await readFile(join(runDir, CONTEXT_FILES.project), 'utf8'));
    assert.equal(project.brief.revisionRequest.feedback, 'Update title');
    assert.equal(project.revision, 2);
  } finally {
    if (oldBrowser === undefined) delete process.env.DREAMATIC_HTML_BROWSER; else process.env.DREAMATIC_HTML_BROWSER = oldBrowser;
    await rm(workspace, { recursive: true, force: true });
  }
});

test('canonical revisions and hashes support targeted patches; retired paths and other roles cannot be edited', async () => {
  const { workspace, runDir } = await setup();
  try {
    const designer = harness(workspace, 'designer');
    await designer.invoke('use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary' });
    const saved = await designer.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.design, data: design });
    await assert.rejects(designer.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.design, data: design }), /Increment context revision/);
    await assert.rejects(designer.invoke('write_json', { runId: 'demo', path: 'plan/design_plan.json', data: {} }), /read-only/);
    await assert.rejects(designer.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.review, data: review }), /cannot write/);
    const native = await designer.handlers.get('tool_call')({ toolName: 'write', input: { path: join(runDir, CONTEXT_FILES.design), content: '{}' } }, { cwd });
    assert.equal(native.block, true);
    const patched = await designer.invoke('patch_json', { runId: 'demo', path: CONTEXT_FILES.design, sha256: saved.sha256, updates: [{ pointer: '/revision', value: 2 }, { pointer: '/strategy/design_intent', value: 'A revised intent' }] });
    assert.notEqual(patched.sha256, saved.sha256);
    assert.equal(JSON.parse(await readRunContext(runDir, 'plan/design_plan.json')).design_intent, 'A revised intent');
    await assert.rejects(designer.invoke('patch_json', { runId: 'demo', path: CONTEXT_FILES.design, sha256: saved.sha256, updates: [{ pointer: '/revision', value: 3 }] }), /JSON changed/);
    // Stale files from an earlier release are ignored, never authoritative.
    await writeFile(join(runDir, 'plan/design_plan.json'), '{}');
    assert.equal(JSON.parse(await readRunContext(runDir, 'plan/design_plan.json')).design_intent, 'A revised intent');
    const read = await designer.handlers.get('tool_call')({ toolName: 'read', input: { path: join(runDir, 'plan/design_plan.json') } }, { cwd });
    assert.equal(read.block, true);
    await assert.rejects(designer.invoke('design_context_read', { runId: 'demo', audience: 'designer', paths: ['plan/design_plan.json'] }), /not available/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('production fields have one source and canonical saves cannot escape the Run', async () => {
  const image = structuredClone(design);
  image.tasks = [{ id: 'hero', method: 'image_generate', size: '512x512', prompt_seed: 'Exact prompt', negative_prompt_seed: 'Text', size_rationale: 'Concept' }];
  image.deliverables = [{ id: 'hero', kind: 'image', purpose: 'Concept', required: true, acceptance_test: 'Matches intent', file: 'artifacts/hero.png' }];
  image.presentation = { mode: 'gallery', entry: 'artifacts/00-gallery.html' };
  const projections = contextProjections(CONTEXT_FILES.design, image, 'demo');
  const manifest = JSON.parse(projections['plan/deliverable_manifest.json']);
  assert.equal(manifest.deliverables[0].size, '512x512');
  assert.equal(manifest.deliverables[0].method, 'image_generate');
  assert.equal(JSON.parse(projections['plan/design_plan.json']).execution_plan[0].prompt_seed, 'Exact prompt');
  image.deliverables[0].size = '1024x1024';
  assert.throws(() => contextProjections(CONTEXT_FILES.design, image, 'demo'), /derived/);
  const { workspace, runDir } = await setup();
  try {
    await rm(join(runDir, 'context'), { recursive: true, force: true });
    const outside = join(workspace, 'outside'); await mkdir(outside);
    await symlink(outside, join(runDir, 'context'));
    await assert.rejects(saveContextDocument(runDir, CONTEXT_FILES.design, design, 'demo'), /escapes/);
    await assert.rejects(readFile(join(outside, 'design.json')), /ENOENT/);
    await assert.rejects(assertContextDocument(runDir, CONTEXT_FILES.design, 'demo'), /ENOENT/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('unified Context never falls back to a stale legacy specification and legacy reads stay supported', async () => {
  const { workspace, runDir } = await setup();
  try {
    await writeFile(join(runDir, 'plan/design_plan.json'), JSON.stringify({ design_intent: 'Stale' }));
    await assert.rejects(readRunContext(runDir, 'plan/design_plan.json'), /ENOENT/);
    await saveContextDocument(runDir, CONTEXT_FILES.design, design, 'demo');
    assert.equal(JSON.parse(await readRunContext(runDir, 'plan/design_plan.json')).design_intent, design.strategy.design_intent);
    await writeFile(join(runDir, CONTEXT_FILES.design), '{invalid');
    await assert.rejects(readRunContext(runDir, 'plan/design_plan.json'), SyntaxError);
    await rm(join(runDir, 'context'), { recursive: true });
    await assert.rejects(readRunContext(runDir, 'plan/design_plan.json'), /ENOENT/);
    const brief = JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8'));
    delete brief.contextFormat;
    await writeFile(join(runDir, 'brief.json'), JSON.stringify(brief));
    assert.equal(JSON.parse(await readRunContext(runDir, 'plan/design_plan.json')).design_intent, 'Stale');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('unified mixed tasks preserve prompts, recover from review failure, reuse outputs and seal sources', async () => {
  const { workspace, runDir } = await setup();
  const fetchOriginal = globalThis.fetch, keyOriginal = process.env.DREAMATIC_IMAGE_API_KEY;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  try {
    const researcher = harness(workspace, 'researcher');
    await researcher.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.research, data: research });
    await researcher.invoke('design_bus_post', completion('research_done', 'Research complete'));
    const mixed = structuredClone(design);
    mixed.tasks.push({ id: 'hero', scope_id: 'ui', category: 'ux', method: 'image_generate', prompt_seed: 'Exact approved hero', negative_prompt_seed: 'Watermark', size: '512x512', size_rationale: 'Concept image', acceptance_test: 'Research concept shown', dependencies: [] });
    mixed.tasks[0].resources = [{ source: 'artifacts/hero.png', output: 'artifacts/ui/hero.png' }];
    mixed.tasks[0].dependencies = ['hero'];
    mixed.deliverables.push({ id: 'hero', scope_id: 'ui', category: 'ux', skill_refs: ['ui-web-design'], kind: 'image', purpose: 'Research concept', acceptance_test: 'Research concept shown', required: true, file: 'artifacts/hero.png' });
    await mkdir(join(runDir, 'plan/html/ui'), { recursive: true });
    await writeFile(join(runDir, 'plan/html/ui/index.html'), '<!doctype html><html><head><title>Research</title></head><body><h1>Research</h1><img src="hero.png" alt="Research concept"></body></html>');
    const designer = harness(workspace, 'designer');
    await designer.invoke('use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary' });
    await designer.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.design, data: mixed });
    await designer.invoke('design_bus_post', completion('design_spec_ready', 'Draft ready'));
    const reviewer = harness(workspace, 'reviewer');
    await reviewer.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.review, data: { ...review, assessment: { ...review.assessment, verdict: 'fail', summary: 'Clarify intent', issues: [{ id: 'intent', severity: 'major', status: 'open', owner: 'designer' }] } } });
    await reviewer.invoke('design_bus_post', completion('design_review_fail', 'Clarify intent'));
    const builder = harness(workspace, 'builder');
    await assert.rejects(builder.invoke('execute_design_plan', { runId: 'demo' }), /approved|approval/i);
    const repairedDesigner = harness(workspace, 'designer');
    await repairedDesigner.invoke('use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary' });
    mixed.revision = 2;
    mixed.strategy.design_intent = 'Clarified research concept';
    await repairedDesigner.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.design, data: mixed });
    await repairedDesigner.invoke('design_bus_post', completion('design_revision_ready', 'Intent clarified'));
    await reviewer.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.review, data: { ...review, revision: 2, assessment: { ...review.assessment, round: 2 } } });
    await reviewer.invoke('design_bus_post', completion('design_review_pass', 'Approved correction'));
    process.env.DREAMATIC_IMAGE_API_KEY = 'test';
    const prompts = [];
    globalThis.fetch = async (_url, init) => { prompts.push(JSON.parse(init.body).prompt); return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); };
    const first = await builder.invoke('execute_design_plan', { runId: 'demo' });
    assert.equal(first.succeeded, 2);
    assert.deepEqual(prompts, ['Exact approved hero\n\nAvoid: Watermark']);
    assert.ok((await readFile(join(runDir, 'artifacts/ui/hero.png'))).equals(png));
    const reused = await builder.invoke('execute_design_plan', { runId: 'demo' });
    assert.ok(reused.results.every(result => result.reused));
    assert.equal(prompts.length, 1);
    const approvedSource = await readFile(join(runDir, 'plan/html/ui/index.html'), 'utf8');
    await writeFile(join(runDir, 'plan/html/ui/index.html'), 'Changed after approval');
    await assert.rejects(builder.invoke('execute_design_plan', { runId: 'demo' }), /changed after/);
    await writeFile(join(runDir, 'plan/html/ui/index.html'), approvedSource);
    await builder.invoke('build_finalize', { runId: 'demo' });
    const manifest = JSON.parse(await readFile(join(runDir, 'artifacts/artifact-manifest.json')));
    assert.ok(manifest.artifacts.every(item => item.provenance.plan === CONTEXT_FILES.design));
    for (const path of Object.values(CONTEXT_PROJECTIONS).flat()) await assert.rejects(readFile(join(runDir, path)), /ENOENT/);

  } finally {
    globalThis.fetch = fetchOriginal;
    if (keyOriginal === undefined) delete process.env.DREAMATIC_IMAGE_API_KEY; else process.env.DREAMATIC_IMAGE_API_KEY = keyOriginal;
    await rm(workspace, { recursive: true, force: true });
  }
});

test('real Reviewer misnesting is rejected before saving and a canonical correction saves safely', async () => {
  const { workspace, runDir } = await setup();
  try {
    const reviewer = harness(workspace, 'reviewer');
    const bad = { schemaVersion: 1, runId: 'demo', revision: 1, assessment: { requirement_fit: 8 }, verdict: 'fail', summary: 'Actual diagnosis', issues: [{ id: 'architecture', severity: 'major', status: 'open', owner: 'designer' }], resolved_issue_ids: [], remaining_risks: [] };
    await assert.rejects(reviewer.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.review, data: bad }), /context\/review.json#\/verdict.*assessment/);
    await assert.rejects(readFile(join(runDir, CONTEXT_FILES.review)), /ENOENT/);
    const valid = { ...review, assessment: { ...review.assessment, verdict: 'fail', summary: bad.summary, scores: bad.assessment, issues: bad.issues } };
    await reviewer.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.review, data: valid });
    const saved = await readFile(join(runDir, CONTEXT_FILES.review), 'utf8');
    const malformed = { ...valid, revision: 2, assessment: { ...valid.assessment, review_stage: undefined } };
    await assert.rejects(reviewer.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.review, data: malformed }), /context\/review.json#\/assessment\/review_stage/);
    assert.equal(await readFile(join(runDir, CONTEXT_FILES.review), 'utf8'), saved);
    await assert.rejects(reviewer.invoke('patch_json', { runId: 'demo', path: CONTEXT_FILES.review, sha256: 'x', updates: '[{"pointer":"/revision","value":2}]' }), /actual array/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('unified prompts remove legacy authoring steps and retain explicit nesting and common domain rules', async () => {
  const { unifiedContextPrompt, legacyContextPrompt, canonicalContextError, contextAuthoringExample } = await import('../dist/context-model.js');
  for (const role of ['researcher', 'designer', 'reviewer']) {
    const source = await readFile(join(cwd, '.pi/agents', `${role}.md`), 'utf8');
    const prompt = unifiedContextPrompt(source);
    assert.doesNotMatch(prompt, /Author three JSON files|Markdown via `write`|mirrors the verdict|both review paths in `artifactRefs`/);
    assert.match(prompt, /actual array|actual evidence/);
    assert.doesNotMatch(legacyContextPrompt(source), /The root is:|Write context\/design.json/);
    const example = contextAuthoringExample(role, 'demo');
    assert.doesNotThrow(() => contextProjections(example.path, example.data, 'demo'));
  }
  const prompt = unifiedContextPrompt(await readFile(join(cwd, '.pi/agents/reviewer.md'), 'utf8'));
  assert.match(prompt, /assessment is the ENTIRE review/);
  assert.match(prompt, /assessment.scores/);
  assert.equal(canonicalContextError('review/design-review.json.review_stage must be design_context'), 'context/review.json#/assessment/review_stage must be design_context');
  assert.equal(canonicalContextError('plan/design_plan.json.execution_plan[0].method'), 'context/design.json#/tasks/0/method');
});

test('three unchanged Context failures stop the specialist and unrelated failures never trigger this gate', async () => {
  const { workspace } = await setup();
  try {
    const reviewer = harness(workspace, 'reviewer');
    const feedback = reviewer.handlers.get('tool_result');
    const event = { toolName: 'design_bus_post', input: {}, isError: true, content: [{ type: 'text', text: 'review/design-review.json.review_stage must be design_context' }] };
    assert.equal((await feedback(event)).details.attempts, 1);
    assert.equal((await feedback(event)).details.blocked, false);
    const third = await feedback(event);
    assert.equal(third.details.blocked, true);
    assert.equal(third.details.repairOwner, 'reviewer');
    assert.match(third.details.issue, /context\/review.json#\/assessment\/review_stage/);
    const next = await reviewer.handlers.get('tool_call')({ toolName: 'write_json', input: {} }, { cwd });
    assert.equal(next.terminate, true);
    const fresh = harness(workspace, 'reviewer');
    for (let i = 0; i < 4; i++) assert.equal(await fresh.handlers.get('tool_result')({ ...event, toolName: 'read', content: [{ type: 'text', text: 'ECONNRESET' }] }), undefined);
    assert.equal(await fresh.handlers.get('tool_call')({ toolName: 'write_json', input: {} }, { cwd }), undefined);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('scope and loaded Skill mismatches cannot overwrite a unified draft', async () => {
  const { workspace, runDir } = await setup();
  try {
    const designer = harness(workspace, 'designer');
    await designer.invoke('use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary' });
    await designer.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.design, data: design });
    const original = await readFile(join(runDir, CONTEXT_FILES.design), 'utf8');
    const wrongScope = structuredClone(design); wrongScope.revision = 2; wrongScope.deliverables[0].category = 'industrial';
    await assert.rejects(designer.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.design, data: wrongScope }), /scope_id\/category/);
    const wrongSkill = structuredClone(design); wrongSkill.revision = 2; wrongSkill.deliverables[0].skill_refs = ['unloaded'];
    await assert.rejects(designer.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.design, data: wrongSkill }), /loaded skill_refs/);
    const fresh = harness(workspace, 'designer');
    await assert.rejects(fresh.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.design, data: { ...design, revision: 2 } }), /not activated|loaded skill_refs/);
    assert.equal(await readFile(join(runDir, CONTEXT_FILES.design), 'utf8'), original);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('missing tool paths and misplaced document envelopes report the exact role call before execution', async () => {
  const { workspace } = await setup();
  try {
    const reviewer = harness(workspace, 'reviewer');
    const tool = reviewer.tools.get('write_json');
    for (const args of [{ data: { assessment: {} } }, { runId: 'demo', schemaVersion: 1, revision: 1, data: { assessment: {} } }]) {
      assert.throws(() => tool.prepareArguments(args), /Exact role argument example:.*"runId":"demo","path":"context\/review.json".*INSIDE data/);
    }
    const context = await reviewer.invoke('design_context_read', { runId: 'demo', audience: 'reviewer' });
    assert.equal(context.authoringExample.runId, 'demo');
    assert.equal(context.authoringExample.path, CONTEXT_FILES.review);
    assert.equal(context.authoringExample.data.schemaVersion, 1);
    const designer = harness(workspace, 'designer');
    const designContext = await designer.invoke('design_context_read', { runId: 'demo', audience: 'designer' });
    assert.equal(designContext.associationContract.assignedScopes[0].id, 'ui');
    assert.match(designContext.associationContract.rule, /never omit system/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
