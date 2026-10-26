export const PROMPT_MIN_SIZE = { width: 300, height: 240 } as const;
/** Pure canvas data rules, shared by persistence and interactions. Ports hold any number of edges. */
export interface CanvasEdge { id: string; source: string; target: string }
export interface GraphNode { id: string; kind: string }
export function validCanvasConnection(nodes: GraphNode[], edges: CanvasEdge[], source: string, target: string): boolean {
  const from = nodes.find(node => node.id === source), to = nodes.find(node => node.id === target);
  if (!from || !to || source === target || !((from.kind === 'image' && to.kind === 'prompt') || (from.kind === 'prompt' && to.kind === 'image'))) return false;
  if (edges.some(edge => edge.source === source && edge.target === target)) return false;
  // A creation chain is a DAG; cycles cannot express a material's provenance.
  const pending = [target], visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === source) return false;
    if (visited.has(id)) continue;
    visited.add(id); edges.filter(edge => edge.source === id).forEach(edge => pending.push(edge.target));
  }
  return true;
}
export function normalizeCanvasEdges(nodes: GraphNode[], value: unknown): CanvasEdge[] {
  const edges: CanvasEdge[] = [];
  if (Array.isArray(value)) for (const entry of value) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 180 || typeof entry.source !== 'string' || typeof entry.target !== 'string' || edges.some(edge => edge.id === entry.id)) continue;
    if (validCanvasConnection(nodes, edges, entry.source, entry.target)) edges.push({ id: entry.id, source: entry.source, target: entry.target });
  }
  return edges;
}
