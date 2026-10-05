import { relative } from 'node:path';
export function showcaseTemplate(title: string, sections: Array<{ title: string; items: Array<{ id: string; path: string; caption: string; kind?: "html" }> }>, artifactsDir: string): string {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const work = (item: { id: string; path: string; caption: string; kind?: "html" }) => {
    const path = escape(relative(artifactsDir, item.path).replaceAll('\\', '/'));
    return item.kind === 'html'
      ? `<a href="${path}" target="_blank" rel="noopener">${escape(item.caption || item.id)}</a>`
      : `<img loading="lazy" src="${path}" alt="${escape(item.caption || item.id)}">`;
  };
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#141719;color:#eef1eb;font:16px/1.6 system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:48px 24px}h1{font-size:clamp(32px,5vw,64px);line-height:1.1}section{border-top:1px solid #555;padding:24px 0}.works{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:24px}figure{margin:0}figure:first-child{grid-column:1/-1}img{display:block;width:100%;height:auto}figcaption{padding:12px 0;color:#c9d1c5}a,a:visited{color:#b8dccd}a:focus-visible{outline:2px solid #fff}
  </style></head><body><main><h1>${escape(title)}</h1>${sections.map((section) => `<section><h2>${escape(section.title)}</h2><div class="works">${section.items.map((item) => `<figure>${work(item)}<figcaption>${escape(item.caption)}</figcaption></figure>`).join('')}</div></section>`).join('')}</main></body></html>`;
}
