import { readRunContext } from "./context-model.js";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveInside } from "./paths.js";

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function json(path: string): Promise<Record<string, unknown>> {
  const source = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  });
  return record(JSON.parse(source));
}

function webUrl(value: unknown): string | undefined {
  try {
    const url = new URL(text(value));
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
  return undefined;
}

function citationText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : text(value);
}

function authors(value: unknown): string {
  if (!Array.isArray(value)) return text(value);
  const names = value.map((entry) => {
    if (typeof entry === "string") return entry.trim();
    const author = record(entry);
    const given = text(author.given ?? author.given_name);
    const family = text(author.family ?? author.family_name);
    const initials = /^[A-Za-z .-]+$/u.test(given) ? given.split(/[\s.-]+/u).filter(Boolean).map((part) => `${part[0]}.`).join(" ") : given;
    return text(author.name) || [initials, family].filter(Boolean).join(" ");
  }).filter(Boolean);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
}

function referenceDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/u.exec(value);
  if (!match) return value;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) return value;
  const month = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(date);
  return `${month === "May" ? month : `${month}.`} ${Number(match[3])}, ${match[1]}`;
}

function doi(value: unknown): string {
  let identifier = text(value).replace(/^doi:\s*/iu, "");
  if (/^https?:\/\/(?:dx\.)?doi\.org\//iu.test(identifier)) {
    try { identifier = decodeURIComponent(new URL(identifier).pathname.slice(1)); } catch { return ""; }
  }
  return /^10\.\d{4,9}\/[^\s]+$/u.test(identifier) ? identifier : "";
}

function doiUrl(identifier: string): string {
  return `https://doi.org/${identifier.split("/").map(encodeURIComponent).join("/")}`;
}

function attribute(tag: string, name: string): string {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu").exec(tag);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/giu, (entity, code: string) => {
    const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
    if (!code.startsWith("#")) return named[code.toLowerCase()] ?? entity;
    const number = code.toLowerCase().startsWith("#x") ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : entity;
  });
}

export async function annotateShowcasePrompts(runDir: string, html: string): Promise<string> {
  const manifest = await readRunContext(runDir, "plan/deliverable_manifest.json").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return {}; throw error; });
  const plan = await readRunContext(runDir, "plan/design_plan.json").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return {}; throw error; });
  const tasks = plan.schemaVersion === 2 ? plan.execution_plan : plan.image_generation_plan;
  const entries = Array.isArray(tasks) ? tasks.map(record).filter((task) => task.method !== "html_generate") : [];
  const prompts = new Map<string, string>();
  const physicalRoot = await realpath(runDir);
  for (const value of Array.isArray(manifest.deliverables) ? manifest.deliverables : []) {
    const deliverable = record(value);
    if (!["image_generate", "image_edit"].includes(text(deliverable.method))) continue;
    const file = text(deliverable.file).replaceAll("\\", "/");
    if (!file.startsWith("artifacts/") || !/\.(png|jpe?g|webp|gif)$/iu.test(file)) continue;
    let path: string;
    try { path = resolveInside(runDir, file); } catch { continue; }
    let actual: Record<string, unknown> = {};
    try {
      const sidecar = resolveInside(physicalRoot, await realpath(`${path}.json`));
      actual = await json(sidecar);
    } catch {}
    const approved = entries.find((entry) => entry.id === deliverable.id);
    const prompt = text(actual.prompt) || text(approved?.prompt_seed);
    if (!prompt) continue;
    const negative = !text(actual.prompt) ? text(approved?.negative_prompt_seed) : "";
    prompts.set(path, `${text(actual.prompt) ? "生成 Prompt" : "设计方案 Prompt"}\n${prompt}${negative ? `\n\nNegative prompt\n${negative}` : ""}`);
  }
  const documentUrl = pathToFileURL(join(runDir, "artifacts/00-gallery.html"));
  const baseTag = /<base\b(?:[^>"']|"[^"]*"|'[^']*')*>/iu.exec(html)?.[0] ?? "";
  let base = documentUrl;
  try { base = new URL(attribute(baseTag, "href") || documentUrl.href, documentUrl); } catch {}
  return html.replace(/<!--[\s\S]*?-->|<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu, (tag) => {
    if (!/^<img\b/iu.test(tag)) return tag;
    let path: string;
    try {
      const url = new URL(attribute(tag, "src"), base);
      if (url.protocol !== "file:") return tag;
      path = resolveInside(runDir, fileURLToPath(url));
    } catch { return tag; }
    const prompt = prompts.get(path);
    if (!prompt) return tag;
    const title = ` title="${escape(prompt)}"`;
    const existing = /\s+title\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/iu;
    return existing.test(tag) ? tag.replace(existing, () => title) : tag.replace(/\s*\/?>$/u, (ending) => `${title}${ending}`);
  });
}

export async function appendShowcaseReferences(runDir: string, html: string): Promise<string> {
  const manifest = await json(join(runDir, "research/assets/manifest.json"));
  const evidence = await readRunContext(runDir, "research/evidence.json").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return {}; throw error; });
  const sources = new Map<string, { number: number; title: string; author: string; date: string; journal: string; publisher: string; volume: string; issue: string; pages: string; articleNumber: string; conference: string; site: string; reportNumber: string; kind: string; doi: string; accessed: string }>();
  const sourceAliases = new Map<string, string>();
  const addSource = (value: unknown) => {
    const source = record(value);
    const identifier = doi(source.doi ?? source.DOI) || doi(source.url ?? source.source_url);
    const url = webUrl(source.url ?? source.source_url ?? value) ?? (identifier ? doiUrl(identifier) : undefined);
    if (!url) return undefined;
    const key = sourceAliases.get(url) ?? (identifier ? sourceAliases.get(`doi:${identifier.toLowerCase()}`) : undefined) ?? url;
    const previous = sources.get(key);
    const metadata = {
      title: text(source.title) === url ? "" : text(source.title), author: authors(source.authors) || authors(source.author_or_institution) || authors(source.author) || text(source.institution),
      date: citationText(source.publication_date ?? source.published_at ?? source.published_date ?? source.year ?? source.date),
      journal: text(source.journal ?? source.journal_title), publisher: text(source.publisher),
      volume: citationText(source.volume), issue: citationText(source.issue), pages: citationText(source.pages ?? source.page_range),
      articleNumber: citationText(source.article_number), conference: text(source.conference ?? source.conference_name ?? source.proceedings_title),
      site: text(source.site_name ?? source.publication), reportNumber: citationText(source.report_number), kind: text(source.source_type ?? source.type),
      doi: identifier, accessed: text(source.accessed_at ?? source.retrieved_at ?? source.retrieval_date ?? source.access_date).split("T")[0]!,
    };
    if (previous) {
      for (const field of Object.keys(metadata) as Array<keyof typeof metadata>) {
        if (metadata[field] && (!previous[field] || (field === "title" && (previous.title === new URL(key).hostname || previous.title === key)))) previous[field] = metadata[field];
      }
    } else sources.set(key, { number: sources.size + 1, ...metadata, title: metadata.title || new URL(url).hostname });
    sourceAliases.set(url, key);
    if (identifier) sourceAliases.set(`doi:${identifier.toLowerCase()}`, key);
    return sources.get(key);
  };
  for (const key of ["sources", "official_sources", "literature", "references", "competitor_or_peer_references", "existing_brand_assets"]) {
    const entries = evidence[key];
    if (Array.isArray(entries)) entries.forEach(addSource);
  }
  const cacheDir = join(runDir, "research/sources");
  const cached = await readdir(cacheDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const file of cached.filter((name) => name.endsWith(".txt")).sort()) {
    const [title, url] = (await readFile(join(cacheDir, file), "utf8")).split(/\r?\n/u);
    addSource({ title, url });
  }
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const figures: string[] = [];
  const physicalRoot = await realpath(runDir);
  for (const [index, value] of assets.entries()) {
    const asset = record(value);
    const url = webUrl(asset.source_page_url) ?? webUrl(asset.source_url) ?? webUrl(asset.url ?? asset.image_url);
    const title = text(asset.description ?? asset.title ?? asset.alt) || text(asset.id) || `参考图 ${index + 1}`;
    const raw = text(asset.file ?? asset.local_path ?? asset.path ?? asset.localPath).replaceAll("\\", "/");
    let image = "";
    try {
      const prefix = `runs/${runDir.split(/[\\/]/u).at(-1)}/`;
      const runRelative = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
      const candidate = isAbsolute(raw) ? raw : runRelative.includes("/") ? runRelative : `research/assets/${runRelative}`;
      const path = resolveInside(runDir, candidate);
      resolveInside(physicalRoot, await realpath(path));
      if (!raw || !/\.(png|jpe?g|webp|gif|svg)$/iu.test(path) || !(await stat(path)).isFile()) throw new Error("Unavailable reference");
      const href = relative(resolve(runDir, "artifacts"), path).replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
      const thumbnail = `<img src="${escape(href)}" alt="${escape(title)}" loading="lazy">`;
      image = url
        ? `<a class="reference-thumbnail" href="${escape(url)}" target="_blank" rel="noopener noreferrer" aria-label="在新窗口查看参考图 ${index + 1} 原始来源">${thumbnail}</a>`
        : `<span class="reference-thumbnail">${thumbnail}</span>`;
    } catch {
      image = "<p>参考图片文件不可用。</p>";
    }
    const citation = url ? addSource({ url, title: text(asset.source_title) || url }) : undefined;
    const attribution = text(asset.attribution ?? asset.rights ?? asset.license);
    const description = `参考图 ${index + 1}. ${title}${attribution ? ` · ${attribution}` : ""}`;
    const characters = Array.from(description.replace(/\s+/gu, " "));
    const preview = characters.length > 90 ? `${characters.slice(0, 89).join("")}…` : characters.join("");
    figures.push(`<figure>${image}<figcaption><span class="reference-caption-text" title="${escape(description)}" tabindex="0" aria-label="${escape(description)}">${escape(preview)}</span><span class="reference-caption-links">${citation ? `<a href="#dreamatic-source-${citation.number}" aria-label="文献 ${citation.number}">[${citation.number}]</a>` : ""}${url ? ` · <a href="${escape(url)}" target="_blank" rel="noopener noreferrer">原始来源</a>` : "来源链接未记录"}</span></figcaption></figure>`);
  }
  const bibliography = [...sources].map(([url, source]) => {
    const academic = Boolean(source.journal || source.conference || source.kind === "book");
    const titleLink = `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(source.title)}</a>`;
    const parts = [source.kind === "book" ? `<i>${titleLink}</i>` : `“${titleLink}”`];
    if (source.journal) parts.push(`<i>${escape(source.journal)}</i>`);
    else if (source.conference) parts.push(`in <i>${escape(source.conference)}</i>`);
    else if (source.site || source.publisher) parts.push(escape(source.site || source.publisher));
    if (source.reportNumber) parts.push(`Rep. ${escape(source.reportNumber)}`);
    if (source.volume) parts.push(`vol. ${escape(source.volume)}`);
    if (source.issue) parts.push(`no. ${escape(source.issue)}`);
    if (source.pages) parts.push(`${/[-–—]/u.test(source.pages) ? "pp." : "p."} ${escape(source.pages)}`);
    if (source.articleNumber) parts.push(`Art. no. ${escape(source.articleNumber)}`);
    if (source.date) parts.push(escape(referenceDate(source.date)));
    if (source.doi) parts.push(`doi: <a href="${escape(doiUrl(source.doi))}" target="_blank" rel="noopener noreferrer">${escape(source.doi)}</a>`);
    const online = !academic || !source.doi ? ` [Online]. Available: <a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(url)}</a>.` : "";
    return `<li id="dreamatic-source-${source.number}"><span class="reference-number">[${source.number}]</span><span>${source.author ? `${escape(source.author)}, ` : ""}${parts.join(", ")}.${source.accessed ? ` Accessed: ${escape(referenceDate(source.accessed))}.` : ""}${online}</span></li>`;
  }).join("\n");
  const appendix = `<!-- DREAMATIC_SHOWCASE_REFERENCES -->
<style>
#dreamatic-showcase-references { color: inherit; background: transparent; max-width: 960px; margin: 32px auto 0; font-size: 12px !important; line-height: 1.55 !important; overflow-wrap: anywhere; }
#dreamatic-showcase-references :is(h2,p,li,figcaption) { color: inherit !important; }
#dreamatic-showcase-references h2 { font-size: 16px !important; line-height: 1.4 !important; margin: 24px 0 8px !important; }
#dreamatic-showcase-references p { font-size: 12px !important; margin: 0 0 12px !important; }
#dreamatic-showcase-references .reference-grid { display: grid !important; grid-template-columns: repeat(auto-fill,minmax(min(128px,100%),1fr)) !important; gap: 12px; }
#dreamatic-showcase-references figure { margin: 0 !important; padding: 0 !important; min-width: 0; }
#dreamatic-showcase-references .reference-thumbnail { display: flex; align-items: center; justify-content: center; height: 88px; }
#dreamatic-showcase-references .reference-thumbnail img { display: block; width: auto !important; height: auto !important; max-width: 100% !important; max-height: 88px !important; object-fit: contain; }
#dreamatic-showcase-references figcaption { display: block !important; font-size: 11px !important; line-height: 1.45 !important; margin-top: 6px; min-width: 0 !important; max-width: 100% !important; }
#dreamatic-showcase-references .reference-caption-text { display: -webkit-box !important; -webkit-line-clamp: 2 !important; -webkit-box-orient: vertical !important; overflow: hidden !important; max-height: 2.9em !important; line-height: 1.45 !important; overflow-wrap: anywhere !important; white-space: normal !important; }
#dreamatic-showcase-references .reference-caption-text:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
#dreamatic-showcase-references .reference-caption-links { display: block; margin-top: 3px; }
#dreamatic-showcase-references ol { list-style: none !important; padding: 0 !important; margin: 0 !important; }
#dreamatic-showcase-references li { display: grid; grid-template-columns: 2.5em minmax(0,1fr); gap: 6px; font-size: 12px !important; line-height: 1.55 !important; margin: 0 0 8px !important; scroll-margin-top: 16px; }
#dreamatic-showcase-references .reference-number { font-variant-numeric: tabular-nums; }
#dreamatic-showcase-references :is(a,span) { font-size: inherit !important; }
#dreamatic-showcase-references a, #dreamatic-showcase-references a:visited { color: inherit !important; text-decoration: underline !important; text-underline-offset: .18em; }
#dreamatic-showcase-references a:hover { text-decoration-thickness: 2px; }
#dreamatic-showcase-references a:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
</style>
<section id="dreamatic-showcase-references" aria-label="参考资料">
<h2>参考图片汇总</h2><p>以下为本项目收集的参考资料，不属于原创设计成品，也不代表每项均被采用或已获得转载授权。</p>
<div class="reference-grid">${figures.join("\n") || "<p>本项目未收集参考图片。</p>"}</div>
<h2>文献与来源</h2><p>采用 IEEE 编号引用格式；仅列出已记录的元数据，缺失信息不作推测。</p>${bibliography ? `<ol>${bibliography}</ol>` : "<p>本项目未记录外部文献来源。</p>"}
</section>
<!-- /DREAMATIC_SHOWCASE_REFERENCES -->`;
  const clean = html.replace(/<!-- DREAMATIC_SHOWCASE_REFERENCES -->[\s\S]*?<!-- \/DREAMATIC_SHOWCASE_REFERENCES -->\r?\n?/gu, "");
  if (/<\/body\s*>/iu.test(clean)) return clean.replace(/<\/body\s*>/iu, () => `${appendix}\n</body>`);
  return `${clean}\n${appendix}`;
}
