import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkillsFromDir, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import { BUILTIN_SKILL_DIRECTORY, loadRoleSkillCatalog, validateSkillDocument, createScopedSkillReadTool, saveSkillCatalog, explicitSkillInstructions, requestedSkillNames } from '../dist/skill-policy.js';
import { AGENT_ROLES, parseSkillSources } from '../dist/skill-sources.js';
import { createDreamaticAgent } from '../dist/agent-session.js';
import { createBuilderTextReadTool } from '../dist/showcase.js';
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'dreamatic-skills-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function skill(root, name, extras = '', body = 'Use the supplied evidence and preserve the task scope.') {
  const dir = join(root, name); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Supporting knowledge for the requested design.\n${extras}---\n\n# Knowledge\n\n${body}\n`); return dir;
}
const catalogFor = (root, role, paths = [], tools = ['read']) => loadRoleSkillCatalog({ root, role, tools, env: { DREAMATIC_SKILL_PATHS: JSON.stringify({ [role]: paths }) } });

test('all built-in Skills use strict portable metadata and current categories with focused bodies', async () => {
  const loaded = loadSkillsFromDir({ dir: BUILTIN_SKILL_DIRECTORY, source: 'project' });
  assert.equal(loaded.skills.length, 30); assert.deepEqual(loaded.diagnostics, []);
  for (const entry of loaded.skills) {
    const text = await readFile(entry.filePath, 'utf8');
    assert.deepEqual(validateSkillDocument(text, basename(entry.baseDir), true), [], entry.name);
    assert.ok(text.split('\n').length < 500, entry.name);
    assert.doesNotMatch(text, /prompt_seed|negative_prompt_seed|plan\/html\/<scope-id>|Save one complete file per response/);
  }
  const source = '---\nname: example\ndescription: Useful method.\nmetadata:\n  outputs: [image, html]\n---\n# Method';
  assert.ok(validateSkillDocument(source, 'example').some(error => error.includes('string values')));
  assert.deepEqual(validateSkillDocument(source.replace('  outputs: [image, html]', '  outputs: "image html"'), 'example'), []);
});

test('role catalogs expose only applicable built-ins and never ambient project or user Skills', async t => {
  const root = await fixture(t);
  await skill(join(root, '.pi/skills'), 'concept-showcase-storytelling');
  await skill(join(root, '.agents/skills'), 'ambient-only');
  const expected = { orchestrator: 0, researcher: 1, designer: 27, builder: 8, editor: 5 };
  for (const role of AGENT_ROLES) {
    const catalog = await catalogFor(root, role);
    assert.equal(catalog.entries.length, expected[role], role); assert.deepEqual(catalog.diagnostics, []);
    assert.ok(catalog.entries.every(entry => entry.source === 'builtin'));
    assert.ok(!catalog.entries.some(entry => entry.skill.name === 'ambient-only'));
    if (role === 'builder') assert.ok(catalog.entries.find(entry => entry.skill.name === 'concept-showcase-storytelling').skill.filePath.startsWith(BUILTIN_SKILL_DIRECTORY));
    if (role === 'editor') assert.ok(catalog.entries.some(entry => entry.skill.name === 'image-prompting'));
    if (role === 'designer') assert.ok(!catalog.entries.some(entry => entry.skill.name === 'html-interface'));
  }
});

test('approved third-party knowledge is role-scoped, cannot shadow built-ins, and preserves explicit-only flags', async t => {
  const root = await fixture(t), approved = await skill(join(root, 'approved'), 'approved-method');
  const collision = await skill(join(root, 'third-party'), 'concept-showcase-storytelling');
  const explicit = await skill(join(root, 'approved'), 'explicit-method', 'disable-model-invocation: true\n');
  const catalog = await catalogFor(root, 'builder', [approved, collision, explicit, approved]);
  assert.equal(catalog.entries.filter(entry => entry.skill.name === 'approved-method').length, 1);
  assert.equal(catalog.entries.find(entry => entry.skill.name === 'concept-showcase-storytelling').source, 'builtin');
  assert.ok(catalog.diagnostics.some(item => item.code === 'name-collision'));
  const prompt = formatSkillsForPrompt(catalog.entries.map(entry => entry.skill));
  assert.match(prompt, /approved-method/); assert.doesNotMatch(prompt, /<name>explicit-method<\/name>/);
  const otherRole = await loadRoleSkillCatalog({ root, role: 'researcher', tools: ['read'], env: { DREAMATIC_SKILL_PATHS: JSON.stringify({ builder: [approved] }) } });
  assert.ok(!otherRole.entries.some(entry => entry.source === 'approved'));
  const wrongRoleCollision = await catalogFor(root, 'orchestrator', [collision]);
  assert.equal(wrongRoleCollision.entries.length, 0); assert.ok(wrongRoleCollision.diagnostics.some(item => item.code === 'name-collision'));
});

test('unsupported tool requirements, invalid metadata, missing sources and Skill-file escapes produce diagnostics', async t => {
  const root = await fixture(t);
  const executable = await skill(root, 'needs-shell', 'metadata:\n  dreamatic-requires-tools: "read bash"\n');
  const invalid = await skill(root, 'invalid-metadata', 'metadata:\n  capabilities: [one, two]\n');
  const environment = await skill(root, 'environment-method', 'compatibility: Requires a Python runtime for optional helpers.\n');
  const escaped = join(root, 'escaped'); await mkdir(escaped);
  const outside = await skill(root, 'outside'); await symlink(join(outside, 'SKILL.md'), join(escaped, 'SKILL.md'));
  const catalog = await catalogFor(root, 'builder', [executable, invalid, environment, escaped, join(root, 'missing')]);
  assert.ok(!catalog.entries.some(entry => ['needs-shell','invalid-metadata','escaped','outside'].includes(entry.skill.name)));
  assert.ok(catalog.entries.some(entry => entry.skill.name === 'environment-method'));
  for (const code of ['unavailable-tools','invalid-skill','source-unavailable','environment-unverified']) assert.ok(catalog.diagnostics.some(item => item.code === code), code);
  const paths = parseSkillSources('{"editor":["~/skills/example"]}'); assert.equal(paths.editor[0], '~/skills/example');
  for (const value of ['[]', '{"unknown":[]}', '{"builder":["relative/path"]}', '{"editor":"/path"}']) assert.throws(() => parseSkillSources(value));
});

test('native reads stay scoped, allow approved text resources, reject changed/unapproved Skills and persist activation evidence', async t => {
  const root = await fixture(t), run = join(root, 'run'); await mkdir(run);
  const approved = await skill(join(root, 'approved'), 'resource-method'); await mkdir(join(approved, 'references')); await mkdir(join(approved, 'scripts'));
  await writeFile(join(approved, 'references/rules.md'), '# Real rules'); await writeFile(join(approved, 'scripts/helper.py'), 'print("not executed")');
  await writeFile(join(root, 'private.txt'), 'outside-data'); await symlink(join(root, 'private.txt'), join(approved, 'references/escape.md'));
  const catalog = await catalogFor(run, 'builder', [approved]);
  await saveSkillCatalog(run, catalog, 'fixture-session');
  const reader = createScopedSkillReadTool({ root: run, catalog, delegate: createBuilderTextReadTool(run), sessionId: () => 'fixture-session' });
  const result = await reader.execute('activate', { path: join(approved, 'SKILL.md') }); assert.match(result.content[0].text, /Knowledge/);
  assert.match((await reader.execute('reference', { path: join(approved, 'references/rules.md') })).content[0].text, /Real rules/);
  assert.match((await reader.execute('source', { path: join(approved, 'scripts/helper.py') })).content[0].text, /not executed/);
  await assert.rejects(reader.execute('escape', { path: join(approved, 'references/escape.md') }), /outside/);
  const unapproved = await skill(join(run, '.pi/skills'), 'unapproved-method');
  await assert.rejects(reader.execute('unapproved', { path: join(unapproved, 'SKILL.md') }), /approved role catalog/);
  await writeFile(join(approved, 'SKILL.md'), 'changed instructions'); await assert.rejects(reader.execute('changed', { path: join(approved, 'SKILL.md') }), /changed after catalog/);
  const folder = join(run, 'sessions/builder/skills');
  const manifest = JSON.parse(await readFile(join(folder, (await readdir(folder)).find(name => name.startsWith('skill-catalog-'))), 'utf8'));
  assert.equal(manifest.sessionId, 'fixture-session'); assert.ok(manifest.skills.some(entry => entry.name === 'resource-method' && entry.source === 'approved'));
  const records = (await readFile(join(folder, 'skill-activations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1); assert.equal(records[0].sessionId, 'fixture-session'); assert.equal(records[0].digest, catalog.entries.find(entry => entry.skill.name === 'resource-method').digest);
});

test('real Pi session discloses the controlled catalog, activates relevant knowledge and keeps the role output contract', async t => {
  const { createServer } = await import('node:http');
  const root = await fixture(t), approved = await skill(join(root, 'approved'), 'campaign-method', '', 'The approved campaign uses an amber lighthouse as its recognition anchor.');
  const run = join(root, 'runs/demo'); await mkdir(run, {recursive:true}); await skill(join(run, '.pi/skills'), 'ambient-only');
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const data = JSON.parse(body); calls++;
    const system = data.messages.find(message => message.role === 'system').content;
    assert.match(system, /campaign-method/); assert.doesNotMatch(system, /<name>ambient-only<\/name>/);
    assert.ok(data.tools.every(tool => tool.function.name === 'read'));
    const loaded = data.messages.some(message => message.role === 'tool');
    if (loaded) assert.ok(JSON.stringify(data.messages).includes('amber lighthouse'));
    const delta = loaded ? { content: '# Coastal identity\n\n## Image: hero\n### Introduction\nAmber lighthouse identity concept.\n### Size\n1024x1024\n### Prompt\nAn amber lighthouse identity composition.' } : { tool_calls: [{ index: 0, id: 'knowledge', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: join(approved, 'SKILL.md') }) } }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choice of [{ delta: { role: 'assistant', ...delta }, finish_reason: null }, { delta: {}, finish_reason: loaded ? 'stop' : 'tool_calls' }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, ...choice }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const env = { DREAMATIC_API_KEY: 'fixture', DREAMATIC_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, DREAMATIC_MODEL: 'fixture', DREAMATIC_CONTEXT_WINDOW: '32768', DREAMATIC_MAX_TOKENS: '8192', DREAMATIC_SKILL_PATHS: JSON.stringify({ designer: [approved] }) };
  const { session, skillCatalog } = await createDreamaticAgent({ root: run, role: 'designer', systemPrompt: 'Return only a design.md image plan. Never write files or implement a prototype.', tools: [], env });
  t.after(() => session.dispose());
  assert.deepEqual(session.resourceLoader.getSkills().skills.map(skill => skill.name), skillCatalog.entries.map(entry => entry.skill.name));
  await session.prompt('Design the campaign using the approved campaign-method knowledge.');
  assert.equal(calls, 2); assert.match(session.getLastAssistantText(), /## Image: hero/); assert.doesNotMatch(session.getLastAssistantText(), /<html/);
  const events = (await readFile(join(run, 'sessions/designer/skills/skill-activations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].name, 'campaign-method'); assert.equal(events[0].sessionId, session.sessionId);
  const {runAgentSessions} = await import('../dist/run-store.js');
  const transcripts = await runAgentSessions(root, 'demo');
  assert.equal(transcripts.length, 1, 'Skill audit records must not appear as additional Pi sessions');
});

async function policy(dir, text) {
  await mkdir(join(dir, 'agents'), { recursive: true });
  await writeFile(join(dir, 'agents/openai.yaml'), text);
}

test('allowed-tools is advisory while explicit required dependencies still gate loading', async t => {
  const root = await fixture(t);
  const optional = await skill(root, 'optional-tools', 'allowed-tools: Read Bash(python:*)\n');
  const required = await skill(root, 'required-tools', 'metadata:\n  dreamatic-requires-tools: "Read Bash"\n');
  const catalog = await catalogFor(root, 'designer', [optional, required]);
  assert.ok(catalog.entries.some(entry => entry.skill.name === 'optional-tools'));
  assert.ok(!catalog.entries.some(entry => entry.skill.name === 'required-tools'));
  assert.equal(catalog.entries.find(entry => entry.skill.name === 'optional-tools').allowedTools, 'Read Bash(python:*)');
  assert.ok(catalog.diagnostics.some(d => d.code === 'allowed-tools-unavailable' && d.severity === 'warning'));
  assert.ok(catalog.diagnostics.some(d => d.code === 'tool-patterns-advisory'));
  assert.ok(catalog.diagnostics.some(d => d.code === 'unavailable-tools' && d.path.includes('required-tools')));
});

test('openai.yaml policy combines conservatively with Pi flags and does not connect dependencies', async t => {
  const root = await fixture(t);
  const openai = await skill(root, 'openai-explicit');
  await policy(openai, 'policy:\n  allow_implicit_invocation: false\ndependencies:\n  tools:\n    - type: mcp\n      value: github\n');
  const pi = await skill(root, 'pi-explicit', 'disable-model-invocation: true\n');
  await policy(pi, 'policy:\n  allow_implicit_invocation: true\n');
  const implicit = await skill(root, 'implicit-method'); await policy(implicit, 'interface:\n  display_name: Optional label\n');
  const catalog = await catalogFor(root, 'designer', [openai, pi, implicit]);
  for (const name of ['openai-explicit', 'pi-explicit']) assert.equal(catalog.entries.find(e => e.skill.name === name).skill.disableModelInvocation, true);
  assert.equal(catalog.entries.find(e => e.skill.name === 'implicit-method').skill.disableModelInvocation, false);
  const disclosed = formatSkillsForPrompt(catalog.entries.map(e => e.skill));
  assert.doesNotMatch(disclosed, /<name>(openai-explicit|pi-explicit)<\/name>/);
  assert.match(disclosed, /implicit-method/);
  assert.ok(catalog.diagnostics.some(d => d.code === 'dependencies-unverified'));
});

test('invalid, escaping and dangling invocation policies cannot silently enable automatic loading', async t => {
  const root = await fixture(t);
  const invalid = await skill(root, 'invalid-policy'); await policy(invalid, 'policy:\n  allow_implicit_invocation: "false"\n');
  const malformed = await skill(root, 'malformed-policy'); await policy(malformed, 'policy: [unterminated\n');
  const outside = join(root, 'outside.yaml'); await writeFile(outside, 'policy:\n  allow_implicit_invocation: false\n');
  const escaping = await skill(root, 'escaping-policy'); await mkdir(join(escaping, 'agents')); await symlink(outside, join(escaping, 'agents/openai.yaml'));
  const dangling = await skill(root, 'dangling-policy'); await mkdir(join(dangling, 'agents')); await symlink(join(root, 'missing.yaml'), join(dangling, 'agents/openai.yaml'));
  const catalog = await catalogFor(root, 'designer', [invalid, malformed, escaping, dangling]);
  assert.ok(!catalog.entries.some(e => [invalid, malformed, escaping, dangling].includes(e.skill.baseDir)));
  assert.equal(catalog.diagnostics.filter(d => d.code === 'invalid-invocation-policy').length, 4);
});

test('missing or replaced optional roots do not break unrelated reads or expand approval', async t => {
  const root = await fixture(t), run = join(root, 'run'); await mkdir(run);
  const optional = await skill(root, 'optional-method');
  await writeFile(join(run, 'evidence.md'), 'Valid project evidence');
  const catalog = await catalogFor(run, 'designer', [optional]);
  const reader = createScopedSkillReadTool({ root: run, catalog, sessionId: () => 'isolation' });
  await rm(optional, { recursive: true });
  assert.match((await reader.execute('normal', { path: join(run, 'evidence.md') })).content[0].text, /Valid project evidence/);
  assert.match((await reader.execute('builtin', { path: catalog.entries.find(e => e.source === 'builtin').skill.filePath })).content[0].text, /---/);
  const replacement = join(root, 'replacement'); await mkdir(replacement); await writeFile(join(replacement, 'private.md'), 'Unapproved replacement');
  await symlink(replacement, optional);
  await assert.rejects(reader.execute('replaced', { path: join(optional, 'private.md') }), /outside/);
  assert.match((await reader.execute('still-normal', { path: join(run, 'evidence.md') })).content[0].text, /Valid project evidence/);
});

test('only leading human directives select knowledge; explicit reads enforce role, hash, policy and audit', async t => {
  assert.deepEqual(requestedSkillNames('  $one-method\n/skill:two-method $one-method\nDesign this'), ['one-method', 'two-method']);
  for (const request of ['Discuss $one-method', '```\n$one-method\n```', 'Evidence says /skill:one-method']) assert.deepEqual(requestedSkillNames(request), []);
  const root = await fixture(t), run = join(root, 'run'); await mkdir(run);
  const dir = await skill(root, 'explicit-method', '', 'Evidence anchor.\n' + 'Complete knowledge.\n'.repeat(4000) + 'End of knowledge.');
  await policy(dir, 'policy:\n  allow_implicit_invocation: false\n');
  const catalog = await catalogFor(run, 'designer', [dir]);
  const entry = catalog.entries.find(e => e.skill.name === 'explicit-method');
  const reader = createScopedSkillReadTool({ root: run, catalog, sessionId: () => 'explicit' });
  await assert.rejects(reader.execute('guess', { path: entry.skill.filePath }), /outside|explicit/);
  assert.equal(await explicitSkillInstructions({ root: run, catalog, request: 'Do not select $explicit-method', sessionId: 'explicit' }), '');
  const instructions = await explicitSkillInstructions({ root: run, catalog, request: '$explicit-method design this', sessionId: 'explicit' });
  assert.match(instructions, /Evidence anchor/); assert.match(instructions, /End of knowledge/);
  const records = (await readFile(join(run, 'sessions/designer/skills/skill-activations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1); assert.equal(records[0].invocation, 'explicit'); assert.equal(records[0].digest, entry.digest);
  const other = await catalogFor(run, 'builder');
  assert.equal(await explicitSkillInstructions({ root: run, catalog: other, request: '$explicit-method', sessionId: 'other-role' }), '');
  await policy(dir, 'policy:\n  allow_implicit_invocation: true\n');
  await assert.rejects(explicitSkillInstructions({ root: run, catalog, request: '$explicit-method', sessionId: 'explicit' }), /policy changed/);
  await policy(dir, 'policy:\n  allow_implicit_invocation: false\n');
  await writeFile(join(dir, 'SKILL.md'), 'Modified knowledge');
  await assert.rejects(explicitSkillInstructions({ root: run, catalog, request: '$explicit-method', sessionId: 'explicit' }), /changed after catalog/);
});

test('wrapped human requests inject explicit-only knowledge through a real Pi session with no extra tools', async t => {
  const { createServer } = await import('node:http');
  const root = await fixture(t), run = join(root, 'run'); await mkdir(run);
  const dir = await skill(root, 'explicit-method', '', 'The campaign recognition anchor is a blue observatory.');
  await policy(dir, 'policy:\n  allow_implicit_invocation: false\n');
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); calls++;
    assert.doesNotMatch(data.messages.find(m => m.role === 'system').content, /<name>explicit-method<\/name>/);
    const user = data.messages.filter(m => m.role === 'user').at(-1).content;
    assert.match(JSON.stringify(user), /blue observatory/);
    assert.match(JSON.stringify(user), /User request:/);
    assert.ok(data.tools.every(tool => tool.function.name === 'read'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'explicit', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: '# Observatory concept' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const env = { DREAMATIC_API_KEY: 'fixture', DREAMATIC_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, DREAMATIC_MODEL: 'fixture', DREAMATIC_CONTEXT_WINDOW: '32768', DREAMATIC_MAX_TOKENS: '8192', DREAMATIC_SKILL_PATHS: JSON.stringify({ designer: [dir] }) };
  const { session, prompt } = await createDreamaticAgent({ root: run, role: 'designer', systemPrompt: 'Return design.md.', skillRequest: '/skill:explicit-method Design this campaign', tools: [], env });
  t.after(() => session.dispose());
  await prompt('User request:\n/skill:explicit-method Design this campaign\n\nPrevious research: supplied evidence.');
  assert.equal(calls, 1); assert.match(session.getLastAssistantText(), /Observatory concept/);
  const events = (await readFile(join(run, 'sessions/designer/skills/skill-activations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].invocation, 'explicit'); assert.equal(events[0].sessionId, session.sessionId);
});
