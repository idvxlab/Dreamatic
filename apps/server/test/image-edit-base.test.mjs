import { deflateSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBaseImage, resolveBaseImage } from '../dist/image-edit-base.js';
function inlinePng() {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([length, body, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(9))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const inputs = [{ id: 'artifacts/scene.png', title: '城市场景', ordinal: 1 }, { id: 'artifacts/portrait.png', title: '人物肖像', ordinal: 2 }];
test('base selection follows explicit bases, retained composition and destination scenes rather than style references', () => {
  for (const [prompt, index, method] of [
    ['把图二的人物放进图一的场景', 0, 'inferred'],
    ['把图一的人物放进图二的场景', 1, 'inferred'],
    ['以图二为底图，参考图一的配色', 1, 'explicit'],
    ['以图 2为底图，参考图 1的配色', 1, 'explicit'],
    ['Use image #2 as the base', 1, 'explicit'],
    ['保留图二的构图，融合图一的元素', 1, 'inferred'],
    ['沿用第二张图的布局', 1, 'inferred'],
    ['不要改变图二的构图，只融合图一的人物', 1, 'inferred'],
    ['用人物肖像作为基底，参考城市场景的色调', 1, 'explicit'],
    ['以artifacts/portrait.png为底图', 1, 'explicit'],
    ['Use image 2 as the base and image 1 for colors', 1, 'explicit'],
    ['Base the result on the second image', 1, 'explicit'],
    ["Preserve image 2's composition; borrow image 1's colors", 1, 'inferred'],
    ['Keep the layout of the second image', 1, 'inferred'],
    ['Put the person from image 1 into image 2', 1, 'inferred'],
  ]) {
    const selected = selectBaseImage(prompt, inputs);
    assert.equal(selected.baseImageId, inputs[index].id, prompt); assert.equal(selected.baseImageMethod, method, prompt); assert.equal(selected.baseImageEvidence, prompt);
  }
  for (const prompt of ['融合这两张图', '参考图二的配色，融合两张图', '参考图二的风格', '以图一为底图，以图二为基底', '以图三为底图', '以<ref:99>为底图', '不要以图二为底图', 'Add text "use image 2 as the base"']) {
    const selected = selectBaseImage(prompt, inputs); assert.equal(selected.baseImageId, inputs[0].id, prompt); assert.equal(selected.baseImageMethod, 'fallback', prompt);
  }
});
test('base references retain original inventory numbering across subsets and reordered inputs', () => {
  const reordered = [{ ...inputs[1], ordinal: 7 }, { ...inputs[0], ordinal: 2 }];
  assert.equal(selectBaseImage('以图二为底图', reordered).baseImageId, inputs[0].id);
  assert.equal(selectBaseImage('Use image 7 as the base', reordered).baseImageId, inputs[1].id);
  assert.equal(selectBaseImage('以图一为底图', reordered).baseImageMethod, 'fallback');
  const duplicateNames = inputs.map(input => ({ ...input, title: '同名图片' }));
  assert.equal(selectBaseImage('以同名图片为底图', duplicateNames).baseImageMethod, 'fallback');
});
test('Pi Editor resolves semantic base roles using real IDs and verbatim evidence, with safe fallback on invalid or conflicting answers', async t => {
  const { createServer } = await import('node:http');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'dreamatic-base-')); t.after(() => rm(root, { recursive: true, force: true }));
  let mode = 'valid', calls = 0, sawImageInputs = false;
  const prompt = '图二承担整个场景的承载画面，图一只提供人物元素';
  const server = createServer(async (req, res) => {
    calls++; let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); assert.ok(data.tools.some(tool => tool.function.name === 'select_base_image'));
    if (data.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))) sawImageInputs = true;
    const called = data.messages.some(message => message.role === 'tool');
    const args = { fileId: mode === 'invalid-id' ? 'fake.png' : inputs[1].id, evidence: mode === 'invented-evidence' ? 'invented base instruction' : JSON.stringify(data.messages).includes('沿用房间构图') ? '沿用房间构图' : '图二承担整个场景的承载画面', reason: 'Image 2 supplies the retained destination scene.' };
    const delta = called ? { content: '# Base image\nSelected the retained scene.' } : { tool_calls: [{ index: 0, id: 'pick', type: 'function', function: { name: 'select_base_image', arguments: JSON.stringify(args) } }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choice of [{ delta: { role: 'assistant', ...delta }, finish_reason: null }, { delta: {}, finish_reason: called ? 'stop' : 'tool_calls' }]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, ...choice }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const env = { DREAMATIC_API_KEY: 'fixture', DREAMATIC_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, DREAMATIC_MODEL: 'fixture', DREAMATIC_CONTEXT_WINDOW: '32768', DREAMATIC_MAX_TOKENS: '8192' };
  const options = { root, prompt, inputs, env, signal: new AbortController().signal };
  const result = await resolveBaseImage(options); assert.equal(result.baseImageId, inputs[1].id); assert.equal(result.baseImageMethod, 'model');
  for (const value of ['invalid-id', 'invented-evidence']) { mode = value; const fallback = await resolveBaseImage(options); assert.equal(fallback.baseImageMethod, 'fallback'); assert.equal(fallback.baseImageId, inputs[0].id); }
  mode = 'valid';
  const visual = await resolveBaseImage({ ...options, prompt: '把人物放进房间场景，沿用房间构图', images: () => inputs.map(() => ({ data: inlinePng(), mimeType: 'image/png' })) });
  assert.equal(visual.baseImageId, inputs[1].id); assert.equal(visual.baseImageMethod, 'model'); assert.equal(sawImageInputs, true);
  const missingVision = await resolveBaseImage({ ...options, prompt: '把人物放进房间场景，沿用房间构图', images: () => inputs.map(() => ({ data: Buffer.from('invalid image').toString('base64'), mimeType: 'image/png' })) });
  assert.equal(missingVision.baseImageMethod, 'fallback'); assert.equal(missingVision.baseImageId, inputs[0].id);
  const before = calls;
  assert.equal((await resolveBaseImage({ ...options, prompt: '以图一为底图，以图二为基底' })).baseImageMethod, 'fallback'); assert.equal(calls, before);
  assert.equal((await resolveBaseImage({ ...options, prompt: '以图二为基底' })).baseImageMethod, 'explicit'); assert.equal(calls, before);
  assert.equal((await resolveBaseImage({ ...options, env: {} })).baseImageMethod, 'fallback');
  const controller = new AbortController(); controller.abort(); await assert.rejects(resolveBaseImage({ ...options, signal: controller.signal }), { name: 'AbortError' });
});
