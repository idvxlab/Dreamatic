import { monitorEventLoopDelay } from 'node:perf_hooks';
const requests = new Map<string, { count: number; errors: number; durationMs: number[] }>();
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
export function recordRequest(method: string, path: string, status: number, durationMs: number) {
  const route = `${method} ${path.replace(/\/runs\/[^/]+/u, '/runs/:id').replace(/\/sessions\/[^/]+/u, '/sessions/:id')}`;
  const entry = requests.get(route) ?? { count: 0, errors: 0, durationMs: [] };
  entry.count++; if (status >= 400) entry.errors++;
  entry.durationMs.push(durationMs); if (entry.durationMs.length > 128) entry.durationMs.shift();
  requests.set(route, entry);
  if (requests.size > 128) requests.delete(requests.keys().next().value!);
}
export function serverPerformance() {
  const percentile = (values: number[], q: number) => Math.round([...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)] ?? 0);
  return { memory: process.memoryUsage(), eventLoopP95Ms: Number.isFinite(loop.percentile(95)) ? Math.round(loop.percentile(95) / 1e6) : 0,
    routes: Object.fromEntries([...requests].map(([route, entry]) => [route, { count: entry.count, errors: entry.errors, p50Ms: percentile(entry.durationMs, .5), p95Ms: percentile(entry.durationMs, .95), samples: entry.durationMs.length }])) };
}
