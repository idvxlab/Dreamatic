import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadToolDefinition, type ToolDefinition, type ReadToolInput } from '@earendil-works/pi-coding-agent';
import { physicalRunFile } from '@dreamatic/project-data';
import { Type } from 'typebox';

export interface ShowcaseImage { id: string; introduction: string; size: string; prompt: string }
export interface GeneratedShowcaseImage { path: string; digest: string }
export interface ShowcaseWork { id: string; role: string; section: string; purpose: string }
export interface ShowcaseDirection { heroId: string; works: ShowcaseWork[]; markdown: string }

/** Keep Pi's text reading/pagination, without sending generated image blocks to Builder. */
export function createBuilderTextReadTool(root: string): ToolDefinition {
  const native = createReadToolDefinition(root);
  return { name: native.name, label: native.label, parameters: native.parameters, description: 'Read textual design documents, prompts, skills, metadata or an existing HTML page. Do not read images; use their Introduction, Prompt and Size for art direction.',
    async execute(callId, params, signal, onUpdate, context) {
      const input = params as ReadToolInput;
      if (!['.md', '.txt', '.html', '.htm', '.css', '.json', '.yaml', '.yml', '.csv', '.xml'].includes(extname(input.path).toLowerCase())) throw new Error('Builder reads text documents only. Use design.md and image descriptions instead of reading images.');
      const result = await native.execute(callId, input, signal, onUpdate, context);
      if (result.content.some(block => block.type === 'image')) throw new Error('Builder uses textual image descriptions, not image blocks.');
      return result;
    }
  };
}

export const showcaseImageSource = (id: string): string => `dreamatic-image:${id}`;
export interface ImageReferenceRepair { id: string; from: string; to: string }

export function validateShowcaseDirection(value: unknown, images: Pick<ShowcaseImage, 'id'>[], generated: Record<string, GeneratedShowcaseImage>): ShowcaseDirection {
  const direction = value as Partial<ShowcaseDirection> | undefined;
  if (!direction || typeof direction.heroId !== 'string' || !Array.isArray(direction.works) || typeof direction.markdown !== 'string' || !direction.markdown.trim()) throw new Error('Provide a project-specific exhibition direction');
  if (images.some(image => !generated[image.id])) throw new Error('Generate all planned works before planning the exhibition');
  const planned = new Set(images.map(image => image.id));
  const ids = direction.works.map(work => work?.id);
  if (new Set(ids).size !== ids.length) throw new Error('Exhibition works must have distinct ids');
  for (const id of ids) if (!planned.has(id)) throw new Error(`Unknown planned work: ${id}`);
  for (const id of planned) if (!ids.includes(id)) throw new Error(`Every planned work must be arranged in the exhibition: ${id}`);
  if (!ids.includes(direction.heroId)) throw new Error('The hero must be included in the planned works');
  if (direction.works.some(work => !work || [work.role, work.section, work.purpose].some(value => typeof value !== 'string' || !value.trim()))) throw new Error('Provide a role, section and purpose for every work');
  return { heroId: direction.heroId, markdown: direction.markdown.trim(), works: direction.works.map(work => ({ id: work.id, role: work.role.trim(), section: work.section.trim(), purpose: work.purpose.trim() })) };
}

export async function verifyShowcaseAssets(root: string, direction: ShowcaseDirection, generated: Record<string, GeneratedShowcaseImage>): Promise<void> {
  const paths = direction.works.map(work => generated[work.id]?.path);
  if (new Set(paths).size !== paths.length) throw new Error('Ambiguous generated image source');
  for (const work of direction.works) {
    const image = generated[work.id];
    if (!image || !/^artifacts\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp|gif)$/i.test(image.path)) throw new Error(`Invalid generated asset: ${work.id}`);
    const bytes = await readFile(await physicalRunFile(root, image.path));
    if (createHash('sha256').update(bytes).digest('hex') !== image.digest) throw new Error(`Generated image has changed: ${work.id}`);
  }
}

function oneHashEdit(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let a = 0, b = 0, changes = 0;
  while (a < left.length && b < right.length) {
    if (left[a] === right[b]) { a++; b++; continue; }
    if (++changes > 1) return false;
    if (left.length >= right.length) a++;
    if (right.length >= left.length) b++;
  }
  return changes + (left.length - a) + (right.length - b) <= 1;
}

/** Bind stable work ids in attributes only. Legacy repair requires an exact id
 * and a single hash edit; never guess a work id or accept an external/traversal path. */
export async function resolveShowcaseImages(root: string, html: string, direction: ShowcaseDirection, generated: Record<string, GeneratedShowcaseImage>): Promise<{ html: string; repairs: ImageReferenceRepair[] }> {
  await verifyShowcaseAssets(root, direction, generated);
  const allowed = new Map(direction.works.map(work => [work.id, generated[work.id]!]));
  const repairs: ImageReferenceRepair[] = [];
  const resolve = (src: string, declaredId?: string): string => {
    let id = [...allowed].find(([, image]) => src === `../${image.path}`)?.[0];
    if (src.startsWith('dreamatic-image:')) {
      id = src.slice('dreamatic-image:'.length);
      if (!allowed.has(id)) throw new Error(`Unknown planned image id: ${id}`);
    }
    let repaired = false;
    if (!id && /^\.\.\/artifacts\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp|gif)$/i.test(src)) {
      const file = basename(src);
      const matches = [...allowed].filter(([key, image]) => {
        const expected = basename(image.path), prefix = `${key}-`;
        if (!file.startsWith(prefix) || !expected.startsWith(prefix) || extname(file) !== extname(expected)) return false;
        const actualHash = file.slice(prefix.length, -extname(file).length), expectedHash = expected.slice(prefix.length, -extname(expected).length);
        return /^[a-f0-9]{12}$/.test(expectedHash) && /^[a-f0-9]{11,13}$/.test(actualHash) && oneHashEdit(actualHash, expectedHash);
      });
      if (matches.length === 1) { id = matches[0]![0]; repaired = true; }
    }
    if (!id || !allowed.has(id)) throw new Error(`Exhibition image must use a known planned image id or generated page source: ${src}`);
    if (declaredId !== undefined && declaredId !== id) throw new Error(`Image id conflicts with its source: ${declaredId}`);
    const target = `../${allowed.get(id)!.path}`;
    if (repaired) repairs.push({ id, from: src, to: target });
    return target;
  };
  const rewritten = html.replace(/<!--[\s\S]*?-->|<(script|style|textarea|title)\b[^>]*>[\s\S]*?<\/\1>|<(?:img|a|source)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, tag => {
    if (!/^<(img|a|source)\b/i.test(tag)) return tag;
    const image = /^<img\b/i.test(tag);
    const attributes = /(\s+)([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    const attrs = [...tag.matchAll(attributes)].filter(attr => ['src', 'href', 'srcset', 'data-image-id'].includes(attr[2]!.toLowerCase()));
    const values = new Map<string, string>();
    for (const attr of attrs) {
      const name = attr[2]!.toLowerCase();
      if (values.has(name)) throw new Error(`Duplicate exhibition attribute: ${name}`);
      values.set(name, attr[3] ?? attr[4] ?? attr[5] ?? '');
    }
    if (values.has('srcset')) throw new Error('Use one complete img per work, without srcset/source overrides');
    return tag.replace(attributes, (attribute, space: string, name: string, double: string | undefined, single: string | undefined, bare: string | undefined) => {
      if (!['src', 'href'].includes(name.toLowerCase())) return attribute;
      const src = double ?? single ?? bare ?? '';
      if (!(image && name.toLowerCase() === 'src') && !src.startsWith('dreamatic-image:') && !/^\.\.\/artifacts\/[^/]+\.(png|jpe?g|webp|gif)$/i.test(src)) return attribute;
      return `${space}${name}="${resolve(src, image ? values.get('data-image-id') : undefined)}"`;
    });
  });
  return { html: rewritten, repairs };
}

/** Designer determines the works; Builder determines the presentation of every work. */
export function createShowcaseTools(options: {
  root: string;
  images: ShowcaseImage[];
  generated: Record<string, GeneratedShowcaseImage>;
  saveDirection: (direction: ShowcaseDirection) => Promise<void>;
  initialDirection?: ShowcaseDirection;
}) {
  let direction = options.initialDirection ? validateShowcaseDirection(options.initialDirection, options.images, options.generated) : undefined;
  const tools: ToolDefinition[] = [{
    name: 'plan_showcase', label: 'Art direct the exhibition',
    description: 'Required before HTML. After generating all planned images, use design.md and each image Introduction, Prompt and Size (no image reading) to record an independent project-specific exhibition direction. Assign EVERY planned image a role, section/group and communication purpose, in narrative order. No omissions or duplicate ids. Include concept thesis, necessary explanation/references, typography/palette/spacing and mobile sequence in direction. Preserve full image proportions; do not invent observed details.',
    parameters: Type.Object({ heroId: Type.String(), works: Type.Array(Type.Object({ id: Type.String(), role: Type.String({ minLength: 1 }), section: Type.String({ minLength: 1 }), purpose: Type.String({ minLength: 1 }) }), { minItems: 1 }), direction: Type.String({ minLength: 1 }) }),
    async execute(_callId, raw) {
      const params = raw as { heroId: string; works: ShowcaseWork[]; direction: string };
      const next = validateShowcaseDirection({ heroId: params.heroId, works: params.works, markdown: params.direction }, options.images, options.generated);
      await options.saveDirection(next);
      direction = next;
      return { content: [{ type: 'text', text: `Exhibition direction saved. Compose the complete HTML following this narrative arrangement. Use stable sources exactly as listed (for example <img src="${showcaseImageSource(next.heroId)}">); Dreamatic binds them to verified files. Never invent or copy hash filenames. Every work must be visibly exhibited using a normal img, not only a background, hidden node or tiny thumbnail:\n${next.works.map(work => `${work.id}: ${showcaseImageSource(work.id)} | ${work.role} | ${work.section} | ${work.purpose}`).join('\n')}\nHero: ${params.heroId}. Preserve a full, undistorted view of every work. No image reading, scripts or external resources are needed.` }], details: {} };
    }
  }];
  return { tools, get direction() { return direction; } };
}

/** Extract only one complete standalone document. Ambiguous boundaries are never guessed. */
export function normalizeShowcaseHtml(output: string): string {
  const text = output.trim();
  const fail = () => new Error('Builder must return a complete HTML exhibition, without commentary or ambiguous documents');
  // Deliberately conservative: tag-shaped examples in comments/strings are
  // ambiguous too. Do not choose the first/last document or repair truncation.
  const starts = [...text.matchAll(/<html(?=[\s>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)];
  const ends = [...text.matchAll(/<\/html\s*>/gi)];
  const doctypes = [...text.matchAll(/<!doctype\s+html\b[^>]*>/gi)];
  if (starts.length !== 1 || ends.length !== 1 || doctypes.length > 1) throw fail();
  const opening = starts[0]!, closing = ends[0]!;
  if (closing.index! < opening.index! + opening[0].length) throw fail();
  let start = opening.index!;
  if (doctypes.length) {
    const doctype = doctypes[0]!;
    if (doctype.index! > start || text.slice(doctype.index! + doctype[0].length, start).trim()) throw fail();
    start = doctype.index!;
  }
  const end = closing.index! + closing[0].length;
  let before = text.slice(0, start), after = text.slice(end);
  // A document must occupy its own lines, not be embedded in a prose example.
  if (!/(?:^|\n)[ \t]*$/.test(before) || !/^[ \t]*(?:\r?\n|$)/.test(after)) throw fail();
  const fence = /(?:^|\r?\n)[ \t]{0,3}(`{3,}|~{3,})(?:html)?[ \t]*\r?\n[ \t\r\n]*$/i.exec(before);
  if (fence) {
    const marker = fence[1]!;
    const close = new RegExp('^[ \t\r\n]*' + marker[0] + '{' + marker.length + ',}[ \t]*(?:\r?\n|$)').exec(after);
    if (!close) throw fail();
    before = before.slice(0, fence.index); after = after.slice(close[0].length);
  }
  // Only plain explanatory text may surround the document. Extra markup or
  // code blocks could be another deliverable or unsafe content: reject them.
  const extraContent = /<[!/?a-z]|^[ \t]{0,3}(?:`{3,}|~{3,})/im;
  if (extraContent.test(before) || extraContent.test(after)) throw fail();
  return text.slice(start, end);
}

/** Static visibility checks for explicit hiding, inactive containers and tiny placeholders.
 * This is deliberately not a CSS layout engine or an aesthetic score. */
function visibleImageSources(html: string): string[] {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  // Only unconditional simple selectors are evaluated; responsive layout remains free.
  const rules: { selector: string; declarations: string }[] = [];
  for (const style of clean.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = style[1]!.replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0, start = 0, selector = '', bodyStart = 0;
    for (let i = 0; i < css.length; i++) {
      if (css[i] === '{') {
        if (depth === 0) { selector = css.slice(start, i).trim(); bodyStart = i + 1; }
        depth++;
      } else if (css[i] === '}') {
        depth--;
        if (depth === 0) {
          if (!selector.startsWith('@')) for (const part of selector.split(',')) rules.push({ selector: part.trim(), declarations: css.slice(bodyStart, i) });
          start = i + 1;
        }
      }
    }
  }
  const stripped = clean.replace(/<(style|script|textarea|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const stack: { tag: string; hidden: boolean; id: string; classes: string[] }[] = [];
  const sources: string[] = [];
  for (const token of stripped.matchAll(/<\/?([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const tag = token[1]!.toLowerCase(), markup = token[0];
    if (markup.startsWith('</')) { const index = stack.map(node => node.tag).lastIndexOf(tag); if (index >= 0) stack.length = index; continue; }
    const attrs: Record<string, string> = {};
    for (const attr of markup.slice(tag.length + 1, -1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[attr[1]!.toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? '';
    const node = { tag, id: attrs.id || '', classes: (attrs.class || '').split(/\s+/), hidden: false };
    // Match simple tag/id/class combinations only, without pretending to resolve arbitrary CSS.
    const declarations = rules.filter(rule => /^[\w.#*-]+$/.test(rule.selector) && [...rule.selector.matchAll(/(^[\w*-]+)|([.#][\w-]+)/g)].every(part => part[0].startsWith('.') ? node.classes.includes(part[0].slice(1)) : part[0].startsWith('#') ? node.id === part[0].slice(1) : part[0] === '*' || node.tag === part[0].toLowerCase())).map(rule => rule.declarations).join(';') + ';' + (attrs.style || '');
    const properties = new Map<string, string>();
    for (const declaration of declarations.split(';')) { const colon = declaration.indexOf(':'); if (colon > 0) properties.set(declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).replace(/!important\s*$/i, '').trim().toLowerCase()); }
    const tiny = (value: string | undefined) => value !== undefined && /^(?:0(?:\.\d+)?|1(?:\.0+)?)(?:px)?$/.test(value);
    node.hidden = stack.some(parent => parent.hidden) || ['head', 'template', 'noscript'].includes(tag) || (tag === 'details' && !('open' in attrs)) || ('hidden' in attrs) || attrs['aria-hidden'] === 'true' || properties.get('display') === 'none' || ['hidden', 'collapse'].includes(properties.get('visibility') || '') || Number(properties.get('opacity') ?? 1) === 0 || properties.get('content-visibility') === 'hidden' || ['width', 'height', 'max-width', 'max-height'].some(key => tiny(properties.get(key))) || (tag === 'img' && (tiny(attrs.width) || tiny(attrs.height)));
    if (tag === 'img' && attrs.src && !node.hidden) sources.push(attrs.src);
    if (!['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tag) && !markup.endsWith('/>')) stack.push(node);
  }
  return sources;
}

/** Objective delivery checks only; aesthetic judgments belong to the Builder and the reviewer. */
export async function validateShowcaseHtml(root: string, html: string, direction: ShowcaseDirection, generated: Record<string, GeneratedShowcaseImage>): Promise<void> {
  const sources = visibleImageSources(html);
  const paths = new Map(Object.entries(generated).map(([id, image]) => [`../${image.path}`, id]));
  const shown = new Set<string>();
  for (const src of sources) {
    const id = paths.get(src);
    if (!id) throw new Error(`Exhibition image must use its generated page source: ${src}`);
    if (!direction.works.some(work => work.id === id)) throw new Error(`Add ${id} to the exhibition direction before displaying it`);
    await readFile(await physicalRunFile(root, generated[id]!.path));
    shown.add(id);
  }
  for (const { id } of direction.works) if (!shown.has(id)) throw new Error(`Planned work is missing from the visible exhibition: ${id}`);
  if (/<script\b|<link\b[^>]*\bhref\s*=\s*["']https?:|@import\s|url\(\s*["']?https?:/i.test(html)) throw new Error('Exhibition must work as a static page with local images, inline CSS and system/local fonts');
}

export function showcaseDirectionMarkdown(direction: ShowcaseDirection): string {
  return `# Exhibition direction\n\nHero: ${direction.heroId}\n\nAll works in narrative order:\n${direction.works.map(work => `- ${work.id} — ${work.role}; ${work.section}; ${work.purpose}`).join('\n')}\n\n${direction.markdown}\n`;
}
