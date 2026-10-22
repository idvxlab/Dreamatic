---
name: image-prompting
description: "Translate resolved design decisions into image generation or editing specifications, including references, visible features, exact copy and consistency. Use to express an existing design as executable image prompts; does not replace professional concept decisions or grant image-production tools."
license: MIT
metadata:
  audience: designer
  domain_type: image_execution_specification
  design_categories: []
  module_type: execution
  capabilities: [image-prompting, visual-specification, image-editing, visual-consistency]
  supported_outputs: [image]
---

# Image Prompting

Translate resolved design decisions into self-contained generation or edit
instructions. Specify the intended image and its acceptance criteria before generation.

## Choose the operation and references

Use `image_generate` for a new treatment expressible through visible features.
Use `image_edit` when reference pixels are needed to preserve or transform a
subject, identity or composition. Distinguish factual subject, inspiration,
exact asset and consistency references. Provenance records do not upload pixels.
Unchanged user-requested originals use verified import and HTML resource mappings,
not generation or a nominal edit.

Study useful references and record observed features; filenames are not observations.
Viewing, pixel conditioning and finished reproduction have separate asset-specific
conditions. Unknown photo permissions do not prohibit the real subject. Retain
recognition cues without tracing an existing design. If critical subject evidence
is missing, record the gap instead of inventing features or making the subject generic.

## Write the visible design

Each prompt expresses one deliverable's purpose and selected concept through:

- subject, action, distinguishing geometry and functional/spatial relationships;
- viewpoint, crop, hierarchy, context and human scale;
- material, color, light, texture and observable style;
- required wording and consistency features;
- concrete errors or unwanted transformations to avoid.

Translate specialist terms into visible attributes. Removing a subject's name
should still leave enough information to depict it. State intentional abstraction
and what meaning survives; titles and disclaimers do not replace subject understanding.
Different concepts need different mechanisms or compositions, not new adjectives.
Keep engineering assumptions separate from visible requirements. Do not delegate
unresolved creative choices or undeclared alternatives to generation.

Check contradictions and missing features. Negative prompts must not erase the
chosen subject, recognition cues or required copy. Scope prohibitions to actual
user intent, evidenced conditions, runtime limits or concrete failure modes.

## Include complete communication

Design words with the image. Repeat exact approved strings in each relevant prompt,
with language, hierarchy, placement, typography, contrast and reading scale.
References to copy elsewhere do not transmit it to the image provider.

Use appropriate names, headlines, labels, legends or calls to action without
inventing factual claims. Balance density and size for readability. Generated
lettering is supported but not guaranteed exact; do not default to blank artwork,
contradict required labels with "no text", or substitute showcase captions for
required in-image communication. Preserve critical copy in the specification;
authored HTML provides deterministic selectable text when needed.

## Plan edits and continuity

Palette and atmosphere may be conveyed in text. Exact marks, silhouettes or repeated
components may need pixel conditioning; independent generation does not guarantee
geometry. For dependent edits:

1. Identify the source deliverable and its exact local output.
2. Record the source image and its relationship to the edited result.
3. Provide self-contained `prompt_seed`, `negative_prompt_seed`, `diagnosis`, `changes`
   and `preserve`, distinguishing retained features from additions or removals.
4. Specify composition, copy, size and observable acceptance for that application.

Diagnosis can explain a transformation, not only a defect. Create source images before dependent edits. Sibling edits may share an existing
source; unrelated views need not be serialized merely for a shared style.

Sources may be appropriately authorized existing assets or newly generated outputs.
Viewing does not establish pixel-use permission; future generated sources have not
been visually inspected. Review edited results against the specified preservation rules. Editing
cannot guarantee exact reproduction; disclose unsupported fidelity requirements.

## Describe the deliverable

Record each image's purpose, exact output filename, dimensions, edit references,
required content and observable acceptance criteria. Keep prompts self-contained.
Choose the lowest adequate resolution for the view and respect the configured
provider's supported sizes and formats. Provide access to requested images from
the presentation, preserving proportions and distinguishing concept imagery from
verified technical claims.
