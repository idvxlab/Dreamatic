import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { researchAcquisition, specialistStageContract } from '../dist/workflow-contract.js';
import { unifiedContextPrompt, unifiedContextInstruction } from '../dist/context-model.js';
import { prepareContextCommit, contextChangesExample, prepareContextChanges, contextUpdateDescription, roleContextChangesSchema } from '../dist/context-tools.js';
import { normalizeDesignBusArguments, specialistRunAssignment } from '../dist/extension.js';

test('old handoff filenames become canonical field references without rewriting unrelated paths', () => {
  const prompt = unifiedContextPrompt('报告（research-findings.md）; evidence.json; research/evidence.json; other/evidence.json');
  assert.equal(prompt, '报告（context/research.json (findings)）; context/research.json (evidence); context/research.json (evidence); other/evidence.json');
  assert.match(specialistStageContract('builder'), /build_finalize.*do not call design_bus_post/s);
  assert.match(specialistStageContract('reviewer'), /Check evidence support.*even for concepts/);
  assert.match(specialistRunAssignment('/tmp/workspace', 'demo', 'designer'), /Only update_design_context and commit_design_context omit runId/);
});

test('obsolete empty commit wrapper is safe but nonempty content and ambiguous envelopes are rejected', () => {
  for (const input of [{}, {changes:'{}'}, {changes:{}}]) assert.deepEqual(prepareContextCommit(input), {});
  for (const input of [{changes:{findings:'new content'}}, {changes:'{}',runId:'foreign'}, {changes:' { } '}, [], '{}', null]) assert.throws(() => prepareContextCommit(input), /takes exactly/);
  assert.throws(() => normalizeDesignBusArguments({payload:'{"type":"design_review_pass","summary":"pass"}'}, 'demo', 'reviewer'), /missing root fields: type, summary/);
});

test('current persona, stage handoff, loaded system Skill and tool schema share one authoring protocol', async () => {
  const repo = new URL('../../../', import.meta.url);
  for (const role of ['researcher','designer','reviewer']) {
    const md=await readFile(new URL(`.pi/agents/${role}.md`,repo),'utf8');
    const prompt=unifiedContextPrompt(md)+'\n'+unifiedContextInstruction(role,2)+'\n'+specialistStageContract(role,2)+'\n'+contextUpdateDescription(role,2);
    assert.doesNotMatch(prompt,/save_design_context|patch_design_context|expectedSha256|Author three JSON files|Tool arguments are `\{runId, path, data\}`/);
    assert.doesNotThrow(()=>prepareContextChanges(contextChangesExample(role),role,2));
  }
  const stage=specialistStageContract('designer',2);
  assert.match(stage,/design_context_validate is an optional/);
  assert.doesNotMatch(stage,/Commit \{\}, validate|missing interaction outcomes|replaceTasks/);
  const skill=await readFile(new URL('.pi/skills/design-system/SKILL.md',repo),'utf8');
  assert.match(skill,/inside `changes.system`/);
  assert.doesNotMatch(skill,/`runId`|write_json|plan\/design_system.json/);
  const schema=roleContextChangesSchema('designer',2);
  for(const field of ['consistency_rules','asset_rules','consistency_anchor','prohibited']) {
    assert.ok(schema.properties.system.properties[field]);
    assert.equal(schema.properties[field],undefined);
  }
});

test('acquisition gaps survive handoff and a successful recovery resolves only the recovered URL', async () => {
  const run = await mkdtemp(join(tmpdir(),'dreamatic-acquisition-'));
  try {
    assert.equal((await researchAcquisition(run)).fetchedSourceCount, 0);
    await mkdir(join(run,'research/batches'),{recursive:true});
    const failed = [{ok:false,url:'https://a.invalid',error:'getaddrinfo ENOTFOUND'}, {ok:false,url:'https://b.invalid',error:'HTTP 403'}, {ok:false,url:'https://c.invalid',error:'Connect Timeout Error'}, {ok:true,url:'https://good.invalid'}];
    await writeFile(join(run,'research/batches/a.json'),JSON.stringify(failed));
    const before = await researchAcquisition(run);
    assert.equal(before.fetchedSourceCount,1);
    assert.deepEqual(before.unavailableSources.map(s=>s.failureKind),['dns','http','timeout']);
    assert.match(before.instruction,/not factual verification/);
    await writeFile(join(run,'research/batches/b.json'),JSON.stringify([{ok:true,url:'https://a.invalid'}, {ok:true,url:'https://good.invalid'}]));
    const after = await researchAcquisition(run);
    assert.equal(after.fetchedSourceCount,2);
    assert.equal(after.hasFetchGaps,true);
    assert.deepEqual(after.unavailableSources.map(s=>s.url),['https://b.invalid','https://c.invalid']);
    // The batch filename order cannot undo a known successful acquisition.
    await writeFile(join(run,'research/batches/z.json'),JSON.stringify([{ok:false,url:'https://a.invalid',error:'timeout'}]));
    assert.equal((await researchAcquisition(run)).unavailableSources.length,2);
    await writeFile(join(run,'research/batches/broken.json'),'{partial');
    const damaged = await researchAcquisition(run);
    assert.equal(damaged.observationsComplete,false);
    assert.equal(damaged.fetchedSourceCount,2);
    assert.equal(damaged.observationErrors.length,1);
  } finally { await rm(run,{recursive:true,force:true}); }
});
