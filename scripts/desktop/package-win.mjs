import { syncReleaseVersion } from './version.mjs';
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('The Windows x64 installer must be packaged on a 64-bit Windows computer.');
}

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

async function run(bin, args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(bin, args, { cwd: root, env: process.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${bin} exited ${code}`)));
  });
}

const version = await syncReleaseVersion(root);
const output = join(root, 'release', `DreamaticArt-${version}-windows-x64-setup.exe`);
await rm(output, { force: true });
await rm(`${output}.sha256`, { force: true });

await run(process.execPath, [
  join(root, 'node_modules/electron-builder/cli.js'),
  '--config', 'apps/desktop/builder-win.cjs', '--win', '--x64',
]);

const unpacked = join(root, 'release/win-unpacked');
await run(process.execPath, [join(root, 'scripts/desktop/verify-win.mjs'), unpacked, output, version]);
const hash = createHash('sha256').update(await readFile(output)).digest('hex');
await writeFile(`${output}.sha256`, `${hash}  ${basename(output)}\n`);
console.log(`Installer: ${output}`);
