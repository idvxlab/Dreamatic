import { syncReleaseVersion } from './version.mjs';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
async function run(bin, args) {
  await new Promise((resolve, reject) => { const child = spawn(bin, args, { cwd: root, stdio: 'inherit' }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}`))); });
}
const version = await syncReleaseVersion(root);
// Use the host's DMG tool: no additional packaging binary needs to be downloaded.
await run(process.execPath, [join(root, 'node_modules/electron-builder/cli.js'), '--config', 'apps/desktop/builder.cjs', '--mac', '--arm64', '--dir']);
const output = join(root, 'release', `DreamaticArt-${version}-mac-arm64.dmg`);
const temporary = await mkdtemp(join(root, 'release', '.package-'));
const stage = join(temporary, 'contents');
const candidate = join(temporary, `DreamaticArt-${version}-mac-arm64.dmg`);
await mkdir(stage);
try {
  await run('/usr/bin/ditto', [join(root, 'release/mac-arm64/DreamaticArt.app'), join(stage, 'DreamaticArt.app')]);
  await symlink('/Applications', join(stage, 'Applications'));
  await run('/usr/bin/hdiutil', ['create', '-volname', 'DreamaticArt', '-srcfolder', stage, '-ov', '-format', 'UDZO', candidate]);
  await run('/usr/bin/hdiutil', ['verify', candidate]);
  await run(process.execPath, [join(root, 'scripts/desktop/verify.mjs'), candidate, version]);
  const hash = createHash('sha256').update(await readFile(candidate)).digest('hex');
  await writeFile(`${candidate}.sha256`, `${hash}  ${output.split('/').at(-1)}\n`);
  // Replace the previous release only after all checks pass.
  await rename(candidate, output);
  await rename(`${candidate}.sha256`, `${output}.sha256`);
  console.log(`Installer: ${output}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
