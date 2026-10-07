import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { versionFromBranch, syncReleaseVersion } from '../../../scripts/desktop/version.mjs';

test('release versions come from an exact version branch', () => {
  assert.equal(versionFromBranch('v2.0.3'), '2.0.3');
  for (const branch of ['main', '', 'feature/v2.0.3', 'v02.0.3', 'v2.0', 'v2.0.3-extra']) {
    assert.throws(() => versionFromBranch(branch), /Release branch/);
  }
});

test('synchronizes manifests and lockfile from Git without changing internal packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dreamatic-version-'));
  try {
    execFileSync('git', ['init', '-b', 'v2.0.3', root]);
    await mkdir(join(root, 'apps/desktop'), { recursive: true });
    for (const path of ['package.json', 'apps/desktop/package.json']) {
      await writeFile(join(root, path), JSON.stringify({ version: '0.1.0' }));
    }
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' }, 'apps/desktop': { version: '0.1.0' }, 'packages/design-agent': { version: '0.1.0' } } }));
    assert.equal(await syncReleaseVersion(root), '2.0.3');
    for (const path of ['package.json', 'apps/desktop/package.json', 'package-lock.json']) {
      assert.equal(JSON.parse(await readFile(join(root, path), 'utf8')).version, '2.0.3');
    }
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages[''].version, '2.0.3');
    assert.equal(lock.packages['apps/desktop'].version, '2.0.3');
    assert.equal(lock.packages['packages/design-agent'].version, '0.1.0');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('main branch uses package version; explicit release versions override it and reject invalid input',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dreamatic-release-main-'));const previous=process.env.DREAMATIC_RELEASE_VERSION;
 try{execFileSync('git',['init','-b','main',root]);await mkdir(join(root,'apps/desktop'),{recursive:true});for(const file of ['package.json','apps/desktop/package.json'])await writeFile(join(root,file),JSON.stringify({version:'2.0.3'}));await writeFile(join(root,'package-lock.json'),JSON.stringify({version:'2.0.3',packages:{'':{},'apps/desktop':{}}}));delete process.env.DREAMATIC_RELEASE_VERSION;assert.equal(await syncReleaseVersion(root),'2.0.3');process.env.DREAMATIC_RELEASE_VERSION='2.0.4';assert.equal(await syncReleaseVersion(root),'2.0.4');process.env.DREAMATIC_RELEASE_VERSION='../bad';await assert.rejects(syncReleaseVersion(root),/Release branch/)}finally{if(previous===undefined)delete process.env.DREAMATIC_RELEASE_VERSION;else process.env.DREAMATIC_RELEASE_VERSION=previous;await rm(root,{recursive:true,force:true})}
});
