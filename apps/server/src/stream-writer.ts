import type { ServerResponse } from 'node:http';
/** Respect socket backpressure. Slow consumers reconnect to the durable snapshot. */
export function streamWriter(response: ServerResponse, maxBytes = 1024 * 1024) {
  const queue: string[] = [];
  let queuedBytes = 0;
  let blocked = false;
  let closed = false;
  let ending = false;
  const pump = () => {
    if (closed || blocked) return;
    while (queue.length) {
      const chunk = queue.shift()!; queuedBytes -= Buffer.byteLength(chunk);
      if (!response.write(chunk)) { blocked = true; return; }
    }
    if (ending) response.end();
  };
  const drain = () => { blocked = false; pump(); };
  const cleanup = () => { closed = true; queue.length = 0; response.off('drain', drain); response.off('close', cleanup); };
  response.on('drain', drain); response.on('close', cleanup);
  return {
    send(chunk: string) {
      if (closed || ending) return false;
      if (!blocked && !queue.length) { blocked = !response.write(chunk); return true; }
      queuedBytes += Buffer.byteLength(chunk);
      if (queuedBytes + response.writableLength > maxBytes) { response.destroy(); cleanup(); return false; }
      queue.push(chunk); pump(); return true;
    },
    end() { ending = true; pump(); },
  };
}
