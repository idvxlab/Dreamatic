import { fork } from 'node:child_process';
import { mkdir, copyFile, constants, readdir, chmod } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
export async function startRuntime({ runtime, dataDir, log }) {
  await mkdir(dataDir, { recursive: true });
  try {
    await copyFile(join(runtime, '.env.example'), join(dataDir, '.env'), constants.COPYFILE_EXCL);
    await chmod(join(dataDir, '.env'), 0o600);
  }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const browserDir = (await readdir(join(runtime, 'browsers'))).find(name => name.startsWith('chromium_headless_shell-'));
  if (!browserDir) throw new Error('The packaged HTML review browser is missing.');
  const browser = join(runtime, 'browsers', browserDir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
  const child = fork(join(runtime, 'apps/server/dist/index.js'), [], {
    execPath: join(runtime, 'bin/node'), cwd: dataDir,
    env: { ...process.env, DREAMATIC_DESKTOP: '1', DREAMATIC_CONFIG_DIR: dataDir,
      DREAMATIC_DESKTOP_TOOL_PATH: join(runtime, 'bin'),
      PATH: [join(runtime, 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', process.env.PATH || ''].join(delimiter),
      PI_CODING_AGENT_DIR: join(dataDir, 'pi'),
      PLAYWRIGHT_BROWSERS_PATH: join(runtime, 'browsers'),
      DREAMATIC_DESKTOP_BROWSER: browser },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', chunk => log.write(chunk)); child.stderr.on('data', chunk => log.write(chunk));
  let stopPromise;
  const stop = () => stopPromise ??= new Promise(resolve => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Local service startup timed out. See desktop.log.')), 45000);
      const finish = (error, port) => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); child.off('error', failure); error ? reject(error) : resolve(port); };
      const message = value => { if (value?.type === 'dreamatic-ready' && Number.isInteger(value.port) && value.port > 0) finish(null, value.port); };
      const exit = code => finish(new Error(`Local service exited (${code}). See desktop.log.`));
      const failure = error => finish(error);
      child.on('message', message); child.once('exit', exit); child.once('error', failure);
    });
    const url = `http://127.0.0.1:${port}`;
    const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json());
    if (health.processId !== child.pid) throw new Error('Local service identity mismatch.');
    return { child, url, stop };
  } catch (error) { await stop(); throw error; }
}
export function localTarget(value, appOrigin) {
  try {
    const url = new URL(value);
    if (url.origin === appOrigin) return true;
    // PreviewService owns a separate loopback origin and a random 48-character grant.
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^\/[a-f0-9]{48}\/artifacts\//.test(url.pathname);
  } catch { return false; }
}
