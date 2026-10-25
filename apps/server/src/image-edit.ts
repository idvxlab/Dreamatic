import { resolveBaseImage, type BaseImageSelection } from './image-edit-base.js';
import { imageDimensions, imageEditSizePolicy } from './image-edit-size.js';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_FIELDS } from './config-store.js';
import { requestImage } from './image-request.js';
import { imageSlot } from './image-slots.js';
import { projectFileContent, projectFiles } from './project-files.js';
import { projectInputDirectory, storeProjectMedia } from './media-upload.js';

function setting(env: NodeJS.ProcessEnv, key: string) {
  return env[key]?.trim() || CONFIG_FIELDS.find(field => field.key === key)?.defaultValue || '';
}
export function imageEditSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: setting(env, 'DREAMATIC_IMAGE_EDIT_ENABLED') === 'true',
    configured: Boolean(setting(env, 'DREAMATIC_IMAGE_API_KEY') || setting(env, 'DREAMATIC_API_KEY')),
    model: setting(env, 'DREAMATIC_IMAGE_EDIT_MODEL') || setting(env, 'DREAMATIC_IMAGE_MODEL'),
    size: setting(env, 'DREAMATIC_IMAGE_EDIT_SIZE') || setting(env, 'DREAMATIC_IMAGE_DEFAULT_SIZE'),
  };
}
export function imageBytesKind(bytes: Buffer): 'png' | 'jpg' | 'webp' | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return 'png';
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 16 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'webp';
}
export interface ImageEditDecision extends BaseImageSelection {
  sizeSource: 'user' | 'base-image' | 'first-input';
}
const activeEdits = new Set<string>();
/** A user-requested image edit is separate from approved design outputs. Never rewrite source images or manifests. */
export async function editProjectImage(workspace: string, runId: string, fileId: unknown, prompt: unknown, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env, provenance?: { taskId: string; attempt: number; originalPrompt?: string; inputOrdinals?: number[] }, onSize?: (size: string, decision: ImageEditDecision) => Promise<void>) {
  const sourceIds = Array.isArray(fileId) ? fileId : [fileId];
  if (!sourceIds.length || sourceIds.length > 16 || sourceIds.some(id => typeof id !== 'string') || new Set(sourceIds).size !== sourceIds.length || typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 8000) throw new Error('Enter an image edit prompt between 1 and 8000 characters.');
  env = { ...env };
  const config = imageEditSettings(env);
  if (!config.enabled) throw new Error('Image editing is disabled in Settings.');
  if (!config.configured) throw new Error('Configure an image API key in Settings before editing images.');
  const catalog = await projectFiles(workspace, runId);
  const files = sourceIds.map(id => {
    const file = catalog.find(file => file.id === id && file.category === 'assets' && /^(png|jpe?g|webp)$/u.test(file.kind));
    if (!file) throw new Error('Image editing supports project PNG, JPEG and WebP images only.');
    if ((file.size ?? 0) >= 50 * 1024 * 1024) throw new Error('The source image must be smaller than 50 MB.');
    return file;
  });
  const keys = files.map(file => JSON.stringify([workspace, runId, file.id]));
  if (keys.some(key => activeEdits.has(key))) throw new Error('This image is already being edited. Wait for the current request to finish.');
  keys.forEach(key => activeEdits.add(key));
  try {
    const images: Array<{ bytes: Buffer; filename: string; mimeType: string }> = [];
    for (const file of files) {
      const source = await projectFileContent(workspace, runId, file.id);
      if (source.data.length >= 50 * 1024 * 1024) throw new Error('The source image must be smaller than 50 MB.');
      const sourceKind = imageBytesKind(source.data);
      if (!sourceKind || (sourceKind === 'jpg' ? !/^(jpg|jpeg)$/u.test(file.kind) : sourceKind !== file.kind)) throw new Error('The source file is not a valid supported image.');
      images.push({ bytes: source.data, filename: `source-${images.length}.${sourceKind}`, mimeType: `image/${sourceKind === 'jpg' ? 'jpeg' : sourceKind}` });
    }
    const sourceDimensions = images.map(image => imageDimensions(image.bytes));
    if (sourceDimensions.some(value => !value)) throw new Error('Could not read the source image dimensions.');
    // Validate output folders before contacting a paid provider.
    const outputFolder = await projectInputDirectory(workspace, runId, 'user-assets');
    const recordFolder = await projectInputDirectory(workspace, runId, 'media-edits');
    const originalPrompt = provenance?.originalPrompt ?? prompt;
    const requestedSize = imageEditSizePolicy(originalPrompt, sourceDimensions[0]!, config.size);
    const base = await resolveBaseImage({ root: join(workspace, 'runs', runId), prompt: originalPrompt, inputs: files.map((file, index) => ({ id: file.id, title: file.title, ordinal: provenance?.inputOrdinals?.[index] ?? index + 1 })), signal, env, allowReasoning: requestedSize.mode === 'preserve', images: () => images.map(image => ({ data: image.bytes.toString('base64'), mimeType: image.mimeType })) });
    const sizePolicy = imageEditSizePolicy(originalPrompt, sourceDimensions[base.baseImageIndex]!, config.size);
    const decision: ImageEditDecision = { ...base, sizeSource: sizePolicy.mode === 'resize' ? 'user' : base.baseImageMethod === 'fallback' ? 'first-input' : 'base-image' };
    await onSize?.(sizePolicy.requestSize, decision);
    const materialMap = files.length > 1 ? `\n\nInput image mapping (multipart order):\n${files.map((file, index) => `- Input image ${index + 1}: Image ${provenance?.inputOrdinals?.[index] ?? index + 1}; material ${file.id}; name ${file.title}`).join('\n')}` : '';
    const instruction = `${prompt.trim()}${materialMap}` + (sizePolicy.mode === 'preserve'
      ? `\n\nOutput constraint: preserve input image ${base.baseImageIndex + 1} (${base.baseImageId})'s exact pixel dimensions (${sizePolicy.requestSize}). Do not resize, crop, or change the canvas dimensions.`
      : '');
    const release = await imageSlot(signal);
    let result;
    try {
      result = await requestImage({
        url: setting(env, 'DREAMATIC_IMAGE_EDIT_ENDPOINT') || `${setting(env, 'DREAMATIC_IMAGE_BASE_URL').replace(/\/$/u, '')}/images/edits`,
        apiKey: setting(env, 'DREAMATIC_IMAGE_API_KEY') || setting(env, 'DREAMATIC_API_KEY'),
        model: config.model, prompt: instruction, size: sizePolicy.requestSize,
        responseFormat: setting(env, 'DREAMATIC_IMAGE_EDIT_RESPONSE_FORMAT'),
        images,
        timeoutMs: Number(setting(env, 'DREAMATIC_IMAGE_TIMEOUT_MS')),
        bodyIdleTimeoutMs: Number(setting(env, 'DREAMATIC_IMAGE_BODY_IDLE_TIMEOUT_MS')),
        maxResponseBytes: Number(setting(env, 'DREAMATIC_IMAGE_RESPONSE_MAX_BYTES')), signal,
      });
    } finally { release(); }
    signal.throwIfAborted();
    const kind = imageBytesKind(result.bytes);
    if (!kind) throw new Error('The image provider returned an invalid image. Try again or check the edit model in Settings.');
    const outputDimensions = imageDimensions(result.bytes);
    if (!outputDimensions) throw new Error('The image provider returned an invalid image with unreadable dimensions.');
    if (sizePolicy.expected && (outputDimensions.width !== sizePolicy.expected.width || outputDimensions.height !== sizePolicy.expected.height)) {
      throw new Error(`Image edit size mismatch: expected ${sizePolicy.requestSize}, received ${outputDimensions.width}x${outputDimensions.height}. The edit provider must support the requested dimensions; no resized result was saved.`);
    }
    const id = randomUUID();
    const saved = await storeProjectMedia(workspace, runId, `${files[base.baseImageIndex]!.title.replace(/\.[^.]+$/u, '')}-edit.${kind}`, result.bytes);
    const recordPath = join(recordFolder, `${id}.json`);
    try {
      await writeFile(recordPath, JSON.stringify({ version: 1, id, ...provenance, createdAt: new Date().toISOString(), sourceId: files[base.baseImageIndex]!.id, sourceName: files[base.baseImageIndex]!.title, sourceIds: files.map(file => file.id), outputId: saved.id, prompt: prompt.trim(), model: config.model, size: sizePolicy.requestSize, sizeMode: sizePolicy.mode, ...decision, sourceDimensions, outputDimensions, executedPrompt: instruction, usage: result.usage }, null, 2), { flag: 'wx', mode: 0o600 });
    } catch (error) { await rm(recordPath, { force: true }); await rm(join(outputFolder, saved.title), { force: true }); throw error; }
    return { ...saved, ...decision, outputDimensions, editId: id, model: config.model, editSize: sizePolicy.requestSize, usage: result.usage, path: saved.id, category: 'assets' as const, group: 'Uploaded files' };
  } finally { keys.forEach(key => activeEdits.delete(key)); }
}
