import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runtime = join(root, '.desktop-runtime-win-x64');
const browserDir = (await readdir(join(runtime, 'browsers'))).find(name => name.startsWith('chromium_headless_shell-'));
if (!browserDir) throw new Error('The Windows icon renderer browser is missing.');
const browserPath = join(runtime, 'browsers', browserDir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
const temporary = await mkdtemp(join(tmpdir(), 'dreamatic-windows-icon-'));
const pngPath = join(temporary, 'Dreamatic.png');
const browser = await chromium.launch({ executablePath: browserPath, headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  const svg = await readFile(join(root, 'apps/desktop/assets/icon.svg'), 'utf8');
  await page.setContent(`<style>html,body{margin:0;width:256px;height:256px;background:transparent}svg{display:block;width:256px!important;height:256px!important}</style>${svg}`);
  await page.screenshot({ path: pngPath, omitBackground: true });
  const image = await readFile(pngPath);

  // ICO permits a PNG-compressed 256 px RGBA entry. This covers the app,
  // shortcuts, Add/Remove Programs and the NSIS installer.
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 0;
  header[7] = 0;
  header[8] = 0;
  header[9] = 0;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(image.length, 14);
  header.writeUInt32LE(header.length, 18);
  await writeFile(join(runtime, 'Dreamatic.ico'), Buffer.concat([header, image]));
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
