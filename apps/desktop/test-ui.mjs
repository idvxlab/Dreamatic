import { _electron } from 'playwright-core';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const dataDir = await mkdtemp('/private/tmp/dreamatic-desktop-ui-');
let app;
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
  await page.getByRole('button', { name: 'User menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: '/private/tmp/dreamatic-desktop-settings.png' });
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await page.keyboard.press('Escape');
  const nextWindow = app.waitForEvent('window');
  await page.evaluate(url => window.open(url, '_blank'), previewUrl);
  const preview = await nextWindow;
  await preview.waitForLoadState();
  assert.equal(preview.url(), previewUrl);
  await preview.getByRole('button', { name: 'Preview interaction' }).click();
  await preview.getByRole('button', { name: '123' }).waitFor();
  assert.equal(await preview.evaluate(() => typeof window.require), 'undefined');
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
} finally { await app?.close(); await new Promise(resolve => previewServer.close(resolve)); await rm(dataDir, { recursive: true, force: true }); }
