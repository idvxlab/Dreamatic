import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.platform !== 'win32') throw new Error('Windows package verification must run on Windows.');

const require = createRequire(import.meta.url);
const { extractFile } = require('@electron/asar');
const unpacked = resolve(process.argv[2]);
const installer = resolve(process.argv[3]);
const expectedVersion = process.argv[4];
if (!expectedVersion) throw new Error('Expected release version is required.');

async function expectPortableExecutable(path) {
  const contents = await readFile(path);
  if (contents.length < 2 || contents[0] !== 0x4d || contents[1] !== 0x5a) {
    throw new Error(`Not a Windows PE executable: ${path}`);
  }
}

const resources = join(unpacked, 'resources');
const runtime = join(resources, 'runtime');
const application = join(unpacked, 'DreamaticArt.exe');
await expectPortableExecutable(application);
await expectPortableExecutable(join(runtime, 'bin/node.exe'));
await expectPortableExecutable(installer);
if ((await stat(installer)).size < 1024 * 1024) throw new Error('Windows installer is unexpectedly small.');

const browserDir = (await readdir(join(runtime, 'browsers'))).find(name => name.startsWith('chromium_headless_shell-'));
if (!browserDir) throw new Error('The packaged Windows HTML review browser is missing.');
await expectPortableExecutable(join(runtime, 'browsers', browserDir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
await access(join(runtime, 'node_modules/playwright-core/index.mjs'));
await access(join(runtime, 'node_modules/@dreamatic/project-data/dist/index.js'));

for (const forbidden of ['.env', '.downloads', '.tool-cache']) {
  try {
    await access(join(runtime, forbidden));
    throw new Error(`Developer/build-only content must not be packaged: runtime/${forbidden}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const appManifest = JSON.parse(extractFile(join(resources, 'app.asar'), 'package.json').toString('utf8'));
if (appManifest.version !== expectedVersion) {
  throw new Error(`Packaged version: expected ${expectedVersion}, got ${appManifest.version}`);
}

const smokeData = await mkdtemp(join(tmpdir(), 'dreamatic-windows-smoke-'));
try {
  const output = await new Promise((resolveSmoke, reject) => {
    const child = spawn(application, [], {
      env: { ...process.env, DREAMATIC_DESKTOP_SMOKE: '1', DREAMATIC_DESKTOP_TEST_DATA: smokeData },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });
    let text = '';
    child.stdout.on('data', data => { text += data; process.stdout.write(data); });
    child.stderr.on('data', data => { text += data; process.stderr.write(data); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged Windows application smoke test timed out.')); }, 120000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      code === 0 ? resolveSmoke(text) : reject(new Error(`Packaged Windows application exited ${code}.`));
    });
  });
  if (!output.includes('DREAMATIC_DESKTOP_SMOKE_OK')) throw new Error('Packaged Windows UI smoke marker was not emitted.');
} finally {
  await rm(smokeData, { recursive: true, force: true });
}

console.log(`PACKAGED_VERSION_OK: v${expectedVersion}`);
console.log('WINDOWS_RUNTIME_LAYOUT_OK');
console.log('WINDOWS_PACKAGED_APP_SMOKE_OK');
console.log('NSIS_INSTALLER_VERIFIED');
