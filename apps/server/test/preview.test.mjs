import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PreviewService } from '../dist/preview-service.js';
import { assetInventory, runInventory } from '../dist/run-store.js';
import { browserExecutable } from '../../../packages/design-agent/dist/html-delivery.js';
const hash = (source) => createHash('sha256').update(source).digest('hex');
async function fixture(workspace, mode = 'html') {
  const runDir = join(workspace, 'runs/demo');
  const files = { 'artifacts/ui/index.html': '<html><head><title>Page</title></head><body><button id="toggle">Turn on</button><p id="status">Off</p><script src="app.js"></script></body></html>', 'artifacts/ui/details.html': '<html><title>Details</title></html>', 'artifacts/ui/app.js': 'document.body.dataset.loaded="true";document.querySelector("#toggle").addEventListener("click",()=>document.querySelector("#status").textContent="On");', 'plan/html/ui/index.html': '<html>Design source</html>', '.performance/html-stage/fake.html': 'Private staging' };
  const receipts = {};
  for (const [path, source] of Object.entries(files)) { await mkdir(join(runDir, path, '..'), { recursive: true }); await writeFile(join(runDir, path), source); if (path.startsWith('artifacts/')) receipts[path] = hash(source); }
  const manifest = { schemaVersion: 2, presentation: { mode, entry: mode === 'html' ? 'artifacts/ui/index.html' : 'artifacts/00-gallery.html' }, previewFiles: Object.keys(receipts), htmlEntries: ['artifacts/ui/index.html', 'artifacts/ui/details.html'], artifacts: [] };
  const source = JSON.stringify(manifest);
  await writeFile(join(runDir, 'artifacts/artifact-manifest.json'), source);
  receipts['artifacts/artifact-manifest.json'] = hash(source);
  await writeFile(join(runDir, 'run-state.json'), JSON.stringify({ status: 'complete', stages: { build: 'completed' } }));
  await writeFile(join(runDir, 'brief.json'), JSON.stringify({ runId: 'demo', title: 'UI project' }));
  await writeFile(join(runDir, 'bus.jsonl'), JSON.stringify({ type: 'build_done', commitReceipt: { files: receipts } }) + '\n');
  return runDir;
}

test('isolated preview serves only committed pages/resources and revokes changed outputs or revisions', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-preview-'));
  const service = new PreviewService(workspace);
  try {
    const runDir = await fixture(workspace);
    const preview = await service.open('demo');
    assert.equal(preview.entries.length, 2);
    const response = await fetch(preview.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const js = new URL('app.js', preview.url).href;
    assert.match((await fetch(js)).headers.get('content-type'), /javascript/);
    assert.equal((await fetch(new URL('../../brief.json', preview.url))).status, 404);
    await assert.rejects(service.open('demo', 'artifacts/ui/app.js'), /Unknown/);
    await writeFile(join(runDir, 'artifacts/ui/app.js'), 'Changed');
    assert.equal((await fetch(js)).status, 404);
    await writeFile(join(runDir, 'run-state.json'), JSON.stringify({ stages: { build: 'pending' } }));
    assert.equal((await fetch(preview.url)).status, 404);
    await assert.rejects(service.open('demo'), /completed/);
  } finally { await service.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('mixed delivery supports independent page entries and keeps source/staging files out of asset inventory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-mixed-preview-'));
  const service = new PreviewService(workspace);
  try {
    await fixture(workspace, 'gallery');
    const page = await service.open('demo', 'artifacts/ui/details.html');
    assert.match(await (await fetch(page.url)).text(), /Details/);
    const assets = await assetInventory(workspace, 'demo');
    assert.equal(assets.some((asset) => asset.path.includes('plan/html') || asset.path.includes('.performance')), false);
    assert.ok(assets.some((asset) => asset.path.endsWith('artifacts/ui/details.html')));
    const runs = await runInventory(workspace, { summary: true });
    assert.deepEqual(runs[0].htmlEntries, ['artifacts/ui/index.html', 'artifacts/ui/details.html']);
    assert.equal(runs[0].presentation.mode, 'gallery');
  } finally { await service.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('real browser runs local interactions inside the product scripts-only iframe sandbox', async (t) => {
  const executablePath = await browserExecutable();
  if (!executablePath) { t.skip('Chromium unavailable'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-sandbox-preview-'));
  const service = new PreviewService(workspace);
  let browser;
  try {
    await fixture(workspace);
    const preview = await service.open('demo');
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.setContent(`<iframe title="prototype" src="${preview.url}" sandbox="allow-scripts"></iframe>`);
    const frame = page.frameLocator('iframe');
    await frame.locator('#toggle').click();
    assert.equal(await frame.locator('#status').textContent(), 'On');
    const child = page.frames().find((frame) => frame.url() === preview.url);
    assert.equal(await child.evaluate(() => { try { document.cookie; return false; } catch { return true; } }), true);
  } finally { await browser?.close(); await service.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('isolated HTML preview permits an explicit local document download while retaining opaque origin',async(t)=>{
  const executablePath=await browserExecutable();if(!executablePath){t.skip('Chromium unavailable');return;}
  const workspace=await mkdtemp(join(tmpdir(),'dreamatic-user-document-preview-'));
  const service=new PreviewService(workspace);let browser;
  try{
    const runDir=await fixture(workspace);
    const document='artifacts/ui/brief.pdf',bytes='%PDF-1.7 User document';
    const source='artifacts/ui/index.html';
    const html=(await readFile(join(runDir,source),'utf8')).replace('</body>','<a download href="brief.pdf">Download brief</a></body>');
    await writeFile(join(runDir,source),html);await writeFile(join(runDir,document),bytes);
    const manifestPath=join(runDir,'artifacts/artifact-manifest.json');
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.previewFiles.push(document);
    const manifestBytes=JSON.stringify(manifest);await writeFile(manifestPath,manifestBytes);
    const event=JSON.parse((await readFile(join(runDir,'bus.jsonl'),'utf8')).trim());
    Object.assign(event.commitReceipt.files,{[source]:hash(html),[document]:hash(bytes),'artifacts/artifact-manifest.json':hash(manifestBytes)});
    await writeFile(join(runDir,'bus.jsonl'),JSON.stringify(event)+'\n');
    const preview=await service.open('demo');
    const response=await fetch(new URL('brief.pdf',preview.url));assert.match(response.headers.get('content-type'),/application\/pdf/);assert.match(response.headers.get('content-disposition'),/attachment/);assert.equal(await response.text(),bytes);
    const {chromium}=await import('playwright-core');browser=await chromium.launch({executablePath,headless:true});const page=await browser.newPage({acceptDownloads:true});
    await page.setContent(`<iframe src="${preview.url}" sandbox="allow-scripts allow-downloads"></iframe>`);
    const downloadEvent=page.waitForEvent('download');await page.frameLocator('iframe').getByRole('link',{name:'Download brief'}).click();const download=await downloadEvent;
    assert.equal(download.suggestedFilename(),'brief.pdf');assert.equal(await readFile(await download.path(),'utf8'),bytes);
    const child=page.frames().find(frame=>frame.url()===preview.url);assert.equal(await child.evaluate(()=>{try{document.cookie;return false;}catch{return true;}}),true);
  }finally{await browser?.close();await service.close();await rm(workspace,{recursive:true,force:true});}
});
