import { CONFIG_FIELDS } from './config-store.js';
let active = 0;
const waiters = new Set<() => void>();
/** Shared by pipeline generation and direct Canvas edits. */
export async function imageSlot(signal: AbortSignal) {
  const limit = () => Number(process.env.DREAMATIC_IMAGE_GLOBAL_CONCURRENCY?.trim() || CONFIG_FIELDS.find(field => field.key === 'DREAMATIC_IMAGE_GLOBAL_CONCURRENCY')!.defaultValue);
  while (active >= limit()) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const wake = () => { waiters.delete(wake); signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { waiters.delete(wake); reject(signal.reason); };
      waiters.add(wake); signal.addEventListener('abort', abort, { once: true });
    });
  }
  signal.throwIfAborted(); active++;
  let released = false;
  return () => { if (released) return; released = true; active--; for (const wake of waiters) wake(); };
}
