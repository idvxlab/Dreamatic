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
