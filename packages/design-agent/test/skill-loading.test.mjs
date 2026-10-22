import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createDreamaticExtension } from '../dist/extension.js';
import { SkillActivation } from '../dist/skill-activation.js';
import { skillMetadata } from '../dist/skill-metadata.js';
import { validateDesignScopes } from '../dist/design-scope-validation.js';

function harness(workspace, agent = 'designer', cwd = workspace) {
  const tools = new Map(), handlers = new Map();
  createDreamaticExtension({ workspaceDir: workspace, parentInvocation: { id: `${agent}-1`, agent, runId: 'demo' } })({
    registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => handlers.set(name, handler),
  });
  return { handlers, async call(name, args = {}) {
    const result = await tools.get(name).execute(name, args, undefined, undefined, { cwd });
    return name === 'use_skill' ? result : JSON.parse(result.content[0].text);
  } };
}
async function skill(workspace, name, extra = '') {
  const path = join(workspace, '.pi/skills', name, 'SKILL.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nname: ${name}\ndescription: Author responsive accessible pages for product concepts\nmetadata:\n  audience: designer\n  module_type: execution\n  design_categories: [ux]\n  capabilities: [page-authoring, accessibility]\n  supported_outputs: [html]\n${extra}---\n# Knowledge ${name}\nUse semantic HTML.\n`);
  return path;
}
async function brief(workspace) {
  const path = join(workspace, 'runs/demo/brief.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ resolvedScope: { designScopes: [{ id: 'lamp', category: 'industrial', task: 'Design a lamp' }] } }));
}

test('task/capability/output discovery loads arbitrary installed names across scope categories', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-dynamic-skills-'));
  try {
    await brief(workspace);
    await skill(workspace, 'studio-pages');
    const professional = await skill(workspace, 'studio-lamp');
    await writeFile(professional, (await readFile(professional, 'utf8'))
      .replace('module_type: execution', 'module_type: discipline')
      .replace('design_categories: [ux]', 'design_categories: [industrial]')
      .replace('capabilities: [page-authoring, accessibility]', 'capabilities: [product-geometry]'));
    const h = harness(workspace);
    const primaryCatalog = await h.call('list_skills', { scopeId: 'lamp', capabilities: ['product-geometry'] });
    const primary = primaryCatalog.skills.find(item => item.name === 'studio-lamp').applicableScopes[0].load;
    assert.equal(primary.arguments.role, 'primary');
    await h.call(primary.tool, { ...primary.arguments, rationale: 'Design physical geometry' });
    const catalog = await h.call('list_skills', { scopeId: 'lamp', capabilities: ['PAGE-AUTHORING'], output: 'HTML', query: 'responsive accessible' });
    const found = catalog.skills.find(item => item.name === 'studio-pages');
    assert.ok(found);
    assert.equal(found.primaryEligible, false);
    assert.ok(catalog.selectionByScope[0].supportingCandidates.includes(found.name));
    const call = found.applicableScopes.find(item => item.scopeId === 'lamp').load;
    assert.equal(call.arguments.role, 'supporting');
    const loaded = await h.call(call.tool, { ...call.arguments, rationale: 'Present the lamp concept' });
    assert.match(loaded.content[0].text, /Use semantic HTML/);
    assert.equal(loaded.details.reused, false);
    assert.equal((await h.call(call.tool, call.arguments)).details.reused, true);
    await assert.rejects(h.call('use_skill', { name: found.name, scopeId: 'lamp', role: 'primary' }), /skill_scope_mismatch/);
    assert.equal((await h.call('list_skills', { category: 'industrial', query: 'studio-pages' })).count, 0);
    await rename(join(workspace, '.pi/skills/studio-pages'), join(workspace, '.pi/skills/retired-pages'));
    await rm(join(workspace, '.pi/skills/retired-pages'), { recursive: true });
    await skill(workspace, 'another-page-author');
    const refreshed = await h.call('list_skills', { refresh: true, capabilities: ['page-authoring'] });
    assert.ok(refreshed.skills.some(item => item.name === 'another-page-author'));
    assert.ok(!refreshed.skills.some(item => item.name === found.name));
    const replacement = refreshed.skills.find(item => item.name === 'another-page-author').applicableScopes[0].load;
    assert.match((await h.call(replacement.tool, replacement.arguments)).content[0].text, /Knowledge another-page-author/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('Skill reads use one entry point while referenced resources stay readable, including symlinks', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-skill-entry-'));
  try {
    const path = await skill(workspace, 'page-method');
    const resource = join(dirname(path), 'reference.md');
    await writeFile(resource, 'Layout details');
    const alias = join(workspace, 'method-alias.md');
    await symlink(path, alias);
    const h = harness(workspace);
    const read = path => h.handlers.get('tool_call')({ toolName: 'read', input: { path } }, { cwd: workspace });
    assert.match((await read(path)).reason, /use_skill/);
    assert.equal((await read(alias)).block, true);
    assert.equal(await read(resource), undefined);
    // A Skill can also be an explicitly configured Markdown entry with any filename.
    const external = join(workspace, 'custom-entry.md');
    await writeFile(external, await readFile(path, 'utf8'));
    await mkdir(join(workspace, '.pi'), { recursive: true });
    await writeFile(join(workspace, '.pi/settings.json'), JSON.stringify({ skills: [external] }));
    const configured = harness(workspace);
    assert.equal((await configured.handlers.get('tool_call')({ toolName: 'read', input: { path: external } }, { cwd: workspace })).block, true);
    const reviewer = harness(workspace, 'reviewer');
    assert.match((await reviewer.handlers.get('tool_call')({ toolName: 'read', input: { path } }, { cwd: workspace })).reason, /not available to this role/);
    assert.equal((await reviewer.handlers.get('tool_call')({ toolName: 'read', input: { path: external } }, { cwd: workspace })).block, true);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('changed bodies invalidate discovery metadata and catalog diagnostics remain visible', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-skill-snapshot-'));
  try {
    const path = await skill(workspace, 'studio-pages');
    const h = harness(workspace);
    await h.call('list_skills');
    await writeFile(path, (await readFile(path, 'utf8')).replace('supported_outputs: [html]', 'supported_outputs: [image]'));
    await h.call('use_skill', { name: 'studio-pages' });
    assert.equal((await h.call('list_skills', { output: 'html', query: 'studio-pages' })).count, 0);
    assert.equal((await h.call('list_skills', { output: 'image', query: 'studio-pages' })).count, 1);
    const duplicate = join(workspace, '.pi/skills/collision/SKILL.md');
    await mkdir(dirname(duplicate), { recursive: true });
    await writeFile(duplicate, await readFile(path, 'utf8'));
    const catalog = await h.call('list_skills', { refresh: true });
    assert.ok(catalog.diagnostics.some(item => item.type === 'collision' && item.collision.name === 'studio-pages'));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('compaction retains selections but invalidates loaded receipts and publication validation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-skill-compaction-'));
  try {
    await brief(workspace);
    const path = await skill(workspace, 'lamp-method');
    await writeFile(path, (await readFile(path, 'utf8')).replace('module_type: execution', 'module_type: discipline').replace('design_categories: [ux]', 'design_categories: [industrial]'));
    const h = harness(workspace);
    const args = { name: 'lamp-method', scopeId: 'lamp', role: 'primary', rationale: 'Design lamp geometry' };
    await h.call('use_skill', args);
    const runDir = join(workspace, 'runs/demo');
    const plan = { skill_selection: [{ scope_id: 'lamp', name: args.name, role: 'primary', rationale: args.rationale }] };
    const manifest = { deliverables: [{ id: 'lamp-view', scope_id: 'lamp', category: 'industrial', skill_refs: [args.name], method: 'image_generate' }] };
    await validateDesignScopes(runDir, plan, manifest);
    await h.handlers.get('session_compact')({});
    const receipt = JSON.parse(await readFile(join(runDir, '.performance/skills-designer.json')));
    assert.equal(receipt.activeSkills.length, 1);
    assert.deepEqual(receipt.loadedSkills, []);
    await assert.rejects(validateDesignScopes(runDir, plan, manifest), /not activated/);
    const loaded = await h.call('use_skill', args);
    assert.equal(loaded.details.reused, false);
    assert.match(loaded.content[0].text, /Use semantic HTML/);
    await validateDesignScopes(runDir, plan, manifest);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('loaded bindings track source paths as well as content hashes', () => {
  const activation = new SkillActivation();
  const metadata = skillMetadata({});
  activation.activate('first', '/first/SKILL.md', 'same-hash', metadata, 'one');
  activation.activate('second', '/second/SKILL.md', 'same-hash', metadata, 'two');
  activation.forgetLoadedBodies();
  activation.activate('first', '/first/SKILL.md', 'same-hash', metadata, 'one');
  assert.deepEqual(activation.loadedBindings().map(item => item.name), ['first']);
});

test('bundled capabilities find accessibility by standard terminology and preserve professional boundaries', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-bundled-discovery-'));
  try {
    await brief(workspace);
    const briefPath = join(workspace, 'runs/demo/brief.json');
    const data = JSON.parse(await readFile(briefPath, 'utf8'));
    data.resolvedScope.designScopes.push({ id: 'controls', category: 'ux', task: 'Control interface' }, { id: 'campaign', category: 'media_communication', task: 'Communicate the lamp' }, { id: 'gallery', category: 'space', task: 'Exhibition wayfinding' });
    await writeFile(briefPath, JSON.stringify(data));
    const h = harness(workspace, 'designer', fileURLToPath(new URL('../../..', import.meta.url)));
    const tagged = await h.call('list_skills', { scopeId: 'controls', capabilities: ['accessibility'] });
    assert.ok(tagged.skills.some(skill => skill.name === 'accessible-interface'));
    assert.ok((await h.call('list_skills', { query: 'accessibility' })).skills.some(skill => skill.name === 'accessible-interface'));
    const loaded = await h.call('use_skill', { ...tagged.skills.find(skill => skill.name === 'accessible-interface').applicableScopes.find(scope => scope.scopeId === 'controls').load.arguments, rationale: 'Keyboard access to controls' });
    assert.equal(loaded.details.role, 'supporting');
    const catalog = await h.call('list_skills', { scopeId: 'controls' });
    const controls = catalog.selectionByScope.find(scope => scope.scopeId === 'controls');
    for (const name of ['game-experience-design', 'illustration-art-direction', 'service-design']) {
      assert.ok(!controls.primaryCandidates.includes(name));
      assert.ok(controls.supportingCandidates.includes(name));
      await assert.rejects(h.call('use_skill', { name, scopeId: 'controls', role: 'primary' }), /skill_scope_mismatch/);
      assert.equal((await h.call('use_skill', { name, scopeId: 'controls', role: 'supporting', rationale: 'Inform the interface context' })).details.role, 'supporting');
    }
    const html = (await h.call('list_skills', { output: 'html' })).skills.map(skill => skill.name);
    for (const name of ['editorial-design', 'game-experience-design', 'media-motion-design']) assert.ok(html.includes(name));
    for (const name of ['illustration-art-direction', 'industrial-design', 'product-design']) assert.ok(!html.includes(name));
    const all = await h.call('list_skills');
    for (const [scopeId, name] of [['lamp', 'packaging-design'], ['campaign', 'packaging-design'], ['gallery', 'exhibition-wayfinding'], ['campaign', 'exhibition-wayfinding'], ['controls', 'information-design'], ['campaign', 'information-design']]) {
      assert.ok(all.selectionByScope.find(scope => scope.scopeId === scopeId).primaryCandidates.includes(name), `${name} retains legitimate primary responsibility in ${scopeId}`);
    }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
