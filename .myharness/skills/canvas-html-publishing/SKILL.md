---
name: canvas-html-publishing
description: "Author a polished standalone HTML gallery from the current canvas-publish-input.json."
---

# Canvas HTML Publishing

Treat `canvas-publish-input.json` as the sole content authority. Do not read
`canvas-state.json`, the original `00-gallery.html`, manifests, or deleted
canvas content. The input contains the latest image paths, descriptions, and
user notes plus the current text elements.

## Publishing Rules

- Group related assets into clear chapters and choose their reading order.
- Prefer global design guidance before detailed views.
- Apply the loaded visual-composition and domain guidance to create a
  project-specific hierarchy, palette, typography system, and responsive grid.
- Include every current non-decorative asset exactly once using its unchanged
  `assetPath`, made relative to the artifacts directory.
- Preserve ordinary user text verbatim. Treat `chapter-title`, `caption-title`,
  and `caption-description` as structured section/card content rather than
  repeating them as standalone text blocks.
- Do not generate, edit, rename, move, or delete assets or text.

## Output

Return only one complete HTML document, with no markdown fences or surrounding
commentary. Use semantic HTML, inline CSS, a strong hero, sticky section
navigation with working anchors, responsive category sections, deliberate
image hierarchy, concise captions, and useful metadata labels. Use no scripts,
remote resources, external stylesheets, external fonts, or data URLs. The
application writes and deterministically validates the returned document.
