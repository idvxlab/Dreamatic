import type { SkillMetadata } from "./skill-metadata.js";

export interface SkillBinding {
  rationale?: string | undefined; name: string; role: "primary" | "supporting"; scope: string; sha256: string;
  version: string; supportedOutputs: string[]; designCategories: string[]; moduleType: string;
}
/** Invocation-local state. Persisted bindings are evidence, never proof of loaded knowledge. */
export class SkillActivation {
  #bindings = new Map<string, SkillBinding>();
  #loaded = new Map<string, string>();
  #retired = new Map<string, { name: string; scope: string }>();
  checkpoint() {
    const bindings = new Map(this.#bindings), loaded = new Map(this.#loaded), retired = new Map(this.#retired);
    return () => { this.#bindings = bindings; this.#loaded = loaded; this.#retired = retired; };
  }
  deactivated() { return [...this.#retired.values()]; }
  all(): SkillBinding[] { return [...this.#bindings.values()]; }
  activate(name: string, path: string, sha256: string, metadata: SkillMetadata, scope: string, requestedRole?: "primary" | "supporting", deactivate: string[] = [], reload = false, rationale?: string) {
    const key = `${scope}\0${name}`;
    for (const retired of deactivate) if (retired !== name) this.#retired.set(`${scope}\0${retired}`, { name: retired, scope });
    this.#retired.delete(key);
    const role = requestedRole ?? this.#bindings.get(key)?.role ?? "supporting";
    const deactivated: string[] = [];
    for (const [existingKey, binding] of this.#bindings) {
      if (binding.scope === scope && binding.name !== name && (deactivate.includes(binding.name) || (role === "primary" && binding.role === "primary"))) {
        this.#bindings.delete(existingKey); deactivated.push(binding.name);
      }
    }
    const reused = !reload && this.#loaded.get(path) === sha256;
    this.#loaded.set(path, sha256);
    this.#bindings.set(key, { rationale: rationale ?? this.#bindings.get(key)?.rationale, name, role, scope, sha256, version: metadata.version, supportedOutputs: metadata.supportedOutputs, designCategories: metadata.designCategories, moduleType: metadata.moduleType });
    return { role, scope, reused, deactivated, activeSkills: this.all().filter((binding) => binding.scope === scope).map(({ name, role }) => ({ name, role })) };
  }
}

/** Recovery aid only: Designer still chooses and loads bodies through Pi's Skill tool. */
export function skillReloadChecklist(plan: Record<string, unknown> | undefined, assignedScopes: string[], active: SkillBinding[] = []) {
  if (!Array.isArray(plan?.skill_selection)) return [];
  return plan.skill_selection.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || !assignedScopes.includes(entry.scope_id) || !["primary", "supporting"].includes(entry.role)) return [];
    const loaded = active.some((binding) => binding.scope === entry.scope_id && binding.name === entry.name && binding.role === entry.role);
    return [{ name: entry.name, scopeId: entry.scope_id, role: entry.role, loaded,
      load: { tool: "use_skill", arguments: { name: entry.name, scopeId: entry.scope_id, role: entry.role } } }];
  });
}
