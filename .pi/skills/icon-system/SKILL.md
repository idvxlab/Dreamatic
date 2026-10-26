---
name: icon-system
description: "Design icon and pictogram families through coherent geometry, optical weight, semantic distinctions and use-size adaptation. Use for controls, explanations and visual symbols; distinguish concept studies from verified vector geometry."
metadata:
  dreamatic-roles: "designer"
  dreamatic-domain: "icon_system"
  dreamatic-categories: ""
  dreamatic-module: "cross_domain"
  dreamatic-capabilities: "icon-design pictograms optical-alignment svg-authoring"
  dreamatic-outputs: "image html"
  version: "2.1"
---

# Icon System

Begin with the meanings the family must convey. Separate object symbols, actions,
states and navigation; visual similarity should not conceal different consequences.
Pair unfamiliar or ambiguous pictograms with words. Do not assume a symbol has
the same meaning across cultures or specialist domains.

## Establish family geometry

Define a working grid, occupied area, stroke/fill treatment, corner character and
detail level. These guide a consistent family without forcing every silhouette
into the same bounding box. Correct circles, diagonals and dense shapes optically
so they appear equally substantial. Preserve distinguishing features between
related symbols; an action overlay must remain readable at its actual size.

## Design at the use size

Inspect the smallest intended presentation before adding fine detail. Simplify
interior gaps and intersections when scaling would merge them. A small control
icon and a large explanatory pictogram may need related, separately tuned geometry.
Keep focus/selected/error cues readable beside the icon; meaning cannot depend
only on its color. The clickable area can be larger than the visible symbol.

## Express deterministically where needed

For precise interface symbols, specify a consistent viewBox and theme-aware colors.
When a vector-authoring host is available, realize and inspect the SVG geometry.
Image-only hosts provide concept studies and cannot establish editable vectors. A
decorative SVG should be hidden from assistive technology; an icon-only control
needs a meaningful accessible name on the control. Informative standalone
graphics need appropriate text alternatives. Avoid duplicate announcements.

For illustration-like symbol studies, image generation may express the intended
style, but it does not establish production SVG geometry. Keep the requested
delivery format explicit and do not promise an unimplemented vector export.
Judge coherence, distinction and legibility across the actual family, rather
than merely evaluating one attractive sample.

## Method reference

[UI UX Pro Max: icon design](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/50d8a7de0900119855614541f15a1a616691eb33/.claude/skills/design/references/icon-design.md).
