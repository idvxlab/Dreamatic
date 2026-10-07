import { syncReleaseVersion } from './version.mjs';
import { cp, mkdir, readFile, writeFile, rm, chmod, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const stage = join(root, '.desktop-runtime');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This package target is macOS arm64. Build on an Apple Silicon Mac.');
async function run(bin, args, env = {}) {
  await new Promise((res, rej) => { const p = spawn(bin, args, { cwd: stage, env: { ...process.env, ...env }, stdio: 'inherit', timeout: 300000 }); p.once('error', rej); p.once('exit', code => code === 0 ? res() : rej(new Error(`${bin} exited ${code}`))); });
}
await syncReleaseVersion(root);
await mkdir(stage, { recursive: true });
await run(process.execPath, [join(root, 'scripts/desktop/electron-runtime.mjs')]);
// Only approved source resources: never package developer secrets, runs, sessions or caches.
for (const path of ['.pi', 'apps/server/dist', 'apps/web/dist', 'packages/design-agent/dist', 'apps/cli/dist']) {
  await rm(join(stage, path), { recursive: true, force: true });
  await cp(join(root, path), join(stage, path), { recursive: true });
}
for (const path of ['package.json', 'package-lock.json', '.env.example', 'apps/server/package.json', 'apps/web/package.json', 'apps/cli/package.json', 'packages/design-agent/package.json']) {
  await mkdir(resolve(stage, path, '..'), { recursive: true });
  await cp(join(root, path), join(stage, path));
}
// Retain the source lockfile; dev/build dependencies are not part of the runtime.
const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
manifest.workspaces = ['apps/server', 'apps/web', 'apps/cli', 'packages/design-agent'];
await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--workspace=@dreamatic/server', '--workspace=@dreamatic/design-agent', '--workspace=@dreamatic/cli', '--include-workspace-root=false']);
// Pi's published package includes esbuild binaries for other platforms; retain only this target.
const esbuildPlatforms = join(stage, 'node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild');
for (const platform of await import('node:fs/promises').then(fs => fs.readdir(esbuildPlatforms))) {
  if (platform !== 'darwin-arm64') await rm(join(esbuildPlatforms, platform), { recursive: true, force: true });
}
await mkdir(join(stage, 'bin'), { recursive: true });
const nodeVersion = 'v24.14.0';
const archive = `node-${nodeVersion}-darwin-arm64.tar.gz`;
const cache = join(stage, '.downloads');
await mkdir(cache, { recursive: true });
async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Download failed: ${url}: ${response.status}`);
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}
const archivePath = join(cache, archive);
try { await access(archivePath); } catch { await download(`https://nodejs.org/dist/${nodeVersion}/${archive}`, archivePath); }
const checksums = await fetch(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30000) }).then(r => { if (!r.ok) throw new Error('Node checksum download failed'); return r.text(); });
const expected = checksums.split('\n').find(line => line.endsWith(`  ${archive}`))?.split(' ')[0];
if (!expected || createHash('sha256').update(await readFile(archivePath)).digest('hex') !== expected) throw new Error('Bundled Node checksum mismatch');
await run('/usr/bin/tar', ['-xzf', archivePath, '-C', cache]);
await cp(join(cache, `node-${nodeVersion}-darwin-arm64/bin/node`), join(stage, 'bin/node'));
await chmod(join(stage, 'bin/node'), 0o755);
await cp(join(cache, `node-${nodeVersion}-darwin-arm64/LICENSE`), join(stage, 'NODE-LICENSE.txt'));
// Use Pi's own tool provisioning, without duplicating its resolver implementation.
const toolScript = `import { ensureTool } from './node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js'; import { copyFile, chmod } from 'node:fs/promises'; import { execFileSync } from 'node:child_process'; import { resolve } from 'node:path'; for (const name of ['rg', 'fd']) { const path = await ensureTool(name); if (!path) throw new Error('Missing '+name); const source = path.startsWith('/') ? path : execFileSync('/usr/bin/which', [path], { encoding: 'utf8' }).trim(); if (resolve(source) !== resolve('./bin/'+name)) await copyFile(source, './bin/'+name); await chmod('./bin/'+name, 0o755); }`;
await run(join(stage, 'bin/node'), ['--input-type=module', '-e', toolScript], { PI_CODING_AGENT_DIR: join(stage, '.tool-cache'), PATH: [join(stage, 'bin'), process.env.PATH, '/usr/bin', '/bin'].filter(Boolean).join(':') });
// Bundle the matching headless browser so HTML review needs no Chrome installation.
await run(join(stage, 'bin/node'), ['node_modules/playwright-core/cli.js', 'install', 'chromium-headless-shell'], { PLAYWRIGHT_BROWSERS_PATH: join(stage, 'browsers') });
await rm(join(stage, '.tool-cache'), { recursive: true, force: true });
await run(process.execPath, [join(root, 'scripts/desktop/icon.mjs')]);
console.log(`Desktop runtime prepared: ${stage}`);
