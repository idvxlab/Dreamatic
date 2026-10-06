#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run release:mac [-- --skip-install]\n\nBuild and verify the Apple Silicon macOS installer.\nRequires macOS arm64, Node >=22.19, npm, internet access and a logged-in desktop session.\n--skip-install reuses the already installed, locked development dependencies.\nVersion is read from apps/desktop/package.json; no Git or version changes are made.');
} else {
  let log;
  try {
    if (args.some(arg => arg !== '--skip-install')) throw new Error('Unknown option. Use --help.');
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Run this release on an Apple Silicon Mac (macOS arm64).');
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw new Error('Node.js 22.19 or newer is required.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = join(root, 'release', 'logs');
    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, `${stamp}.log`);
    log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
    log.on('error', error => { console.error(`Release log error: ${error.message}`); });
    const report = message => { console.log(message); log.write(`${message}\n`); };
    async function run(label, bin, argv) {
      report(`\n${label}`);
      await new Promise((resolve, reject) => {
        const child = spawn(bin, argv, { cwd: root, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] });
        child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
        child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
        child.once('error', reject);
        child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${label} failed (${signal || code}). See ${logPath}`)));
      });
    }
    if (!args.includes('--skip-install')) await run('1/7 Install locked dependencies', 'npm', ['ci', '--include=dev', '--no-audit', '--no-fund']);
    else report('1/7 Reuse installed dependencies (--skip-install)');
    await run('2/7 Build Web, CLI, server and design agents', 'npm', ['run', 'build']);
    await run('3/7 Check types', 'npm', ['run', 'check']);
    await run('4/7 Prepare the bundled Node, Pi tools, browser and icon', process.execPath, ['scripts/desktop/prepare.mjs']);
    const testDirs = ['apps/server/test', 'apps/web/test', 'packages/design-agent/test', 'apps/desktop/test'];
    const tests = (await Promise.all(testDirs.map(async directory => (await readdir(join(root, directory))).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(directory, name))))).flat();
    await run('5/7 Run regression and desktop lifecycle tests', process.execPath, ['--test', '--test-concurrency=2', ...tests]);
    await run('6/7 Check desktop Settings, Preview and Export', process.execPath, ['apps/desktop/test-ui.mjs']);
    await run('7/7 Package and verify the isolated read-only installer', process.execPath, ['scripts/desktop/package.mjs']);
    const { version } = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
    const installer = join(root, 'release', `DreamaticArt-${version}-mac-arm64.dmg`);
    report(`\nRelease complete\nInstaller: ${installer}\nSHA256: ${installer}.sha256\nLog: ${logPath}`);
  } catch (error) {
    console.error(`Release failed: ${error.message}`);
    log?.write(`\nRelease failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally { if (log) await new Promise(resolve => log.end(resolve)); }
}
