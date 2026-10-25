import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { projectFiles, projectFileContent, bibliography, renameProjectMedia } from '../dist/project-files.js';

test('file catalog preserves full documents, attachments, source metadata and project boundaries', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-files-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'runs', 'project');
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await mkdir(join(root, 'inputs', 'user-assets'), { recursive: true });
  const text = '# Research\n' + 'Full content. '.repeat(150) + '\n## References\n[1] Example study. https://example.org/study\n[2] Offline paper, 2020.\n';
  await writeFile(join(root, 'research.md'), text);
  const historicalContext = JSON.stringify({ schemaVersion: 1, status: 'collecting', revision: 0 });
  await writeFile(join(root, 'design-context.json'), historicalContext);
  await writeFile(join(root, 'inputs/user-assets/paper.pdf'), '%PDF-1.4');
  await writeFile(join(root, 'inputs/user-assets/note.txt'), 'Original upload');
  await writeFile(join(root, 'artifacts/work.mp4'), 'video');
  await writeFile(join(root, 'artifacts/portfolio.pdf'), '%PDF-1.4');
  await writeFile(join(root, 'pipeline-state.json'), '{"private":"internal"}');
  const original = JSON.stringify([{ name: 'Original image', mimeType: 'image/png', data: Buffer.from('image bytes').toString('base64') }]);
  await writeFile(join(root, 'attachments.json'), original);
  const files = await projectFiles(workspace, 'project');
  assert.ok(files.some(file => file.id === 'inputs/user-assets/paper.pdf' && file.group === 'Uploaded files'));
  assert.ok(files.some(file => file.id === 'artifacts/portfolio.pdf'));
  assert.ok(!files.some(file => file.id === 'pipeline-state.json' || file.id === 'attachments.json'));
  assert.ok(files.some(file => file.id === 'design-context.json' && file.category === 'context'));
  assert.equal((await projectFileContent(workspace, 'project', 'design-context.json')).data.toString(), historicalContext);
  assert.equal(await readFile(join(root, 'design-context.json'), 'utf8'), historicalContext);
  const refs = files.filter(file => file.category === 'references');
  assert.equal(refs.length, 2); assert.equal(refs[0].url, 'https://example.org/study'); assert.match(refs[1].metadata, /Offline paper/);
  assert.equal((await projectFileContent(workspace, 'project', 'research.md')).data.toString(), text);
  assert.equal((await projectFileContent(workspace, 'project', 'attachment:0')).data.toString(), 'image bytes');
  assert.equal(await readFile(join(root, 'attachments.json'), 'utf8'), original);
  await assert.rejects(projectFiles(workspace, '../project'), /Invalid run id/);
  await assert.rejects(projectFileContent(workspace, 'project', '../pipeline-state.json'));
  await assert.rejects(projectFileContent(workspace, 'project', 'pipeline-state.json'));
  const outside = join(workspace, 'outside.txt'); await writeFile(outside, 'private');
  await symlink(outside, join(root, 'inputs/user-assets/outside.txt'));
  assert.ok(!(await projectFiles(workspace, 'project')).some(file => file.id.includes('outside')));
  await assert.rejects(projectFileContent(workspace, 'project', 'inputs/user-assets/outside.txt'));
});
test('unified historical contexts expose virtual documents without writing projections', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-unified-')); t.after(() => rm(workspace, {recursive:true,force:true}));
  const root = join(workspace, 'runs', 'history'); await mkdir(join(root,'context'), {recursive:true});
  await writeFile(join(root,'context/project.json'),JSON.stringify({runId:'history',brief:{title:'History'}}));
  await writeFile(join(root,'context/research.json'),JSON.stringify({runId:'history',evidence:{sources:[{title:'Actual source',url:'https://example.org/source',year:2024}]},findings:'# Findings\nHistorical research',usageConditions:'Use with attribution'}));
  const files = await projectFiles(workspace,'history');
  assert.ok(files.some(file=>file.id==='research/research-findings.md'));
  assert.match((await projectFileContent(workspace,'history','research/research-findings.md')).data.toString(), /Historical research/);
  assert.ok(files.some(file=>file.category==='references'&&file.url==='https://example.org/source'&&file.metadata.includes('2024')));
  await assert.rejects(readFile(join(root,'research/research-findings.md')),{code:'ENOENT'});
  const before = files.find(file => file.id === 'research/research-findings.md').modifiedAt;
  const future = new Date(Date.now() + 2000);
  await utimes(join(root, 'context/research.json'), future, future);
  const updated = await projectFiles(workspace, 'history');
  assert.notEqual(updated.find(file => file.id === 'research/research-findings.md').modifiedAt, before);
});
test('bibliography keeps numbers and rejects unsafe URL schemes', () => {
  const refs=bibliography('## References\n[7] Safe https://example.org/a\n[9] javascript:alert(1)\n## Other\nUnrelated text','research.md');
  assert.equal(refs.length,2);assert.match(refs[0].title,/\[7\]/);assert.equal(refs[1].url,undefined);
});

test('HTTP file routes serve full text, typed media and named originals without exposing internal files', { timeout: 20000 }, async () => {
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const { resolve } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'dreamatic-file-http-'));
  let child;
  try {
    await writeFile(join(root, '.env'), 'DREAMATIC_PREVENT_IDLE_SLEEP=false\n');
    child = fork(resolve('apps/server/dist/index.js'), [], { cwd: root, env: { ...process.env, DREAMATIC_CONFIG_DIR: root, DREAMATIC_WORKSPACE: join(root, 'workspace'), DREAMATIC_DESKTOP: '1', PI_CODING_AGENT_DIR: join(root, 'pi') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.resume(); child.stderr.resume();
    const [ready] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Server exited before ready'); }), new Promise((_, reject) => setTimeout(() => reject(new Error('Startup timeout')), 10000).unref())]);
    const origin = `http://127.0.0.1:${ready.port}`;
    const session = await fetch(origin + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.json());
    const runRoot = join(root, 'workspace/runs', session.projectId);
    await mkdir(join(runRoot, 'inputs/user-assets'), { recursive: true });
    const original = '# Full intent\n' + 'Complete text\n'.repeat(200);
    await writeFile(join(runRoot, 'intent.md'), original);
    await writeFile(join(runRoot, 'inputs/user-assets/source.pdf'), '%PDF-1.4');
    await writeFile(join(runRoot, 'inputs/user-assets/clip.webm'), '0123456789');
    const api = `${origin}/api/runs/${session.projectId}/files`;
    const uploadUrl = `${origin}/api/runs/${session.projectId}/media?name=`;
    const uploaded = await fetch(uploadUrl + encodeURIComponent('New image.png'), {method:'POST',headers:{'Content-Type':'image/png'},body:Buffer.from('png-fixture')});
    assert.equal(uploaded.status,201); const receipt = await uploaded.json(); assert.match(receipt.id,/^inputs\/user-assets\/New-image-.+\.png$/);
    assert.equal(await readFile(join(runRoot,receipt.id),'utf8'),'png-fixture');
    const second = await fetch(uploadUrl + 'New%20image.png',{method:'POST',headers:{'Content-Type':'image/png'},body:'another'}).then(response=>response.json());assert.notEqual(second.id,receipt.id);
    assert.equal((await fetch(uploadUrl+'page.html',{method:'POST',body:'<html>no</html>'})).status,400);
    assert.equal((await fetch(uploadUrl+'empty.png',{method:'POST',headers:{'Content-Type':'image/png'},body:Buffer.alloc(0)})).status,400);
    assert.equal((await fetch(uploadUrl+'bad.png',{method:'POST',headers:{'Content-Type':'video/mp4'},body:'bad'})).status,400);
    const renamed = await fetch(`${origin}/api/runs/${session.projectId}/media/name`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:receipt.id,title:'Hero image'})});
    assert.equal(renamed.status,200);
    assert.equal((await fetch(api+'/content?id='+encodeURIComponent(receipt.id))).status,200);
    assert.equal(await readFile(join(runRoot,receipt.id),'utf8'),'png-fixture');
    const catalog = await fetch(api).then(response => response.json());
    assert.ok(catalog.some(file=>file.id===receipt.id&&file.group==='Uploaded files'&&file.title==='Hero image')); assert.ok(catalog.some(file => file.id === 'intent.md'));
    const text = await fetch(api + '/content?id=intent.md'); assert.equal(await text.text(), original); assert.match(text.headers.get('content-type'), /text\/plain/); assert.equal(text.headers.get('x-content-type-options'), 'nosniff');
    const pdf = await fetch(api + '/content?id=' + encodeURIComponent('inputs/user-assets/source.pdf')); assert.equal(pdf.headers.get('content-type'), 'application/pdf'); assert.match(pdf.headers.get('content-disposition'), /source.pdf/); assert.equal(await pdf.text(), '%PDF-1.4');
    assert.equal((await fetch(api + '/content?id=' + encodeURIComponent('../brief.json'))).status, 400);
    assert.equal((await fetch(api + '/content?id=brief.json')).status, 400);
    const videoUrl = api + '/content?id=' + encodeURIComponent('inputs/user-assets/clip.webm');
    const range = await fetch(videoUrl, { headers: { Range: 'bytes=2-5' } });
    assert.equal(range.status,206); assert.equal(range.headers.get('content-type'),'video/webm'); assert.equal(range.headers.get('content-range'),'bytes 2-5/10'); assert.equal(await range.text(),'2345');
    assert.equal((await fetch(videoUrl,{headers:{Range:'bytes=20-'}})).status,416);
    await writeFile(join(runRoot, 'research.md'), '## References\n[1] Private source http://127.0.0.1/private\n');
    const reader = `${origin}/api/runs/${session.projectId}/references/read?id=`;
    const denied = await fetch(reader + encodeURIComponent('citation:research.md:0'));
    assert.equal(denied.status, 400); assert.match((await denied.json()).error, /Only public/);
    const missing = await fetch(reader + encodeURIComponent('https://example.org/arbitrary'));
    assert.equal(missing.status, 400); assert.match((await missing.json()).error, /selected reference is unavailable/);
  } finally {
    if (child && child.exitCode === null) { const timer = setTimeout(() => child.kill('SIGKILL'), 3000); child.kill('SIGTERM'); await once(child, 'exit'); clearTimeout(timer); }
    await rm(root, { recursive: true, force: true });
  }
});

test('media display names persist without changing paths, bytes or generated references', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-names-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = join(workspace, 'runs', 'demo');
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(join(root, 'artifacts/photo.png'), 'original image');
  await writeFile(join(root, 'artifacts/page.html'), '<img src="photo.png">');
  await writeFile(join(root, 'attachments.json'), JSON.stringify([{ name: 'source.png', mimeType: 'image/png', data: Buffer.from('attached').toString('base64') }]));
  await Promise.all([
    renameProjectMedia(workspace, 'demo', 'artifacts/photo.png', '  主视觉  '),
    renameProjectMedia(workspace, 'demo', 'attachment:0', '参考图'),
  ]);
  const files = await projectFiles(workspace, 'demo');
  const photo = files.find(file => file.id === 'artifacts/photo.png');
  assert.equal(photo.title, '主视觉'); assert.equal(photo.originalName, 'photo.png'); assert.equal(photo.path, 'artifacts/photo.png');
  assert.equal(files.find(file => file.id === 'attachment:0').title, '参考图');
  const content = await projectFileContent(workspace, 'demo', photo.id);
  assert.equal(content.filename, 'photo.png'); assert.equal(content.data.toString(), 'original image');
  assert.equal(await readFile(join(root, 'artifacts/page.html'), 'utf8'), '<img src="photo.png">');
  await assert.rejects(renameProjectMedia(workspace, 'demo', photo.id, '  '));
  await assert.rejects(renameProjectMedia(workspace, 'demo', photo.id, 'a'.repeat(121)));
  await assert.rejects(renameProjectMedia(workspace, 'demo', 'artifacts/page.html', 'Page'));
  await assert.rejects(renameProjectMedia(workspace, 'demo', '../outside.png', 'Outside'));
  await renameProjectMedia(workspace, 'demo', photo.id, '参考图'); // Duplicate labels do not affect identity.
  assert.equal((await projectFileContent(workspace, 'demo', photo.id)).data.toString(), 'original image');
});
