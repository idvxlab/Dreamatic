import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createDreamaticAgent } from './agent-session.js';
import { cancelEditorTask, editorTaskMarkdown, submitEditorTask, waitEditorTask, recordEditorPlanningFailure } from './editor.js';
import { projectFiles, type ProjectFile } from './project-files.js';

export function editorTool(options: { repoRoot: string; originalRequest?: string; skillRequest?: string; inventory?: ProjectFile[]; workspaceDir: string; runId: string; signal: AbortSignal; emit: (event: unknown) => void }): ToolDefinition {
  return {
    name: 'edit_materials', label: 'Editor',
    description: 'Delegate image modifications or multi-image fusion to Editor. Supply a Markdown editing instruction and all exact project image file IDs. Editor persists a new asset and context/edit.md. Never use image_generate to modify existing materials.',
    parameters: Type.Object({ instruction: Type.String(), inputIds: Type.Array(Type.String(), { minItems: 1, maxItems: 16 }) }),
    async execute(_id, params) {
      const input = params as { instruction: string; inputIds: string[] };
      const id = randomUUID(), invocationId = randomUUID();
      const inventory = options.inventory ?? await editorMaterials(options.workspaceDir, options.runId);
      const inputOrdinals = input.inputIds.map(id => inventory.findIndex(file => file.id === id) + 1);
      if (inputOrdinals.some(ordinal => ordinal < 1)) throw new Error('Editor inputs must reference current project images.');
      options.emit({ type: 'workflow_event', event: { type: 'agent_started', agent: 'editor', invocationId, task: input.instruction } });
      try {
      const { session, prompt } = await createDreamaticAgent({ root: join(options.workspaceDir, 'runs', options.runId), repoRoot: options.repoRoot, role: 'editor', textOnly: true, skillRequest: options.skillRequest ?? options.originalRequest ?? '',
        systemPrompt: await readFile(join(options.repoRoot, 'apps/server/prompts/editor.md'), 'utf8'),
        tools: [{ name: 'image_edit', label: 'Edit or fuse materials', description: 'Edit the supplied stable image references. This is the only image editing executor. Selects the configured edit model, using all inputs for fusion.', parameters: Type.Object({ prompt: Type.String() }),
          async execute(_call, args) {
            const task = await submitEditorTask(options.workspaceDir, options.runId, { id, prompt: (args as { prompt: string }).prompt, inputIds: input.inputIds, inputOrdinals, originalPrompt: options.originalRequest ?? input.instruction, source: 'natural-language' });
            if (options.signal.aborted) await cancelEditorTask(options.workspaceDir, options.runId, id);
            const result = await waitEditorTask(options.workspaceDir, options.runId, task.id);
            return { content: [{ type: 'text', text: editorTaskMarkdown(result) }], details: { taskId: id, status: result.status } };
          }
        }] });
      const abort = () => { void session.abort(); void cancelEditorTask(options.workspaceDir, options.runId, id).catch(() => {}); };
      const deadline = setTimeout(abort, 15 * 60_000);
      options.signal.addEventListener('abort', abort, { once: true });
      try {
        options.signal.throwIfAborted();
        await prompt(`# Editing request\n\n${input.instruction}\n\n## Input materials\n\n${input.inputIds.map((id, index) => `- Image ${inputOrdinals[index]}: ${id}; name: ${inventory.find(file => file.id === id)?.title}`).join('\n')}`);
        const result = await waitEditorTask(options.workspaceDir, options.runId, id);
        options.emit({ type: 'workflow_event', event: { type: result.status === 'succeeded' ? 'agent_finished' : 'agent_interrupted', agent: 'editor', invocationId, output: editorTaskMarkdown(result), error: result.error } });
        return { content: [{ type: 'text', text: editorTaskMarkdown(result) }], details: { taskId: id } };
      } finally { clearTimeout(deadline); options.signal.removeEventListener('abort', abort); session.dispose(); }
      } catch (error) {
        await recordEditorPlanningFailure(options.workspaceDir, options.runId, { id, prompt: input.instruction, originalPrompt: options.originalRequest ?? input.instruction, source: 'natural-language', inputIds: input.inputIds, inputOrdinals }, options.signal.aborted);
        const task = await waitEditorTask(options.workspaceDir, options.runId, id);
        options.emit({ type: 'workflow_event', event: { type: 'agent_interrupted', agent: 'editor', invocationId, error: task.error || 'Editor reasoning was interrupted; consult the saved task result.', output: editorTaskMarkdown(task) } });
        if (options.signal.aborted) throw error;
        return { content: [{ type: 'text', text: editorTaskMarkdown(task) }], details: { taskId: id, status: task.status } };
      }
    }
  };
}
export async function editorMaterials(workspace: string, runId: string, preferredIds: string[] = []) {
  const files = (await projectFiles(workspace, runId)).filter(file => file.category === 'assets' && /^(png|jpe?g|webp)$/.test(file.kind));
  const preferred = [...new Set(preferredIds)].flatMap(id => { const file = files.find(file => file.id === id); return file ? [file] : []; });
  return [...preferred, ...files.filter(file => !preferredIds.includes(file.id))];
}
export async function editorInventory(workspace: string, runId: string, inventory?: ProjectFile[]) {
  return (inventory ?? await editorMaterials(workspace, runId)).map((file, index) => `- Image ${index + 1}: ${file.id}; name: ${file.title}`).join('\n');
}
