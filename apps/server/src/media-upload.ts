import type { IncomingMessage } from 'node:http';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join, sep } from 'node:path';

export const MAX_MEDIA_UPLOAD = 100 * 1024 * 1024;
const formats: Record<string, string> = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif', svg:'image/svg+xml', mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime' };
export async function uploadProjectMedia(workspace: string, runId: string, filename: string, request: IncomingMessage) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(runId)) throw new Error('Invalid project id');
  const kind = extname(filename).slice(1).toLowerCase();
  if (!formats[kind]) throw new Error('Only image and video files can be uploaded to Canvas.');
  const type = request.headers['content-type']?.split(';')[0]?.toLowerCase();
  if (type && type !== 'application/octet-stream' && type !== formats[kind]) throw new Error('The media file type does not match its extension.');
  if (Number(request.headers['content-length']) > MAX_MEDIA_UPLOAD) throw new Error('Each media file must be 100 MB or smaller.');
  const runs = await realpath(join(workspace, 'runs'));
  const root = await realpath(join(runs, runId));
  if (!root.startsWith(runs + sep)) throw new Error('Invalid project path');
  const inputs = join(root, 'inputs');
  // Check each existing directory before creating or writing beneath it.
  await mkdir(inputs).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (await realpath(inputs) !== inputs) throw new Error('Invalid media directory');
  const folder = join(inputs, 'user-assets');
  await mkdir(folder).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (await realpath(folder) !== folder) throw new Error('Invalid media directory');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
    if (size > MAX_MEDIA_UPLOAD) throw new Error('Each media file must be 100 MB or smaller.');
    chunks.push(bytes);
  }
  if (!size) throw new Error('The selected media file is empty.');
  const stem = filename.replaceAll('\\', '/').split('/').at(-1)!.replace(/\.[^.]*$/u, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0,80) || 'media';
  const name = `${stem}-${randomUUID().slice(0,8)}.${kind}`;
  await writeFile(join(folder, name), Buffer.concat(chunks), { flag: 'wx' });
  return { id: `inputs/user-assets/${name}`, title: name, kind, size };
}
