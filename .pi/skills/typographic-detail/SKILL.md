---
name: typographic-detail
description: "Refine typography for multilingual text, long-form reading and dense data through script-aware spacing, optical alignment and responsive type. Use when typography details need work beyond basic composition; supports the selected visual direction in images and HTML rather than replacing publication or interface design."
metadata:
  audience: designer
  domain_type: typographic_detail
  design_categories: []
  module_type: cross_domain
  capabilities: [typography, typography-refinement, multilingual-typesetting, responsive-type]
  supported_outputs: [image, html]
  version: "1.0"
---

# Typographic Detail

Use when text carries the design's character or reading quality needs close
attention. Preserve the selected identity; refine its application rather than
introducing a new visual direction by changing fonts.

## Fit the actual language

Work with representative copy, including long titles, punctuation, numbers and
mixed scripts. Latin tracking, capitals and character-based measures do not
transfer directly to Chinese. Tune line height to glyph density and text role;
avoid stranded punctuation and awkward breaks between values and units. For
bilingual content establish language order and optical balance, rather than
giving both scripts identical numerical settings.

## Resolve small differences

Distinguish adjacent roles through weight, spacing, position and size together.
Inspect heading wraps, caption proximity, list indentation and repeated baselines.
Align figures optically where shapes demand it. Use tabular numerals for changing
readouts or aligned comparisons, proportional numerals for prose when appropriate.
Keep enough precision to interpret a quantity, without decorative decimal places.

## Survive real content

For HTML, use relative text sizes and bounded responsive display sizes; preserve
zoom and allow containers to grow. Choose available system families with fallback
coverage for the required scripts. Do not propose unavailable font files as if
they were supplied. Avoid fixed-height text blocks and truncation of essential
instructions. Consider narrow widths, expanded translations and missing weights.

For generated imagery, specify exact essential wording, hierarchy and readable
scale; do not claim exact glyph fidelity from a prompt alone. Keep lengthy exact
text in authored HTML when it must remain readable and selectable.

Carry the chosen roles and exceptions into the existing typography decisions.
Judge reading comfort using the actual content and medium, not a universal type
ratio or a mandatory number of font families.

## Method reference

[Impeccable: typeset](https://github.com/pbakaus/impeccable/blob/d631a8827f99414d2b6daba4ef08b7f8701751d7/.agents/skills/impeccable/reference/typeset.md).
