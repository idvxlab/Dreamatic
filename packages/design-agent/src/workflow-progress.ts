/** Public operational receipts only; never model reasoning or estimated progress. */
export interface ImageProgress { total: number; items: Record<string, { ok: boolean; path?: string }> }
export function imageProgress(previous: ImageProgress | undefined, event: Record<string, unknown>): ImageProgress | undefined {
  if (typeof event.total !== 'number' || !Number.isSafeInteger(event.total) || event.total < 1) return previous;
  const result = event.result as Record<string, unknown> | undefined;
  if (!result || typeof result.ok !== 'boolean' || typeof event.imageId !== 'string') return { total: event.total, items: previous?.items ?? {} };
  const raw = typeof result.path === 'string' ? result.path.replaceAll('\\', '/') : '';
  const path = /^runs\/[a-zA-Z0-9._-]+\/artifacts\/.+\.(png|jpe?g|webp|gif)$/i.test(raw) && !raw.split('/').includes('..') ? raw : undefined;
  return { total: event.total, items: { ...previous?.items, [event.imageId]: { ok: result.ok, ...(result.ok && path ? { path } : {}) } } };
}
