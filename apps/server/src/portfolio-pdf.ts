import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { physicalRunFile } from '@dreamatic/project-data';
import { plannedImages } from './design-pipeline.js';
import { workTitle } from './project-title.js';
import type { ShowcaseDirection, GeneratedShowcaseImage } from './showcase.js';
import { concise, curatePortfolio, fallbackDirection, type PortfolioPlan, type PortfolioWork } from './portfolio-plan.js';

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const jsonFile = async (root: string, path: string) => JSON.parse(await readFile(await physicalRunFile(root, path), 'utf8'));
const busy = new Set<string>();
export const portfolioInProgress = (): boolean => busy.size > 0;
export interface PortfolioResult { path: string; filename: string; pages: number; bytes: number; selected: number; warnings: string[]; sha256: string }

async function browserExecutable(): Promise<string> {
  const configured = process.env.DREAMATIC_HTML_BROWSER_EXECUTABLE || process.env.DREAMATIC_DESKTOP_BROWSER;
  const candidates = configured ? [configured] : [chromium.executablePath(), ...(process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : process.platform === 'win32' ? [join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'), join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'])];
  for (const candidate of candidates) if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  throw new Error('PDF renderer unavailable. Install a Playwright Chromium browser or set DREAMATIC_HTML_BROWSER_EXECUTABLE to an installed Chromium executable.');
}

async function fontCss(): Promise<string> {
  const font = process.env.DREAMATIC_PDF_FONT;
  if (!font) return '';
  const extension = extname(font).toLowerCase();
  const formats: Record<string, [string, string]> = { '.ttf': ['font/ttf', 'truetype'], '.otf': ['font/otf', 'opentype'], '.woff2': ['font/woff2', 'woff2'], '.woff': ['font/woff', 'woff'] };
  const format = formats[extension];
  if (!format) throw new Error('DREAMATIC_PDF_FONT must be a licensed embeddable TTF, OTF, WOFF or WOFF2 font');
  const bytes = await readFile(font).catch(() => { throw new Error('Configured PDF font cannot be read'); });
  if (bytes.length > 40 * 1024 * 1024) throw new Error('Configured PDF font exceeds 40 MB');
  return `@font-face{font-family:PortfolioEmbedded;src:url(data:${format[0]};base64,${bytes.toString('base64')}) format('${format[1]}');font-weight:100 900;font-display:block}`;
}

/** Read only safe inline styles from the HTML; never execute its scripts or fetch
 * any of its resources. Reuse its art direction without changing its layout. */
async function showcaseTheme(page: Page, html: string, markdown: string): Promise<PortfolioPlan['theme']> {
  const safeHtml = await page.evaluate(html => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    parsed.querySelectorAll('script,link,iframe,object,embed,base,meta,svg,video,audio,source').forEach(node => node.remove());
    for (const element of parsed.querySelectorAll('*')) for (const attr of [...element.attributes]) if (/^on/i.test(attr.name) || ['src','srcset','href','poster','action','formaction'].includes(attr.name)) element.removeAttribute(attr.name);
    const policy = parsed.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy'; policy.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"; parsed.head.prepend(policy);
    return parsed.documentElement.outerHTML;
  }, html);
  await page.setContent(safeHtml);
  const theme = await page.evaluate(() => {
    const body = getComputedStyle(document.body), title = getComputedStyle(document.querySelector('h1') || document.body);
    return { background: body.backgroundColor, foreground: body.color, serif: /(?<!sans-)serif/i.test(title.fontFamily) };
  });
  const rgb = (value: string): number[] | undefined => {
    const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value);
    return match && (match[4] === undefined || Number(match[4]) === 1) ? match.slice(1, 4).map(Number) : undefined;
  };
  const palette = [...markdown.split(/^## Image:/m)[0]!.matchAll(/#[a-f\d]{6}\b/gi)].map(match => match[0]);
  const bg = rgb(theme.background) ? theme.background : '#f6f4ef';
  const channel = (n: number) => { const s = n / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; };
  const luminance = (v: number[]) => .2126 * channel(v[0]!) + .7152 * channel(v[1]!) + .0722 * channel(v[2]!);
  const background = rgb(bg) || [246, 244, 239], foreground = rgb(theme.foreground) || [20, 20, 20];
  const contrast = (Math.max(luminance(background), luminance(foreground)) + .05) / (Math.min(luminance(background), luminance(foreground)) + .05);
  return { background: bg, foreground: contrast >= 4.5 ? theme.foreground : luminance(background) < .2 ? '#f4f3ef' : '#171916', accent: palette[0] || '#77776d', serif: theme.serif };
}

export function portfolioHtml(plan: PortfolioPlan, works: PortfolioWork[], fonts = ''): string {
  const byId = new Map(works.map(work => [work.id, work]));
  const image = (id: string) => {
    const work = byId.get(id)!;
    return `<figure><div class="image"><img src="${work.source}" alt="${escape(work.caption)}" data-work="${escape(id)}"></div><figcaption>${escape(work.caption)}</figcaption></figure>`;
  };
  const hero = byId.get(plan.pages[0]!.ids[0]!)!;
  const sideOpening = plan.width > plan.height && hero.width / hero.height < .95;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><title>${escape(plan.title)}</title><style>
${fonts}
@page{size:${plan.width}px ${plan.height}px;margin:0}
*{box-sizing:border-box}html,body{margin:0;padding:0}body{background:${plan.theme.background};color:${plan.theme.foreground};font-family:PortfolioEmbedded,"Noto Sans CJK SC","PingFang SC","Microsoft YaHei",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{width:${plan.width}px;height:${plan.height}px;padding:38px 46px 28px;display:flex;flex-direction:column;gap:20px;break-after:page;position:relative}.sheet:last-child{break-after:auto}
header,footer{display:flex;align-items:center;justify-content:space-between;gap:28px;font-size:11px;letter-spacing:.06em;line-height:1.6}header{border-bottom:1px solid currentColor;padding-bottom:10px;opacity:.7}header span:first-child{max-width:80%;overflow-wrap:anywhere}footer{margin-top:auto;opacity:.65}footer span:first-child{max-width:85%}
h1,h2,p,figure{margin:0}h1,h2{font-family:${plan.theme.serif ? 'PortfolioEmbedded,"Noto Serif CJK SC","Songti SC",serif' : 'inherit'};font-weight:500;line-height:1.5;padding:3px 0;overflow-wrap:anywhere}h1{font-size:36px;max-width:93%}h2{font-size:27px}.intro{display:flex;align-items:start;gap:36px}.intro h1{flex:1}.intro p{flex:1;max-width:460px;font-size:13px;line-height:1.85;overflow-wrap:anywhere}
.works{flex:1;min-height:0;display:flex;gap:28px}figure{flex:1;min-width:0;display:flex;flex-direction:column;gap:12px;min-height:0}.image{flex:1;min-height:0;display:flex;align-items:center;justify-content:center}img{display:block;max-width:100%;max-height:100%;object-fit:contain;width:100%;height:100%}figcaption{font-size:12px;line-height:1.65;max-width:78%;overflow-wrap:anywhere;flex-shrink:0}
.detail .works{flex-direction:${plan.width > plan.height ? 'row' : 'column'}}.specimen figure,.detail figure{flex-direction:${plan.width > plan.height ? 'row' : 'column'};align-items:stretch}.specimen .image,.detail .image{flex:4}.specimen figcaption,.detail figcaption{flex:1;max-width:none;align-self:center;font-size:14px;line-height:1.9;padding:18px}.feature:nth-child(even) .works{padding-right:${plan.width > plan.height ? '65px' : '0'}}.opening figcaption{max-width:85%}.pair figure:last-child{flex:.85}.pair .works{align-items:stretch}
${sideOpening ? `.opening .intro{position:absolute;left:61%;right:46px;top:145px;display:block}.opening .intro h1{font-size:40px;margin-bottom:30px}.opening .intro p{font-size:15px}.opening .works{width:54%}.opening figcaption{max-width:100%}` : ''}
.reference-notes{font-size:10px;line-height:1.6;overflow-wrap:anywhere;max-width:95%}.reference-notes p+p{margin-top:6px}
.references .works{flex-direction:column;justify-content:flex-start;gap:25px}.reference{font-size:13px;line-height:1.85;max-width:85%;overflow-wrap:anywhere}
</style></head><body>${plan.pages.map((page, i) => `<section class="sheet ${page.kind}"><header><span>${escape(plan.title)}</span><span>${String(i + 1).padStart(2, '0')} / ${String(plan.pages.length).padStart(2, '0')}</span></header>${page.kind === 'opening' ? `<div class="intro"><h1>${escape(page.title)}</h1>${page.text ? `<p>${escape(page.text)}</p>` : ''}</div>` : `<h2>${escape(concise(page.title, 64))}</h2>`}<div class="works">${page.ids.map(image).join('')}${(page.references || []).map(text => `<p class="reference">${escape(text)}</p>`).join('')}</div>${page.notes?.length ? `<aside class="reference-notes">${page.notes.map(note => `<p>${escape(note)}</p>`).join('')}</aside>` : ''}<footer><span>${escape(page.kind === 'opening' ? '' : concise(page.title, 90))}</span><span>${String(i + 1).padStart(2, '0')}</span></footer></section>`).join('')}</body></html>`;
}

async function validateLayout(page: Page): Promise<void> {
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode())); });
  const issues = await page.evaluate(() => {
    const failures: string[] = [];
    for (const sheet of document.querySelectorAll<HTMLElement>('.sheet')) {
      const bounds = sheet.getBoundingClientRect();
      if (sheet.scrollHeight > sheet.clientHeight + 1 || sheet.scrollWidth > sheet.clientWidth + 1) failures.push('Page overflow');
      for (const element of sheet.querySelectorAll<HTMLElement>('h1,h2,p,figcaption,header,footer,img,aside')) {
        const rect = element.getBoundingClientRect();
        if (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1 || rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || element.scrollHeight > element.clientHeight + 1) failures.push(`Content overflow: ${element.tagName}`);
      }
    }
    for (const image of document.images) if (!image.complete || !image.naturalWidth || image.width < 80 || image.height < 80) failures.push(`Unreadable image: ${image.dataset.work}`);
    // Compare required characters with a missing-codepoint glyph. This catches
    // absent CJK coverage instead of silently printing tofu on a headless host.
    const canvas = document.createElement('canvas'); canvas.width = 72; canvas.height = 72;
    const ctx = canvas.getContext('2d')!;
    const glyph = (c: string) => { ctx.clearRect(0, 0, 72, 72); ctx.fillStyle = '#000'; ctx.font = `32px ${getComputedStyle(document.body).fontFamily}`; ctx.fillText(c, 3, 44); return canvas.toDataURL(); };
    const missing = glyph('\u{10ffff}');
    const chars = new Set((document.body.textContent || '').match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []);
    for (const c of chars) if (glyph(c) === missing) { failures.push('Missing font glyphs. Install Noto CJK or set DREAMATIC_PDF_FONT to a licensed embeddable font with project language coverage.'); break; }
    return failures;
  });
  if (issues.length) throw new Error(`PDF quality check failed: ${[...new Set(issues)].join('; ')}`);
}

/** Independent, local-only export. The original Builder checkpoint, HTML,
 * manifest and images are never mutated, even when rendering fails. */
export async function generatePortfolio(workspace: string, runId: string): Promise<PortfolioResult> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)) throw new Error('Invalid run id');
  const runs = await realpath(join(workspace, 'runs'));
  const root = await realpath(join(runs, runId));
  if (!root.startsWith(`${runs}${sep}`)) throw new Error('Invalid run path');
  if (busy.has(root) || busy.size >= 2) throw new Error('A PDF export is already running. Please wait before retrying.');
  busy.add(root);
  let temporary: string | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const state = await jsonFile(root, 'run-state.json');
    if (state.stages?.build !== 'completed') throw new Error('PDF requires a completed Builder project');
    const design = await readFile(await physicalRunFile(root, 'design.md'), 'utf8');
    if (!design.trim()) throw new Error('design.md is empty');
    const images = plannedImages(design);
    const generated: Record<string, GeneratedShowcaseImage> = await jsonFile(root, 'artifacts/generated.json');
    const manifest = await jsonFile(root, 'artifacts/artifact-manifest.json');
    const warnings: string[] = [];
    let direction: ShowcaseDirection;
    let savedDirection: { direction: ShowcaseDirection; assets?: Record<string, GeneratedShowcaseImage> } | undefined;
    try {
      savedDirection = await jsonFile(root, '.showcase-direction.json');
      direction = savedDirection!.direction;
      if (savedDirection?.assets && images.some(image => savedDirection!.assets![image.id]?.digest !== generated[image.id]?.digest || savedDirection!.assets![image.id]?.path !== generated[image.id]?.path)) throw new Error('Saved exhibition direction belongs to different generated images');
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      direction = manifest.showcase?.works ? { heroId: manifest.showcase.heroId, works: manifest.showcase.works, markdown: await readFile(await physicalRunFile(root, 'showcase.md'), 'utf8') } : fallbackDirection(images);
      warnings.push('Historical project: using manifest or inferred narrative because the saved exhibition direction is unavailable');
    }
    if (!direction || !Array.isArray(direction.works) || !direction.works.length || typeof direction.heroId !== 'string' || typeof direction.markdown !== 'string' || new Set(direction.works.map(work => work.id)).size !== direction.works.length || direction.works.some(work => !images.some(image => image.id === work.id) || [work.role, work.section, work.purpose].some(value => typeof value !== 'string'))) throw new Error('Invalid saved exhibition direction');
    const htmlPath = manifest.presentation?.entry || 'artifacts/00-gallery.html';
    const html = await readFile(await physicalRunFile(root, htmlPath), 'utf8');
    browser = await chromium.launch({ executablePath: await browserExecutable(), headless: true });
    const context = await browser.newContext({ viewport: { width: 1120, height: 790 }, serviceWorkers: 'block' });
    // Export runs without network access or access to local files from HTML.
    await context.route('**/*', route => route.abort());
    await context.setExtraHTTPHeaders({});
    const page = await context.newPage();
    await page.addInitScript(() => { window.open = () => null; });
    const theme = await showcaseTheme(page, html, `${direction.markdown}\n${design}`);
    const works: PortfolioWork[] = [];
    const snapshot = new Map<string, string>([['artifacts/artifact-manifest.json', hash(await readFile(await physicalRunFile(root, 'artifacts/artifact-manifest.json')))], ['design.md', hash(design)], [htmlPath, hash(html)], ['artifacts/generated.json', hash(await readFile(await physicalRunFile(root, 'artifacts/generated.json')))]]);
    if (savedDirection) snapshot.set('.showcase-direction.json', hash(await readFile(await physicalRunFile(root, '.showcase-direction.json'))));
    let totalBytes = 0;
    for (const item of direction.works) {
      const asset = generated[item.id], image = images.find(image => image.id === item.id)!;
      if (!asset || !/^artifacts\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp|gif)$/i.test(asset.path)) { warnings.push(`Unavailable image omitted: ${item.id}`); continue; }
      let bytes: Buffer;
      try { bytes = await readFile(await physicalRunFile(root, asset.path)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { warnings.push(`Missing image omitted: ${item.id}`); continue; } throw error; }
      if (hash(bytes) !== asset.digest) throw new Error(`Generated image changed: ${item.id}`);
      if (bytes.length > 80 * 1024 * 1024) { warnings.push(`Oversized image omitted (80 MB limit): ${item.id}`); continue; }
      totalBytes += bytes.length;
      if (totalBytes > 240 * 1024 * 1024) throw new Error('Portfolio images exceed the 240 MB processing budget; reduce image sizes before exporting');
      const mime = extname(asset.path).toLowerCase().replace('.', '').replace('jpg', 'jpeg');
      const source = `data:image/${mime};base64,${bytes.toString('base64')}`;
      const metadata = await page.evaluate(async source => {
        const image = new Image(); image.src = source;
        try { await image.decode(); } catch { return null; }
        if (image.naturalWidth * image.naturalHeight > 100_000_000) return null;
        const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
        const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 8, 8); ctx.drawImage(image, 0, 0, 8, 8);
        const data = ctx.getImageData(0, 0, 8, 8).data;
        return { width: image.naturalWidth, height: image.naturalHeight, signature: [...data].filter((_, i) => i % 4 !== 3) };
      }, source);
      if (!metadata || Math.min(metadata.width, metadata.height) < 240) { warnings.push(`Corrupt, unsupported or low-resolution image omitted: ${item.id}`); continue; }
      snapshot.set(asset.path, asset.digest);
      works.push({ ...metadata, id: item.id, section: item.section, role: item.role, caption: concise(image.introduction || item.purpose, 145), digest: asset.digest, source });
    }
    const title = workTitle(design) || runId;
    const plan = curatePortfolio({ title, markdown: design, direction, works, theme, warnings });
    const printDocument = portfolioHtml(plan, works, await fontCss());
    await page.emulateMedia({ media: 'print', reducedMotion: 'reduce' });
    await page.setViewportSize({ width: plan.width, height: plan.height });
    await page.setContent(printDocument, { waitUntil: 'load', timeout: 30_000 });
    await validateLayout(page);
    const lowResolution = await page.evaluate(() => [...document.images].filter(image => { const ratio = Math.min(image.clientWidth / image.naturalWidth, image.clientHeight / image.naturalHeight); return ratio > 1.35; }).map(image => image.dataset.work!));
    for (const id of lowResolution) plan.warnings.push(`Image resolution below preferred display density: ${id}`);
    // CDP exposes actual fonts used, including system fallback fonts that Chromium
    // subsets and embeds into the resulting portable PDF.
    const cdp = await context.newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root: dom } = await cdp.send('DOM.getDocument');
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: dom.nodeId, selector: 'h1,h2,p,figcaption,header span,footer span' });
    const fonts = (await Promise.all(nodeIds.map(nodeId => cdp.send('CSS.getPlatformFontsForNode', { nodeId })))).flatMap(result => result.fonts);
    if (!fonts.length) throw new Error('PDF fonts unavailable');
    let printTimer: NodeJS.Timeout | undefined;
    const bytes = await Promise.race([
      page.pdf({ width: `${plan.width}px`, height: `${plan.height}px`, printBackground: true, preferCSSPageSize: true, tagged: true }),
      new Promise<Buffer>((_, reject) => { printTimer = setTimeout(() => reject(new Error('PDF rendering exceeded 30 seconds')), 30_000); })
    ]).finally(() => clearTimeout(printTimer));
    const raw = bytes.toString('latin1');
    const pages = [...raw.matchAll(/\/Type\s*\/Page\b/g)].length;
    // macOS CJK collections are emitted as embedded Type 3 glyph programs.
    const embedded = /\/FontFile[23]?\b/.test(raw) || (/\/Subtype\s*\/Type3\b/.test(raw) && /\/CharProcs\b/.test(raw) && /\/ToUnicode\b/.test(raw));
    if (!raw.startsWith('%PDF-') || !raw.trimEnd().endsWith('%%EOF') || pages !== plan.pages.length || !embedded) throw new Error(`PDF output verification failed: ${pages}/${plan.pages.length} pages, embedded fonts=${embedded}, complete=${raw.trimEnd().endsWith('%%EOF')}`);
    // A concurrent rebuild may invalidate the source while Chromium is working.
    if ((await jsonFile(root, 'run-state.json')).stages?.build !== 'completed') throw new Error('Build changed during PDF export');
    for (const [path, digest] of snapshot) if (hash(await readFile(await physicalRunFile(root, path))) !== digest) throw new Error(`Source changed during PDF export: ${path}`);
    const artifacts = await realpath(join(root, 'artifacts'));
    if (!artifacts.startsWith(`${root}${sep}`)) throw new Error('Invalid artifacts directory');
    temporary = await mkdtemp(join(artifacts, '.portfolio-'));
    await writeFile(join(temporary, 'portfolio.pdf'), bytes, { flag: 'wx' });
    await writeFile(join(temporary, 'curation.json'), JSON.stringify({ ...plan, sources: Object.fromEntries(snapshot), fonts: fonts.map(font => font.familyName), sha256: hash(bytes) }, null, 2), { flag: 'wx' });
    // Self-contained print proof supports offline inspection and future reprints.
    await writeFile(join(temporary, 'print.html'), printDocument, { flag: 'wx' });
    const directory = `portfolio-${randomUUID()}`;
    await rename(temporary, join(artifacts, directory)); temporary = undefined;
    return { path: `runs/${runId}/artifacts/${directory}/portfolio.pdf`, filename: `${runId}-portfolio.pdf`, pages, bytes: bytes.length, selected: plan.selected.length, warnings: plan.warnings, sha256: hash(bytes) };
  } finally {
    busy.delete(root);
    await browser?.close().catch(() => undefined);
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
