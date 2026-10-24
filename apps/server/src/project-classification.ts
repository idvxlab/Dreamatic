import { projectClassification, inferProjectClassification, type ProjectClassification } from '@dreamatic/project-data';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
/** Called only after a complete stage document has been validated and saved. */
export async function saveProjectClassification(root: string, stage: 'orchestrator' | 'designer', candidate: unknown, markdown: string): Promise<ProjectClassification | undefined> {
  const path = join(root, 'brief.json');
  const brief = JSON.parse(await readFile(path, 'utf8'));
  if (stage === 'orchestrator' && brief.classificationSource === 'designer') return;
  const next = projectClassification(candidate) || inferProjectClassification(/^# +(.+)$/m.exec(markdown)?.[1], brief.brief) || projectClassification(brief.classification);
  if (!next || (JSON.stringify(next) === JSON.stringify(brief.classification) && brief.classificationSource === stage)) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ ...brief, classification: next, classificationSource: stage }, null, 2));
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return next;
}
