---
name: image-prompting
description: "Specify executable image-generation or image-editing prompts, references, consistency anchors, acceptance criteria, aspect ratios, and efficient output sizes."
license: MIT
metadata:
  audience: designer
  domain_type: image_execution_specification
  design_categories: []
  module_type: execution
  supported_outputs: [image]
---

# Image Prompting

Use this optional module to translate an approved design concept into precise image instructions. It defines intent for later execution; it does not call image tools.

## Choose the Method

Choose by the intended operation, not by whether a real subject is recognizable.
Use generation for a new treatment when observed subject features can be
specified in text. Use editing when appropriate reference pixels are needed
to preserve or transform the intended subject, identity or composition; confirm
the applicable usage conditions for those inputs. Identify each reference's
role: factual subject, inspiration, exact asset or consistency anchor. A picture
listed as provenance is not automatically uploaded to the generation provider.
Existing designs, logos, photographs and layouts may be visually studied to
understand subject features, useful principles and failure modes. Avoiding
plagiarism is not a blanket prohibition on reference viewing. Distinguish
observation/inspiration, appropriate pixel conditioning and reproducing the
source in the result. Document the intended operation and asset-specific
conditions; unknown rights do not make the subject itself unusable.
For each visually used reference, cite observed features and explain their
transformation into the proposed original solution. Screen the retained library
in labelled batches; do not infer content from filenames or silently skip most
candidates.

For a recognizable real subject, specify its evidenced silhouette, geometry,
rhythm, material cues and context as positive requirements. Negative prompts
should prevent actual errors or unwanted copying, not prohibit those same
features. "Do not copy an existing logo" is different from "do not show this
bridge." If accurate depiction matters and evidence is insufficient, record
the missing feature rather than inventing it or silently making the scene generic.

## Generation Prompt

Translate specialist concepts from their understood meaning, not their names.
Identify the defining relationships or attributes from the Design Spec's subject
understanding and select how this view communicates them. Describe applicable
operation, structure, material behavior, cultural context or user behavior in
concrete positive terms. Differentiate the intended subject from its nearest
visual look-alike. If an abstraction or reinterpretation is intentional, specify
what meaning remains and what is changed; do not imply source-verified properties
for an invented treatment. A title, technical label or disclaimer cannot replace
this content. Test whether removing the subject name would still leave enough
information to depict the intended design, and revise when it would produce
only a generic pattern or familiar category image. Use multiple states or detail
views only when they clarify the task, without a fixed extra-image requirement.

Translate selected design decisions into visible relationships, not adjective
lists: who/what acts, functional or spatial arrangement, distinguishing geometry,
material behavior, context, viewpoint and hierarchy. Each prompt must explain
one deliverable's purpose and preserve the relevant concept id/anchors. Different
concepts need different mechanisms or compositions, not the same prompt with
new style words. Before handoff, check missing critical features, geometric or
material contradictions, and negatives that erase the desired content. Keep
unknown engineering assumptions separate from visible design requirements.
Do not ask generation to settle an unresolved creative choice or output a set
of alternatives unless the approved manifest actually requests that set.

Include the information that changes the result:

- subject, purpose, and design intent;
- composition, viewpoint, crop, and spatial relationships;
- defining form, material, color, light, typography, or environmental traits;
- context, human scale, interaction, or narrative cues when relevant;
- style and medium described through observable qualities;
- exclusions and failure modes that would violate the concept.

Avoid long adjective lists, contradictory art directions, and implementation details that cannot be seen in the image.

## Copy and Typography

For communication-oriented artwork, design the words together with the image.
Specify exact quoted strings, language, message hierarchy, reading order,
placement, typographic character, contrast, spacing and appropriate reading
distance. Include brand names, headlines, supporting copy, calls to action,
labels or legends as needed by the brief, not every category automatically.
Repeat approved literal strings in each applicable self-contained prompt;
references to structured copy elsewhere do not transmit those words to the
image provider. Ask the model to render that copy within the final image.
Choose resolution and text density for readability within the size ceiling.
Avoid conflicting negatives such as "no text" for a labelled poster or sign.
Do not omit copy because a separate typography tool is unavailable; existing
generation/editing tools can integrate it. Preserve exact user wording and
do not invent factual claims. Rendering accuracy remains a possible limitation,
not a reason to make textless results the default. Gallery explanations are
supplementary, not substitutes for required in-image communication.

## Edit Prompt

### Cross-Output Continuity

Classify what must remain stable: atmosphere/palette can often be communicated
in text, while a distinctive mark, silhouette or repeated component may require
pixel conditioning. Do not assume independent generations reproduce exact geometry.
For the latter, plan a source artifact and dependent `image_edit` outputs:

1. Name the source deliverable id and exact local output path in the Design Spec.
2. State which visible features must survive and what each application changes.
3. Put the source before its edits in execution dependencies; use independent
   generation for unrelated views so the anchor does not serialize the whole project.
   Sibling edits sharing an existing source may run in one edit batch; only real
   source dependencies require successive execution groups. Use editing for
   necessary visual preservation, not merely because all images share a style.
4. Supply that path in each dependent edit's `referenceImagePaths`, along with a
   self-contained application prompt, preservation rules, copy and size.

Declare the transformation need for the tool's `diagnosis`, plus `changes` and
`preserve`; this can describe the new application, not a discovered visual defect.
Run-relative source paths must be resolved against the assigned `runDir` when
Builder passes them to the edit tool.

A source may be an appropriately authorized existing asset or a newly generated
artifact in this Run. Do not infer source permission from viewing it. Generated
anchors need not be uploaded research assets, and their future pixels have not
been inspected or approved. Success permits execution to continue without a new
visual review stage; edits still cannot guarantee exact reproduction. Disclose
unsupported fidelity requirements rather than promise them or invent a compositor.

State separately:

- what must be preserved exactly;
- what may change;
- what must be added or removed;
- the intended composition and visual integration;
- protected assets and prohibited transformations.

## Execution Contract

For each planned image, provide:

- stable identifier and purpose;
- method: `image_generate` or `image_edit` in the canonical Design Spec;
- final prompt and any required reference paths;
- output filename and format intent;
- aspect ratio, width, height, and a short size rationale;
- consistency anchors and acceptance criteria.

Width and height must not exceed the runtime ceiling supplied by the system from `DREAMATIC_IMAGE_DEFAULT_SIZE`. Treat that ceiling as dynamic; do not hard-code a model-specific maximum. Use the lowest adequate resolution for diagrams, supporting views, contact sheets, or exploratory assets, and reserve larger outputs for hero images or detail-critical views.

For schemaVersion 2, every image is one `execution_plan` task with `id` matching
its manifest deliverable, plus complete prompt_seed, negative_prompt_seed, size
and size_rationale. Scheduling groups and `deliverable_id` do not replace these
fields; prompts in a separate legacy array are not executed by schemaVersion 2.
Declare one exact Run-relative output filename and matching sizes in the manifest.
Use PNG by default; JPG/JPEG are supported as lossy opaque delivery formats.
The extension selects the saved encoding; b64_json/url describe transport only.
Builder reads that same manifest path by id and must not invent another filename.
Read runtime outputContract.imageOutputFormats for executable format capabilities.
For Gallery,
`presentation` uses `{"mode":"gallery","entry":"artifacts/00-gallery.html"}`;
Designer saves fill a missing fixed entry deterministically. `entry` is the
Showcase homepage, not an `artifacts[]` list. For mixed delivery, explicitly choose
Gallery or HTML presentation. Read Design Context's runtime `outputContract`
and save-time diagnostics; repair named fields without changing schema merely
to suppress errors.

## Prompt Discipline

Make each prompt self-contained and directly executable. Prefer one well-resolved instruction per required artifact over speculative alternates. Acceptance criteria should describe visible outcomes, not a second design review or an open-ended iteration loop.
