/** Observed operational receipts only; never model reasoning or estimated progress. */
export interface ImageProgressItem {
  ok?: boolean;
  path?: string;
  state?: 'queued' | 'generating' | 'saved' | 'failed';
  label?: string;
  startedAt?: string;
  durationMs?: number;
  reused?: boolean;
}
export interface ImageProgress { total: number; items: Record<string, ImageProgressItem> }
export function imageProgress(previous: ImageProgress | undefined, event: Record<string, unknown>): ImageProgress | undefined {
  if (typeof event.total !== 'number' || !Number.isSafeInteger(event.total) || event.total < 1) return previous;
  const clean = (raw: Record<string, unknown>): ImageProgressItem => {
    const path = typeof raw.path === 'string' ? raw.path.replaceAll('\\', '/') : '';
    const validPath = /^runs\/[a-zA-Z0-9._-]+\/artifacts\/.+\.(png|jpe?g|webp|gif)$/i.test(path) && !path.split('/').includes('..');
    return {
      ...(typeof raw.ok === 'boolean' ? { ok: raw.ok } : {}),
      ...(raw.ok === true && validPath ? { path } : {}),
      ...(['queued','generating','saved','failed'].includes(String(raw.state)) ? { state: raw.state as NonNullable<ImageProgressItem['state']> } : {}),
      ...(typeof raw.label === 'string' ? { label: raw.label.slice(0,120) } : {}),
      ...(typeof raw.startedAt === 'string' && Number.isFinite(Date.parse(raw.startedAt)) ? { startedAt: raw.startedAt } : {}),
      ...(typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? { durationMs: raw.durationMs } : {}),
      ...(typeof raw.reused === 'boolean' ? { reused: raw.reused } : {}),
    };
  };
  if (event.imageItems && typeof event.imageItems === 'object' && !Array.isArray(event.imageItems)) {
    const items: Record<string,ImageProgressItem> = {};
    for (const [id,item] of Object.entries(event.imageItems)) if (item && typeof item === 'object' && !Array.isArray(item)) items[id] = clean(item as Record<string,unknown>);
    return { total: event.total, items };
  }
  const result = event.result as Record<string, unknown> | undefined;
  if (!result || typeof result.ok !== 'boolean' || typeof event.imageId !== 'string') return { total: event.total, items: previous?.items ?? {} };
  return { total: event.total, items: { ...previous?.items, [event.imageId]: clean(result) } };
}
