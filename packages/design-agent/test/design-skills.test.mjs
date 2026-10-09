import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createDreamaticExtension, specialistCompletionEvent } from '../dist/extension.js';
import { createReadTool, createWriteTool, createGrepTool } from '@earendil-works/pi-coding-agent';
import { designerDraftReadiness, designerHandoffError } from '../dist/designer-recovery.js';
import { configureToolSearchPath } from '../dist/runtime.js';
import { RUN_CONTEXT_SECTIONS } from '../dist/run-files.js';
import { designScopes } from '../dist/design-categories.js';
import { encodeImageOutput, imageEncoding } from "../dist/image-output.js";
import { finalizeDelivery } from "../dist/finalize-delivery.js";
import { approvedImageEdit, approvedImageAcceptance, deliveryContract, htmlTask, normalizeDraftPresentation, validateDeliveryContract } from '../dist/design-contract.js';
import { browserExecutable, checkHtmlBrowser, lintHtmlDelivery, lintHtmlSourceDependencies, materializeHtml } from '../dist/html-delivery.js';
import { assertHtmlSourcePreflight } from '../dist/html-preflight.js';
import { validateDesignScopes } from '../dist/design-scope-validation.js';

const cwd = fileURLToPath(new URL('../../..', import.meta.url));
const context = { cwd };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function harness(workspaceDir, agent, runId = 'demo') {
  const tools = new Map(), handlers = new Map();
  createDreamaticExtension({ workspaceDir, ...(agent ? { parentInvocation: { id: `${agent}-1`, agent, runId } } : {}) })({ on(name, handler) { handlers.set(name, handler); }, registerTool(tool) { tools.set(tool.name, tool); } });
  return { tools, handlers };
}
async function invoke(tools, name, args, ctx = context) {
  const result = await tools.get(name).execute(name, args, undefined, undefined, ctx);
  if (name === 'run_init') {
    // These tests intentionally exercise the historical split-file contract.
    // The unified authoring/approval path has its own end-to-end suite.
    const runDir = JSON.parse(result.content[0].text).runDir;
    await rm(join(runDir, 'context'), { recursive: true, force: true });
    const brief = JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8'));
    delete brief.contextFormat;
    await writeFile(join(runDir, 'brief.json'), JSON.stringify(brief));
    const index = JSON.parse(await readFile(join(runDir, 'design-context.json'), 'utf8'));
    await writeFile(join(runDir, 'design-context.json'), JSON.stringify({ ...index, sections: RUN_CONTEXT_SECTIONS }));
  }
  return result;
}
const value = (result) => JSON.parse(result.content[0].text);
const scopes = [{ id: 'product', category: 'industrial', task: 'Design the hardware' }, { id: 'ui', category: 'ux', task: 'Design control pages' }, { id: 'campaign', category: 'media_communication', task: 'Design the campaign poster' }];
async function init(workspaceDir, selected = scopes) {
  const { tools } = harness(workspaceDir);
  await invoke(tools, 'run_init', { runIdOverride: 'demo', projectTitle: 'Connected Light', brief: 'Hardware, control interface and campaign', designScopes: selected });
  return tools;
}
async function jsonFile(runDir, path, data) { await mkdir(join(runDir, path, '..'), { recursive: true }); await writeFile(join(runDir, path), JSON.stringify(data)); }
async function fixture(workspaceDir, mixed = false, options = {}) {
  const assigned = options.contribution ? [scopes[1], scopes[2]] : mixed ? scopes : [scopes[1]];
  const orchestrator = await init(workspaceDir, assigned);
  const runDir = join(workspaceDir, 'runs/demo');
  const { tools: designer } = harness(workspaceDir, 'designer');
  const primary = { product: 'industrial-design', ui: 'ui-web-design', campaign: 'poster-advertising' };
  for (const scope of assigned) {
    if (options.discoveryHint) {
      const catalog = value(await invoke(designer, 'list_skills', { scopeId: primary[scope.id], refresh: true }));
      assert.equal(catalog.scopeId, scope.id);
      const call = catalog.skills.find((skill) => skill.name === primary[scope.id]).applicableScopes.find((item) => item.scopeId === scope.id).load;
      await invoke(designer, call.tool, call.arguments);
    } else await invoke(designer, 'use_skill', { name: primary[scope.id], scopeId: scope.id, role: 'primary' });
  }
  await invoke(designer, 'use_skill', { name: 'html-interface', scopeId: 'ui', role: 'supporting' });
  await mkdir(join(runDir, 'plan/html/ui'), { recursive: true });
  await writeFile(join(runDir, 'plan/html/ui/index.html'), '<!doctype html><html><head><title>Light control</title><link rel="stylesheet" href="../shared/style.css"></head><body><h1>Light control</h1><button id="toggle">Turn on</button><p id="status">Off</p><a href="details.html">Details</a><script src="app.js"></script></body></html>');
  await writeFile(join(runDir, 'plan/html/ui/details.html'), '<!doctype html><html><head><title>Details</title><link rel="stylesheet" href="../shared/style.css"></head><body><h1>Details</h1><a href="index.html">Controls</a></body></html>');
  await writeFile(join(runDir, 'plan/html/ui/style.css'), 'body{margin:0;padding:24px;font:16px system-ui}button{padding:12px}');
  await writeFile(join(runDir, 'plan/html/ui/app.js'), 'document.querySelector("#toggle").addEventListener("click",()=>{document.querySelector("#status").textContent="On";});');
  if (options.missingResource) {
    const path = join(runDir, 'plan/html/ui/index.html');
    await writeFile(path, (await readFile(path, 'utf8')).replace('</body>', '<img src="missing.png"></body>'));
  }
  const page = { id: 'page', scope_id: 'ui', category: 'ux', method: 'html_generate', files: ['index.html','details.html','style.css','app.js'].map((file) => ({ source: `plan/html/ui/${file}`, output: file === 'style.css' ? 'artifacts/shared/style.css' : `artifacts/ui/${file}` })), resources: [], dependencies: [], interaction_checks: [{ name: 'Power on', steps: [{ action: 'click', selector: '#toggle' }, { action: 'expect_text', selector: '#status', value: 'On' }] }, { name: 'Details navigation', steps: [{ action: 'click', selector: 'a[href="details.html"]' }, { action: 'expect_text', selector: 'h1', value: 'Details' }] }], viewports: [{ width: 390, height: 844 }, { width: 1440, height: 900 }] };
  if (options.navigationFailure) {
    await writeFile(join(runDir, 'plan/html/ui/index.html'), '<!doctype html><html><head><title>Navigation</title><link rel="stylesheet" href="../shared/style.css"></head><body><header><nav><a href="#research">Research</a><a href="#contact">Contact</a></nav></header><div class="hero-actions"><a href="#research">Research CTA</a><a href="#contact">Contact CTA</a></div><section id="research">Research</section><section id="contact">Contact</section><script src="app.js"></script></body></html>');
    await writeFile(join(runDir, 'plan/html/ui/style.css'), 'header{position:fixed;top:0;height:40px;width:100%}.hero-actions{padding-top:60px}section{height:1000px}@media(max-width:767px){nav{display:none}}');
    await writeFile(join(runDir, 'plan/html/ui/app.js'), 'document.addEventListener("click",()=>document.querySelector("header").classList.add("scrolled"));');
    page.viewports = [{width:1440,height:900},{width:768,height:1024},{width:390,height:844}];
    page.interaction_checks = [
      {name:'Smooth scroll',steps:[{action:'click',selector:'a[href="#research"]'},{action:'expect_visible',selector:'#research'}]},
      {name:'Header shadow',steps:[{action:'click',selector:'nav a[href="#contact"]'},{action:'expect_visible',selector:'header.scrolled'}]},
    ];
  }
  const image = (scope) => ({ id: scope.id, scope_id: scope.id, category: scope.category, method: 'image_generate', prompt_seed: `Approved ${scope.id}`, negative_prompt_seed: 'Watermark', size: '512x512', size_rationale: 'Concept view', acceptance_test: 'Approved concept is communicated', dependencies: [] });
  const tasks = mixed ? [page, image(scopes[0]), image(scopes[2])] : [page];
  if (mixed) { page.resources = [{ source: 'artifacts/product.png', output: 'artifacts/ui/product.png' }]; page.dependencies = ['product']; }
  if (options.optional) tasks.push({ ...page, id: 'optional', files: page.files.filter(file=>!file.source.endsWith('style.css')).map(file=>({...file,output:file.output.replace('artifacts/ui/','artifacts/optional/')})), dependencies: [], resources: [] });
  if (options.imageAcceptance) for (const task of tasks.filter((item) => item.method !== 'html_generate')) {
    const declared = task.acceptance_test; delete task.acceptance_test;
    if (options.imageAcceptance !== 'manifest') task[options.imageAcceptance] = declared;
  }
  const plan = { schemaVersion: 2, runId: 'demo', design_system_ref: 'plan/design_system.json', design_intent: 'Approved design', skill_selection: assigned.map((scope) => ({ scope_id: scope.id, name: primary[scope.id], role: 'primary', rationale: scope.task })).concat([{ scope_id: 'ui', name: 'html-interface', role: 'supporting', rationale: 'Executable page expression' }]), execution_plan: tasks };
  const manifest = { schemaVersion: 2, runId: 'demo', design_system_ref: 'plan/design_system.json', presentation: options.gallery ? { mode: 'gallery', entry: 'artifacts/00-gallery.html' } : { mode: 'html', entry: 'artifacts/ui/index.html' }, deliverables: tasks.map((task) => ({ id: task.id, scope_id: task.scope_id, category: task.category, skill_refs: [primary[task.scope_id]], kind: task.method === 'html_generate' ? 'html_page' : 'image', purpose: task.id, acceptance_test: 'Declared task works', required: task.id !== 'optional', method: task.method, file: task.method === 'html_generate' ? task.files[0].output : `artifacts/${task.id}.png`, ...(task.size ? { size: task.size } : {}) })) };
  if (options.imageExtension) {
    for (const item of manifest.deliverables.filter(item=>item.method!=="html_generate")) item.file=item.file.replace(/\.png$/,options.imageExtension);
    for (const task of tasks.filter(item=>item.method==="html_generate")) for (const resource of task.resources) {
      resource.source=resource.source.replace(/\.png$/,options.imageExtension);resource.output=resource.output.replace(/\.png$/,options.imageExtension);
    }
  }
  if (options.omitPresentation) delete manifest.presentation;
  else if (options.omitPresentationEntry) delete manifest.presentation.entry;
  if (options.contribution) manifest.deliverables[0].contributing_scopes = [{ scope_id: 'campaign', category: 'media_communication', skill_refs: ['poster-advertising'], purpose: 'Visual identity applied in this page' }];
  for (const [path, data] of [['plan/design_system.json', { runId: 'demo', system_thesis: 'One coherent design', palette: {}, typography: {} }], ['plan/design_plan.json', plan], ['plan/deliverable_manifest.json', manifest]]) await invoke(designer, 'write_json', { runId: 'demo', path, data });
  const originalBrowser = process.env.DREAMATIC_HTML_BROWSER;
  if (options.legacyApproval) process.env.DREAMATIC_HTML_BROWSER = 'off';
  try {
  const publication = await invoke(designer, 'design_bus_post', { runId: 'demo', type: 'design_spec_ready', from_agent: 'designer', to: 'orchestrator', summary: 'Designed', ...(options.omitArtifactRefs ? {} : { artifactRefs: ['plan/design_plan.json'] }), requestedAction: options.requestedAction ?? 'Review' });
  assert.equal(value(publication).ok, true, JSON.stringify(value(publication)));
  const { tools: reviewer } = harness(workspaceDir, 'reviewer');
  await jsonFile(runDir, 'review/design-review.json', { runId: 'demo', review_stage: 'design_context', verdict: 'pass', round: 1, summary: 'Ready', scores: {}, issues: [] });
  await writeFile(join(runDir, 'review/design-review.md'), 'Approved design');
  await invoke(reviewer, 'design_bus_post', { runId: 'demo', type: 'design_review_pass', from_agent: 'reviewer', to: 'orchestrator', summary: 'Reviewed', artifactRefs: ['review/design-review.json'], requestedAction: 'Build' });
  } finally { if (originalBrowser === undefined) delete process.env.DREAMATIC_HTML_BROWSER; else process.env.DREAMATIC_HTML_BROWSER = originalBrowser; }
  return { runDir, plan, manifest, page, orchestrator, designer, builder: harness(workspaceDir, 'builder').tools };
}

test('category assignments and per-scope professional Skills preserve independent primary selections', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-skills-'));
  try {
    await init(workspace);
    const { tools } = harness(workspace, 'designer');
    const industrial = value(await invoke(tools, 'list_skills', { scopeId: 'product' }));
    assert.ok(industrial.skills.some((skill) => skill.name === 'industrial-design'));
    assert.ok(industrial.skills.some((skill) => skill.name === 'image-prompting'));
    assert.equal(industrial.skills.some((skill) => skill.name === 'html-interface'), false);
    assert.equal(industrial.skills.some((skill) => skill.name === 'brand-identity'), false);
    assert.deepEqual(industrial.activeSkills, []);
    await assert.rejects(invoke(tools, 'use_skill', { name: 'design-system', scopeId: 'product', role: 'primary' }), /professional knowledge/);
    await assert.rejects(invoke(tools, 'use_skill', { name: 'industrial-design', role: 'primary' }), /scopeId/);
    await invoke(tools, 'use_skill', { name: 'industrial-design', scopeId: 'product', role: 'primary' });
    await invoke(tools, 'use_skill', { name: 'ux-design', scopeId: 'ui', role: 'primary' });
    await invoke(tools, 'use_skill', { name: 'product-design', scopeId: 'product', role: 'primary' });
    const selected = value(await invoke(tools, 'list_skills', {})).skillBindings;
    assert.deepEqual(selected.map(({ scope, name }) => ({ scope, name })), [{ scope: 'ui', name: 'ux-design' }, { scope: 'product', name: 'product-design' }]);
    const fresh = harness(workspace, 'designer').tools;
    assert.equal((await invoke(fresh, 'use_skill', { name: 'ux-design', scopeId: 'ui', role: 'primary' })).details.reused, false);
    await assert.rejects(invoke(fresh, 'list_skills', { scopeId: 'product', category: 'ux' }), /match/);
    assert.throws(() => designScopes([scopes[0], scopes[0]]), /unique/);
    assert.throws(() => designScopes([{ id: 'wrong', category: 'unknown', task: 'Task' }]), /Unknown/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('Skill catalog caches metadata and only refresh exposes a changed category mapping', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-skill-cache-'));
  try {
    const path = join(workspace, '.pi/skills/custom/SKILL.md');
    await mkdir(join(path, '..'), { recursive: true });
    const skill = (category) => `---\nname: custom\ndescription: Test module\nmetadata:\n  audience: designer\n  domain_type: custom\n  design_categories: [${category}]\n---\nKnowledge`;
    await writeFile(path, skill('industrial'));
    const { tools } = harness(workspace, 'designer');
    const local = { cwd: workspace };
    assert.ok(value(await invoke(tools, 'list_skills', { category: 'industrial' }, local)).skills.some((skill) => skill.name === 'custom'));
    await writeFile(path, skill('ux'));
    assert.ok(value(await invoke(tools, 'list_skills', { category: 'industrial' }, local)).skills.some((skill) => skill.name === 'custom'));
    assert.equal(value(await invoke(tools, 'list_skills', { category: 'industrial', refresh: true }, local)).skills.some((skill) => skill.name === 'custom'), false);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('Skill-name discovery resolves only a unique assigned scope and loading never invents a scope', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-scope-hint-'));
  try {
    const orchestrator = await init(workspace);
    const tools = harness(workspace, 'designer').tools;
    const catalog = value(await invoke(tools, 'list_skills', { refresh: true, scopeId: 'ui-web-design' }));
    assert.equal(catalog.ok, true);
    assert.equal(catalog.scopeId, 'ui');
    assert.equal(catalog.category, 'ux');
    assert.equal(catalog.scopeResolution.status, 'resolved_unique_hint');
    assert.deepEqual(catalog.skillBindings, []);
    const primary = catalog.skills.find((skill) => skill.name === 'ui-web-design').applicableScopes.find((item) => item.scopeId === 'ui').load;
    assert.deepEqual(primary.arguments, { name: 'ui-web-design', scopeId: 'ui', role: 'primary' });
    assert.equal(catalog.skills.find((skill) => skill.name === 'design-system').primaryEligible, false);
    const rejected = value(await invoke(tools, 'use_skill', { name: 'ui-web-design', scopeId: 'ui-web-design', role: 'primary' }));
    assert.equal(rejected.error, 'unknown_design_scope');
    assert.deepEqual(value(await invoke(tools, 'list_skills', {})).skillBindings, []);
    await invoke(tools, primary.tool, primary.arguments);
    const before = value(await invoke(tools, 'list_skills', {})).skillBindings;
    const invalid = value(await invoke(tools, 'list_skills', { scopeId: 'nonexistent-task' }));
    assert.equal(invalid.scopeResolution.status, 'unresolved');
    assert.equal(invalid.scopeId, null);
    assert.deepEqual(invalid.skillBindings, before);
    const categoryHint = value(await invoke(tools, 'list_skills', { scopeId: 'industrial' }));
    assert.equal(categoryHint.scopeId, 'product');
    const brief = JSON.parse(await readFile(join(workspace, 'runs/demo/brief.json')));
    assert.deepEqual(brief.resolvedScope.designScopes, scopes);
    assert.ok(orchestrator);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('multiple same-category tasks stay distinct and a legitimate project scope id remains usable', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-scope-ambiguity-'));
  try {
    const assigned = [{ id: 'project', category: 'ux', task: 'Public product site' }, { id: 'admin', category: 'ux', task: 'Staff administration dashboard' }];
    await init(workspace, assigned);
    const tools = harness(workspace, 'designer').tools;
    const ambiguous = value(await invoke(tools, 'list_skills', { scopeId: 'ui-web-design' }));
    assert.equal(ambiguous.scopeResolution.status, 'unresolved');
    assert.equal(ambiguous.scopeId, null);
    assert.equal(ambiguous.category, null);
    assert.deepEqual(ambiguous.scopeResolution.suggestedScopes, assigned);
    const skill = ambiguous.skills.find((skill) => skill.name === 'ui-web-design');
    assert.deepEqual(skill.applicableScopes.map((item) => item.scopeId), ['project','admin']);
    for (const item of skill.applicableScopes) await invoke(tools, item.load.tool, item.load.arguments);
    const all = value(await invoke(tools, 'list_skills', {}));
    assert.deepEqual(all.skillBindings.map((binding) => binding.scope), ['project','admin']);
    assert.equal(all.category, null);
    const selected = value(await invoke(tools, 'list_skills', { scopeId: ' project ' }));
    assert.equal(selected.scopeId, 'project');
    assert.equal(selected.category, 'ux');
    const rejected = value(await invoke(tools, 'use_skill', { name: 'ux-design', scopeId: 'ux', role: 'primary' }));
    assert.equal(rejected.ok, false);
    assert.deepEqual(value(await invoke(tools, 'list_skills', {})).skillBindings, all.skillBindings);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('canonical scope protocol survives discovery recovery, design approval and mechanical HTML delivery', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-scope-handoff-'));
  const old = process.env.DREAMATIC_HTML_BROWSER;
  try {
    process.env.DREAMATIC_HTML_BROWSER = 'off';
    const { builder, runDir } = await fixture(workspace, false, { discoveryHint: true });
    for (const audience of ['designer','reviewer','builder']) {
      const ctx = value(await invoke(harness(workspace, audience).tools, 'design_context_read', { runId: 'demo', audience }));
      assert.equal(ctx.scopeProtocol.mode, 'classified');
      assert.deepEqual(ctx.scopeProtocol.assignments[0].discover.arguments, { scopeId: 'ui' });
      assert.equal(ctx.scopeProtocol.assignments[0].category, 'ux');
      assert.equal(ctx.scopeProtocol.assignments[0].defaultOutput, 'html_page');
      assert.ok(ctx.files.some((file) => file.path === '.performance/skills-designer.json'));
    }
    const executed = value(await invoke(builder, 'execute_design_plan', { runId: 'demo' }));
    assert.equal(executed.succeeded, 1);
    assert.equal(executed.results[0].method, 'html_generate');
    await invoke(builder, 'build_finalize', { runId: 'demo' });
    const artifacts = JSON.parse(await readFile(join(runDir, 'artifacts/artifact-manifest.json')));
    assert.equal(artifacts.artifacts[0].scope_id, 'ui');
    assert.equal(artifacts.artifacts[0].category, 'ux');
  } finally { if (old === undefined) delete process.env.DREAMATIC_HTML_BROWSER; else process.env.DREAMATIC_HTML_BROWSER = old; await rm(workspace, { recursive: true, force: true }); }
});

test('a fresh Designer cannot commit a revision by borrowing an earlier Skill activation receipt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-skill-receipt-'));
  try {
    const { runDir } = await fixture(workspace);
    const designer = harness(workspace, 'designer').tools;
    const publish = { runId: 'demo', type: 'design_revision_ready', from_agent: 'designer', to: 'orchestrator', summary: 'Revision', artifactRefs: ['plan/design_plan.json'], requestedAction: 'Review' };
    await assert.rejects(invoke(designer, 'design_bus_post', publish), /not activated|actually loaded primary/);
    const receipt = JSON.parse(await readFile(join(runDir, '.performance/skills-designer.json')));
    assert.deepEqual(receipt.activeSkills, []);
    assert.equal((await readFile(join(runDir, 'bus.jsonl'), 'utf8')).includes('"type":"design_revision_ready"'), false);
    await invoke(designer, 'use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary' });
    await invoke(designer, 'use_skill', { name: 'html-interface', scopeId: 'ui', role: 'supporting' });
    assert.equal(value(await invoke(designer, 'design_bus_post', publish)).ok, true);
    await assert.rejects(invoke(harness(workspace, 'builder').tools, 'execute_design_plan', { runId: 'demo' }), /current approved/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('new Runs require classification while historical unclassified Skill use remains compatible', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-classification-'));
  try {
    const orchestrator = harness(workspace).tools;
    await assert.rejects(invoke(orchestrator, 'run_init', { runIdOverride: 'demo', projectTitle: 'Page', brief: 'A web page' }), /require Orchestrator-assigned designScopes/);
    await assert.rejects(readFile(join(workspace, 'runs/demo/brief.json')), /ENOENT/);
    const initialized = value(await invoke(orchestrator, 'run_init', { runIdOverride: 'demo', projectTitle: 'Page', brief: 'A web page', resolvedScope: JSON.stringify({ designScopes: [scopes[1]] }) }));
    assert.deepEqual(initialized.designScopes, [scopes[1]]);
    assert.equal(initialized.scopeProtocol.mode, 'classified');
    await jsonFile(join(workspace, 'runs/legacy'), 'brief.json', { runId: 'legacy', resolvedScope: {} });
    const legacy = harness(workspace, 'designer', 'legacy').tools;
    const loaded = await invoke(legacy, 'use_skill', { name: 'industrial-design', role: 'primary' });
    assert.equal(loaded.details.scopeId, 'project');
    assert.equal(value(await invoke(legacy, 'list_skills', {})).scopeProtocol.mode, 'legacy_unclassified');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('approved page generation reuses sources, seals inputs and exports the actual UI entry', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-html-'));
  const old = process.env.DREAMATIC_HTML_BROWSER;
  try {
    process.env.DREAMATIC_HTML_BROWSER = 'off';
    const { runDir, builder, orchestrator } = await fixture(workspace);
    const result = value(await invoke(builder, 'html_generate', { runId: 'demo', id: 'page' }));
    assert.equal(result.ok, true);
    assert.equal(value(await invoke(builder, 'html_generate', { runId: 'demo', id: 'page' })).reused, true);
    await invoke(builder, 'build_finalize', { runId: 'demo' });
    const manifest = JSON.parse(await readFile(join(runDir, 'artifacts/artifact-manifest.json')));
    assert.equal(manifest.qualityEvidence.interactions, 'not_assessed');
    assert.deepEqual(manifest.htmlEntries, ['artifacts/ui/index.html', 'artifacts/ui/details.html']);
    const source = await readFile(join(runDir, 'plan/html/ui/index.html'), 'utf8');
    await writeFile(join(runDir, 'plan/html/ui/index.html'), 'Changed after build');
    await assert.rejects(invoke(orchestrator, 'export_package', { runId: 'demo', runDir: 'runs/demo' }), /changed after/);
    await writeFile(join(runDir, 'plan/html/ui/index.html'), source);
    await invoke(orchestrator, 'export_package', { runId: 'demo', runDir: 'runs/demo' });
    const exported = JSON.parse(await readFile(join(runDir, 'final/package-manifest.json')));
    assert.equal(exported.entry, 'artifacts/ui/index.html');
    assert.equal(await readFile(join(runDir, exported.entry), 'utf8'), await readFile(join(runDir, 'final', exported.entry), 'utf8'));
    await invoke(orchestrator, 'run_revision', { runId: 'demo', feedback: 'Refine interface only', designScopes: [scopes[1]] });
    await assert.rejects(invoke(builder, 'html_generate', { runId: 'demo', id: 'page' }), /current approved/);
  } finally { if (old === undefined) delete process.env.DREAMATIC_HTML_BROWSER; else process.env.DREAMATIC_HTML_BROWSER = old; await rm(workspace, { recursive: true, force: true }); }
});

test('mixed execution preserves approved image prompts, resolves page dependencies and reuses completed outputs', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-mixed-'));
  const fetchOriginal = globalThis.fetch, keyOriginal = process.env.DREAMATIC_IMAGE_API_KEY;
  try {
    const { runDir, builder, plan, manifest } = await fixture(workspace, true);
    process.env.DREAMATIC_IMAGE_API_KEY = 'test';
    const prompts = [];
    globalThis.fetch = async (_url, init) => { prompts.push(JSON.parse(init.body).prompt); return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })); };
    const first = value(await invoke(builder, 'execute_design_plan', { runId: 'demo' }));
    assert.equal(first.succeeded, 3);
    assert.deepEqual(prompts.sort(), ['Approved campaign\n\nAvoid: Watermark', 'Approved product\n\nAvoid: Watermark']);
    assert.equal(await readFile(join(runDir, 'artifacts/ui/product.png')).then((bytes) => bytes.equals(PNG)), true);
    const second = value(await invoke(builder, 'execute_design_plan', { runId: 'demo' }));
    assert.ok(second.results.every((result) => result.reused));
    assert.equal(prompts.length, 2);
    await validateDeliveryContract(runDir, deliveryContract(plan, manifest));
    await writeFile(join(runDir, 'plan/html/ui/index.html'), 'Changed after review');
    await assert.rejects(invoke(builder, 'execute_design_plan', { runId: 'demo' }), /changed after/);
  } finally { globalThis.fetch = fetchOriginal; if (keyOriginal === undefined) delete process.env.DREAMATIC_IMAGE_API_KEY; else process.env.DREAMATIC_IMAGE_API_KEY = keyOriginal; await rm(workspace, { recursive: true, force: true }); }
});

test('scope validation rejects claimed but unloaded knowledge and a UX image-only downgrade', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-scope-gates-'));
  try {
    const { runDir, plan, manifest } = await fixture(workspace);
    await assert.rejects(validateDesignScopes(runDir, { ...plan, skill_selection: [{ scope_id: 'ui', name: 'ux-design', role: 'primary', rationale: 'Claimed' }] }, manifest), /not activated/);
    await assert.rejects(validateDesignScopes(runDir, plan, { ...manifest, deliverables: manifest.deliverables.map((item) => ({ ...item, method: 'image_generate' })) }), /requires an HTML/);
    await assert.rejects(validateDesignScopes(runDir, plan, { ...manifest, deliverables: manifest.deliverables.map((item) => ({ ...item, category: 'industrial' })) }), /category/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('verified missing professional knowledge allows a recorded gap but available knowledge cannot be bypassed', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-skill-gap-'));
  try {
    await init(workspace, [scopes[0]]);
    const tools = harness(workspace, 'designer').tools;
    const runDir = join(workspace, 'runs/demo');
    const plan = { skill_selection: [], skill_gaps: [{ scope_id: 'product', reason: 'No suitable professional module installed' }] };
    const manifest = { deliverables: [{ id: 'concept', scope_id: 'product', category: 'industrial', skill_refs: [], method: 'image_generate' }] };
    await invoke(tools, 'list_skills', { scopeId: 'product' });
    await assert.rejects(validateDesignScopes(runDir, plan, manifest), /actually loaded primary/);
    const discovered = value(await invoke(tools, 'list_skills', { scopeId: 'product', refresh: true }, { cwd: workspace }));
    assert.equal(discovered.skills.some((skill) => skill.moduleType === 'discipline' && skill.designCategories.includes('industrial')), false);
    await validateDesignScopes(runDir, plan, manifest);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('required HTML delivery finalizes without materializing optional pages', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-optional-page-'));
  const old = process.env.DREAMATIC_HTML_BROWSER;
  try {
    process.env.DREAMATIC_HTML_BROWSER = 'off';
    const { runDir, builder, orchestrator } = await fixture(workspace, false, { optional: true });
    assert.equal(value(await invoke(builder, 'execute_design_plan', { runId: 'demo' })).succeeded, 1);
    await invoke(builder, 'build_finalize', { runId: 'demo' });
    const built = JSON.parse(await readFile(join(runDir, 'artifacts/artifact-manifest.json')));
    assert.equal(built.htmlEntries.some((path) => path.includes('optional')), false);
    await invoke(orchestrator, 'export_package', { runId: 'demo', runDir: 'runs/demo' });
  } finally { if (old === undefined) delete process.env.DREAMATIC_HTML_BROWSER; else process.env.DREAMATIC_HTML_BROWSER = old; await rm(workspace, { recursive: true, force: true }); }
});

test('mixed Gallery links real pages, retains image prompts and exports without banning approved prototype scripts', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-gallery-page-'));
  const fetchOriginal = globalThis.fetch, keyOriginal = process.env.DREAMATIC_IMAGE_API_KEY, browserOriginal = process.env.DREAMATIC_HTML_BROWSER;
  try {
    process.env.DREAMATIC_HTML_BROWSER = 'off'; process.env.DREAMATIC_IMAGE_API_KEY = 'test';
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
    const { runDir, builder, orchestrator } = await fixture(workspace, true, { gallery: true });
    await invoke(builder, 'execute_design_plan', { runId: 'demo' });
    await invoke(builder, 'showcase_template', { runId: 'demo', title: 'Connected Light', sections: [{ title: 'Hardware, control and campaign', items: ['product', 'page', 'campaign'].map((id) => ({ id, caption: id })) }] });
    await invoke(builder, 'build_finalize', { runId: 'demo' });
    const gallery = await readFile(join(runDir, 'artifacts/00-gallery.html'), 'utf8');
    assert.match(gallery, /href="ui\/index\.html" target="_blank"/);
    assert.doesNotMatch(gallery, /<img[^>]*src="ui\/index\.html"/);
    assert.match(gallery, /Approved product/);
    await invoke(orchestrator, 'export_package', { runId: 'demo', runDir: 'runs/demo' });
    assert.equal(JSON.parse(await readFile(join(runDir, 'final/package-manifest.json'))).entry, '00-index.html');
  } finally {
    globalThis.fetch = fetchOriginal;
    for (const [key, value] of [['DREAMATIC_IMAGE_API_KEY', keyOriginal], ['DREAMATIC_HTML_BROWSER', browserOriginal]]) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(workspace, { recursive: true, force: true });
  }
});

test('HTML lint rejects undeclared/external resources and physical source escapes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-html-lint-'));
  try {
    const { runDir, plan, manifest, page } = await fixture(workspace);
    await materializeHtml(runDir, page);
    await writeFile(join(runDir, 'artifacts/ui/index.html'), '<html><title>Bad</title><script src="https://example.com/a.js"></script><img src="missing.png"></html>');
    const lint = await lintHtmlDelivery(runDir, deliveryContract(plan, manifest));
    assert.equal(lint.ok, false); assert.equal(lint.issues.length, 2);
    await writeFile(join(workspace, 'outside.html'), '<html><title>Outside</title></html>');
    await symlink(workspace, join(runDir, 'plan/html/escape'));
    const task = { ...page, files: [{ source: 'plan/html/escape/outside.html', output: 'artifacts/ui/index.html' }] };
    await assert.rejects(validateDeliveryContract(runDir, deliveryContract({ ...plan, execution_plan: [task] }, manifest)));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('real browser validates page navigation, declared actions and both viewport sizes', async (t) => {
  if (!await browserExecutable()) { t.skip('Chromium browser unavailable'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-browser-'));
  try {
    const { runDir, plan, manifest, page } = await fixture(workspace);
    await materializeHtml(runDir, page);
    const result = await checkHtmlBrowser(runDir, deliveryContract(plan, manifest));
    assert.equal(result.status, 'completed'); assert.deepEqual(result.issues, []); assert.equal(result.passed, true);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('Run-relative native writes resolve correctly for Researcher and Reviewer without weakening ownership', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-relative-writes-'));
  try {
    await init(workspace);
    for (const [agent, path] of [['researcher', 'research/research-findings.md'], ['reviewer', 'review/design-review.md']]) {
      const { handlers } = harness(workspace, agent);
      const input = { path, content: 'Correct Run output' };
      assert.equal(await handlers.get('tool_call')({ toolName: 'write', input }, context), undefined);
      assert.equal(input.path, join(workspace, 'runs/demo', path));
      await createWriteTool(cwd).execute('write', input, undefined, undefined, context);
      assert.equal(await readFile(input.path, 'utf8'), input.content);
      const rejected = await handlers.get('tool_call')({ toolName: 'write', input: { path: 'plan/wrong.md', content: 'Wrong role' } }, context);
      assert.equal(rejected.block, true);
      const escape = await handlers.get('tool_call')({ toolName: 'write', input: { path: 'research/../../escape.md', content: 'Outside' } }, context);
      assert.equal(escape.block, true);
    }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('approved HTML outputs reject native rewrites while mechanical generation remains available', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-approved-output-'));
  try {
    await fixture(workspace);
    const { handlers, tools } = harness(workspace, 'builder');
    const blocked = await handlers.get('tool_call')({ toolName: 'write', input: { path: 'artifacts/ui/index.html', content: 'Rebuilt' } }, context);
    assert.equal(blocked.block, true); assert.match(blocked.reason, /generated mechanically/);
    assert.equal(value(await invoke(tools, 'execute_design_plan', { runId: 'demo' })).succeeded, 1);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('multiple professional scopes can contribute to one page without duplicate execution tasks', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-contributions-'));
  const old = process.env.DREAMATIC_HTML_BROWSER;
  try {
    process.env.DREAMATIC_HTML_BROWSER = 'off';
    const { runDir, builder, plan, manifest } = await fixture(workspace, false, { contribution: true });
    await validateDesignScopes(runDir, plan, manifest);
    assert.equal(plan.execution_plan.length, 1);
    await invoke(builder, 'execute_design_plan', { runId: 'demo' });
    await invoke(builder, 'build_finalize', { runId: 'demo' });
    const built = JSON.parse(await readFile(join(runDir, 'artifacts/artifact-manifest.json')));
    assert.equal(built.artifacts[0].contributing_scopes[0].scope_id, 'campaign');
    const wrong = structuredClone(manifest); wrong.deliverables[0].contributing_scopes[0].category = 'industrial';
    await assert.rejects(validateDesignScopes(runDir, plan, wrong), /category/);
  } finally { if (old === undefined) delete process.env.DREAMATIC_HTML_BROWSER; else process.env.DREAMATIC_HTML_BROWSER = old; await rm(workspace, { recursive: true, force: true }); }
});

test('JSON append uses the returned SHA-256 and stale edits cannot overwrite the result', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-json-append-'));
  try {
    await init(workspace);
    const tools = harness(workspace, 'designer').tools;
    const saved = value(await invoke(tools, 'write_json', { runId: 'demo', path: 'plan/options.json', data: { options: ['a'] } }));
    const updated = value(await invoke(tools, 'patch_json', { runId: 'demo', path: 'plan/options.json', sha256: saved.sha256, updates: [{ pointer: '/options/-', value: 'b' }] }));
    assert.notEqual(saved.sha256, updated.sha256);
    await assert.rejects(invoke(tools, 'patch_json', { runId: 'demo', path: 'plan/options.json', sha256: saved.sha256, updates: [{ pointer: '/options/-', value: 'c' }] }), /Current sha256:/);
    assert.deepEqual(JSON.parse(await readFile(join(workspace, 'runs/demo/plan/options.json'))).options, ['a','b']);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('contact links pass but embedded mailto/script resources remain rejected', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-contact-links-'));
  try {
    const { runDir, page, plan, manifest } = await fixture(workspace);
    await materializeHtml(runDir, page);
    const entry = join(runDir, 'artifacts/ui/index.html');
    await writeFile(entry, '<html><title>Contact</title><a href="mailto:hello@example.com">Email</a><a href="tel:+123456">Phone</a><a href="?tab=about">About</a></html>');
    assert.equal((await lintHtmlDelivery(runDir, deliveryContract(plan, manifest))).ok, true);
    await writeFile(entry, '<html><title>Bad</title><script src="mailto:hello@example.com"></script><a href="javascript:alert(1)">Bad</a></html>');
    assert.equal((await lintHtmlDelivery(runDir, deliveryContract(plan, manifest))).ok, false);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('legacy incomplete HTML approval is blocked before execution and recovery requires a corrected specification', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-build-block-'));
  const old = process.env.DREAMATIC_HTML_BROWSER;
  try {
    process.env.DREAMATIC_HTML_BROWSER = 'off';
    const { runDir, builder, orchestrator } = await fixture(workspace);
    const index = join(runDir, 'plan/html/ui/index.html');
    const source = await readFile(index, 'utf8');
    await writeFile(index, source.replace('</body>', '<img src="missing.png"></body>'));
    // Reproduce an old approval whose source hash was accepted without resource closure.
    const events=(await readFile(join(runDir,'bus.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const hash=createHash('sha256').update(await readFile(index)).digest('hex');
    for(const event of events) if(event.commitReceipt?.files?.['plan/html/ui/index.html']) event.commitReceipt.files['plan/html/ui/index.html']=hash;
    await writeFile(join(runDir,'bus.jsonl'),events.map(JSON.stringify).join('\n')+'\n');
    await assert.rejects(invoke(builder, 'execute_design_plan', { runId: 'demo' }), /undeclared local reference/);
    await assert.rejects(readFile(join(runDir,'artifacts/ui/index.html')),/ENOENT/);
    assert.doesNotMatch(await readFile(join(runDir, 'bus.jsonl'), 'utf8'), /"type":"build_done"/);
    assert.equal(value(await invoke(orchestrator, 'spawn_agent', { agent: 'builder', runId: 'demo', task: 'Retry unchanged build' }, { ...context, model: { id: 'test', provider: 'test', api: 'openai-completions' } })).blocked, true);
    const designer = harness(workspace, 'designer').tools;
    await invoke(designer, 'use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary' });
    await invoke(designer, 'use_skill', { name: 'html-interface', scopeId: 'ui', role: 'supporting' });
    await writeFile(index, source);
    await invoke(designer, 'design_bus_post', { runId: 'demo', type: 'design_revision_ready', from_agent: 'designer', to: 'orchestrator', summary: 'Fixed source', artifactRefs: ['plan/design_plan.json'], requestedAction: 'Review' });
    await invoke(harness(workspace, 'reviewer').tools, 'design_bus_post', { runId: 'demo', type: 'design_review_pass', from_agent: 'reviewer', to: 'orchestrator', summary: 'Corrected source approved', artifactRefs: ['review/design-review.json'], requestedAction: 'Build' });
    const recovered = harness(workspace, 'builder').tools;
    await invoke(recovered, 'execute_design_plan', { runId: 'demo' });
    assert.equal(value(await invoke(recovered, 'build_finalize', { runId: 'demo' })).ok, true);
  } finally { if (old === undefined) delete process.env.DREAMATIC_HTML_BROWSER; else process.env.DREAMATIC_HTML_BROWSER = old; await rm(workspace, { recursive: true, force: true }); }
});

test('browser checks support collection assertions and explicit responsive applicability, while real failures remain failures', async (t) => {
  if (!await browserExecutable()) { t.skip('Chromium unavailable'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-responsive-checks-'));
  try {
    const { runDir, plan, manifest, page } = await fixture(workspace);
    await materializeHtml(runDir, page);
    await writeFile(join(runDir, 'artifacts/ui/index.html'), '<html><head><title>Responsive</title><style>.mobile{display:none}@media(max-width:600px){.desktop{display:none}.mobile{display:block}}</style></head><body><button class="desktop">Desktop</button><button class="mobile">Mobile</button><p class="result">Ready</p><p class="result">Ready</p></body></html>');
    const task = { ...page, interaction_checks: [
      { name: 'Collection', steps: [{ action: 'expect_visible', selector: '.result' }, { action: 'expect_text', selector: '.result', match: 'all', value: 'Ready' }] },
      { name: 'Desktop', viewport: { min_width: 601 }, steps: [{ action: 'click', selector: '.desktop' }] },
      { name: 'Mobile', viewport: { max_width: 600 }, steps: [{ action: 'click', selector: '.mobile' }] },
    ] };
    const contract = deliveryContract({ ...plan, execution_plan: [task] }, manifest);
    const success = await checkHtmlBrowser(runDir, contract);
    assert.equal(success.passed, true); assert.equal(success.checks.filter((check) => check.status === 'not_applicable').length, 2);
    task.interaction_checks[0].steps[1].match = 'unique';
    const failure = await checkHtmlBrowser(runDir, deliveryContract({ ...plan, execution_plan: [task] }, manifest));
    assert.equal(failure.passed, false); assert.match(failure.issues.join(' '), /matches 2 elements/);
    assert.equal(failure.checks.filter((check) => check.name === 'Mobile' && check.status === 'passed').length, 1);
    assert.throws(() => htmlTask({ ...task, interaction_checks: [{ name: 'No viewport', viewport: { min_width: 2000 }, steps: [{ action: 'click', selector: 'button' }] }] }), /no declared viewport/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('explicit tool directories expose installed ripgrep through Pi without replacing its search implementation', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const rg = spawnSync('which', ['rg'], { encoding: 'utf8' }).stdout.trim();
  if (!rg) { t.skip('Local rg unavailable'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-pi-tools-'));
  const oldPath = process.env.PATH, oldConfigured = process.env.DREAMATIC_TOOL_PATH;
  try {
    const bin = join(workspace, 'bin'); await mkdir(bin);
    await symlink(rg, join(bin, 'rg')); await writeFile(join(workspace, 'sample.txt'), 'needle\n');
    process.env.DREAMATIC_TOOL_PATH = bin;
    configureToolSearchPath(); configureToolSearchPath();
    assert.equal(process.env.PATH.split((await import('node:path')).delimiter).filter((path) => path === bin).length, 1);
    const result = await createGrepTool(workspace).execute('search', { pattern: 'needle', path: join(workspace, 'sample.txt') }, undefined, undefined, { cwd: workspace });
    assert.match(result.content[0].text, /needle/);
    delete process.env.DREAMATIC_TOOL_PATH; configureToolSearchPath();
    assert.equal(process.env.PATH.split((await import('node:path')).delimiter).includes(bin), false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldConfigured === undefined) delete process.env.DREAMATIC_TOOL_PATH; else process.env.DREAMATIC_TOOL_PATH = oldConfigured;
    await rm(workspace, { recursive: true, force: true });
  }
});


test('Designer publication derives validated references and routes proceed_to_build to a new Reviewer approval', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-publication-refs-'));
  const old = process.env.DREAMATIC_HTML_BROWSER;
  try {
    process.env.DREAMATIC_HTML_BROWSER = 'off';
    const { runDir, builder } = await fixture(workspace, false, { omitArtifactRefs: true, requestedAction: 'proceed_to_build' });
    const events = (await readFile(join(runDir, 'bus.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const published = events.find((event) => event.type === 'design_spec_ready');
    assert.equal(published.nextAgent, 'reviewer');
    assert.equal(published.requestedAction, 'review');
    assert.equal(published.submittedRequestedAction, 'proceed_to_build');
    for (const path of ['plan/design_plan.json','plan/design_system.json','plan/deliverable_manifest.json','plan/task_breakdown.md','plan/acceptance_criteria.md','plan/html/ui/index.html']) {
      assert.ok(published.artifactRefs.includes(path));
      assert.equal(typeof published.commitReceipt.files[path], 'string');
    }
    assert.ok(events.findIndex((event) => event.type === 'design_review_pass') > events.indexOf(published));
    assert.equal(value(await invoke(builder, 'execute_design_plan', { runId: 'demo' })).succeeded, 1);
    await invoke(builder, 'build_finalize', { runId: 'demo' });
  } finally { if (old === undefined) delete process.env.DREAMATIC_HTML_BROWSER; else process.env.DREAMATIC_HTML_BROWSER = old; await rm(workspace, { recursive: true, force: true }); }
});

test('publication rejects missing, cross-Run and unowned explicit references without publishing an event', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-publication-invalid-'));
  try {
    const { runDir, designer } = await fixture(workspace);
    const before = await readFile(join(runDir, 'bus.jsonl'), 'utf8');
    const publish = { runId: 'demo', type: 'design_revision_ready', from_agent: 'designer', to: 'orchestrator', summary: 'Updated design', requestedAction: 'proceed_to_build' };
    for (const ref of ['plan/missing.json', '../../other/plan/design_plan.json', 'runs/other/plan/design_plan.json', 'review/design-review.json']) {
      await assert.rejects(invoke(designer, 'design_bus_post', { ...publish, artifactRefs: [ref] }), /missing or empty|escapes|owned or declared/);
      assert.equal(await readFile(join(runDir, 'bus.jsonl'), 'utf8'), before);
    }
    await rm(join(runDir, 'plan/html/ui/style.css'));
    await assert.rejects(invoke(designer, 'design_bus_post', publish), /ENOENT|missing/);
    assert.equal(await readFile(join(runDir, 'bus.jsonl'), 'utf8'), before);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('HTML resource publication diagnoses external URL declarations with a task, field and valid local mapping', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-publication-resource-'));
  try {
    const { runDir, designer, plan } = await fixture(workspace);
    const before = await readFile(join(runDir, 'bus.jsonl'), 'utf8');
    plan.execution_plan[0].resources = [{ type: 'external_url', url: 'https://fonts.googleapis.com/css2?family=Inter', license: 'SIL Open Font License' }];
    const saved = value(await invoke(designer, 'write_json', { runId: 'demo', path: 'plan/design_plan.json', data: plan }));
    assert.ok(saved.warnings.some((warning) => warning.includes('task page.resources[0]') && warning.includes('external_url')));
    await assert.rejects(invoke(designer, 'design_bus_post', { runId: 'demo', type: 'design_revision_ready', from_agent: 'designer', to: 'orchestrator', summary: 'Declare font', requestedAction: 'proceed_to_build' }), /plan\/design_plan.json.*task page\.resources\[0\].*external_url.*system-font/);
    assert.equal(await readFile(join(runDir, 'bus.jsonl'), 'utf8'), before);
    plan.execution_plan[0].resources = [{}];
    assert.throws(() => htmlTask(plan.execution_plan[0]), /task page\.resources\[0\]\.source must be a non-empty string/);
    plan.execution_plan[0].resources = [{ source: 'research/assets/font.woff2' }];
    assert.throws(() => htmlTask(plan.execution_plan[0]), /task page\.resources\[0\]\.output must be a non-empty string/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});


test('Orchestrator rejects a mistyped specialist Run before creating a child or orphan directory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-run-ownership-'));
  try {
    const canonical = 'project-2026-10-05-e3d73c65', wrong = 'project-2026-10-05-e3d73c73';
    const tools = new Map(), handlers = new Map();
    createDreamaticExtension({ workspaceDir: workspace, projectId: canonical })({ on(name, fn) { handlers.set(name, fn); }, registerTool(tool) { tools.set(tool.name, tool); } });
    await invoke(tools, 'run_init', { projectTitle: 'Academic interface', brief: 'Design a bilingual page', designScopes: [scopes[1]] });
    await assert.rejects(invoke(tools, 'spawn_agent', { agent: 'designer', runId: wrong, task: 'Design page' }, {}), /spawn_agent.*canonical runId: project-2026-10-05-e3d73c65/);
    const blocked = await handlers.get('tool_call')({ toolName: 'spawn_agent', input: { agent: 'designer', runId: wrong } });
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /canonical runId: project-2026-10-05-e3d73c65/);
    await assert.rejects(invoke(tools, 'spawn_agent', { agent: 'designer', runId: canonical, task: `Run id: ${wrong}. Design page` }, { ...context, model: {} }), /handoff disagrees/);
    await assert.rejects(readFile(join(workspace, 'runs', wrong, 'run-state.json')), /ENOENT/);
    await assert.rejects(readFile(join(workspace, 'runs', canonical, 'sessions/designer')), /ENOENT/);
    const unowned = harness(workspace).tools;
    await assert.rejects(invoke(unowned, 'spawn_agent', { agent: 'designer', runId: 'never-initialized', task: 'Design' }, { ...context, model: {} }), /requires an initialized Run/);
    await assert.rejects(readFile(join(workspace, 'runs/never-initialized/brief.json')), /ENOENT/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('correctly assigned Designer writes the submitted design-system envelope while cross-project data remains blocked', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-json-ownership-'));
  try {
    const canonical = 'project-2026-10-05-e3d73c65', wrong = 'project-2026-10-05-e3d73c73';
    const tools = new Map();
    createDreamaticExtension({ workspaceDir: workspace, projectId: canonical, parentInvocation: { id: 'designer-canonical', agent: 'designer', runId: canonical } })({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } });
    const data = { runId: canonical, schemaVersion: 2, system_thesis: 'Luminous Network', palette: { background_primary: '#0a0e1a' }, typography: { font_en: 'system-ui' } };
    const writer = tools.get('write_json');
    const normalized = writer.prepareArguments({ data });
    assert.equal(normalized.runId, canonical);
    assert.equal(normalized.path, 'plan/design_system.json');
    await writer.execute('write-system', normalized);
    assert.deepEqual(JSON.parse(await readFile(join(workspace, 'runs', canonical, 'plan/design_system.json'))), data);
    await assert.rejects(invoke(tools, 'write_json', { runId: wrong, path: 'plan/design_system.json', data: { ...data, runId: wrong } }), /canonical runId/);
    assert.throws(() => writer.prepareArguments({ data: { ...data, runId: wrong } }), /must agree/);
    const conflicted = new Map();
    createDreamaticExtension({ workspaceDir: workspace, projectId: canonical, parentInvocation: { id: 'designer-wrong', agent: 'designer', runId: wrong } })({ on() {}, registerTool(tool) { conflicted.set(tool.name, tool); } });
    await assert.rejects(invoke(conflicted, 'write_json', { runId: wrong, path: 'plan/design_system.json', data: { ...data, runId: wrong } }), /canonical runId/);
    await assert.rejects(readFile(join(workspace, 'runs', wrong, 'plan/design_system.json')), /ENOENT/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('restored conversation tools enforce project ownership assigned after extension initialization', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-late-ownership-'));
  try {
    let projectId;
    const tools = new Map(), handlers = new Map();
    createDreamaticExtension({ workspaceDir: workspace, get projectId() { return projectId; } })({ on(name, fn) { handlers.set(name, fn); }, registerTool(tool) { tools.set(tool.name, tool); } });
    projectId = 'canonical-project';
    await assert.rejects(invoke(tools, 'spawn_agent', { agent: 'designer', runId: 'other-project', task: 'Design' }, {}), /canonical runId: canonical-project/);
    const blocked = await handlers.get('tool_call')({ toolName: 'design_context_read', input: { runId: 'other-project', audience: 'designer' } });
    assert.equal(blocked.block, true);
    await assert.rejects(invoke(tools, 'write_json', { runId: 'other-project', path: 'plan/progress.json', data: {} }), /canonical runId: canonical-project/);
    assert.equal(writerTarget(), projectId);
    function writerTarget() { return tools.get('write_json').prepareArguments({ path: 'plan/progress.json', data: {} }).runId; }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});


test('HTML presentation retains required images after subset execution and incomplete finalization remains recoverable', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-subset-delivery-'));
  const fetchOriginal = globalThis.fetch, keyOriginal = process.env.DREAMATIC_IMAGE_API_KEY, browserOriginal = process.env.DREAMATIC_HTML_BROWSER;
  try {
    process.env.DREAMATIC_HTML_BROWSER = 'off';
    const { runDir, builder } = await fixture(workspace, true);
    process.env.DREAMATIC_IMAGE_API_KEY = 'test';
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })); };
    // Page selection includes its product dependency, but not the independent campaign image.
    const subset = value(await invoke(builder, 'execute_design_plan', { runId: 'demo', ids: ['page'] }));
    assert.equal(subset.ok, true);
    assert.equal(subset.deliveryComplete, false);
    assert.deepEqual(subset.pendingOutputs, [{ id: 'campaign', method: 'image_generate', files: ['artifacts/campaign.png'] }]);
    const result = await invoke(builder, 'build_finalize', { runId: 'demo' });
    const incomplete = value(result);
    assert.equal(incomplete.ok, false); assert.equal(incomplete.retryable, true); assert.equal(incomplete.blocked, false);
    assert.equal(incomplete.repairOwner, 'builder');
    assert.equal(specialistCompletionEvent('builder', 'build_finalize', false, { runId: 'demo' }, result), undefined);
    assert.doesNotMatch(await readFile(join(runDir, 'bus.jsonl'), 'utf8'), /"type":"build_done"/);
    const complete = value(await invoke(builder, 'execute_design_plan', { runId: 'demo' }));
    assert.equal(complete.deliveryComplete, true); assert.deepEqual(complete.pendingOutputs, []);
    assert.equal(calls, 2); // Successful dependency image is reused, not regenerated.
    assert.equal(value(await invoke(builder, 'build_finalize', { runId: 'demo' })).ok, true);
  } finally {
    globalThis.fetch = fetchOriginal;
    if (keyOriginal === undefined) delete process.env.DREAMATIC_IMAGE_API_KEY; else process.env.DREAMATIC_IMAGE_API_KEY = keyOriginal;
    if (browserOriginal === undefined) delete process.env.DREAMATIC_HTML_BROWSER; else process.env.DREAMATIC_HTML_BROWSER = browserOriginal;
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Reviewer rejects major accepted risks and permits resolved corrections with minor suggestions', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-review-readiness-'));
  try {
    const { runDir } = await fixture(workspace);
    const reviewer = harness(workspace, 'reviewer').tools;
    const review = JSON.parse(await readFile(join(runDir, 'review/design-review.json')));
    review.issues = [{ id: 'filter-bug', severity: 'major', status: 'open', owner: 'designer' }];
    await jsonFile(runDir, 'review/design-review.json', review);
    const args = { runId: 'demo', type: 'design_review_pass', from_agent: 'reviewer', to: 'orchestrator', summary: 'Reviewed' };
    await assert.rejects(invoke(reviewer, 'design_bus_post', args), /unresolved major issue.*filter-bug/);
    review.issues[0].status = 'accepted_risk';
    await jsonFile(runDir, 'review/design-review.json', review);
    await assert.rejects(invoke(reviewer, 'design_bus_post', args), /accepted_risk cannot waive/);
    review.issues[0].status = 'resolved';
    review.issues.push({ id: 'optional-animation', severity: 'minor', status: 'open', owner: 'designer' });
    await jsonFile(runDir, 'review/design-review.json', review);
    await invoke(reviewer, 'design_bus_post', args);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('historical pass with a valid receipt cannot bypass major defect readiness at build time', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-old-review-'));
  try {
    const { runDir, builder, orchestrator } = await fixture(workspace);
    const review = JSON.parse(await readFile(join(runDir, 'review/design-review.json')));
    review.issues = [{ id: 'filter-bug', severity: 'major', status: 'accepted_risk', owner: 'designer' }];
    await jsonFile(runDir, 'review/design-review.json', review);
    // Simulate a pass committed by the old runtime, with authentic matching hashes.
    const busPath = join(runDir, 'bus.jsonl');
    const bus = (await readFile(busPath, 'utf8')).trim().split('\n').map(JSON.parse);
    bus.at(-1).commitReceipt.files['review/design-review.json'] = createHash('sha256').update(await readFile(join(runDir, 'review/design-review.json'))).digest('hex');
    await writeFile(busPath, bus.map(JSON.stringify).join('\n') + '\n');
    await assert.rejects(invoke(builder, 'execute_design_plan', { runId: 'demo' }), /unresolved major issue/);
    const result = await invoke(builder, 'build_finalize', { runId: 'demo' });
    assert.equal(value(result).repairOwner, 'designer'); assert.equal(value(result).blocked, true);
    assert.equal(specialistCompletionEvent('builder', 'build_finalize', false, { runId: 'demo' }, result), undefined);
    const spawn = value(await invoke(orchestrator, 'spawn_agent', { runId: 'demo', agent: 'builder', task: 'Build' }, { ...context, model: { id: 'test', provider: 'test', api: 'openai-completions' } }));
    assert.equal(spawn.blocked, true); assert.equal(spawn.repairOwner, 'designer');
    assert.equal(await readFile(busPath, 'utf8'), bus.map(JSON.stringify).join('\n') + '\n');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});


test('approved image acceptance aliases and manifest fallback execute unchanged prompts in a mixed plan', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-acceptance-alias-'));
  const fetchOriginal = globalThis.fetch, keyOriginal = process.env.DREAMATIC_IMAGE_API_KEY;
  try {
    const { builder } = await fixture(workspace, true, { imageAcceptance: 'acceptance' });
    process.env.DREAMATIC_IMAGE_API_KEY = 'test';
    const prompts = [];
    globalThis.fetch = async (_url, init) => { prompts.push(JSON.parse(init.body).prompt); return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })); };
    const result = value(await invoke(builder, 'execute_design_plan', { runId: 'demo' }));
    assert.equal(result.succeeded, 3); assert.equal(result.deliveryComplete, true);
    assert.deepEqual(prompts.sort(), ['Approved campaign\n\nAvoid: Watermark', 'Approved product\n\nAvoid: Watermark']);
    for (const field of ['acceptanceCriteria', 'acceptance_criteria', 'acceptance_test', 'acceptance']) assert.deepEqual(approvedImageAcceptance({ id: 'x', [field]: ['Keep the agreed visual'] }, {}), ['Keep the agreed visual']);
    assert.deepEqual(approvedImageAcceptance({ id: 'x' }, { acceptance_test: 'Approved manifest criterion' }), ['Approved manifest criterion']);
    assert.throws(() => approvedImageAcceptance({ id: 'x', acceptance: '' }, { acceptance_test: 'Fallback' }), /declared acceptance/);
    assert.throws(() => approvedImageAcceptance({ id: 'x' }, {}), /declared acceptance/);
  } finally { globalThis.fetch = fetchOriginal; if (keyOriginal === undefined) delete process.env.DREAMATIC_IMAGE_API_KEY; else process.env.DREAMATIC_IMAGE_API_KEY = keyOriginal; await rm(workspace, { recursive: true, force: true }); }
});

test('interaction viewport fields are never silently ignored and report their exact correction location', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-check-protocol-'));
  try {
    const { page, plan, manifest, runDir } = await fixture(workspace);
    const invalid = structuredClone(page);
    invalid.interaction_checks[0].steps[0].viewport = { min_width: 1200 };
    assert.throws(() => htmlTask(invalid), /interaction_checks\[0\].steps\[0\].*whole interaction check/);
    delete invalid.interaction_checks[0].steps[0].viewport;
    invalid.interaction_checks[0].viewport = { width: 1440 };
    assert.throws(() => htmlTask(invalid), /accepts only min_width and max_width/);
    invalid.interaction_checks[0].viewport = { min_width: 1200 };
    assert.deepEqual(htmlTask(invalid).interaction_checks[0].viewport, { min_width: 1200 });
    delete plan.execution_plan[0].interaction_checks[0].viewport;
    plan.execution_plan[0].interaction_checks[0].steps[0].viewport = { max_width: 767 };
    await assert.rejects(validateDeliveryContract(runDir, deliveryContract(plan, manifest)), /steps\[0\].*whole interaction check/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('a fresh Designer receives the full Skill reload checklist and progress includes remaining support modules', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-skill-checklist-'));
  try {
    const { plan } = await fixture(workspace, true);
    const designer = harness(workspace, 'designer').tools;
    const args = { runId: 'demo', audience: 'designer' };
    const initial = value(await invoke(designer, 'design_context_read', args)).skillLoading.selectionChecklist;
    assert.equal(initial.length, plan.skill_selection.length); assert.ok(initial.every((item) => !item.loaded));
    const first = initial.find((item) => item.role === 'primary');
    const result = await invoke(designer, first.load.tool, first.load.arguments);
    assert.equal(result.details.pendingSkillLoads.length, initial.length - 1);
    assert.ok(result.details.pendingSkillLoads.some((item) => item.name === 'html-interface' && item.role === 'supporting'));
    for (const item of result.details.pendingSkillLoads) await invoke(designer, item.load.tool, item.load.arguments);
    assert.ok(value(await invoke(designer, 'design_context_read', args)).skillLoading.selectionChecklist.every((item) => item.loaded));
    const fresh = value(await invoke(harness(workspace, 'designer').tools, 'design_context_read', args));
    assert.ok(fresh.skillLoading.selectionChecklist.every((item) => !item.loaded));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('workspace-relative runs paths resolve to the assigned Run and reject cross-Run access', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-runs-relative-'));
  try {
    const { runDir } = await fixture(workspace);
    const { handlers } = harness(workspace, 'designer');
    const input = { path: 'runs/demo/plan/design_plan.json' };
    assert.equal(await handlers.get('tool_call')({ toolName: 'read', input }, context), undefined);
    assert.equal(input.path, join(runDir, 'plan/design_plan.json'));
    const result = await createReadTool(cwd).execute('read', input, undefined, undefined, context);
    assert.match(result.content[0].text, /execution_plan/);
    const rejected = await handlers.get('tool_call')({ toolName: 'read', input: { path: 'runs/other/plan/design_plan.json' } }, context);
    assert.equal(rejected.block, true);
    const escaped = await handlers.get('tool_call')({ toolName: 'read', input: { path: 'runs/demo/../../escape.md' } }, context);
    assert.equal(escaped.block, true);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});


test('mixed batch mismatch reports all ids and readonly recovery explains the real draft repair', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-batch-diagnostics-'));
  try {
    const { plan, manifest, runDir } = await fixture(workspace, true);
    plan.image_generation_plan = plan.execution_plan.filter((task) => task.method !== 'html_generate');
    plan.execution_plan = [plan.execution_plan[0], { id: 'decorative-images', method: 'image_generate' }];
    await jsonFile(runDir, 'plan/design_plan.json', plan);
    await assert.rejects(validateDeliveryContract(runDir, deliveryContract(plan, manifest)), /decorative-images.*no matching deliverables/s);
    const before = await readFile(join(runDir, 'plan/design_plan.json'));
    const report = await designerDraftReadiness(runDir);
    assert.equal(report.ok, false);
    assert.match(report.issues.join('\n'), /deliverables.product.*no execution_plan task/);
    assert.match(report.issues.join('\n'), /deliverables.campaign.*no execution_plan task/);
    assert.deepEqual(await readFile(join(runDir, 'plan/design_plan.json')), before);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('failed typed publication preserves JSON hashes and stops repeated unchanged envelopes across invocations', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-publication-loop-'));
  try {
    const { plan, runDir } = await fixture(workspace, true);
    plan.image_generation_plan = plan.execution_plan.filter((task) => task.method !== 'html_generate');
    plan.execution_plan = [plan.execution_plan[0], { id: 'decorative-images', method: 'image_generate' }];
    await jsonFile(runDir, 'plan/design_plan.json', plan);
    const before = await readFile(join(runDir, 'plan/design_plan.json'));
    const args = { runId: 'demo', type: 'design_revision_ready', from_agent: 'designer', to: 'orchestrator', summary: 'Done' };
    await assert.rejects(invoke(harness(workspace, 'designer').tools, 'design_bus_post', args), /no matching deliverables/);
    await assert.rejects(invoke(harness(workspace, 'designer').tools, 'design_bus_post', { ...args, summary: 'Changed summary' }), /no matching deliverables/);
    const third = await invoke(harness(workspace, 'designer').tools, 'design_bus_post', { ...args, artifactRefs: [], runDir });
    assert.equal(third.details.blocked, true); assert.equal(third.details.attempts, 3);
    assert.equal(specialistCompletionEvent('designer', 'design_bus_post', false, args, third), undefined);
    assert.deepEqual(await readFile(join(runDir, 'plan/design_plan.json')), before);
    assert.doesNotMatch(await readFile(join(runDir, 'bus.jsonl'), 'utf8'), /"type":"design_revision_ready"/);
    // A real draft correction resets the unchanged-failure count, even before Skills reload.
    plan.execution_plan = [plan.execution_plan[0], ...plan.image_generation_plan];
    await jsonFile(runDir, 'plan/design_plan.json', plan);
    await assert.rejects(invoke(harness(workspace, 'designer').tools, 'design_bus_post', args), /not activated/);
    assert.equal(JSON.parse(await readFile(join(runDir, '.performance/designer-recovery.json'))).attempts, 1);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('UX handoffs cannot transfer source design to Builder and legacy image work remains available', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-handoff-contract-'));
  try {
    const orchestrator = await init(workspace, [scopes[1]]);
    const result = value(await invoke(orchestrator, 'spawn_agent', { runId: 'demo', agent: 'designer', task: '不需要编写HTML代码（Builder的工作）' }, { ...context, model: { id: 'test', provider: 'test', api: 'openai-completions' } }));
    assert.equal(result.ok, false); assert.equal(result.repairOwner, 'orchestrator');
    assert.match(result.error, /Designer owns complete HTML/);
    assert.equal(designerHandoffError('DO NOT write HTML; Builder authors it', { resolvedScope: { designScopes: [scopes[1]] } })?.includes('Designer owns'), true);
    assert.equal(designerHandoffError('Design the image prompts; no need to write HTML', { resolvedScope: { designScopes: [scopes[0]] } }), undefined);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('remote fonts are diagnosed in source before approval while navigation and declared generated imagery remain valid', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-font-preflight-'));
  try {
    const { runDir, page } = await fixture(workspace);
    const sourcePath = join(runDir, page.files[0].source);
    const original = await readFile(sourcePath, 'utf8');
    await writeFile(sourcePath, original.replace('</head>', '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head>'));
    const report = await designerDraftReadiness(runDir);
    assert.equal(report.ok, false); assert.match(report.issues.join('\n'), /remote embedded resource.*fonts.googleapis.com/);
    await writeFile(sourcePath, original.replace('</body>', '<a href="https://example.com">Paper</a></body>'));
    assert.equal((await designerDraftReadiness(runDir)).ok, true);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('image viewing accepts inventory path objects without guessing paths or bypassing ownership', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-image-input-'));
  try {
    await init(workspace);
    const path = join(workspace, 'runs/demo/research/assets/reference.png');
    await writeFile(path, PNG);
    const tool = harness(workspace, 'designer').tools.get('view_image');
    const args = tool.prepareArguments({ paths: [{ asset_id: 'reference', path }] });
    assert.deepEqual(args, { paths: [path] });
    assert.equal((await tool.execute('view', args, undefined, undefined, context)).details.results[0].ok, true);
    await assert.rejects(tool.execute('cross', tool.prepareArguments({ paths: [{ path: join(workspace, 'runs/other/private.png') }] }), undefined, undefined, context), /assigned Run/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});


test('Orchestrator cannot launch a publish-only recovery against a known invalid draft', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-publish-handoff-'));
  try {
    const { plan, runDir, orchestrator } = await fixture(workspace, true);
    plan.execution_plan = [{ id: 'decorative-images', method: 'image_generate' }, plan.execution_plan[0]];
    await jsonFile(runDir, 'plan/design_plan.json', plan);
    const result = value(await invoke(orchestrator, 'spawn_agent', { runId: 'demo', agent: 'designer', task: 'Your files are complete. You only need to commit the event. DO NOT read any files.' }, { ...context, model: { id: 'test', provider: 'test', api: 'openai-completions' } }));
    assert.equal(result.ok, false); assert.equal(result.repairOwner, 'orchestrator'); assert.equal(result.draftReadiness.ok, false);
    assert.match(result.draftReadiness.issues.join('\n'), /decorative-images/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('source diagnostics expose remote fonts even behind an invalid interaction viewport', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-masked-diagnostics-'));
  try {
    const { runDir, plan, page } = await fixture(workspace);
    plan.execution_plan[0].interaction_checks[0].viewport = { min_width: 0 };
    await jsonFile(runDir, 'plan/design_plan.json', plan);
    const path = join(runDir, page.files[0].source);
    await writeFile(path, (await readFile(path, 'utf8')).replace('</head>', '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head>'));
    const report = await designerDraftReadiness(runDir);
    assert.match(report.issues.join('\n'), /viewport.min_width/);
    assert.match(report.issues.join('\n'), /fonts.googleapis.com/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});


test('Designer publication catches duplicate selectors and hidden mobile navigation before build; corrected checks reuse source preflight', async (t) => {
  if (!await browserExecutable()) { t.skip('Chromium unavailable'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-navigation-preflight-'));
  try {
    const { runDir, plan, manifest, designer } = await fixture(workspace, true, { navigationFailure: true, legacyApproval: true });
    const beforeSource = await readFile(join(runDir, 'plan/html/ui/index.html'));
    const beforeBus = await readFile(join(runDir, 'bus.jsonl'), 'utf8');
    const publication = {runId:'demo',type:'design_revision_ready',from_agent:'designer',to:'orchestrator',summary:'Revalidate navigation',requestedAction:'Review'};
    await assert.rejects(invoke(designer, 'design_bus_post', publication), /HTML source preflight.*Smooth scroll.*strict mode violation/s);
    const report = JSON.parse(await readFile(join(runDir, '.performance/html-preflight.json'), 'utf8'));
    assert.equal(report.report.checks.filter((item) => item.name === 'Smooth scroll' && item.status === 'failed').length, 3);
    assert.equal(report.report.checks.filter((item) => item.name === 'Header shadow' && item.status === 'failed').length, 1);
    assert.match(report.report.issues.join(' '), /390px.*Timeout/);
    assert.equal(await readFile(join(runDir, 'bus.jsonl'), 'utf8'), beforeBus);
    await assert.rejects(readFile(join(runDir, 'artifacts/product.png')), /ENOENT/);
    const cachedFailure = await readFile(join(runDir, '.performance/html-preflight.json'), 'utf8');
    await assert.rejects(assertHtmlSourcePreflight(runDir, deliveryContract(plan, manifest)), /strict mode violation/);
    assert.equal(await readFile(join(runDir, '.performance/html-preflight.json'), 'utf8'), cachedFailure);
    plan.execution_plan[0].interaction_checks[0].steps[0].selector = '.hero-actions a[href="#research"]';
    plan.execution_plan[0].interaction_checks[1].steps[0].selector = '.hero-actions a[href="#contact"]';
    await invoke(designer, 'write_json', {runId:'demo',path:'plan/design_plan.json',data:plan});
    await invoke(designer, 'design_bus_post', publication);
    const success = await assertHtmlSourcePreflight(runDir, deliveryContract(plan, manifest));
    assert.equal(success.passed, true); assert.equal(success.reused, true);
    assert.equal(success.checks.length, 6);
    assert.ok((await readFile(join(runDir, 'plan/html/ui/index.html'))).equals(beforeSource));
    await assert.rejects(readFile(join(runDir, 'artifacts/ui/product.png')), /ENOENT/);
    await writeFile(join(runDir, 'plan/html/ui/app.js'), '/* Broken interaction */');
    await assert.rejects(assertHtmlSourcePreflight(runDir, deliveryContract(plan, manifest)), /Header shadow/);
    assert.notEqual(JSON.parse(await readFile(join(runDir, '.performance/html-preflight.json'), 'utf8')).fingerprint, success.fingerprint);
  } finally { await rm(workspace, {recursive:true,force:true}); }
});

test('Builder performs no second browser/interaction audit after approval, while output integrity still gates completion', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-builder-mechanical-'));
  const old = Object.fromEntries(['DREAMATIC_HTML_BROWSER','DREAMATIC_HTML_BROWSER_EXECUTABLE','DREAMATIC_HTML_REQUIRE_BROWSER','DREAMATIC_IMAGE_API_KEY'].map(key=>[key,process.env[key]]));
  const originalFetch = globalThis.fetch;
  try {
    process.env.DREAMATIC_HTML_BROWSER = 'off';
    const {runDir,builder} = await fixture(workspace,true);
    const approved = (await readFile(join(runDir,'bus.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).findLast(event=>event.type==='design_review_pass');
    assert.equal(approved.commitReceipt.executionReadiness.executable,true);
    assert.equal(approved.commitReceipt.executionReadiness.sourcePreflight.status,'unavailable');
    process.env.DREAMATIC_HTML_BROWSER = '';
    process.env.DREAMATIC_HTML_BROWSER_EXECUTABLE = '/definitely-not-a-browser';
    process.env.DREAMATIC_HTML_REQUIRE_BROWSER = 'true';
    process.env.DREAMATIC_IMAGE_API_KEY = 'test';
    let calls=0;
    globalThis.fetch = async()=>{calls++;return new Response(JSON.stringify({data:[{b64_json:PNG.toString('base64')}]}));};
    const result=value(await invoke(builder,'execute_design_plan',{runId:'demo'}));
    assert.equal(result.succeeded,3); assert.equal(calls,2);
    const built=await readFile(join(runDir,'artifacts/ui/index.html'));
    await writeFile(join(runDir,'artifacts/ui/index.html'),'Unapproved replacement');
    await assert.rejects(invoke(builder,'build_finalize',{runId:'demo'}),/differs from approved source/);
    await writeFile(join(runDir,'artifacts/ui/index.html'),built);
    const finalized=value(await invoke(builder,'build_finalize',{runId:'demo'}));
    assert.equal(finalized.ok,true);
    const lint=JSON.parse(await readFile(join(runDir,'artifacts/lint-report.json'),'utf8'));
    assert.equal(lint.browser.status,'not_run');
    assert.equal(calls,2);
  } finally {
    globalThis.fetch=originalFetch;
    for(const [key,val] of Object.entries(old)) if(val===undefined) delete process.env[key]; else process.env[key]=val;
    await rm(workspace,{recursive:true,force:true});
  }
});

test('source preflight leaves image-only plans unchanged and preserves unavailable browser policy/repair ownership', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-preflight-runtime-'));
  const oldBrowser = process.env.DREAMATIC_HTML_BROWSER, oldRequired = process.env.DREAMATIC_HTML_REQUIRE_BROWSER;
  try {
    process.env.DREAMATIC_HTML_BROWSER = 'off';
    const {runDir,plan,manifest,designer} = await fixture(workspace);
    assert.equal((await assertHtmlSourcePreflight(runDir,deliveryContract(plan,manifest))).status,'unavailable');
    process.env.DREAMATIC_HTML_REQUIRE_BROWSER = 'true';
    await assert.rejects(assertHtmlSourcePreflight(runDir,deliveryContract(plan,manifest)), error => error.repairOwner === 'runtime');
    const result = value(await invoke(designer,'design_bus_post',{runId:'demo',type:'design_revision_ready',from_agent:'designer',to:'orchestrator',summary:'Revalidate',requestedAction:'Review'}));
    assert.equal(result.repairOwner,'runtime'); assert.equal(result.blocked,true); assert.equal(result.attempts,1);
    assert.equal((await assertHtmlSourcePreflight(runDir,{schemaVersion:1,tasks:[],deliverables:[],presentation:{mode:'gallery',entry:'artifacts/00-gallery.html'}})).status,'not_applicable');
  } finally {
    for (const [key,val] of [['DREAMATIC_HTML_BROWSER',oldBrowser],['DREAMATIC_HTML_REQUIRE_BROWSER',oldRequired]]) if (val === undefined) delete process.env[key]; else process.env[key] = val;
    await rm(workspace,{recursive:true,force:true});
  }
});


test('save completes missing Gallery entry and still reports wrong task ids, unsupported image formats and size limits together without changing prompts', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-publish-fields-'));
  const oldSize = process.env.DREAMATIC_IMAGE_DEFAULT_SIZE;
  try {
    process.env.DREAMATIC_IMAGE_DEFAULT_SIZE = '1024x1024';
    const {runDir,plan,manifest,designer} = await fixture(workspace,true);
    plan.image_generation_plan = structuredClone(plan.execution_plan.filter(task=>task.method!=='html_generate'));
    const prompt = plan.image_generation_plan[0].prompt_seed;
    plan.execution_plan[1] = {deliverable_id:'product',method:'image_generate',scope_id:'product',category:'industrial',size:'1536x1024'};
    manifest.presentation = {mode:'gallery',artifacts:['artifacts/00-gallery.html']};
    manifest.deliverables[1].file = 'artifacts/product.webp';
    const saved = value(await invoke(designer,'write_json',{runId:'demo',path:'plan/design_plan.json',data:plan}));
    const result = value(await invoke(designer,'write_json',{runId:'demo',path:'plan/deliverable_manifest.json',data:manifest}));
    const warnings = result.warnings.join('\n');
    assert.equal(result.normalizedFields['/presentation/entry'],'artifacts/00-gallery.html');
    assert.doesNotMatch(warnings,/presentation.entry/);
    for (const pattern of [/execution_plan\[1\].id/, /prompt_seed/, /must use \.png, \.jpg or \.jpeg/, /exceeds.*1024x1024/]) assert.match(warnings,pattern);
    const contextResult = value(await invoke(designer,'design_context_read',{runId:'demo',audience:'designer'}));
    assert.equal(contextResult.draftReadiness.ok,false);
    assert.equal(contextResult.outputContract.imageSizeCeiling,'1024x1024');
    assert.equal(contextResult.outputContract.presentation.gallery.entry,'artifacts/00-gallery.html');
    const before = await readFile(join(runDir,'bus.jsonl'),'utf8');
    const hashBefore = createHash('sha256').update(await readFile(join(runDir,'plan/design_plan.json'))).digest('hex');
    await assert.rejects(invoke(designer,'design_bus_post',{runId:'demo',type:'design_revision_ready',from_agent:'designer',to:'orchestrator',summary:'Ready'}), /execution_plan\[1\].id/);
    assert.equal(await readFile(join(runDir,'bus.jsonl'),'utf8'),before);
    assert.equal(createHash('sha256').update(await readFile(join(runDir,'plan/design_plan.json'))).digest('hex'),hashBefore);
    assert.equal(JSON.parse(await readFile(join(runDir,'plan/design_plan.json'),'utf8')).image_generation_plan[0].prompt_seed,prompt);
    assert.equal(saved.ok,true);
  } finally { if(oldSize===undefined)delete process.env.DREAMATIC_IMAGE_DEFAULT_SIZE;else process.env.DREAMATIC_IMAGE_DEFAULT_SIZE=oldSize;await rm(workspace,{recursive:true,force:true}); }
});

test('unresolved publication fields keep their failure count through unrelated draft edits and recover after genuine repair', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-unresolved-field-'));
  try {
    const {runDir,plan,manifest,designer} = await fixture(workspace);
    manifest.presentation = {mode:'html',artifacts:['artifacts/ui/index.html']};
    await jsonFile(runDir,'plan/deliverable_manifest.json',manifest);
    const args = {runId:'demo',type:'design_revision_ready',from_agent:'designer',to:'orchestrator',summary:'Ready'};
    await assert.rejects(invoke(designer,'design_bus_post',args),/presentation.entry/);
    plan.design_intent += ' Unrelated description change';
    await invoke(designer,'write_json',{runId:'demo',path:'plan/design_plan.json',data:plan});
    await assert.rejects(invoke(designer,'design_bus_post',args),/presentation.entry/);
    manifest.deliverables[0].purpose += ' Unrelated purpose change';
    await jsonFile(runDir,'plan/deliverable_manifest.json',manifest);
    const blocked = await invoke(designer,'design_bus_post',{...args,summary:'Different envelope',runDir});
    assert.equal(blocked.details.blocked,true);assert.equal(blocked.details.attempts,3);
    assert.equal(specialistCompletionEvent('designer','design_bus_post',false,args,blocked),undefined);
    assert.doesNotMatch(await readFile(join(runDir,'bus.jsonl'),'utf8'),/"type":"design_revision_ready"/);
    manifest.presentation = {mode:'html',entry:'artifacts/ui/index.html'};
    await jsonFile(runDir,'plan/deliverable_manifest.json',manifest);
    const fresh = harness(workspace,'designer').tools;
    for(const skill of plan.skill_selection) await invoke(fresh,'use_skill',{name:skill.name,scopeId:skill.scope_id,role:skill.role});
    const committed = value(await invoke(fresh,'design_bus_post',args));
    assert.equal(committed.ok,true);assert.equal(committed.event.nextAgent,'reviewer');
  } finally {await rm(workspace,{recursive:true,force:true});}
});

test('Designer can attach declared research inputs while canonical design outputs and evidence integrity remain mandatory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-research-publication-'));
  try {
    const {runDir,designer} = await fixture(workspace);
    await jsonFile(runDir,'research/evidence.json',{runId:'demo',official_sources:[],open_questions:[]});
    await writeFile(join(runDir,'research/research-findings.md'),'Verified research findings');
    const args = {runId:'demo',type:'design_revision_ready',from_agent:'designer',to:'orchestrator',summary:'Ready',artifactRefs:['research/evidence.json','research/research-findings.md']};
    const committed = value(await invoke(designer,'design_bus_post',args));
    assert.equal(committed.ok,true);assert.equal(committed.event.nextAgent,'reviewer');
    for(const ref of ['plan/design_plan.json','plan/deliverable_manifest.json','research/evidence.json','research/research-findings.md']) {
      assert.ok(committed.event.artifactRefs.includes(ref));assert.match(committed.event.commitReceipt.files[ref],/^[a-f0-9]{64}$/);
    }
    await assert.rejects(invoke(designer,'write_json',{runId:'demo',path:'research/evidence.json',data:{}}),/Designer|designer|owned|write|Write/);
    await jsonFile(runDir,'research/evidence.json',{runId:'demo',official_sources:[],open_questions:['Changed after Designer approval']});
    const reviewer = harness(workspace,'reviewer').tools;
    await assert.rejects(invoke(reviewer,'design_bus_post',{runId:'demo',type:'design_review_pass',from_agent:'reviewer',to:'orchestrator',summary:'Ready'}),/referenced input changed.*research\/evidence.json/);
  } finally {await rm(workspace,{recursive:true,force:true});}
});

test('legacy image-only publication catches unsupported formats/size mismatch and preserves existing image design capability', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-legacy-image-draft-'));
  const oldSize = process.env.DREAMATIC_IMAGE_DEFAULT_SIZE, originalFetch = globalThis.fetch;
  try {
    process.env.DREAMATIC_IMAGE_DEFAULT_SIZE='1024x1024';
    await init(workspace,[scopes[0]]);
    const runDir = join(workspace,'runs/demo'),designer = harness(workspace,'designer').tools;
    await invoke(designer,'use_skill',{name:'industrial-design',scopeId:'product',role:'primary'});
    const seed='Exact multi-round industrial design prompt';
    const plan={schemaVersion:1,runId:'demo',design_system_ref:'plan/design_system.json',design_intent:'Industrial lattice design',skill_selection:[{scope_id:'product',name:'industrial-design',role:'primary',rationale:'Industrial concept'}],image_generation_plan:[{id:'muscle',method:'image_generate',prompt_seed:seed,negative_prompt_seed:'Watermark',size:'1536x1024',size_rationale:'Concept',acceptance:'Visible lattice'}]};
    const manifest={schemaVersion:1,runId:'demo',design_system_ref:'plan/design_system.json',deliverables:[{id:'muscle',scope_id:'product',category:'industrial',skill_refs:['industrial-design'],method:'image_generate',kind:'concept_render',purpose:'Concept',required:true,acceptance_test:'Visible lattice',file:'artifacts/muscle.webp',size:'1024x1024'}]};
    for(const [path,data] of [['plan/design_system.json',{runId:'demo',system_thesis:'Lattice',palette:{},typography:{}}],['plan/design_plan.json',plan],['plan/deliverable_manifest.json',manifest]]) await invoke(designer,'write_json',{runId:'demo',path,data});
    const args={runId:'demo',type:'design_spec_ready',from_agent:'designer',to:'orchestrator',summary:'Ready'};
    await assert.rejects(invoke(designer,'design_bus_post',args),/must use \.png, \.jpg or \.jpeg/);
    const report=await designerDraftReadiness(runDir);assert.equal(report.ok,false);assert.match(report.issues.join(' '),/exceeds.*1024x1024/);assert.match(report.issues.join(' '),/size must match/);
    plan.image_generation_plan[0].size='1024x1024';manifest.deliverables[0].file='artifacts/muscle.png';
    for(const [path,data] of [['plan/design_plan.json',plan],['plan/deliverable_manifest.json',manifest]]) await invoke(designer,'write_json',{runId:'demo',path,data});
    assert.equal((await designerDraftReadiness(runDir)).ok,true);
    const approved=value(await invoke(designer,'design_bus_post',args));assert.equal(approved.ok,true);
    assert.equal(JSON.parse(await readFile(join(runDir,'plan/design_plan.json'),'utf8')).image_generation_plan[0].prompt_seed,seed);
    await jsonFile(runDir,'review/design-review.json',{runId:'demo',review_stage:'design_context',verdict:'pass',round:1,summary:'Ready',scores:{},issues:[]});
    await writeFile(join(runDir,'review/design-review.md'),'Ready');
    await invoke(harness(workspace,'reviewer').tools,'design_bus_post',{runId:'demo',type:'design_review_pass',from_agent:'reviewer',to:'orchestrator',summary:'Ready'});
    // Simulate genuine old-runtime approvals of the same source with a unsupported WebP filename.
    manifest.deliverables[0].file='artifacts/muscle.webp';await jsonFile(runDir,'plan/deliverable_manifest.json',manifest);
    const bus=(await readFile(join(runDir,'bus.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const hash=createHash('sha256').update(await readFile(join(runDir,'plan/deliverable_manifest.json'))).digest('hex');
    for(const event of bus) if(event.commitReceipt?.files?.['plan/deliverable_manifest.json']) event.commitReceipt.files['plan/deliverable_manifest.json']=hash;
    await writeFile(join(runDir,'bus.jsonl'),bus.map(JSON.stringify).join('\n')+'\n');
    let providerCalls=0;globalThis.fetch=async()=>{providerCalls++;throw new Error('Must not call image provider');};
    const builder=harness(workspace,'builder').tools;
    await assert.rejects(invoke(builder,'execute_image_plan',{runId:'demo',ids:['muscle']}),error=>error.repairOwner==='designer'&&/must use \.png, \.jpg or \.jpeg/.test(error.issues.join(' ')));
    await assert.rejects(invoke(builder,'image_generate',{runId:'demo',id:'muscle',intent:'Approved muscle',prompt:seed,acceptanceCriteria:['Visible lattice']}),/must use \.png, \.jpg or \.jpeg/);
    const blocked=value(await invoke(harness(workspace).tools,'spawn_agent',{runId:'demo',agent:'builder',task:'Build'}, {...context,model:{id:'test',provider:'test',api:'openai-completions'}}));
    assert.equal(blocked.blocked,true);assert.equal(blocked.repairOwner,'designer');assert.equal(providerCalls,0);
    // A reviewer can still publish a failed review to route the old invalid specification back to Designer.
    await jsonFile(runDir,'review/design-review.json',{runId:'demo',review_stage:'design_context',verdict:'fail',round:2,summary:'Repair image filenames',scores:{},issues:[{id:'png-path',severity:'blocking',status:'open',owner:'designer'}]});
    const failedReview=value(await invoke(harness(workspace,'reviewer').tools,'design_bus_post',{runId:'demo',type:'design_review_fail',from_agent:'reviewer',to:'orchestrator',summary:'Repair image filenames'}));
    assert.equal(failedReview.ok,true);assert.equal(failedReview.event.type,'design_review_fail');

  } finally {globalThis.fetch=originalFetch;if(oldSize===undefined)delete process.env.DREAMATIC_IMAGE_DEFAULT_SIZE;else process.env.DREAMATIC_IMAGE_DEFAULT_SIZE=oldSize;await rm(workspace,{recursive:true,force:true});}
});


test('first Gallery manifest save fills the runtime-owned entry before the plan exists and binds the actual saved hash', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-gallery-default-'));
  try {
    await init(workspace, [scopes[0]]);
    const {tools} = harness(workspace, 'designer');
    const path = 'plan/deliverable_manifest.json';
    const draft = {schemaVersion:2,presentation:{mode:'gallery',artifacts:['artifacts/00-gallery.html']},deliverables:[{id:'product',method:'image_generate',kind:'image',file:'artifacts/product.png'}]};
    const result = value(await invoke(tools,'write_json',{runId:'demo',path,data:draft}));
    const source = await readFile(join(workspace,'runs/demo',path));
    assert.equal(result.sha256,createHash('sha256').update(source).digest('hex'));
    assert.deepEqual(result.normalizedFields,{'/presentation/entry':'artifacts/00-gallery.html'});
    assert.equal(JSON.parse(source).presentation.entry,'artifacts/00-gallery.html');
    assert.equal(result.warnings,undefined); // Completion does not depend on saving plan first.
    const patched = value(await invoke(tools,'patch_json',{runId:'demo',path,sha256:result.sha256,updates:[{pointer:'/presentation',value:{mode:'gallery'}}]}));
    assert.equal(patched.normalizedFields['/presentation/entry'],'artifacts/00-gallery.html');
    assert.equal(patched.sha256,createHash('sha256').update(await readFile(join(workspace,'runs/demo',path))).digest('hex'));
  } finally {await rm(workspace,{recursive:true,force:true});}
});

test('pure image defaults preserve image payloads and legacy manifests while HTML uses the declared main page', () => {
  const image = {schemaVersion:2,deliverables:[{method:'image_generate',file:'artifacts/01.png',prompt_seed:'Exact tuned image prompt'}]};
  assert.deepEqual(normalizeDraftPresentation(image),{normalizedFields:{'/presentation/mode':'gallery','/presentation/entry':'artifacts/00-gallery.html'},issues:[]});
  assert.deepEqual(image.presentation,{mode:'gallery',entry:'artifacts/00-gallery.html'});
  assert.equal(image.deliverables[0].prompt_seed,'Exact tuned image prompt');
  const legacy = {schemaVersion:1,deliverables:structuredClone(image.deliverables)};
  const before = JSON.stringify(legacy);
  assert.deepEqual(normalizeDraftPresentation(legacy),{normalizedFields:{},issues:[]});
  assert.equal(JSON.stringify(legacy),before);
  const page = {schemaVersion:2,deliverables:[{method:'html_generate',kind:'html_page',file:'artifacts/custom/start.html'}]};
  assert.equal(normalizeDraftPresentation(page).issues.length,0);
  assert.deepEqual(page.presentation,{mode:'html',entry:'artifacts/custom/start.html'}); // No invented index.html or file-order guess.
  assert.deepEqual(normalizeDraftPresentation(page),{normalizedFields:{},issues:[]}); // Idempotent saves.
});

test('initial UX specification without presentation publishes once, retains its main page, and finalizes with immutable approval hashes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-ux-default-'));
  try {
    // This task includes index + details HTML pages; its sole deliverable declares index as the main page.
    const {runDir,plan,manifest,builder} = await fixture(workspace,false,{omitPresentation:true});
    const bus = (await readFile(join(runDir,'bus.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const designs = bus.filter(event=>event.type==='design_spec_ready');
    assert.equal(designs.length,1);
    const source = await readFile(join(runDir,'plan/deliverable_manifest.json'));
    assert.deepEqual(JSON.parse(source).presentation,{mode:'html',entry:'artifacts/ui/index.html'});
    assert.equal(designs[0].commitReceipt.files['plan/deliverable_manifest.json'],createHash('sha256').update(source).digest('hex'));
    const contract = deliveryContract(plan,manifest);
    assert.equal(contract.presentation.entry,manifest.deliverables[0].file);
    // Directly corrupting an approved manifest never triggers completion or receipt rewriting on read/build.
    const corruptManifest=structuredClone(manifest);
    delete corruptManifest.presentation.entry;
    await jsonFile(runDir,'plan/deliverable_manifest.json',corruptManifest);
    const corruptSource = await readFile(join(runDir,'plan/deliverable_manifest.json'),'utf8');
    await assert.rejects(invoke(builder,'execute_design_plan',{runId:'demo'}),/changed|receipt|approval|presentation.entry/i);
    assert.equal(await readFile(join(runDir,'plan/deliverable_manifest.json'),'utf8'),corruptSource);
    await writeFile(join(runDir,'plan/deliverable_manifest.json'),source);
    const built = value(await invoke(builder,'execute_design_plan',{runId:'demo'}));
    assert.equal(built.ok,true);assert.equal(built.deliveryComplete,true);
    assert.equal(value(await invoke(builder,'build_finalize',{runId:'demo'})).ok,true);
    const artifacts = JSON.parse(await readFile(join(runDir,'artifacts/artifact-manifest.json'),'utf8'));
    assert.deepEqual(artifacts.presentation,contract.presentation);
    assert.equal(await readFile(join(runDir,'plan/deliverable_manifest.json'),'utf8'),source.toString());
    await assert.rejects(readFile(join(runDir,'artifacts/00-gallery.html')),/ENOENT/);

  } finally {await rm(workspace,{recursive:true,force:true});}
});

test('mixed Gallery specification omitting entry publishes on its first attempt without choosing a UX page', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-mixed-gallery-default-'));
  try {
    const {runDir,manifest} = await fixture(workspace,true,{gallery:true,omitPresentationEntry:true});
    assert.deepEqual(manifest.presentation,{mode:'gallery',entry:'artifacts/00-gallery.html'});
    const bus = (await readFile(join(runDir,'bus.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(bus.filter(event=>event.type==='design_spec_ready').length,1);
    assert.equal(bus.some(event=>event.type==='designer_recovery_required'),false);
  } finally {await rm(workspace,{recursive:true,force:true});}
});

test('ambiguous presentation choices are surfaced on the first save and an explicit choice can be patched using the returned hash', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-presentation-choice-'));
  try {
    await init(workspace,[scopes[1]]);
    const {tools} = harness(workspace,'designer');
    const path = 'plan/deliverable_manifest.json';
    const draft = {schemaVersion:2,deliverables:[{id:'one',method:'html_generate',kind:'html_page',file:'artifacts/one.html'},{id:'two',method:'html_generate',kind:'html_page',file:'artifacts/two.html',required:false}]};
    const saved = value(await invoke(tools,'write_json',{runId:'demo',path,data:draft}));
    assert.match(saved.warnings.join(' '),/presentation.entry.*2 HTML deliverables/);
    assert.equal(saved.normalizedFields['/presentation/mode'],'html');
    assert.equal(JSON.parse(await readFile(join(workspace,'runs/demo',path))).presentation.entry,undefined);
    const patched = value(await invoke(tools,'patch_json',{runId:'demo',path,sha256:saved.sha256,updates:[{pointer:'/presentation/entry',value:'artifacts/two.html'}]}));
    assert.equal(patched.warnings,undefined);
    assert.equal(JSON.parse(await readFile(join(workspace,'runs/demo',path))).presentation.entry,'artifacts/two.html');
    const mixed = {schemaVersion:2,deliverables:[draft.deliverables[0],{method:'image_generate',file:'artifacts/hero.png'}]};
    assert.match(normalizeDraftPresentation(mixed).issues.join(' '),/presentation.mode.*explicit/);
    assert.equal(mixed.presentation,undefined);
    // An explicit mixed HTML presentation can derive its sole declared main page.
    mixed.presentation={mode:'html',artifacts:['artifacts/unrelated.html']};
    assert.equal(normalizeDraftPresentation(mixed).issues.length,0);
    assert.equal(mixed.presentation.entry,'artifacts/one.html');
    const manual={schemaVersion:2,deliverables:[{method:'manual',file:'artifacts/manual.html'}]};
    assert.match(normalizeDraftPresentation(manual).issues.join(' '),/explicit/);
    assert.equal(manual.presentation,undefined);
  } finally {await rm(workspace,{recursive:true,force:true});}
});

test('explicit invalid or alternate presentation entries are preserved rather than silently replaced', () => {
  for (const entry of ['',null,'../outside.html','artifacts/../outside.html','artifacts/page.png','artifacts/custom-gallery.html']) {
    const draft={schemaVersion:2,presentation:{mode:'gallery',entry},deliverables:[{method:'image_generate',file:'artifacts/product.png'}]};
    const result=normalizeDraftPresentation(draft);
    assert.ok(result.issues.length);
    assert.deepEqual(result.normalizedFields,{});
    assert.equal(draft.presentation.entry,entry);
  }
  const explicit={schemaVersion:2,presentation:{mode:'html',entry:'artifacts/two.html'},deliverables:[{method:'html_generate',kind:'html_page',file:'artifacts/one.html'},{method:'html_generate',kind:'html_page',file:'artifacts/two.html'}]};
  assert.deepEqual(normalizeDraftPresentation(explicit),{normalizedFields:{},issues:[]});
  assert.equal(explicit.presentation.entry,'artifacts/two.html');
});

test('native Designer JSON writes share deterministic entry completion and block ambiguous choices before writing', async () => {
  const workspace=await mkdtemp(join(tmpdir(),'dreamatic-native-presentation-'));
  try {
    await init(workspace,[scopes[0]]);
    const {handlers}=harness(workspace,'designer');
    const draft={schemaVersion:2,presentation:{mode:'gallery',artifacts:['artifacts/00-gallery.html']},deliverables:[{method:'image_generate',file:'artifacts/product.png'}]};
    const input={path:'plan/deliverable_manifest.json',content:JSON.stringify(draft)};
    assert.equal(await handlers.get('tool_call')({toolName:'write',input},context),undefined);
    assert.equal(JSON.parse(input.content).presentation.entry,'artifacts/00-gallery.html');
    await createWriteTool(cwd).execute('write',input,undefined,undefined,context);
    const source=await readFile(input.path,'utf8');
    const ambiguous={schemaVersion:2,deliverables:[{method:'html_generate',kind:'html_page',file:'artifacts/page.html'},{method:'image_generate',file:'artifacts/hero.png'}]};
    const rejected=await handlers.get('tool_call')({toolName:'write',input:{path:'plan/deliverable_manifest.json',content:JSON.stringify(ambiguous)}},context);
    assert.equal(rejected.block,true);assert.match(rejected.reason,/explicit.*presentation choice/);
    assert.equal(await readFile(input.path,'utf8'),source);
    const wrongRole=await handlers.get('tool_call')({toolName:'write',input:{path:'research/evidence.json',content:JSON.stringify(draft)}},context);
    assert.equal(wrongRole.block,true);
  } finally {await rm(workspace,{recursive:true,force:true});}
});


test('the first approved JPEG design executes at its exact path, preserves approval bytes and reuses encoded images', async () => {
  const workspace=await mkdtemp(join(tmpdir(),'dreamatic-approved-jpeg-'));
  const oldFetch=globalThis.fetch,oldKey=process.env.DREAMATIC_IMAGE_API_KEY;
  try {
    const {runDir,builder,manifest}=await fixture(workspace,true,{imageExtension:'.jpg'});
    const approved=await readFile(join(runDir,'plan/deliverable_manifest.json'));
    let requests=0;process.env.DREAMATIC_IMAGE_API_KEY='test';
    globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({data:[{b64_json:PNG.toString('base64')}]}));};
    assert.equal(value(await invoke(builder,'execute_design_plan',{runId:'demo'})).ok,true);
    assert.equal(requests,2);
    for(const item of manifest.deliverables.filter(item=>item.method==='image_generate')) {
      assert.equal(imageEncoding(await readFile(join(runDir,item.file))),'jpeg');
      const sidecar=JSON.parse(await readFile(join(runDir,item.file+'.json'),'utf8'));
      assert.equal(sidecar.mimeType,'image/jpeg');assert.equal(sidecar.encoding.converted,true);
    }
    assert.equal(value(await invoke(builder,'execute_design_plan',{runId:'demo'})).ok,true);assert.equal(requests,2);
    const original=await readFile(join(runDir,'artifacts/campaign.jpg'));
    await writeFile(join(runDir,'artifacts/campaign.jpg'),PNG);
    await assert.rejects(finalizeDelivery(runDir,'demo'),error=>error.repairOwner==='runtime'&&/encoding/.test(error.message));
    await writeFile(join(runDir,'artifacts/campaign.jpg'),original);
    assert.equal(value(await invoke(builder,'build_finalize',{runId:'demo'})).ok,true);
    assert.deepEqual(await readFile(join(runDir,'plan/deliverable_manifest.json')),approved);
    const metadata=JSON.parse(await readFile(join(runDir,'artifacts/artifact-manifest.json'),'utf8'));
    assert.equal(metadata.artifacts.find(item=>item.path==='artifacts/product.jpg').mimeType,'image/jpeg');
    assert.deepEqual(await readFile(join(runDir,'artifacts/ui/product.jpg')),await readFile(join(runDir,'artifacts/product.jpg')));
  } finally {globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.DREAMATIC_IMAGE_API_KEY;else process.env.DREAMATIC_IMAGE_API_KEY=oldKey;await rm(workspace,{recursive:true,force:true});}
});

test('Builder raw image tools derive planned paths by id and reject invented paths or modified approvals before calling a provider', async () => {
  const workspace=await mkdtemp(join(tmpdir(),'dreamatic-bound-image-path-'));
  const oldFetch=globalThis.fetch,oldKey=process.env.DREAMATIC_IMAGE_API_KEY;
  try {
    const {runDir,builder,manifest}=await fixture(workspace,true,{imageExtension:'.jpeg'});
    process.env.DREAMATIC_IMAGE_API_KEY='test';let requests=0;
    globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({data:[{b64_json:PNG.toString('base64')}]}));};
    const task={id:'product',intent:'Approved product',prompt:'Approved product',acceptanceCriteria:['Exists']};
    const batch=value(await invoke(builder,'image_generate_batch',{runId:'demo',tasks:[task]}));
    assert.equal(batch.results[0].path,'runs/demo/artifacts/product.jpeg');
    assert.equal(imageEncoding(await readFile(join(runDir,'artifacts/product.jpeg'))),'jpeg');
    await assert.rejects(invoke(builder,'image_generate',{runId:'demo',...task,outputPath:'artifacts/renamed.png'}),/conflicts.*declared file/);
    await assert.rejects(invoke(builder,'image_generate',{runId:'demo',...task,id:'invented'}),/Unknown approved/);
    assert.equal(requests,1);
    manifest.deliverables.find(item=>item.id==='campaign').file='artifacts/campaign-other.jpg';
    await jsonFile(runDir,'plan/deliverable_manifest.json',manifest);
    await assert.rejects(invoke(builder,'image_generate',{runId:'demo',...task,id:'campaign'}),/changed.*committed|receipt/i);
    assert.equal(requests,1);
  } finally {globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.DREAMATIC_IMAGE_API_KEY;else process.env.DREAMATIC_IMAGE_API_KEY=oldKey;await rm(workspace,{recursive:true,force:true});}
});


test('lazy/offscreen and fallback images with empty resources fail publication and Reviewer approval without a browser', async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'dreamatic-resource-closure-'));
  const old=process.env.DREAMATIC_HTML_BROWSER;
  try {
    process.env.DREAMATIC_HTML_BROWSER='off';
    const {runDir,plan,manifest,designer}=await fixture(workspace);
    const source=join(runDir,'plan/html/ui/index.html');
    await writeFile(source,(await readFile(source,'utf8')).replace('</body>', '<img loading="lazy" src="images/example.png" onerror="this.style.display=\'none\'"></body>'));
    const issues=await lintHtmlSourceDependencies(runDir,deliveryContract(plan,manifest));
    assert.ok(issues.some(issue=>issue.includes('images/example.png')&&issue.includes('producer dependency')));
    const before=await readFile(join(runDir,'bus.jsonl'),'utf8');
    await assert.rejects(invoke(designer,'design_bus_post',{runId:'demo',type:'design_revision_ready',from_agent:'designer',to:'orchestrator',summary:'Ready',requestedAction:'Review'}),/undeclared local reference images\/example.png/);
    assert.equal(await readFile(join(runDir,'bus.jsonl'),'utf8'),before);
    // Simulate a receipt made by the previous permissive runtime: reviewer still validates executability.
    const events=before.trim().split('\n').map(JSON.parse);
    const hash=createHash('sha256').update(await readFile(source)).digest('hex');
    for(const event of events) if(event.commitReceipt?.files?.['plan/html/ui/index.html']) event.commitReceipt.files['plan/html/ui/index.html']=hash;
    await writeFile(join(runDir,'bus.jsonl'),events.map(JSON.stringify).join('\n')+'\n');
    await assert.rejects(invoke(harness(workspace,'reviewer').tools,'design_bus_post',{runId:'demo',type:'design_review_pass',from_agent:'reviewer',to:'orchestrator',summary:'Ready',requestedAction:'Build'}),/undeclared local reference/);
    assert.equal((await readFile(join(runDir,'bus.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(event=>event.type==='design_review_pass').length,1);
    await assert.rejects(readFile(join(runDir,'artifacts/ui/index.html')),/ENOENT/);
  }finally{if(old===undefined)delete process.env.DREAMATIC_HTML_BROWSER;else process.env.DREAMATIC_HTML_BROWSER=old;await rm(workspace,{recursive:true,force:true});}
});

test('research assets cannot be embedded directly, while declared generated image dependencies remain executable',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'dreamatic-generated-assets-'));
  try {
    const {runDir,plan,manifest,page,designer}=await fixture(workspace,true);
    const source=join(runDir,'research/assets/reference.png');await mkdir(join(source,'..'),{recursive:true});await writeFile(source,PNG);
    const resources=page.resources;
    page.resources=[{source:'research/assets/reference.png',output:'artifacts/ui/product.png'}];
    assert.throws(()=>htmlTask(page),/reference-only.*image_generate\/image_edit/);
    const before=await readFile(join(runDir,'bus.jsonl'),'utf8');
    await invoke(designer,'write_json',{runId:'demo',path:'plan/design_plan.json',data:plan});
    await assert.rejects(invoke(designer,'design_bus_post',{runId:'demo',type:'design_revision_ready',from_agent:'designer',to:'orchestrator',summary:'Use reference',requestedAction:'Review'}),/reference-only/);
    assert.equal(await readFile(join(runDir,'bus.jsonl'),'utf8'),before);
    page.resources=resources;
    await validateDeliveryContract(runDir,deliveryContract(plan,manifest));
    assert.deepEqual(await lintHtmlSourceDependencies(runDir,deliveryContract(plan,manifest)),[]);
    page.dependencies=[];
    await assert.rejects(validateDeliveryContract(runDir,deliveryContract(plan,manifest)),/producing task in dependencies/);
  }finally{await rm(workspace,{recursive:true,force:true});}
});

test('UX page assets are designed as generated tasks, approved for executability and built before the page',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'dreamatic-ux-generated-'));
  const oldBrowser=process.env.DREAMATIC_HTML_BROWSER,oldKey=process.env.DREAMATIC_IMAGE_API_KEY,oldFetch=globalThis.fetch;
  try {
    process.env.DREAMATIC_HTML_BROWSER='off';process.env.DREAMATIC_IMAGE_API_KEY='test';
    const {runDir,plan,manifest,page,designer,builder}=await fixture(workspace);
    await invoke(designer,'use_skill',{name:'image-prompting',scopeId:'ui',role:'supporting'});
    plan.skill_selection.push({scope_id:'ui',name:'image-prompting',role:'supporting',rationale:'Design the homepage hero asset'});
    plan.execution_plan.push({id:'hero',scope_id:'ui',category:'ux',method:'image_generate',prompt_seed:'Original homepage hero inspired by researched scientific structure',negative_prompt_seed:'Watermark',size:'1024x1024',size_rationale:'Page hero image',acceptance_test:'Original intended hero composition'});
    manifest.deliverables.push({id:'hero',scope_id:'ui',category:'ux',skill_refs:['ui-web-design','image-prompting'],kind:'image',purpose:'Page hero',acceptance_test:'Original intended hero composition',required:true,method:'image_generate',file:'artifacts/hero.png',size:'1024x1024'});
    page.dependencies=['hero'];page.resources=[{source:'artifacts/hero.png',output:'artifacts/ui/images/hero.png'}];
    const source=join(runDir,'plan/html/ui/index.html');
    await writeFile(source,(await readFile(source,'utf8')).replace('</body>','<img src="images/hero.png" alt="Designed hero"></body>'));
    await invoke(designer,'write_json',{runId:'demo',path:'plan/design_plan.json',data:plan});
    await invoke(designer,'write_json',{runId:'demo',path:'plan/deliverable_manifest.json',data:manifest});
    await invoke(designer,'design_bus_post',{runId:'demo',type:'design_revision_ready',from_agent:'designer',to:'orchestrator',summary:'Designed page asset',requestedAction:'Review'});
    await invoke(harness(workspace,'reviewer').tools,'design_bus_post',{runId:'demo',type:'design_review_pass',from_agent:'reviewer',to:'orchestrator',summary:'Executable page and hero approved',requestedAction:'Build'});
    const prompts=[];
    globalThis.fetch=async(_url,input)=>{prompts.push(JSON.parse(input.body).prompt);return new Response(JSON.stringify({data:[{b64_json:PNG.toString('base64')}]}));};
    const result=value(await invoke(builder,'execute_design_plan',{runId:'demo'}));
    assert.equal(result.deliveryComplete,true);assert.equal(result.succeeded,2);
    assert.deepEqual(prompts,['Original homepage hero inspired by researched scientific structure\n\nAvoid: Watermark']);
    assert.ok((await readFile(join(runDir,'artifacts/ui/images/hero.png'))).equals(PNG));
    assert.ok((await readFile(join(runDir,'artifacts/ui/index.html'))).equals(await readFile(source)));
    assert.equal(value(await invoke(builder,'build_finalize',{runId:'demo'})).ok,true);
  }finally{globalThis.fetch=oldFetch;for(const[key,val]of[['DREAMATIC_HTML_BROWSER',oldBrowser],['DREAMATIC_IMAGE_API_KEY',oldKey]])if(val===undefined)delete process.env[key];else process.env[key]=val;await rm(workspace,{recursive:true,force:true});}
});


test('explicit uploaded originals pass Designer and Reviewer receipts and Builder copies without generation',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'dreamatic-user-material-workflow-'));
  const oldBrowser=process.env.DREAMATIC_HTML_BROWSER,oldFetch=globalThis.fetch;
  try {
    process.env.DREAMATIC_HTML_BROWSER='off';
    const {runDir,plan,page,designer,builder}=await fixture(workspace);
    const {prepareDreamaticPrompt}=await import('../dist/prompt.js');
    const {recordUserMaterialSources}=await import('../dist/user-assets.js');
    const upload=await prepareDreamaticPrompt({workspaceDir:workspace,scopeId:'web-demo',text:'Use this exact logo',images:[{type:'image',name:'logo.png',mimeType:'image/png',data:PNG.toString('base64')}]});
    await recordUserMaterialSources(runDir,[upload.text]);
    const imported=value(await invoke(designer,'user_asset_import',{runId:'demo',source:upload.references[0].path}));
    assert.ok(imported.filePath.startsWith(runDir));
    page.resources=[{source:imported.source,output:'artifacts/ui/assets/logo.png'}];
    const source=join(runDir,'plan/html/ui/index.html');
    await writeFile(source,(await readFile(source,'utf8')).replace('</body>','<img loading="lazy" src="assets/logo.png" alt="User logo"></body>'));
    await invoke(designer,'write_json',{runId:'demo',path:'plan/design_plan.json',data:plan});
    await invoke(designer,'design_bus_post',{runId:'demo',type:'design_revision_ready',from_agent:'designer',to:'orchestrator',summary:'Use approved uploaded original',requestedAction:'Review'});
    await invoke(harness(workspace,'reviewer').tools,'design_bus_post',{runId:'demo',type:'design_review_pass',from_agent:'reviewer',to:'orchestrator',summary:'Original provenance and output mapping approved',requestedAction:'Build'});
    const events=(await readFile(join(runDir,'bus.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const receipt=events.findLast(item=>item.type==='design_review_pass').commitReceipt.files;
    assert.equal(receipt[imported.source],imported.sha256);
    assert.ok(receipt['.performance/user-materials.json']);
    globalThis.fetch=async()=>{throw new Error('Copying user material must not call generation/download APIs')};
    const result=value(await invoke(builder,'execute_design_plan',{runId:'demo'}));
    assert.equal(result.deliveryComplete,true);assert.equal(result.succeeded,1);
    assert.deepEqual(await readFile(join(runDir,'artifacts/ui/assets/logo.png')),PNG);
    assert.equal(value(await invoke(builder,'build_finalize',{runId:'demo'})).ok,true);
  }finally{globalThis.fetch=oldFetch;if(oldBrowser===undefined)delete process.env.DREAMATIC_HTML_BROWSER;else process.env.DREAMATIC_HTML_BROWSER=oldBrowser;await rm(workspace,{recursive:true,force:true});}
});

test('root user input supplies import permission, Orchestrator summaries and specialist requests do not',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'dreamatic-user-source-binding-'));
  try {
    const root=harness(workspace);
    await root.handlers.get('before_agent_start')({prompt:'Use https://93.184.216.34/user-logo.png',systemPrompt:''});
    await invoke(root.tools,'run_init',{runIdOverride:'demo',projectTitle:'User Assets',brief:'Research https://93.184.216.34/research.png',designScopes:[scopes[1]]});
    const {userMaterialInventory}=await import('../dist/user-assets.js');
    const inventory=await userMaterialInventory(join(workspace,'runs/demo'));
    assert.deepEqual(inventory.sources,['https://93.184.216.34/user-logo.png']);
    await assert.rejects(invoke(harness(workspace,'designer').tools,'user_asset_import',{runId:'demo',source:'https://93.184.216.34/research.png'}),/not explicitly user-provided/);
  }finally{await rm(workspace,{recursive:true,force:true});}
});


test('image edits use one approval/execution contract and reject unchanged reuse', async () => {
  const valid = { id: 'detail', referenceImagePaths: ['research/assets/source.png'], diagnosis: ['User requested a headline revision'], changes: ['Replace the headline with approved copy'], preserve: ['Composition'] };
  assert.deepEqual(approvedImageEdit(valid).changes, valid.changes);
  assert.doesNotThrow(() => approvedImageEdit({ ...valid, changes: ['Change background while keeping the subject unchanged'] }));
  assert.doesNotThrow(() => approvedImageEdit({ ...valid, changes: ['Keep the subject unchanged', 'Replace the headline with approved copy'] }));
  for (const field of ['referenceImagePaths', 'diagnosis', 'changes', 'preserve']) {
    const missing = { ...valid }; delete missing[field];
    assert.throws(() => approvedImageEdit(missing), new RegExp(field));
  }
  assert.throws(() => approvedImageEdit({ ...valid, referenceImagePaths: undefined, reference_ids_or_paths: valid.referenceImagePaths }), /provenance only/);
  for (const change of ['Retain original image without visual modification', 'Copy the original unchanged', '原样复制图片'])
    assert.throws(() => approvedImageEdit({ ...valid, changes: [change] }), /unchanged reuse/);
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-edit-readiness-'));
  try {
    const { plan, manifest, runDir } = await fixture(workspace, true);
    const image = plan.execution_plan.find(task => task.method === 'image_generate');
    image.method = 'image_edit';
    manifest.deliverables.find(item => item.id === image.id).method = 'image_edit';
    await jsonFile(runDir, 'plan/design_plan.json', plan);
    await jsonFile(runDir, 'plan/deliverable_manifest.json', manifest);
    assert.equal((await designerDraftReadiness(runDir)).ok, false);
    await assert.rejects(validateDeliveryContract(runDir, deliveryContract(plan, manifest)), /referenceImagePaths/);
    Object.assign(image, valid, { id: image.id, referenceImagePaths: ['research/assets/missing.png'] });
    await assert.rejects(validateDeliveryContract(runDir, deliveryContract(plan, manifest)), /ENOENT/);
    await mkdir(join(runDir, 'research/assets'), { recursive: true });
    await writeFile(join(runDir, 'research/assets/source.png'), PNG);
    image.referenceImagePaths = ['research/assets/source.png'];
    await validateDeliveryContract(runDir, deliveryContract(plan, manifest));
    image.changes = ['Retain original image without visual modification'];
    await assert.rejects(validateDeliveryContract(runDir, deliveryContract(plan, manifest)), /unchanged reuse/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('non-UX primary scopes cannot replace design imagery with a manual document or HTML showcase', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-domain-routing-'));
  const old = process.env.DREAMATIC_HTML_BROWSER;
  try {
    process.env.DREAMATIC_HTML_BROWSER = 'off';
    const { runDir, plan, manifest } = await fixture(workspace, true);
    for (const method of ['manual', 'html_generate']) {
      const changed = structuredClone(manifest);
      changed.deliverables.find(item=>item.scope_id==='product').method = method;
      await assert.rejects(validateDesignScopes(runDir, plan, changed), /Non-UX scope product requires design imagery/);
    }
  } finally {
    if (old === undefined) delete process.env.DREAMATIC_HTML_BROWSER; else process.env.DREAMATIC_HTML_BROWSER = old;
    await rm(workspace,{recursive:true,force:true});
  }
});
