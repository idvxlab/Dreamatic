import { htmlTask } from "./design-contract.js";
import { designTasks } from "./design-context-v2.js";
import { contextSemanticIssues } from "./context-schema.js";
import { createHash } from "node:crypto";
import { Check, Errors } from "typebox/value";
import { roleContextSchema, prepareContextChanges } from "./context-tools.js";
import type { SkillBinding } from "./skill-activation.js";
import { diagnoseDesignScopes, type ScopeIssue } from "./design-scope-validation.js";

export function contextSkeleton(role: string, version = 1): Record<string, unknown> {
  if (role === "researcher") return { evidence: { official_sources: [], open_questions: [] }, findings: "", usageConditions: "" };
  if (role === "reviewer") return { assessment: { review_stage: "design_context", scores: {}, issues: [], resolved_issue_ids: [], remaining_risks: [] } };
  return { system: { palette: {}, typography: {} }, strategy: {}, ...(version === 1 ? { tasks: [] } : {}), deliverables: [], presentation: {} };
}
export function draftHash(source: string) { return createHash("sha256").update(source).digest("hex"); }
export function assembleContextDraft(role: string, input: Record<string, unknown>, bindings: SkillBinding[], scopes: { id: string; category: string }[], deactivated: { name: string; scope: string }[] = [], availableProfessionals: Record<string, unknown> = {}, version = 1): { data: Record<string, unknown>; issues: ScopeIssue[] } {
  if (role === "designer" && version === 2) {
    let projectedTasks: Record<string, unknown>[];
    try { projectedTasks = designTasks(input); }
    catch (error) { return { data: structuredClone(input), issues: [{ code: "invalid_execution_reference", pointer: "/deliverables", message: String(error) }] }; }
    const projected = { ...structuredClone(input), tasks: projectedTasks, deliverables: (input.deliverables as Record<string, unknown>[] ?? []).map(({ execution: _e, presentation: _p, ...item }) => item) };
    const assembled = assembleContextDraft(role, projected, bindings, scopes, deactivated, availableProfessionals);
    const data = { ...structuredClone(input), strategy: assembled.data.strategy, deliverables: (input.deliverables as Record<string, unknown>[] ?? []).map(item => ({ ...item, ...(assembled.data.deliverables as Record<string, unknown>[]).find(derived => derived.id === item.id) })) };
    const issues = assembled.issues.map(issue => ({ ...issue, pointer: issue.pointer.replace(/^\/tasks\/(\d+)(.*)$/u, "/deliverables/$1/execution$2") }));
    const schema = roleContextSchema(role, 2);
    if (!Check(schema, data)) for (const error of Errors(schema, data)) issues.push({ code: "invalid_context_structure", pointer: error.instancePath, message: error.message });
    issues.push(...contextSemanticIssues(role, data));
    for (const [index, item] of (data.deliverables as Record<string, unknown>[]).entries()) {
      const execution = item.execution as Record<string, unknown> | undefined;
      if (execution?.method !== "html_generate") continue;
      try { htmlTask({ ...execution, id:item.id }); }
      catch (error) { issues.push({code:"invalid_html_execution",pointer:`/deliverables/${index}/execution`,message:error instanceof Error ? error.message : String(error)}); }
    }
    return { data, issues: [...new Map(issues.map(issue => [`${issue.code}:${issue.pointer}:${issue.message}`, issue])).values()] };
  }
  const data = structuredClone(input);
  const issues: ScopeIssue[] = [];
  if (role === "designer") {
    const strategy = data.strategy;
    if (strategy && typeof strategy === "object" && !Array.isArray(strategy)) {
      const record = strategy as Record<string, unknown>;
      const prior = Array.isArray(record.skill_selection) ? record.skill_selection.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
      const selected = prior.filter(item => !deactivated.some(retired => retired.scope === item.scope_id && retired.name === item.name)
        && !bindings.some(binding => binding.role === "primary" && binding.scope === item.scope_id && item.role === "primary" && item.name !== binding.name));
      for (const binding of bindings.filter(binding => scopes.some(scope => scope.id === binding.scope))) {
        const index = selected.findIndex(item => item.scope_id === binding.scope && item.name === binding.name);
        const rationale = binding.rationale || (index >= 0 ? selected[index]?.rationale : undefined);
        if (typeof rationale !== "string" || !rationale.trim()) issues.push({ code: "missing_skill_rationale", pointer: "/strategy/skill_selection", message: `Provide task-specific rationale via use_skill for ${binding.name} in ${binding.scope}` });
        const choice = { scope_id: binding.scope, name: binding.name, role: binding.role, rationale: rationale ?? "" };
        if (index < 0) selected.push(choice); else selected[index] = choice;
      }
      record.skill_selection = selected;
    }
    for (const item of (Array.isArray(data.deliverables) ? data.deliverables : [])) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const entries = [item, ...(Array.isArray(item.contributing_scopes) ? item.contributing_scopes : [])];
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const scope = scopes.find(scope => scope.id === entry.scope_id);
        if (scope && entry.category === undefined) entry.category = scope.category;
      }
    }
  }
  if (role === "designer" && Array.isArray(data.tasks) && Array.isArray(data.deliverables)) {
    const ids = new Set<string>();
    for (const [index, task] of data.tasks.entries()) {
      if (!task || typeof task !== "object" || Array.isArray(task)) continue;
      if (ids.has(task.id)) issues.push({ code: "duplicate_task_id", pointer: `/tasks/${index}/id`, message: `Duplicate task id ${task.id}` });
      ids.add(task.id);
      const owner = data.deliverables.find(item => item && typeof item === "object" && item.id === task.id);
      if (owner && scopes.length && task.method !== "manual") {
        for (const key of ["scope_id", "category"]) {
          if (task[key] === undefined) task[key] = owner[key];
          else if (task[key] !== owner[key]) issues.push({ code: "task_scope_mismatch", pointer: `/tasks/${index}/${key}`, message: `Task ${task.id} must match its deliverable ${key}` });
        }
      }
    }
    for (const [index, item] of data.deliverables.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (!ids.has(item.id)) issues.push({ code: "missing_task", pointer: `/deliverables/${index}/id`, message: `Add a task with id ${item.id}; preserve this deliverable id. To rename/remove old items use removeTasks/removeDeliverables, or replaceTasks/replaceDeliverables with complete collections.` });
      for (const field of ["method", "size"]) if (field in item) issues.push({ code: "task_field_on_deliverable", pointer: `/deliverables/${index}/${field}`, message: `Keep ${field} only on the matching task` });
    }
  }
  if (role === "designer") {
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const deliverables = (Array.isArray(data.deliverables) ? data.deliverables : []).filter(item => item && typeof item === "object" && !Array.isArray(item)).map(item => ({ ...item, method: tasks.find(task => task && task.id === item.id)?.method }));
    issues.push(...diagnoseDesignScopes(scopes, bindings, { ...(data.strategy as Record<string, unknown>), schemaVersion: 2, execution_plan: tasks }, { deliverables }, availableProfessionals));
  }
  const schema = roleContextSchema(role);
  if (!Check(schema, data)) for (const error of Errors(schema, data)) issues.push({ code: "invalid_context_structure", pointer: error.instancePath, message: error.message });
  issues.push(...contextSemanticIssues(role, data));
  return { data, issues };
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

export function contextReadiness(issues: ScopeIssue[]) {
  if (!issues.length) return "ready";
  return issues.every(issue => issue.code === "invalid_context_structure" || issue.code.startsWith("missing_")) ? "incomplete" : "blocked";
}

/** A repair view is complete for its selected objects, independent of overview budgets. */
export function selectContextSection(role: string, data: Record<string, unknown>, section: string, ids?: string[], version = 1) {
  if (!Object.hasOwn(roleContextSchema(role, version).properties, section)) throw new Error(`Context section is not available to ${role}: ${section}`);
  if (ids && !["tasks", "deliverables"].includes(section)) throw new Error("ids selects only tasks or deliverables");
  const value = data[section];
  if (!ids) return { [section]: value };
  const items = Array.isArray(value) ? value.filter(isRecord) : [];
  const missing = ids.filter(id => !items.some(item => item.id === id));
  if (missing.length) throw new Error(`Working Context ${section} ids not found: ${missing.join(", ")}`);
  return { [section]: items.filter(item => ids.includes(String(item.id))) };
}
/** Objects merge by field; ordinary arrays replace; tasks/deliverables upsert by id. */
export function mergeContextChanges(role: string, previous: Record<string, unknown>, changes: Record<string, unknown>) {
  return mergePreparedContextChanges(role, previous, prepareContextChanges({ changes }, role).changes);
}
/** Internal merge receives the validated Pi tool input. */
export function mergePreparedContextChanges(role: string, previous: Record<string, unknown>, changes: Record<string, unknown>, version = 1) {
  const allowed = new Set(Object.keys(roleContextSchema(role, version).properties));
  const forbidden = new Set(["__proto__", "prototype", "constructor"]);
  function replacement(value: unknown, path: string): unknown {
    if (isRecord(value)) return merge({}, value, path);
    if (Array.isArray(value)) return value.map((item, index) => replacement(item, `${path}/${index}`));
    return structuredClone(value);
  }
  function merge(target: Record<string, unknown>, patch: Record<string, unknown>, path: string) {
    for (const [key, value] of Object.entries(patch)) {
      if (key === "unsetFields") continue;
      if (forbidden.has(key)) throw new Error(`Protected field: ${path}/${key}`);
      if (isRecord(value)) {
        const child = isRecord(target[key]) ? target[key] as Record<string, unknown> : {};
        target[key] = merge(child, value, `${path}/${key}`);
      } else target[key] = replacement(value, `${path}/${key}`);
    }
    for (const key of (patch.unsetFields ?? []) as string[]) delete target[key];
    return target;
  }
  const data = structuredClone(previous);
  for (const [field, removal] of [["tasks", "removeTasks"], ["deliverables", "removeDeliverables"]] as const) {
    if (Array.isArray(changes[field]) && Array.isArray(changes[removal])) {
      const ids = (changes[field] as unknown[]).filter(isRecord).map(item => item.id);
      if ((changes[removal] as unknown[]).some(id => ids.includes(id))) throw new Error(`Cannot update and remove the same ${field} id in one changes object`);
    }
  }
  for (const [key, value] of Object.entries(changes)) {
    if (key === "unsetFields") { for (const field of value as string[]) delete data[field]; continue; }
    if (role === "designer" && ["removeTasks", "removeDeliverables"].includes(key)) {
      if (!Array.isArray(value) || value.some(id => typeof id !== "string")) throw new Error(`${key} must contain stable ids`);
      const field = key === "removeTasks" ? "tasks" : "deliverables";
      data[field] = (Array.isArray(data[field]) ? data[field] as unknown[] : []).filter(item => !isRecord(item) || !value.includes(item.id));
      continue;
    }
    if (role === "designer" && ["replaceTasks", "replaceDeliverables"].includes(key)) {
      const field = key === "replaceTasks" ? "tasks" : "deliverables";
      if (changes[field] !== undefined || changes[field === "tasks" ? "removeTasks" : "removeDeliverables"] !== undefined) throw new Error("Replacement cannot combine with upserts/removals for the same collection");
      if (!Array.isArray(value) || value.some(item => !isRecord(item) || typeof item.id !== "string") || new Set(value.map(item => (item as Record<string, unknown>).id)).size !== value.length) throw new Error(`${key} requires complete items with unique stable ids`);
      data[field] = replacement(value, `/${field}`);
      continue;
    }
    if (!allowed.has(key)) throw new Error(`Invalid role field: ${key}`);
    if (role === "designer" && ["tasks", "deliverables"].includes(key)) {
      if (!Array.isArray(value)) throw new Error(`${key} must be an array of id-keyed objects`);
      if (!value.length) { data[key] = []; continue; }
      const items = Array.isArray(data[key]) ? structuredClone(data[key]) as unknown[] : [];
      const supplied = new Set<string>();
      for (const patch of value) {
        if (!isRecord(patch) || typeof patch.id !== "string" || !patch.id.trim()) throw new Error(`${key} items require a stable id`);
        if (supplied.has(patch.id)) throw new Error(`Duplicate ${key} update id: ${patch.id}`);
        supplied.add(patch.id);
        const index = items.findIndex(item => isRecord(item) && item.id === patch.id);
        const { unsetFields, ...fields } = patch;
        const item = merge(index < 0 ? {} : items[index] as Record<string, unknown>, fields, `/${key}/${patch.id}`);
        for (const field of (unsetFields ?? []) as string[]) delete item[field];
        if (index < 0) items.push(item); else items[index] = item;
      }
      data[key] = items;
    } else merge(data, { [key]: value }, "");
  }
  return data;
}
