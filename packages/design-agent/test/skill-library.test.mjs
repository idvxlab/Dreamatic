import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import { validateSkillLibrary } from '../dist/skill-library.js';

const bundled = fileURLToPath(new URL('../../../.pi/skills', import.meta.url));
const metadata = () => ({ audience: 'designer', domain_type: 'custom_method', module_type: 'discipline', design_categories: ['industrial'], supported_outputs: ['image'], capabilities: ['a-new-capability'] });
async function entry(root, name, meta = metadata(), body = '# Custom Method\n\nProfessional knowledge.') {
  const path = join(root, name, 'SKILL.md');
  await mkdir(join(root, name), { recursive: true });
  // JSON scalar values are valid YAML, keeping the fixture independent of serializer choices.
  await writeFile(path, `---\nname: ${name}\ndescription: A dynamically installed professional method.\nmetadata:\n${Object.entries(meta).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${body}\n`);
  return path;
}
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dreamatic-library-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('bundled Skill library is structurally valid and every directory is discoverable by Pi', async () => {
  assert.deepEqual(await validateSkillLibrary(bundled), []);
  const directories = (await readdir(bundled, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const loaded = loadSkillsFromDir({ dir: bundled, source: 'project' });
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.skills.map(skill => skill.name).sort(), directories);
});

test('new Skill names and capability tags require no validator whitelist changes', () => fixture(async root => {
  const path = await entry(root, 'unregistered-professional-method');
  await mkdir(join(root, 'unregistered-professional-method/references'));
  await writeFile(join(root, 'unregistered-professional-method/references/detail.md'), 'Details');
  await writeFile(path, (await readFile(path, 'utf8')) + '\n[Detail](references/detail.md)\n');
  assert.deepEqual(await validateSkillLibrary(root), []);
}));

test('empty and partial libraries cannot silently pass structural checks', () => fixture(async root => {
  assert.ok((await validateSkillLibrary(root)).some(issue => issue.code === 'empty_library'));
  await mkdir(join(root, 'empty-module'));
  await mkdir(join(root, 'ui-only-module/agents'), { recursive: true });
  await writeFile(join(root, 'ui-only-module/agents/openai.yaml'), 'interface:\n  display_name: Missing entry');
  const issues = await validateSkillLibrary(root);
  assert.equal(issues.filter(issue => issue.code === 'missing_skill_entry').length, 2);
}));

test('metadata typos and unsupported media fail validation rather than disappearing in runtime defaults', () => fixture(async root => {
  await entry(root, 'broken-module', { ...metadata(), domain_type: '', design_categories: ['industral'], supported_outputs: ['video'], capabilities: ['Mixed_Case'], version: '' });
  const issues = await validateSkillLibrary(root);
  for (const code of ['invalid_domain_type', 'invalid_design_categories', 'invalid_supported_outputs', 'invalid_capabilities', 'invalid_version']) assert.ok(issues.some(issue => issue.code === code), code);
  await entry(root, 'missing-tags', { ...metadata(), capabilities: [] });
  assert.ok((await validateSkillLibrary(root)).some(issue => issue.path.includes('missing-tags') && issue.code === 'invalid_capabilities'));
  await entry(root, 'no-professional-category', { ...metadata(), design_categories: [] });
  assert.ok((await validateSkillLibrary(root)).some(issue => issue.path.includes('no-professional-category') && issue.code === 'invalid_design_categories'));
}));

test('mismatched names, supporting primary categories and broken local resources are reported', () => fixture(async root => {
  const path = await entry(root, 'custom-support', { ...metadata(), module_type: 'execution' }, '# Custom\n\n[Missing](references/missing.md)');
  await writeFile(path, (await readFile(path, 'utf8')).replace('name: custom-support', 'name: other-name'));
  const issues = await validateSkillLibrary(root);
  for (const code of ['name_directory_mismatch', 'supporting_primary_categories', 'missing_reference']) assert.ok(issues.some(issue => issue.code === code), code);
}));
