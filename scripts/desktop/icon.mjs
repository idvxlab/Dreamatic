import { chromium } from 'playwright-core';
import { readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runtime = join(root, '.desktop-runtime');
const browserDir = (await readdir(join(runtime, 'browsers'))).find(name => name.startsWith('chromium_headless_shell-'));
const set = join(runtime, '.icon-build.iconset');
await mkdir(set, { recursive: true });
const browser = await chromium.launch({ executablePath: join(runtime, 'browsers', browserDir, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(`<style>body{margin:0;background:transparent}</style>${await readFile(join(root, 'apps/desktop/assets/icon.svg'), 'utf8')}`);
  const full = join(set, 'icon_512x512@2x.png');
  await page.screenshot({ path: full, omitBackground: true });
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
    const output = join(set, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
    if (output !== full) execFileSync('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), full, '--out', output], { stdio: 'ignore' });
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', join(runtime, 'Dreamatic.icns')]);
} finally { await browser.close(); await rm(set, { recursive: true, force: true }); }
