import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function versionFromBranch(branch) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(branch);
  if (!match) throw new Error(`Release branch must be v<major>.<minor>.<patch>; got ${JSON.stringify(branch)}`);
  return branch.slice(1);
}

export function branchVersion(root) {
  return versionFromBranch(execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim());
}

export async function syncReleaseVersion(root) {
  let version = process.env.DREAMATIC_RELEASE_VERSION;
  let origin = "explicit release version";
  if (!version) {
    let branch = "";
    try { branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* Source archives have no Git metadata. */ }
    if (/^v\d+\.\d+\.\d+$/.test(branch)) { version = versionFromBranch(branch); origin = "Git branch"; }
    else { version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version; origin = "package.json"; }
  }
  version = versionFromBranch(`v${version}`);

  for (const path of ['package.json', 'apps/desktop/package.json', 'package-lock.json']) {
    const file = join(root, path);
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.version = version;
    if (path === 'package-lock.json') {
      manifest.packages[''].version = version;
      manifest.packages['apps/desktop'].version = version;
    }
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(`Release version: v${version} (from ${origin})`);
  return version;
}
