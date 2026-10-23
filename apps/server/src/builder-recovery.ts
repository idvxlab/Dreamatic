import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { indexedJsonl } from './jsonl-index.js';
import { normalizeShowcaseHtml, resolveShowcaseImages, validateShowcaseHtml, validateShowcaseDirection, verifyShowcaseAssets, type ShowcaseDirection, type ShowcaseImage, type GeneratedShowcaseImage, type ImageReferenceRepair } from './showcase.js';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const read = async (path: string): Promise<Record<string, unknown>> => record(JSON.parse(await readFile(path, 'utf8')));
export const showcaseAssets = (images: Pick<ShowcaseImage, 'id'>[], generated: Record<string, GeneratedShowcaseImage>) => Object.fromEntries(images.map(image => [image.id, { path: generated[image.id]?.path, digest: generated[image.id]?.digest }]));
const sameAssets = (images: Pick<ShowcaseImage, 'id'>[], generated: Record<string, GeneratedShowcaseImage>, saved: unknown): boolean => images.every(image => record(record(saved)[image.id]).path === generated[image.id]?.path && record(record(saved)[image.id]).digest === generated[image.id]?.digest && Boolean(generated[image.id]?.digest));

export async function savedShowcaseDirection(root: string, fingerprint: string, images: ShowcaseImage[], generated: Record<string, GeneratedShowcaseImage>): Promise<ShowcaseDirection | undefined> {
  try {
    const saved = await read(join(root, '.showcase-direction.json'));
    if (saved.fingerprint !== fingerprint || !sameAssets(images, generated, saved.assets)) return undefined;
    const direction = validateShowcaseDirection(saved.direction, images, generated);
    await verifyShowcaseAssets(root, direction, generated);
    return direction;
  } catch { return undefined; }
}

/** Legacy drafts have no paired direction. Recover only the successful plan
 * belonging to the Pi session whose complete final text exactly matches the draft. */
async function legacyDirection(root: string, text: string, images: ShowcaseImage[], generated: Record<string, GeneratedShowcaseImage>): Promise<ShowcaseDirection | undefined> {
  let finalAt: string | undefined;
  for (const file of await readdir(join(root, 'sessions/builder')).catch(() => [])) {
    if (!file.endsWith('.jsonl')) continue;
    for (const row of (await indexedJsonl(join(root, 'sessions/builder', file))).rows) {
      const message = record(row.message);
      if (message?.role !== 'assistant' || message.stopReason !== 'stop' || !Array.isArray(message.content)) continue;
      const output = message.content.map(record).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
      if (output === text && typeof row.timestamp === 'string' && (!finalAt || row.timestamp > finalAt)) finalAt = row.timestamp;
    }
  }
  if (!finalAt) return undefined;
  const records = (await indexedJsonl(join(root, 'bus.jsonl'))).rows.filter(row => typeof row.at === 'string' && row.at <= finalAt!);
  const invocation = records.findLast(row => row.type === 'agent_started' && row.agent === 'builder')?.invocationId;
  if (!invocation) return undefined;
  for (const event of records.filter(row => row.type === 'tool_finished' && row.toolName === 'plan_showcase' && row.invocationId === invocation && row.isError !== true).reverse()) {
    const call = records.findLast(row => row.type === 'tool_started' && row.invocationId === invocation && row.toolCallId === event.toolCallId);
    if (typeof call?.input !== 'string' || typeof event.output !== 'string') continue;
    const params = record(JSON.parse(call.input)), receipt = record(JSON.parse(event.output));
    const direction = validateShowcaseDirection({ heroId: params.heroId, works: params.works, markdown: params.direction }, images, generated);
    const receiptText = (Array.isArray(receipt.content) ? receipt.content : []).map(record).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
    if (images.every(image => receiptText.split('\n').some((line: string) => line === `${image.id}: ../${generated[image.id]!.path}` || line.startsWith(`${image.id}: ../${generated[image.id]!.path} |`)))) return direction;
  }
  return undefined;
}

export async function recoverBuilderDraft(root: string, fingerprint: string, images: ShowcaseImage[], generated: Record<string, GeneratedShowcaseImage>): Promise<{ html: string; direction: ShowcaseDirection; repairs: ImageReferenceRepair[] } | undefined> {
  try {
    const draft = await read(join(root, '.builder-output.json'));
    if (draft.fingerprint !== fingerprint || typeof draft.text !== 'string') return undefined;
    let direction: ShowcaseDirection | undefined;
    if (draft.direction) {
      if (!sameAssets(images, generated, draft.assets)) return undefined;
      direction = validateShowcaseDirection(draft.direction, images, generated);
    } else direction = await legacyDirection(root, draft.text, images, generated);
    if (!direction) return undefined;
    const result = await resolveShowcaseImages(root, normalizeShowcaseHtml(draft.text), direction, generated);
    await validateShowcaseHtml(root, result.html, direction, generated);
    return { ...result, direction };
  } catch { return undefined; }
}
