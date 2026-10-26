import { PROMPT_MIN_SIZE } from '@dreamatic/project-data/canvas-graph';
import type { CanvasElementState, ProjectFile } from './types';
export const CANVAS_MEDIA_MIME = 'application/x-dreamatic-project-media';
export function mediaKind(file: ProjectFile): 'image' | 'video' | undefined {
  if (file.url || (!file.path && !/^attachment:\d+$/u.test(file.id))) return;
  const kind = file.kind.toLowerCase();
  if (/^(png|jpe?g|webp|gif|svg)$/u.test(kind)) return 'image';
  if (/^(mp4|webm|mov)$/u.test(kind)) return 'video';
}
export function draggedMedia(data: string, runId: string, files: ProjectFile[]): ProjectFile | undefined {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object' || !('runId' in value) || value.runId !== runId || !('fileId' in value) || typeof value.fileId !== 'string') return;
    return files.find(file => file.id === value.fileId && file.category === 'assets' && mediaKind(file));
  } catch { return undefined; }
}

/** Historical auto-inventories are not user-created canvas instances. */
export function creativeCanvasElements(elements: CanvasElementState[]): CanvasElementState[] {
  const automatic = new Set(['canvas-overview-v3', 'group-overview', 'group-rationale', 'group-reference', 'group-generated', 'group-edited', 'group-other', 'group-interfaces', 'note-intent', 'note-research', 'note-plan', 'note-review']);
  return elements.filter(item => !automatic.has(item.id)
    && !(!item.fileId && item.assetPath && item.id === `asset-${item.assetPath}`))
    .map(item => item.kind === 'prompt' ? { ...item, width: Math.max(PROMPT_MIN_SIZE.width, item.width), height: Math.max(PROMPT_MIN_SIZE.height, item.height) } : item);
}
