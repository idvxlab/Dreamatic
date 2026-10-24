import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Agent, Headers, request } from 'undici';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { projectFiles } from './project-files.js';

export interface ReaderNode { tag: string; text?: string; href?: string; src?: string; alt?: string; children?: ReaderNode[] }
export interface ReferenceArticle { title: string; url: string; byline?: string; excerpt?: string; nodes: ReaderNode[]; embeddingBlocked: boolean }
const MAX_BYTES = 2 * 1024 * 1024;
const denied = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) denied.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) denied.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !denied.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
}
function checkedUrl(value: string) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (isIP(host) && !publicAddress(host))) throw new Error('Only public HTTP or HTTPS reference pages can be read.');
  return url;
}
const allowed = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'strong', 'b', 'em', 'i', 'del', 'a', 'img', 'br', 'hr', 'div', 'span', 'figure', 'figcaption']);
const dropped = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'input', 'button', 'select', 'textarea', 'nav', 'header', 'footer', 'noscript']);
function contentUrl(value: string | null, base: string) {
  if (!value) return;
  try { return checkedUrl(new URL(value, base).href).href; } catch { return undefined; }
}
/** Parse inert HTML; return an allowlisted tree, never executable HTML or remote scripts. */
export function extractArticle(html: string, url: string, headers: { xFrameOptions?: string; csp?: string } = {}): ReferenceArticle {
  const { document } = parseHTML(html);
  Object.defineProperty(document, 'documentURI', { value: url, configurable: true });
  Object.defineProperty(document, 'baseURI', { value: url, configurable: true });
  const article = new Readability(document as unknown as Document, { charThreshold: 100, maxElemsToParse: 30000 }).parse();
  if (!article?.textContent?.trim() || !article.content) throw new Error('No readable article was found. The page may require JavaScript, sign-in, or access permission.');
  const content = parseHTML(`<html><body>${article.content}</body></html>`).document;
  let count = 0;
  function nodes(parent: Node, depth = 0): ReaderNode[] {
    if (depth > 100) throw new Error('This reference page is too large to read.');
    const result: ReaderNode[] = [];
    for (const child of Array.from(parent.childNodes)) {
      if (++count > 15000) throw new Error('This reference page is too large to read.');
      if (child.nodeType === 3) { if (child.textContent) result.push({ tag: 'text', text: child.textContent }); continue; }
      if (child.nodeType !== 1) continue;
      const element = child as Element;
      const tag = element.tagName.toLowerCase();
      if (dropped.has(tag) || element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') continue;
      const children = nodes(element, depth + 1);
      if (!allowed.has(tag)) { result.push(...children); continue; }
      if (tag === 'img') {
        const src = contentUrl(element.getAttribute('src') || element.getAttribute('data-src'), url);
        if (src) result.push({ tag, src, alt: element.getAttribute('alt') ?? '' });
      } else if (tag === 'a') {
        const href = contentUrl(element.getAttribute('href'), url);
        result.push({ tag: href ? 'a' : 'span', ...(href ? { href } : {}), children });
      } else result.push({ tag, children });
    }
    return result;
  }
  const xfo = headers.xFrameOptions?.toUpperCase().trim();
  const ancestors = headers.csp?.match(/(?:^|;)\s*frame-ancestors\s+([^;]+)/iu)?.[1]?.trim();
  return { title: article.title || new URL(url).hostname, url, ...(article.byline ? { byline: article.byline } : {}), ...(article.excerpt ? { excerpt: article.excerpt } : {}), nodes: nodes(content.body as unknown as Node), embeddingBlocked: xfo === 'DENY' || xfo === 'SAMEORIGIN' || ancestors === "'none'" || ancestors === "'self'" };
}

interface PageResponse { status: number; ok: boolean; headers: Pick<Headers, 'get'>; body: ReadableStream<Uint8Array> | null }
async function boundedBody(response: PageResponse) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('This reference page is too large to read.'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('The reference page returned no content.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > MAX_BYTES) throw new Error('This reference page is too large to read.'); chunks.push(value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const charset = response.headers.get('content-type')?.match(/charset\s*=\s*["']?([^;\s"']+)/iu)?.[1] ?? 'utf-8';
  try { return new TextDecoder(charset).decode(Buffer.concat(chunks)); } catch { return new TextDecoder().decode(Buffer.concat(chunks)); }
}
interface PageRequestOptions { dispatcher: Agent; redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> }
interface ReaderTransport {
  resolve: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request: (url: URL, options: PageRequestOptions) => Promise<PageResponse>;
}
// Read raw responses so both compressed and decoded bytes have explicit bounds.
// Unsupported encoding chains never enter a transport's automatic decoder.
export async function requestReferencePage(url: URL, options: PageRequestOptions): Promise<PageResponse> {
  const response = await request(url, { dispatcher: options.dispatcher, signal: options.signal, headers: { ...options.headers, 'Accept-Encoding': 'identity' } });
  // Early rejection destroys an unread body; consume its expected abort error.
  response.body.on('error', () => {});
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) if (value !== undefined && name !== 'set-cookie') headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  const encoding = headers.get('content-encoding')?.trim().toLowerCase() ?? '';
  if (!['', 'identity', 'gzip', 'br', 'deflate'].includes(encoding)) { response.body.destroy(); throw new Error('The source website uses an unsupported content encoding. Open the original page.'); }
  if (Number(headers.get('content-length')) > MAX_BYTES) { response.body.destroy(); throw new Error('This reference page is too large to read.'); }
  async function* limited() {
    let size = 0;
    try { for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES) throw new Error('This reference page is too large to read.'); yield chunk; } }
    finally { response.body.destroy(); }
  }
  const source = Readable.from(limited());
  source.on('error', () => {});
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : undefined;
  decoder?.on('error', () => {});
  const body = decoder ? source.compose(decoder) : source;
  body.on('error', () => {});
  if (decoder) headers.delete('content-length');
  return { status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, headers, body: Readable.toWeb(body) as ReadableStream<Uint8Array> };
}
const network: ReaderTransport = { resolve: hostname => lookup(hostname, { all: true }), request: requestReferencePage };
async function resolveHost(hostname: string, signal: AbortSignal, transport: ReaderTransport) {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([transport.resolve(hostname), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
export async function fetchArticle(address: string, transport: ReaderTransport = network): Promise<ReferenceArticle> {
  const signal = AbortSignal.timeout(15000);
  let url = checkedUrl(address);
  try {
    for (let redirect = 0; redirect <= 3; redirect++) {
      const hostname = url.hostname.replace(/^\[|\]$/gu, '');
      const addresses = await resolveHost(hostname, signal, transport);
      signal.throwIfAborted();
      if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Only public HTTP or HTTPS reference pages can be read.');
      // Pin the checked DNS results to this connection, including every redirect.
      const dnsLookup: LookupFunction = (_hostname, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0]!.address, addresses[0]!.family);
      const dispatcher = new Agent({ connect: { lookup: dnsLookup } });
      try {
        const response = await transport.request(url, { dispatcher, redirect: 'manual', signal, headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', 'User-Agent': 'Dreamatic-Reference-Reader/1.0' } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || redirect === 3) throw new Error('The reference page redirected too many times or has an invalid redirect.');
          url = checkedUrl(new URL(location, url).href); continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(response.status === 401 || response.status === 403 ? 'The source website denied access or requires sign-in.' : response.status === 429 ? 'The source website is rate limiting requests. Please try again later.' : `The source website returned HTTP ${response.status}.`);
        }
        const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(type ?? '')) { await response.body?.cancel(); throw new Error('This reference is not an HTML or text page. Open the original file.'); }
        const text = await boundedBody(response);
        if (type === 'text/plain') return { title: url.hostname, url: url.href, nodes: [{ tag: 'pre', children: [{ tag: 'text', text }] }], embeddingBlocked: false };
        return extractArticle(text, url.href, { ...(response.headers.get('x-frame-options') ? { xFrameOptions: response.headers.get('x-frame-options')! } : {}), ...(response.headers.get('content-security-policy') ? { csp: response.headers.get('content-security-policy')! } : {}) });
      } finally { await dispatcher.destroy(); }
    }
    throw new Error('The reference page redirected too many times or has an invalid redirect.');
  } catch (error) {
    if (signal.aborted) throw new Error('Reading the reference page timed out. Please try again or open the original.');
    if (error instanceof Error && (error.name === 'TypeError' || 'code' in error)) throw new Error('Could not connect to the source website. Please try again or open the original.');
    throw error;
  }
}
const cache = new Map<string, { at: number; article: ReferenceArticle }>();
const pending = new Map<string, Promise<ReferenceArticle>>();
export async function readProjectReference(workspace: string, runId: string, fileId: string, refresh = false) {
  const reference = (await projectFiles(workspace, runId)).find(file => file.id === fileId && file.category === 'references' && file.kind === 'web');
  if (!reference?.url) throw new Error('The selected reference is unavailable. Refresh the file list.');
  const url = checkedUrl(reference.url).href;
  const saved = cache.get(url);
  if (!refresh && saved && Date.now() - saved.at < 300000) return saved.article;
  const inflight = pending.get(url); if (inflight) return inflight;
  const request = fetchArticle(url).then(article => { cache.delete(url); cache.set(url, { at: Date.now(), article }); while (cache.size > 16) cache.delete(cache.keys().next().value!); return article; }).finally(() => pending.delete(url));
  pending.set(url, request); return request;
}
