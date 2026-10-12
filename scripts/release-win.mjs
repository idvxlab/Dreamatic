#!/usr/bin/env node
import { syncReleaseVersion } from './desktop/version.mjs';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log('Usage: npm run release:win [-- --skip-install] [-- --version X.Y.Z]\n\nBuild, run and verify the Windows x64 NSIS installer on Windows.\nRequires 64-bit Windows 10/11, Node >=22.19, npm, internet access and a logged-in desktop session.\n--skip-install reuses the already installed, locked development dependencies.\nVersion: --version, then a version-named Git branch, then package.json.\nSigning is automatic when electron-builder Windows signing credentials are provided.');
} else {
  let log;
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--skip-install') continue;
      if (args[i] === '--version' && args[i + 1]) { process.env.DREAMATIC_RELEASE_VERSION = args[++i]; continue; }
      throw new Error('Unknown or incomplete option. Use --help.');
    }
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      throw new Error('Run this release on a 64-bit Windows 10 or 11 computer. Use npm run release:mac on Apple Silicon macOS.');
    }
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 19)) throw new Error('Node.js 22.19 or newer is required.');

    await syncReleaseVersion(root);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logDir = join(root, 'release', 'logs');
    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, `${stamp}-windows.log`);
    log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
    log.on('error', error => { console.error(`Release log error: ${error.message}`); });
    const report = message => { console.log(message); log.write(`${message}\n`); };
    async function run(label, bin, argv) {
      report(`\n${label}`);
      await new Promise((resolveRun, reject) => {
        const child = spawn(bin, argv, { cwd: root, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] });
        child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
        child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
        child.once('error', reject);
        child.once('close', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${label} failed (${signal || code}). See ${logPath}`)));
      });
    }
    const runNpm = (label, argv) => process.env.npm_execpath
      ? run(label, process.execPath, [process.env.npm_execpath, ...argv])
      : run(label, process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...argv]);

    if (!args.includes('--skip-install')) await runNpm('1/7 Install locked dependencies', ['ci', '--include=dev', '--no-audit', '--no-fund']);
    else report('1/7 Reuse installed dependencies (--skip-install)');
    await runNpm('2/7 Build Web, CLI, server and design agents', ['run', 'build']);
    await runNpm('3/7 Check types', ['run', 'check']);
    await run('4/7 Prepare the bundled Windows Node, Pi tools, browser and icon', process.execPath, ['scripts/desktop/prepare-win.mjs']);
    const browserDir = (await readdir(join(root, '.desktop-runtime-win-x64', 'browsers'))).find(name => name.startsWith('chromium_headless_shell-'));
    if (!browserDir) throw new Error('Prepared Windows HTML review browser is missing.');
    const browser = join(root, '.desktop-runtime-win-x64', 'browsers', browserDir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
    process.env.DREAMATIC_HTML_BROWSER_EXECUTABLE = browser;
    process.env.DREAMATIC_DESKTOP_BROWSER = browser;
    const desktopTestDir = 'apps/desktop/test';
    const tests = (await readdir(join(root, desktopTestDir))).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(desktopTestDir, name));
    await run('5/7 Run Windows desktop lifecycle tests', process.execPath, ['--test', '--test-concurrency=1', ...tests]);
    await run('6/7 Check desktop Settings, Preview and Export on Windows', process.execPath, ['apps/desktop/test-ui.mjs']);
    await run('7/7 Package and verify the native Windows installer', process.execPath, ['scripts/desktop/package-win.mjs']);

    const { version } = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
    const installer = join(root, 'release', `DreamaticArt-${version}-windows-x64-setup.exe`);
    report(`\nRelease complete\nInstaller: ${installer}\nSHA256: ${installer}.sha256\nLog: ${logPath}\nFinal manual gate: install and uninstall the generated setup once.`);
  } catch (error) {
    console.error(`Release failed: ${error.message}`);
    log?.write(`\nRelease failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    if (log) await new Promise(resolveLog => log.end(resolveLog));
  }
}
