/** One authored deliverable owns identity, scope, output and execution. Views are disposable. */
export function designTasks(data: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(data.tasks)) return data.tasks as Record<string, unknown>[];
  const items = Array.isArray(data.deliverables) ? data.deliverables as Record<string, unknown>[] : [];
  return items.map(item => {
    const execution = item.execution as Record<string, unknown> | undefined;
    const uses = Array.isArray(execution?.uses) ? execution.uses as string[] : [];
    const resources = uses.map(id => {
      const reference = items.find(candidate => candidate.id === id);
      if (!reference || reference.id === item.id) throw new Error(`Deliverable ${item.id} has an invalid execution.uses reference: ${id}`);
      // Dependencies express execution order. Only HTML image dependencies need
      // copied resource mappings; page links and edit anchors are not resources.
      if (execution?.method !== "html_generate" || !["image_generate", "image_edit"].includes(String((reference.execution as Record<string, unknown> | undefined)?.method))) return undefined;
      const mapped = Array.isArray(execution?.resources) && execution.resources.some(resource => (resource as Record<string, unknown>).source === reference.file);
      return mapped ? undefined : { source: reference.file, output: reference.file };
    }).filter(Boolean);
    return { ...execution, id: item.id, scope_id: item.scope_id, category: item.category,
      ...(uses.length ? { dependencies: uses, resources: [...(Array.isArray(execution?.resources) ? execution.resources : []), ...resources] } : {}) };
  });
}
export function designDeliverables(data: Record<string, unknown>): Record<string, unknown>[] {
  const tasks = designTasks(data);
  return (data.deliverables as Record<string, unknown>[] ?? []).map(item => {
    const { execution: _execution, ...fields } = item;
    const task = tasks.find(task => task.id === item.id);
    return { ...fields, method: task?.method, ...(task?.size === undefined ? {} : { size: task.size }) };
  });
}
/** Explicit conversion for a revision/legacy adapter only; never writes an existing Run. */
export function upgradeDesignData(data: Record<string, unknown>) {
  if (!Array.isArray(data.tasks)) return structuredClone(data);
  const { tasks, ...fields } = structuredClone(data);
  return { ...fields, deliverables: (fields.deliverables as Record<string, unknown>[]).map(item => {
    const task = (tasks as Record<string, unknown>[]).find(task => task.id === item.id);
    if (!task) throw new Error(`Cannot migrate deliverable ${item.id}: matching task missing`);
    for (const field of ["scope_id", "category"]) if (task[field] !== undefined && item[field] !== undefined && task[field] !== item[field]) throw new Error(`Cannot migrate deliverable ${item.id}: conflicting ${field}`);
    const { id: _id, scope_id: _scope, category: _category, dependencies, ...execution } = task;
    if (Array.isArray(dependencies) && dependencies.length) execution.uses = dependencies;
    if (execution.method === "html_generate") {
      const checks = Array.isArray(execution.interaction_checks) ? execution.interaction_checks as Record<string, unknown>[] : [];
      execution.interaction_requirements = checks.map((check, index) => ({ id: `legacy-${index + 1}`, goal: check.name, initial_state: "Declared page loaded", ...(check.viewport ? { viewport: check.viewport } : {}), ...(check.page ? { page: check.page } : {}), outcome: (check.steps as Record<string, unknown>[] ?? []).filter(step => String(step.action).startsWith("expect_")) }));
      execution.interaction_checks = checks.map((check, index) => ({ ...check, requirement_id: `legacy-${index + 1}` }));
    }
    return { ...item, user_requested: item.required === true, presentation: item.required === true ? { required: true, access: "embed" } : { required: false, rationale: "Historical optional supporting output; Designer must verify intent during this revision" }, execution };
  }) };
}
