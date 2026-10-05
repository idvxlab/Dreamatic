/** Dreamatic image-service admission control; Pi continues to own agent execution. */
export class ImageRequestScheduler {
  #queues = new Map<string, Array<{ start: () => void; cancel: () => void }>>();
  #active = 0;
  #projects = new Map<string, number>();
  constructor(public capacity = 4, public perProject = 2) {}
  configure(capacity: number, perProject: number) { this.capacity = capacity; this.perProject = perProject; this.#pump(); }
  run<T>(project: string, operation: () => Promise<T>, signal?: AbortSignal, admitted?: (waitMs: number) => void): Promise<T> {
    signal?.throwIfAborted();
    const queuedAt = performance.now();
    return new Promise<T>((resolve, reject) => {
      const entry = {
        start: () => {
          signal?.removeEventListener('abort', entry.cancel);
          this.#active += 1;
          this.#projects.set(project, (this.#projects.get(project) ?? 0) + 1);
          Promise.resolve().then(() => { signal?.throwIfAborted(); admitted?.(performance.now() - queuedAt); return operation(); })
            .then(resolve, reject).finally(() => {
              this.#active -= 1;
              const active = (this.#projects.get(project) ?? 1) - 1;
              if (active) this.#projects.set(project, active); else this.#projects.delete(project);
              this.#pump();
            });
        },
        cancel: () => {
          const queue = this.#queues.get(project);
          if (queue) { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); if (!queue.length) this.#queues.delete(project); }
          reject(signal?.reason ?? new Error('Aborted'));
          this.#pump();
        },
      };
      const queue = this.#queues.get(project) ?? [];
      queue.push(entry); this.#queues.set(project, queue);
      signal?.addEventListener('abort', entry.cancel, { once: true });
      this.#pump();
    });
  }
  #pump() {
    while (this.#active < this.capacity) {
      const next = [...this.#queues].find(([key, queue]) => queue.length && (this.#projects.get(key) ?? 0) < this.perProject);
      if (!next) break;
      const [key, queue] = next;
      const entry = queue.shift()!;
      this.#queues.delete(key);
      if (queue.length) this.#queues.set(key, queue); // Rotate waiting projects.
      entry.start();
    }
  }
}
let scheduler: ImageRequestScheduler | undefined;
export function imageRequestScheduler(): ImageRequestScheduler {
  const capacity = Math.max(1, Math.min(32, Math.floor(Number(process.env.DREAMATIC_IMAGE_GLOBAL_CONCURRENCY ?? 4)) || 4));
  const perProject = Math.max(1, Math.min(8, Math.floor(Number(process.env.DREAMATIC_IMAGE_CONCURRENCY ?? 2)) || 2));
  scheduler ??= new ImageRequestScheduler(capacity, perProject);
  scheduler.configure(capacity, perProject);
  return scheduler;
}

/** A valid JSON overview, with explicit pointers for details that need native read. */
export function projectContext(value: unknown, maxChars = 12_000): { content: unknown; omittedPointers: string[] } {
  const omittedPointers: string[] = [];
  let remaining = Math.max(256, maxChars);
  const pointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
  const visit = (item: unknown, path: string, depth: number): unknown => {
    if (typeof item === 'string') {
      const limit = Math.max(0, Math.min(700, remaining)); remaining -= Math.min(item.length, limit);
      if (item.length > limit) { omittedPointers.push(path); return item.slice(0, limit) + ' [detail omitted]'; }
      return item;
    }
    if (!item || typeof item !== 'object') return item;
    if (depth > 8 || remaining <= 0) {
      omittedPointers.push(path);
      if (Array.isArray(item)) return item.map((entry) => entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).filter(([key]) => ['id', 'asset_id', 'source_id', 'decision_id', 'deliverable_id', 'file', 'path', 'output_file', 'method', 'required'].includes(key))) : { detailOmitted: true });
      return { ...Object.fromEntries(Object.entries(item).filter(([key]) => ['id', 'asset_id', 'source_id', 'decision_id', 'deliverable_id', 'file', 'path', 'output_file', 'method', 'runId', 'verdict', 'required'].includes(key))), detailOmitted: true };
    }
    if (Array.isArray(item)) {
      // Preserve every item identity; do not silently drop deliverables/references.
      return item.map((child, index) => visit(child, `${path}/${index}`, depth + 1));
    }
    const result: Record<string, unknown> = {};
    const entries = Object.entries(item as Record<string, unknown>);
    for (const [key, child] of entries) {
      if (['id', 'asset_id', 'source_id', 'decision_id', 'deliverable_id', 'file', 'path', 'output_file', 'method', 'runId', 'verdict', 'required'].includes(key)) { result[key] = child; continue; }
      remaining -= key.length + 4;
      result[key] = visit(child, `${path}/${pointer(key)}`, depth + 1);
    }
    return result;
  };
  return { content: visit(value, '', 0), omittedPointers };
}

export class ResponseBodyTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(`Image response body stalled: no data received for ${idleTimeoutMs} ms`);
    this.name = "TimeoutError";
  }
}

/** Bound buffered bytes and inactivity independently of a provider's long generation deadline. */
export async function boundedResponseBytes(response: Response, maxBytes = 64 * 1024 * 1024, options: { signal?: AbortSignal; idleTimeoutMs?: number; onProgress?: (bytes: number) => void } = {}): Promise<ArrayBuffer> {
  options.signal?.throwIfAborted();
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) { void response.body?.cancel().catch(() => undefined); throw new Error('Image response exceeds configured byte limit'); }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0, lastByteAt = performance.now();
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;
  const read = () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true; cleanup(); reject(error);
      // Do not await cancellation: an unresponsive transport must not hold the scheduler slot.
      void reader.cancel(error).catch(() => undefined);
    };
    const abort = () => fail(options.signal?.reason ?? new Error('Aborted'));
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    if (idleTimeoutMs > 0) {
      const remaining = idleTimeoutMs - (performance.now() - lastByteAt);
      if (remaining <= 0) { fail(new ResponseBodyTimeoutError(idleTimeoutMs)); return; }
      timer = setTimeout(() => fail(new ResponseBodyTimeoutError(idleTimeoutMs)), remaining);
    }
    reader.read().then((value) => { if (!settled) { settled = true; cleanup(); resolve(value); } }, (error) => { if (!settled) { settled = true; cleanup(); reject(error); } });
  });
  try {
    while (true) {
      const { done, value } = await read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { void reader.cancel().catch(() => undefined); throw new Error('Image response exceeds configured byte limit'); }
      if (value.byteLength) { lastByteAt = performance.now(); options.onProgress?.(size); }
      if (value.byteLength) chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

const jsonWriteLocks = new Map<string, Promise<void>>();
export async function serializeJsonWrite<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = jsonWriteLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const lock = new Promise<void>((resolve) => { release = resolve; });
  jsonWriteLocks.set(path, lock);
  await previous;
  try { return await operation(); }
  finally { release(); if (jsonWriteLocks.get(path) === lock) jsonWriteLocks.delete(path); }
}
