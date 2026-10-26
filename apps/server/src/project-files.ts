import { readFile, readdir, realpath, stat, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join, relative, resolve, sep } from 'node:path';
import { CONTEXT_FILES, CONTEXT_PROJECTIONS, hasUnifiedContext, readRunContext } from '@dreamatic/project-data';

export interface ProjectFile {
  id: string;
  title: string;
  editId?: string; targetDimensions?: {width:number;height:number}; outputDimensions?: {width:number;height:number}; requestSize?: string; dimensionStatus?: 'exact' | 'same-ratio' | 'near-ratio' | 'different-ratio';
  originalName?: string;
  kind: string;
  category: 'context' | 'assets' | 'references';
  group: string;
  path?: string;
  url?: string;
  size?: number;
  modifiedAt?: string;
  metadata?: string;
}
const extensions = new Set(['md', 'txt', 'json', 'csv', 'html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'mp4', 'webm', 'mov', 'glb', 'gltf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx']);
const mimeKinds: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/html': 'html', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'image/svg+xml': 'svg' };
function checkedId(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(id)) throw new Error('Invalid run id');
  return id;
}
async function rootPath(workspace: string, id: string) {
  const runs = await realpath(join(workspace, 'runs'));
  const root = await realpath(join(runs, checkedId(id)));
  if (!root.startsWith(runs + sep)) throw new Error('Invalid project path');
  return root;
}
async function inside(root: string, path: string) {
  if (!path || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid project file path');
  const target = await realpath(resolve(root, path));
  if (!target.startsWith(root + sep)) throw new Error('Invalid project file path');
  return target;
}
function contextFile(path: string) {
  return /^(intent|research|design|showcase)\.md$/u.test(path) || /^(context|plan|review)\//u.test(path) || /^research\/[^/]+\.(md|json)$/u.test(path) || path === 'design-context.json';
}
function visible(path: string) {
  const kind = extname(path).slice(1).toLowerCase();
  if (!extensions.has(kind) || path.split('/').some(part => part.startsWith('.'))) return false;
  if (contextFile(path)) return true;
  return /^(inputs\/user-assets|research\/assets|references|artifacts|final)\//u.test(path)
    && !/^(plan\/html)\//u.test(path) && (kind !== 'json' || /^(inputs\/user-assets|references)\//u.test(path));
}
async function attachments(root: string): Promise<Array<{ name?: string; data: string; mimeType: string }>> {
  return inside(root, 'attachments.json').then(path => readFile(path, 'utf8')).then(source => {
    const items: unknown = JSON.parse(source);
    return Array.isArray(items) ? items.filter(item => item && typeof item.data === 'string' && typeof item.mimeType === 'string') : [];
  }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
}
function webUrl(value: string): string | undefined {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
/** Read-only projection: retain original numbering and source text; never invent metadata. */
export function bibliography(source: string, origin: string): ProjectFile[] {
  const lines = source.split('\n');
  const result: ProjectFile[] = [];
  let section = false;
  let entry: string[] = [];
  const flush = () => {
    if (!entry.length) return;
    const metadata = entry.join('\n').trim();
    const link = metadata.match(/https?:\/\/[^\s<>"\])]+/u)?.[0];
    const url = link ? webUrl(link.replace(/[.,;。；]+$/u, '')) : undefined;
    result.push({ id: `citation:${origin}:${result.length}`, title: metadata.split('\n')[0]!, kind: url ? 'web' : 'txt', category: 'references', group: 'Bibliography', ...(url ? { url } : {}), metadata });
    entry = [];
  };
  for (const line of lines) {
    if (/^#{1,6}\s/u.test(line)) {
      flush(); section = /references|bibliography|参考文献|参考资料|引用来源|来源目录/iu.test(line); continue;
    }
    if (/^\s*(?:[-*]\s*)?\[\d+\]\s+/u.test(line) || (section && /^\s*(?:\d+[.)]|[-*])\s+/u.test(line))) { flush(); entry = [line]; }
    else if (entry.length && line.trim()) entry.push(line);
  }
  flush();
  return result;
}
export async function projectFiles(workspace: string, id: string): Promise<ProjectFile[]> {
  const root = await rootPath(workspace, id);
  const files: ProjectFile[] = [];
  async function walk(directory: string) {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (child.name.startsWith('.') || child.isSymbolicLink()) continue;
      const absolute = join(directory, child.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (child.isDirectory()) {
        if (/^(context|plan|review|research|references|artifacts|final|inputs)(\/|$)/u.test(path) && !path.startsWith('plan/html')) await walk(absolute);
      } else if (visible(path)) {
        const info = await stat(absolute);
        const context = contextFile(path);
        files.push({ id: path, path, title: path.split('/').at(-1)!, kind: extname(path).slice(1).toLowerCase(), category: context ? 'context' : 'assets', group: context ? 'Design Context' : path.startsWith('inputs/') ? 'Uploaded files' : /^(research|references)\//u.test(path) ? 'Research materials' : 'Generated works', size: info.size, modifiedAt: info.mtime.toISOString() });
      }
    }
  }
  await walk(root);
  if (await hasUnifiedContext(root)) {
    for (const [owner, projections] of Object.entries(CONTEXT_PROJECTIONS)) {
      const canonical = owner === 'researcher' ? CONTEXT_FILES.research : owner === 'designer' ? CONTEXT_FILES.design : CONTEXT_FILES.review;
      if (!files.some(file => file.path === canonical)) continue;
      const modifiedAt = files.find(file => file.path === canonical)?.modifiedAt;
      for (const path of projections) {
        const existing = files.find(file => file.path === path);
        if (existing && modifiedAt) existing.modifiedAt = modifiedAt;
        else if (!existing) files.push({ id: path, path, title: path.split('/').at(-1)!, kind: extname(path).slice(1), category: 'context', group: 'Design Context', ...(modifiedAt ? { modifiedAt } : {}) });
      }
    }
  }
  const uploaded = await attachments(root);
  const uploadModifiedAt = uploaded.length ? await stat(await inside(root, 'attachments.json')).then(info => info.mtime.toISOString()) : undefined;
  uploaded.forEach((item, index) => files.push({ id: `attachment:${index}`, title: item.name || `Attachment ${index + 1}`, kind: mimeKinds[item.mimeType] ?? 'bin', category: 'assets', group: 'Uploaded files', ...(uploadModifiedAt ? { modifiedAt: uploadModifiedAt } : {}), size: Buffer.byteLength(item.data.replace(/^data:[^,]+,/, ''), 'base64') }));
  const citations: ProjectFile[] = files.filter(file => file.path && /^(references|research\/assets)\//u.test(file.path)).map(file => ({ ...file, category: 'references', group: 'Local references' }));
  for (const file of files.filter(file => file.category === 'context' && file.kind === 'md' && /research|design|findings/u.test(file.id))) {
    const source = await readRunContext(root, file.id).catch(() => '');
    citations.push(...bibliography(source, file.id));
  }
  // Unified research retains structured evidence alongside its human-readable findings.
  const evidence = await readRunContext(root, CONTEXT_FILES.research).then(JSON.parse).catch(() => readRunContext(root, 'research/evidence.json').then(JSON.parse).catch(() => undefined));
  function collect(value: unknown, key: string) {
    if (Array.isArray(value)) { value.forEach((item, index) => collect(item, `${key}:${index}`)); return; }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    const url = typeof item.url === 'string' ? webUrl(item.url) : undefined;
    if (url) citations.push({ id: `evidence:${key}`, title: typeof item.title === 'string' ? item.title : url, kind: 'web', category: 'references', group: 'Research sources', url, metadata: JSON.stringify(item, null, 2) });
    Object.entries(item).forEach(([name, child]) => { if (typeof child === 'object') collect(child, `${key}:${name}`); });
  }
  collect(evidence?.evidence ?? evidence, 'research');
  const seen = new Set<string>();
  for (const citation of citations) {
    const key = citation.url ?? citation.path ?? citation.metadata!;
    if (!seen.has(key)) { seen.add(key); files.push(citation); }
  }
  const names = await readMediaNames(root);
  for (const file of files) {
    if (file.category === 'assets' && names[file.id]) {
      file.originalName = file.title;
      file.title = names[file.id]!;
    }
  }
  return files.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
export async function projectFileContent(workspace: string, id: string, fileId: string): Promise<{ data: Buffer; kind: string; filename: string }> {
  const root = await rootPath(workspace, id);
  const catalog = await projectFiles(workspace, id);
  const file = catalog.find(file => file.id === fileId && file.kind !== 'web');
  if (!file) throw new Error('Project file not found');
  if (fileId.startsWith('attachment:')) {
    const item = (await attachments(root))[Number(fileId.slice('attachment:'.length))]!;
    return { data: Buffer.from(item.data.replace(/^data:[^,]+,/, ''), 'base64'), kind: file.kind, filename: file.originalName ?? file.title };
  }
  if (!file.path) return { data: Buffer.from(file.metadata ?? ''), kind: 'txt', filename: file.originalName ?? file.title };
  if (file.category === 'context') return { data: Buffer.from(await readRunContext(root, file.path)), kind: file.kind, filename: file.originalName ?? file.title };
  return { data: await readFile(await inside(root, file.path)), kind: file.kind, filename: file.originalName ?? file.title };
}

const nameWrites = new Map<string, Promise<unknown>>();
async function readMediaNames(root: string): Promise<Record<string, string>> {
  const source = await inside(root, 'media-names.json').then(path => readFile(path, 'utf8')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  });
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid media names');
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
/** Display labels only: never change source files or generated document references. */
export async function renameProjectMedia(workspace: string, runId: string, fileId: unknown, title: unknown) {
  if (typeof fileId !== 'string' || typeof title !== 'string' || !title.trim() || title.trim().length > 120 || /[\x00-\x1f\x7f]/u.test(title)) throw new Error('Use a name between 1 and 120 characters without control characters.');
  const name = title.trim();
  const root = await rootPath(workspace, runId);
  const operation = (nameWrites.get(root) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const file = (await projectFiles(workspace, runId)).find(file => file.id === fileId && file.category === 'assets' && /^(png|jpe?g|webp|gif|svg|mp4|webm|mov)$/u.test(file.kind));
    if (!file) throw new Error('Project media not found');
    const names = await readMediaNames(root);
    const temporary = join(root, `media-names.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ ...names, [fileId]: name }, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(root, 'media-names.json'));
    } finally { await rm(temporary, { force: true }); }
    return { id: fileId, title: name };
  });
  nameWrites.set(root, operation);
  try { return await operation; } finally { if (nameWrites.get(root) === operation) nameWrites.delete(root); }
}
