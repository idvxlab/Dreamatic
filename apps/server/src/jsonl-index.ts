import { publicWorkflowData } from './workflow-data.js';
import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
interface JsonlIndex { source: string; rows: Record<string, unknown>[]; size: number; mtimeMs: number; ino: number; tail: string; decoder: StringDecoder }
const indexes = new Map<string, JsonlIndex>();
const pending = new Map<string, Promise<JsonlIndex>>();
function parseRow(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (value && typeof value === 'object' && !Array.isArray(value)) return publicWorkflowData(value as Record<string, unknown>);
  } catch { /* Malformed or incomplete records are never exposed as public data. */ }
  return undefined;
}
function view(index: JsonlIndex): JsonlIndex {
  const last = parseRow(index.tail);
  return { ...index, source: index.source + (last ? JSON.stringify(last) : ''), rows: last ? [...index.rows, last] : index.rows };
}
/** Offset-based parsing, reset on replacement/truncation. Partial UTF-8 and JSON lines wait for the next append. */
export async function indexedJsonl(path: string): Promise<JsonlIndex> {
  const inFlight = pending.get(path);
  if (inFlight) return inFlight;
  const operation = (async () => {
    const info = await stat(path);
    let index = indexes.get(path);
    if (index?.size === info.size && index.mtimeMs === info.mtimeMs && index.ino === info.ino) return view(index);
    if (!index || index.ino !== info.ino || info.size <= index.size) index = { source: '', rows: [], size: 0, mtimeMs: 0, ino: info.ino, tail: '', decoder: new StringDecoder('utf8') };
    const handle = await open(path, 'r');
    try {
      while (index.size < info.size) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, info.size - index.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, index.size);
        if (!bytesRead) break;
        index.size += bytesRead;
        const text = index.decoder.write(buffer.subarray(0, bytesRead));
        const lines = (index.tail + text).split(/\r?\n/u);
        index.tail = lines.pop() ?? '';
        for (const line of lines) {
          const row = parseRow(line);
          if (row) { index.source += JSON.stringify(row) + '\n'; index.rows.push(row); }
        }
      }
    } finally { await handle.close(); }
    index.mtimeMs = info.mtimeMs;
    indexes.delete(path); indexes.set(path, index);
    while (indexes.size > 256) indexes.delete(indexes.keys().next().value!);
    return view(index);
  })();
  pending.set(path, operation);
  try { return await operation; } finally { pending.delete(path); }
}
