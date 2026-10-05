export type ExecutionTask = Record<string, unknown>;
type Executor = (tasks: ExecutionTask[]) => Promise<ExecutionTask[]>;
/** Group by executor so existing image batching remains intact. */
export class ExecutionRegistry {
  #executors = new Map<string, Executor>();
  register(methods: string[], executor: Executor): this {
    for (const method of methods) {
      if (this.#executors.has(method)) throw new Error(`Executor already registered: ${method}`);
      this.#executors.set(method, executor);
    }
    return this;
  }
  async execute(tasks: ExecutionTask[]): Promise<ExecutionTask[]> {
    const groups = new Map<Executor, ExecutionTask[]>();
    for (const task of tasks) {
      const executor = this.#executors.get(String(task.method));
      if (!executor) throw new Error(`Unsupported executor: ${String(task.method)}`);
      const group = groups.get(executor) ?? [];
      group.push(task); groups.set(executor, group);
    }
    return (await Promise.all([...groups].map(([executor, group]) => executor(group)))).flat();
  }
}
