import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDreamaticExtension } from '../dist/extension.js';
import { contextProjections } from '../dist/context-model.js';
import { prepareContextChanges } from '../dist/context-tools.js';
import { deliveryContract, htmlTask } from '../dist/design-contract.js';
import { assertHtmlSourcePreflight } from '../dist/html-preflight.js';
import { checkHtmlBrowser } from '../dist/html-delivery.js';
import { dreamaticSessionFailure } from '../dist/session-status.js';
import { isRetryableError, withRetry } from '../dist/retry.js';
import { modelRecoveryTask, providerRequestSummary } from '../dist/model-response-policy.js';
import { upgradeDesignData } from '../dist/design-context-v2.js';

const cwd = fileURLToPath(new URL('../../..', import.meta.url));
function harness(workspaceDir, agent) {
  const tools = new Map();
  createDreamaticExtension({ workspaceDir, ...(agent ? { parentInvocation: { id: agent, agent, runId: 'demo' } } : {}) })({ registerTool: tool => tools.set(tool.name, tool), on() {} });
  return { tools, async call(name, args = {}) {
    const tool = tools.get(name);
    const result = await tool.execute(name, tool.prepareArguments ? tool.prepareArguments(args) : args, undefined, undefined, { cwd });
    return name === 'use_skill' ? result : JSON.parse(result.content[0].text);
  } };
}
const page = { id: 'page', scope_id: 'ui', skill_refs: ['ui-web-design'], file: 'artifacts/ui/index.html', kind: 'html_page', purpose: 'Present concept', acceptance_test: 'Title readable', required: true, user_requested: true, presentation: { required: true, access: 'embed' }, execution: { method: 'html_generate', files: [{ source: 'plan/html/ui/index.html', output: 'artifacts/ui/index.html' }], resources: [], interaction_requirements: [], interaction_checks: [] } };
const document = () => ({ schemaVersion: 2, runId: 'demo', revision: 1, system: { system_thesis: 'A clear concept', palette: {}, typography: {} }, strategy: { design_intent: 'Show the concept' }, deliverables: [structuredClone(page)], presentation: { mode: 'html', entry: page.file } });
const contractOf = data => { const views = contextProjections('context/design.json', data, 'demo'); return deliveryContract(JSON.parse(views['plan/design_plan.json']), JSON.parse(views['plan/deliverable_manifest.json'])); };
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Concept</title></head><body><h1>Concept</h1></body></html>';

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-contract-v2-'));
  const root = harness(workspace);
  await root.call('run_init', { runIdOverride: 'demo', projectTitle: 'Clear concept', brief: 'Present the concept', designScopes: [{ id: 'ui', category: 'ux', task: 'Concept page' }, { id: 'campaign', category: 'media_communication', task: 'Concept communication' }] });
  const runDir = join(workspace, 'runs/demo');
  await mkdir(join(runDir, 'plan/html/ui'), { recursive: true });
  await writeFile(join(runDir, 'plan/html/ui/index.html'), html);
  return { workspace, root, runDir };
}

test('new Run authoring owns one deliverable; scoped multi-bind reads one body and commit derives task views', async () => {
  const { workspace, runDir, root } = await fixture();
  try {
    assert.equal(JSON.parse(await readFile(join(runDir, 'brief.json'))).designContractVersion, 2);
    const designer = harness(workspace, 'designer');
    const bound = await designer.call('use_skill', { name: 'image-prompting', bindings: [{ scopeId: 'ui', role: 'supporting', rationale: 'UI imagery' }, { scopeId: 'campaign', role: 'supporting', rationale: 'Campaign imagery' }] });
    assert.equal(bound.details.bindings.length, 2);
    assert.equal(bound.details.reused, false);
    const reused = await designer.call('use_skill', { name: 'image-prompting', bindings: [{ scopeId: 'campaign', role: 'supporting', rationale: 'Campaign detail' }] });
    assert.equal(reused.details.reused, true);
    const before = await readFile(join(runDir, '.performance/skills-designer.json'));
    await assert.rejects(designer.call('use_skill', { name: 'image-prompting', bindings: [{ scopeId: 'ui', role: 'supporting', rationale: 'Valid' }, { scopeId: 'foreign', role: 'supporting', rationale: 'Invalid' }] }), /Unknown assigned scope/);
    assert.deepEqual(await readFile(join(runDir, '.performance/skills-designer.json')), before);
    await designer.call('use_skill', { name: 'ui-web-design', scopeId: 'ui', role: 'primary', rationale: 'Concept page hierarchy' });
    await designer.call('use_skill', { name: 'information-design', scopeId: 'campaign', role: 'primary', rationale: 'Communicate the concept' });
    const { schemaVersion, runId, revision, ...data } = document();
    data.deliverables[0].contributing_scopes = [{ scope_id: 'campaign', skill_refs: ['information-design'], purpose: 'Information hierarchy' }];
    const result = await designer.call('update_design_context', { changes: data });
    assert.equal(result.readiness, 'ready', JSON.stringify(result));
    const committed = await designer.call('commit_design_context');
    assert.equal(committed.committed, true, JSON.stringify(committed));
    const source = JSON.parse(await readFile(join(runDir, 'context/design.json')));
    assert.equal(source.schemaVersion, 2); assert.equal('tasks' in source, false);
    assert.equal(source.deliverables[0].execution.id, undefined);
    const reviewer = harness(workspace, 'reviewer');
    const detail = await reviewer.call('design_context_read', { audience: 'reviewer', paths: ['context/design.json'], select: { section: 'tasks', ids: ['page'] } });
    assert.equal(JSON.parse(detail.files[0].content).tasks[0].scope_id, 'ui');
    const protocol = await designer.call('design_context_read', { audience: 'designer' });
    assert.equal(protocol.outputContract.storage.schemaVersion, 2);
    assert.equal(protocol.outputContract.storage.fields.includes('tasks'), false);
    const validation = await designer.call('design_context_validate');
    assert.equal(validation.ok, true, JSON.stringify(validation));
    assert.equal(validation.executionValidation.status, 'completed');
    // Exercise the real Dreamatic gates, not only projection helpers.
    await mkdir(join(runDir, 'research/assets'), { recursive: true });
    await writeFile(join(runDir, 'research/assets/manifest.json'), JSON.stringify({ runId: 'demo', assets: [] }));
    const researcher = harness(workspace, 'researcher');
    await researcher.call('update_design_context', { changes: { evidence: { target: 'Concept page', summary: 'No source claims required', official_sources: [], open_questions: [] }, findings: 'Original concept without factual claims', usageConditions: 'No external assets' } });
    await researcher.call('commit_design_context');
    await researcher.call('design_bus_post', { runId: 'demo', type: 'research_done', summary: 'Research ready' });
    await designer.call('design_bus_post', { runId: 'demo', type: 'design_spec_ready', summary: 'Executable page' });
    await reviewer.call('update_design_context', { changes: { assessment: { review_stage: 'design_context', verdict: 'pass', round: 1, summary: 'Executable and user-accessible', scores: {}, issues: [], resolved_issue_ids: [], remaining_risks: [] } } });
    await reviewer.call('commit_design_context');
    await reviewer.call('design_bus_post', { runId: 'demo', type: 'design_review_pass', summary: 'Approved' });
    const builder = harness(workspace, 'builder');
    assert.equal((await builder.call('execute_design_plan', { runId: 'demo' })).succeeded, 1);
    assert.equal((await builder.call('build_finalize', { runId: 'demo' })).ok, true);
    await assert.rejects(root.call('export_package', { runId: 'demo', runDir: join(workspace, 'runs/foreign') }), /must match its canonical runId/);
    await root.call('export_package', { runId: 'demo' });
    const finalSource = JSON.parse(await readFile(join(runDir, 'final/context/design.json')));
    assert.equal(finalSource.schemaVersion, 2); assert.equal('tasks' in finalSource, false);
    const finalEvidence = JSON.parse(await readFile(join(runDir, 'artifacts/lint-report.json')));
    assert.equal(finalEvidence.browser.status, 'completed');
    // Open a normal same-version revision before continuing authoring.
    await root.call('run_revision', { runId: 'demo', feedback: 'Check a narrower viewport' });
    assert.equal((await designer.call('update_design_context', { changes: { deliverables: [{ id: 'page', execution: { viewports: [{ width: 390, height: 844 }] } }] } })).saved, true);
    assert.throws(() => prepareContextChanges({ changes: { tasks: [] } }, 'designer', 2), /invalid_named_fields/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('producer references derive dependencies/resources and invalid references cannot be hidden', () => {
  const data = document();
  data.deliverables.push({ id: 'cutaway', scope_id: 'campaign', kind: 'image', purpose: 'Explain mechanism', acceptance_test: 'Visible cutaway', required: true, user_requested: true, file: 'artifacts/cutaway.png', presentation: { required: true, access: 'embed' }, execution: { method: 'image_generate', prompt_seed: 'Cutaway concept', negative_prompt_seed: 'No text', size: '512x512', size_rationale: 'Mechanism detail' } });
  data.deliverables[0].execution.uses = ['cutaway'];
  const contract = contractOf(data);
  assert.deepEqual(contract.tasks[0].dependencies, ['cutaway']);
  assert.deepEqual(contract.tasks[0].resources, [{ source: 'artifacts/cutaway.png', output: 'artifacts/cutaway.png' }]);
  data.deliverables[0].execution.uses = ['wrong'];
  assert.throws(() => contractOf(data), /invalid execution.uses reference/);
  data.deliverables[0].execution.uses = [];
  data.deliverables[1].presentation.required = false;
  assert.throws(() => contractOf(data), /User-requested outputs must be accessible/);
});

test('required cutaway omission and hidden elements fail; descriptive goals do not duplicate interaction tests', async () => {
  const { workspace, runDir } = await fixture();
  try {
    const data = document();
    data.deliverables.push({ id: 'cutaway', kind: 'image', scope_id: 'campaign', purpose: 'Mechanism', acceptance_test: 'Cutaway is visible', required: true, user_requested: true, file: 'artifacts/cutaway.png', presentation: { required: true, access: 'embed' }, execution: { method: 'image_generate', prompt_seed: 'A cutaway', negative_prompt_seed: 'No text', size: '512x512', size_rationale: 'Detail' } });
    data.deliverables[0].execution.uses = ['cutaway'];
    let contract = contractOf(data);
    await assert.rejects(assertHtmlSourcePreflight(runDir, contract), /cutaway.*missing or hidden/);
    await writeFile(join(runDir, 'plan/html/ui/index.html'), html.replace('</body>', '<img hidden src="../../artifacts/cutaway.png"></body>'));
    await assert.rejects(assertHtmlSourcePreflight(runDir, contract), /cutaway.*missing or hidden/);
    await writeFile(join(runDir, 'plan/html/ui/index.html'), html.replace('</body>', '<img alt="Cutaway" src="../../artifacts/cutaway.png"></body>'));
    assert.equal((await assertHtmlSourcePreflight(runDir, contract)).passed, true);
    data.deliverables[1].presentation.access = 'download';
    const downloadContract = contractOf(data);
    await writeFile(join(runDir, 'plan/html/ui/index.html'), html.replace('</body>', '<a href="../../artifacts/cutaway.png">Download</a></body>'));
    await assert.rejects(assertHtmlSourcePreflight(runDir, downloadContract), /required download access/);
    await writeFile(join(runDir, 'plan/html/ui/index.html'), html.replace('</body>', '<a href="https://example.invalid/artifacts/cutaway.png" download>Download</a></body>'));
    await assert.rejects(assertHtmlSourcePreflight(runDir, downloadContract), /required download access/);
    await writeFile(join(runDir, 'plan/html/ui/index.html'), html.replace('</body>', '<a href="../../artifacts/cutaway.png" download>Download</a></body>'));
    assert.equal((await assertHtmlSourcePreflight(runDir, downloadContract)).passed, true);
    await writeFile(join(runDir, 'plan/html/ui/index.html'), html.replace('</body>', '<img alt="Cutaway" src="../../artifacts/cutaway.png"></body>'));
    const execution = { ...page.execution, id: 'page', viewports: [{ width: 1440, height: 900 }, { width: 390, height: 844 }], interaction_requirements: [{ id: 'nav', goal: 'Reach section', initial_state: 'Closed menu', outcome: [{ action: 'expect_url', selector: 'html', value: '#section' }] }], interaction_checks: [{ name: 'Desktop only', requirement_id: 'nav', viewport: { min_width: 769 }, steps: [{ action: 'click', selector: 'a' }, { action: 'expect_url', selector: 'html', value: '#section' }] }] };
    assert.doesNotThrow(() => htmlTask(execution)); // Optional design notes do not duplicate executable assertions.
    execution.interaction_checks[0].viewport = { max_width: 768 };
    execution.interaction_checks[0].steps = [{ action: 'click', selector: '#toggle' }, { action: 'expect_visible', selector: '#menu' }];
    assert.doesNotThrow(() => htmlTask(execution));
    // Final browser sees actual assets, and catches a missing resource even after source preview passed.
    await mkdir(join(runDir, 'artifacts/ui'), { recursive: true });
    await writeFile(join(runDir, page.file), await readFile(join(runDir, 'plan/html/ui/index.html')));
    const final = await checkHtmlBrowser(runDir, contract);
    assert.equal(final.passed, false); assert.match(final.issues.join('\n'), /resource 404/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('truncation recovery is bounded, preserves durable results and distinguishes unknown controls', async () => {
  const failure = dreamaticSessionFailure([{ role: 'assistant', stopReason: 'length' }]);
  assert.match(failure, /truncated/); assert.equal(isRetryableError(new Error(failure)), true);
  const durable = { committed: 'unchanged' }; let attempts = 0;
  await assert.rejects(withRetry(async () => { attempts++; throw new Error(failure); }, { attempts: 2, sleep: async () => {} }), /token limit/);
  assert.equal(attempts, 2); assert.deepEqual(durable, { committed: 'unchanged' });
  assert.match(modelRecoveryTask(failure), /Never split required Context roots/);
  assert.equal(providerRequestSummary({ max_completion_tokens: 16384 }).thinkingControl, 'unspecified');
  assert.equal(providerRequestSummary({ enable_thinking: false }).thinkingControl, 'explicit');
});

test('explicit upgrade builds a new draft without changing historical specification bytes', () => {
  const legacy = { ...document(), schemaVersion: 1, tasks: [{ id: 'page', method: 'manual' }], deliverables: [{ ...page }] };
  delete legacy.deliverables[0].execution;
  const before = JSON.stringify(legacy);
  const upgraded = upgradeDesignData(legacy);
  assert.equal(JSON.stringify(legacy), before); assert.equal('tasks' in upgraded, false);
  assert.equal(upgraded.deliverables[0].execution.method, 'manual');
});


test('completed unified-v1 upgrade archives receipts and leaves canonical bytes unchanged until Designer commit', async () => {
  const { workspace, runDir, root } = await fixture();
  try {
    const brief = JSON.parse(await readFile(join(runDir, 'brief.json'))); brief.designContractVersion = 1;
    await writeFile(join(runDir, 'brief.json'), JSON.stringify(brief));
    const legacy = document(); legacy.schemaVersion = 1;
    legacy.tasks = [{ id: 'page', ...legacy.deliverables[0].execution }];
    delete legacy.deliverables[0].execution; delete legacy.deliverables[0].user_requested; delete legacy.deliverables[0].presentation;
    const canonical = JSON.stringify(legacy);
    await writeFile(join(runDir, 'context/design.json'), canonical);
    await writeFile(join(runDir, 'run-state.json'), JSON.stringify({ runId: 'demo', status: 'complete', stages: { build: 'completed' } }));
    await mkdir(join(runDir, 'final'), { recursive: true });
    await writeFile(join(runDir, 'final/receipt.json'), '{"approved":"historical"}');
    const result = await root.call('run_revision', { runId: 'demo', feedback: 'Explicitly upgrade this completed design', upgradeDesignContract: true });
    const archived = join(runDir, result.revisionRequest.baseSnapshot);
    assert.equal(await readFile(join(archived, 'context/design.json'), 'utf8'), canonical);
    assert.equal(await readFile(join(runDir, 'context/design.json'), 'utf8'), canonical);
    assert.equal(await readFile(join(archived, 'final/receipt.json'), 'utf8'), '{"approved":"historical"}');
    assert.equal(JSON.parse(await readFile(join(runDir, 'brief.json'))).designContractVersion, 2);
    const draft = JSON.parse(await readFile(join(runDir, '.performance/context-draft-designer.json')));
    assert.equal('tasks' in draft.data, false); assert.equal(draft.data.deliverables[0].execution.method, 'html_generate');
    const read = await harness(workspace, 'designer').call('design_context_read', { audience: 'designer' });
    assert.equal(read.workingContext.data.deliverables[0].user_requested, true);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});


test('runtime identity is captured when loaded and does not claim a later disk rebuild is active', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dreamatic-loaded-identity-'));
  try {
    const source = await readFile(new URL('../dist/delivery-block.js', import.meta.url), 'utf8');
    const names = [...source.matchAll(/"([^"\n]+\.js)"/g)].map(match => match[1]);
    for (const name of names) await writeFile(join(directory, name), name === 'delivery-block.js' ? source : 'original loaded build');
    const loaded = await import(pathToFileURL(join(directory, 'delivery-block.js')).href);
    const first = await loaded.deliveryRuntimeStamp();
    await writeFile(join(directory, 'extension.js'), 'new build on disk awaiting restart');
    assert.equal(await loaded.deliveryRuntimeStamp(), first);
    assert.equal(loaded.loadedRuntimeIdentity.codeFingerprint.length, 64);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Gallery plus navigable Designer document previews sources before Gallery exists, while final Gallery access remains mandatory', async()=>{
 const {workspace,runDir}=await fixture();
 try{
  const data=document();data.presentation={mode:'gallery',entry:'artifacts/00-gallery.html'};
  data.deliverables[0].execution.interaction_checks=[{name:'Read concept',steps:[{action:'click',selector:'a[href="#concept"]'},{action:'expect_url',value:'#concept'}]}];
  data.deliverables[0].execution.interaction_requirements=[{id:'read',goal:'Read section',outcome:['Concept section is readable']}];
  const source=html.replace('<h1>Concept</h1>','<nav><a href="#concept">Read</a></nav><h1 id="concept">Concept</h1>');
  await writeFile(join(runDir,'plan/html/ui/index.html'),source);
  const contract=contractOf(data);
  const preview=await assertHtmlSourcePreflight(runDir,contract);
  assert.equal(preview.passed,true,JSON.stringify(preview));assert.equal(preview.checks.filter(c=>c.status==='passed').length,2);
  assert.equal((await assertHtmlSourcePreflight(runDir,contract)).reused,true);
  await writeFile(join(runDir,'plan/html/ui/index.html'),source.replace('id="concept"','id="missing"'));
  await assert.rejects(assertHtmlSourcePreflight(runDir,contract),/anchor #concept has no target element/);
  await writeFile(join(runDir,'plan/html/ui/index.html'),source);
  await mkdir(join(runDir,'artifacts/ui'),{recursive:true});await writeFile(join(runDir,page.file),source);
  const final=await checkHtmlBrowser(runDir,contract);
  assert.equal(final.passed,false);assert.ok(final.issues.some(i=>i.includes('00-gallery.html')));
 }finally{await rm(workspace,{recursive:true,force:true});}
});
