import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionRegistry } from '../dist/execution-registry.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const task = (id, dependencies = []) => ({ id, method: 'image_generate', dependencies });
const deps = item => item.dependencies;

test('a completed producer releases its dependent while an unrelated slow task is still running', async () => {
  const starts = [], releases = new Map(), receipts = [];
  let active = 0, maximum = 0;
  const registry = new ExecutionRegistry().register(['image_generate'], async ([item]) => {
    starts.push(item.id); active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => releases.set(item.id, resolve)); active--;
    return [{ ok: true, id: item.id, path: `${item.id}.png` }];
  });
  const pending = registry.execute([task('a'), task('b'), task('c', ['a'])], deps, { concurrency: 2, onResult: result => receipts.push(result.id) });
  await tick(); assert.deepEqual(starts, ['a', 'b']);
  releases.get('a')(); await tick();
  assert.deepEqual(starts, ['a', 'b', 'c']);
  assert.deepEqual(receipts, ['a']); // b has not finished.
  releases.get('c')(); releases.get('b')();
  assert.deepEqual((await pending).map(result => result.id), ['a', 'b', 'c']);
  assert.equal(maximum, 2);
});

test('failure blocks all dependent work while independent successes survive', async () => {
  const starts = [];
  const registry = new ExecutionRegistry().register(['image_generate'], async ([item]) => {
    starts.push(item.id); return [{ ok: item.id !== 'bad', id: item.id }];
  });
  const results = await registry.execute([task('descendant', ['blocked']), task('blocked', ['bad']), task('bad'), task('independent')], deps, { concurrency: 2 });
  assert.deepEqual(starts.sort(), ['bad', 'independent']);
  assert.equal(results[1].error, 'Required dependency failed');
  assert.equal(results[0].ok, false);
  assert.equal(results[3].ok, true);
});

test('cycles, missing producers and unsupported methods fail before spending executor calls', async () => {
  let calls = 0;
  const registry = new ExecutionRegistry().register(['image_generate'], async () => { calls++; return []; });
  await assert.rejects(registry.execute([task('a', ['b']), task('b', ['a'])], deps, { concurrency: 2 }), /cyclic/);
  await assert.rejects(registry.execute([task('a', ['missing'])], deps, { concurrency: 2 }), /Unknown approved dependency/);
  await assert.rejects(registry.execute([{ ...task('a'), method: 'unknown' }], deps, { concurrency: 2 }), /Unsupported executor/);
  assert.equal(calls, 0);
});

test('cancellation starts no dependent work and waits for outstanding executors to settle', async () => {
  const abort = new AbortController(), starts = [];
  let release, settled = false;
  const registry = new ExecutionRegistry().register(['image_generate'], async ([item]) => {
    starts.push(item.id); await new Promise(resolve => { release = resolve; }); settled = true;
    return [{ ok: true, id: item.id }];
  });
  const execution = registry.execute([task('a'), task('b', ['a'])], deps, { concurrency: 1, signal: abort.signal });
  const rejected = assert.rejects(execution, /cancelled/);
  await tick(); abort.abort(new Error('cancelled')); release(); await rejected;
  assert.equal(settled, true); assert.deepEqual(starts, ['a']);
});
