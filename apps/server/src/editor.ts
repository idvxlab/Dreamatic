import { validDimensions, type EditSizeOptions } from './image-edit-plan.js';
import { EDIT_HISTORY_FILE } from '@dreamatic/project-data';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { editProjectImage, imageEditSettings, imageBytesKind, type ImageEditDecision } from './image-edit.js';
import { projectInputDirectory } from './media-upload.js';
import { projectFiles, projectFileContent, type ProjectFile } from './project-files.js';

export interface EditorInput {
  id: string; prompt: string; originalPrompt?: string; source: 'canvas' | 'natural-language'; inputIds: string[];
  sizeOptions?: EditSizeOptions;
  inputOrdinals?: number[];
  promptNodeId?: string; upstream?: Array<{ nodeId: string; fileId: string; taskId?: string }>;
}
export interface EditorTask extends EditorInput, Partial<ImageEditDecision> {
  status: 'submitted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  attempt: number; createdAt: string; completedAt?: string; output?: ProjectFile; error?: string;
  model?: string; size?: string; recordId?: string; outputDimensions?: { width: number; height: number };
  upstreamTaskIds?: string[]; outputAvailable?: boolean; recoveredAt?: string; toolInvoked?: boolean; unavailableInputIds?: string[];
}
interface Journal { tasks: EditorTask[]; events: Array<{ at: string; task: EditorTask }> }
const writes = new Map<string, Promise<unknown>>();
const active = new Map<string, { controller: AbortController; done: Promise<void>; ready: Promise<EditorTask> }>();
async function directory(workspace: string, runId: string) {
  return projectInputDirectory(workspace, runId, 'media-edits');
}
async function atomicText(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
const quoted = (text: string) => text.split('\n').map(line => `> ${line}`).join('\n');
export function editorTaskMarkdown(task: EditorTask): string {
  return `## Editor task: ${task.id}\n\n- Attempt: ${task.attempt}\n- Source: ${task.source}\n- Created: ${task.createdAt}\n${task.completedAt ? `- Completed: ${task.completedAt}\n` : ''}- Status: ${task.status}${task.dimensionStatus && task.dimensionStatus !== 'exact' ? ' (generated; dimensions need review)' : ''}\n- Tool: ${!task.toolInvoked ? 'Not invoked yet' : 'image_edit' + (task.inputIds.length > 1 ? ' (multi-image fusion)' : '')}\n${task.model ? `- Model: ${task.model}\n- Target dimensions: ${task.targetDimensions ? `${task.targetDimensions.width}x${task.targetDimensions.height}` : 'Historical / unspecified'}\n- Size: ${task.size ?? 'Pending source image inspection'}\n` : ''}${task.promptNodeId ? `- Prompt node: ${task.promptNodeId}\n` : ''}${task.recordId ? `- Tool receipt: inputs/media-edits/${task.recordId}.json\n` : ''}\n${task.baseImageId ? `- Base image: ${task.baseImageId}\n- Base selection: ${task.baseImageMethod}\n- Size source: ${task.sizeSource}\n- Base reason: ${task.baseImageReason}\n` : ''}${task.baseImageEvidence ? `- Base evidence: ${task.baseImageEvidence.replaceAll('\n', ' ')}\n` : ''}${task.outputDimensions ? `- Actual output dimensions: ${task.outputDimensions.width}x${task.outputDimensions.height}\n` : ''}\n### Original request\n\n${quoted(task.originalPrompt ?? task.prompt)}\n\n### Instruction\n\n${quoted(task.prompt)}\n\n### Inputs\n\n${task.inputIds.map((id, index) => `- Image ${task.inputOrdinals?.[index] ?? index + 1}: ${id}`).join('\n')}\n\n${task.unavailableInputIds?.length ? `Unavailable inputs (references retained): ${task.unavailableInputIds.join(', ')}\n\n` : ''}### Upstream nodes and tasks\n\n${task.upstream?.map(input => `- Node ${input.nodeId}: ${input.fileId}${input.taskId ? `; task ${input.taskId}` : ''}`).join('\n') || 'No canvas nodes supplied.'}\n\n### Upstream tasks\n\n${task.upstreamTaskIds?.map(id => `- ${id}`).join('\n') || 'Original project materials.'}\n\n### Result\n\n${task.output ? `- Output: ${task.output.id}${task.promptNodeId ? `\n- Canvas association: saved nodes reference outputTaskId ${task.id}; attachment depends on the current board state.` : ''}` : 'No saved output.'}${task.outputAvailable === false ? '\n- Availability: output material is unavailable; historical references retained.' : ''}${task.recoveredAt ? `\n- Recovered: ${task.recoveredAt}` : ''}${task.error ? `\n\n${quoted(task.error)}` : ''}\n`;
}
async function load(folder: string): Promise<Journal> {
  return readFile(join(folder, 'editor-tasks.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return { tasks: [], events: [] }; throw error; });
}
async function projectHistory(folder: string, journal: Journal) {
  const root = join(folder, '../..');
  const context = join(root, 'context');
  await mkdir(context, { recursive: true });
  if (await realpath(context) !== await realpath(root) + sep + 'context') throw new Error('Invalid context directory');
  // The durable event journal is authoritative. Rebuilding repairs a partial/failed projection
  // without losing past attempts or appending duplicate success records.
  const relationships = journal.tasks.map(task => `- Task ${task.id}: inputs ${task.inputIds.join(', ')}; output ${task.output?.id ?? 'none'}; upstream tasks ${task.upstreamTaskIds?.join(', ') || 'none'}; downstream tasks ${journal.tasks.filter(next => task.output && next.inputIds.includes(task.output.id)).map(next => next.id).join(', ') || 'none'}`).join('\n');
  const markdown = '# Material editing history\n\n' + journal.events.map(event => `<!-- ${event.at} -->\n${editorTaskMarkdown(event.task)}`).join('\n') + '\n## Current material relationships\n\n' + relationships + '\n';
  if (await readFile(join(root, EDIT_HISTORY_FILE), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }) !== markdown) await atomicText(join(root, EDIT_HISTORY_FILE), markdown);
}
async function transaction<T>(workspace: string, runId: string, update: (journal: Journal) => T | Promise<T>): Promise<T> {
  const folder = await directory(workspace, runId);
  const operation = (writes.get(folder) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const journal = await load(folder);
    const result = await update(journal);
    const serialized = JSON.stringify(journal, null, 2);
    if (await readFile(join(folder, 'editor-tasks.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }) !== serialized) await atomicText(join(folder, 'editor-tasks.json'), serialized);
    await projectHistory(folder, journal);
    return result;
  });
  writes.set(folder, operation);
  try { return await operation; } finally { if (writes.get(folder) === operation) writes.delete(folder); }
}
function record(journal: Journal, task: EditorTask) {
  const index = journal.tasks.findIndex(item => item.id === task.id);
  if (index < 0) journal.tasks.push(task); else journal.tasks[index] = task;
  journal.events.push({ at: new Date().toISOString(), task: structuredClone(task) });
}
const taskKey = (workspace: string, runId: string, id: string) => JSON.stringify([workspace, runId, id]);
export async function listEditorTasks(workspace: string, runId: string): Promise<EditorTask[]> {
  return transaction(workspace, runId, async journal => {
    const catalog = await projectFiles(workspace, runId);
    for (let task of [...journal.tasks]) {
      const unavailableInputIds = task.inputIds.filter(id => !catalog.some(file => file.id === id));
      if (JSON.stringify(task.unavailableInputIds ?? []) !== JSON.stringify(unavailableInputIds)) { task = { ...task, unavailableInputIds }; record(journal, task); }
      if (task.output && task.status === 'succeeded') {
        const available = catalog.some(file => file.id === task.output!.id);
        if (task.outputAvailable !== available) record(journal, { ...task, outputAvailable: available });
      }
      if (!['submitted', 'running'].includes(task.status) || active.has(taskKey(workspace, runId, task.id))) continue;
      // A provider output may have been saved immediately before the process exited.
      const folder = await directory(workspace, runId);
      for (const name of await readdir(folder)) {
        if (!name.endsWith('.json') || name === 'editor-tasks.json') continue;
        const receipt = await readFile(join(folder, name), 'utf8').then(JSON.parse);
        if (receipt.taskId !== task.id || receipt.attempt !== task.attempt) continue;
        const output = catalog.find(file => file.id === receipt.outputId);
        if (output && imageBytesKind((await projectFileContent(workspace, runId, output.id)).data)) { task.output = output; task.recordId = receipt.id; task.model = receipt.model; task.size = receipt.size; task.completedAt = receipt.createdAt; task.outputAvailable = true; task.toolInvoked = true;
          for (const key of ['baseImageId', 'baseImageIndex', 'baseImageMethod', 'baseImageReason', 'baseImageEvidence', 'sizeSource', 'outputDimensions'] as const) if (receipt[key] !== undefined) Object.assign(task, { [key]: receipt[key] });
          break; }
      }
      record(journal, { ...task, status: task.output ? 'succeeded' : 'interrupted', recoveredAt: new Date().toISOString(), ...(task.output ? {} : { error: 'Execution was interrupted. Retry explicitly; the provider may have processed the request.' }) });
    }
    return structuredClone(journal.tasks);
  });
}
function validate(input: EditorInput) {
  if (!input || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id)) throw new Error('Invalid editor task id');
  if (!['canvas', 'natural-language'].includes(input.source)) throw new Error('Invalid editor source');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000) throw new Error('Enter an image edit prompt between 1 and 8000 characters.');
  if (!Array.isArray(input.inputIds) || !input.inputIds.length || input.inputIds.length > 16 || input.inputIds.some(id => typeof id !== 'string') || new Set(input.inputIds).size !== input.inputIds.length) throw new Error('Select 1–16 distinct input images.');
  if (input.inputOrdinals !== undefined && (!Array.isArray(input.inputOrdinals) || input.inputOrdinals.length !== input.inputIds.length || input.inputOrdinals.some(ordinal => !Number.isSafeInteger(ordinal) || ordinal < 1) || new Set(input.inputOrdinals).size !== input.inputOrdinals.length)) throw new Error('Invalid input image numbering');
  if (input.sizeOptions !== undefined && (!input.sizeOptions || typeof input.sizeOptions !== 'object' || (input.sizeOptions.target !== undefined && !validDimensions(input.sizeOptions.target)) || (input.sizeOptions.confirmConflict !== undefined && typeof input.sizeOptions.confirmConflict !== 'boolean') || (input.sizeOptions.acceptAdaptation !== undefined && typeof input.sizeOptions.acceptAdaptation !== 'boolean'))) throw new Error('Invalid image size options');
  if (input.originalPrompt !== undefined && (typeof input.originalPrompt !== 'string' || input.originalPrompt.length > 8000)) throw new Error('Invalid original request');
  if (input.promptNodeId !== undefined && (typeof input.promptNodeId !== 'string' || input.promptNodeId.length > 180)) throw new Error('Invalid prompt node');
  if (input.upstream !== undefined && (!Array.isArray(input.upstream) || input.upstream.some(item => !item || typeof item.nodeId !== 'string' || !input.inputIds.includes(item.fileId) || (item.taskId !== undefined && typeof item.taskId !== 'string')))) throw new Error('Invalid upstream references');
}
export async function submitEditorTask(workspace: string, runId: string, input: EditorInput, retry = false, env: NodeJS.ProcessEnv = process.env): Promise<EditorTask> {
  validate(input);
  const key = taskKey(workspace, runId, input.id);
  // Claim synchronously before disk IO so recovery cannot interrupt a just-created task.
  if (active.has(key)) {
    const existing = await active.get(key)!.ready;
    if (existing && JSON.stringify([existing.sizeOptions, existing.prompt.trim(), existing.inputIds, existing.promptNodeId, (existing.originalPrompt ?? existing.prompt).trim(), existing.inputOrdinals ?? existing.inputIds.map((_, index) => index + 1)]) === JSON.stringify([input.sizeOptions, input.prompt.trim(), input.inputIds, input.promptNodeId, (input.originalPrompt ?? input.prompt).trim(), input.inputOrdinals ?? input.inputIds.map((_, index) => index + 1)])) return existing;
    throw new Error('Editor task is being submitted; retry the same request.');
  }
  const controller = new AbortController();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  let readyResolve!: (task: EditorTask) => void, readyReject!: (error: unknown) => void;
  const ready = new Promise<EditorTask>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  active.set(key, { controller, done, ready });
  let task: EditorTask;
  let execute = false;
  try {
    task = await transaction(workspace, runId, journal => {
      const existing = journal.tasks.find(task => task.id === input.id);
      if (existing) {
        if (JSON.stringify([existing.sizeOptions, existing.prompt.trim(), existing.inputIds, existing.promptNodeId, (existing.originalPrompt ?? existing.prompt).trim(), existing.inputOrdinals ?? existing.inputIds.map((_, index) => index + 1)]) !== JSON.stringify([input.sizeOptions, input.prompt.trim(), input.inputIds, input.promptNodeId, (input.originalPrompt ?? input.prompt).trim(), input.inputOrdinals ?? input.inputIds.map((_, index) => index + 1)])) throw new Error('Task id already belongs to a different edit.');
        if (!retry || !['failed', 'cancelled', 'interrupted'].includes(existing.status)) return structuredClone(existing);
      }
      const config = imageEditSettings(env);
      const next: EditorTask = { id: input.id, source: input.source, ...(input.sizeOptions ? {sizeOptions: input.sizeOptions} : {}), originalPrompt: input.originalPrompt ?? input.prompt, upstreamTaskIds: journal.tasks.filter(task => task.output && input.inputIds.includes(task.output.id)).map(task => task.id), inputIds: [...input.inputIds], ...(input.inputOrdinals ? { inputOrdinals: [...input.inputOrdinals] } : {}), ...(input.promptNodeId ? { promptNodeId: input.promptNodeId } : {}), ...(input.upstream ? { upstream: structuredClone(input.upstream) } : {}), prompt: input.prompt.trim(), status: 'submitted', attempt: (existing?.attempt ?? 0) + 1, createdAt: existing?.createdAt ?? new Date().toISOString(), model: config.model };
      execute = true; record(journal, next); return structuredClone(next);
    });
    readyResolve(task);
  } catch (error) { readyReject(error); active.delete(key); finish(); throw error; }
  if (!execute) { active.delete(key); finish(); return task; }
  void (async () => {
    try {
      task = { ...task, status: 'running' };
      await transaction(workspace, runId, journal => record(journal, task));
      controller.signal.throwIfAborted();
      task = { ...task, toolInvoked: true };
      const output = await editProjectImage(workspace, runId, task.inputIds, task.prompt, controller.signal, env, { taskId: task.id, attempt: task.attempt, ...(task.sizeOptions ? {sizeOptions: task.sizeOptions} : {}), originalPrompt: task.originalPrompt ?? task.prompt, ...(task.inputOrdinals ? { inputOrdinals: task.inputOrdinals } : {}) }, async (size, decision) => {
        task = { ...task, size, ...decision };
        await transaction(workspace, runId, journal => record(journal, task));
      });
      task = { ...task, ...(output.targetDimensions ? {targetDimensions: output.targetDimensions} : {}), ...(output.requestSize ? {requestSize: output.requestSize} : {}), ...(output.dimensionStatus ? {dimensionStatus: output.dimensionStatus} : {}), status: 'succeeded', output, outputDimensions: output.outputDimensions, outputAvailable: true, model: output.model, size: output.editSize, recordId: output.editId, completedAt: new Date().toISOString() };
    } catch (error) {
      task = { ...task, status: controller.signal.aborted ? 'cancelled' : 'failed', completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
    }
    try { await transaction(workspace, runId, journal => record(journal, task)); }
    catch (error) { console.error('Editor history needs repair', error instanceof Error ? error.message : 'storage failure'); }
    finally { active.delete(key); finish(); }
  })();
  return task;
}
export async function cancelEditorTask(workspace: string, runId: string, id: string) {
  const operation = active.get(taskKey(workspace, runId, id));
  operation?.controller.abort();
  if (operation) await operation.done;
  const task = (await listEditorTasks(workspace, runId)).find(task => task.id === id);
  if (!task) throw new Error('Editor task not found');
  return task;
}
export async function waitEditorTask(workspace: string, runId: string, id: string) {
  await active.get(taskKey(workspace, runId, id))?.done;
  const task = (await listEditorTasks(workspace, runId)).find(task => task.id === id);
  if (!task) throw new Error('Editor task not found');
  return task;
}

/** Preserve a specialist planning failure even when no image tool was invoked. */
export async function recordEditorPlanningFailure(workspace: string, runId: string, input: EditorInput, cancelled: boolean) {
  validate(input);
  await transaction(workspace, runId, journal => {
    if (journal.tasks.some(task => task.id === input.id)) return;
    record(journal, { ...input, status: cancelled ? 'cancelled' : 'failed', toolInvoked: false, attempt: 1, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: cancelled ? 'Editor planning was cancelled before image execution.' : 'Editor planning failed before image execution. Check the reasoning model settings and retry.' });
  });
}
