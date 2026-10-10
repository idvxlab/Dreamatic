import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { briefDesignScopes } from "./design-categories.js";
import type { SkillBinding } from "./skill-activation.js";

export interface ScopeIssue {
  code: string;
  pointer: string;
  message: string;
  deliverableId?: string;
}

/** Pure diagnostics shared by editable drafts and commit/publication adapters. */
export function diagnoseDesignScopes(scopes: { id: string; category: string }[], bindings: SkillBinding[], plan: Record<string, unknown>, manifest: Record<string, unknown>, availableProfessionals: Record<string, unknown> = {}): ScopeIssue[] {
  if (!scopes.length) return [];
  const issues: ScopeIssue[] = [];
  const add = (code: string, pointer: string, message: string, deliverableId?: string) => issues.push({ code, pointer, message, ...(deliverableId ? { deliverableId } : {}) });
  const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(item => !!item && typeof item === "object" && !Array.isArray(item)) : [];
  if (!Array.isArray(plan.skill_selection)) add("missing_skill_selection", "/strategy/skill_selection", "Classified design requires skill_selection with scope_id, name, role and rationale");
  const selections = records(plan.skill_selection);
  if (Array.isArray(plan.skill_selection) && selections.length !== plan.skill_selection.length) add("invalid_skill_selection", "/strategy/skill_selection", "Skill selection needs an assigned scope_id");
  const gaps = records(plan.skill_gaps);
  const hasVerifiedGap = (id: string) => Array.isArray(availableProfessionals[id]) && availableProfessionals[id].length === 0 && gaps.some(gap => gap.scope_id === id && typeof gap.reason === "string" && gap.reason.trim());
  for (const [index, selection] of selections.entries()) {
    const pointer = `/strategy/skill_selection/${index}`;
    if (!scopes.some(scope => scope.id === selection.scope_id)) { add("invalid_skill_scope", pointer, "Skill selection needs an assigned scope_id"); continue; }
    if (typeof selection.rationale !== "string" || !selection.rationale.trim()) add("missing_skill_rationale", `${pointer}/rationale`, "Skill selection needs its task-specific rationale");
    if (!bindings.some(binding => binding.scope === selection.scope_id && binding.name === selection.name && binding.role === selection.role)) {
      const actual = bindings.find(binding => binding.scope === selection.scope_id && binding.name === selection.name);
      add("skill_not_loaded", pointer, `Skill ${String(selection.name)} was not activated for ${String(selection.scope_id)} in this invocation${actual ? ` with role ${String(selection.role)}; actual loaded role is ${actual.role}` : "; load it with use_skill first"}`);
    }
  }
  const deliverables = records(manifest.deliverables);
  const contributions = new Map<Record<string, unknown>, Record<string, unknown>[]>();
  for (const [index, deliverable] of deliverables.entries()) {
    const pointer = `/deliverables/${index}/contributing_scopes`;
    const id = String(deliverable.id);
    const extra = deliverable.contributing_scopes;
    if (extra !== undefined && !Array.isArray(extra)) add("invalid_contributing_scopes", pointer, `Deliverable ${id} contributing_scopes must be an array; [] means no additional contributions`, id);
    const entries = records(extra);
    if (Array.isArray(extra) && entries.length !== extra.length) add("invalid_contributing_scopes", pointer, "Contributing scopes must be objects", id);
    const seen = new Set([deliverable.scope_id]);
    for (const [part, entry] of entries.entries()) {
      if (seen.has(entry.scope_id)) add("duplicate_contributing_scope", `${pointer}/${part}/scope_id`, `Deliverable ${id} repeats a contributing scope ${String(entry.scope_id)}; contributing_scopes lists only additional scopes, excluding the primary scope`, id);
      seen.add(entry.scope_id);
      if (typeof entry.purpose !== "string" || !entry.purpose.trim()) add("missing_contribution_purpose", `${pointer}/${part}/purpose`, "Contributing scope needs its concrete purpose", id);
    }
    contributions.set(deliverable, entries);
  }
  for (const scope of scopes) {
    if (!bindings.some(binding => binding.scope === scope.id && binding.role === "primary" && binding.moduleType === "discipline" && binding.designCategories.includes(scope.category) && selections.some(item => item.scope_id === scope.id && item.name === binding.name)) && !hasVerifiedGap(scope.id)) add("missing_primary_skill", "/strategy/skill_selection", `Design scope ${scope.id} needs an actually loaded primary professional Skill for ${scope.category}`);
    const outputs = deliverables.filter(item => item.scope_id === scope.id || contributions.get(item)?.some(entry => entry.scope_id === scope.id));
    if (!outputs.length) add("missing_scope_deliverable", "/deliverables", `Design scope ${scope.id} has no declared deliverables. Bind a contribution with contributing_scopes instead of inventing duplicate tasks or files.`);
    if (scope.category === "ux" && !outputs.some(item => item.method === "html_generate")) add("missing_html_task", "/tasks", `UX scope ${scope.id} requires an HTML page design, not only screen-image prompts`);
  }
  for (const [index, deliverable] of deliverables.entries()) {
    const id = String(deliverable.id);
    const scope = scopes.find(item => item.id === deliverable.scope_id);
    for (const [part, entry] of [deliverable, ...contributions.get(deliverable)!].entries()) {
      const pointer = `/deliverables/${index}${part ? `/contributing_scopes/${part - 1}` : ""}`;
      const owner = scopes.find(item => item.id === entry.scope_id);
      if (!owner || entry.category !== owner.category) { add("scope_category_mismatch", pointer, `Deliverable ${id} must use an assigned scope_id and its category; actual scope_id=${String(entry.scope_id)}, category=${String(entry.category)}, expected category=${owner?.category ?? "unknown scope"}. Omit category to infer it; content genres belong in kind.`, id); continue; }
      if (!Array.isArray(entry.skill_refs) || (!entry.skill_refs.length && !hasVerifiedGap(owner.id)) || entry.skill_refs.some(name => !selections.some(selection => selection.scope_id === owner.id && selection.name === name))) add("missing_skill_refs", `${pointer}/skill_refs`, `Deliverable ${id} needs loaded skill_refs from its scope ${owner.id}. Loaded selections here: ${selections.filter(selection => selection.scope_id === owner.id).map(selection => selection.name).join(", ") || "none"}. Load each referenced Skill with use_skill scopeId:${owner.id}; loading in another scope is insufficient.`, id);
    }
    if (plan.schemaVersion === 2) {
      const task = records(plan.execution_plan).find(item => item.id === deliverable.id);
      if (deliverable.method !== "manual" && (!task || !scope || task.scope_id !== scope.id || task.category !== scope.category)) add("task_scope_mismatch", "/tasks", `Execution task ${id} must match its scope/category`, id);
    }
  }
  return issues;
}

/** New classified Runs use scoped knowledge; unclassified historical plans keep their contract. */
export async function validateDesignScopes(runDir: string, plan: Record<string, unknown>, manifest: Record<string, unknown>): Promise<void> {
  const brief = await readFile(join(runDir, "brief.json"), "utf8").then(JSON.parse).catch(() => ({}));
  const scopes = briefDesignScopes(brief);
  if (!scopes.length) return;
  const loaded = await readFile(join(runDir, ".performance/skills-designer.json"), "utf8").then(JSON.parse).catch(() => ({ activeSkills: [] }));
  const bindings: SkillBinding[] = Array.isArray(loaded.activeSkills) ? loaded.activeSkills : [];
  const issues = diagnoseDesignScopes(scopes, bindings, plan, manifest, loaded.availableProfessionals ?? {});
  if (issues.length) throw new Error([...new Set(issues.map(issue => issue.message))].join("; "));
}
