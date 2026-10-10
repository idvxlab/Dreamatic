/** Design scope belongs to Orchestrator; Skills describe their own applicability. */
export const DESIGN_CATEGORIES = [
  { id: "media_communication", name: "媒体传达设计", description: "Brand identity, logos, advertising, posters, editorial, illustration and visual information." },
  { id: "industrial", name: "工业设计", description: "Physical products, hardware, ergonomics, product architecture, materials and CMF. Digital interfaces are a separate UX scope." },
  { id: "ux", name: "UX 设计", description: "User tasks, information architecture, UI, responsive pages and interaction. UI/page tasks produce HTML prototypes." },
  { id: "space", name: "建筑与空间设计", description: "Architecture, interiors, exhibitions and spatial experience." },
  { id: "fashion", name: "服装与纺织设计", description: "Fashion, accessories, textiles, fit and construction concepts." },
  { id: "game", name: "游戏体验设计", description: "Game concepts, rules, worlds and player experience; interface tasks can use a separate UX scope." },
  { id: "service", name: "服务设计", description: "Journeys, physical/digital touchpoints and organizational handoffs." },
] as const;

export type DesignCategory = typeof DESIGN_CATEGORIES[number]["id"];
export interface DesignScope { id: string; category: DesignCategory; task: string; rationale?: string }
export function isDesignCategory(value: unknown): value is DesignCategory {
  return DESIGN_CATEGORIES.some((category) => category.id === value);
}
export function designScopes(value: unknown): DesignScope[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length === 0) throw new Error("designScopes must be a non-empty array when supplied");
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each design scope must be an object");
    const scope = item as Record<string, unknown>;
    if (typeof scope.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(scope.id) || ids.has(scope.id)) throw new Error("Design scope ids must be unique, stable identifiers");
    if (!isDesignCategory(scope.category)) throw new Error(`Unknown design category: ${String(scope.category)}`);
    if (typeof scope.task !== "string" || !scope.task.trim()) throw new Error(`Design scope ${scope.id} needs its task`);
    if (scope.rationale !== undefined && (typeof scope.rationale !== "string" || !scope.rationale.trim())) throw new Error("Scope rationale must be non-empty text");
    ids.add(scope.id);
    return { id: scope.id, category: scope.category, task: scope.task.trim(), ...(typeof scope.rationale === "string" ? { rationale: scope.rationale.trim() } : {}) };
  });
}
export function briefDesignScopes(brief: Record<string, unknown>): DesignScope[] {
  const resolved = brief.resolvedScope;
  return designScopes(resolved && typeof resolved === "object" && !Array.isArray(resolved) ? (resolved as Record<string, unknown>).designScopes : undefined);
}

/** Shared runtime handoff: ids identify tasks, categories identify domains, names identify Skills. */
export function designScopeSkillProtocol(scopes: DesignScope[]) {
  return {
    mode: scopes.length ? "classified" : "legacy_unclassified",
    namespaces: { scopeId: "Exact designScopes[].id assigned by Orchestrator", category: "Design category registry id", name: "Skill name returned by list_skills; never a scopeId" },
    assignments: scopes.map((scope) => ({ ...scope, discover: { tool: "list_skills", arguments: { scopeId: scope.id } }, defaultOutput: scope.category === "ux" ? "html_page" : "image" })),
    instruction: "Orchestrator persists category/task assignments; Designer chooses and loads Skills with use_skill(name, scopeId, role). Discovery does not load knowledge. Scope ids must remain unchanged in skill_selection, deliverables and execution tasks. Reviewer checks this committed specification; Builder executes only approved declared methods. If classification is missing in a new task, ask Orchestrator to establish it; do not infer an id from a Skill name.",
  };
}


/** User-facing classification comes from the actual persisted assignment, not a second inference. */
export function designClassificationMessage(scopes: DesignScope[], revised = false) {
  const names = [...new Set(scopes.map((scope) => DESIGN_CATEGORIES.find((category) => category.id === scope.category)!.name))];
  const summary = `${revised ? "设计类型已更新" : "设计类型识别"}：${names.join("、")}`;
  const detail = [summary, ...scopes.map((scope, index) => `${index + 1}. ${DESIGN_CATEGORIES.find((category) => category.id === scope.category)!.name}\n设计任务：${scope.task}${scope.rationale ? `\n判断依据：${scope.rationale}` : ""}`)].join("\n\n");
  return { summary, detail };
}
