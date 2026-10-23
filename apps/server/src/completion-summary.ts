import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompletionSummary, CompletionDeliverable } from '@dreamatic/project-data';
import { indexedJsonl } from './jsonl-index.js';
import { physicalRunFile } from '@dreamatic/project-data';

const STAGES = ['orchestrator', 'researcher', 'designer', 'builder'] as const;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const time = (value: unknown): number => typeof value === 'string' ? Date.parse(value) : NaN;

/** Image providers may omit usage entirely; missing reports must never become zero. */
export function imageUsageTokens(value: unknown): number | undefined {
  const usage = record(value);
  if (number(usage.total_tokens)) return usage.total_tokens;
  if (number(usage.totalTokens)) return usage.totalTokens;
  if (number(usage.input_tokens) && number(usage.output_tokens)) return usage.input_tokens + usage.output_tokens;
  return undefined;
}

export async function publishCompletionSummary(options: {
  root: string; runId: string; completionKey: string; completedAt?: string;
  deliverables: CompletionDeliverable[];
  save: (path: string, value: unknown) => Promise<void>;
  emit: (event: Record<string, unknown>) => Promise<unknown>;
}): Promise<CompletionSummary> {
  const { root, runId } = options;
  const records = (await indexedJsonl(join(root, 'bus.jsonl'))).rows;
  const lastDelivery = records.findLast(event => event.type === 'agent_finished' && event.agent === 'builder');
  const id = `${runId}-completion-${createHash('sha256').update(`${options.completionKey}:${String(lastDelivery?.invocationId ?? '')}`).digest('hex').slice(0, 16)}`;
  const existing = records.find(event => event.type === 'project_completed' && event.id === id);
  if (existing?.completion) {
    const completion = existing.completion as unknown as CompletionSummary;
    await options.save(join(root, 'completion-summary.json'), completion);
    return completion;
  }
  // A new successful revision has its own summary; resumes/retries belong to the
  // same revision and are counted until that revision reaches completion.
  const previous = records.filter(event => event.type === 'project_completed').at(-1);
  const since = Number.isFinite(time(previous?.at)) ? time(previous?.at) : -Infinity;
  const completedAt = options.completedAt ?? new Date().toISOString();
  const end = time(completedAt);
  const events = records.filter(event => time(event.at) > since && time(event.at) <= end);
  const stages = STAGES.map(stage => ({ stage, durationMs: 0, tokens: 0, attempts: 0, unreportedCalls: 0 }));
  const active = new Map<string, { stage: typeof stages[number]; at: number }>();
  let started = end, executionMs = 0, activeAt: number | undefined;
  let lastAt = end, timingIncomplete = false;
  const imageRequests = new Set<string>(), imageReports = new Map<string, number | undefined>();
  for (const event of events) {
    const at = time(event.at);
    if (event.type === 'run_status') {
      if (event.status === 'active') {
        started = Math.min(started, at);
        if (activeAt !== undefined) {
          // An earlier process disappeared without a terminal event. Count only
          // its observed interval, rather than charging offline time as execution.
          executionMs += Math.max(0, lastAt - activeAt); timingIncomplete = true;
          for (const attempt of active.values()) attempt.stage.durationMs += Math.max(0, lastAt - attempt.at);
          active.clear();
        }
        activeAt = at;
      }
      else if (activeAt !== undefined) { executionMs += Math.max(0, at - activeAt); activeAt = undefined; }
    }
    if (event.type === 'agent_started' && typeof event.invocationId === 'string') {
      const stage = stages.find(stage => stage.stage === event.agent);
      if (stage) { started = Math.min(started, at); stage.attempts++; active.set(event.invocationId, { stage, at }); }
    }
    if (['agent_finished', 'agent_waiting', 'agent_interrupted'].includes(String(event.type)) && typeof event.invocationId === 'string') {
      const attempt = active.get(event.invocationId);
      if (attempt) { attempt.stage.durationMs += Math.max(0, at - attempt.at); active.delete(event.invocationId); }
    }
    // Older image runs have timing snapshots but no usage receipt.
    for (const [imageId, raw] of Object.entries(record(event.imageItems))) {
      const item = record(raw);
      if (item.state === 'generating' && typeof item.startedAt === 'string') imageRequests.add(`${imageId}:${item.startedAt}`);
    }
    const usage = record(event.imageUsage);
    if (typeof usage.imageId === 'string' && typeof usage.startedAt === 'string') {
      const key = `${usage.imageId}:${usage.startedAt}`;
      imageRequests.add(key); imageReports.set(key, number(usage.tokens) ? usage.tokens : undefined);
    }
    lastAt = at;
  }
  if (activeAt !== undefined) executionMs += Math.max(0, end - activeAt);
  if (active.size) timingIncomplete = true;
  for (const attempt of active.values()) attempt.stage.durationMs += Math.max(0, lastAt - attempt.at);
  if (!events.some(event => event.type === 'run_status')) executionMs = stages.reduce((sum, stage) => sum + stage.durationMs, 0);
  for (const stage of stages) {
    const directory = join(root, 'sessions', stage.stage);
    let assistantMessages = 0;
    for (const file of await readdir(directory).catch(() => [])) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        for (const row of (await indexedJsonl(join(directory, file))).rows) {
          const message = record(row.message), at = time(row.timestamp);
          if (message.role !== 'assistant' || !Number.isFinite(at) || at <= since || at > end) continue;
          assistantMessages++;
          const usage = record(message.usage);
          const total = number(usage.totalTokens) ? usage.totalTokens
            : [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(number)
              ? Number(usage.input) + Number(usage.output) + Number(usage.cacheRead) + Number(usage.cacheWrite) : undefined;
          // Pi output already includes reasoning tokens. Cache tokens are included
          // in totalTokens; adding either again would double count provider usage.
          if (total === undefined || (total === 0 && ['error', 'aborted'].includes(String(message.stopReason)))) stage.unreportedCalls++;
          else stage.tokens += total;
        }
      } catch { stage.unreportedCalls++; }
    }
    if (assistantMessages && !stage.attempts) timingIncomplete = true;
    const localRecovery = events.some(event => event.type === 'agent_finished' && event.agent === stage.stage && typeof event.output === 'string' && event.output.includes('(revalidated draft)'));
    if (stage.attempts && !assistantMessages && !localRecovery) stage.unreportedCalls++;
  }
  let unreportedImageCalls = 0;
  for (const key of imageRequests) {
    const tokens = imageReports.get(key);
    if (tokens === undefined) { unreportedImageCalls++; stages[3]!.unreportedCalls++; }
    else stages[3]!.tokens += tokens;
  }
  const deliverables: CompletionDeliverable[] = [];
  for (const item of options.deliverables) {
    try {
      const path = await physicalRunFile(root, item.path);
      if (!(await stat(path)).isFile()) throw new Error(`Missing completed deliverable: ${item.path}`);
    } catch (error) {
      if (item.kind === 'document' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    deliverables.push({ ...item, path: `runs/${runId}/${item.path}` });
  }
  const elapsedMs = Math.max(0, end - started);
  const completion: CompletionSummary = {
    schemaVersion: 1, runId, startedAt: new Date(started).toISOString(), completedAt,
    elapsedMs, executionMs, pausedMs: Math.max(0, elapsedMs - executionMs), timingIncomplete,
    tokens: stages.reduce((sum, stage) => sum + stage.tokens, 0),
    unreportedCalls: stages.reduce((sum, stage) => sum + stage.unreportedCalls, 0),
    unreportedImageCalls, deliverables, stages,
  };
  await options.save(join(root, 'completion-summary.json'), completion);
  const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
  const detail = `Design task completed.\nDeliverables: ${deliverables.map(item => item.label).join('; ')}.\nElapsed: ${seconds(elapsedMs)}; execution: ${seconds(executionMs)}.\nReported tokens: ${completion.tokens}${completion.unreportedCalls ? ' (some usage was not reported)' : ''}.\n${stages.map(stage => `${stage.stage}: ${seconds(stage.durationMs)}, ${stage.tokens} reported tokens`).join('\n')}`;
  await options.emit({ id, type: 'project_completed', runId, at: completedAt, summary: 'Project completion summary', detail, completion,
    artifactRefs: deliverables.filter(item => item.kind === 'page').map(item => item.path) });
  return completion;
}
