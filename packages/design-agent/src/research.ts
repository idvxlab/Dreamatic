import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { resolveInside, safeRunId } from "./paths.js";
import { RetryableHttpError, withRetry } from "./retry.js";

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const SERPER_SEARCH_URL = "https://google.serper.dev/search";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface WebSearchOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}

function safeUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Research URLs must use HTTP or HTTPS");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    throw new Error("Research URLs may not target local or private hosts");
  }
  return url;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function plainText(html: string): string {
  return decodeEntities(html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function describeNetworkError(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const code = "code" in current && typeof current.code === "string" ? ` (${current.code})` : "";
    const message = `${current.message}${code}`.trim();
    if (message && !messages.includes(message)) messages.push(message);
    current = "cause" in current ? current.cause : undefined;
  }
  return messages.join(": ") || String(error);
}

async function boundedFetch(
  url: URL,
  accept: string,
  maxBytes: number,
  options: { fetch?: FetchLike; init?: RequestInit; operation?: string } = {},
): Promise<{ response: Response; bytes: Buffer }> {
  const operation = options.operation ?? "Research fetch";
  try {
    return await withRetry(async () => {
      const headers = new Headers({ "User-Agent": "Dreamatic/0.1 design research", Accept: accept });
      new Headers(options.init?.headers).forEach((value, key) => headers.set(key, value));
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        ...options.init,
        redirect: "follow",
        headers,
        signal: AbortSignal.timeout(45_000),
      });
      if ([408, 409, 425, 429, 500, 502, 503, 504].includes(response.status)) {
        throw new RetryableHttpError(response.status, `${operation} failed (${response.status})`);
      }
      if (!response.ok) throw new Error(`${operation} failed (${response.status})`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new Error(`${operation} response exceeds ${Math.round(maxBytes / 1024 / 1024)} MB`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error(`${operation} response exceeds ${Math.round(maxBytes / 1024 / 1024)} MB`);
      return { response, bytes };
    }, { attempts: 3 });
  } catch (error) {
    throw new Error(`${operation} failed: ${describeNetworkError(error)}`, { cause: error });
  }
}

function searchConfiguration(env: NodeJS.ProcessEnv): { provider: "serper"; apiKey: string } | { provider: "duckduckgo"; fallbackReason?: string } {
  const provider = env.DREAMATIC_SEARCH_PROVIDER?.trim().toLowerCase();
  const profileKey = env.DREAMATIC_SEARCH_API_KEY?.trim();
  const legacySerperKey = env.SERPER_API_KEY?.trim();
  if (provider === "serper") {
    const apiKey = profileKey || legacySerperKey;
    return apiKey ? { provider: "serper", apiKey } : { provider: "duckduckgo", fallbackReason: "Serper is selected but no search API key is configured." };
  }
  if (!provider && legacySerperKey) return { provider: "serper", apiKey: legacySerperKey };
  return { provider: "duckduckgo", ...(provider && provider !== "duckduckgo" ? { fallbackReason: `Unsupported search provider '${provider}'.` } : {}) };
}

async function serperSearch(query: string, limit: number, apiKey: string, fetcher?: FetchLike) {
  const { bytes } = await boundedFetch(new URL(SERPER_SEARCH_URL), "application/json", MAX_PAGE_BYTES, {
    ...(fetcher ? { fetch: fetcher } : {}),
    operation: "Serper search",
    init: {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: limit }),
    },
  });
  let payload: { organic?: Array<{ title?: unknown; link?: unknown; snippet?: unknown; date?: unknown }> };
  try { payload = JSON.parse(bytes.toString("utf8")) as typeof payload; }
  catch (error) { throw new Error(`Serper search returned invalid JSON: ${describeNetworkError(error)}`); }
  const results: Array<{ title: string; url: string; snippet: string; date?: string }> = [];
  const seen = new Set<string>();
  for (const item of payload.organic ?? []) {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const url = typeof item.link === "string" ? item.link.trim() : "";
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    const snippet = typeof item.snippet === "string" ? item.snippet.trim() : "";
    const date = typeof item.date === "string" ? item.date.trim() : "";
    results.push({ title, url, snippet, ...(date ? { date } : {}) });
    if (results.length >= limit) break;
  }
  return { provider: "serper" as const, query, count: results.length, results };
}

export async function webSearch(query: string, limit = 8, options: WebSearchOptions = {}) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new Error("Search query must not be empty");
  const cappedLimit = Math.max(1, Math.min(12, limit));
  const configuration = searchConfiguration(options.env ?? process.env);
  if (configuration.provider === "serper") return serperSearch(normalizedQuery, cappedLimit, configuration.apiKey, options.fetch);
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", normalizedQuery);
  const { bytes } = await boundedFetch(url, "text/html", MAX_PAGE_BYTES, { ...(options.fetch ? { fetch: options.fetch } : {}), operation: "DuckDuckGo search" });
  const html = bytes.toString("utf8");
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const blocks = html.split(/class="result\s+results_links[^>]*"/i).slice(1);
  for (const block of blocks) {
    const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const rawUrl = decodeEntities(link[1]!);
    const redirected = new URL(rawUrl, url);
    const destination = redirected.searchParams.get("uddg") ?? redirected.href;
    const snippet = plainText(block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a?>/i)?.[1] ?? "");
    results.push({ title: plainText(link[2]!), url: destination, snippet });
    if (results.length >= cappedLimit) break;
  }
  return { provider: "duckduckgo" as const, query: normalizedQuery, count: results.length, results, ...(configuration.fallbackReason ? { fallbackReason: configuration.fallbackReason } : {}) };
}

function sourceId(url: URL): string {
  const stem = `${url.hostname}-${url.pathname}`.replace(/[^a-z0-9\u4e00-\u9fff-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "source";
  return safeRunId(`${stem}-${createHash("sha256").update(url.href).digest("hex").slice(0, 10)}`);
}

export async function researchFetch(workspaceDir: string, params: { runId: string; url: string; id?: string; cacheText?: boolean }) {
  const runId = safeRunId(params.runId);
  const url = safeUrl(params.url);
  const { response, bytes } = await boundedFetch(url, "text/html,text/plain,application/json", MAX_PAGE_BYTES);
  const source = bytes.toString("utf8");
  const contentType = response.headers.get("content-type") ?? "";
  const text = /html/i.test(contentType) ? plainText(source) : source.replace(/\s+/g, " ").trim();
  const title = /html/i.test(contentType) ? plainText(source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? url.hostname) : url.hostname;
  let cachedPath: string | undefined;
  if (params.cacheText) {
    const id = params.id?.trim() ? safeRunId(params.id) : sourceId(url);
    const path = resolveInside(workspaceDir, join("runs", runId, "research", "sources", `${id}.txt`));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${title}\n${response.url}\n\n${text}\n`, "utf8");
    cachedPath = relative(workspaceDir, path).replaceAll("\\", "/");
  }
  return { ok: true, url: response.url, title, text: text.slice(0, 24_000), contentType, ...(cachedPath ? { cachedPath } : {}) };
}

function absoluteAssetUrl(raw: string, pageUrl: URL): string | undefined {
  try {
    const value = decodeEntities(raw).trim();
    if (!value || value.startsWith("data:")) return undefined;
    return safeUrl(new URL(value, pageUrl).href).href;
  } catch { return undefined; }
}

export async function discoverResearchAssets(page: string, limit = 12) {
  const pageUrl = safeUrl(page);
  const { bytes } = await boundedFetch(pageUrl, "text/html", MAX_PAGE_BYTES);
  const html = bytes.toString("utf8");
  const candidates: Array<{ url: string; source: string; alt?: string }> = [];
  const seen = new Set<string>();
  const add = (raw: string, source: string, alt?: string) => {
    const url = absoluteAssetUrl(raw, pageUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, source, ...(alt ? { alt: plainText(alt) } : {}) });
  };
  for (const match of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>/gi)) add(match[1]!, "metadata");
  for (const match of html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    const tag = match[0];
    add(match[1]!, "image", tag.match(/alt=["']([^"']*)["']/i)?.[1]);
    if (candidates.length >= Math.max(1, Math.min(24, limit))) break;
  }
  return { pageUrl: pageUrl.href, count: candidates.slice(0, limit).length, candidates: candidates.slice(0, limit) };
}

function imageType(contentType: string, bytes: Buffer, url: URL): { mimeType: string; extension: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mimeType: "image/png", extension: ".png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { mimeType: "image/jpeg", extension: ".jpg" };
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { mimeType: "image/webp", extension: ".webp" };
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return { mimeType: "image/gif", extension: ".gif" };
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const extension = extname(url.pathname).toLowerCase();
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type) && [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) return { mimeType: type, extension: extension === ".jpeg" ? ".jpg" : extension };
  throw new Error("Reference asset is not a supported PNG, JPEG, WEBP, or GIF image");
}

interface ResearchAsset {
  id: string;
  file: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  source_url: string;
  source_page_url?: string;
  kind: string;
  description: string;
  do_not_replace: boolean;
  allowed_for_edit: boolean;
  fetched_at: string;
}

export async function fetchResearchAsset(workspaceDir: string, params: { runId: string; id: string; url: string; kind?: string; description?: string; sourcePageUrl?: string; doNotReplace?: boolean; allowedForEdit?: boolean }) {
  const runId = safeRunId(params.runId);
  const id = safeRunId(params.id);
  const url = safeUrl(params.url);
  const { response, bytes } = await boundedFetch(url, "image/*", MAX_ASSET_BYTES);
  const type = imageType(response.headers.get("content-type") ?? "", bytes, url);
  const assetDir = resolveInside(workspaceDir, join("runs", runId, "research", "assets"));
  await mkdir(assetDir, { recursive: true });
  const fileName = `${id}${type.extension}`;
  const path = join(assetDir, fileName);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifestPath = join(assetDir, "manifest.json");
  const manifest = await readFile(manifestPath, "utf8").then((value) => JSON.parse(value) as { assets?: ResearchAsset[] }).catch(() => ({ assets: [] as ResearchAsset[] }));
  const duplicate = (manifest.assets ?? []).find((asset) => asset.sha256 === sha256 && asset.id !== id);
  if (duplicate) throw new Error(`Reference duplicates existing asset ${duplicate.id}`);
  const asset: ResearchAsset = {
    id,
    file: fileName,
    mime_type: type.mimeType,
    bytes: bytes.length,
    sha256,
    source_url: response.url,
    ...(params.sourcePageUrl ? { source_page_url: safeUrl(params.sourcePageUrl).href } : {}),
    kind: params.kind?.trim() || "reference",
    description: params.description?.trim() || basename(url.pathname) || id,
    do_not_replace: params.doNotReplace ?? false,
    allowed_for_edit: params.allowedForEdit ?? true,
    fetched_at: new Date().toISOString(),
  };
  await writeFile(path, bytes);
  await writeFile(`${path}.json`, JSON.stringify(asset, null, 2), "utf8");
  const assets = [...(manifest.assets ?? []).filter((item) => item.id !== id), asset];
  await writeFile(manifestPath, JSON.stringify({ runId, updatedAt: new Date().toISOString(), assets }, null, 2), "utf8");
  return { ok: true, asset, path: relative(workspaceDir, path).replaceAll("\\", "/"), manifestPath: relative(workspaceDir, manifestPath).replaceAll("\\", "/") };
}

export async function validateResearchAssets(workspaceDir: string, params: { runId: string; minUsableAssets?: number; requireLogo?: boolean }) {
  const runId = safeRunId(params.runId);
  const assetDir = resolveInside(workspaceDir, join("runs", runId, "research", "assets"));
  const manifestPath = join(assetDir, "manifest.json");
  const manifest = await readFile(manifestPath, "utf8").then((value) => JSON.parse(value) as { assets?: ResearchAsset[] }).catch(() => ({ assets: [] as ResearchAsset[] }));
  const issues: string[] = [];
  const usable: ResearchAsset[] = [];
  const hashes = new Set<string>();
  for (const asset of manifest.assets ?? []) {
    const path = resolveInside(assetDir, asset.file);
    const bytes = await readFile(path).catch(() => null);
    if (!bytes) { issues.push(`${asset.id}: file missing`); continue; }
    const info = await stat(path);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== asset.sha256) { issues.push(`${asset.id}: sha256 mismatch`); continue; }
    if (hashes.has(hash)) { issues.push(`${asset.id}: duplicate content`); continue; }
    hashes.add(hash);
    if (info.size < 8_000) { issues.push(`${asset.id}: image is unusually small`); continue; }
    usable.push(asset);
  }
  const minimum = Math.max(0, params.minUsableAssets ?? 1);
  if (usable.length < minimum) issues.push(`Expected ${minimum} usable reference assets, found ${usable.length}`);
  if (params.requireLogo && !usable.some((asset) => /logo|mark|wordmark/i.test(`${asset.kind} ${asset.id}`))) issues.push("A protected logo or mark reference is required");
  const validation = {
    runId,
    checkedAt: new Date().toISOString(),
    ready: issues.length === 0,
    summary: { total_assets: manifest.assets?.length ?? 0, usable_assets: usable.length, flagged_assets: issues.length, protected_count: usable.filter((asset) => asset.do_not_replace).length },
    usableAssetIds: usable.map((asset) => asset.id),
    issues,
  };
  const validationPath = join(assetDir, "validation.json");
  await mkdir(dirname(validationPath), { recursive: true });
  await writeFile(validationPath, JSON.stringify(validation, null, 2), "utf8");
  return { ok: true, validation, path: relative(workspaceDir, validationPath).replaceAll("\\", "/") };
}
