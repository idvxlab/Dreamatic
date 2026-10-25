import { createDreamaticAgent } from './agent-session.js';
import { editorTool, editorInventory, editorMaterials } from './editor-agent.js';
import { imageSlot } from './image-slots.js';
import { requestImage, retryImage, type ImageFailure } from './image-request.js';
import { saveProjectClassification } from './project-classification.js';
import { PROJECT_CATEGORIES, projectClassification, resolveProjectClassification, type ProjectClassification } from '@dreamatic/project-data';
import { updateWorkTitle } from './project-title.js';
import { recoverBuilderDraft, savedShowcaseDirection, showcaseAssets } from './builder-recovery.js';
import { publishCompletionSummary, imageUsageTokens } from './completion-summary.js';
import { publicWorkflowData } from './workflow-data.js';
import { createBuilderTextReadTool, createShowcaseTools, normalizeShowcaseHtml, validateShowcaseHtml, showcaseDirectionMarkdown, showcaseImageSource, resolveShowcaseImages, type ShowcaseDirection, type GeneratedShowcaseImage, type ImageReferenceRepair } from './showcase.js';
import type { ImageProgressItem } from '@dreamatic/project-data/workflow-progress';
import { createModelResponseTimer } from './model-response-timer.js';
import { reviewResearchCitations, reviewDesignCitations, annotateCitationIssues, type CitationReview } from './design-citations.js';
export { validateCitations } from './design-citations.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, appendFile, stat, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { type AgentSession, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { clarificationFromToolResult, type DesignClarificationRequest } from '@dreamatic/project-data';
import { CONFIG_FIELDS, searchApiKey } from './config-store.js';

export const STAGES = ['orchestrator', 'researcher', 'designer', 'builder'] as const;
type Stage = typeof STAGES[number];
const DELIVERY_POLICY = 'Dreamatic saves your final response to the designated output file after validation. You do not have write/edit/bash tools. Never call unavailable tools to save files. Return the complete deliverable once as your final response, not a completion summary. Do not wrap it in a code fence or add apologies, save instructions, or claims that the user must save it. The ask_user waiting flow is the only exception: return no deliverable while awaiting answers.';
const outputs = ['intent.md', 'research.md', 'design.md', 'final/00-index.html'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const setting = (key: string): string => process.env[key]?.trim() || CONFIG_FIELDS.find(f => f.key === key)?.defaultValue || '';
/** Resume validity follows design inputs, not the implementation of role instructions. */
export function stageFingerprint(stage: Stage, request: string, attachments: unknown, prior: string[], _instruction: string): string {
  const imageInputs = stage === 'designer' || stage === 'builder'
    ? ['DREAMATIC_IMAGE_MODEL', 'DREAMATIC_IMAGE_BASE_URL', 'DREAMATIC_IMAGE_GENERATION_ENDPOINT', 'DREAMATIC_IMAGE_DEFAULT_SIZE', 'DREAMATIC_IMAGE_CAPABILITIES'].map(setting)
    : [];
  return hash(JSON.stringify([2, stage, request, attachments, prior, imageInputs]));
}
const checkpoint = (fingerprint: string, output: string) => `v2:${hash(fingerprint + output)}`;

/** Upgrade old checksums only when their original inputs and output still match. */
async function matchesLegacyCheckpoint(root: string, stage: Stage, saved: string, request: string, attachments: unknown, prior: string[], output: string, instruction: string): Promise<boolean> {
  const instructions = new Set([instruction]);
  const directory = join(root, 'sessions', stage);
  for (const file of await readdir(directory).catch(() => [] as string[])) {
    if (!file.endsWith('.jsonl')) continue;
    for (const line of (await source(join(directory, file))).split('\n')) {
      try {
        const row = JSON.parse(line);
        const preamble = row.message?.role === 'system' ? row.message.sections?.preamble : undefined;
        if (typeof preamble === 'string') {
          const original = preamble.split('\n\n' + DELIVERY_POLICY)[0]!;
          for (const candidate of [original, original.trimEnd(), original.trimEnd() + '\n']) instructions.add(candidate);
        }
      } catch { /* An incomplete historical JSONL tail is not completion evidence. */ }
    }
  }
  for (const original of instructions) {
    const prefix = [request, hash(JSON.stringify(attachments)), prior, original];
    const suffix = [setting(`DREAMATIC_MODEL_${stage.toUpperCase()}`), setting('DREAMATIC_MODEL'), setting('DREAMATIC_BASE_URL'), setting('DREAMATIC_MODEL_CAPABILITIES'), setting('DREAMATIC_IMAGE_MODEL'), setting('DREAMATIC_IMAGE_BASE_URL'), setting('DREAMATIC_IMAGE_DEFAULT_SIZE'), setting('DREAMATIC_IMAGE_CAPABILITIES'), setting('DREAMATIC_PROVIDER_TYPE'), setting(`DREAMATIC_THINKING_LEVEL_${stage.toUpperCase()}`)];
    for (const values of [[...prefix, ...suffix], [...prefix, DELIVERY_POLICY, ...suffix]]) {
      if (saved === hash(hash(JSON.stringify(values)) + output)) return true;
    }
  }
  return false;
}
export async function atomic(path: string, value: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2)); await rename(tmp, path);
}
/** Publish complete UTF-8 output only after a verified temporary write. */
export async function saveStageOutput(path: string, text: string): Promise<void> {
  if (!text.trim()) throw new Error('Cannot save an empty stage output');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, 'utf8');
    if (await readFile(temporary, 'utf8') !== text) throw new Error('Saved content does not match stage output');
    await rename(temporary, path);
  } catch (error) {
    throw new Error(`Failed to save ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally { await rm(temporary, { force: true }); }
}
const source = (path: string) => readFile(path, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
export function dimensions(size: string): [number, number] {
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2])) || Number(match[1]) < 1 || Number(match[2]) < 1) throw new Error(`Invalid image size: ${size}`);
  return [Number(match[1]), Number(match[2])];
}
export interface PlannedImage { id: string; introduction: string; size: string; prompt: string }
export function plannedImages(markdown: string): PlannedImage[] {
  const images = [...markdown.matchAll(/^## Image: ([a-zA-Z0-9_-]+)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].map(m => {
    const field = (name: string) => new RegExp(`^### ${name}\\s*\\n([\\s\\S]*?)(?=^#{1,3} |$(?![\\s\\S]))`, 'm').exec(m[2]!)?.[1]?.trim() || '';
    const size = field('Size'); dimensions(size);
    const prompt = field('Prompt'); if (!prompt) throw new Error(`Missing prompt: ${m[1]}`);
    return { id: m[1]!, introduction: field('Introduction'), size, prompt };
  });
  if (!images.length || new Set(images.map(i => i.id)).size !== images.length) throw new Error('Design must contain distinct valid Image sections');
  return images;
}

export interface ImageCapabilityInfo {
  sizes: string[];
  source: 'configuration' | 'metadata' | 'generation' | 'budget';
  verified: boolean;
}
function imageCapabilityCache() {
  const base = setting('DREAMATIC_IMAGE_BASE_URL').replace(/\/$/, '');
  const model = setting('DREAMATIC_IMAGE_MODEL');
  const key = hash(JSON.stringify([2, base, model, setting('DREAMATIC_IMAGE_GENERATION_ENDPOINT'), setting('DREAMATIC_IMAGE_CAPABILITIES'), hash(setting('DREAMATIC_IMAGE_API_KEY') || setting('DREAMATIC_API_KEY'))]));
  const directory = join(process.env.DREAMATIC_CONFIG_DIR || join(homedir(), '.dreamatic'), 'cache', 'image-capabilities');
  return { base, model, directory, path: join(directory, `${key}.json`) };
}
function validImageSizes(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.length) return false;
  try { for (const size of value) { if (typeof size !== 'string') return false; dimensions(size); } return true; }
  catch { return false; }
}
export async function imageCapabilityInfo(signal?: AbortSignal): Promise<ImageCapabilityInfo> {
  signal?.throwIfAborted();
  const cache = imageCapabilityCache();
  await mkdir(cache.directory, { recursive: true });
  let cached: { at: number; sizes: string[]; source: ImageCapabilityInfo['source'] } | undefined;
  try { cached = JSON.parse(await source(cache.path) || 'null'); } catch { /* Invalid cache is a miss. */ }
  if (cached && ['configuration', 'metadata', 'generation'].includes(cached.source) && validImageSizes(cached.sizes) && Number.isFinite(cached.at) && Date.now() >= cached.at && Date.now() - cached.at < Number(setting('DREAMATIC_IMAGE_CAPABILITY_TTL_MS'))) {
    return { sizes: cached.sizes, source: cached.source, verified: true };
  }
  if (setting('DREAMATIC_IMAGE_CAPABILITIES')) {
    const sizes: unknown = JSON.parse(setting('DREAMATIC_IMAGE_CAPABILITIES')).sizes;
    if (!validImageSizes(sizes)) throw new Error('Invalid image capabilities: sizes must contain positive WIDTHxHEIGHT dimensions');
    await atomic(cache.path, { at: Date.now(), sizes, source: 'configuration' });
    return { sizes, source: 'configuration', verified: true };
  }
  // supported_sizes is optional provider metadata, not part of the standard Models API.
  // A missing/unsupported metadata route must not prevent a normal generation request.
  try {
    const response = await fetch(`${cache.base}/models/${encodeURIComponent(cache.model)}`, { headers: { Authorization: `Bearer ${setting('DREAMATIC_IMAGE_API_KEY') || setting('DREAMATIC_API_KEY')}` }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Number(setting('DREAMATIC_IMAGE_TIMEOUT_MS')))]) });
    if (response.ok) {
      const metadata = await response.json() as { supported_sizes?: unknown };
      if (validImageSizes(metadata.supported_sizes)) {
        const sizes = metadata.supported_sizes;
        await atomic(cache.path, { at: Date.now(), sizes, source: 'metadata' });
        return { sizes, source: 'metadata', verified: true };
      }
    }
  } catch { signal?.throwIfAborted(); /* Metadata is optional; generation returns authoritative errors. */ }
  const size = setting('DREAMATIC_IMAGE_DEFAULT_SIZE');
  dimensions(size);
  // This is an unverified request candidate within the user's ceiling, never a model limit.
  // Do not persist it as a detected capability.
  return { sizes: [size], source: 'budget', verified: false };
}
export async function imageCapabilities(signal?: AbortSignal): Promise<string[]> {
  return (await imageCapabilityInfo(signal)).sizes;
}
let capabilityWrites = Promise.resolve();
export async function recordSuccessfulImageSize(size: string): Promise<void> {
  dimensions(size);
  const cache = imageCapabilityCache();
  const operation = capabilityWrites.catch(() => undefined).then(async () => {
    await mkdir(cache.directory, { recursive: true });
    let saved: { at: number; sizes: string[]; source: string } | undefined;
    try { saved = JSON.parse(await source(cache.path) || 'null'); } catch { /* Replace invalid cache. */ }
    // Complete declarations must not be narrowed to only the observed generation sizes.
    if (saved && ['configuration', 'metadata'].includes(saved.source)) return;
    const valid = saved?.source === 'generation' && validImageSizes(saved.sizes) && Date.now() - saved.at < Number(setting('DREAMATIC_IMAGE_CAPABILITY_TTL_MS'));
    const sizes = [...new Set([...(valid ? saved!.sizes : []), size])];
    await atomic(cache.path, { at: Date.now(), sizes, source: 'generation' });
  });
  capabilityWrites = operation;
  return operation;
}

export interface PipelineOptions { repoRoot: string; workspaceDir: string; runId: string; text: string; images?: Array<{ data: string; mimeType: string }>; signal: AbortSignal; emit: (event: unknown) => void; onSession?: (session: AgentSession | undefined) => void; onQuestion?: (question: DesignClarificationRequest) => void }
export async function runDesign(options: PipelineOptions) {
  const { repoRoot, workspaceDir, runId, text, signal, emit } = options;
  const root = join(workspaceDir, 'runs', runId);
  const statePath = join(root, 'pipeline-state.json');
  const attachmentPath = join(root, 'attachments.json');
  const attachments: Array<{ data: string; mimeType: string }> = JSON.parse(await source(attachmentPath) || '[]');
  // Historical attachment:N references must keep identifying the same bytes across later messages.
  if (options.images?.length) {
    for (const image of options.images) if (!attachments.some(saved => saved.data === image.data && saved.mimeType === image.mimeType)) attachments.push(image);
    await atomic(attachmentPath, attachments);
  }
  const state: { request: string; completed: Record<string, string> } = JSON.parse(await source(statePath) || '{"request":"","completed":{}}');
  const stateBeforeRequest = structuredClone(state);
  const resume = text === '继续完成' || text === 'Continue workflow';
  if (!resume && state.request !== text) { state.request = state.request ? `${state.request}\n\nUser revision:\n${text}` : text; state.completed = {}; }
  if (!state.request) throw new Error('No original request to resume');
  await mkdir(join(root, 'final'), { recursive: true });
  await mkdir(join(root, 'artifacts'), { recursive: true });
  const briefPath = join(root, 'brief.json');
  const brief = JSON.parse(await source(briefPath) || '{}');
  const briefBeforeRequest = structuredClone(brief);
  brief.brief = state.request; await atomic(briefPath, brief);
  let busWrites = Promise.resolve();
  const bus = (event: Record<string, unknown>) => {
    const record = publicWorkflowData({ id: randomUUID(), at: new Date().toISOString(), ...event });
    busWrites = busWrites.then(async () => {
      await appendFile(join(root, 'bus.jsonl'), JSON.stringify(record) + '\n');
      emit({ type: 'workflow_event', event: record });
    });
    // Subscribe callbacks cannot await I/O. The session's finally block drains writes.
    void busWrites.catch(() => undefined);
    return busWrites;
  };
  const syncWorkTitle = async (stage: 'orchestrator' | 'designer', markdown: string) => {
    const title = await updateWorkTitle(root, markdown, stage);
    if (title) await bus({ type: 'project_renamed', title });
  };
  const syncClassification = async (stage: 'orchestrator' | 'designer', markdown: string, candidate?: unknown) => {
    const classification = await saveProjectClassification(root, stage, candidate, markdown);
    if (classification) await bus({ type: 'project_classified', classification });
  };
  const saveShowcaseDirection = async (fingerprint: string, images: PlannedImage[], generated: Record<string, GeneratedShowcaseImage>, direction: ShowcaseDirection) => {
    await saveStageOutput(join(root, 'showcase.md'), showcaseDirectionMarkdown(direction));
    await atomic(join(root, '.showcase-direction.json'), { schemaVersion: 1, fingerprint, direction, assets: showcaseAssets(images, generated) });
  };
  const deliverBuilder = async (text: string, fingerprint: string, images: PlannedImage[], generated: Record<string, GeneratedShowcaseImage>, direction: ShowcaseDirection, previousRepairs: ImageReferenceRepair[] = []) => {
    if (images.some(image => !generated[image.id])) throw new Error('Builder must complete every planned image');
    const bound = await resolveShowcaseImages(root, normalizeShowcaseHtml(text), direction, generated);
    await validateShowcaseHtml(root, bound.html, direction, generated);
    const repairs = [...previousRepairs, ...bound.repairs];
    await saveShowcaseDirection(fingerprint, images, generated, direction);
    await atomic(join(root, '.builder-delivery.json'), { fingerprint, repairs });
    await saveStageOutput(join(root, 'artifacts/00-gallery.html'), bound.html.replaceAll('../artifacts/', './'));
    const artifactList = images.map(image => ({ ...generated[image.id]!, deliverableId: image.id }));
    const modelUsage = {
      reasoning: STAGES.map(role => ({ role, model: setting(`DREAMATIC_MODEL_${role.toUpperCase()}`) || setting('DREAMATIC_MODEL'), provider: setting('DREAMATIC_BASE_URL') })),
      generation: [{ model: setting('DREAMATIC_IMAGE_MODEL'), provider: setting('DREAMATIC_IMAGE_BASE_URL'), method: 'image_generate' }]
    };
    const classification = resolveProjectClassification(JSON.parse(await source(briefPath) || '{}'));
    await atomic(join(root, 'artifacts/artifact-manifest.json'), { ...(classification ? { classification } : {}), schemaVersion: 2, artifacts: artifactList, modelUsage, presentation: { mode: 'gallery', entry: 'artifacts/00-gallery.html' }, showcase: { heroId: direction.heroId, imageIds: direction.works.map(work => work.id), works: direction.works, direction: 'showcase.md' } });
    await saveStageOutput(join(root, 'final/00-index.html'), bound.html);
    const files: Record<string, string> = {};
    for (const path of ['artifacts/00-gallery.html', 'artifacts/artifact-manifest.json', ...artifactList.map(image => image.path)]) files[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
    return { html: bound.html, files, repairs };
  };
  const status = async (value: string) => { await atomic(join(root, 'run-state.json'), { runId, status: value, stages: Object.fromEntries(STAGES.map((s, i) => [[ 'orchestrator', 'research', 'design', 'build'][i], state.completed[s] ? 'completed' : 'pending'])), updatedAt: new Date().toISOString() }); await bus({ type: 'run_status', status: value }); };
  let active: Stage = 'orchestrator'; let invocationId = '';
  await status('active');
  try {
    let sizes: string[] | undefined;
    let capability: ImageCapabilityInfo | undefined;
    for (const [index, stage] of STAGES.entries()) {
      signal.throwIfAborted(); active = stage;
      const prior = await Promise.all(outputs.slice(0, index).map(path => source(join(root, path))));
      const instruction = await readFile(join(repoRoot, 'apps/server/prompts', `${stage}.md`), 'utf8');
      const fingerprint = stageFingerprint(stage, state.request, attachments, prior, instruction);
      const existing = await source(join(root, outputs[index]!));
      let reusable = Boolean(state.completed[stage] === checkpoint(fingerprint, existing) && existing.trim());
      const saved = state.completed[stage];
      if (!reusable && resume && saved && !saved.startsWith('v2:') && existing.trim()) {
        reusable = await matchesLegacyCheckpoint(root, stage, saved, state.request, attachments, prior, existing, instruction);
        if (reusable) { state.completed[stage] = checkpoint(fingerprint, existing); await atomic(statePath, state); }
      }
      if (reusable && stage === 'builder') {
        const records = JSON.parse(await source(join(root, 'artifacts/generated.json')) || '{}');
        for (const image of plannedImages(prior[2]!)) {
          const record = records[image.id];
          if (!record || !record.digest || await readFile(join(root, record.path)).then(bytes => createHash('sha256').update(bytes).digest('hex')).catch(() => '') !== record.digest) reusable = false;
        }
      }
      if (reusable) {
        if (stage === 'orchestrator' || stage === 'designer') {
          await syncWorkTitle(stage, existing);
          let savedOutput: { fingerprint?: string; classification?: unknown } = {};
          try { savedOutput = JSON.parse(await source(join(root, `.${stage}-output.json`)) || '{}') || {}; } catch { /* Optional classification metadata must not block a valid checkpoint. */ }
          await syncClassification(stage, existing, savedOutput.fingerprint === fingerprint ? savedOutput.classification : undefined);
        }
        continue;
      }
      for (const downstream of STAGES.slice(index)) delete state.completed[downstream];
      await atomic(statePath, state);
      invocationId = randomUUID();
      await bus({ type: 'agent_started', agent: stage, invocationId, task: stage });
      if (stage === 'builder' && resume) {
        const images = plannedImages(prior[2]!);
        const generated = JSON.parse(await source(join(root, 'artifacts/generated.json')) || '{}');
        const recovered = await recoverBuilderDraft(root, fingerprint, images, generated);
        if (recovered) {
          const delivery = await deliverBuilder(recovered.html, fingerprint, images, generated, recovered.direction, recovered.repairs);
          state.completed[stage] = checkpoint(fingerprint, delivery.html); await atomic(statePath, state);
          await bus({ type: 'build_done', commitReceipt: { files: delivery.files } });
          await bus({ type: 'agent_finished', agent: stage, invocationId, output: 'Completed and saved: final/00-index.html (revalidated draft)' + (delivery.repairs.length ? `\nCorrected image references: ${delivery.repairs.map(repair => repair.id).join(', ')}.` : ''), artifactRefs: [`runs/${runId}/final/00-index.html`] });
          continue;
        }
      }

      if (index >= 2 && !capability) { capability = await imageCapabilityInfo(signal); sizes = capability.sizes; }
      const [maxWidth, maxHeight] = dimensions(setting('DREAMATIC_IMAGE_DEFAULT_SIZE'));
      const allowed = sizes?.filter(s => { const [w,h] = dimensions(s); return w <= maxWidth && h <= maxHeight; });
      const acceptsSize = (size: string) => {
        const [width, height] = dimensions(size);
        return width <= maxWidth && height <= maxHeight && (!capability?.verified || Boolean(allowed?.includes(size)));
      };
      if (allowed && !allowed.length) throw new Error('No verified model size fits the image budget. Adjust System Settings.');
      const draftPath = join(root, '.design-draft.json');
      let citationNote = '';
      const checkDesign = (text: string) => {
        for (const image of plannedImages(text)) if (!acceptsSize(image.size)) throw new Error(`Invalid planned size: ${image.size}`);
      };

      const saveCitationReview = async (result: CitationReview) => {
        const reportPath = join(root, '.citation-report.json');
        let report: Record<string, unknown> = {};
        try { const saved = JSON.parse(await source(reportPath) || '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) report = saved; } catch { /* Rebuild optional diagnostic metadata; it is never a stage gate. */ }
        const previous = report[stage] as { issues?: string[]; fingerprint?: string } | undefined;
        report[stage] = { fingerprint, repairs: result.repairs, issues: result.issues, unusedReferences: result.unusedReferences };
        await atomic(reportPath, report);
        if ((result.issues.length || previous?.issues?.length) &&
            (previous?.fingerprint !== fingerprint || JSON.stringify(previous?.issues) !== JSON.stringify(result.issues))) {
          await bus({ type: 'citation_review', id: `${runId}-citations-${stage}`, agent: stage,
            summary: 'Reference verification',
            detail: result.issues.length
              ? `${stage === 'researcher' ? 'Researcher' : 'Designer'}: Some references need verification. Automatic repairs were applied where possible; the workflow will continue. ${result.issues.length} issue(s) remain. See the reference notes and stage output for details.`
              : 'Previously reported reference issues have been resolved. The workflow will continue.' });
        }
        const notes = [
          ...result.repairs,
          ...(result.issues.length ? ['References need verification; workflow continues.', ...result.issues] : []),
          ...(result.unusedReferences.length ? [`Citation note: listed but uncited references ${result.unusedReferences.map(id => `[${id}]`).join(', ')} were retained.`] : [])
        ];
        citationNote = notes.join('\n');
      };

      if (stage === 'designer') {
        let draftCitationReview: CitationReview | undefined;
        let draft: { fingerprint: string; text: string; classification?: ProjectClassification } | undefined;
        try {
          draft = JSON.parse(await source(draftPath) || 'null');
          if (draft && typeof draft.text === 'string' && draft.fingerprint !== fingerprint) {
            const compatible = await matchesLegacyCheckpoint(root, stage, hash(draft.fingerprint + draft.text), state.request, attachments, prior, draft.text, instruction);
            if (compatible) draft.fingerprint = fingerprint;
          }
          if (draft?.fingerprint !== fingerprint || typeof draft.text !== 'string') draft = undefined;
          if (draft) {
            const citationReview = reviewDesignCitations(draft.text, prior[1]!);
            checkDesign(citationReview.text);
            draftCitationReview = citationReview;
            draft.text = annotateCitationIssues(citationReview);
          }
        } catch { draft = undefined; /* Retain the draft, but regenerate if it still fails validation. */ }
        if (draft) {
          await saveCitationReview(draftCitationReview!);
          await saveStageOutput(join(root, 'design.md'), draft.text);
          await syncWorkTitle('designer', draft.text);
          await syncClassification('designer', draft.text, draft.classification);
          state.completed[stage] = checkpoint(fingerprint, draft.text); await atomic(statePath, state);
          await bus({ type: 'agent_finished', agent: stage, invocationId, output: 'Completed and saved: design.md (revalidated draft)' + (citationNote ? `\n${citationNote}` : ''), artifactRefs: [`runs/${runId}/design.md`] });
          continue;
        }
      }
      const images = stage === 'builder' ? plannedImages(prior[2]!) : [];
      let generationWrites = Promise.resolve();
      const generated: Record<string, { signature: string; path: string; method: string; digest: string }> = JSON.parse(await source(join(root, 'artifacts/generated.json')) || '{}');
      const restoredDirection = stage === 'builder' && resume ? await savedShowcaseDirection(root, fingerprint, images, generated) : undefined;
      const exhibitionContext = stage === 'builder'
        ? `\n\nExhibition material inventory (exact prompts are already in design.md above; existing works are reused by image_generate):\n${JSON.stringify(images.map(image => ({ id: image.id, introduction: image.introduction, size: image.size, source: showcaseImageSource(image.id), generated: Boolean(generated[image.id]) })), null, 2)}\n${await source(join(root, 'artifacts/00-gallery.html')) ? 'An existing exhibition is available at artifacts/00-gallery.html. Read it to identify content/sequence weaknesses before redesigning; preserve useful explanation, not its template.' : 'No earlier exhibition exists. Build the structure from the works and concept.'}`
        : '';
      const showcase = stage === 'builder' ? createShowcaseTools({ root, images, generated,
        ...(restoredDirection ? { initialDirection: restoredDirection } : {}),
        saveDirection: direction => saveShowcaseDirection(fingerprint, images, generated, direction)
      }) : undefined;
      const tools: ToolDefinition[] = showcase ? [createBuilderTextReadTool(root), ...showcase.tools] : [];
      let pendingClassification: ProjectClassification | undefined;
      if (stage === 'orchestrator' || stage === 'designer') tools.push({
        name: 'set_project_classification', label: 'Classify design project',
        description: 'Choose the actual design discipline, not the HTML/image format or supporting Skills. One primary category and only substantive secondary scopes. This records pending metadata, published after the stage deliverable is saved. Categories: ' + JSON.stringify(PROJECT_CATEGORIES.map(({ id, en }) => ({ id, name: en }))),
        parameters: Type.Object({ primary: Type.String(), secondary: Type.Array(Type.String()) }),
        async execute(_id, params) {
          const candidate = projectClassification({ schemaVersion: 1, taxonomyVersion: 'dreamatic-design-v1', ...(params as object) });
          if (!candidate) return { content: [{ type: 'text' as const, text: 'Classification not recorded: use only the listed canonical ids. You may correct it; do not interrupt the design task.' }], details: {} };
          pendingClassification = candidate;
          return { content: [{ type: 'text' as const, text: JSON.stringify(candidate) }], details: {} };
        }
      });
      let question: DesignClarificationRequest | undefined;
      if (stage === 'orchestrator') tools.push({
        name: 'ask_user', label: 'Clarify direction', description: 'Present structured questions using Dreamatic’s existing clarification card. Ask only essential questions, then stop and wait.',
        parameters: Type.Object({
          title: Type.String(), context: Type.Optional(Type.String()),
          questions: Type.Array(Type.Object({
            id: Type.Optional(Type.String()), header: Type.String(), question: Type.String(),
            options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), description: Type.String() }), { minItems: 2, maxItems: 4 })),
            multiple: Type.Optional(Type.Boolean()), custom: Type.Optional(Type.Boolean()),
            required: Type.Optional(Type.Boolean()), placeholder: Type.Optional(Type.String())
          }), { minItems: 1 })
        }),
        async execute(toolCallId, params) {
          if (question) return { content: [{ type: 'text', text: JSON.stringify({ status: 'waiting_for_user', ...question }) }], details: {} };
          const result = { content: [{ type: 'text' as const, text: JSON.stringify({ ...(params as Record<string, unknown>), status: 'waiting_for_user' }) }], details: {} };
          const request = clarificationFromToolResult(result, toolCallId);
          if (!request) throw new Error('Invalid clarification questions');
          question = request;
          options.onQuestion?.(request);
          // Store pending questions before a transport interruption can lose them.
          await atomic(join(root, 'pending-clarification.json'), request);
          return result;
        }
      });
      if (stage === 'researcher') tools.push({ name: 'search', label: 'Research references', description: 'Search for relevant source material.', parameters: Type.Object({ query: Type.String() }), async execute(_id, params) {
        const serper = setting('DREAMATIC_SEARCH_PROVIDER') === 'serper';
        const response = await fetch(serper ? 'https://google.serper.dev/search' : `https://html.duckduckgo.com/html/?q=${encodeURIComponent((params as { query: string }).query)}`, { ...(serper ? { method: 'POST', headers: { 'X-API-KEY': searchApiKey(), 'Content-Type': 'application/json' }, body: JSON.stringify({ q: (params as { query: string }).query }) } : {}), signal });
        if (!response.ok) throw new Error(`Search failed: ${response.status}`);
        return { content: [{ type: 'text', text: await response.text() }], details: {} };
      } });
      const imageItems: Record<string, ImageProgressItem> = {};
      const imageAttempts: Record<string, number> = {};
      let pendingImages: { saved: number; total: number; failed: Array<{ id: string; attempts: number; error: ImageFailure }>; message: string } | undefined;
      if (stage === 'builder') tools.push({ name: 'image_generate', label: 'Generate design image', description: 'Generate planned images with bounded provider retries. Returns a complete success/failure receipt; failures pause the stage for explicit user retry. Existing matching images are reused. Returns stable dreamatic-image:ID sources for img and full-resolution links; Dreamatic resolves physical files on delivery.', parameters: Type.Object({ ids: Type.Array(Type.String()) }), executionMode: 'sequential', async execute(toolCallId, params) {
        const reportImages = () => bus({ type: 'agent_progress', agent: stage, invocationId, toolCallId, total: images.length, imageItems: structuredClone(imageItems), output: 'Image generation progress' });
        if (pendingImages) return { content: [{ type: 'text', text: pendingImages.message }], details: pendingImages };
        const ids = [...new Set((params as { ids: string[] }).ids)];
        const imageLocation = (image: PlannedImage) => {
          const signature = hash(JSON.stringify([image, setting('DREAMATIC_IMAGE_MODEL'), setting('DREAMATIC_IMAGE_BASE_URL'), setting('DREAMATIC_IMAGE_GENERATION_ENDPOINT')]));
          return { signature, path: `artifacts/${image.id}-${signature.slice(0,12)}.png` };
        };
        const cached = async (image: PlannedImage) => {
          const { signature, path } = imageLocation(image), record = generated[image.id];
          return record?.signature === signature && record.path === path && await readFile(join(root, path)).then(bytes => createHash('sha256').update(bytes).digest('hex')).catch(() => '') === record.digest;
        };
        for (const image of images) {
          imageItems[image.id] ??= { state: 'queued', label: image.id.replaceAll('-', ' ').replaceAll('_', ' ') };
          if (await cached(image)) imageItems[image.id] = { ...imageItems[image.id], state: 'saved', ok: true, path: `runs/${runId}/${generated[image.id]!.path}`, reused: true };
        }
        await reportImages();
        const generate = async (imageId: string) => {
        const image = images.find(i => i.id === imageId); if (!image) throw new Error('Unknown planned image');
        if (!acceptsSize(image.size)) throw new Error('Planned image violates verified size or budget');
        const { signature, path } = imageLocation(image);
        if (await cached(image)) {
          imageItems[image.id] = { ...imageItems[image.id], ok: true, state: 'saved', path: `runs/${runId}/${path}`, reused: true };
          await reportImages();
          return { content: [{ type: 'text', text: showcaseImageSource(image.id) }], details: {} };
        }
        const release = await imageSlot(signal);
        const started = Date.now();
        imageItems[image.id] = { label: image.id.replaceAll('-', ' ').replaceAll('_', ' '), state: 'generating', startedAt: new Date(started).toISOString() };
        try {
        const maxAttempts = Number(setting('DREAMATIC_IMAGE_RETRY_ATTEMPTS'));
        const remaining = maxAttempts - (imageAttempts[image.id] ?? 0);
        if (remaining <= 0) throw new Error('Image attempt budget exhausted');
        const attemptResult = await retryImage(async () => {
          imageAttempts[image.id] = (imageAttempts[image.id] ?? 0) + 1;
          const attemptStartedAt = new Date().toISOString();
          imageItems[image.id] = { ...imageItems[image.id], startedAt: attemptStartedAt };
          await reportImages();
          return requestImage({
            url: setting('DREAMATIC_IMAGE_GENERATION_ENDPOINT') || `${setting('DREAMATIC_IMAGE_BASE_URL').replace(/\/$/, '')}/images/generations`,
            apiKey: setting('DREAMATIC_IMAGE_API_KEY') || setting('DREAMATIC_API_KEY'),
            model: setting('DREAMATIC_IMAGE_MODEL'), prompt: image.prompt, size: image.size,
            responseFormat: setting('DREAMATIC_IMAGE_RESPONSE_FORMAT'),
            timeoutMs: Number(setting('DREAMATIC_IMAGE_TIMEOUT_MS')),
            bodyIdleTimeoutMs: Number(setting('DREAMATIC_IMAGE_BODY_IDLE_TIMEOUT_MS')),
            maxResponseBytes: Number(setting('DREAMATIC_IMAGE_RESPONSE_MAX_BYTES')), signal,
            onUsage: async usage => { await bus({ type: 'agent_progress', agent: stage, invocationId, toolCallId, output: 'Image generation progress',
              imageUsage: { imageId: image.id, startedAt: attemptStartedAt, tokens: imageUsageTokens(usage) } }); }
          });
        }, { maxAttempts: remaining, signal, onRetry: async (attempt, failure, waitMs) => {
          await bus({ type: 'image_retry', agent: stage, invocationId, toolCallId, imageId: image.id,
            attempt, maxAttempts, waitMs, error: failure });
          await bus({ type: 'agent_progress', agent: stage, invocationId, toolCallId,
            output: `Image ${image.id}: ${failure.code}. Retrying after ${Math.round(waitMs / 1000)}s (${attempt + 1}/${maxAttempts}).` });
        } });
        if (!attemptResult.ok) return { failed: true as const, id: image.id, attempts: imageAttempts[image.id]!, error: attemptResult.error };
        const { bytes } = attemptResult.value;
        await writeFile(join(root, path), bytes);
        await recordSuccessfulImageSize(image.size);
        generated[image.id] = { signature, path, method: 'image_generate', digest: createHash('sha256').update(bytes).digest('hex') };
        generationWrites = generationWrites.then(() => atomic(join(root, 'artifacts/generated.json'), generated));
        await generationWrites;
        imageItems[image.id] = { ...imageItems[image.id], ok: true, state: 'saved', path: `runs/${runId}/${path}`, durationMs: Date.now() - started, reused: false };
        await reportImages();
        return { content: [{ type: 'text', text: showcaseImageSource(image.id) }], details: {} };
        } finally { release(); }
        };
        const results: string[] = [];
        const failures: Array<{ id: string; attempts: number; error: ImageFailure }> = [];
        let cursor = 0;
        const workers = Array.from({ length: Math.min(ids.length, Number(setting('DREAMATIC_IMAGE_CONCURRENCY'))) }, async () => {
          while (cursor < ids.length) {
            signal.throwIfAborted();
            const id = ids[cursor++]!;
            const result = await generate(id);
            if (result.failed === true) {
              failures.push(result);
              imageItems[id] = { ...imageItems[id], ok: false, state: 'failed', durationMs: Date.now() - Date.parse(imageItems[id]?.startedAt ?? new Date().toISOString()) };
              await reportImages();
            } else results.push(`${id}: ${result.content[0]!.text}`);
          }
        });
        const settled = await Promise.allSettled(workers);
        signal.throwIfAborted();
        const fatal = settled.find(result => result.status === 'rejected');
        if (fatal?.status === 'rejected') throw fatal.reason;
        const saved: string[] = [];
        for (const image of images) if (await cached(image)) saved.push(image.id);
        const missing = images.filter(image => !saved.includes(image.id)).map(image => image.id);
        const receipt = { total: images.length, saved, missing, failed: failures };
        await atomic(join(root, '.image-generation-state.json'), { fingerprint, invocationId, ...receipt });
        if (failures.length) {
          const message = `Image generation paused: ${saved.length}/${images.length} images saved. Needs retry: ${failures.map(item => `${(images.find(image => image.id === item.id)?.introduction || item.id).replace(/\[\d+(?:[,–—-]\d+)*\]/g, '').split(/[。.!?\n]/)[0]!.trim().slice(0, 80)} (${item.error.code}, ${item.attempts} attempt(s))`).join('; ')}. Successful images are retained. Check the image service/settings, then Continue workflow to retry only missing images.`;
          pendingImages = { saved: saved.length, total: images.length, failed: failures, message };
          await bus({ type: 'image_batch_result', id: `${runId}-image-generation`, summary: 'Image generation paused', detail: message });
        } else if (!missing.length) {
          await bus({ type: 'image_batch_result', id: `${runId}-image-generation`, summary: 'Design images ready', detail: `All ${saved.length} design images are saved. Continuing exhibition production.` });
        }
        return { content: [{ type: 'text', text: results.join('\n') + '\n' + JSON.stringify(receipt) + (failures.length ? '\nAutomatic retry budget reached. The workflow is pausing for user retry; do not call image_generate or plan_showcase again.' : '') }], details: receipt };

      } });
      // Image 1/2 refer to this message's attachments first, then the existing project inventory.
      const messageImageIds = (options.images ?? []).flatMap(image => { const index = attachments.findIndex(saved => saved.data === image.data && saved.mimeType === image.mimeType); return index >= 0 ? [`attachment:${index}`] : []; });
      const materialInventory = stage === 'orchestrator' ? await editorMaterials(workspaceDir, runId, messageImageIds) : [];
      let editorUsed = false;
      if (stage === 'orchestrator') {
        const delegate = editorTool({ repoRoot, inventory: materialInventory, originalRequest: text, workspaceDir, runId, signal, emit: event => { void bus((event as { event: Record<string, unknown> }).event); } });
        tools.push({ ...delegate, async execute(...args) { editorUsed = true; return delegate.execute(...args); } });
      }
      const { session } = await createDreamaticAgent({ root, role: stage, systemPrompt: `${instruction}\n\n${DELIVERY_POLICY}\nDesignated output: ${outputs[index]}`, skills: stage === 'designer' ? [join(repoRoot, '.pi/skills')] : stage === 'builder' ? [join(repoRoot, '.pi/skills/concept-showcase-storytelling')] : [], textOnly: stage === 'builder', tools });
      options.onSession?.(session);
      const responseTimer = createModelResponseTimer({
        firstOutputMs: Number(setting(`DREAMATIC_MODEL_TURN_TIMEOUT_MS_${stage.toUpperCase()}`) || setting('DREAMATIC_MODEL_TURN_TIMEOUT_MS')),
        generationMs: Number(setting('DREAMATIC_MODEL_GENERATION_TIMEOUT_MS')),
        idleMs: Number(setting('DREAMATIC_MODEL_IDLE_TIMEOUT_MS')),
        ...(setting('DREAMATIC_MODEL_TOTAL_TIMEOUT_MS') ? { totalMs: Number(setting('DREAMATIC_MODEL_TOTAL_TIMEOUT_MS')) } : {}),
        onTimeout: () => { void session.abort(); },
      });
      let publicText = '';
      let progressTimer: ReturnType<typeof setTimeout> | undefined;
      const flushProgress = () => {
        if (progressTimer) clearTimeout(progressTimer);
        progressTimer = undefined;
        if (publicText) void bus({ type: 'agent_progress', agent: stage, invocationId, output: publicText.slice(-1200) });
      };
      session.subscribe(event => {
        responseTimer.handle(event);
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          publicText = (publicText + event.assistantMessageEvent.delta).slice(-1200);
          if (!progressTimer) progressTimer = setTimeout(flushProgress, 250);
        }
        if (event.type === 'message_start' && event.message.role === 'assistant') publicText = '';

        emit({ type: 'agent_event', agent: stage, invocationId, event: publicWorkflowData(event) });
        if (event.type === 'tool_execution_start') {
          void bus({ type: 'tool_started', agent: stage, invocationId, toolCallId: event.toolCallId, toolName: event.toolName, input: JSON.stringify(event.args) });
        } else if (event.type === 'tool_execution_end') {
          if ((event.toolName === 'ask_user' && question && !event.isError) || (event.toolName === 'image_generate' && pendingImages)) void session.abort();
          void bus({ type: 'tool_finished', agent: stage, invocationId, toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, output: JSON.stringify(event.result) });
        }
      });
      const abort = () => { void session.abort(); }; signal.addEventListener('abort', abort, { once: true });
      let result: string;
      try {
        await session.prompt(`User request:\n${state.request}${stage === 'orchestrator' ? '\n\nEditable project materials (use edit_materials for image editing):\n' + await editorInventory(workspaceDir, runId, materialInventory) : ''}\n\n${prior.map((doc,i) => `--- ${outputs[i]} ---\n${doc}`).join('\n\n')}\n\n${allowed ? `${capability?.verified ? 'Verified supported sizes within current budget (not necessarily exhaustive)' : 'Model size capability is UNKNOWN. Choose WIDTHxHEIGHT within the configured ceiling, which is only a budget, not detected model support or a model maximum; Builder will validate through actual generation. Unverified ceiling'}: ${allowed.join(', ')}` : ''}${['designer', 'builder'].includes(stage) ? '\n\nReference verification report (advisory, never a reason to stop):\n' + await source(join(root, '.citation-report.json')) : ''}${exhibitionContext}${restoredDirection ? '\nA validated exhibition direction from the earlier attempt is restored. Preserve it; repair the saved .builder-output.json HTML instead of starting the exhibition over. Call plan_showcase only if you need to change the direction.' : ''}`, { images: (stage === 'builder' ? [] : attachments).map(image => ({ type: 'image' as const, data: image.data.replace(/^data:[^,]+,/, ''), mimeType: image.mimeType })) });
        signal.throwIfAborted();
        if (!pendingImages && responseTimer.failure) throw new Error(`Model response timeout (${responseTimer.failure}); tool execution time is excluded. Resume to retry this stage`);
        result = session.getLastAssistantText() || '';
        if (!question && !pendingImages && session.messages.some(m => m.role === 'assistant' && (m.stopReason === 'error' || m.stopReason === 'aborted'))) throw new Error('Model execution failed; resume to retry this stage');
      } finally {
        flushProgress(); responseTimer.dispose(); signal.removeEventListener('abort', abort); session.dispose(); options.onSession?.(undefined); await busWrites;
        if (editorUsed) {
          state.request = stateBeforeRequest.request; state.completed = stateBeforeRequest.completed;
          await atomic(statePath, stateBeforeRequest); await atomic(briefPath, briefBeforeRequest);
        }
      }
      if (editorUsed) {
        await bus({ type: 'agent_finished', agent: stage, invocationId, output: result || 'Editor handled the material editing request. See context/edit.md.' });
        await status('completed');
        return;
      }
      if (pendingImages) {
        await atomic(statePath, state);
        await status('waiting_for_images');
        await bus({ type: 'agent_waiting', agent: stage, invocationId, reason: 'images', output: pendingImages.message });
        return;
      }
      if (question) {
        await atomic(statePath, state);
        await status('waiting_for_user');
        await bus({ type: 'agent_waiting', agent: stage, invocationId, output: 'Waiting for your answers' });
        return;
      }
      if (!result.trim()) throw new Error(`${stage} returned no result`);
      // Keep the complete public output before validation or disk publication can fail.
      await atomic(join(root, `.${stage}-output.json`), { fingerprint, text: result, ...(pendingClassification ? { classification: pendingClassification } : {}), ...(stage === 'builder' ? { direction: showcase?.direction ?? null, assets: showcaseAssets(images, generated) } : {}) });
      let buildReceipt: Record<string, string> | undefined;
      if (stage === 'researcher') {
        const citationReview = reviewResearchCitations(result);
        await saveCitationReview(citationReview);
        result = citationReview.text;
      }
      if (stage === 'designer') {
        await atomic(draftPath, { fingerprint, text: result, ...(pendingClassification ? { classification: pendingClassification } : {}) });
        const citationReview = reviewDesignCitations(result, prior[1]!);
        checkDesign(citationReview.text);
        await saveCitationReview(citationReview);
        result = annotateCitationIssues(citationReview);
      }
      let deliveryNote = '';
      if (stage === 'builder') {
        if (!showcase?.direction) throw new Error('Record the exhibition direction for every planned work before delivering HTML');
        const delivery = await deliverBuilder(result, fingerprint, images, generated, showcase.direction);
        result = delivery.html; buildReceipt = delivery.files;
        if (delivery.repairs.length) deliveryNote = `Corrected image references: ${delivery.repairs.map(repair => repair.id).join(', ')}.`;
      } else await saveStageOutput(join(root, outputs[index]!), result);
      if (stage === 'orchestrator' || stage === 'designer') {
        await syncWorkTitle(stage, result);
        await syncClassification(stage, result, pendingClassification);
      }
      state.completed[stage] = checkpoint(fingerprint, result); await atomic(statePath, state);
      if (buildReceipt) await bus({ type: 'build_done', commitReceipt: { files: buildReceipt } });
      await bus({ type: 'agent_finished', agent: stage, invocationId, output: `Completed and saved: ${outputs[index]}` + (citationNote ? `\n${citationNote}` : '') + (deliveryNote ? `\n${deliveryNote}` : ''), artifactRefs: [`runs/${runId}/${outputs[index]}`] });
    }
    await busWrites;
    const deliveredImages = plannedImages(await source(join(root, 'design.md')));
    const delivered = JSON.parse(await source(join(root, 'artifacts/generated.json')) || '{}');
    await publishCompletionSummary({ root, runId, completionKey: state.completed.builder!, save: atomic, emit: bus,
      deliverables: [
        { kind: 'page', path: 'final/00-index.html', label: 'Showcase page' },
        ...deliveredImages.map(image => ({ kind: 'image' as const, path: delivered[image.id].path as string,
          label: image.introduction.replace(/\[\d+(?:[,–—-]\d+)*\]/g, '').split(/[。.!?\n]/)[0]?.trim().slice(0, 60) || image.id })),
        ...[['intent.md', 'Intent brief'], ['research.md', 'Research findings'], ['design.md', 'Design proposal'], ['showcase.md', 'Exhibition direction']].map(([path, label]) => ({ kind: 'document' as const, path: path!, label: label! }))
      ] });
    await status('completed');
  } catch (error) {
    await atomic(statePath, state); await status('interrupted');
    await bus({ type: 'agent_interrupted', agent: active, invocationId, status: 'interrupted', error: String(error) }); throw error;
  }
}
