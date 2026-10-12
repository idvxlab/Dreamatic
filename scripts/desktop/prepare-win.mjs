import { syncReleaseVersion } from './version.mjs';
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

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
  const response = await fetch(url, { signal: AbortSignal.timeout(900000) });
  if (!response.ok) throw new Error(`Download failed: ${url}: ${response.status}`);
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function cachedDownload({ file, expected, sources }) {
  const destination = join(downloads, file);
  if (await sha256(destination).catch(() => '') !== expected) {
    await rm(destination, { force: true });
    for (const source of sources) {
      console.log(`Downloading ${file} from ${new URL(source).hostname}`);
      try {
        await download(source, destination);
        if (await sha256(destination) !== expected) throw new Error(`SHA256 mismatch for ${file}`);
        break;
      } catch (error) {
        console.warn(error.message);
        await rm(destination, { force: true });
      }
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
for (const path of ['.pi', 'apps/server/dist', 'apps/web/dist', 'packages/design-agent/dist', 'apps/cli/dist']) {
  await cp(join(root, path), join(stage, path), { recursive: true });
}
for (const path of ['package.json', 'package-lock.json', '.env.example', 'apps/server/package.json', 'apps/web/package.json', 'apps/cli/package.json', 'packages/design-agent/package.json']) {
  await mkdir(resolve(stage, path, '..'), { recursive: true });
  await cp(join(root, path), join(stage, path));
}

const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
manifest.workspaces = ['apps/server', 'apps/web', 'apps/cli', 'packages/design-agent'];
await writeFile(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

await runNpm([
  'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
  '--workspace=@dreamatic/server', '--workspace=@dreamatic/design-agent',
  '--workspace=@dreamatic/cli', '--include-workspace-root=false',
]);

for (const esbuildRoot of [
  join(stage, 'node_modules/@esbuild'),
  join(stage, 'node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild'),
]) {
  for (const platform of await readdir(esbuildRoot).catch(() => [])) {
    if (platform !== 'win32-x64') await rm(join(esbuildRoot, platform), { recursive: true, force: true });
  }
}
await access(join(stage, 'node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild/win32-x64/esbuild.exe'));

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

// Ask Pi to provision its own supported Windows tools, then freeze them into
// the application runtime so end users do not need rg or fd installed.
const toolScript = `import { ensureTool } from './node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js'; import { copyFile } from 'node:fs/promises'; import { execFileSync } from 'node:child_process'; import { isAbsolute, resolve } from 'node:path'; for (const name of ['rg', 'fd']) { let source = await ensureTool(name); if (!source) throw new Error('Missing '+name); if (!isAbsolute(source)) source = execFileSync('where.exe', [source], { encoding: 'utf8' }).split(/\\r?\\n/).find(Boolean); const destination = resolve('./bin/'+name+'.exe'); if (resolve(source) !== destination) await copyFile(source, destination); }`;
await run(join(stage, 'bin/node.exe'), ['--input-type=module', '-e', toolScript], {
  PI_CODING_AGENT_DIR: join(stage, '.tool-cache'),
  // Exclude developer-installed shims so Pi downloads self-contained tools
  // that remain valid after the runtime is copied to another computer.
  PATH: [join(stage, 'bin'), join(windowsRoot, 'System32')].join(';'),
});

await run(join(stage, 'bin/node.exe'), ['node_modules/playwright-core/cli.js', 'install', 'chromium-headless-shell'], {
  PLAYWRIGHT_BROWSERS_PATH: join(stage, 'browsers'),
});
await rm(join(stage, '.tool-cache'), { recursive: true, force: true });

const browserDir = (await readdir(join(stage, 'browsers'))).find(name => name.startsWith('chromium_headless_shell-'));
if (!browserDir) throw new Error('Playwright did not install the Windows HTML review browser.');
await access(join(stage, 'browsers', browserDir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
await access(join(root, 'node_modules/electron/dist/electron.exe'));
await run(process.execPath, [join(root, 'scripts/desktop/icon-win.mjs')], {}, root);

console.log(`Windows x64 desktop runtime prepared: ${stage}`);
