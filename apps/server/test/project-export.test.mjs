import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { prepareProjectExport } from '../dist/project-export.js';
const exec = promisify(execFile);

async function fixture(t, mode) {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-export-test-'));
  t.after(() => rm(workspace, {recursive:true,force:true}));
  const runId = `project-${mode}`, run = join(workspace, 'runs', runId);
  const entry = mode === 'html' ? 'artifacts/home/index.html' : 'artifacts/00-gallery.html';
  const outputs = {
    [entry]: '<!doctype html><h1>Approved design</h1>',
    'artifacts/home/style.css': 'h1 {color:blue}',
    'artifacts/home/app.js': 'console.log("design")',
    'artifacts/home/image.jpg': 'fixture-image',
    'artifacts/artifact-manifest.json': JSON.stringify({schemaVersion:2,presentation:{mode,entry}}),
  };
  const receipt = {};
  for (const [path, bytes] of Object.entries(outputs)) {
    await mkdir(dirname(join(run,path)),{recursive:true}); await writeFile(join(run,path),bytes);
    receipt[path] = createHash('sha256').update(bytes).digest('hex');
  }
  for (const [path,bytes] of Object.entries({'brief.json':'{"title":"Test"}', 'run-state.json':'{"stages":{"build":"completed"}}','plan/design_plan.json':'{}','plan/html/home/index.html':'Designer source','research/findings.md':'Research','review/design-review.md':'Review','sessions/private.json':'Private','history/old.txt':'Old'})) {
    await mkdir(dirname(join(run,path)),{recursive:true}); await writeFile(join(run,path),bytes);
  }
  await writeFile(join(run,'bus.jsonl'),JSON.stringify({type:'build_done',commitReceipt:{files:receipt}})+'\n');
  return {workspace,runId,run,entry,outputs};
}
for (const mode of ['html','gallery']) test(`${mode} download ZIP includes complete source/resources and keeps approved output intact`, async (t) => {
  const f = await fixture(t, mode);
  const archive = await prepareProjectExport(f.workspace,f.runId); t.after(archive.cleanup);
  assert.equal(archive.filename, `${f.runId}.zip`);
  const {stdout:list} = await exec('unzip',['-Z1',archive.path]);
  for (const path of [f.entry,'artifacts/home/style.css','artifacts/home/app.js','artifacts/home/image.jpg','plan/html/home/index.html','research/findings.md','review/design-review.md','brief.json','index.html','package-manifest.json']) assert.ok(list.includes(`${f.runId}/${path}`),path);
  assert.doesNotMatch(list,/sessions|history|bus\.jsonl/);
  for (const [path,bytes] of Object.entries(f.outputs)) {
    assert.equal((await exec('unzip',['-p',archive.path,`${f.runId}/${path}`])).stdout,bytes);
    assert.equal(await readFile(join(f.run,path),'utf8'),bytes);
  }
  const manifest=JSON.parse((await exec('unzip',['-p',archive.path,`${f.runId}/package-manifest.json`])).stdout);
  assert.equal(manifest.entry,f.entry);
  assert.match((await exec('unzip',['-p',archive.path,`${f.runId}/index.html`])).stdout,new RegExp(f.entry));
  await archive.cleanup(); assert.equal(await stat(archive.path).then(()=>true).catch(()=>false),false);
});
test('export rejects pending builds, changed/missing committed output, traversal and symlinks',async(t)=>{
  const f=await fixture(t,'html');
  await assert.rejects(prepareProjectExport(f.workspace,'../project-html'),/Invalid run id/);
  await writeFile(join(f.run,'run-state.json'),'{"stages":{"build":"in_progress"}}');
  await assert.rejects(prepareProjectExport(f.workspace,f.runId),/completed build/);
  await writeFile(join(f.run,'run-state.json'),'{"stages":{"build":"completed"}}');
  await writeFile(join(f.run,f.entry),'Changed');
  await assert.rejects(prepareProjectExport(f.workspace,f.runId),/changed after approval/);
  await writeFile(join(f.run,f.entry),f.outputs[f.entry]);
  await rm(join(f.run,'artifacts/home/app.js'));
  await assert.rejects(prepareProjectExport(f.workspace,f.runId),/Committed build output is missing/);
  await writeFile(join(f.run,'artifacts/home/app.js'),f.outputs['artifacts/home/app.js']);
  await symlink(join(f.run,'brief.json'),join(f.run,'artifacts/linked.json'));
  await assert.rejects(prepareProjectExport(f.workspace,f.runId),/symbolic link/);
});
