import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openProjectAssets, localFolderRequest } from '../dist/open-assets.js';

test('Assets opens the project folder containing original files, with no shell or arbitrary path access', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dreamatic-open-assets-'));t.after(() => rm(root, { recursive:true, force:true }));
  await mkdir(join(root, 'runs', 'project-a', 'artifacts'), { recursive:true });
  const calls = [];const open = async (...args) => { calls.push(args);return { stdout:'', stderr:'' }; };
  await openProjectAssets(root, 'project-a', open, 'darwin');
  assert.deepEqual(calls, [['/usr/bin/open', [await realpath(join(root, 'runs', 'project-a'))]]]);
  for (const id of ['../outside', 'project-a;echo test', 'not-existing']) await assert.rejects(openProjectAssets(root, id, open, 'darwin'));
  await mkdir(join(root, 'outside'));await symlink(join(root, 'outside'), join(root, 'runs', 'escaped'));
  await assert.rejects(openProjectAssets(root, 'escaped', open, 'darwin'), /Invalid project folder/);
  assert.equal(calls.length, 1);
});
test('native folder opening accepts local desktop and local web requests only', () => {
  assert.equal(localFolderRequest('127.0.0.1', '127.0.0.1:4310', 'http://127.0.0.1:4310'), true);
  assert.equal(localFolderRequest('::1', 'localhost:4310', 'http://localhost:5173'), true);
  assert.equal(localFolderRequest('203.0.113.1', 'localhost:4310', undefined), false);
  assert.equal(localFolderRequest('127.0.0.1', 'malicious.example', undefined), false);
  assert.equal(localFolderRequest('127.0.0.1', 'localhost:4310', 'https://malicious.example'), false);
});
