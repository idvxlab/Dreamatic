import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverResearchAssets, researchFetch, validateResearchAssets, webSearch } from "../dist/index.js";

test("reference discovery has no implicit candidate ceiling and excludes named site logos", async () => {
  const html = '<img src="/asset-official-logo.png" alt="Site logo">' + Array.from({ length: 24 }, (_, index) => `<img src="/subject-${index}.jpg" alt="Material structure detail ${index}">`).join("");
  const options = { focusTerms: ["material structure"], fetch: async () => new Response(html) };
  const all = await discoverResearchAssets("https://example.com/subject", undefined, options);
  assert.equal(all.count, 24);
  assert.ok(all.excluded.some((entry) => entry.url.endsWith("asset-official-logo.png")));
  const selected = await discoverResearchAssets("https://example.com/subject", 3, options);
  assert.equal(selected.count, 3);
});

test("reference discovery screens page utilities before limiting and ranks task context", async () => {
  let requests = 0;
  const html = `<meta content="/logo.png" property="og:image">
    <img src="/print.png"><img src="/qr.jpg"><img src="/share.jpg" alt="二维码">
    <img src="/tiny.jpg" width="32" height="32">
    <img src="/random.jpg" alt="Unrelated event">
    <img src="/loading.gif" data-src="/river.jpg" alt="River bridge &amp; street" width="1200" height="600">
    <img src="/river.jpg" alt="River bridge">
    <img src='/material.jpg' alt='Stone material detail'>`;
  const result = await discoverResearchAssets("https://example.com/place", 2, {
    focusTerms: ["bridge", "material"],
    fetch: async () => { requests += 1; return new Response(html); },
  });
  assert.equal(requests, 1);
  assert.deepEqual(result.candidates.map((candidate) => candidate.url), ["https://example.com/river.jpg", "https://example.com/material.jpg"]);
  assert.equal(result.candidates[0].alt, "River bridge & street");
  assert.equal(result.candidates[0].visual_review_status, "unreviewed");
  assert.ok(result.excluded.some((entry) => entry.url.endsWith("logo.png") && entry.reason === "identity_asset_not_requested"));
  assert.ok(result.excluded.some((entry) => entry.url.endsWith("print.png") && entry.reason === "page_utility"));
  assert.ok(result.excluded.some((entry) => entry.url.endsWith("tiny.jpg") && entry.reason === "small_page_decoration"));
});

test("reference discovery permits requested identity research without allowing QR utilities", async () => {
  const result = await discoverResearchAssets("https://example.com/brand", 4, {
    includeIdentityAssets: true,
    fetch: async () => new Response('<img src="/logo.png" width="48" height="48"><img src="/qr.png"><img src="/iconic-building.jpg" alt="Iconic bridge">'),
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.url).sort(), ["https://example.com/iconic-building.jpg", "https://example.com/logo.png"]);
  assert.equal(result.excluded.length, 1);
  assert.match(result.instruction, /not visually verified/);
});

test("reference discovery returns a gap instead of falling back to irrelevant page controls", async () => {
  const result = await discoverResearchAssets("https://example.com/place", 2, {
    fetch: async () => new Response('<img src="/print.png"><img src="/logo.png"><img src="/wx.jpg">'),
  });
  assert.equal(result.count, 0);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.excluded.length, 3);
});

test("reference discovery excludes page noise while retaining article-context uncertainty for Designer", async () => {
  const result = await discoverResearchAssets("https://example.com/research", 8, {
    focusTerms: ["actuator", "cellular"],
    fetch: async () => new Response(`<header><nav><div><img src="/car.png" alt="header_X9"></div></nav></header>
      <main><article><h1>Cellular actuators</h1>
      <div class="author-profile"><img src="/portrait.jpg" alt="Professor portrait"></div>
      <img src="/none-img.jpg" alt="프로필이미지없음">
      <img src="/sports-car.jpg" alt="Sports car exterior">
      <figure id="fig1"><img src="/figure.png" alt="Figure 1"><figcaption>Figure 1</figcaption></figure>
      <img src="/detail.png" alt="Cellular actuator connections"></article></main>
      <footer><img src="/footer-actuator.jpg" alt="Actuator promotion"></footer>`),
  });
  assert.equal(result.contentScope, "article");
  assert.deepEqual(result.candidates.map((entry) => entry.url).sort(), ["https://example.com/detail.png", "https://example.com/figure.png", "https://example.com/sports-car.jpg"]);
  assert.equal(result.candidates.find((entry) => entry.url.endsWith("figure.png")).relevance_basis, "article_figure_context");
  assert.ok(result.excluded.some((entry) => entry.url.endsWith("car.png") && entry.reason === "outside_article_or_page_chrome"));
  assert.equal(result.candidates.find((entry) => entry.url.endsWith("sports-car.jpg")).relevance_status, "uncertain");
  assert.equal(result.candidates[0].relevance_status, "likely");
  assert.ok(result.excluded.some((entry) => entry.url.endsWith("none-img.jpg") && entry.reason === "page_utility"));
  const gap = await discoverResearchAssets("https://example.com/empty", 3, {
    focusTerms: ["actuator"], fetch: async () => new Response('<img src="/car.png" alt="Car"><img src="/boat.png" alt="Boat">'),
  });
  assert.equal(gap.count, 0);
  assert.equal(gap.excluded.length, 2);
});

test("explicit identity research retains a header mark and labels ambiguous article images", async () => {
  const result = await discoverResearchAssets("https://example.com/brand", 4, {
    includeIdentityAssets: true, focusTerms: ["brand"],
    fetch: async () => new Response('<header><img src="/logo.png" alt="Official mark"></header><main><article>Brand identity<img src="/car.png" alt="Car"></article></main>'),
  });
  assert.deepEqual(result.candidates.map((entry) => entry.url).sort(), ["https://example.com/car.png", "https://example.com/logo.png"]);
  assert.equal(result.candidates.find((entry) => entry.url.endsWith("car.png")).relevance_status, "uncertain");
});

test("article figures with specific abbreviated or translated captions remain uncertain candidates", async () => {
  const result = await discoverResearchAssets("https://example.com/paper", 20, {
    focusTerms: ["programmable actuator"],
    fetch: async () => new Response(`<article><p>Programmable actuator research.</p>
      <figure><img src="/f1.png"><figcaption>PAM deformation at 20 kPa</figcaption></figure>
      <figure><img src="/f2.png"><figcaption>单元结构与连接方式</figcaption></figure>
      <img src="/test.png" alt="Experimental rig and pressure controller">
      <img src="/qrcode.png" alt="Paper QR code"></article>`),
  });
  assert.equal(result.count, 3);
  assert.equal(result.candidates.every((candidate) => candidate.relevance_status === "uncertain"), true);
  assert.equal(result.candidates.every((candidate) => candidate.visual_review_status === "unreviewed"), true);
  assert.ok(result.excluded.some((candidate) => candidate.url.endsWith("qrcode.png")));
});

test("research fetch selects core passages deep in the article while preserving the complete cache", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-focused-research-"));
  try {
    const body = "General background. ".repeat(700) + "A cellular actuator changes its topology under pressure. The mechanism and its connections are illustrated in Figure 2. " + "Additional discussion. ".repeat(300);
    const html = `<header><nav>Menu topic unrelated</nav></header><main><article><h1>Research report</h1><p>${body}</p></article></main><footer>Footer links</footer>`;
    const result = await researchFetch(workspace, { runId: "demo", url: "https://example.com/paper", cacheText: true, researchTerms: ["cellular actuator", "topology"] }, {
      maxTextChars: 1000, fetch: async () => new Response(html, { headers: { "content-type": "text/html" } }),
    });
    assert.equal(result.extractionMethod, "topic_passages");
    assert.equal(result.contentScope, "article");
    assert.ok(result.text.length <= 1000);
    assert.match(result.text, /cellular actuator changes its topology/);
    assert.doesNotMatch(result.text, /Menu topic unrelated|Footer links/);
    assert.deepEqual(result.matchedTerms, ["cellular actuator", "topology"]);
    assert.equal(result.truncated, true);
    assert.ok((await readFile(join(workspace, result.cachedPath), "utf8")).includes(body));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("reference discovery screens camel-case, numbered and encoded utility filenames before applying limits", async () => {
  const result = await discoverResearchAssets("https://example.com/paper", 1, {
    focusTerms: ["mechanism"],
    fetch: async () => new Response(`<img src="/siteLogo2.png"><img src="/logo3.png"><img src="/toolIcon24.png">
      <img src="/%6c%6f%67%6f.png"><img src="/image?filename=footerLogo.png">
      <img src="/mechanism.png" alt="Mechanism diagram">`),
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.url), ["https://example.com/mechanism.png"]);
  assert.equal(result.excluded.length, 5);
});

test("reference discovery filters captions and per-image descriptions without mistaking the page subject for image content", async () => {
  const result = await discoverResearchAssets("https://example.com/paper", 8, {
    focusTerms: ["structure"],
    fetch: async () => new Response(`<title>Structure paper</title>
      <figure><img src="/opaque-1.png"><figcaption>Publisher logo</figcaption></figure>
      <img src="/opaque-2.png" data-description="Site navigation icon">
      <img src="/opaque-3.png" aria-label="网站标志">
      <img src="/opaque-4.png" aria-describedby="image-desc"><span id="image-desc">Company logo</span>
      <img src="/opaque-5.png" data-caption="分享图标">
      <img src="/good.png" data-description="Structure cross-section">
      <img src="/iconic-architecture.jpg" alt="Iconic building structure">`),
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.url), ["https://example.com/good.png", "https://example.com/iconic-architecture.jpg"]);
  assert.equal(result.candidates[0].description, "Structure cross-section");
  assert.equal(result.excluded.length, 5);
});

test("requested icon and logo references remain eligible while page utilities stay excluded", async () => {
  const result = await discoverResearchAssets("https://example.com/design", 8, {
    includeIdentityAssets: true,
    includeIconAssets: true,
    fetch: async () => new Response('<img src="/brandLogo2.png" width="48" height="48"><img src="/icon24.png" width="24" height="24"><img src="/favicon.png"><img src="/shareIcon.png"><img src="/qrcode.png">'),
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.url).sort(), ["https://example.com/brandLogo2.png", "https://example.com/icon24.png"]);
  assert.equal(result.excluded.length, 3);
});

test("social preview descriptions can exclude an opaque logo without borrowing the generic page description", async () => {
  const result = await discoverResearchAssets("https://example.com/paper", 4, {
    fetch: async () => new Response('<meta property="og:image" content="/opaque.png"><meta property="og:image:alt" content="Publisher logo"><meta name="description" content="Logo discussion in a technology article"><img src="/diagram.png" alt="Structure diagram">'),
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.url), ["https://example.com/diagram.png"]);
  assert.equal(result.excluded[0].reason, "identity_asset_not_requested");
});

test("reference discovery merges later image context and rejects misleading metadata images", async () => {
  const result = await discoverResearchAssets("https://example.com/place", 1, {
    focusTerms: ["bridge"],
    fetch: async () => new Response(`<meta property="og:image" content="/bridge-reference.jpg">
      <meta name="twitter:image" content="/photo.jpg">
      <img src="/bridge-reference.jpg" alt="微信二维码">
      <img src="/random.jpg" alt="Other event">
      <img src="/photo.jpg" alt="Stone bridge at riverside">`),
  });
  assert.equal(result.candidates[0].url, "https://example.com/photo.jpg");
  assert.equal(result.candidates[0].alt, "Stone bridge at riverside");
  assert.ok(result.excluded.some((entry) => entry.url.endsWith("bridge-reference.jpg")));
});

test("web search uses Serper when the provider and key are configured", async () => {
  let request;
  const result = await webSearch("industrial design", 2, {
    env: { DREAMATIC_SEARCH_PROVIDER: "serper", DREAMATIC_SEARCH_API_KEY: "secret" },
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return new Response(JSON.stringify({ organic: [
        { title: "First", link: "https://example.com/first", snippet: "One" },
        { title: "Second", link: "https://example.com/second", snippet: "Two" },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(result.provider, "serper");
  assert.equal(result.count, 2);
  assert.equal(request.url, "https://google.serper.dev/search");
  assert.equal(request.init.method, "POST");
  assert.equal(new Headers(request.init.headers).get("X-API-KEY"), "secret");
  assert.deepEqual(JSON.parse(request.init.body), { q: "industrial design", num: 2 });
});

test("category queries preserve combined subject terms and language for both search providers", async () => {
  for (const query of ["vibe coding 键盘", '"vibe coding" keyboard']) {
    let serperQuery;
    const serper = await webSearch(query, 5, {
      env: { DREAMATIC_SEARCH_PROVIDER: "serper", DREAMATIC_SEARCH_API_KEY: "test-key" },
      fetch: async (_input, init) => {
        serperQuery = JSON.parse(init.body).q;
        return new Response(JSON.stringify({ organic: [{ title: "AI coding keypad", link: "https://example.com/keypad", snippet: "Voice and accept controls" }] }));
      },
    });
    assert.equal(serperQuery, query);
    assert.equal(serper.query, query);
    let duckQuery;
    const duck = await webSearch(query, 5, {
      env: {},
      fetch: async (input) => {
        duckQuery = new URL(input).searchParams.get("q");
        return new Response('<div class="result results_links_deep"><a class="result__a" href="https://example.com/keypad">AI coding keypad</a><a class="result__snippet">Voice and accept controls</a></div>');
      },
    });
    assert.equal(duckQuery, query);
    assert.equal(duck.query, query);
    assert.equal(duck.results[0].url, serper.results[0].url);
  }
});

test("web search falls back to DuckDuckGo when Serper is not configured", async () => {
  let requestedUrl = "";
  const result = await webSearch("product reference", 3, {
    env: { DREAMATIC_SEARCH_API_KEY: "an-unused-key-without-a-selected-provider" },
    fetch: async (input) => {
      requestedUrl = String(input);
      return new Response(`<div class="result results_links_deep"><a class="result__a" href="https://example.com/reference">Reference</a><a class="result__snippet">Useful precedent</a></div>`, { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  assert.equal(result.provider, "duckduckgo");
  assert.equal(result.count, 1);
  assert.match(requestedUrl, /^https:\/\/html\.duckduckgo\.com\/html\/\?q=product\+reference$/);
});

test("research fetch rejects HTTP 200 verification pages and binary PDFs without caching false evidence", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-blocked-evidence-"));
  try {
    const blockedPages = [
      '<html><title>Checking your browser - reCAPTCHA</title><body>Checking your browser before accessing pmc.ncbi.nlm.nih.gov</body></html>',
      "<html><body>JavaScript is disabled. In order to continue, we need to verify that you're not a robot. This requires JavaScript.</body></html>",
      '<html><title>Just a moment...</title><body>Enable JavaScript and cookies to continue</body></html>',
      '<html><title>Making sure you\'re not a bot!</title><body>Protected by Anubis<img src="/challenge.webp"></body></html>',
      '<html><body>Making sure you’re not a bot! Please wait.</body></html>',
    ];
    for (const [index, page] of blockedPages.entries()) {
      let requests = 0;
      await assert.rejects(researchFetch(workspace, { runId: "demo", id: `blocked-${index}`, url: "https://example.com/article", cacheText: true }, {
        fetch: async () => { requests += 1; return new Response(page, { headers: { "content-type": "text/html" } }); },
      }), /access-verification page/);
      assert.equal(requests, 1);
      await assert.rejects(readFile(join(workspace, `runs/demo/research/sources/blocked-${index}.txt`)), /ENOENT/);
    }
    await assert.rejects(researchFetch(workspace, { runId: "demo", id: "pdf", url: "https://example.com/paper.pdf", cacheText: true }, {
      fetch: async () => new Response("%PDF-1.7 binary", { headers: { "content-type": "application/pdf" } }),
    }), /cannot extract PDF text/);
    const valid = await researchFetch(workspace, { runId: "demo", url: "https://example.com/paper" }, {
      fetch: async () => new Response('<html><title>Muscle lattice actuators</title><body>Artificial muscle actuator with a cellular lattice. This article also discusses CAPTCHA experiments and the Anubis software.</body></html>', { headers: { "content-type": "text/html" } }),
    });
    assert.equal(valid.ok, true);
    assert.match(valid.text, /cellular lattice/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("reference discovery rejects Anubis pages rather than retaining their illustrations", async () => {
  await assert.rejects(discoverResearchAssets("https://example.com/paper", 4, {
    fetch: async () => new Response('<title>Making sure you\'re not a bot!</title><img src="/challenge.webp">'),
  }), /access-verification page/);
});

test("reference discovery uses figure captions and high resolution images instead of thumbnails", async () => {
  const result = await discoverResearchAssets("https://example.com/articles/paper", 2, {
    focusTerms: ["lattice", "contraction"],
    fetch: async () => new Response(`<img src="/robot.jpg" alt="Humanoid robot">
      <figure id="fig-1"><a href="/figures/cell-full.png"><img src="/cell-thumb.png" width="88" height="49" alt="Cell"></a>
      <figcaption>Figure 1. Fabric-lattice artificial muscle contraction.</figcaption></figure>
      <figure id="fig-2"><img src="/states-thumb.jpg" srcset="/states-small.jpg 320w, /states-large.jpg 1600w" width="88" height="49">
      <figcaption>Figure 2. Lattice deformation states.</figcaption></figure>`),
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.url), ["https://example.com/figures/cell-full.png", "https://example.com/states-large.jpg"]);
  assert.equal(result.candidates[0].source, "figure");
  assert.equal(result.candidates[0].figureId, "fig-1");
  assert.match(result.candidates[0].caption, /Fabric-lattice/);
  assert.equal(result.candidates[0].visual_review_status, "unreviewed");
});

test("reference discovery resolves picture and lazy srcsets while excluding private image links", async () => {
  const result = await discoverResearchAssets("https://example.com/paper", 4, {
    fetch: async () => new Response(`<picture><source srcset="/figure-small.webp 1x, /figure-large.webp 2x"><img src="/fallback.jpg" alt="Actuator"></picture>
      <img data-srcset="/lazy-small.png 320w, /lazy-full.png 1200w" src="/loading.gif">
      <figure><a href="http://127.0.0.1/private.png"><img src="/preview.png"></a><figcaption>Structure</figcaption></figure>`),
  });
  assert.ok(result.candidates.some((candidate) => candidate.url === "https://example.com/figure-large.webp"));
  assert.ok(result.candidates.some((candidate) => candidate.url === "https://example.com/lazy-full.png"));
  assert.ok(result.candidates.every((candidate) => new URL(candidate.url).hostname === "example.com"));
});

test("reference discovery excludes advertising and newsletter banners, not relevant structural figures", async () => {
  const result = await discoverResearchAssets("https://example.com/paper", 3, {
    focusTerms: ["muscle", "lattice"],
    fetch: async () => new Response('<img src="/ad-banner/advert-banner_LG.png" alt="CORDIS Newsletter"><img src="/newsletter.jpg"><img src="/figure1.png" alt="Artificial muscle lattice deformation">'),
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.url), ["https://example.com/figure1.png"]);
  assert.equal(result.excluded.length, 2);
  const requested = await discoverResearchAssets("https://example.com/newsletter", 2, {
    focusTerms: ["newsletter"],
    fetch: async () => new Response('<img src="/newsletter.jpg" alt="Newsletter layout reference">'),
  });
  assert.equal(requested.count, 1);
});

test("research fetch accepts a Markdown-wrapped URL and sends browser-compatible headers", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-fetch-url-"));
  let request;
  try {
    const result = await researchFetch(workspace, {
      runId: "test-run",
      url: "[NASA](https://www.nasa.gov/lunar-surface-technology/)",
    }, {
      fetch: async (input, init) => {
        request = { url: String(input), headers: new Headers(init.headers) };
        return new Response("<html><title>Lunar technology</title><body>Evidence</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    });
    assert.equal(request.url, "https://www.nasa.gov/lunar-surface-technology/");
    assert.match(request.headers.get("User-Agent"), /Mozilla\/5\.0/);
    assert.equal(request.headers.get("Accept-Language"), "en-US,en;q=0.9");
    assert.equal(result.title, "Lunar technology");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("research asset validation creates a durable health report", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "dreamatic-research-"));
  try {
    const directory = join(workspace, "runs", "test-run", "research", "assets");
    await mkdir(directory, { recursive: true });
    const bytes = Buffer.alloc(9_000, 7);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(directory, "reference.png"), bytes);
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ assets: [{
      id: "reference",
      file: "reference.png",
      mime_type: "image/png",
      bytes: bytes.length,
      sha256,
      source_url: "https://example.com/reference.png",
      kind: "peer",
      description: "Reference",
      do_not_replace: false,
      allowed_for_edit: true,
      fetched_at: new Date().toISOString(),
    }] }));
    const result = await validateResearchAssets(workspace, { runId: "test-run", minUsableAssets: 1 });
    assert.equal(result.validation.ready, true);
    assert.equal(result.validation.summary.usable_assets, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
