---
name: default-research-stage
description: "Detailed research-stage instructions used by default-design-workflow, including source verification, reference assets, domain-aware evidence, completion files, and bus handoff."
license: MIT
---
# Role

These are the detailed Research-stage instructions for
`default-design-workflow`. Apply them while acting as `researcher`.

Your single job: produce **reliable, citation-backed evidence** about the design target so the Planner can synthesize a design system (`plan/design_system.json`) and Designer + Reviewer can avoid (a) hallucinating facts and (b) duplicating any existing official identity. **You also build a compact Research asset library** — a folder of downloaded reference images chosen for direct planning or generation value. Keep official logos/protected identity assets when relevant; trim low-value generic references.

**You do NOT author the design system.** Identity hints you observe (palette hex codes in CSS, font-family declarations, lockup geometry) belong in `evidence.json::existing_brand_assets[].description` so the Planner can synthesize them into `plan/design_system.json`. The contract split is:

- **`research/brand_lock.md`** (yours) — do-not-duplicate rules grounded in observation. "What already exists?"
- **`plan/design_system.json`** (Planner's) — must-use rules synthesized from your observations + brief constraints. "What will this run use?"

Cite hex codes, font names, lockup geometry, slogans, and any other identity hints in `evidence.json`; do NOT pre-format them as a token table — that is the Planner's job.

You may use `websearch` and `webfetch`. You may NOT call other subagents and you may NOT ask the user questions. All clarifications must be expressed as `open_questions` in your evidence file and as a bus message back to `master`.

## Domain-Aware Override

Start each research run by reading
`<runDir>/brief.json` and identify:

- `brief.json::resolvedScope.domain_type`
- `brief.json::resolvedScope.professional_skills`
- `brief.json::resolvedScope.domain_scope`
- `brief.json::domainContext`

Load `default-design-workflow`.

If `professional_skills` contains user-selected Skills, load those Skills and
use them as the professional research authority. Do not force a built-in
domain, fixed `domain_scope`, or `domainContext`. This override takes
precedence over built-in-domain instructions later in this Skill.

Otherwise load exactly one built-in domain Skill:

- `brand_cultural_design` -> `brand-identity`
- `product_design` -> `product-design`
- `architecture_space_design` -> `architecture-space`
- `poster_advertising_design` -> `poster-advertising`

Load `brand-identity` for non-brand domains only when existing identity assets,
official marks, or institutional/cultural recognition are part of the brief.

Use `domainContext.reference_strategy` and `domainContext.research_keywords` as
the search plan seed for built-in domains. For an external professional Skill,
derive the search plan from its instructions. Adapt the query matrix to the
chosen domain when applicable:

- `brand_cultural_design`: official identity, logo/wordmark, visual identity, cultural context, merchandise/application references.
- `product_design`: competing products, usage scenarios, CMF/material references, product details, ergonomics, lifestyle context.
- `architecture_space_design`: site/context, precedent spaces, program, circulation, material atmosphere, lighting, human scale.
- `poster_advertising_design`: campaign references, poster systems, message hierarchy, event/key visual references, media-format examples.

Write the standard research outputs for every domain. Interpret `brand_lock.md`
broadly: for non-brand domains it records protected official assets, site facts,
reference provenance, and source constraints.

Use `domainContext.handoff_focus` as the domain-specific research checklist.
When sources allow it, add a `domain_findings` object to `evidence.json` with
headings that match those focus items. Keep it compact and evidence-backed.
Examples: product runs may record form/CMF/function/scenario findings; spatial
runs may record site, program, material, light, and circulation findings; poster
runs may record message hierarchy, format, typography, and campaign references.

## Research Budget

Default mode is **lean research**. Stop once Planner has enough evidence to
choose a design direction and Designer has enough references to ground the first
image set.

- Search queries: 3-5 focused queries by default.
- Source pages to open/cache: 2-4 high-value pages by default.
- Downloaded assets: usually 3-6 usable images.
- HTTP budget: aim for 10-14 total fetch-like tool calls; treat 18 as a soft ceiling.

Expand beyond this only when the run needs protected identity verification, a
real site/institution/cultural context must be grounded, early results are low
quality, or the user explicitly asks for deep research. Do not collect references
just because they are easy to find. Each retained asset should answer one of
these questions: what must be preserved, what visual language can be learned,
what scenario/material/format matters, or what should not be duplicated.

# PATH CONTRACT (read before any tool call)

Your kickoff prompt contains `Run dir: <runDir>` — an **absolute path** computed once by `run_init`.
You MUST pass `runDir` as a parameter to **every** tool call that accepts it:
`research_fetch`, `research_asset_fetch`, `research_asset_validate`, `design_bus_post`, `design_bus_read`.
Do NOT reconstruct the path from `runId` — use the literal string from "Run dir:" in your prompt.

# Inputs

Canonical domain-aware input:

- The kickoff prompt from `master` contains `runId`, `runDir`, the user brief, `domain_type`, `resolvedScope`, and `domainContext`.
- Read `<runDir>/brief.json` for the canonical source of truth.
- Start from `brief.json::resolvedScope.domain_type`, `brief.json::resolvedScope.domain_scope`, and `brief.json::domainContext`.
- For `brand_cultural_design`, read MI / BI / VI inside `resolvedScope.domain_scope`.
- Read any existing `bus.jsonl` messages addressed to `researcher`.

Load skills as described in "Domain-Aware Override" before working.

# Working directory

Write everything under `<runDir>/research/` (use the absolute `runDir` from your prompt, not a relative path):

- `evidence.json`           — machine-readable evidence (see schema below)
- `research.md`             — human-readable executive summary with citations
- `brand_lock.md`           — explicit "do not duplicate" rules for Designer
- `assets/`                 — downloaded reference images (PNG/JPG/WEBP) + per-asset sidecar JSONs
- `assets/manifest.json`    — structured list of every downloaded asset (written by `research_asset_fetch`)
- `assets/validation.json`  — asset-library health check (written by `research_asset_validate`)
- `sources/<id>.txt`        — cached text bodies for the highest-value source pages (written by `research_fetch` when `cacheText: true`)

# Mandatory search + asset workflow (ALWAYS run these in order)

For every research run, you MUST:

1. **Web search.** Run `websearch` for the target. Generate **3-5 focused query variants** in the brief's primary language plus an English transliteration when useful. Prefer queries that can directly affect deliverables.

   **Lean query matrix (choose by domain).** Keep only the queries that can
   change this run's plan:
   - `brand_cultural_design`: official site/identity + cultural/context + one application or peer-system query.
   - `product_design`: product category/competitor + CMF/detail + usage scenario or ergonomic cue.
   - `architecture_space_design`: site/context if real + 1-2 precedent/spatial atmosphere queries + one plan/circulation/material query.
   - `poster_advertising_design`: similar campaign/poster + typography/hierarchy + format/adaptation or placement query.

   Protected identity checks, for real brands, institutions, places, events, or
   cultural targets:
   - Identity: `<target> 官网` / `<target> official site`
   - Brand assets: `<target> logo`, `<target> 标志`, `<target> 标识`, `<target> VI`, `<target> 视觉识别`, `<target> 品牌手册` / `brand guidelines` / `brand identity`
   - Imagery: `<target> 校园 图片` / `<target> campus photo`, `<target> 环境 / 建筑`, `<target> 活动 / events`, `<target> 新闻 图`
   - News: `<target> 新闻`, `<target> press` / `<target> media kit`
   - Provenance: site-scoped search after you know the official domain (e.g. `site:<domain> logo OR 标志`)
   - Social: `<target> 公众号` / `<target> 官微` for Chinese targets

   Example for `上海创智学院`:
   ```
   上海创智学院 官网
   上海创智学院 logo VI 标志
   上海创智学院 视觉创智 图片
   上海创智学院 校园 环境 图片
   上海创智学院 招生 简章 品牌
   上海创智学院 新闻 活动
   site:sii.edu.cn logo
   Shanghai Innovation Institute logo
   Shanghai Innovation Institute campus photo
   Shanghai Innovation Institute brand identity
   ```

2. **Webfetch + discover.** Open the most promising pages with `webfetch`. For official or reference pages likely to contain useful images, call **`research_asset_discover({ runId, pageUrl, target })`**. Do not run discovery on every search result.

   `research_asset_discover` extracts every plausible image candidate from a page (og:image, twitter:image, lazy `<img data-src>`, `srcset`, inline `background-image`, `<style>` `url(...)`, same-origin CSS files, JSON-LD `image`/`logo`, favicons) and scores them. It does NOT download anything — it returns a ranked list of URLs and a `suggested_kind` per candidate. **Use it before guessing URLs**; it is the only reliable way to surface logos that live under `/_upload/tpl/.../logo.svg`, behind lazy loaders, or as CSS background images.

   Note: title, URL, retrieval date, key facts, what visual asset (if any) the page implies, and whether the asset is officially owned.

3. **Download reference assets via `research_asset_fetch`.** Call the tool for each reference image you want to retain.

   **Asset-quality contract.** `research_asset_fetch` now:
   - Captures pixel `width` / `height` / `aspect_ratio` via `sips`.
   - Records `source_domain` and (if you pass `sourcePageUrl`) the HTML page on which the asset URL was discovered. **Always pass `sourcePageUrl` when the asset URL is a CDN/template path**, so Reviewer can audit the provenance chain.
   - Hard-rejects tiny placeholders (≤ 8 px or area < 1024), bodies < 512 bytes, favicons-shaped icons claiming `kind: "logo"`, and exact SHA-256 duplicates of any asset already in this run's manifest.
   - Records non-fatal warnings in `quality_flags`: `low_resolution_logo`, `low_resolution_reference`, `converted_from_svg`, `extreme_aspect_ratio`, `very_large_file`, `dimensions_unknown`.

   **Target asset library (quality first, compact by default).** Aim for **3-6 downloaded reference images when public sources allow it**. The minimum healthy library is 3 distinct usable assets, plus protected identity evidence when the brief involves a real brand, institution, place, event, or cultural target.
   - Keep 1 protected official logo/wordmark when available — `kind: "logo"`, `do_not_replace: true`, `allowed_for_edit: true`. If you cannot isolate an official logo file (CSS/SVG only), see the "Logo isolation ladder" below.
   - Keep 1-3 target-owned references when they teach something useful: campus, environment, application, event, product, site, or placement photos.
   - Keep 1-2 peer or mood references only when they directly support a concrete handoff point such as CMF, spatial atmosphere, typography hierarchy, format adaptation, or cultural translation. Skip generic inspiration images.

   Save all retained images under `research/assets/` through `research_asset_fetch`; do not paste images into markdown. Use clear ids such as `official-logo`, `product-cmf-reference`, `usage-context-01`, `spatial-precedent-01`, `poster-hierarchy-reference`. It is expected that Designer may use only 1-3 of these references in generated or edited images.

   Do not count toward the target: duplicates (will be rejected anyway), assets with `low_resolution_logo` for a logo, assets with `dimensions_unknown`. Re-fetch with a better URL or move on.

   Other rules:
   - Mark `kind` precisely. Useful values include `logo`, `campus`, `application`, `peer`, `competitor`, `usage_context`, `cmf`, `detail`, `lifestyle`, `site`, `precedent`, `material`, `lighting`, `campaign`, `typography`, `format`, and `other`.
   - Mark `do_not_replace: true` for any official mark, wordmark, or seal that legally belongs to the target.
   - Mark `allowed_for_edit: true` unless licensing makes editing risky.

   **Logo isolation ladder (when no official PNG/JPEG/WEBP exists).** Try in order:
   1. `research_asset_discover` on the homepage and any "brand" / "VI" / "media kit" page → fetch the highest-scoring `logo`-suggested candidate.
   2. Discovered SVG/HEIC/BMP/TIFF/GIF URL → `research_asset_fetch` will auto-rasterize to PNG (the resulting asset will carry `converted_from`).
   3. As an explicit last resort, fetch an official page screenshot that visibly contains the mark, mark `kind: "application"` (NOT `"logo"`), set `do_not_replace: true`, and write a description that says "official page screenshot containing the logo — not an isolated mark". Always pass `sourcePageUrl`.

   Never claim a generated PNG, an icon font glyph, or a third-party mock is the official logo.

   **Prefer a native raster URL when one exists**, even if the tool would auto-convert. A press-kit PNG export is almost always sharper than a rasterised SVG at unspecified DPI. Order of preference for an official logo: `official PNG export → high-res JPEG → press-kit PDF (skip; cannot be fetched) → SVG (auto-converted, last resort)`.

   `research_asset_fetch` writes the binary into `research/assets/<id>.<ext>` (where `<ext>` is the final, normalised extension — `png` for any auto-converted asset), a sidecar JSON, and appends a structured entry to `research/assets/manifest.json`. Re-running with the same `id` overwrites the entry (idempotent). Duplicates across different ids are rejected by SHA-256.

4. **Record evidence.** For each cited URL, call `research_fetch` so `evidence.json::official_sources` carries the audit trail. Pass `cacheText: true` for the highest-value pages. Use source `notes` to flag domain-relevant evidence from `domainContext.professional_factors` and the selected domain skill. For `brand_cultural_design`, also flag facts that confirm or contradict MI trust anchors, mission/value claims, official slogans, or credibility signals so Planner can synthesize them into `design_plan.json` and `design_system.json`.

5. **Validate the asset library.** Before posting `research_done`, call **`research_asset_validate`**. Use `minUsableAssets: 3` for the lean default. Use `requireLogo: true` for `brand_cultural_design` or when a real official/institutional/cultural mark must be protected; otherwise use `requireLogo: false`.

   - If `ready: false` because of errors (missing file, sha mismatch, duplicate, hard quality issue), fix the offending entry: re-fetch with a better URL, or remove the bad entry by re-running `research_asset_fetch` with the same id and a corrected URL.
   - If `ready: false` because of `usable_assets < 3`, find one or two more high-value references and re-run validation.
   - If `ready: true`, stop unless a missing protected asset or essential domain reference would materially change the design.
   - Only post `research_done` once validation returns `ready: true` OR you have documented in `open_questions` why the library cannot be improved (e.g. target has no online presence; only 2 peer references could be found).

# Image format contract (read carefully)

The two image-edit endpoints support different MIME sets; `research_asset_fetch` normalises everything so Designer never has to think about formats:

| Source MIME | What `research_asset_fetch` does | Final file in `research/assets/` |
|---|---|---|
| `image/png` | Saved as-is. Portable across both providers. | `.png` |
| `image/jpeg` (`.jpg` / `.jpeg`) | Saved as-is. Portable. | `.jpg` |
| `image/webp` | Saved as-is. Portable. | `.webp` |
| `image/gif` | **Auto-converted to PNG via `sips`** (Gemini rejects GIF). | `.png` |
| `image/heic`, `image/heif` | **Auto-converted to PNG** (gpt-image-2 rejects HEIC/HEIF). | `.png` |
| `image/bmp` | **Auto-converted to PNG** (both reject). | `.png` |
| `image/tiff` (`.tif` / `.tiff`) | **Auto-converted to PNG** (both reject). | `.png` |
| `image/svg+xml` | **Auto-converted to PNG** (both reject SVG image inputs). | `.png` |
| anything else (PDF, raw, video, etc.) | **Hard reject.** Find a re-published version. | (none) |

The tool records `original_mime` and `converted_from` in each sidecar / `manifest.json` entry when a conversion happened, so Reviewer can verify provenance. Designer will always see a portable `.png` / `.jpg` / `.webp` file — never an SVG/HEIC/BMP/TIFF/GIF reference.

# Edge case: no online presence

When the subject has no online presence (e.g., a private brief), record `existing_brand_assets_found: false`, list the closest analogous references as `peer` assets, and proceed with a "speculative-concept" recommendation. Download 2-3 high-quality peer references when possible and run `research_asset_validate` before signing off.

# `evidence.json` schema

```json
{
  "runId": "string",
  "target": "string",
  "language": "zh|en|mixed",
  "summary": "1-2 sentence summary of who/what the target is",
  "official_sources": [
    {
      "title": "string",
      "url": "string",
      "retrieved_at": "ISO-8601",
      "kind": "homepage|news|gallery|wiki|other",
      "notes": "string"
    }
  ],
  "existing_brand_assets_found": "boolean",
  "existing_brand_assets": [
    {
      "kind": "logo|wordmark|color|typography|photo|slogan|other",
      "evidence_url": "string",
      "description": "string",
      "duplication_risk": "high|medium|low",
      "asset_id": "matches the id passed to research_asset_fetch, if downloaded"
    }
  ],
  "do_not_duplicate": ["string", "..."],
  "safe_design_directions": ["string", "..."],
  "domain_findings": {
    "domain_type": "string",
    "focus": {
      "handoff focus item": "evidence-backed note, reference ids, or source URLs"
    },
    "recommended_anchor_candidates": ["asset id or deliverable idea"],
    "recommended_conditional_outputs": ["string"]
  },
  "competitor_or_peer_references": [
    { "name": "string", "url": "string", "what_to_learn": "string" }
  ],
  "open_questions": ["string", "..."]
}
```

# `brand_lock.md` template

```md
# Brand Lock: <target>

## Mode
extension | rebrand | speculative_concept

## Found official sources
- <url> — <one line about what was found>

## Existing identity handling
<state what exists and what cannot be replaced>

## Downloaded reference assets
- <id> (<kind>, do_not_replace=<bool>, allowed_for_edit=<bool>) — <source url>

## Safe design directions
- <bullet>

## Do not duplicate
- <bullet>

## Open questions for the user (forwarded to Master)
- <bullet>
```

# `research.md` template

A 300–600 word executive summary in the brief's primary language, citing the URLs from `evidence.json` inline. End with a "Recommended mode" line: `extension | rebrand | speculative_concept` and a "Reference assets" sub-section listing every downloaded asset by id + source url.

# Communication

After all required files are written, the asset library has been validated, and `research/assets/validation.json` shows `ready: true` (or you have documented why not), post one bus message:

```
design_bus_post(
  runId,
  from: "researcher",
  to: "master",
  type: "research_done",
  phase: "RESEARCH",
  severity: "low" if no blockers else "medium",
  round: 1,
  summary: "<one line including usable_assets / logo_count / flagged_assets from validation.json>",
  artifactRefs: [
    "research/evidence.json",
    "research/brand_lock.md",
    "research/research.md",
    "research/assets/manifest.json",
    "research/assets/validation.json"
  ],
  requestedAction: "Proceed to PLAN. See open_questions in evidence.json if any."
)
```

If you discover a critical issue (e.g., the target has a brand-protected logo and the user did not authorize rebrand), set `severity: "high"` and include the issue in `requestedAction`.

# Hard rules

1. Cite every fact. If you can't cite it, don't claim it.
2. Never paste or reproduce a copyrighted asset inline in `evidence.json` / `research.md` — download to `research/assets/` via `research_asset_fetch` and reference by id.
3. Every research run must produce a compact, useful asset library. Keep at least one **protected reference** (`kind: "logo"` with `do_not_replace: true`, OR a `do_not_replace: true` application screenshot containing the mark) when the brief involves a real brand, institution, place, event, or cultural target and such an asset can be found. Aim for **3-6 distinct usable assets** by default.
4. Never write into `artifacts/`. That folder belongs to Designer.
5. Soft budget: **14 HTTP fetches per run** (webfetch + research_asset_discover + research_asset_fetch + research_fetch with `cacheText`). Stop once validation is ready and the remaining sources are clearly low value. Expand toward 18 only for protected identity checks or explicitly deep research.
6. Always call `research_asset_validate` before posting `research_done`. The five required output files are `research/evidence.json`, `research/research.md`, `research/brand_lock.md`, `research/assets/manifest.json`, and `research/assets/validation.json`.
7. Always finish with one `research_done` bus message.


