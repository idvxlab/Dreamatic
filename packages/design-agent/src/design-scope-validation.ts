import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { briefDesignScopes } from "./design-categories.js";
import type { SkillBinding } from "./skill-activation.js";

/** New classified Runs use scoped knowledge; unclassified historical plans keep their contract. */
export async function validateDesignScopes(runDir: string, plan: Record<string, unknown>, manifest: Record<string, unknown>): Promise<void> {
  const brief = await readFile(join(runDir, "brief.json"), "utf8").then(JSON.parse).catch(() => ({}));
  const scopes = briefDesignScopes(brief);
  if (!scopes.length) return;
  const loaded = await readFile(join(runDir, ".performance/skills-designer.json"), "utf8").then(JSON.parse).catch(() => ({ activeSkills: [] }));
  const bindings: SkillBinding[] = Array.isArray(loaded.activeSkills) ? loaded.activeSkills : [];
  if (!Array.isArray(plan.skill_selection)) throw new Error("Classified design requires skill_selection with scope_id, name, role and rationale");
  const selections = plan.skill_selection as Record<string, unknown>[];
  const gaps = Array.isArray(plan.skill_gaps) ? plan.skill_gaps as Record<string, unknown>[] : [];
  const issues: string[] = [];
  const hasVerifiedGap = (id: string) => Array.isArray(loaded.availableProfessionals?.[id]) && loaded.availableProfessionals[id].length === 0 && gaps.some((gap) => gap.scope_id === id && typeof gap.reason === "string" && gap.reason.trim());
  for (const selection of selections) {
    if (!selection || typeof selection !== "object" || !scopes.some((scope) => scope.id === selection.scope_id)) { issues.push("Skill selection needs an assigned scope_id"); continue; }
    if (typeof selection.rationale !== "string" || !selection.rationale.trim()) issues.push("Skill selection needs its task-specific rationale");
    if (!bindings.some((binding) => binding.scope === selection.scope_id && binding.name === selection.name && binding.role === selection.role)) {
      const actual = bindings.find((binding) => binding.scope === selection.scope_id && binding.name === selection.name);
      issues.push(`Skill ${String(selection.name)} was not activated for ${String(selection.scope_id)} in this invocation${actual ? ` with role ${String(selection.role)}; actual loaded role is ${actual.role}` : "; load it with use_skill first"}`);
    }
  }
  const deliverables = Array.isArray(manifest.deliverables) ? manifest.deliverables as Record<string, unknown>[] : [];
  const contributions = new Map<Record<string, unknown>, Record<string, unknown>[]>();
  for (const deliverable of deliverables) {
    const extra = deliverable.contributing_scopes;
    if (extra !== undefined && (!Array.isArray(extra) || !extra.length)) issues.push(`Deliverable ${String(deliverable.id)} contributing_scopes must be a nonempty array`);
    const entries = Array.isArray(extra) ? extra.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry)) : [];
    if (Array.isArray(extra) && entries.length !== extra.length) issues.push("Contributing scopes must be objects");
    const ids = [deliverable.scope_id, ...entries.map((entry) => entry.scope_id)];
    if (new Set(ids).size !== ids.length) issues.push(`Deliverable ${String(deliverable.id)} repeats a contributing scope`);
    for (const entry of entries) if (typeof entry.purpose !== "string" || !entry.purpose.trim()) issues.push("Contributing scope needs its concrete purpose");
    contributions.set(deliverable, entries);
  }
  for (const scope of scopes) {
    if (!bindings.some((binding) => binding.scope === scope.id && binding.role === "primary" && binding.moduleType === "discipline" && binding.designCategories.includes(scope.category) && selections.some((item) => item?.scope_id === scope.id && item.name === binding.name)) && !hasVerifiedGap(scope.id)) issues.push(`Design scope ${scope.id} needs an actually loaded primary professional Skill for ${scope.category}`);
    const outputs = deliverables.filter((item) => item.scope_id === scope.id || contributions.get(item)?.some((entry) => entry.scope_id === scope.id));
    if (!outputs.length) issues.push(`Design scope ${scope.id} has no declared deliverables. Bind a contribution with contributing_scopes instead of inventing duplicate tasks or files.`);
    if (scope.category === "ux" && !outputs.some((item) => item.method === "html_generate")) issues.push(`UX scope ${scope.id} requires an HTML page design, not only screen-image prompts`);
  }
  for (const deliverable of deliverables) {
    const scope = scopes.find((item) => item.id === deliverable.scope_id);
    for (const entry of [deliverable, ...contributions.get(deliverable)!]) {
      const owner = scopes.find((item) => item.id === entry.scope_id);
      if (!owner || entry.category !== owner.category) { issues.push(`Deliverable ${String(deliverable.id)} must match its assigned scope_id/category`); continue; }
      if (!Array.isArray(entry.skill_refs) || (!entry.skill_refs.length && !hasVerifiedGap(owner.id)) || entry.skill_refs.some((name) => !selections.some((selection) => selection?.scope_id === owner.id && selection.name === name))) issues.push(`Deliverable ${String(deliverable.id)} needs loaded skill_refs from its scope ${owner.id}`);
    }
    if (plan.schemaVersion === 2) {
      const task = Array.isArray(plan.execution_plan) ? (plan.execution_plan as Record<string, unknown>[]).find((item) => item.id === deliverable.id) : undefined;
      if (deliverable.method !== "manual" && (!task || !scope || task.scope_id !== scope.id || task.category !== scope.category)) issues.push(`Execution task ${String(deliverable.id)} must match its scope/category`);
    }
  }
  if (issues.length) throw new Error([...new Set(issues)].join("; "));
}
