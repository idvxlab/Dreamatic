/** One owner counts each operation once; event adapters share this policy. */
export class ContextFailureTracker {
  #counts = new Map<string, number>();
  #operations = new Set<string>();
  record(key: string, operationId?: string) {
    const operation = operationId ? `${operationId}\0${key}` : undefined;
    if (operation && this.#operations.has(operation)) return this.#counts.get(key) ?? 0;
    if (operation) this.#operations.add(operation);
    const attempts = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, attempts);
    return attempts;
  }
  clear() { this.#counts.clear(); this.#operations.clear(); }
}
