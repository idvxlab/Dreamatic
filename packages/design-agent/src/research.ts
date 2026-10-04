import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { resolveInside, safeRunId } from "./paths.js";
import { RetryableHttpError, withRetry } from "./retry.js";

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
const SERPER_SEARCH_URL = "https://google.serper.dev/search";
const assetWrites = new Map<string, Promise<void>>();

async function serializeAssetWrite<Result>(key: string, operation: () => Promise<Result>): Promise<Result> {
  const previous = assetWrites.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  assetWrites.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (assetWrites.get(key) === current) assetWrites.delete(key);
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface WebSearchOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}

function normalizedUrlInput(value: string): string {
  const trimmed = value.trim();
  const markdown = trimmed.match(/^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/iu);
  if (markdown) return markdown[1]!;
  const angleBracket = trimmed.match(/^<(https?:\/\/[^\s>]+)>$/iu);
  return angleBracket?.[1] ?? trimmed;
}

function safeUrl(value: string): URL {
  const url = new URL(normalizedUrlInput(value));
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

function htmlAttribute(tag: string, name: string): string {
  return decodeEntities(tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find((value) => value !== undefined) ?? "");
}

function researchContent(html: string): { html: string; scoped: boolean } {
  const source = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const stack: Array<{ tag: string; start: number; excluded: boolean; content: boolean }> = [];
  const excluded: Array<{ start: number; end: number }> = [];
  const scopes: Array<{ start: number; end: number }> = [];
  for (const match of source.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
    const tag = match[1]!.toLowerCase();
    const start = match.index!;
    if (match[0].startsWith("</")) {
      const index = stack.findLastIndex((frame) => frame.tag === tag);
      if (index === -1) continue;
      const frames = stack.splice(index);
      for (const frame of frames) {
        const range = { start: frame.start, end: start + match[0].length };
        if (frame.excluded) excluded.push(range);
        else if (frame.content) scopes.push(range);
      }
      continue;
    }
    if (/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/u.test(tag) || /\/\s*>$/u.test(match[0])) continue;
    const label = `${htmlAttribute(match[0], "class")} ${htmlAttribute(match[0], "id")}`.toLowerCase();
    const role = htmlAttribute(match[0], "role").toLowerCase();
    const content = /^(?:article|main)$/u.test(tag) || /(?:article|entry|post|news|story)[_-](?:body|content)|content[_-]body|rich[_-]text/u.test(label) || role === "main";
    const chrome = /^(?:nav|footer|aside)$/u.test(tag) || /^(?:navigation|banner|contentinfo)$/u.test(role)
      || (tag === "header" && !stack.some((frame) => frame.content))
      || /(?:^|\s)(?:site[_-]header|site[_-]footer|navbar|navigation|breadcrumb|related[_-](?:posts|articles)|author[_-]profile|profile[_-]card)(?:\s|$)/u.test(label);
    stack.push({ tag, start, content, excluded: chrome || stack.some((frame) => frame.excluded) });
  }
  for (const frame of stack) if (frame.excluded) excluded.push({ start: frame.start, end: source.length });
  const strip = (start: number, end: number) => {
    let cursor = start;
    const chunks: string[] = [];
    for (const range of excluded.filter((entry) => entry.end > start && entry.start < end).sort((first, second) => first.start - second.start)) {
      if (range.start > cursor) chunks.push(source.slice(cursor, range.start));
      cursor = Math.max(cursor, Math.min(end, range.end));
    }
    chunks.push(source.slice(cursor, end));
    return chunks.join(" ");
  };
  const outerScopes = scopes.filter((scope) => !scopes.some((other) => other !== scope && other.start <= scope.start && other.end >= scope.end));
  return { html: outerScopes.length ? outerScopes.sort((first, second) => first.start - second.start).map((scope) => strip(scope.start, scope.end)).join("\n") : strip(0, source.length), scoped: outerScopes.length > 0 };
}

function focusedExcerpt(source: string, terms: string[], limit: number): { text: string; matchedTerms: string[]; method: string } {
  const lower = source.toLowerCase();
  const normalized = [...new Set(terms.map((term) => term.trim().toLowerCase()).filter(Boolean))];
  const windows: Array<{ start: number; end: number; score: number }> = [];
  const matchedTerms: string[] = [];
  for (const term of normalized) {
    let position = lower.indexOf(term);
    if (position !== -1) matchedTerms.push(term);
    let occurrences = 0;
    while (position !== -1 && occurrences < 64) {
      const start = Math.max(0, position - 160);
      const end = Math.min(source.length, start + Math.min(700, limit));
      const passage = lower.slice(start, end);
      windows.push({ start, end, score: normalized.filter((entry) => passage.includes(entry)).length });
      position = lower.indexOf(term, position + term.length);
      occurrences += 1;
    }
  }
  if (!windows.length || source.length <= limit) return { text: source.slice(0, limit), matchedTerms, method: windows.length ? "full_content" : "opening_excerpt" };
  const selected: typeof windows = [];
  let remaining = limit;
  for (const window of windows.sort((first, second) => second.score - first.score || first.start - second.start)) {
    if (selected.some((entry) => window.start < entry.end && window.end > entry.start)) continue;
    const budget = remaining - (selected.length ? 5 : 0);
    if (budget <= 0) break;
    const end = Math.min(window.end, window.start + budget);
    selected.push({ ...window, end });
    remaining -= end - window.start + (selected.length > 1 ? 5 : 0);
  }
  return { text: selected.sort((first, second) => first.start - second.start).map((entry) => source.slice(entry.start, entry.end)).join("\n[…]\n"), matchedTerms, method: "topic_passages" };
}

function rejectVerificationPage(title: string, text: string): void {
  const challengeTitle = /^(?:checking your browser|just a moment|attention required|access denied|robot verification|making sure you(?:'|’)re not a bot)/iu.test(title);
  const challengeText = text.length < 4_000 && /(?:verify that you(?:'|’)re not a robot|making sure you(?:'|’)re not a bot|checking your browser before accessing|javascript is disabled.{0,180}verify|enable javascript and cookies to continue)/iu.test(text);
  if (challengeTitle || challengeText) {
    throw new Error("Research fetch returned an access-verification page, not source content. Do not cite it as read evidence or retry unchanged; use an accessible publisher page, author repository or alternate source for the same research question.");
  }
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
      const headers = new Headers({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Dreamatic/0.1",
        Accept: accept,
        "Accept-Language": "en-US,en;q=0.9",
      });
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
      if (!response.ok) throw new Error(`${operation} returned HTTP ${response.status}`);
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

export async function researchFetch(
  workspaceDir: string,
  params: { runId: string; url: string; id?: string; cacheText?: boolean; researchTerms?: string[] },
  options: { fetch?: FetchLike; maxTextChars?: number; onHtml?: (html: string) => void } = {},
) {
  const runId = safeRunId(params.runId);
  const url = safeUrl(params.url);
  const { response, bytes } = await boundedFetch(url, "text/html,text/plain,application/json", MAX_PAGE_BYTES, options);
  const source = bytes.toString("utf8");
  const contentType = response.headers.get("content-type") ?? "";
  if (/application\/pdf/iu.test(contentType) || bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    throw new Error("Research fetch cannot extract PDF text or figures. Use the paper's readable HTML article, publisher abstract or author repository; do not treat binary PDF bytes as research evidence.");
  }
  const text = /html/i.test(contentType) ? plainText(source) : source.replace(/\s+/g, " ").trim();
  const title = /html/i.test(contentType) ? plainText(source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? url.hostname) : url.hostname;
  rejectVerificationPage(title, text);
  const content = /html/i.test(contentType) ? researchContent(source) : undefined;
  options.onHtml?.(source);
  let cachedPath: string | undefined;
  if (params.cacheText) {
    const id = params.id?.trim() ? safeRunId(params.id) : sourceId(url);
    const path = resolveInside(workspaceDir, join("runs", runId, "research", "sources", `${id}.txt`));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${title}\n${response.url}\n\n${text}\n`, "utf8");
    cachedPath = relative(workspaceDir, path).replaceAll("\\", "/");
  }
  const maxTextChars = Math.max(1, Math.min(24_000, options.maxTextChars ?? 24_000));
  const readableText = content ? plainText(content.html) : text;
  const excerpt = focusedExcerpt(readableText, params.researchTerms ?? [], maxTextChars);
  return { ok: true, url: response.url || url.href, title, text: excerpt.text, textChars: text.length, truncated: readableText.length > maxTextChars, extractionMethod: excerpt.method, matchedTerms: excerpt.matchedTerms, contentScope: content?.scoped ? "article" : "page", contentType, ...(cachedPath ? { cachedPath } : {}) };
}

function absoluteAssetUrl(raw: string, pageUrl: URL): string | undefined {
  try {
    const value = decodeEntities(raw).trim();
    if (!value || value.startsWith("data:")) return undefined;
    return safeUrl(new URL(value, pageUrl).href).href;
  } catch { return undefined; }
}

export async function discoverResearchAssets(page: string, limit = Number.MAX_SAFE_INTEGER, options: {
  fetch?: FetchLike;
  includeIdentityAssets?: boolean;
  includeIconAssets?: boolean;
  focusTerms?: string[];
  html?: string;
  onHtml?: (html: string) => void;
} = {}) {
  const pageUrl = safeUrl(page);
  const html = options.html ?? (await boundedFetch(pageUrl, "text/html", MAX_PAGE_BYTES, options.fetch ? { fetch: options.fetch } : {})).bytes.toString("utf8");
  const content = researchContent(html);
  const contentText = plainText(content.html).toLowerCase();
  rejectVerificationPage(plainText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""), plainText(html));
  options.onHtml?.(html);
  const candidates: Array<{ url: string; source: string; alt?: string; description?: string; caption?: string; figureId?: string; matched_terms: string[]; relevance_basis: string; relevance_status: "likely" | "uncertain"; selection_score: number; visual_review_status: "unreviewed" }> = [];
  const excluded: Array<{ url: string; reason: string }> = [];
  const seen = new Set<string>();
  const terms = [...new Set((options.focusTerms ?? []).map((term) => term.trim().toLowerCase()).filter(Boolean))];
  const attribute = htmlAttribute;
  const descriptions = new Map<string, string>();
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid\s*=\s*(?:"[^"]*"|'[^']*')[^>]*)>([^<]*(?:<(?!\/\1\b)[\s\S]*?)?)<\/\1\s*>/gi)) {
    const id = attribute(match[2]!, "id");
    if (id) descriptions.set(id, plainText(match[3]!).slice(0, 2_000));
  }
  const normalizedLabel = (value: string) => {
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch {}
    return decoded.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").toLowerCase();
  };
  const add = (raw: string, source: string, tag: string, context: { caption?: string; description?: string; figureId?: string; highResolution?: boolean } = {}) => {
    const url = absoluteAssetUrl(raw, pageUrl);
    if (!url) return;
    seen.add(url);
    if (source === "page_chrome") {
      if (candidates.some((candidate) => candidate.url === url && candidate.source !== "metadata")) return;
      if (!excluded.some((entry) => entry.url === url)) excluded.push({ url, reason: "outside_article_or_page_chrome" });
      const existingIndex = candidates.findIndex((candidate) => candidate.url === url);
      if (existingIndex !== -1) candidates.splice(existingIndex, 1);
      return;
    }
    const alt = plainText(attribute(tag, "alt"));
    const description = plainText([
      context.description,
      attribute(tag, "aria-label"), attribute(tag, "data-description"),
      attribute(tag, "data-caption"), attribute(tag, "description"),
      ...attribute(tag, "aria-describedby").split(/\s+/).map((id) => descriptions.get(id) ?? ""),
    ].filter(Boolean).join(" ")).slice(0, 2_000);
    const imageUrl = new URL(url);
    const label = normalizedLabel(`${imageUrl.pathname} ${imageUrl.search} ${alt} ${description} ${context.caption ?? ""} ${attribute(tag, "title")} ${attribute(tag, "class")} ${attribute(tag, "id")}`);
    const promotion = /(?:^|[\s/_.-])(?:advert|advertisement|newsletter|ad-banner)(?:[\s/_.-]|$)|订阅横幅/iu.test(label);
    const promotionRequested = terms.some((term) => /advert|newsletter|广告|电子报|订阅横幅/iu.test(term));
    const portraitRequested = terms.some((term) => /portrait|avatar|headshot|profile image|肖像|头像/iu.test(term));
    const profile = /(?:^|[\s/_.-])(?:avatar|headshot|profile|none[_-]img|no[_-]image|placeholder)(?:[\s/_.-]|$)|프로필이미지|头像|无图片|暂无图片/iu.test(label);
    const utility = /(?:^|[\s/_.?=&-])(?:qrcode|qr|wechat|weixin|wx|print|printer|printing|favicon|sprite|spacer|tracking|pixel|loading)[0-9]*(?:[\s/_.?=&-]|$)|(?:^|[\s/_.-])(?:share|social)[\s_-]+(?:icons?|buttons?|controls?)[0-9]*(?:[\s/_.-]|$)|二维码|打印按钮|打印图标|分享图标|社交媒体图标/iu.test(label) || (promotion && !promotionRequested) || (profile && !portraitRequested);
    const icon = /(?:^|[\s/_.?=&-])(?:icons?|pictograms?)[0-9]*(?:[\s/_.?=&-]|$)|图标/iu.test(label);
    const identity = /(?:^|[\s/_.?=&-])(?:logos?|logotypes?|wordmarks?|brandmarks?)[0-9]*(?:[\s/_.?=&-]|$)|(?:header|footer|site|brand|company|publisher|nav|website)[_-]?(?:logo|logotype)|网站标志|网站标识|品牌标识|商标/iu.test(label);
    const width = Number(attribute(tag, "width"));
    const height = Number(attribute(tag, "height"));
    const tiny = !context.highResolution && width > 0 && height > 0 && width <= 96 && height <= 96;
    if (utility || (icon && !options.includeIconAssets) || (identity && !options.includeIdentityAssets) || (tiny && !(identity && options.includeIdentityAssets) && !(icon && options.includeIconAssets))) {
      const existingIndex = candidates.findIndex((candidate) => candidate.url === url);
      if (existingIndex !== -1) candidates.splice(existingIndex, 1);
      if (!excluded.some((entry) => entry.url === url)) excluded.push({ url, reason: utility ? "page_utility" : identity && !options.includeIdentityAssets ? "identity_asset_not_requested" : icon && !options.includeIconAssets ? "icon_asset_not_requested" : "small_page_decoration" });
      return;
    }
    if (excluded.some((entry) => entry.url === url && entry.reason !== "task_relevance_not_established")) return;
    const matchedTerms = terms.filter((term) => label.includes(normalizedLabel(term)));
    const articleMatches = terms.some((term) => normalizedLabel(contentText).includes(normalizedLabel(term)));
    const contextualFigure = source === "figure" && articleMatches;
    const contextualImage = source === "image" && content.scoped && articleMatches;
    if (terms.length && !matchedTerms.length && !contextualFigure && !contextualImage && !(identity && options.includeIdentityAssets) && !(icon && options.includeIconAssets)) {
      const existingIndex = candidates.findIndex((candidate) => candidate.url === url);
      if (existingIndex !== -1) candidates.splice(existingIndex, 1);
      if (!excluded.some((entry) => entry.url === url)) excluded.push({ url, reason: "task_relevance_not_established" });
      return;
    }
    const tentativeExclusion = excluded.findIndex((entry) => entry.url === url && entry.reason === "task_relevance_not_established");
    if (tentativeExclusion !== -1) excluded.splice(tentativeExclusion, 1);
    const relevanceBasis = matchedTerms.length ? "image_metadata" : contextualFigure ? "article_figure_context" : contextualImage ? "article_image_context" : "unspecified_task";
    const selectionScore = matchedTerms.length * 10
      + (alt || description ? 2 : 0) + (source === "metadata" ? 1 : 0) + (context.caption ? 3 : 0);
    const existing = candidates.find((candidate) => candidate.url === url);
    if (existing) {
      existing.selection_score = Math.max(existing.selection_score, selectionScore);
      if (alt && (!existing.alt || alt.length > existing.alt.length)) existing.alt = alt;
      if (context.caption) existing.caption = context.caption;
      if (context.figureId) existing.figureId = context.figureId;
      if (description && (!existing.description || description.length > existing.description.length)) existing.description = description;
      existing.matched_terms = [...new Set([...existing.matched_terms, ...matchedTerms])];
      if (matchedTerms.length) existing.relevance_status = "likely";
      if (matchedTerms.length) existing.relevance_basis = relevanceBasis;
      if (source === "figure" || (source === "image" && existing.source === "metadata")) existing.source = source;
      return;
    }
    candidates.push({ url, source, ...(alt ? { alt } : {}), ...(description ? { description } : {}), ...(context.caption ? { caption: context.caption } : {}), ...(context.figureId ? { figureId: context.figureId } : {}), matched_terms: matchedTerms, relevance_basis: relevanceBasis, relevance_status: matchedTerms.length || identity || icon ? "likely" : "uncertain", selection_score: selectionScore, visual_review_status: "unreviewed" });
  };
  const processedTags = new Set<string>();
  const largestSrcset = (value: string) => value.split(",").map((entry) => {
    const parts = entry.trim().split(/\s+/);
    return { url: parts[0] ?? "", size: Number.parseFloat(parts[1] ?? "1") || 1 };
  }).filter((entry) => absoluteAssetUrl(entry.url, pageUrl)).sort((first, second) => second.size - first.size)[0]?.url;
  const collectImages = (block: string, source: string, context: { caption?: string; figureId?: string } = {}) => {
    const pictures = [...block.matchAll(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi)];
    const links = [...block.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)];
    for (const match of block.matchAll(/<img\b[^>]*>/gi)) {
      if (seen.size >= 256) break;
      const tag = match[0];
      if (processedTags.has(tag)) continue;
      processedTags.add(tag);
      const picture = pictures.find((entry) => entry[0].includes(tag))?.[0];
      const pictureSets = picture ? [...picture.matchAll(/<source\b[^>]*>/gi)].map((entry) => attribute(entry[0], "srcset") || attribute(entry[0], "data-srcset")).filter(Boolean) : [];
      const responsive = largestSrcset(attribute(tag, "srcset") || attribute(tag, "data-srcset") || pictureSets[0] || "");
      const linked = links.find((entry) => entry[0].includes(tag))?.[0];
      const href = linked ? attribute(linked.match(/^<a\b[^>]*>/i)?.[0] ?? "", "href") : "";
      const fullImage = /\.(?:png|jpe?g|webp|gif)(?:[?#]|$)/iu.test(href) ? href : undefined;
      add(fullImage || responsive || attribute(tag, "data-src") || attribute(tag, "data-original") || attribute(tag, "src"), source, tag, { ...context, highResolution: Boolean(fullImage || responsive) });
      if (seen.size >= 256) break;
    }
  };
  const metadataTags = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
  for (const [index, tag] of metadataTags.entries()) {
    const property = attribute(tag, "property") || attribute(tag, "name");
    if (!/^(?:og:image|twitter:image)$/i.test(property)) continue;
    const following = metadataTags.slice(index + 1);
    const nextImage = following.findIndex((entry) => /^(?:og:image|twitter:image)$/i.test(attribute(entry, "property") || attribute(entry, "name")));
    const description = following.slice(0, nextImage === -1 ? undefined : nextImage)
      .filter((entry) => (attribute(entry, "property") || attribute(entry, "name")).toLowerCase() === `${property.toLowerCase()}:alt`)
      .map((entry) => attribute(entry, "content")).join(" ");
    add(attribute(tag, "content"), "metadata", tag, { description });
  }
  for (const match of content.html.matchAll(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi)) {
    const figure = match[0];
    const caption = plainText(figure.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1] ?? "").slice(0, 2_000);
    const figureId = attribute(figure.match(/^<figure\b[^>]*>/i)?.[0] ?? "", "id");
    collectImages(figure, "figure", { ...(caption ? { caption } : {}), ...(figureId ? { figureId } : {}) });
    if (seen.size >= 256) break;
  }
  collectImages(content.html, "image");
  if (options.includeIdentityAssets || options.includeIconAssets) {
    for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
      const label = normalizedLabel(match[0]);
      if ((options.includeIdentityAssets && /logo|wordmark|brandmark|标志|标识/u.test(label)) || (options.includeIconAssets && /\bicons?\d*\b|图标/u.test(label))) collectImages(match[0], "requested_asset");
    }
  }
  if (!options.includeIdentityAssets && !options.includeIconAssets) {
    for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
      const tag = match[0];
      if (!content.html.includes(tag)) add(attribute(tag, "data-src") || attribute(tag, "data-original") || attribute(tag, "src"), "page_chrome", tag);
    }
  }
  const selected = candidates.sort((first, second) => second.selection_score - first.selection_score).slice(0, Math.max(1, Math.floor(limit)));
  return { pageUrl: pageUrl.href, contentScope: content.scoped ? "article" : "page", count: selected.length, candidates: selected, excluded: excluded.slice(0, 24), instruction: "Candidates are not visually verified. Keyword matches prioritize likely references; article-context candidates without lexical matches remain uncertain, not rejected merely for different captions or terminology. Select for coverage, not padding. Designer judges relevance before adoption." };
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
  visual_review_status?: "unreviewed";
  source_context?: string;
  relevance_basis?: string;
  relevance_status?: "likely" | "uncertain";
  matched_terms?: string[];
  fetched_at: string;
}

export async function fetchResearchAsset(workspaceDir: string, params: { runId: string; id: string; url: string; kind?: string; description?: string; sourcePageUrl?: string; sourceContext?: string; relevanceBasis?: string; relevanceStatus?: "likely" | "uncertain"; matchedTerms?: string[]; doNotReplace?: boolean; allowedForEdit?: boolean }) {
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
  return serializeAssetWrite(manifestPath, async () => {
  const manifest = await readFile(manifestPath, "utf8").then((value) => JSON.parse(value) as { assets?: ResearchAsset[] }).catch(() => ({ assets: [] as ResearchAsset[] }));
  const duplicate = (manifest.assets ?? []).find((asset) => asset.sha256 === sha256 && asset.id !== id);
  if (duplicate) throw new Error(`Reference duplicates existing asset ${duplicate.id}`);
  const asset: ResearchAsset = {
    id,
    file: fileName,
    mime_type: type.mimeType,
    bytes: bytes.length,
    sha256,
    source_url: response.url || url.href,
    ...(params.sourcePageUrl ? { source_page_url: safeUrl(params.sourcePageUrl).href } : {}),
    kind: params.kind?.trim() || "reference",
    description: params.description?.trim() || basename(url.pathname) || id,
    ...(params.sourceContext ? { source_context: params.sourceContext } : {}),
    ...(params.relevanceBasis ? { relevance_basis: params.relevanceBasis } : {}),
    ...(params.relevanceStatus ? { relevance_status: params.relevanceStatus } : {}),
    ...(params.matchedTerms ? { matched_terms: params.matchedTerms } : {}),
    do_not_replace: params.doNotReplace ?? false,
    allowed_for_edit: params.allowedForEdit ?? true,
    visual_review_status: "unreviewed",
    fetched_at: new Date().toISOString(),
  };
  await writeFile(path, bytes);
  await writeFile(`${path}.json`, JSON.stringify(asset, null, 2), "utf8");
  const assets = [...(manifest.assets ?? []).filter((item) => item.id !== id), asset];
  await writeFile(manifestPath, JSON.stringify({ runId, updatedAt: new Date().toISOString(), assets }, null, 2), "utf8");
  return { ok: true, asset, path: relative(workspaceDir, path).replaceAll("\\", "/"), manifestPath: relative(workspaceDir, manifestPath).replaceAll("\\", "/") };
  });
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
