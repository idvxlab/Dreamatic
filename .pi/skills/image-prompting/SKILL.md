---
name: image-prompting
description: "Specify executable image-generation or image-editing prompts, references, consistency anchors, acceptance criteria, aspect ratios, and efficient output sizes."
license: MIT
metadata:
  audience: designer
  domain_type: image_execution_specification
---

# Image Prompting

Use this optional module to translate an approved design concept into precise image instructions. It defines intent for later execution; it does not call image tools.

## Choose the Method

Use generation for a new scene or artifact with no protected source that must remain exact. Use editing when the task must preserve an existing composition, product, logo, identity element, or consistency anchor. Identify every required reference and explain its role.

## Generation Prompt

Include the information that changes the result:

- subject, purpose, and design intent;
- composition, viewpoint, crop, and spatial relationships;
- defining form, material, color, light, typography, or environmental traits;
- context, human scale, interaction, or narrative cues when relevant;
- style and medium described through observable qualities;
- exclusions and failure modes that would violate the concept.

Avoid long adjective lists, contradictory art directions, and implementation details that cannot be seen in the image.

## Edit Prompt

State separately:

- what must be preserved exactly;
- what may change;
- what must be added or removed;
- the intended composition and visual integration;
- protected assets and prohibited transformations.

## Execution Contract

For each planned image, provide:

- stable identifier and purpose;
- method: `generate` or `edit`;
- final prompt and any required reference paths;
- output filename and format intent;
- aspect ratio, width, height, and a short size rationale;
- consistency anchors and acceptance criteria.

Width and height must not exceed the runtime ceiling supplied by the system from `DREAMATIC_IMAGE_DEFAULT_SIZE`. Treat that ceiling as dynamic; do not hard-code a model-specific maximum. Use the lowest adequate resolution for diagrams, supporting views, contact sheets, or exploratory assets, and reserve larger outputs for hero images or detail-critical views.

## Prompt Discipline

Make each prompt self-contained and directly executable. Prefer one well-resolved instruction per required artifact over speculative alternates. Acceptance criteria should describe visible outcomes, not a second design review or an open-ended iteration loop.
