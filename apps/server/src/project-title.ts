import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Role documents reserve their first H1 for the work name. Never infer it from prose or image prompts. */
export function workTitle(markdown: string): string | undefined {
  const heading = /^# +(.+?)\s*#*\s*$/m.exec(markdown.replace(/^\uFEFF/, ''))?.[1];
  if (!heading) return;
  const title = heading.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim();
  if (!title || title.length > 120 || /[<>\x00-\x1f]/.test(title)) return;
  if (/^(?:design(?: proposal| plan| document)?|intent(?: brief)?|untitled(?: design)?|tbd|作品名称(?:待定)?|待定|未命名|设计(?:方案|计划|文档)|意图理解)$/i.test(title)) return;
  return title;
}

export async function updateWorkTitle(root: string, markdown: string, stage: 'orchestrator' | 'designer'): Promise<string | undefined> {
  const title = workTitle(markdown);
  if (!title) return;
  const path = join(root, 'brief.json');
  const brief = JSON.parse(await readFile(path, 'utf8'));
  // Replaying an earlier checkpoint must not replace a later Designer name.
  if (stage === 'orchestrator' && brief.titleSource === 'designer') return;
  if (brief.title === title && brief.titleStatus === 'formal' && brief.titleSource === stage) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ ...brief, title, titleStatus: 'formal', titleSource: stage }, null, 2));
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  // An explicit project rename retains precedence over automatic naming.
  const display = JSON.parse(await readFile(join(root, 'project-display.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  }));
  return typeof display.title === 'string' && display.title.trim() ? undefined : title;
}
