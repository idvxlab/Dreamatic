import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const electron = join(root, 'node_modules/electron');
const { version } = JSON.parse(await readFile(join(electron, 'package.json'), 'utf8'));
const executable = 'Electron.app/Contents/MacOS/Electron';
async function installed() {
  try {
    return (await readFile(join(electron, 'dist/version'), 'utf8')).trim().replace(/^v/, '') === version
      && (await readFile(join(electron, 'path.txt'), 'utf8')).trim() === executable
      && await access(join(electron, 'dist', executable)).then(() => true);
  } catch { return false; }
}
async function run(bin, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit', timeout: 960000 });
    child.once('error', reject); child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${bin} failed (${signal || code})`)));
  });
}
if (!await installed()) {
  const file = `electron-v${version}-darwin-arm64.zip`;
  const checksums = JSON.parse(await readFile(join(electron, 'checksums.json'), 'utf8'));
  const expected = checksums[file];
  if (!expected) throw new Error(`The official Electron package has no checksum for ${file}`);
  const cache = join(root, '.desktop-runtime/.downloads');
  await mkdir(cache, { recursive: true });
  const archive = join(cache, file);
  const valid = async () => { try { return createHash('sha256').update(await readFile(archive)).digest('hex') === expected; } catch { return false; } };
  if (!await valid()) {
    const sources = [
      `https://npmmirror.com/mirrors/electron/${version}/${file}`,
      `https://github.com/electron/electron/releases/download/v${version}/${file}`,
    ];
    for (const source of sources) {
      console.log(`Downloading Electron ${version} from ${new URL(source).hostname}`);
      try {
        await run('/usr/bin/curl', ['--location', '--fail', '--connect-timeout', '15', '--max-time', '900', '--output', archive, source]);
        if (!await valid()) throw new Error('Electron SHA256 differs from the official package');
        break;
      } catch (error) { console.warn(error.message); await rm(archive, { force: true }); }
    }
  }
  if (!await valid()) throw new Error('Unable to download a verified Electron runtime. Check internet access and rerun the release.');
  await rm(join(electron, 'dist'), { recursive: true, force: true });
  await mkdir(join(electron, 'dist'), { recursive: true });
  await run('/usr/bin/ditto', ['-xk', archive, join(electron, 'dist')]);
  await writeFile(join(electron, 'path.txt'), executable);
  if (!await installed()) throw new Error('Electron runtime installation is incomplete');
  console.log(`Electron ${version} installed; official SHA256 verified.`);
}
