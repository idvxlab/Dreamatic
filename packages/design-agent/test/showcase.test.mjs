import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { annotateShowcasePrompts, appendShowcaseReferences } from "../dist/showcase.js";

test("reference descriptions clamp visually and retain escaped full hover text and visible citations", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "dreamatic-reference-hover-"));
  try {
    await mkdir(join(runDir, "research/assets"), { recursive: true });
    const description = 'Long "caption" <b>detail</b> & context '.repeat(30);
    await writeFile(join(runDir, "research/assets/figure.png"), "image");
    await writeFile(join(runDir, "research/assets/manifest.json"), JSON.stringify({ assets: [{ file: "figure.png", description, license: "CC BY", source_page_url: "https://example.com/figure" }] }));
    const html = await appendShowcaseReferences(runDir, "<html><body>Work</body></html>");
    assert.match(html, /-webkit-line-clamp: 2 !important/);
    assert.match(html, /class="reference-caption-text" title="参考图 1\. Long &quot;caption&quot; &lt;b&gt;detail&lt;\/b&gt; &amp; context/);
    assert.match(html, /CC BY" tabindex="0"/);
    assert.match(html, /class="reference-caption-links"><a[^>]*>\[1\]<\/a> · <a/);
    assert.doesNotMatch(html, /\.reference-caption-text:focus[^}]*overflow: visible/);
    assert.match(html, /max-height: 2.9em !important/);
    const preview = /class="reference-caption-text"[^>]*>([^<]*)<\/span>/u.exec(html)?.[1];
    assert.ok(preview.endsWith("…"));
    assert.ok(preview.length < 200);
    assert.match(html, /class="reference-thumbnail" href="https:\/\/example.com\/figure" target="_blank" rel="noopener noreferrer"/);
    assert.doesNotMatch(html, /<b>detail<\/b>/);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("generated image hover uses exact paths and actual sidecars, with labeled plan fallback", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "dreamatic-prompt-hover-"));
  try {
    await mkdir(join(runDir, "plan"), { recursive: true });
    await mkdir(join(runDir, "artifacts/generated-images"), { recursive: true });
    await writeFile(join(runDir, "plan/deliverable_manifest.json"), JSON.stringify({ deliverables: [
      { id: "hero", file: "artifacts/generated-images/hero & view.png", method: "image_generate" },
      { id: "detail", file: "artifacts/generated-images/detail.png", method: "image_edit" },
      { id: "manual", file: "artifacts/manual.png", method: "manual" },
    ] }));
    await writeFile(join(runDir, "plan/design_plan.json"), JSON.stringify({ image_generation_plan: [
      { id: "hero", prompt_seed: "OUTDATED PLAN" },
      { id: "detail", prompt_seed: "Approved detailed view", negative_prompt_seed: "No distortion" },
      { id: "manual", prompt_seed: "NOT AN IMAGE PROMPT" },
    ] }));
    await writeFile(join(runDir, "artifacts/generated-images/hero & view.png.json"), JSON.stringify({ prompt: 'Actual "prompt" & <script>alert(1)</script>\nNext line' }));
    const html = '<html><head></head><body><img src="generated-images/hero%20%26%20view.png" title="Old title"><img src=\'generated-images/detail.png?version=2#image\'><img src="manual.png"><img src="../research/assets/detail.png"><!-- <img src="generated-images/detail.png"> --><script>const sample = \'<img src="generated-images/detail.png">\';</script></body></html>';
    const result = await annotateShowcasePrompts(runDir, html);
    assert.match(result, /title="生成 Prompt\nActual &quot;prompt&quot; &amp; &lt;script&gt;alert\(1\)&lt;\/script&gt;\nNext line"/);
    assert.match(result, /title="设计方案 Prompt\nApproved detailed view\n\nNegative prompt\nNo distortion"/);
    assert.doesNotMatch(result, /OUTDATED PLAN|NOT AN IMAGE PROMPT|Old title/);
    assert.match(result, /<img src="manual.png"><img src="\.\.\/research\/assets\/detail.png">/);
    assert.match(result, /<!-- <img src="generated-images\/detail.png"> -->/);
    assert.match(result, /const sample = '<img src="generated-images\/detail.png">'/);
    assert.equal(await annotateShowcasePrompts(runDir, result), result);
    const rooted = await annotateShowcasePrompts(runDir, '<html><head><base href="../"></head><body><img src="artifacts/generated-images/detail.png"></body></html>');
    assert.match(rooted, /title="设计方案 Prompt/);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("reference thumbnail links open public original sources, never local files or unsafe URLs", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "dreamatic-reference-original-link-"));
  try {
    await mkdir(join(runDir, "research/assets"), { recursive: true });
    for (const name of ["page", "image", "missing", "unsafe"]) await writeFile(join(runDir, `research/assets/${name}.png`), "image");
    await writeFile(join(runDir, "research/assets/manifest.json"), JSON.stringify({ assets: [
      { file: "page.png", source_page_url: "https://example.com/article", source_url: "https://example.com/figure.png" },
      { file: "image.png", source_url: "https://example.com/original.png" },
      { file: "missing.png" },
      { file: "unsafe.png", source_page_url: "javascript:alert(1)", source_url: "file:///private/image.png" },
    ] }));
    const result = await appendShowcaseReferences(runDir, "<html><body>Works</body></html>");
    assert.match(result, /class="reference-thumbnail" href="https:\/\/example.com\/article" target="_blank" rel="noopener noreferrer"/);
    assert.match(result, /class="reference-thumbnail" href="https:\/\/example.com\/original.png" target="_blank" rel="noopener noreferrer"/);
    assert.equal([...result.matchAll(/<span class="reference-thumbnail">/gu)].length, 2);
    assert.doesNotMatch(result, /class="reference-thumbnail" href="\.\.|javascript:|file:\/\/\/private/);
    assert.equal([...result.matchAll(/<img[^>]*src="\.\.\/research\/assets\//gu)].length, 4);
    assert.equal(await appendShowcaseReferences(runDir, result), result);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("Showcase appendix includes the whole reference library and deduplicated literature", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-showcase-"));
  try {
    const runDir = join(workspace, "runs", "demo");
    const assetsDir = join(runDir, "research/assets");
    const sourcesDir = join(runDir, "research/sources");
    await mkdir(assetsDir, { recursive: true });
    await mkdir(sourcesDir, { recursive: true });
    const assets = [];
    for (let index = 0; index < 25; index += 1) {
      const file = `reference ${index}.png`;
      await writeFile(join(assetsDir, file), "reference image");
      assets.push({ id: `asset-${index}`, file, description: `Reference ${index}`, source_page_url: "https://example.com/product" });
    }
    assets[1].file = "runs/demo/research/assets/reference 1.png";
    assets[2].file = join(assetsDir, "reference 2.png");
    delete assets[3].file;
    assets[3].local_path = "research/assets/reference 3.png";
    assets.push({ id: "missing", file: "missing.png", description: "Missing reference" });
    assets.push({ id: "unsafe", file: "https://example.com/remote.png", description: '<script>alert("unsafe")</script>', source_url: "javascript:alert(1)" });
    await writeFile(join(assetsDir, "manifest.json"), JSON.stringify({ assets }));
    await writeFile(join(runDir, "research/evidence.json"), JSON.stringify({
      sources: [{ title: "Product study", url: "https://example.com/product", author: "Maker", date: "2026" }],
      official_sources: [{ title: "Repeated source", url: "https://example.com/product" }],
      references: [{ title: "Paper", url: "https://example.com/paper" }, { title: "Unsafe", url: "javascript:alert(2)" }],
    }));
    await writeFile(join(sourcesDir, "product.txt"), "Cached product\nhttps://example.com/product\n\nText");
    await writeFile(join(sourcesDir, "additional.txt"), "Additional literature\nhttps://example.com/additional\n\nText");
    const gallery = "<!doctype html><html><head><title>Work</title></head><body><main><h1>Work</h1><p>Overview</p><p>Conclusion</p></main></body></html>";
    const result = await appendShowcaseReferences(runDir, gallery);
    assert.ok(result.startsWith(gallery.split("</body>")[0]));
    assert.ok(result.indexOf("参考图片汇总") > result.indexOf("Conclusion"));
    assert.ok(result.indexOf("文献与来源") > result.indexOf("参考图片汇总"));
    assert.equal([...result.matchAll(/<img\s/gu)].length, 25);
    assert.match(result, /\.\.\/research\/assets\/reference%2024\.png/);
    assert.match(result, /Missing reference/);
    assert.match(result, /参考图片文件不可用/);
    assert.match(result, /&lt;script&gt;/);
    assert.doesNotMatch(result, /<script|javascript:|<img[^>]+https?:/u);
    assert.equal([...result.matchAll(/>Product study<\/a>/gu)].length, 1);
    assert.match(result, /Additional literature/);
    assert.equal(await appendShowcaseReferences(runDir, result), result);
    assets.pop();
    assets.pop();
    assets.pop();
    await writeFile(join(assetsDir, "manifest.json"), JSON.stringify({ assets }));
    const revised = await appendShowcaseReferences(runDir, result);
    assert.equal([...revised.matchAll(/<img\s/gu)].length, 24);
    assert.doesNotMatch(revised, /reference%2024\.png/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Showcase never exposes reference paths escaping the Run, including symlinks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-showcase-safety-"));
  try {
    const runDir = join(workspace, "runs", "demo");
    const assetsDir = join(runDir, "research/assets");
    await mkdir(assetsDir, { recursive: true });
    await writeFile(join(workspace, "private.png"), "private image");
    await symlink(join(workspace, "private.png"), join(assetsDir, "unsafe.png"));
    await writeFile(join(assetsDir, "manifest.json"), JSON.stringify({ assets: [{ file: "unsafe.png" }, { file: join(workspace, "private.png") }] }));
    const html = await appendShowcaseReferences(runDir, "<html><body>Works</body></html>");
    assert.doesNotMatch(html, /<img/);
    assert.equal([...html.matchAll(/参考图片文件不可用/gu)].length, 2);
    assert.match(html, /未记录外部文献来源/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Showcase source links inherit readable page text on dark and light themes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-showcase-colors-"));
  try {
    await mkdir(join(workspace, "research"), { recursive: true });
    await writeFile(join(workspace, "research/evidence.json"), JSON.stringify({ sources: [{ title: "Structure paper", url: "https://example.com/paper" }] }));
    for (const [background, foreground] of [["#202529", "#d9ddd7"], ["#ffffff", "#202529"]]) {
      const html = `<html><head><style>body{background:${background};color:${foreground}}a{color:blue}a:visited{color:purple}p{color:white}</style></head><body>Work</body></html>`;
      const result = await appendShowcaseReferences(workspace, html);
      assert.ok(result.includes(`body{background:${background};color:${foreground}}`));
      assert.match(result, /#dreamatic-showcase-references a, #dreamatic-showcase-references a:visited \{ color: inherit !important; text-decoration: underline !important;/);
      assert.match(result, /#dreamatic-showcase-references :is\(h2,p,li,figcaption\) \{ color: inherit !important;/);
      assert.match(result, /a:focus-visible \{ outline: 2px solid currentColor/);
      assert.equal(await appendShowcaseReferences(workspace, result), result);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Showcase uses compact thumbnails and numbered academic metadata with linked figure sources", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "dreamatic-showcase-citations-"));
  try {
    await mkdir(join(runDir, "research/assets"), { recursive: true });
    await writeFile(join(runDir, "research/assets/figure.png"), "image");
    await writeFile(join(runDir, "research/assets/manifest.json"), JSON.stringify({ assets: [{ file: "figure.png", description: "Structure figure", source_page_url: "https://example.com/article" }] }));
    await writeFile(join(runDir, "research/evidence.json"), JSON.stringify({
      sources: [{ title: "Structure study", url: "https://example.com/article" }],
      literature: [
        { title: "Structure study", url: "https://example.com/article", authors: [{ family: "Yang", given: "D" }, { family: "Feng", given: "M" }], publication_date: "2024", journal: "Design Journal", volume: 36, issue: 2, article_number: "2306928", doi: "10.1234/example", retrieved_at: "2026-10-03T10:00:00Z" },
        { title: "DOI duplicate", url: "https://doi.org/10.1234/example" },
        { title: "Institution report", url: "https://example.com/report", author_or_institution: "Research Institute", published_at: "2025-06-01" },
      ],
    }));
    const result = await appendShowcaseReferences(runDir, "<html><body>Work</body></html>");
    assert.match(result, /font-size: 12px !important/);
    assert.match(result, /max-height: 88px !important; object-fit: contain/);
    assert.match(result, /minmax\(min\(128px,100%\),1fr\)/);
    assert.match(result, /href="#dreamatic-source-1"[^>]*>\[1\]<\/a>/);
    assert.match(result, /<li id="dreamatic-source-1">/);
    assert.match(result, /D\. Yang and M\. Feng, /);
    assert.match(result, /<i>Design Journal<\/i>, vol\. 36, no\. 2, Art\. no\. 2306928, 2024/);
    assert.match(result, /doi: <a href="https:\/\/doi.org\/10\.1234\/example"/);
    assert.match(result, /Accessed: Oct\. 3, 2026/);
    assert.match(result, /Research Institute, /);
    assert.match(result, /Jun\. 1, 2025/);
    assert.match(result, /IEEE 编号引用格式/);
    assert.match(result, /\[Online\]\. Available: <a href="https:\/\/example.com\/report"/);
    assert.equal([...result.matchAll(/<li id="dreamatic-source-/gu)].length, 2);
    assert.equal(await appendShowcaseReferences(runDir, result), result);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("Showcase accepts DOI-only records, escapes citations and does not invent missing dates or authors", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "dreamatic-showcase-citation-safety-"));
  try {
    await mkdir(join(runDir, "research"), { recursive: true });
    await writeFile(join(runDir, "research/evidence.json"), JSON.stringify({ sources: [
      { title: '<script>Unsafe title</script>', doi: "doi:10.1234/valid", authors: ["<b>Author</b>"] },
      { title: "Undated web resource", url: "https://example.com/undated" },
      { title: "Invalid DOI", doi: "javascript:alert(1)" },
    ] }));
    const result = await appendShowcaseReferences(runDir, "<html><body>Work</body></html>");
    assert.match(result, /href="https:\/\/doi.org\/10\.1234\/valid"/);
    assert.match(result, /&lt;b&gt;Author&lt;\/b&gt;/);
    assert.doesNotMatch(result, /<script|<b>Author|javascript:|Invalid DOI|Accessed:|Anonymous|Unknown author/);
    assert.equal([...result.matchAll(/<li id="dreamatic-source-/gu)].length, 2);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("IEEE appendix distinguishes proceedings, books, reports and online news", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "dreamatic-showcase-source-types-"));
  try {
    await mkdir(join(runDir, "research"), { recursive: true });
    await writeFile(join(runDir, "research/evidence.json"), JSON.stringify({ sources: [
      { title: "Conference paper", url: "https://example.com/proceedings", authors: [{ family: "Smith", given: "Jane A" }], conference_name: "Design Conference", pages: "12–18", year: 2024, doi: "10.1234/proceedings" },
      { title: "Design book", url: "https://example.com/book", type: "book", author: "Design Institute", publisher: "Academic Press", year: 2023 },
      { title: "Research report", url: "https://example.com/report", institution: "Research Institute", report_number: "R-42", publication_date: "2025-06-01" },
      { title: "Technology news", url: "https://example.com/news", site_name: "Science Newsroom", publication_date: "2026-09-12", accessed_at: "2026-10-03T08:00:00Z" },
    ] }));
    const result = await appendShowcaseReferences(runDir, "<html><body>Works</body></html>");
    assert.match(result, /J\. A\. Smith, .*in <i>Design Conference<\/i>, pp\. 12–18, 2024/);
    assert.match(result, /Design Institute, <i><a[^>]*>Design book<\/a><\/i>, Academic Press, 2023/);
    assert.match(result, /Research Institute, .*Rep\. R-42, Jun\. 1, 2025/);
    assert.match(result, /Science Newsroom, Sep\. 12, 2026\. Accessed: Oct\. 3, 2026\. \[Online\]\. Available:/);
    assert.equal([...result.matchAll(/<li id="dreamatic-source-/gu)].length, 4);
    assert.equal(await appendShowcaseReferences(runDir, result), result);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
