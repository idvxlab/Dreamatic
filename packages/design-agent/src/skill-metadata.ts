import { isDesignCategory, type DesignCategory } from "./design-categories.js";

export interface SkillMetadata {
  audience: string;
  domainType: string;
  moduleType: string;
  supportedOutputs: string[];
  version: string;
  designCategories: DesignCategory[];
}
/** Metadata describes knowledge applicability; it never grants executor/tool permissions. */
export function skillMetadata(value: unknown): SkillMetadata {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const text = (key: string, fallback: string) => typeof data[key] === "string" ? data[key] as string : fallback;
  const outputs = data.supported_outputs;
  const categories = data.design_categories;
  return { audience: text("audience", "unspecified"), domainType: text("domain_type", "unspecified"), moduleType: text("module_type", "discipline"), version: text("version", "unversioned"), supportedOutputs: Array.isArray(outputs) ? outputs.filter((value): value is string => typeof value === "string") : typeof outputs === "string" ? outputs.split(/[,\s]+/u).filter(Boolean) : [], designCategories: Array.isArray(categories) ? [...new Set(categories.filter(isDesignCategory))] : typeof categories === "string" ? categories.split(/[,\s]+/u).filter(isDesignCategory) : [] };
}

export function skillMatchesCategory(skill: SkillMetadata, category: DesignCategory): boolean {
  return skill.designCategories.includes(category) || (!skill.designCategories.length && ["cross_domain", "execution"].includes(skill.moduleType));
}
