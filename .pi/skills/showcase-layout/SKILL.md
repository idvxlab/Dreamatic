---
name: showcase-layout
description: "Builder guidance for responsive HTML showcases of approved design works: thematic grouping, weighted image layouts, typography hierarchy, compact reference galleries and academic citations."
metadata:
  audience: builder
  domain_type: showcase_presentation
  design_categories: []
  module_type: presentation
  supported_outputs: [gallery]
---

# Showcase Layout

Use before Builder authors or revises `artifacts/00-gallery.html`. Present the
approved work; design its presentation without redesigning or regenerating the
delivered works. This independent module needs no other Skill. User intent and the Agent
contract govern scope and completion; unavailable Skills never block delivery.

## Organize the story

Read the approved plan, deliverable purposes and available `showcase` copy from
the current Design Context. Respect explicit grouping, priorities and supplied
copy. Otherwise choose meaningful themes and presentation weights from approved
intent and deliverable purposes, and write faithful descriptions and a summary.
Missing optional presentation instructions do not require another design approval.
Do not omit supporting images to make a shorter page.

Use this reading order: project title and overall work description; every delivered
image with a distinct caption in thematic sections; collection conclusion; compact
reference library; bibliography. Choose themes that clarify the approved work. Do not impose the same categories on every design discipline,
split single works into artificial themes or create empty sections.

Each theme has a semantic `<section>`, a visible `<h2>` and a separator rule.
Use `<h3>` only for real subthemes, not every image. A concise theme introduction
can explain the relationship between works without revealing internal reasoning.
Captions describe the design/view, distinguishing features and intended use;
never substitute prompts, scoring, retry logs or unverified performance claims.

## Weight and composition

Use three relative weights, adapting to aspect ratios and approved emphasis:
- Principal: establish the theme with a dominant hero or wide feature.
- Supporting: explain variants, interactions or key details in paired panels.
- Context: use smaller parallel panels for scenarios, comparisons and background.

Vary scale deliberately; avoid a wall of identical cards or making every image
full-width. One useful desktop grid is 12 columns: principal spans 8–12,
supporting 4–6, context 3–4. These are layout examples, not mandatory quotas or
limits on image count. Portrait works may need narrower columns; never stretch
or crop meaningful design details to fit a hero slot.

Use `minmax(0,1fr)`, `min-width:0` and fluid gutters. Preserve original aspect
ratios with `width:100%; height:auto`; use `object-fit:contain` for bounded
comparison panels. On narrow screens collapse to one readable column, retaining
the theme order and stronger principal-image emphasis. Prevent horizontal overflow.

## Typography and visual language

Reuse the approved palette, typography intent and visual treatment; do not impose
minimalism, maximalism, light/dark themes or large whitespace by default.
Clearly distinguish project title, theme heading, subheading, body and caption
through size, weight and spacing. For example, fluid title 36–72px, theme 24–32px,
subheading 18–22px, body 15–17px, work captions 13–14px; tune to the context.
Keep theme rules visible on the chosen background without competing with images.
Use local/system fonts, readable line lengths and accessible link/focus contrast.
Scope page styles to the work sections: broad `span`, `figure`, `img` or heading
rules must not override the runtime reference appendix.

## Interaction and references

Keep image Prompts out of visible captions. Finalization attaches exact-path
hover titles from actual generation records, or explicitly labeled plan fallback.
Do not invent prompts for manually authored works or references.

Finalization appends the reference library and IEEE-style bibliography from
existing research metadata. Do not duplicate it or author reserved appendix
markers. Reference thumbnails remain small and use local images; clicking opens
the original public source URL with `target="_blank" rel="noopener noreferrer"`.
Missing source URLs mean non-clickable thumbnails, never guessed URLs or navigation
to a local image in the current tab.

Visible reference descriptions are short previews clamped to two lines. Keep full
description/credits in hover and accessible metadata; focus must not expand the
caption or shift the grid. Keep numbered citation and source links separate and
visible. Preserve scholarly authors, titles, venue, publication date, volume,
issue, pages/article number, DOI/URL and recorded access date when available;
do not fabricate missing metadata, permissions or adoption claims.

## Deliver

Write complete standalone HTML with local images and inline/local CSS. Confirm
from markup that all approved works are included, thematic headings/rules and
weight classes are present, local paths are correct and reference styles are
isolated. This is layout implementation, not another image or design audit.
Then use `build_finalize` once; repair only named mechanical failures and preserve
completed images. Orchestrator packages this page and provides a text summary.
