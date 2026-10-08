import { _electron } from 'playwright-core';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const dataDir = await mkdtemp('/private/tmp/dreamatic-desktop-ui-');
let app, originalClipboard;
const previewServer = createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<button onclick="this.textContent=123">Preview interaction</button>');
});
await new Promise(resolve => previewServer.listen(0, '127.0.0.1', resolve));
const previewUrl = `http://127.0.0.1:${previewServer.address().port}/${'b'.repeat(48)}/artifacts/index.html`;
try {
  app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [join(root, 'apps/desktop')], env: { ...process.env, DREAMATIC_DESKTOP_TEST_DATA: dataDir } });
  app.process().stderr.on('data', data => process.stderr.write(data));
  const page = await app.firstWindow();
  await page.waitForLoadState();
  await page.bringToFront();
  await page.getByRole('button', { name: 'DreamaticArt menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: '/private/tmp/dreamatic-desktop-settings.png' });
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await page.getByRole('tab', { name: 'Image model', exact: true }).click();
  await page.getByRole('textbox', { name: 'Image model', exact: true }).fill('desktop-image-model');
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await page.getByText('Settings saved and applied', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => fetch('/api/health').then(response => response.json()))).imageModel, 'desktop-image-model');
  await page.getByRole('button', { name: 'DreamaticArt menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'System parameters', exact: true }).click();
  await page.getByRole('textbox', { name: 'Workspace directory', exact: true }).fill('./new-workspace');
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.settings-modal') && document.body.innerText.includes('New project'));
  assert.equal((await page.evaluate(() => fetch('/api/health').then(response => response.json()))).workspaceDir, join(dataDir, 'new-workspace'));

  const publicationLink = 'https://www.dreamatic.art/gallery-assets/published-desktop/artifacts/00-gallery.html';
  originalClipboard = await app.evaluate(({ clipboard, shell }) => {
    const previous = clipboard.readText();clipboard.writeText('');
    shell.openExternal = async url => { globalThis.sharedExternalLink = url; };
    return previous;
  });
  const fixtureRun = { id:'share-fixture',sessionId:'share-session',title:'Desktop share fixture',status:'complete',stages:{build:'completed'},notes:[],documents:[],activity:[],agentSessions:[],assetCount:0,showcasePath:'runs/share-fixture/artifacts/00-gallery.html',presentation:{mode:'gallery',entry:'artifacts/00-gallery.html'} };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/stream')) { await route.fulfill({contentType:'text/event-stream',body:''});return; }
    const value = url.pathname === '/api/health' ? {ok:true} : url.pathname === '/api/sessions' ? [{id:'share-session',title:fixtureRun.title,running:false,messages:[],projectId:fixtureRun.id}] : url.pathname === '/api/runs' ? [fixtureRun] : url.pathname === '/api/runs/share-fixture' ? fixtureRun : url.pathname.endsWith('/publish') ? {site:'https://www.dreamatic.art',published:true,mayExist:true,inProgress:false,receipt:{projectId:'published-desktop',previewUrl:publicationLink,galleryUrl:'https://www.dreamatic.art/#gallery'}} : url.pathname.endsWith('/canvas') ? null : [];
    await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  });
  await page.route('**/assets/**', route => route.fulfill({contentType:'text/html',body:'<h1>Desktop preview</h1>'}));
  await page.reload();await page.getByRole('button',{name:'Preview',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.preview-actions button:last-child').disabled);
  await page.getByRole('button',{name:'Share',exact:true}).click();
  await page.getByText('Published project link copied',{exact:true}).waitFor();
  assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),publicationLink);
  assert.equal(await app.evaluate(()=>globalThis.sharedExternalLink),publicationLink);
  assert.equal(await page.evaluate(async()=>{try{await window.dreamaticDesktop.copyPublicationLink('javascript:alert(1)');return false;}catch{return true;}}),true);
  console.log('DESKTOP_SHARE_CLIPBOARD_EXTERNAL_BROWSER_OK');
  const nextWindow = app.waitForEvent('window');
  await page.evaluate(url => window.open(url, '_blank'), previewUrl);
  const preview = await nextWindow;
  await preview.waitForLoadState();
  assert.equal(preview.url(), previewUrl);
  await preview.getByRole('button', { name: 'Preview interaction' }).click();
  await preview.getByRole('button', { name: '123' }).waitFor();
  assert.equal(await preview.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await preview.evaluate(() => typeof window.dreamaticDesktop), 'undefined');
  await preview.close();
  const output = join(dataDir, 'export-test.zip');
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialogSync = () => path; }, output);
  await page.evaluate(() => { const blob = new Blob([new Uint8Array([80,75,3,4,1,2,3])], { type: 'application/zip' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'export-test.zip'; a.click(); });
  await page.waitForTimeout(1000);
  assert.deepEqual([...await readFile(output)], [80,75,3,4,1,2,3]);
  console.log('DESKTOP_SETTINGS_PREVIEW_EXPORT_OK');
} catch (error) {
  console.error('Desktop service diagnostics:', await readFile(join(dataDir, 'desktop.log'), 'utf8').catch(() => 'Log unavailable'));
  throw error;
} finally { if(app && originalClipboard !== undefined) await app.evaluate(({clipboard},value)=>clipboard.writeText(value),originalClipboard).catch(()=>{});await app?.close(); await new Promise(resolve => previewServer.close(resolve)); await rm(dataDir, { recursive: true, force: true }); }
