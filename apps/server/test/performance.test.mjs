import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, appendFile, rename, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { indexedJsonl } from '../dist/jsonl-index.js';
import { streamWriter } from '../dist/stream-writer.js';
import { createDraftRun, runInventory } from '../dist/run-store.js';

test('JSONL index handles append, partial Unicode, complete tails and replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dreamatic-jsonl-'));
  const path = join(directory, 'bus.jsonl');
  try {
    await writeFile(path, '{"id":1}\n{"text":');
    assert.equal((await indexedJsonl(path)).rows.length, 1);
    const unicode = Buffer.from('"测试"}');
    await appendFile(path, unicode.subarray(0, 2));
    assert.equal((await indexedJsonl(path)).rows.length, 1);
    await appendFile(path, unicode.subarray(2));
    assert.equal((await indexedJsonl(path)).rows.at(-1).text, '测试');
    await appendFile(path, '\n{"id":3}\n');
    assert.equal((await indexedJsonl(path)).rows.length, 3);
    await writeFile(path + '.new', '{"id":4}\n'); await rename(path + '.new', path);
    assert.deepEqual((await indexedJsonl(path)).rows, [{ id: 4 }]);
    await writeFile(path, '{"id":5}\n');
    assert.deepEqual((await indexedJsonl(path)).rows, [{ id: 5 }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('stream backpressure preserves order, flushes before end and bounds slow consumers', () => {
  class Response extends EventEmitter {
    writableLength = 0; chunks = []; block = true; ended = false; destroyed = false;
    write(text) { this.chunks.push(text); return !this.block; }
    end() { this.ended = true; }
    destroy() { this.destroyed = true; this.emit('close'); }
  }
  const response = new Response(); const writer = streamWriter(response, 100);
  writer.send('a'); writer.send('b'); writer.end();
  assert.deepEqual(response.chunks, ['a']); assert.equal(response.ended, false);
  response.block = false; response.emit('drain');
  assert.deepEqual(response.chunks, ['a', 'b']); assert.equal(response.ended, true);
  const slow = new Response(); const bounded = streamWriter(slow, 5);
  bounded.send('a'); bounded.send('123456'); assert.equal(slow.destroyed, true);
});

test('summary inventories preserve project identity and full detail stays scoped', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dreamatic-summary-'));
  try {
    const one = await createDraftRun(workspace, 'one'); const two = await createDraftRun(workspace, 'two');
    const runDir = join(workspace, 'runs', one.id); await mkdir(join(runDir, 'plan'), { recursive: true });
    await writeFile(join(runDir, 'plan/task_breakdown.md'), '# Design\nApproved plan');
    const summaries = await runInventory(workspace, { summary: true });
    assert.equal(summaries.length, 2); assert.equal(summaries.find((run) => run.id === one.id).sessionId, 'one');
    assert.deepEqual(summaries[0].notes, []);
    const details = await runInventory(workspace, { runId: one.id });
    assert.equal(details.length, 1); assert.equal(details[0].id, one.id); assert.ok(details[0].notes.length > 0);
    assert.ok(!details.some((run) => run.id === two.id));
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('compact web events avoid cumulative message payloads while retaining clarification', async () => {
  const { compactPromptEvent } = await import('../dist/stream-writer.js');
  const delta = compactPromptEvent({ type: 'message_update', message: { enormous: 'x'.repeat(10000) }, assistantMessageEvent: { type: 'text_delta', delta: 'next', partial: { enormous: 'x'.repeat(10000) } } });
  assert.deepEqual(delta, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'next' } });
  assert.equal(compactPromptEvent({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', partial: {} } }), undefined);
  const card = { content: [{ type: 'text', text: '{"questions":[]}' }] };
  assert.equal(compactPromptEvent({ type: 'tool_execution_end', toolName: 'ask_user', result: card }).result, card);
  assert.equal(compactPromptEvent({ type: 'tool_execution_end', toolName: 'spawn_agent', result: { enormous: 'x'.repeat(10000) } }).result, undefined);
});
