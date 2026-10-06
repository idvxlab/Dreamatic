import { spawn } from 'node:child_process';
import { mkdtemp, rm, access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
const image = resolve(process.argv[2]);
const temp = await mkdtemp(join(tmpdir(), 'dreamatic-install-check-'));
const mount = join(temp, 'volume');
const { mkdir } = await import('node:fs/promises');
await mkdir(mount);
async function run(bin, args, env = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: temp, env: { ...process.env, ...env }, stdio: 'inherit', timeout: 90000 });
    child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${bin} failed (${code ?? signal})`)));
  });
}
let mounted = false;
try {
  await run('/usr/bin/hdiutil', ['attach', image, '-readonly', '-nobrowse', '-mountpoint', mount]); mounted = true;
  const app = join(mount, 'DreamaticArt.app');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const runtime = join(app, 'Contents/Resources/runtime');
  await access(join(runtime, 'node_modules/playwright-core/index.mjs'));
  await access(join(runtime, 'node_modules/@dreamatic/design-agent/dist/index.js'));
  try { await access(join(runtime, '.env')); throw new Error('Developer configuration must not be packaged'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await run(join(app, 'Contents/MacOS/DreamaticArt'), [], { DREAMATIC_DESKTOP_SMOKE: '1', DREAMATIC_DESKTOP_TEST_DATA: join(temp, 'data') });
  const browserDir = (await readdir(join(runtime, 'browsers'))).find(name => name.startsWith('chromium_headless_shell-'));
  const browser = join(runtime, 'browsers', browserDir, 'chrome-headless-shell-mac-arm64/chrome-headless-shell');
  const code = `import { chromium } from ${JSON.stringify(pathToFileURL(join(runtime, 'node_modules/playwright-core/index.mjs')).href)}; const browser = await chromium.launch({ executablePath: ${JSON.stringify(browser)}, headless: true }); try { const page = await browser.newPage(); await page.setContent('<button onclick="this.textContent=123">Test</button>'); await page.locator('button').click(); if (await page.locator('button').textContent() !== '123') throw Error('Browser interaction failure'); console.log('PACKAGED_HTML_BROWSER_OK'); } finally { await browser.close(); }`;
  await run(join(runtime, 'bin/node'), ['--input-type=module', '-e', code]);
  console.log('DMG_INSTALL_VERIFIED');
} finally {
  if (mounted) await run('/usr/bin/hdiutil', ['detach', mount]);
  await rm(temp, { recursive: true, force: true });
}
