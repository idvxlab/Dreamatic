---
name: visual-composition
description: "Layout, grid, hierarchy, color contrast and whitespace principles for graphic deliverables. Used by Designer to describe composition in image_edit / image_generate prompts and in the 00-gallery.html layout so the rendered PNGs look intentional, not AI-generated."
license: MIT
metadata:
  audience: design-designer
  workflow: ai-design-harness
---

# Visual Composition Skill

## 1. Hierarchy: one focal point, one supporting layer, one ambient layer

Every composition should resolve into three layers:

1. **Focal** — what the eye lands on first. Largest scale, highest contrast, or most saturated. Exactly one.
2. **Supporting** — what the eye reads second. Mid-scale, anchors the focal point in context.
3. **Ambient** — texture, grid, fields of color, supporting type. Provides rhythm without competing.

A composition with three focal points has zero.

## 2. Grid systems

- For HTML deliverables, use CSS Grid with 12 columns and a 1.5rem gutter as a sane default. Don't reinvent.
- For posters at 1080×1920, use a 6-column safe-area grid with 64px outer margins.
- For social cards at 1080×1080, use a 4-column or 6-column grid, anchored at thirds.
- Always declare gutter and column width as CSS variables. Do not hardcode `gap: 24px` six times in one file.

## 3. Type scale

A modular scale grounded in a base of 16px (1rem):

```
xs:   12  /  0.75rem
sm:   14  /  0.875rem
base: 16  /  1rem
md:   20  /  1.25rem
lg:   28  /  1.75rem
xl:   40  /  2.5rem
2xl:  56  /  3.5rem
3xl:  80  /  5rem
4xl:  112 / 7rem      (display only)
```

Use no more than 4 sizes in a single composition. Headline / sub / body / caption is plenty.

## 4. Contrast

- Body text on background: aim for ≥ 7.0 contrast ratio (AAA).
- Display text on background: ≥ 4.5 (AA).
- Decorative type may be lower, but only when redundant with stronger text.
- Never set 50% gray text on a 50% gray background "for vibes".

## 5. Whitespace

Whitespace is not absence; it is *negative form*. Composition rules:

- The outer margin should be ≥ the largest gutter inside the composition.
- The space between unrelated elements should be larger than the space between related ones.
- A headline and its kicker should sit closer together than the headline and the body that follows.

## 6. Color application

- Establish a primary surface (background) and a primary ink (text). Everything else is accent or system.
- Use the accent color for **at most 5%** of the visual area. It is a punctuation mark, not a flood.
- For multi-card sets (social campaign), give each card the *same* system but a *different* hero color drawn from a small ramp of the primary; rotate, don't randomize.

## 7. HTML deliverable patterns

### Self-contained shell

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>...</title>
  <style>
    :root { --ink: #0d1117; --paper: #f7f5f0; --accent: #c8302a; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "PingFang SC", "Source Han Sans", system-ui, sans-serif; color: var(--ink); background: var(--paper); }
  </style>
</head>
<body>
  <!-- content -->
</body>
</html>
```

No external CSS or JS. Inline `<style>`. Reference local images via `generated-images/<name>.png` only.

### Poster grid (1080×1920)

```html
<main class="poster">
  <img class="hero" src="generated-images/poster-hero.png" alt="...">
  <header class="lockup">...</header>
  <h1 class="headline">...</h1>
  <p class="kicker">...</p>
  <footer class="meta">...</footer>
</main>
```

Drive the grid with CSS Grid `grid-template-rows: auto 1fr auto auto auto;` and use percentage-based margins so the layout scales to any export size.

## 8. Common composition failures (auto-flag)

- Headline and image fighting for the same area
- Caption that's larger than necessary, killing hierarchy
- Three different accent colors instead of one
- Body paragraphs without leading
- Anything center-aligned without an asymmetric counterweight
- Generated image stretched (aspect-ratio mismatch with container)

If you spot any of these in your output, fix before posting `design_done`.
