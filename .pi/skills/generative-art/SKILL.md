---
name: generative-art
description: "Develop algorithmic artwork and procedural motifs through reproducible rules, bounded variation and native browser drawing. Supporting knowledge for generative visuals and interactive art, not an engineering simulation."
metadata:
  audience: designer
  domain_type: generative_art
  design_categories: []
  module_type: cross_domain
  supported_outputs: [image, html]
  version: "1.0"
---

# Generative Art

Translate a concept into a visual process: what repeats, what changes, what
interacts and what constrains the result. Apply this when procedural behavior
adds meaning to artwork, identity motifs or surface-pattern concepts.

## Choose the mechanism

Connect rules to the subject: directional fields can convey flow, subdivision
can articulate growth, and controlled packing can express aggregation. These
are options rather than a pattern menu. Define hierarchy, palette, density and
negative space so variation has a coherent character. Derive original rules
from the brief rather than impersonating an artist's recognizable composition.

## Make variation reproducible

For authored procedural HTML, store an explicit seed and initialize a deterministic
random generator for each regeneration. Separate parameters, generation and
rendering; time and frame rate must not secretly change a supposedly static
seeded result. Bound recursion, element count and input ranges. Specify whether
resizing preserves the composition or deliberately regenerates it. Expose only
parameters that produce useful aesthetic changes, with an understandable reset.

## Deliver the actual medium

Use local JavaScript with native SVG or Canvas drawing for procedural HTML.
Designer authors the complete algorithm and presentation; Builder materializes
the approved sources. No remote drawing library, fixed vendor template or new
executor is required. Provide meaningful text alongside non-text art when needed;
animated work should have a still/reduced-motion path and bounded rendering work.

If image generation is the chosen medium, describe the visual rules and composition
in the prompt, but treat it as an illustrative result: it does not prove algorithmic
reproducibility, exact tiling or physical behavior. A browser's optional image-save
interaction does not itself create a packaged image deliverable; declare required
files through the existing supported execution methods.

Compare chosen variations for composition and character. Keep rules and parameter
decisions in the existing specification without an additional manifesto file.

## Method reference

[Anthropic: algorithmic art](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/algorithmic-art/SKILL.md).
