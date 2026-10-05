export interface RetryNotice {
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  error: string;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (notice: RetryNotice) => void | Promise<void>;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export class RetryableHttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "RetryableHttpError";
  }
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof RetryableHttpError) return true;
  if (!(error instanceof Error)) return false;
  const message = `${error.name} ${error.message} ${String((error as Error & { cause?: unknown }).cause ?? "")}`.toLowerCase();
  return /connection error|fetch failed|terminated|timeout|timed out|econnreset|econnrefused|etimedout|eai_again|enotfound|socket|network/.test(message);
}

async function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delayMs);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("Aborted")); };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function withRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 1_000);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 8_000);
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try { return await operation(attempt); }
    catch (error) {
      options.signal?.throwIfAborted();
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error)) throw error;
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = options.random ? Math.floor(exponential * options.random() * 0.25) : 0;
      const delayMs = error instanceof RetryableHttpError && error.retryAfterMs !== undefined
        ? Math.max(exponential, error.retryAfterMs) + jitter
        : Math.min(maxDelayMs, exponential + jitter);
      await options.onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, error: error instanceof Error ? error.message : String(error) });
      await sleep(delayMs, options.signal);
    }
  }
  throw lastError;
}

export function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function isRetryableStatus(status: number): boolean {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}
