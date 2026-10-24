import taxonomy from './project-taxonomy.json' with { type: 'json' };
export const PROJECT_CATEGORIES = taxonomy.categories;
export type ProjectCategoryId = 'brand' | 'visual' | 'product' | 'space' | 'digital' | 'fashion' | 'game' | 'service';
export interface ProjectClassification { schemaVersion: 1; taxonomyVersion: 'dreamatic-design-v1'; primary: ProjectCategoryId; secondary: ProjectCategoryId[] }
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function projectCategoryId(value: unknown): ProjectCategoryId | undefined {
  if (typeof value !== 'string') return;
  const key = value.trim().toLowerCase();
  return PROJECT_CATEGORIES.find(c => [c.id, c.name, c.en, ...c.aliases].some(a => a.toLowerCase() === key))?.id as ProjectCategoryId | undefined;
}
export function projectClassification(value: unknown): ProjectClassification | undefined {
  const data = record(value);
  if (data.schemaVersion !== 1 || data.taxonomyVersion !== taxonomy.taxonomyVersion || !PROJECT_CATEGORIES.some(c => c.id === data.primary) || !Array.isArray(data.secondary) || data.secondary.some(id => !PROJECT_CATEGORIES.some(c => c.id === id))) return;
  return { schemaVersion: 1, taxonomyVersion: 'dreamatic-design-v1', primary: data.primary as ProjectCategoryId, secondary: [...new Set(data.secondary as ProjectCategoryId[])].filter(id => id !== data.primary) };
}
export function classificationForIds(ids: ProjectCategoryId[]): ProjectClassification | undefined {
  const [primary, ...secondary] = [...new Set(ids)];
  return primary ? { schemaVersion: 1, taxonomyVersion: 'dreamatic-design-v1', primary, secondary } : undefined;
}
export function inferProjectClassification(...hints: unknown[]): ProjectClassification | undefined {
  for (const hint of hints) {
    if (typeof hint !== 'string') continue;
    const match = PROJECT_CATEGORIES.find(c => new RegExp(c.pattern, 'i').test(hint));
    if (match) return classificationForIds([match.id as ProjectCategoryId]);
  }
}
/** New metadata first; legacy scope definitions remain unchanged for historical readers. */
export function resolveProjectClassification(brief: unknown, manifest?: unknown): ProjectClassification | undefined {
  const b = record(brief), m = record(manifest), scope = record(b.resolvedScope);
  const direct = projectClassification(b.classification) || projectClassification(m.classification);
  if (direct) return direct;
  const legacy = [b.design_category, b.designCategory, b.design_categories, b.designCategories, scope.designScopes && Array.isArray(scope.designScopes) ? scope.designScopes.map(s => record(s).category) : [], b.workflowSkill];
  const ids = legacy.flatMap(v => Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;，；]/) : []).map(projectCategoryId).filter((id): id is ProjectCategoryId => Boolean(id));
  return classificationForIds(ids) || inferProjectClassification(b.title, b.brief);
}
