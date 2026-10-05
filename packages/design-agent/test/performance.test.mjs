import assert from 'node:assert/strict';
import test from 'node:test';
import { ImageRequestScheduler, projectContext, boundedResponseBytes, ResponseBodyTimeoutError } from '../dist/performance.js';
import { RetryableHttpError, withRetry } from '../dist/retry.js';

test('image admission bounds total and per-project concurrency, cancellation removes queued work', async () => {
  const scheduler = new ImageRequestScheduler(2, 1);
  let active = 0, max = 0;
  const release = [];
  const op = () => new Promise((resolve) => { active++; max = Math.max(max, active); release.push(() => { active--; resolve(); }); });
  const a = scheduler.run('a', op);
  const abort = new AbortController();
  const waiting = scheduler.run('a', () => { throw new Error('must not execute'); }, abort.signal);
  const b = scheduler.run('b', op);
  const rejected = assert.rejects(waiting, /cancelled/);
  abort.abort(new Error('cancelled'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2); release.forEach((done) => done());
  await Promise.all([a, b, rejected]); assert.equal(max, 2);
  await scheduler.run('a', async () => 'recovered');
});

test('queued image projects rotate and a failed request releases capacity', async () => {
  const scheduler = new ImageRequestScheduler(1, 1);
  let release;
  const first = scheduler.run('a', () => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const order = [];
  const a = scheduler.run('a', async () => { order.push('a'); });
  const b = scheduler.run('b', async () => { order.push('b'); });
  release(); await Promise.all([first, a, b]); assert.deepEqual(order, ['a', 'b']);
  await assert.rejects(scheduler.run('a', async () => { throw new Error('failed'); }), /failed/);
  await scheduler.run('b', async () => { order.push('recovered'); });
});

test('Retry-After is respected beyond the local backoff cap', async () => {
  const delays = []; let attempts = 0;
  await withRetry(async () => { if (++attempts === 1) throw new RetryableHttpError(429, 'limited', 60_000); }, { maxDelayMs: 8000, sleep: async (ms) => delays.push(ms), random: () => 0 });
  assert.deepEqual(delays, [60_000]);
});

test('JSON overview preserves all deliverable identities and marks omitted details', () => {
  const source = { narrative: 'x'.repeat(20_000), deliverables: Array.from({ length: 30 }, (_, index) => ({ id: `d${index}`, file: `artifacts/${index}.png`, method: 'image_generate', required: true, prompt: 'x'.repeat(10_000) })) };
  const { content, omittedPointers } = projectContext(source, 1000);
  assert.equal(content.deliverables.length, 30);
  assert.equal(content.deliverables.at(-1).id, 'd29');
  assert.ok(omittedPointers.length > 0); assert.ok(JSON.stringify(content).length < JSON.stringify(source).length / 10);
});

test('image responses are bounded even without a Content-Length', async () => {
  const { boundedResponseBytes } = await import('../dist/performance.js');
  await assert.rejects(boundedResponseBytes(new Response('123456'), 5), /byte limit/);
  assert.equal((await boundedResponseBytes(new Response('123'), 5)).byteLength, 3);
});


test('stalled image bodies time out even when their transport ignores abort or cancellation never settles', {timeout:2000}, async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({start(c) {c.enqueue(new Uint8Array([1,2,3]));},cancel() {cancelled=true;return new Promise(()=>{});}}));
  const progress = [];
  await assert.rejects(boundedResponseBytes(response,1024,{idleTimeoutMs:30,onProgress:bytes=>progress.push(bytes)}),error=>error instanceof ResponseBodyTimeoutError);
  assert.equal(cancelled,true);assert.deepEqual(progress,[3]);
});

test('body inactivity resets only when bytes arrive and slow active streams preserve exact content', {timeout:2000}, async () => {
  let interval;
  const response = new Response(new ReadableStream({start(c) {
    let count=0;
    interval=setInterval(()=>{c.enqueue(new Uint8Array([++count]));if(count===8){clearInterval(interval);c.close();}},20);
  },cancel(){clearInterval(interval);}}));
  try {assert.deepEqual([...new Uint8Array(await boundedResponseBytes(response,1024,{idleTimeoutMs:120}))],[1,2,3,4,5,6,7,8]);}
  finally {clearInterval(interval);}
});

test('user cancellation ends a pending body read immediately without waiting for a long timeout', {timeout:2000}, async () => {
  const controller=new AbortController();
  const response=new Response(new ReadableStream({cancel(){return new Promise(()=>{});}}));
  const reading=boundedResponseBytes(response,1024,{signal:controller.signal,idleTimeoutMs:3_000_000});
  const rejected=assert.rejects(reading,/User stopped/);
  controller.abort(new Error('User stopped'));
  await rejected;
});

test('empty body chunks do not postpone an inactivity deadline', {timeout:2000}, async () => {
  let interval;
  const response=new Response(new ReadableStream({start(c){interval=setInterval(()=>c.enqueue(new Uint8Array(0)),5);},cancel(){clearInterval(interval);}}));
  try {await assert.rejects(boundedResponseBytes(response,1024,{idleTimeoutMs:40}),ResponseBodyTimeoutError);}
  finally {clearInterval(interval);}
});
