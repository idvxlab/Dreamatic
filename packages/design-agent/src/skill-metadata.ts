import { isDesignCategory, type DesignCategory } from "./design-categories.js";

export interface SkillMetadata {
  audience: string;
  domainType: string;
  moduleType: string;
  supportedOutputs: string[];
  capabilities: string[];
  version: string;
  designCategories: DesignCategory[];
}
/** Metadata describes knowledge applicability; it never grants executor/tool permissions. */
export function skillMetadata(value: unknown): SkillMetadata {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const text = (key: string, fallback: string) => typeof data[key] === "string" ? data[key] as string : fallback;
  const outputs = data.supported_outputs;
  const categories = data.design_categories;
  const strings = (value: unknown) => [...new Set((Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? value.split(/[,\s]+/u) : []).map(item => item.trim()).filter(Boolean))];
  return { audience: text("audience", "unspecified"), domainType: text("domain_type", "unspecified"), moduleType: text("module_type", "discipline"), version: text("version", "unversioned"), supportedOutputs: strings(outputs), capabilities: strings(data.capabilities), designCategories: Array.isArray(categories) ? [...new Set(categories.filter(isDesignCategory))] : typeof categories === "string" ? categories.split(/[,\s]+/u).filter(isDesignCategory) : [] };
}

export function skillMatchesCategory(skill: SkillMetadata, category: DesignCategory): boolean {
  return skill.designCategories.includes(category) || (!skill.designCategories.length && ["cross_domain", "execution"].includes(skill.moduleType));
}
