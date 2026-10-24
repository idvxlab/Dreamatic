import type { ShowcaseDirection, ShowcaseImage } from './showcase.js';

export interface PortfolioWork {
  id: string; section: string; role: string; caption: string;
  width: number; height: number; digest: string; source: string;
  /** A small perceptual signature, used only to suppress near duplicate assets. */
  signature: number[];
}
export interface PortfolioPage { kind: 'opening' | 'feature' | 'pair' | 'detail' | 'specimen' | 'references'; title: string; text: string; ids: string[]; references?: string[]; notes?: string[] }
export interface PortfolioPlan {
  version: 1; title: string; concept: string; direction: string;
  width: number; height: number;
  theme: { background: string; foreground: string; accent: string; serif: boolean };
  pages: PortfolioPage[]; selected: string[]; omitted: Array<{ id: string; reason: string }>; warnings: string[];
}

export function concise(text: string, limit = 160): string {
  const clean = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const first = clean.slice(0, limit + 1);
  const stop = Math.max(first.lastIndexOf('。'), first.lastIndexOf('. '), first.lastIndexOf('；'));
  return stop > limit / 3 ? first.slice(0, stop + 1) : `${clean.slice(0, limit - 1)}…`;
}
export function conceptText(markdown: string): string {
  const body = /^##\s+(?:Concept|核心理念|设计理念|概念)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/im.exec(markdown)?.[1] || '';
  return concise(body.split(/\n\s*\n/).find(line => line.trim() && !line.trim().startsWith('#')) || '', 210);
}
const detail = (work: PortfolioWork) => /detail|material|construction|细节|材质|构造/i.test(work.role);
const near = (a: PortfolioWork, b: PortfolioWork) => a.digest === b.digest || (Math.abs(a.width / a.height - b.width / b.height) < .03 && a.signature.length === 192 && b.signature.length === 192 && a.signature.reduce((sum, value, i) => sum + Math.abs(value - b.signature[i]!), 0) / 192 < 3);

/** PDF selection is independent of HTML's deliberate all-works policy. Keep its
 * hero, narrative and grouping; suppress duplicates and cap repetitive groups. */
export function curatePortfolio(input: { title: string; markdown: string; direction: ShowcaseDirection; works: PortfolioWork[]; theme: PortfolioPlan['theme']; warnings: string[] }): PortfolioPlan {
  const { direction, works } = input;
  if (!works.length) throw new Error('No readable design images remain for a portfolio');
  const omitted: PortfolioPlan['omitted'] = [];
  const ordered = direction.works.flatMap(item => works.find(work => work.id === item.id) || []);
  const hero = works.find(work => work.id === direction.heroId) || ordered.find(work => !detail(work)) || ordered[0]!;
  const selected = [hero];
  const counts = new Map<string, number>([[hero.section, 1]]);
  for (const work of ordered) {
    if (work.id === hero.id) continue;
    const duplicate = selected.find(other => near(work, other));
    const count = counts.get(work.section) || 0;
    if (duplicate) omitted.push({ id: work.id, reason: `Visually near duplicate of ${duplicate.id}` });
    else if (count >= 3 && !detail(work)) omitted.push({ id: work.id, reason: `Section already represented by ${count} complementary works` });
    else { selected.push(work); counts.set(work.section, count + 1); }
  }
  const ratios = selected.map(work => work.width / work.height).sort((a, b) => a - b);
  // Follow the body of work as well as its opening: a portrait integration
  // drawing must not force a landscape technical series into narrow pages.
  const landscape = ratios[Math.floor(ratios.length / 2)]! >= 1.12;
  const pages: PortfolioPage[] = [{ kind: 'opening', title: input.title, text: conceptText(input.markdown), ids: [hero.id] }];
  const remaining = selected.slice(1);
  for (let i = 0; i < remaining.length; i++) {
    const work = remaining[i]!, next = remaining[i + 1];
    // Portrait/square series benefit from a comparative spread. Wide or detailed
    // works retain a whole page; never crop a composition to fill a template.
    const pair = next && next.section === work.section && !detail(work) && !detail(next) && work.width / work.height < 1.35 && next.width / next.height < 1.35 && landscape;
    pages.push({ kind: pair ? 'pair' : detail(work) ? 'detail' : landscape && work.width / work.height < .85 ? 'specimen' : 'feature', title: work.section, text: '', ids: pair ? [work.id, next.id] : [work.id] });
    if (pair) i++;
  }
  const publishedText = `${pages[0]!.text} ${selected.map(work => work.caption).join(' ')}`;
  const cited = new Set([...publishedText.matchAll(/\[(\d+)\]/g)].map(match => match[1]!));
  const bibliography = [...input.markdown.matchAll(/^\[(\d+)\]\s+(.+)(?:\n(?!\[\d+\]|#|\s*$).+)*/gm)].filter(match => cited.has(match[1]!));
  const referenceEntries = bibliography.map(match => concise(match[0], 4000));
  if (referenceEntries.length <= 2 && referenceEntries.join(' ').length <= 420) {
    if (referenceEntries.length) pages.at(-1)!.notes = referenceEntries;
  } else {
    const capacity = ((landscape ? 790 : 1060) - 230) / 24;
    const costs = referenceEntries.map(entry => Math.ceil(entry.length / (landscape ? 125 : 85)) + 1.3);
    const total = costs.reduce((sum, cost) => sum + cost, 0);
    const count = Math.ceil(total / capacity), target = total / count;
    let entries: string[] = [], cost = 0;
    const flush = () => { if (entries.length) pages.push({ kind: 'references', title: 'References · 参考资料', text: '', ids: [], references: entries }); entries = []; cost = 0; };
    for (let i = 0; i < referenceEntries.length; i++) {
      if (entries.length && cost + costs[i]! > target + 1 && pages.filter(page => page.kind === 'references').length < count - 1) flush();
      entries.push(referenceEntries[i]!); cost += costs[i]!;
    }
    flush();
  }
  for (const id of cited) if (!bibliography.some(match => match[1] === id)) input.warnings.push(`Citation [${id}] has no matching bibliography entry in design.md`);
  return { version: 1, title: input.title, concept: conceptText(input.markdown), direction: direction.markdown, width: landscape ? 1120 : 820, height: landscape ? 790 : 1060, theme: input.theme, pages, selected: selected.map(work => work.id), omitted, warnings: [...input.warnings, ...(hero.id !== direction.heroId ? ['Original hero unavailable; opening uses the first available representative work'] : [])] };
}

export function fallbackDirection(images: ShowcaseImage[]): ShowcaseDirection {
  // Historical projects without a saved direction remain usable, but never
  // pretend that filename order is an art-directed sequence.
  const hero = images.find(image => /hero|overall|主视觉|整体/i.test(`${image.id} ${image.introduction}`)) || images[0]!;
  return { heroId: hero.id, markdown: 'Historical project: narrative inferred from documented image purposes.', works: images.map(image => ({ id: image.id, role: /detail|material|细节|材质/i.test(`${image.id} ${image.introduction}`) ? 'detail' : 'work', section: concise(image.introduction.split(/[。.!！\n]/)[0] || image.id, 42), purpose: concise(image.introduction) })) };
}
