import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const workspace = resolve(process.argv[2] ?? 'workspace');
const quantile = (items, q) => { if (!items.length) return null; const sorted = [...items].sort((a, b) => a - b); return Math.round(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]); };
const stages = {}; const requests = []; const items = []; let retries = 0;
for (const run of await readdir(join(workspace, 'runs'), { withFileTypes: true })) {
  if (!run.isDirectory()) continue;
  const source = await readFile(join(workspace, 'runs', run.name, 'bus.jsonl'), 'utf8').catch(() => '');
  for (const line of source.split(/\r?\n/u)) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'operation_retry') retries++;
    if (event.type === 'image_request_metrics') requests.push(event);
    if (event.type === 'image_item_finished') items.push(event);
    if (!event.metrics || !['agent_finished', 'agent_interrupted'].includes(event.type)) continue;
    const stage = stages[event.agent] ??= { durations: [], completed: 0, interrupted: 0, modelTurns: 0, firstDeltaMs: [], responseMs: 0, outputTokens: 0 };
    stage.durations.push(event.metrics.durationMs); stage[event.type === 'agent_finished' ? 'completed' : 'interrupted']++;
    for (const turn of event.metrics.modelTurns ?? []) {
      if (turn.stopReason === 'error' && !turn.usage?.totalTokens) continue;
      stage.modelTurns++; if (Number.isFinite(turn.firstDeltaMs)) stage.firstDeltaMs.push(turn.firstDeltaMs);
      stage.responseMs += turn.responseMs ?? 0; stage.outputTokens += turn.usage?.output ?? 0;
    }
  }
}
console.log(JSON.stringify({ workspace, stages: Object.fromEntries(Object.entries(stages).map(([name, value]) => [name, { completed: value.completed, interrupted: value.interrupted, p50Ms: quantile(value.durations, .5), p95Ms: quantile(value.durations, .95), modelTurns: value.modelTurns, firstDeltaP50Ms: quantile(value.firstDeltaMs, .5), responseMs: value.responseMs, outputTokens: value.outputTokens }])), images: { requests: requests.length, queueP50Ms: quantile(requests.map((event) => event.queueMs), .5), queueP95Ms: quantile(requests.map((event) => event.queueMs), .95), requestP95Ms: quantile(requests.map((event) => event.requestMs), .95), timedOut: requests.filter((event) => event.timedOut).length, completedItems: items.filter((event) => event.status === 'completed').length, retries }, caveats: ['Historical versions and task sizes differ; use fixed tasks for optimization comparisons.', 'Overlapping image requests are not additive wall time.', 'Empty telemetry means unmeasured, not zero latency.'] }, null, 2));
