export type ExecutionTask = Record<string, unknown>;
type Executor = (tasks: ExecutionTask[]) => Promise<ExecutionTask[]>;
/** Schedule approved domain tasks as soon as their actual dependencies finish. */
export class ExecutionRegistry {
  #executors = new Map<string, Executor>();
  register(methods: string[], executor: Executor): this {
    for (const method of methods) {
      if (this.#executors.has(method)) throw new Error(`Executor already registered: ${method}`);
      this.#executors.set(method, executor);
    }
    return this;
  }
  async execute(tasks: ExecutionTask[], dependencies: (task: ExecutionTask) => string[], options: {
    concurrency: number; signal?: AbortSignal; onResult?: (result: ExecutionTask) => void;
  }): Promise<ExecutionTask[]> {
    const pending = new Map(tasks.map(task => [String(task.id), task]));
    if (pending.size !== tasks.length) throw new Error("Execution task ids must be unique");
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error("Execution plan has cyclic dependencies");
      if (visited.has(id)) return;
      const task = pending.get(id);
      if (!task) throw new Error(`Unknown approved dependency: ${id}`);
      if (!this.#executors.has(String(task.method))) throw new Error(`Unsupported executor: ${String(task.method)}`);
      visiting.add(id); dependencies(task).forEach(visit); visiting.delete(id); visited.add(id);
    };
    pending.forEach((_, id) => visit(id));
    const finished = new Map<string, ExecutionTask>();
    const active = new Map<string, Promise<void>>();
    const concurrency = Math.max(1, Math.floor(options.concurrency) || 1);
    const finish = (id: string, result: ExecutionTask) => {
      finished.set(id, result); options.onResult?.(result);
    };
    try {
      while (pending.size || active.size) {
        options.signal?.throwIfAborted();
        let progressed = false;
        for (const [id, task] of pending) {
          const deps = dependencies(task);
          if (!deps.every(dep => finished.has(dep))) continue;
          if (deps.some(dep => finished.get(dep)!.ok !== true)) {
            pending.delete(id); progressed = true; finish(id, { ok: false, id, error: "Required dependency failed" }); continue;
          }
          if (active.size >= concurrency) continue;
          pending.delete(id); progressed = true;
          const operation = Promise.resolve().then(async () => {
            options.signal?.throwIfAborted();
            const results = await this.#executors.get(String(task.method))!([task]);
            const result = results.find(item => String(item.id) === id);
            if (!result) throw new Error(`Executor omitted result for ${id}`);
            finish(id, result);
          }).finally(() => { active.delete(id); });
          active.set(id, operation);
        }
        if (active.size) await Promise.race(active.values());
        else if (pending.size && !progressed) throw new Error("Execution plan has unresolved dependencies");
      }
      options.signal?.throwIfAborted();
      return tasks.map(task => finished.get(String(task.id))!);
    } finally {
      // Never return while sibling executors are still writing outputs.
      await Promise.allSettled(active.values());
    }
  }
}
