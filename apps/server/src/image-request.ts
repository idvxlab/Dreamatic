import { Agent, fetch, FormData } from 'undici';
import { setTimeout as delay } from 'node:timers/promises';

export interface ImageFailure {
  message: string;
  code: string;
  retryable: boolean;
  status?: number;
  phase: 'generation' | 'download';
  retryAfterMs?: number | undefined;
}
export class ImageRequestError extends Error {
  constructor(readonly failure: ImageFailure) { super(failure.message); this.name = 'ImageRequestError'; }
}
class ImageUsageError extends Error { constructor(cause: unknown) { super('Failed to record image usage', { cause }); } }
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const ms = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(60_000, Math.max(0, ms)) : undefined;
}
function httpError(status: number, phase: ImageFailure['phase'], after: string | null): ImageRequestError {
  return new ImageRequestError({ message: `Image ${phase} failed (HTTP ${status})`, code: `HTTP_${status}`, status,
    phase, retryable: status === 408 || status === 429 || status >= 500, retryAfterMs: retryAfter(after) });
}
/** Retain transport diagnostics without logging provider bodies, prompts or credentials. */
function transportError(error: unknown, phase: ImageFailure['phase'], timedOut: boolean): ImageRequestError {
  let cause = error as { code?: unknown; cause?: unknown; name?: unknown } | undefined;
  let code = timedOut ? 'IMAGE_TOTAL_TIMEOUT' : 'IMAGE_NETWORK_ERROR';
  for (let level = 0; cause && level < 5; level++) {
    if (!timedOut && typeof cause.code === 'string' && /^[A-Z0-9_]+$/.test(cause.code)) code = cause.code;
    cause = cause.cause as typeof cause;
  }
  return new ImageRequestError({ message: `Image ${phase} failed (${code})`, code, phase, retryable: true });
}
export interface ImageRequestOptions {
  url: string; apiKey: string; model: string; prompt: string; size: string; responseFormat: string;
  timeoutMs: number; bodyIdleTimeoutMs: number; signal: AbortSignal;
  image?: { bytes: Buffer; filename: string; mimeType: string };
  images?: Array<{ bytes: Buffer; filename: string; mimeType: string }>;
  maxResponseBytes?: number;
  onUsage?: (usage: unknown) => Promise<void>;
}
/** Per-request dispatcher: never change Pi/provider/global HTTP behavior. Deadline also covers image downloads. */
export async function requestImage(options: ImageRequestOptions): Promise<{ bytes: Buffer; usage?: unknown }> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = AbortSignal.any([options.signal, timeout]);
  const dispatcher = new Agent({ headersTimeout: options.timeoutMs, bodyTimeout: options.bodyIdleTimeoutMs,
    connect: { timeout: Math.min(30_000, options.timeoutMs) } });
  let phase: ImageFailure['phase'] = 'generation';
  const limit = options.maxResponseBytes ?? 67_108_864;
  if (!Number.isSafeInteger(limit) || limit < 1) { await dispatcher.destroy(); throw new Error('Invalid image response byte limit'); }
  const tooLarge = () => new ImageRequestError({ message: `Image ${phase} exceeds response byte limit (${limit})`, code: 'IMAGE_RESPONSE_TOO_LARGE', phase, retryable: false });
  const readBounded = async (response: Awaited<ReturnType<typeof fetch>>): Promise<Buffer> => {
    const length = response.headers.get('content-length');
    if (length && Number(length) > limit) { await response.body?.cancel(); throw tooLarge(); }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > limit) { await reader.cancel(); throw tooLarge(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    return Buffer.concat(chunks, total);
  };
  try {
    let body: string | FormData;
    const inputs = options.images ?? (options.image ? [options.image] : []);
    if (inputs.length) {
      body = new FormData();
      body.set('model', options.model); body.set('prompt', options.prompt); body.set('size', options.size);
      if (options.responseFormat && options.responseFormat !== 'auto') body.set('response_format', options.responseFormat);
      for (const image of inputs) body.append(inputs.length === 1 ? 'image' : 'image[]', new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), image.filename);
    } else body = JSON.stringify({ model: options.model, prompt: options.prompt, size: options.size, response_format: options.responseFormat });
    const response = await fetch(options.url, { dispatcher, signal, method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}`, ...(inputs.length ? {} : { 'Content-Type': 'application/json' }) }, body });
    if (!response.ok) {
      await response.body?.cancel();
      throw httpError(response.status, phase, response.headers.get('retry-after'));
    }
    const payload = JSON.parse((await readBounded(response)).toString('utf8')) as { data?: { b64_json?: string; url?: string }[]; usage?: unknown };
    if (options.onUsage) {
      try { await options.onUsage(payload.usage); }
      catch (error) { throw new ImageUsageError(error); }
    }
    const image = payload.data?.[0];
    let bytes: Buffer;
    if (image?.b64_json) bytes = Buffer.from(image.b64_json, 'base64');
    else if (image?.url) {
      phase = 'download';
      const download = await fetch(image.url, { dispatcher, signal });
      if (!download.ok) {
        await download.body?.cancel();
        throw httpError(download.status, phase, download.headers.get('retry-after'));
      }
      bytes = await readBounded(download);
    } else throw new ImageRequestError({ message: 'Image response has no image', code: 'IMAGE_EMPTY_RESPONSE', phase, retryable: true });
    if (!bytes.length) throw new ImageRequestError({ message: 'Empty image result', code: 'IMAGE_EMPTY_RESPONSE', phase, retryable: true });
    return { bytes, usage: payload.usage };
  } catch (error) {
    options.signal.throwIfAborted();
    if (error instanceof ImageUsageError) throw error.cause;
    if (error instanceof ImageRequestError) throw error;
    if (error instanceof SyntaxError) throw new ImageRequestError({ message: 'Invalid image response JSON', code: 'IMAGE_INVALID_RESPONSE', phase, retryable: true });
    throw transportError(error, phase, timeout.aborted);
  } finally { await dispatcher.destroy(); }
}

export type ImageAttemptResult<T> = { ok: true; value: T; attempts: number } | { ok: false; error: ImageFailure; attempts: number };
export async function retryImage<T>(operation: () => Promise<T>, options: {
  maxAttempts: number; signal: AbortSignal;
  onRetry?: (attempt: number, failure: ImageFailure, waitMs: number) => Promise<void>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<ImageAttemptResult<T>> {
  const limit = Math.max(1, Math.min(20, Math.floor(options.maxAttempts) || 1));
  for (let attempt = 1; attempt <= limit; attempt++) {
    options.signal.throwIfAborted();
    try { return { ok: true, value: await operation(), attempts: attempt }; }
    catch (error) {
      options.signal.throwIfAborted();
      // Programming, persistence and policy errors are not provider failures and must propagate.
      if (!(error instanceof ImageRequestError)) throw error;
      if (!error.failure.retryable || attempt === limit) return { ok: false, error: error.failure, attempts: attempt };
      const waitMs = Math.min(60_000, Math.max(error.failure.retryAfterMs ?? 0, 2000 * 2 ** (attempt - 1)));
      await options.onRetry?.(attempt, error.failure, waitMs);
      await (options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal })))(waitMs, options.signal);
    }
  }
  throw new Error('Unreachable image retry state');
}
