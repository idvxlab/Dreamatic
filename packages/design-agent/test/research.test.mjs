import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { researchFetch, validateResearchAssets, webSearch } from "../dist/index.js";

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
