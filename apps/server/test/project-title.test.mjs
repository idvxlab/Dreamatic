import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workTitle, updateWorkTitle } from '../dist/project-title.js';

test('work names come from the reserved heading; unknown names preserve fallback naming', () => {
 assert.equal(workTitle('# **浮光 · Aurora**\n\n## Concept\nA lamp'), '浮光 · Aurora');
 for (const text of ['## Image: hero\n### Prompt\nA lamp', '# Design proposal\nDescription', '# 作品名称待定', '# TBD', '# '+ 'a'.repeat(121)]) assert.equal(workTitle(text), undefined);
});

test('saved work names update immediately, Designer takes precedence, manual names survive, replay is idempotent', async t => {
 const root = await mkdtemp(join(tmpdir(),'dreamatic-title-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const briefPath = join(root,'brief.json');
 await writeFile(briefPath,JSON.stringify({title:'Design a lamp',titleStatus:'temporary',brief:'Original request',sessionId:'session'}));
 assert.equal(await updateWorkTitle(root,'# Design proposal','designer'),undefined);
 assert.equal(JSON.parse(await readFile(briefPath)).title,'Design a lamp');
 assert.equal(await updateWorkTitle(root,'# Aurora','orchestrator'),'Aurora');
 assert.equal(await updateWorkTitle(root,'# 浮光','designer'),'浮光');
 const saved = await readFile(briefPath,'utf8');
 assert.equal(await updateWorkTitle(root,'# Aurora','orchestrator'),undefined);
 assert.equal(await updateWorkTitle(root,'# 浮光','designer'),undefined);
 assert.equal(await readFile(briefPath,'utf8'),saved);
 assert.equal(JSON.parse(saved).brief,'Original request');
 assert.equal(JSON.parse(saved).sessionId,'session');
 await writeFile(join(root,'project-display.json'),JSON.stringify({title:'My exhibition'}));
 assert.equal(await updateWorkTitle(root,'# 浮光 II','designer'),undefined);
 assert.equal(JSON.parse(await readFile(briefPath)).title,'浮光 II');
 assert.equal(JSON.parse(await readFile(join(root,'project-display.json'))).title,'My exhibition');
});
