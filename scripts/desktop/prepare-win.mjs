import { syncReleaseVersion } from './version.mjs';
import { createWriteStream } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const stage = join(root, '.desktop-runtime-win-x64');
const downloads = join(stage, '.downloads');
const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This package target is Windows x64. Build it on a 64-bit Windows 10 or 11 computer.');
}

async function run(bin, args, env = {}, cwd = stage) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      timeout: 2100000,
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${bin} exited ${code}`)));
  });
}

async function runNpm(args) {
  if (process.env.npm_execpath) return run(process.execPath, [process.env.npm_execpath, ...args]);
  return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...args]);
}

async function download(url, destination) {
  const partial = `${destination}.partial`;
  await rm(partial, { force: true });
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'DreamaticArt-release' },
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('Response body is empty');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }));
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw new Error(`Download failed: ${url}: ${error.message}`, { cause: error });
  }
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function cachedDownload({ file, expected, sources }) {
  const destination = join(downloads, file);
  if (await sha256(destination).catch(() => '') !== expected) {
    await rm(destination, { force: true });
    for (const source of sources) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`Downloading ${file} from ${new URL(source).hostname} (attempt ${attempt}/2)`);
        try {
          await download(source, destination);
          if (await sha256(destination) !== expected) throw new Error(`SHA256 mismatch for ${file}`);
          break;
        } catch (error) {
          console.warn(error.message);
          await rm(destination, { force: true });
        }
      }
      if (await sha256(destination).catch(() => '') === expected) break;
    }
  }
  if (await sha256(destination).catch(() => '') !== expected) {
    throw new Error(`Unable to download a verified ${file}. Check internet access and rerun the release.`);
  }
  return destination;
}

async function extractZip(archive, destination, extractedPath) {
  await rm(extractedPath, { recursive: true, force: true });
  const tar = join(windowsRoot, 'System32', 'tar.exe');
  try {
    await run(tar, ['-xf', archive, '-C', destination]);
  } catch (tarError) {
    await rm(extractedPath, { recursive: true, force: true });
    const script = "& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
    try {
      await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, archive, destination]);
    } catch (powershellError) {
      throw new Error(`Unable to extract ${archive}: ${tarError.message}; ${powershellError.message}`);
    }
  }
}

await syncReleaseVersion(root);
await mkdir(downloads, { recursive: true });

// Keep verified downloads between builds, but reconstruct every packaged file.
for (const path of ['.pi', 'apps', 'packages', 'node_modules', 'bin', 'browsers', '.tool-cache', 'Dreamatic.ico', 'package.json', 'package-lock.json', '.env.example', 'NODE-LICENSE.txt']) {
  await rm(join(stage, path), { recursive: true, force: true });
}

// Only approved runtime resources are copied. Developer secrets, sessions,
// generated runs and caches never enter the installer.
for (const path of ['.pi', 'apps/server/prompts', 'apps/server/dist', 'apps/web/dist', 'packages/project-data/dist', 'apps/cli/dist']) {
  await cp(join(root, path), join(stage, path), { recursive: true });
}
for (const path of ['package.json', 'package-lock.json', '.env.example', 'apps/server/package.json', 'apps/web/package.json', 'apps/cli/package.json', 'packages/project-data/package.json']) {
  await mkdir(resolve(stage, path, '..'), { recursive: true });
  await cp(join(root, path), join(stage, path));
}

const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
manifest.workspaces = ['apps/server', 'apps/web', 'apps/cli', 'packages/project-data'];
await writeFile(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

await runNpm([
  'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
  '--workspace=@dreamatic/server', '--workspace=@dreamatic/project-data',
  '--workspace=@dreamatic/cli', '--include-workspace-root=false',
]);

const nodeVersion = 'v24.14.0';
const nodeArchive = `node-${nodeVersion}-win-x64.zip`;
const checksums = await fetch(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30000) })
  .then(response => { if (!response.ok) throw new Error('Node checksum download failed'); return response.text(); });
const expected = checksums.split('\n').find(line => line.endsWith(`  ${nodeArchive}`))?.split(' ')[0];
if (!expected) throw new Error(`Missing official checksum for ${nodeArchive}`);
const archive = await cachedDownload({ file: nodeArchive, expected, sources: [`https://nodejs.org/dist/${nodeVersion}/${nodeArchive}`] });
const extracted = join(downloads, `node-${nodeVersion}-win-x64`);
await extractZip(archive, downloads, extracted);
await mkdir(join(stage, 'bin'), { recursive: true });
await cp(join(extracted, 'node.exe'), join(stage, 'bin/node.exe'));
await cp(join(extracted, 'LICENSE'), join(stage, 'NODE-LICENSE.txt'));

// Pin and verify the same native tools Pi uses. Resolving "latest" through the
// GitHub redirect is unreliable behind some Windows proxies, and a release
// must not silently pick up a different binary between builds.
await run(join(stage, 'bin/node.exe'), ['node_modules/playwright-core/cli.js', 'install', 'chromium-headless-shell'], {
  PLAYWRIGHT_BROWSERS_PATH: join(stage, 'browsers'),
});
await rm(join(stage, '.tool-cache'), { recursive: true, force: true });

const browserDir = (await readdir(join(stage, 'browsers'))).find(name => name.startsWith('chromium_headless_shell-'));
if (!browserDir) throw new Error('Playwright did not install the Windows HTML review browser.');
await access(join(stage, 'browsers', browserDir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));

// Electron 44 exposes an explicit installer instead of downloading its binary
// during npm ci. Install and checksum-verify the host-native runtime now.
const electronExecutable = join(root, 'node_modules/electron/dist/electron.exe');
try {
  await access(electronExecutable);
} catch {
  const electronInstaller = join(root, 'node_modules/electron/install.js');
  const mirrors = [undefined, 'https://npmmirror.com/mirrors/electron/'];
  let lastError;
  for (const mirror of mirrors) {
    console.log(`Installing Electron for Windows from ${mirror ? new URL(mirror).hostname : 'the official release'}`);
    try {
      await run(process.execPath, [electronInstaller], mirror ? { ELECTRON_MIRROR: mirror } : {}, root);
      await access(electronExecutable);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      console.warn(error.message);
      await rm(join(root, 'node_modules/electron/dist'), { recursive: true, force: true });
      await rm(join(root, 'node_modules/electron/path.txt'), { force: true });
    }
  }
  if (lastError) throw new Error(`Unable to install the verified Windows Electron runtime: ${lastError.message}`);
}
await access(join(root, 'node_modules/electron/dist/electron.exe'));
await run(process.execPath, [join(root, 'scripts/desktop/icon-win.mjs')], {}, root);

console.log(`Windows x64 desktop runtime prepared: ${stage}`);
