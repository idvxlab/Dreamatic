import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
async function save(h, runDir, document) {
  const { schemaVersion, runId, revision, ...data } = document;
  const rolePath = data.assessment ? CONTEXT_FILES.review : data.evidence ? CONTEXT_FILES.research : CONTEXT_FILES.design;
  const source = await readFile(join(runDir, rolePath), 'utf8').catch(e => { if (e.code === 'ENOENT') return undefined; throw e; });
  return h.invoke('save_design_context', { expectedSha256: source === undefined ? null : createHash('sha256').update(source).digest('hex'), data });
}
async function setup(assignedScopes = [{ id: 'ui', category: 'ux', task: 'Academic page' }]) {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-unified-'));
  const root = harness(workspace);
  await root.invoke('run_init', { runIdOverride: 'demo', projectTitle: 'A coherent page', brief: 'Build an academic page', designScopes: assignedScopes });
  // Historical unified-v1 fixtures remain version 1; new v2 has a separate regression suite.
  const runDir = join(workspace, 'runs/demo');
  const brief = JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8'));
  brief.designContractVersion = 1;
  await writeFile(join(runDir, 'brief.json'), JSON.stringify(brief));
  const project = JSON.parse(await readFile(join(runDir, 'context/project.json'), 'utf8'));
  project.brief.designContractVersion = 1;
  await writeFile(join(runDir, 'context/project.json'), JSON.stringify(project));
  return { workspace, runDir, root };
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
    await save(researcher, runDir, research);
    await researcher.invoke('design_bus_post', completion('research_done', 'Researched'));
    const designer = harness(workspace, 'designer');
    await designer.invoke('use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary' });
    await mkdir(join(runDir, 'plan/html/ui'), { recursive: true });
    await writeFile(join(runDir, 'plan/html/ui/index.html'), '<!doctype html><html><head><title>Research</title></head><body><h1>Research</h1></body></html>');
    await save(designer, runDir, design);
    const spec = await designer.invoke('design_bus_post', completion('design_spec_ready', 'Designed'));
    assert.equal(spec.ok, true);
    assert.ok(spec.event.artifactRefs.includes(CONTEXT_FILES.design));
    const reviewer = harness(workspace, 'reviewer');
    await save(reviewer, runDir, review);
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
    const finalized = await builder.invoke('build_finalize', { runId: 'demo' });
    assert.deepEqual(finalized.nextAction, { tool: 'export_package', arguments: { runId: 'demo' } });
    assert.match(finalized.instruction, /immediately without reading artifacts/);
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
    const saved = await save(designer, runDir, design);
    await assert.rejects(designer.invoke('save_design_context', { expectedSha256: null, data: {} }), /changed since/);
    await assert.rejects(designer.invoke('write_json', {runId:'demo',path:CONTEXT_FILES.design,data:design}), /update_design_context/);
    await assert.rejects(designer.invoke('write_json', { runId: 'demo', path: 'plan/design_plan.json', data: {} }), /read-only/);
    await assert.rejects(save(designer, runDir, review), /context\/design.json/);
    const native = await designer.handlers.get('tool_call')({ toolName: 'write', input: { path: join(runDir, CONTEXT_FILES.design), content: '{}' } }, { cwd });
    assert.equal(native.block, true);
    const patched = await designer.invoke('patch_design_context', { expectedSha256: saved.sha256, updates: [ { pointer: '/strategy/design_intent', value: 'A revised intent' }] });
    assert.notEqual(patched.sha256, saved.sha256);
    assert.equal(JSON.parse(await readRunContext(runDir, 'plan/design_plan.json')).design_intent, 'A revised intent');
    await assert.rejects(designer.invoke('patch_design_context', { expectedSha256: saved.sha256, updates: [{ pointer: '/strategy/design_intent', value: 'Stale' }] }), /changed since/);
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
    await save(researcher, runDir, research);
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
    await save(designer, runDir, mixed);
    const published = await designer.invoke('design_bus_post', completion('design_spec_ready', 'Draft ready'));
    assert.equal(published.ok, true, JSON.stringify(published));
    const reviewer = harness(workspace, 'reviewer');
    await save(reviewer, runDir, { ...review, assessment: { ...review.assessment, verdict: 'fail', summary: 'Clarify intent', issues: [{ id: 'intent', severity: 'major', status: 'open', owner: 'designer' }] } });
    await reviewer.invoke('design_bus_post', completion('design_review_fail', 'Clarify intent'));
    const builder = harness(workspace, 'builder');
    await assert.rejects(builder.invoke('execute_design_plan', { runId: 'demo' }), /approved|approval/i);
    const repairedDesigner = harness(workspace, 'designer');
    await repairedDesigner.invoke('use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary' });
    mixed.revision = 2;
    mixed.strategy.design_intent = 'Clarified research concept';
    await save(repairedDesigner, runDir, mixed);
    await repairedDesigner.invoke('design_bus_post', completion('design_revision_ready', 'Intent clarified'));
    await save(reviewer, runDir, { ...review, revision: 2, assessment: { ...review.assessment, round: 2 } });
    await reviewer.invoke('design_bus_post', completion('design_review_pass', 'Approved correction'));
    process.env.DREAMATIC_IMAGE_API_KEY = 'test';
    const prompts = [];
    globalThis.fetch = async (_url, init) => { prompts.push(JSON.parse(init.body).prompt); return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); };
    const exact = {runId:'demo',id:'hero',intent:'Research concept',prompt:'Exact approved hero\n\nAvoid: Watermark',size:'512x512',acceptanceCriteria:['Research concept shown']};
    for (const changes of [{prompt:'Unapproved design'},{size:'256x256'},{acceptanceCriteria:['Different criterion']},{preserve:['Unapproved rule']}])
      await assert.rejects(builder.invoke('image_generate',{...exact,...changes}),/differs from the approved task/);
    await assert.rejects(builder.invoke('image_generate_batch',{runId:'demo',tasks:[exact,{...exact,id:'invented'}]}),/Unknown approved/);
    assert.equal(prompts.length,0);
    const first = await builder.invoke('execute_design_plan', { runId: 'demo' });
    assert.equal(first.succeeded, 2);
    assert.deepEqual(prompts, ['Exact approved hero\n\nAvoid: Watermark']);
    assert.ok((await readFile(join(runDir, 'artifacts/ui/hero.png'))).equals(png));
    const reused = await builder.invoke('execute_design_plan', { runId: 'demo' });
    assert.ok(reused.results.every(result => result.reused));
    assert.equal(prompts.length, 1);
    const sidecarPath=join(runDir,'artifacts/hero.png.json');
    const sidecar=await readFile(sidecarPath,'utf8');
    await writeFile(sidecarPath,JSON.stringify({...JSON.parse(sidecar),planFingerprint:'wrong'}));
    const blocked=await builder.invoke('build_finalize',{runId:'demo'});assert.equal(blocked.ok,false);assert.match(JSON.stringify(blocked),/approved execution evidence/);
    await writeFile(sidecarPath,sidecar);

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
    await assert.rejects(save(reviewer, runDir, bad), /context\/review.json#\/verdict.*assessment/);
    await assert.rejects(readFile(join(runDir, CONTEXT_FILES.review)), /ENOENT/);
    const valid = { ...review, assessment: { ...review.assessment, verdict: 'fail', summary: bad.summary, scores: bad.assessment, issues: bad.issues } };
    await save(reviewer, runDir, valid);
    const saved = await readFile(join(runDir, CONTEXT_FILES.review), 'utf8');
    const malformed = { ...valid, revision: 2, assessment: { ...valid.assessment, review_stage: undefined } };
    await assert.rejects(save(reviewer, runDir, malformed), /context\/review.json#\/assessment\/review_stage/);
    assert.equal(await readFile(join(runDir, CONTEXT_FILES.review), 'utf8'), saved);
    await assert.rejects(reviewer.invoke('patch_json', { runId: 'demo', path: CONTEXT_FILES.review, sha256: 'x', updates: '[{"pointer":"/revision","value":2}]' }), /actual array/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('unified prompts remove legacy authoring steps and retain explicit nesting and common domain rules', async () => {
  const { unifiedContextPrompt, legacyContextPrompt, canonicalContextError } = await import('../dist/context-model.js');
  const { contextChangesExample, prepareContextChanges } = await import('../dist/context-tools.js');
  for (const role of ['researcher', 'designer', 'reviewer']) {
    const source = await readFile(join(cwd, '.pi/agents', `${role}.md`), 'utf8');
    const prompt = unifiedContextPrompt(source);
    assert.doesNotMatch(prompt, /Author three JSON files|Markdown via `write`|mirrors the verdict|both review paths in `artifactRefs`/);
    assert.match(prompt, /runtime-provided role-specific Context contract/);
    assert.doesNotMatch(prompt,/expectedSha256|expectedDraftSha256|save_design_context|patch_design_context/);
    assert.doesNotMatch(legacyContextPrompt(source), /The root is:|Write context\/design.json/);
    const example = contextChangesExample(role);
    assert.deepEqual(Object.keys(example), ['changes']);
    assert.doesNotThrow(() => prepareContextChanges(example, role, 2));
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
    await feedback(event);
    const third = await feedback(event);
    assert.equal(third.details.blocked, true);
    assert.equal(third.details.repairOwner, 'reviewer');
    assert.match(third.details.issue, /context\/review.json#\/assessment\/review_stage/);
    const next = await reviewer.handlers.get('tool_call')({ toolName: 'write_json', input: {} }, { cwd });
    assert.equal(next.terminate, true);
    const fresh = harness(workspace, 'reviewer');
    for (let i = 0; i < 4; i++) assert.equal(await fresh.handlers.get('tool_result')({ ...event, toolName: 'read', content: [{ type: 'text', text: 'ECONNRESET' }] }), undefined);
    assert.equal((await fresh.handlers.get('tool_call')({ toolName: 'write_json', input: {} }, { cwd })).block, true);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('scope and loaded Skill mismatches cannot overwrite a unified draft', async () => {
  const { workspace, runDir } = await setup();
  try {
    const designer = harness(workspace, 'designer');
    await designer.invoke('use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary' });
    await save(designer, runDir, design);
    const original = await readFile(join(runDir, CONTEXT_FILES.design), 'utf8');
    const wrongScope = structuredClone(design); wrongScope.revision = 2; wrongScope.deliverables[0].category = 'industrial';
    await assert.rejects(save(designer, runDir, wrongScope), /scope_id\/category/);
    const wrongSkill = structuredClone(design); wrongSkill.revision = 2; wrongSkill.deliverables[0].skill_refs = ['unloaded'];
    await assert.rejects(save(designer, runDir, wrongSkill), /loaded skill_refs/);
    const fresh = harness(workspace, 'designer');
    await assert.rejects(save(fresh, runDir, { ...design, revision: 2 }), /not activated|loaded skill_refs/);
    assert.equal(await readFile(join(runDir, CONTEXT_FILES.design), 'utf8'), original);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('missing tool paths and misplaced document envelopes report the exact role call before execution', async () => {
  const { workspace } = await setup();
  try {
    const reviewer = harness(workspace, 'reviewer');
    const tool = reviewer.tools.get('write_json');
    for (const args of [{ data: { assessment: {} } }, { runId: 'demo', schemaVersion: 1, revision: 1, data: { assessment: {} } }]) {
      assert.throws(() => tool.prepareArguments(args), /path/);
    }
    const context = await reviewer.invoke('design_context_read', { runId: 'demo', audience: 'reviewer' });
    assert.equal(context.authoringExample.changes.assessment.verdict, 'fail');
    assert.equal('expectedSha256' in context.authoringExample, false);
    assert.equal(context.workingContext.versionManagedByRuntime,true);
    const designer = harness(workspace, 'designer');
    const designContext = await designer.invoke('design_context_read', { runId: 'demo', audience: 'designer' });
    assert.equal(designContext.associationContract.assignedScopes[0].id, 'ui');
    assert.match(designContext.associationContract.rule, /runtime provides/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('bound saves reject metadata and stale concurrent replacements without modifying valid content', async () => {
  const {workspace,runDir} = await setup();
  try {
    const h = harness(workspace,'reviewer');
    const {schemaVersion,runId,revision,...data} = review;
    const saved = await h.invoke('save_design_context',{expectedSha256:null,data});
    const results = await Promise.allSettled([1,2].map(n => h.invoke('patch_design_context',{expectedSha256:saved.sha256,updates:[{pointer:'/assessment/summary',value:`Revision ${n}`}]})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(JSON.parse(await readFile(join(runDir,CONTEXT_FILES.review),'utf8')).revision,2);
    const source = await readFile(join(runDir,CONTEXT_FILES.review),'utf8');
    const hash = createHash('sha256').update(source).digest('hex');
    await assert.rejects(h.invoke('save_design_context',{expectedSha256:hash,data:{...data,revision:99}}),/runtime-owned/);
    await assert.rejects(h.invoke('patch_design_context',{expectedSha256:hash,updates:[{pointer:'/revision',value:99}]}),/protected/);
    await assert.rejects(h.invoke('patch_json',{runId:'demo',path:CONTEXT_FILES.review,sha256:hash,updates:[{pointer:'/assessment/verdict',value:'pass'}]}),/update_design_context/);
    assert.equal(await readFile(join(runDir,CONTEXT_FILES.review),'utf8'),source);
  } finally { await rm(workspace,{recursive:true,force:true}); }
});

test('new Orchestrator starts with unified persistence rules before Run initialization', async () => {
 const workspace=await mkdtemp(join(tmpdir(),'dreamatic-initial-contract-'));
 try {
  const handlers=new Map();
  createDreamaticExtension({workspaceDir:workspace,personaPath:join(cwd,'.pi/agents/orchestrator.md')})({registerTool:()=>{},setActiveTools:()=>{},on:(name,handler)=>handlers.set(name,handler)});
  const result=await handlers.get('before_agent_start')({prompt:'Create a design',systemPrompt:'Base'});
  assert.match(result.systemPrompt,/run_brief_update/);
  assert.match(result.systemPrompt,/audience:"orchestrator"/);
  assert.doesNotMatch(result.systemPrompt,/research\/research-findings.md|research\/evidence.json/);
  await handlers.get('before_provider_request')({payload:{model:'mock',messages:[{role:'user',content:'private-content'}],enable_thinking:false}});
  await handlers.get('after_provider_response')({status:200,headers:{Authorization:'private-key'}});
  await handlers.get('message_update')({assistantMessageEvent:{type:'thinking_delta',delta:'private-reasoning'}});
  const log=await readFile(join(workspace,'.performance/model-requests.jsonl'),'utf8');
  assert.doesNotMatch(log,/private-/);
  const records=log.trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(r=>r.type),['provider_request','provider_response_headers','provider_first_delta']);
  assert.ok(records.every(r=>r.requestId===records[0].requestId));
 } finally {await rm(workspace,{recursive:true,force:true});}
});


const domainData = document => {const {schemaVersion,runId,revision,...data}=structuredClone(document);if(data.strategy)delete data.strategy.skill_selection;return data;};
const inspect = h => h.invoke('update_design_context',{changes:{}});
const change = (h,changes) => h.invoke('update_design_context',{changes});
const commit = h => h.invoke('commit_design_context',{});
const draftSource = runDir => readFile(join(runDir,'.performance/context-draft-designer.json'),'utf8');

test('named authoring starts incomplete, preserves nested evidence and never asks the model for hashes',async()=>{
 const {workspace,runDir}=await setup();
 try{
  const h=harness(workspace,'researcher');
  const read=await inspect(h);assert.equal(read.hasWorkingDraft,false);
  await assert.rejects(readFile(join(runDir,'.performance/context-draft-researcher.json'),'utf8'),/ENOENT/);
  await change(h,{evidence:{target:'Research',summary:'Evidence',official_sources:[],open_questions:[]},findings:'Findings'});
  const rejected=await commit(h);assert.equal(rejected.ok,false);
  assert.ok(rejected.issues.some(issue=>issue.pointer==='/usageConditions'));
  await change(h,{usageConditions:'No restrictions'});
  const saved=await commit(h);assert.equal(saved.ok,true);
  assert.equal('draftSha256' in saved,false);assert.equal('sha256' in saved,false);
  const retained=JSON.parse(await readFile(join(runDir,'.performance/context-draft-researcher.json'),'utf8'));
  assert.equal(typeof retained.baseSha256,'string');
  assert.equal(JSON.parse(await readFile(join(runDir,CONTEXT_FILES.research),'utf8')).revision,1);
  assert.equal((await commit(h)).unchanged,true);
  assert.equal(JSON.parse(await readFile(join(runDir,CONTEXT_FILES.research),'utf8')).revision,1);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('named fields eliminate review wrappers while preserving evidence and verification',async()=>{
 const {workspace}=await setup();
 try{
  const h=harness(workspace,'reviewer');
  const details={id:'issue',evidence:['Source'],verification:'Verify source',severity:'major',owner:'designer',status:'open',diagnosis:'Actual diagnosis'};
  await change(h,{assessment:{issues:[details],resolved_issue_ids:[],remaining_risks:[]}});
  const prior=(await inspect(h)).data;
  await assert.rejects(h.invoke('update_design_context',{changes:'JSON text'}),/named-field object/);
  await assert.rejects(h.invoke('update_design_context',{expectedDraftSha256:null,updates:[]}),/Unexpected arguments/);
  await assert.rejects(change(h,{assessment:{verdict:'not-valid'}}),/verdict/);
  await change(h,{assessment:{summary:'Summary'}});
  const read=await inspect(h);assert.deepEqual(read.data.assessment.issues[0],details);assert.equal(read.data.assessment.summary,'Summary');
  assert.deepEqual(prior.assessment.issues,read.data.assessment.issues);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('read-only inspection preserves persisted Skill selections and draft bytes in a fresh invocation',async()=>{
 const {workspace,runDir}=await setup();
 try{
  const h=harness(workspace,'designer');await h.invoke('use_skill',{name:'ui-web-design',scopeId:'ui',role:'primary',rationale:'Academic interface'});
  await change(h,domainData(design));
  const before=await draftSource(runDir);
  const fresh=harness(workspace,'designer');
  const read=await fresh.invoke('design_context_read',{runId:'demo',audience:'designer',full:true});
  assert.equal(read.workingContext.data.strategy.skill_selection[0].name,'ui-web-design');
  assert.ok(read.workingContext.issues.some(issue=>issue.code==='skill_not_loaded'));
  await inspect(fresh);assert.equal(await draftSource(runDir),before);
  const rejected=await commit(fresh);assert.equal(rejected.ok,false);assert.equal(await draftSource(runDir),before);
  await fresh.invoke('use_skill',{name:'ui-web-design',scopeId:'ui',role:'primary',rationale:'Academic interface'});
  assert.equal((await commit(fresh)).ok,true);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('same-invocation batched calls succeed while other observed writers cannot overwrite unnoticed changes',async()=>{
 const {workspace}=await setup();
 try{
  const h=harness(workspace,'reviewer');await inspect(h);
  await Promise.all([change(h,{assessment:{summary:'Summary'}}),change(h,{assessment:{scores:{quality:8}}})]);
  const second=harness(workspace,'reviewer');await inspect(second);
  await change(h,{assessment:{round:1}});
  await assert.rejects(change(second,{assessment:{summary:'Stale writer'}}),/another invocation/);
  await assert.rejects(commit(second),/another invocation/);
  assert.equal((await inspect(second)).data.assessment.summary,'Summary');
  await change(second,{assessment:{summary:'Reconciled'}});
  assert.equal((await inspect(second)).data.assessment.scores.quality,8);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('canonical conflicts retain working content and explicit reset refreshes from current canonical',async()=>{
 const {workspace,runDir}=await setup();
 try{
  const h=harness(workspace,'reviewer');await save(h,runDir,review);await inspect(h);
  await change(h,{assessment:{summary:'Working revision'}});
  const current=await readFile(join(runDir,CONTEXT_FILES.review),'utf8');
  await h.invoke('patch_design_context',{expectedSha256:createHash('sha256').update(current).digest('hex'),updates:[{pointer:'/assessment/summary',value:'Concurrent canonical revision'}]});
  const failed=await commit(h);assert.equal(failed.ok,false);assert.match(failed.issues[0].message,/changed/);
  assert.equal((await inspect(h)).data.assessment.summary,'Working revision');
  const retained = await readFile(join(runDir,'.performance/context-draft-reviewer.json'),'utf8');
  await assert.rejects(h.invoke('update_design_context',{changes:{},reset:true}),/canonical:true/);
  assert.equal(await readFile(join(runDir,'.performance/context-draft-reviewer.json'),'utf8'),retained);
  const canonical = await h.invoke('design_context_read',{runId:'demo',audience:'reviewer',canonical:true});
  assert.equal(canonical.workingContext.data.assessment.summary,'Concurrent canonical revision');
  await h.invoke('update_design_context',{changes:{},reset:true});
  assert.equal((await inspect(h)).data.assessment.summary,'Concurrent canonical revision');
  assert.equal((await commit(h)).unchanged,true);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('stable-id updates preserve other tasks and merge object fields; ordinary arrays replace explicitly',async()=>{
 const {workspace,runDir}=await setup();
 try{
  const h=harness(workspace,'designer');await h.invoke('use_skill',{name:'ui-web-design',scopeId:'ui',role:'primary',rationale:'Academic interface'});
  await change(h,{...domainData(design),tasks:[...design.tasks,{id:'second',method:'manual'}],deliverables:[...design.deliverables,{...design.deliverables[0],id:'second',file:'artifacts/second.png'}]});
  await change(h,{tasks:[{id:'page',interaction_checks:[{name:'Navigation',steps:[]}]}],system:{palette:{accent:'#abc'}}});
  const read=await inspect(h);assert.equal(read.data.tasks.length,2);assert.equal(read.data.tasks[0].method,'html_generate');assert.equal(read.data.tasks[0].interaction_checks.length,1);assert.equal(read.data.system.system_thesis,design.system.system_thesis);
  await change(h,{removeTasks:['second'],removeDeliverables:['second']});
  assert.equal((await inspect(h)).data.tasks.length,1);
  await assert.rejects(change(h,{tasks:[{method:'manual'}]}),/id/);
  await assert.rejects(change(h,{strategy:{skill_selection:[]}}),/runtime-owned/);
  await assert.rejects(change(h,{revision:88}),/additional|named/);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('committed work remains editable after publication failure and survives restart',async()=>{
 const {workspace,runDir}=await setup();
 try{
  const h=harness(workspace,'designer');await h.invoke('use_skill',{name:'ui-web-design',scopeId:'ui',role:'primary',rationale:'Academic interface'});
  await change(h,domainData(design));assert.equal((await commit(h)).ok,true);
  await assert.rejects(h.invoke('design_bus_post',completion('design_spec_ready','Ready')),/source|missing|HTML/i);
  const canonical=await readFile(join(runDir,CONTEXT_FILES.design),'utf8');
  await change(h,{strategy:{design_intent:'Corrected intent'}});
  assert.equal(await readFile(join(runDir,CONTEXT_FILES.design),'utf8'),canonical);
  const fresh=harness(workspace,'designer');await fresh.invoke('use_skill',{name:'ui-web-design',scopeId:'ui',role:'primary',rationale:'Academic interface'});
  await assert.rejects(commit(fresh),/Read design_context_read/);
  await fresh.invoke('design_context_read',{runId:'demo',audience:'designer'});assert.equal((await commit(fresh)).ok,true);
  assert.equal(JSON.parse(await readFile(join(runDir,CONTEXT_FILES.design),'utf8')).revision,2);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('unrelated named changes do not reset retries for missing required fields',async()=>{
 const {workspace}=await setup();
 try{
  const h=harness(workspace,'reviewer');
  for(let n=1;n<=3;n++){await change(h,{assessment:{scores:{unrelated:n}}});const result=await commit(h);assert.equal(result.attempts,n);assert.equal(result.blocked,n===3);}
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('draft reads reject symlinks and never create a missing working directory or file',async()=>{
 const {workspace,runDir}=await setup();const outside=await mkdtemp(join(tmpdir(),'dreamatic-outside-'));
 try{
  await rm(join(runDir,'.performance'),{recursive:true,force:true});
  await inspect(harness(workspace,'reviewer'));
  await assert.rejects(readFile(join(runDir,'.performance/context-draft-reviewer.json'),'utf8'),/ENOENT/);
  await assert.rejects(import('node:fs/promises').then(fs=>fs.stat(join(runDir,'.performance'))),/ENOENT/);
  await symlink(outside,join(runDir,'.performance'));
  await assert.rejects(inspect(harness(workspace,'reviewer')),/symlink/);
 }finally{await rm(workspace,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

 test('named-field failures track the offending value independently of unrelated prose',async()=>{
 const {prepareContextChanges,contextFailureIdentity}=await import('../dist/context-tools.js');
 const identities=[];
 for(const summary of ['First','Second']){
  const args={changes:{assessment:{verdict:'invalid',summary}}};
  try{prepareContextChanges(args,'reviewer');assert.fail('expected validation failure');}catch(error){
   assert.match(error.message,/changes\/assessment\/verdict/);
   identities.push(contextFailureIdentity('update_design_context',error.message,args).key);
  }
 }
 assert.equal(identities[0],identities[1]);
 });


test('poster failure chain has early scope diagnostics and a local empty-array repair', async () => {
 const { workspace, runDir } = await setup([{ id: 'poster-campaign', category: 'media_communication', task: 'Tea cup posters' }]);
 try {
  const h = harness(workspace, 'designer');
  await inspect(h);
  for (const [name, role] of [['poster-advertising', 'primary'], ['image-prompting', 'supporting'], ['visual-composition', 'supporting']]) {
   await h.invoke('use_skill', { name, role, scopeId: 'poster-campaign', rationale: `Tea cup poster contribution from ${name}` });
  }
  const system = { system_thesis: 'Poetic tea cup campaign', palette: { paper: '#eee' }, typography: { headline: 'Song' } };
  const strategy = { design_intent: 'Celebrate ceramic craft', evidence: ['Preserved observation'] };
  await assert.rejects(change(h, { system, strategy: { ...strategy, skill_selection: [] } }), error => {
   const failure = JSON.parse(error.message);
   assert.equal(failure.saved, false); assert.equal(failure.committed, false);
   assert.equal(failure.code, 'runtime_owned_field'); assert.match(failure.instruction, /No fields were saved/);
   return true;
  });
  await assert.rejects(draftSource(runDir), /ENOENT/);
  const ids = ['poster-social-1', 'poster-social-2', 'poster-retail-1', 'poster-ecommerce-1'];
  const refs = ['poster-advertising', 'image-prompting', 'visual-composition'];
  const deliverables = ids.map(id => ({ id, scope_id: 'poster-campaign', skill_refs: refs, contributing_scopes: [{ scope_id: 'poster-campaign', skill_refs: refs, purpose: 'Poster design' }], kind: 'image', purpose: id, acceptance_test: 'Readable brand and recognizable cup', required: true, file: `artifacts/${id}.png` }));
  const tasks = ids.map(id => ({ id, method: 'image_generate', size: '512x512', size_rationale: 'Concept view', prompt_seed: `Tea cup ${id}`, negative_prompt_seed: 'Watermark' }));
  const incomplete = await change(h, { tasks, deliverables, presentation: { mode: 'gallery', entry: 'artifacts/00-gallery.html' } });
  assert.equal(incomplete.saved, true); assert.equal(incomplete.committed, false);
  assert.equal(incomplete.issues.filter(issue => issue.code === 'duplicate_contributing_scope').length, 4);
  const first = await commit(h); assert.equal(first.saved, false); assert.equal(first.committed, false);
  assert.ok(first.issues.some(issue => issue.code === 'invalid_context_structure' && issue.pointer === '/system'));
  const filled = await change(h, { system, strategy });
  assert.equal(filled.readiness, 'blocked');
  const duplicate = await commit(h);
  assert.deepEqual(duplicate.issues, filled.issues);
  assert.equal(duplicate.issues[0].deliverableId, ids[0]);
  const read = await h.invoke('design_context_read', duplicate.issues[0].repairRead);
  assert.equal(read.workingContext.complete, true);
  assert.equal(read.workingContext.data.deliverables.length, 1);
  assert.equal(read.workingContext.data.deliverables[0].contributing_scopes[0].scope_id, 'poster-campaign');
  const omitted = await change(h, { deliverables: ids.map(id => ({ id, purpose: 'Revised poster' })) });
  assert.equal(omitted.issues.filter(issue => issue.code === 'duplicate_contributing_scope').length, 4);
  assert.equal((await commit(h)).committed, false);
  const repaired = await change(h, { deliverables: ids.map(id => ({ id, contributing_scopes: [] })) });
  assert.equal(repaired.readiness, 'ready'); assert.deepEqual(repaired.issues, []);
  assert.equal((await commit(h)).committed, true);
  const saved = JSON.parse(await readFile(join(runDir, CONTEXT_FILES.design), 'utf8'));
  assert.deepEqual(saved.system, system); assert.equal(saved.strategy.design_intent, strategy.design_intent);
  assert.deepEqual(saved.strategy.evidence, strategy.evidence);
  assert.equal(saved.strategy.skill_selection.length, 3);
  assert.deepEqual(saved.tasks.map(task => task.prompt_seed), tasks.map(task => task.prompt_seed));
  assert.ok(saved.tasks.every(task => task.scope_id === 'poster-campaign' && task.category === 'media_communication'));
  assert.ok(saved.deliverables.every(item => item.category === 'media_communication' && item.contributing_scopes.length === 0));
 } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('optional item fields can be retracted atomically without rebuilding or persisting operations', async () => {
 const { workspace, runDir } = await setup();
 try {
  const h = harness(workspace, 'designer');
  await h.invoke('use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary', rationale: 'Academic interface' });
  await change(h, { ...domainData(design), tasks: [{ ...design.tasks[0], creative_note: 'Obsolete choice' }, { id: 'other', method: 'manual', note: 'Keep' }] });
  const before = await draftSource(runDir);
  for (const changes of [
   { tasks: [{ id: 'page', unsetFields: ['method'] }] },
   { deliverables: [{ id: 'page', unsetFields: ['file'] }] },
   { tasks: [{ id: 'page', creative_note: 'New', unsetFields: ['creative_note'] }] },
   { tasks: [{ id: 'page', unsetFields: ['constructor'] }] },
   { tasks: [{ id: 'page', unsetFields: ['nested/value'] }] },
  ]) {
   await assert.rejects(change(h, changes));
   assert.equal(await draftSource(runDir), before);
  }
  await change(h, { tasks: [{ id: 'page', unsetFields: ['creative_note'] }], deliverables: [{ id: 'page', contributing_scopes: [] }] });
  const data = (await inspect(h)).data;
  assert.equal('creative_note' in data.tasks[0], false);
  assert.deepEqual(data.tasks[1], { id: 'other', method: 'manual', note: 'Keep' });
  assert.deepEqual(data.tasks[0].files, design.tasks[0].files);
  assert.equal((await commit(h)).ok, true);
  const canonical = await readFile(join(runDir, CONTEXT_FILES.design), 'utf8');
  assert.equal(canonical.includes('unsetFields'), false);
  assert.equal((await commit(h)).unchanged, true);
 } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('repair reads show full working objects independently of canonical content and overview budget', async () => {
 const { workspace, runDir } = await setup();
 try {
  const h = harness(workspace, 'designer');
  await h.invoke('use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary', rationale: 'Academic interface' });
  await change(h, domainData(design)); await commit(h);
  await change(h, { strategy: { exploration: Array.from({ length: 30 }, () => 'Design detail '.repeat(90)) }, deliverables: [{ id: 'page', purpose: 'Changed in draft', acceptance_test: 'Complete criterion '.repeat(100) }] });
  const before = await draftSource(runDir);
  const receipt = await readFile(join(runDir, '.performance/skills-designer.json'), 'utf8');
  const overview = await h.invoke('design_context_read', { runId: 'demo', audience: 'designer' });
  assert.ok(overview.workingContext.omittedPointers.includes('/deliverables'));
  const focused = await h.invoke('design_context_read', { runId: 'demo', audience: 'designer', section: 'deliverables', ids: ['page'] });
  assert.equal(focused.workingContext.source, 'working_draft');
  assert.equal(focused.workingContext.complete, true);
  assert.deepEqual(focused.workingContext.omittedPointers, []);
  assert.deepEqual(Object.keys(focused.workingContext.data), ['deliverables']);
  assert.equal(focused.workingContext.data.deliverables[0].purpose, 'Changed in draft');
  assert.equal(focused.workingContext.data.deliverables[0].acceptance_test, 'Complete criterion '.repeat(100));
  assert.equal(JSON.parse(await readFile(join(runDir, CONTEXT_FILES.design), 'utf8')).deliverables[0].purpose, design.deliverables[0].purpose);
  assert.equal(await draftSource(runDir), before);
  assert.equal(await readFile(join(runDir, '.performance/skills-designer.json'), 'utf8'), receipt);
  await assert.rejects(h.invoke('design_context_read', { runId: 'demo', audience: 'designer', section: 'deliverables', ids: ['missing'] }), /not found/);
  await assert.rejects(h.invoke('design_context_read', { runId: 'demo', audience: 'designer', ids: ['page'] }), /requires/);
  await assert.rejects(h.invoke('design_context_read', { runId: 'demo', audience: 'designer', section: 'assessment' }), /not available/);
  await assert.rejects(h.invoke('design_context_read', { runId: 'demo', audience: 'reviewer', section: 'deliverables' }), /own bound role/);
  assert.doesNotMatch(overview.outputContract.storage.rule, /write_json|patch_json/);
  assert.match(overview.outputContract.storage.rule, /update_design_context/);
  const second = harness(workspace, 'designer');
  await inspect(second);
  await change(second, { deliverables: [{ id: 'page', purpose: 'Concurrent draft update' }] });
  await assert.rejects(h.invoke('design_context_read', { runId: 'demo', audience: 'designer', section: 'deliverables', ids: ['missing'] }), /not found/);
  await assert.rejects(change(h, { strategy: { design_intent: 'Stale change' } }), /snapshot changed/);

 } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('draft and commit diagnostics honor verified Skill gaps and reject category conflicts', async () => {
 const { assembleContextDraft } = await import('../dist/context-draft.js');
 const data = { ...domainData(design), strategy: { design_intent: 'Product concept', skill_gaps: [{ scope_id: 'product', reason: 'No available professional' }] }, tasks: [{ id: 'concept', method: 'image_generate' }], deliverables: [{ ...design.deliverables[0], id: 'concept', scope_id: 'product', category: 'industrial', skill_refs: [] }] };
 const scopes = [{ id: 'product', category: 'industrial' }];
 const unverified = assembleContextDraft('designer', data, [], scopes);
 assert.ok(unverified.issues.some(issue => issue.code === 'missing_primary_skill'));
 const verified = assembleContextDraft('designer', data, [], scopes, [], { product: [] });
 assert.deepEqual(verified.issues, []);
 data.deliverables[0].category = 'ux';
 assert.ok(assembleContextDraft('designer', data, [], scopes, [], { product: [] }).issues.some(issue => issue.code === 'scope_category_mismatch'));
});


test('author Schema excludes runtime declarations while retaining open creative strategy fields', async () => {
 const { Check } = await import('typebox/value');
 const { roleContextChangesSchema, prepareContextChanges } = await import('../dist/context-tools.js');
 const schema = roleContextChangesSchema('designer');
 assert.equal(Check(schema, { strategy: { design_intent: 'Poetry', creative_decisions: [{ why: 'Tea culture' }] } }), true);
 for (const field of ['skill_selection', 'runId', 'schemaVersion', 'revision', 'execution_plan', 'image_generation_plan', 'deliverables', 'presentation']) {
  const changes = { strategy: { [field]: [] } };
  assert.equal(Check(schema, changes), false);
  assert.throws(() => prepareContextChanges({ changes }, 'designer'), error => JSON.parse(error.message).saved === false);
 }
});

test('final persona bodies use only their format-specific Context protocol',async()=>{
 const {unifiedContextPrompt,legacyContextPrompt}=await import('../dist/context-model.js');
 for(const role of ['researcher','designer','reviewer','builder','orchestrator']){
  const source=await readFile(join(cwd,'.pi/agents',`${role}.md`),'utf8');
  const body=source.split('---').slice(2).join('---');
  const unified=unifiedContextPrompt(body),legacy=legacyContextPrompt(body);
  assert.doesNotMatch(unified,/save that document as a whole|save_design_context|patch_design_context/);
  if(['researcher','designer','reviewer'].includes(role))assert.doesNotMatch(unified,/latest sha256/);
  if(!["designer", "reviewer"].includes(role)) assert.doesNotMatch(legacy,/update_design_context|commit_design_context|Runtime Context assembly/);
  else assert.doesNotMatch(body,/legacy|split-file|write_json|patch_json/iu);
  if(['researcher','designer','reviewer'].includes(role))assert.match(unified,/runtime-provided role-specific Context contract/);
 }
});

test('complete storage and tool structures agree for sources, identifiers and text',async()=>{
 const {Check}=await import('typebox/value');
 const {roleContextSchema}=await import('../dist/context-schema.js');
 const {validateContextDocument}=await import('../dist/context-model.js');
 for(const [role,doc] of [['researcher',research],['reviewer',review],['designer',design]]){
  const good=domainData(doc); if(role==='designer')good.strategy.skill_selection=design.strategy.skill_selection;
  const bad=structuredClone(good);
  if(role==='researcher')bad.evidence.official_sources=[17];
  if(role==='reviewer')bad.assessment.resolved_issue_ids=[17];
  if(role==='designer')bad.tasks[0].dependencies=[17];
  for(const data of [good,bad]){
   const accepted=Check(roleContextSchema(role),data);
   let storageAccepted=true;
   try{validateContextDocument(role==='researcher'?CONTEXT_FILES.research:role==='designer'?CONTEXT_FILES.design:CONTEXT_FILES.review,{...data,schemaVersion:1,runId:'demo',revision:1},'demo');}catch{storageAccepted=false;}
   assert.equal(accepted,storageAccepted,role);
   assert.equal(accepted,data===good);
  }
 }
 const whitespace={...domainData(research),findings:'   '};
 assert.equal(Check(roleContextSchema('researcher'),whitespace),false);
});

test('explicit object retraction removes historical invalid keys without resetting work',async()=>{
 const {workspace,runDir}=await setup();
 try{
  const h=harness(workspace,'designer');await h.invoke('use_skill',{name:'ui-web-design',scopeId:'ui',role:'primary',rationale:'Academic interface'});
  await change(h,{...domainData(design),acceptanceNotes:'Keep then deliberately remove',system:{...design.system,palette:{old_metric:'red',retained:'green'}}});
  const path=join(runDir,'.performance/context-draft-designer.json');
  const existing=JSON.parse(await readFile(path,'utf8'));existing.data.strategy.execution_plan=[];await writeFile(path,JSON.stringify(existing));
  await inspect(h);
  const unchanged=await draftSource(runDir);
  for(const changes of [
   {strategy:{unsetFields:['design_intent']}},
   {strategy:{unsetFields:['skill_selection']}},
   {system:{palette:{old_metric:'blue',unsetFields:['old_metric']}}},
   {unsetFields:['revision']},
  ])await assert.rejects(change(h,changes),/Cannot/);
  assert.equal(await draftSource(runDir),unchanged);
  await change(h,{strategy:{unsetFields:['execution_plan']},system:{palette:{unsetFields:['old_metric']}},unsetFields:['acceptanceNotes']});
  const data=(await inspect(h)).data;
  assert.equal(Object.hasOwn(data.strategy,'execution_plan'),false);
  assert.deepEqual(data.system.palette,{retained:'green'});
  assert.equal(Object.hasOwn(data,'acceptanceNotes'),false);
  assert.equal(data.strategy.design_intent,design.strategy.design_intent);
  assert.equal((await commit(h)).ok,true);
  const saved=await readFile(join(runDir,CONTEXT_FILES.design),'utf8');assert.doesNotMatch(saved,/unsetFields|execution_plan/);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('working Skill guidance follows uncommitted choices while Builder sees canonical choices',async()=>{
 const {workspace}=await setup();
 try{
  const h=harness(workspace,'designer');await h.invoke('use_skill',{name:'ui-web-design',scopeId:'ui',role:'primary',rationale:'Academic interface'});
  await change(h,domainData(design));await commit(h);
  await h.invoke('use_skill',{name:'image-prompting',scopeId:'ui',role:'supporting',rationale:'Supporting illustration'});
  await change(h,{strategy:{design_intent:'Updated illustration strategy'}});
  const read=await h.invoke('design_context_read',{runId:'demo',audience:'designer'});
  assert.equal(read.skillLoading.source,'working_draft');
  assert.ok(read.skillLoading.selectionChecklist.some(item=>item.name==='image-prompting'));
  assert.equal(read.draftReadiness.source,'canonical');
  assert.equal(read.files.some(file=>file.path===CONTEXT_FILES.design),false);
  const explicit=await h.invoke('design_context_read',{runId:'demo',audience:'designer',paths:[CONTEXT_FILES.design],full:true});
  assert.ok(explicit.files.some(file=>file.path===CONTEXT_FILES.design));
  const builder=await harness(workspace,'builder').invoke('design_context_read',{runId:'demo',audience:'builder',paths:[CONTEXT_FILES.design],full:true});
  assert.equal(builder.workingContext,undefined);
  assert.equal(JSON.parse(builder.files[0].content).strategy.skill_selection.some(item=>item.name==='image-prompting'),false);
 }finally{await rm(workspace,{recursive:true,force:true});}
});

test('repeated delivery of one failure event counts once while new calls still reach the guard',async()=>{
 const {workspace}=await setup();
 try{
  const feedback=harness(workspace,'reviewer').handlers.get('tool_result');
  const event={toolName:'update_design_context',input:{changes:{assessment:{verdict:'invalid'}}},isError:true,content:[{type:'text',text:'update_design_context#/changes/assessment/verdict: invalid_named_fields: must be pass or fail'}]};
  assert.equal((await feedback({...event,toolCallId:'one'})).details.attempts,1);
  assert.equal((await feedback({...event,toolCallId:'one'})).details.attempts,1);
  assert.equal((await feedback({...event,toolCallId:'two'})).details.attempts,2);
  assert.equal((await feedback({...event,toolCallId:'three'})).details.blocked,true);
 }finally{await rm(workspace,{recursive:true,force:true});}
});


test('empty id-keyed collections clear work while omission retains it and commit stays incomplete', async () => {
 const {workspace}=await setup();
 try {
  const h=harness(workspace,'designer');
  await change(h,{tasks:[{id:'old',method:'manual'}],deliverables:[{id:'old',kind:'image',purpose:'Original',acceptance_test:'Original',required:true,file:'artifacts/old.png'}]});
  await change(h,{system:{palette:{accent:'#fff'}}});
  assert.equal((await inspect(h)).data.tasks.length,1);
  const cleared=await change(h,{tasks:[],deliverables:[]});
  assert.equal(cleared.saved,true);assert.notEqual(cleared.readiness,'ready');
  const data=(await inspect(h)).data;assert.deepEqual(data.tasks,[]);assert.deepEqual(data.deliverables,[]);
  assert.equal((await commit(h)).committed,false);
 } finally {await rm(workspace,{recursive:true,force:true});}
});

test('review semantic blockers agree across update, read and commit', async () => {
 const {workspace}=await setup();
 try {
  const h=harness(workspace,'reviewer');
  for (const assessment of [{...review.assessment,verdict:'fail',issues:[]},{...review.assessment,verdict:'pass',issues:[{id:'major',severity:'major',status:'open'}]}]) {
   const updated=await change(h,{assessment});
   assert.equal(updated.readiness,'blocked');
   const read=await inspect(h);const committed=await commit(h);
   assert.deepEqual(updated.issues,read.issues);assert.deepEqual(updated.issues,committed.issues);
   assert.equal(committed.saved,false);
  }
 } finally {await rm(workspace,{recursive:true,force:true});}
});

test('reset checks canonical independently from an unchanged retained draft', async () => {
 const {workspace,runDir}=await setup();
 try {
  const h=harness(workspace,'reviewer');await save(h,runDir,review);await inspect(h);
  await change(h,{assessment:{summary:'Local work'}});
  await h.invoke('design_context_read',{runId:'demo',audience:'reviewer',canonical:true});
  const before=await readFile(join(runDir,'.performance/context-draft-reviewer.json'),'utf8');
  const writer=harness(workspace,'reviewer');
  await save(writer,runDir,{...review,assessment:{...review.assessment,summary:'Unseen external work'}});
  await assert.rejects(h.invoke('update_design_context',{changes:{},reset:true}),/Canonical Context.*changed/);
  assert.equal(await readFile(join(runDir,'.performance/context-draft-reviewer.json'),'utf8'),before);
  const read=await h.invoke('design_context_read',{runId:'demo',audience:'reviewer',canonical:true});
  assert.equal(read.workingContext.data.assessment.summary,'Unseen external work');
  await h.invoke('update_design_context',{changes:{},reset:true});
  assert.equal((await inspect(h)).data.assessment.summary,'Unseen external work');
 } finally {await rm(workspace,{recursive:true,force:true});}
});


test('canonical reset observation returns complete canonical and retained working content',async()=>{
 const {workspace,runDir}=await setup();
 try {
  const summary='Complete canonical evidence '.repeat(800);
  const h=harness(workspace,'reviewer');await save(h,runDir,{...review,assessment:{...review.assessment,summary}});await inspect(h);
  await change(h,{assessment:{summary:'Local work to discard'}});
  const read=await h.invoke('design_context_read',{runId:'demo',audience:'reviewer',canonical:true});
  assert.equal(read.workingContext.data.assessment.summary,summary);
  assert.equal(read.workingContext.retainedWorkingData.assessment.summary,'Local work to discard');
  assert.equal(read.workingContext.omittedPointers,undefined);
  await assert.rejects(h.invoke('design_context_read',{runId:'demo',audience:'reviewer',canonical:true,section:'assessment'}),/complete role Context/);
  await h.invoke('update_design_context',{changes:{},reset:true});
  const selected=await h.invoke('design_context_read',{runId:'demo',audience:'reviewer',section:'assessment'});
  assert.equal(selected.workingContext.data.assessment.summary,summary);
 }finally{await rm(workspace,{recursive:true,force:true});}
});


test('research-only correction can be reviewed without republishing unchanged design; approval seals current evidence', async () => {
  const { workspace, runDir } = await setup();
  const oldBrowser = process.env.DREAMATIC_HTML_BROWSER;
  process.env.DREAMATIC_HTML_BROWSER = 'off';
  try {
    const researcher = harness(workspace, 'researcher');
    await save(researcher, runDir, research);
    await researcher.invoke('design_bus_post', completion('research_done', 'Initial evidence'));
    const designer = harness(workspace, 'designer');
    await designer.invoke('use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary' });
    await mkdir(join(runDir, 'plan/html/ui'), { recursive: true });
    await writeFile(join(runDir, 'plan/html/ui/index.html'), '<!doctype html><html><head><title>Research</title></head><body><h1>Research</h1></body></html>');
    await save(designer, runDir, design);
    await designer.invoke('design_bus_post', completion('design_spec_ready', 'Designed'));
    const spec = await readFile(join(runDir, CONTEXT_FILES.design), 'utf8');
    const failed = harness(workspace, 'reviewer');
    await save(failed, runDir, { ...review, assessment: { ...review.assessment, verdict: 'fail', issues: [{ id: 'citation', owner: 'researcher', severity: 'major', status: 'open', diagnosis: 'Missing supporting citation' }] } });
    await failed.invoke('design_bus_post', completion('design_review_fail', 'Evidence needs correction'));
    const correction = harness(workspace, 'researcher');
    await save(correction, runDir, { ...research, findings: 'Corrected supporting evidence; the specification is unchanged.' });
    await correction.invoke('design_bus_post', completion('research_done', 'Evidence corrected'));
    const reviewer = harness(workspace, 'reviewer');
    await save(reviewer, runDir, { ...review, assessment: { ...review.assessment, round: 2, resolved_issue_ids: ['citation'], issues: [{ id: 'citation', owner: 'researcher', severity: 'major', status: 'resolved' }] } });
    const pass = await reviewer.invoke('design_bus_post', completion('design_review_pass', 'Correction accepted'));
    assert.ok(pass.event.commitReceipt.files[CONTEXT_FILES.research]);
    assert.equal(await readFile(join(runDir, CONTEXT_FILES.design), 'utf8'), spec);
    const events = (await readFile(join(runDir, 'bus.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(event => event.type === 'design_spec_ready').length, 1);
    const builder = harness(workspace, 'builder');
    await builder.invoke('execute_design_plan', { runId: 'demo' });
    await writeFile(join(runDir, CONTEXT_FILES.research), (await readFile(join(runDir, CONTEXT_FILES.research), 'utf8')) + '\n');
    await assert.rejects(builder.invoke('execute_design_plan', { runId: 'demo' }), /changed after/);
  } finally {
    if (oldBrowser === undefined) delete process.env.DREAMATIC_HTML_BROWSER; else process.env.DREAMATIC_HTML_BROWSER = oldBrowser;
    await rm(workspace, { recursive: true, force: true });
  }
});

test('confirmed active-run updates persist scope and invalidate approvals until new design and review', async () => {
  const { workspace, runDir, root } = await setup();
  const oldBrowser = process.env.DREAMATIC_HTML_BROWSER;
  process.env.DREAMATIC_HTML_BROWSER = 'off';
  try {
    await save(harness(workspace, 'researcher'), runDir, research);
    const designer = harness(workspace, 'designer');
    await designer.invoke('use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary' });
    await mkdir(join(runDir, 'plan/html/ui'), { recursive: true });
    await writeFile(join(runDir, 'plan/html/ui/index.html'), '<!doctype html><html><head><title>Research</title></head><body><h1>Research</h1></body></html>');
    await save(designer, runDir, design);
    await designer.invoke('design_bus_post', completion('design_spec_ready', 'Designed'));
    const reviewer = harness(workspace, 'reviewer');
    await save(reviewer, runDir, review);
    await reviewer.invoke('design_bus_post', completion('design_review_pass', 'Reviewed'));
    const initial = JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8'));
    const snapshot = await readFile(join(runDir, CONTEXT_FILES.design), 'utf8');
    const result = await root.invoke('run_brief_update', { runId: 'demo', feedback: 'The user confirms the page is for students.', brief: 'Build an academic page for students', designScopes: [{ id: 'ui', category: 'ux', task: 'Student academic page' }] });
    assert.equal(result.ok, true);
    const context = await root.invoke('design_context_read', { runId: 'demo', audience: 'orchestrator', paths: [CONTEXT_FILES.project], full: true });
    const brief = JSON.parse(context.files[0].content).brief;
    assert.equal(brief.originalRequest, initial.originalRequest);
    assert.equal(brief.resolvedScope.designScopes[0].task, 'Student academic page');
    assert.equal(brief.confirmedUpdates[0].feedback, 'The user confirms the page is for students.');
    assert.equal(await readFile(join(runDir, CONTEXT_FILES.design), 'utf8'), snapshot);
    const state = JSON.parse(await readFile(join(runDir, 'run-state.json'), 'utf8'));
    assert.equal(state.stages.design, 'pending');
    assert.equal(state.stages.review, 'pending');
    const spawn = args => root.tools.get('spawn_agent').execute('gate', args, undefined, undefined, { cwd, model: { id: 'mock', provider: 'mock' } });
    await assert.rejects(spawn({ runId: 'demo', agent: 'reviewer', task: 'Review the existing design.' }), /until Designer/);
    await assert.rejects(spawn({ runId: 'demo', agent: 'builder', task: 'Build the existing design.' }), /until the latest/);
    await assert.rejects(harness(workspace, 'builder').invoke('execute_design_plan', { runId: 'demo' }), /current approved/);
    await assert.rejects(harness(workspace, 'researcher').invoke('run_brief_update', { runId: 'demo', feedback: 'Change the brief' }), /Only Orchestrator/);
    const revised = harness(workspace, 'designer');
    await revised.invoke('use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary' });
    await save(revised, runDir, { ...design, strategy: { ...design.strategy, design_intent: 'Present research clearly for students' } });
    await revised.invoke('design_bus_post', completion('design_revision_ready', 'Confirmed audience incorporated'));
    const newReview = harness(workspace, 'reviewer');
    await save(newReview, runDir, review);
    await newReview.invoke('design_bus_post', completion('design_review_pass', 'Audience correction reviewed'));
    const builder = harness(workspace, 'builder');
    await builder.invoke('execute_design_plan', { runId: 'demo' });
    await builder.invoke('build_finalize', { runId: 'demo' });
    await assert.rejects(root.invoke('run_brief_update', { runId: 'demo', feedback: 'Another change' }), /before build_done/);
    await root.invoke('export_package', { runId: 'demo', runDir });
    await assert.rejects(root.invoke('run_brief_update', { runId: 'demo', feedback: 'Another change' }), /run_revision/);
  } finally {
    if (oldBrowser === undefined) delete process.env.DREAMATIC_HTML_BROWSER; else process.env.DREAMATIC_HTML_BROWSER = oldBrowser;
    await rm(workspace, { recursive: true, force: true });
  }
});

test('runtime Context contracts are scoped to actual role capabilities and read-only roles receive no authoring example', async () => {
  const { unifiedContextInstruction } = await import('../dist/context-model.js');
  for (const role of ['researcher', 'reviewer']) {
    assert.doesNotMatch(unifiedContextInstruction(role), /use_skill|removeTasks|removeDeliverables/);
    const source = await readFile(join(cwd, '.pi/agents', `${role}.md`), 'utf8');
    assert.doesNotMatch(source, /fresh Designer invocation|Runtime Context assembly|Tasks\/deliverables upsert/);
  }
  assert.doesNotMatch(unifiedContextInstruction('builder'), /update_design_context|commit_design_context/);
  assert.match(unifiedContextInstruction('designer'), /Reload all retained primary\/supporting Skills/);
  const { workspace, root } = await setup();
  try {
    const result = await root.invoke('design_context_read', { runId: 'demo', audience: 'orchestrator' });
    assert.equal(result.authoringExample, undefined);
    assert.match(result.authoringContract, /run_brief_update/);
    const reviewer = await harness(workspace, 'reviewer').invoke('design_context_read', { runId: 'demo', audience: 'reviewer' });
    assert.match(reviewer.referenceReview.coverageRequirement, /not mandatory corrections/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('observed Orchestrator stage-section misuse is excluded from schema and offers a canonical recovery call', async () => {
  const { Check } = await import('typebox/value');
  const { workspace, runDir, root } = await setup();
  try {
    await save(harness(workspace, 'researcher'), runDir, research);
    const reader = root.tools.get('design_context_read');
    const observed = { runId: 'demo', audience: 'orchestrator', section: 'research' };
    assert.equal(Check(reader.parameters, observed), false);
    await assert.rejects(root.invoke('design_context_read', observed), /paths.*context\/research.json.*full.*true/);
    const good = { runId: 'demo', audience: 'orchestrator', paths: [CONTEXT_FILES.research], full: true };
    assert.equal(Check(reader.parameters, good), true);
    const before = await readFile(join(runDir, CONTEXT_FILES.research), 'utf8');
    assert.equal((await root.invoke('design_context_read', good)).files[0].content, JSON.stringify(JSON.parse(before)));
    assert.equal(await readFile(join(runDir, CONTEXT_FILES.research), 'utf8'), before);
    const blocked = await root.handlers.get('tool_call')({ toolName: 'read', input: { path: join(runDir, 'research/research-findings.md') } }, { cwd });
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /Retired Context path.*paths.*context\/research.json.*full.*true/);
    const builder = harness(workspace, 'builder').tools.get('design_context_read');
    assert.equal(Check(builder.parameters, { runId: 'demo', audience: 'builder', section: 'research' }), false);
    const author = harness(workspace, 'researcher').tools.get('design_context_read');
    assert.equal(Check(author.parameters, { runId: 'demo', audience: 'researcher', section: 'findings' }), true);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('canonical writing and specialist recipient schemas reject the observed invalid calls before execution', async () => {
  const { Check } = await import('typebox/value');
  const { workspace, runDir } = await setup();
  try {
    const researcher = harness(workspace, 'researcher');
    const writer = researcher.tools.get('write_json');
    assert.equal(Check(writer.parameters, { runId: 'demo', path: CONTEXT_FILES.research, data: research }), false);
    assert.match(writer.description, /Never use this tool for canonical Context/);
    assert.equal(Check(writer.parameters, { runId: 'demo', path: 'research/notes.json', data: { note: 'Acquisition note' } }), true);
    await assert.rejects(researcher.invoke('write_json', { runId: 'demo', path: CONTEXT_FILES.research, data: research }), /update_design_context/);
    await researcher.invoke('design_context_read', { runId: 'demo', audience: 'researcher' });
    const { schemaVersion, runId: _run, revision, ...changes } = research;
    await researcher.invoke('update_design_context', { changes });
    assert.equal((await researcher.invoke('commit_design_context', {})).committed, true);
    const post = harness(workspace, 'designer').tools.get('design_bus_post');
    assert.equal(Check(post.parameters, { ...completion('design_spec_ready', 'Ready'), to: 'reviewer' }), false);
    const valid = post.prepareArguments(completion('design_spec_ready', 'Ready'));
    assert.equal(valid.to, 'orchestrator');
    assert.equal(Check(post.parameters, valid), true);
    assert.match(post.description, /nextAgent, never by to=reviewer/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('Reviewer expands compact design tasks through canonical select without observing or changing its draft', async () => {
  const { Check } = await import('typebox/value');
  const { workspace, runDir } = await setup();
  try {
    const stored = structuredClone(design);
    stored.tasks.push({ ...stored.tasks[0], id: 'transition-scene', prompt_seed: 'Full detail '.repeat(1000) });
    stored.strategy.reference_use_decisions = [{ asset_id: 'reference-1', review_status: 'viewed', decision: 'adopt' }];
    await writeFile(join(runDir, CONTEXT_FILES.design), JSON.stringify(stored));
    await mkdir(join(runDir, 'research/assets'), { recursive: true });
    await writeFile(join(runDir, 'research/assets/manifest.json'), JSON.stringify({ assets: [{ id: 'reference-1', file: 'reference.png' }] }));
    const reviewer = harness(workspace, 'reviewer');
    const overview = await reviewer.invoke('design_context_read', { runId: 'demo', audience: 'reviewer' });
    const input = overview.files.find(file => file.path === CONTEXT_FILES.design);
    assert.equal(input.truncated, true);
    const expansion = input.expansionReads.find(args => args.select.section === 'tasks');
    assert.ok(expansion);
    assert.deepEqual(overview.referenceReview.missingAssetIds, []);
    assert.equal(overview.referenceReview.source, 'canonical');
    const reader = reviewer.tools.get('design_context_read');
    assert.equal(Check(reader.parameters, { runId: 'demo', audience: 'reviewer', section: 'tasks', ids: ['transition-scene'] }), false);
    await assert.rejects(reviewer.invoke('design_context_read', { runId: 'demo', audience: 'reviewer', section: 'tasks' }), /paths.*context\/design.json.*select.*tasks/);
    assert.equal(Check(reader.parameters, { runId: 'demo', audience: 'reviewer', section: 'assessment' }), true);
    const before = await readFile(join(runDir, CONTEXT_FILES.design), 'utf8');
    const selected = await reviewer.invoke('design_context_read', { ...expansion, select: { section: 'tasks', ids: ['transition-scene'] } });
    assert.equal(Check(reader.parameters, { ...expansion, select: { section: 'tasks', ids: ['transition-scene'] } }), true);
    assert.equal(selected.workingContext, undefined);
    assert.equal(selected.files[0].truncated, false);
    assert.deepEqual(JSON.parse(selected.files[0].content), { tasks: [stored.tasks[1]] });
    assert.equal(await readFile(join(runDir, CONTEXT_FILES.design), 'utf8'), before);
    await assert.rejects(readFile(join(runDir, '.performance/context-draft-reviewer.json')), /ENOENT/);
    const all = await reviewer.invoke('design_context_read', expansion);
    assert.deepEqual(JSON.parse(all.files[0].content).tasks, stored.tasks);
    const full = await reviewer.invoke('design_context_read', input.readArguments);
    assert.deepEqual(JSON.parse(full.files[0].content), stored);
    await assert.rejects(reviewer.invoke('design_context_read', { ...expansion, select: { section: 'tasks', ids: ['missing'] } }), /ids not found/);
    await assert.rejects(reviewer.invoke('design_context_read', { ...expansion, select: { section: 'assessment' } }), /not available in context\/design.json/);
    await assert.rejects(reviewer.invoke('design_context_read', { ...expansion, select: { section: 'strategy', ids: ['x'] } }), /only tasks or deliverables/);
    await assert.rejects(reviewer.invoke('design_context_read', { ...expansion, section: 'assessment' }), /not both/);
    await assert.rejects(reviewer.invoke('design_context_read', { ...expansion, paths: [CONTEXT_FILES.design, CONTEXT_FILES.research] }), /exactly one/);
    await assert.rejects(reviewer.invoke('design_context_read', { ...expansion, runId: 'another' }), /assigned Run/);
    await assert.rejects(harness(workspace, 'researcher').invoke('design_context_read', { ...expansion, audience: 'researcher' }), /not available to researcher/);
    for (const role of ['orchestrator', 'builder']) {
      const selected = await harness(workspace, role === 'orchestrator' ? undefined : role).invoke('design_context_read', { ...expansion, audience: role });
      assert.deepEqual(JSON.parse(selected.files[0].content).tasks, stored.tasks);
    }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('bound Context reads inject identity before validation without weakening foreign-run rejection', async () => {
  const { workspace, runDir, root } = await setup();
  try {
    const h = harness(workspace, 'designer'), read = h.tools.get('design_context_read');
    const args = read.prepareArguments({audience:'designer',section:'deliverables'});
    assert.equal(args.runId,'demo');
    const {Check} = await import('typebox/value');
    assert.equal(Check(read.parameters,args),true);
    const result = await h.invoke('design_context_read',{audience:'designer',section:'deliverables'});
    assert.equal(result.runId,'demo');
    assert.equal(result.researchAcquisition.fetchedSourceCount,0);
    await assert.rejects(h.invoke('design_context_read',{runId:'other',audience:'designer'}),/Assigned runId/);
    const unbound = root.tools.get('design_context_read');
    assert.equal(Check(unbound.parameters,unbound.prepareArguments({audience:'orchestrator'})),false);
    await writeFile(join(runDir,CONTEXT_FILES.research),JSON.stringify(research));
    const selected = await h.invoke('design_context_read',{audience:'designer',paths:[CONTEXT_FILES.research],select:{section:'findings'}});
    assert.ok(selected.researchAcquisition);
  } finally { await rm(workspace,{recursive:true,force:true}); }
});

test('Designer can replace mismatched ids atomically without retaining obsolete upsert rows', async () => {
  const {workspace} = await setup();
  try {
    const h = harness(workspace,'designer');
    await h.invoke('design_context_read',{audience:'designer'});
    const deliverable = {...design.deliverables[0],id:'del-old'};
    await h.invoke('update_design_context',{changes:{tasks:[{id:'task-old',method:'manual'}],deliverables:[deliverable]}});
    await h.invoke('update_design_context',{changes:{tasks:[{id:'hero',method:'manual'}],deliverables:[{...deliverable,id:'hero'}]}});
    assert.equal((await h.invoke('design_context_read',{audience:'designer',section:'tasks'})).workingContext.data.tasks.length,2);
    const replacement = {changes:{replaceTasks:[{id:'hero',method:'manual'}],replaceDeliverables:[{...deliverable,id:'hero'}]}};
    const saved = await h.invoke('update_design_context',replacement);
    assert.equal(saved.saved,true);
    assert.equal(saved.issues.some(issue=>issue.code==='missing_task'),false);
    const snapshot = (await h.invoke('design_context_read',{audience:'designer'})).workingContext.data;
    assert.deepEqual(snapshot.tasks.map(x=>x.id),['hero']);
    assert.deepEqual(snapshot.deliverables.map(x=>x.id),['hero']);
    for (const invalid of [
      {replaceDeliverables:[{id:'incomplete'}]},
      {replaceTasks:[{id:'new',method:'manual'}],tasks:[{id:'other'}]},
      {replaceTasks:[{id:'new',method:'manual'}],removeTasks:['hero']},
      {replaceTasks:[{id:'new',method:'manual'},{id:'new',method:'manual'}]},
    ]) await assert.rejects(h.invoke('update_design_context',{changes:invalid}));
    assert.deepEqual((await h.invoke('design_context_read',{audience:'designer'})).workingContext.data,snapshot);
    const reviewer = harness(workspace,'reviewer');
    assert.throws(()=>reviewer.tools.get('update_design_context').prepareArguments(replacement),/invalid_named_fields/);
  } finally { await rm(workspace,{recursive:true,force:true}); }
});
