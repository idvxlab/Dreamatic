---
name: default-production-stage
description: "Detailed production-stage instructions used by default-design-workflow, including manifest execution, image generation/editing, optional user-requested video, visual consistency, gallery presentation, lint, and handoff."
license: MIT
---
# Role

These are the detailed Production-stage instructions for
`default-design-workflow`. Apply them while acting as `design-designer`.

Your job is to produce actual design artifacts under `<runDir>/artifacts/`.

## Domain-Aware Override

Before producing any artifact, read `<runDir>/brief.json` and identify:

- `brief.json::resolvedScope.domain_type`
- `brief.json::resolvedScope.professional_skills`
- `brief.json::resolvedScope.domain_scope`
- `brief.json::domainContext`

Load `default-design-workflow`, `image-prompting`, `visual-composition`, and
`design-system`.

If `professional_skills` contains user-selected Skills, load them and use their
production guidance. Use the plan manifest as the execution authority and do
not require a built-in domain or `domainContext`.
This override takes precedence over built-in-domain instructions later in this
Skill.

Otherwise load exactly one built-in domain Skill:

- `brand_cultural_design` -> `brand-identity`
- `product_design` -> `product-design`
- `architecture_space_design` -> `architecture-space`
- `poster_advertising_design` -> `poster-advertising`

Use the manifest plus `plan/design_plan.json` to decide what each PNG should
be. For built-in domains, also use `domainContext.deliverable_categories`.
Every final PNG should correspond to the plan's output categories and should
record that purpose in its prompt or sidecar.

Read `plan/design_plan.json::domain_handoff` before producing images. Treat it
as the run-specific bridge from research and planning into production. It may
contain a compact baseline plus additional fields created for the current brief.
Use `anchor_lock` to choose the first image/reference that must stay stable.
Use `expansion_logic` to understand why the manifest has extra or split
deliverables. Use `execution_notes` to keep the right professional details in
every prompt and sidecar.

Planner's `image_generation_plan[].prompt_seed` is a seed, not the final image
prompt. Before each `image_generate` or `image_edit` call, expand it with:

- the relevant `design_system.json` palette tokens, typography roles, motif,
  material, voice, and consistency lock;
- `domain_handoff.anchor_lock` and `domain_handoff.execution_notes`;
- the concrete manifest item's `purpose`, `acceptance_test`, category, size,
  method, and reference assets;
- the selected domain skill's production guidance.

This keeps plan JSON stable while still allowing detailed final image prompts.

`plan/deliverable_manifest.json` is the execution authority. Its PNG entries are
concrete files to produce, while `deliverable_category` records the broader
required category. A single category may appear on several PNG entries when the
brief asks for multiple applications, objects, scenes, or formats.

Before producing the full set, establish a visual consistency anchor from
`design_system.json`, the professional Skill, and any available
`domainContext.consistency_anchor`. The anchor may be a
canonical product render or three-view, a logo/motif reference, a spatial
material-and-light reference, or a poster key visual. Use that anchor as a
reference for later images whenever continuity matters.

## Inputs

The parent must provide:

- `runId`
- `runDir`
- user brief
- resolved scope
- any critic repair notes, if this is a repair pass

Read:

- `<runDir>/brief.json`
- `<runDir>/research/evidence.json` if present
- `<runDir>/research/research.md` if present
- `<runDir>/research/brand_lock.md` if present
- `<runDir>/research/assets/manifest.json` if present
- `<runDir>/plan/design_plan.json`
- `<runDir>/plan/deliverable_manifest.json`
- `<runDir>/plan/acceptance_criteria.md`

## Workflow

1. Load skills as described in "Domain-Aware Override".
2. Create `<runDir>/artifacts/` if needed.
3. Use `image_generate` for new visual assets.
4. Use `image_edit` only with valid local reference images. Prefer standard PNG/JPEG/WebP references with sufficient size.
   Research may collect a larger reference library than you need. Choose the best few references for each deliverable, but leave unused assets untouched for audit and future iterations.
5. If `domain_handoff.anchor_lock` names a canonical anchor item, produce it first. Otherwise choose the first hero/key visual/system image as the anchor and record that choice in `artifact-manifest.json`.
6. Produce every concrete PNG entry in `plan/deliverable_manifest.json`. If several entries share the same `deliverable_category`, treat them as a coherent series.
7. Use `image_edit` from the anchor for derived deliverables that need continuity: color-system boards, typography/system boards, merchandise or application mockups, product scenes, product detail images, form-language boards, function annotation boards, spatial views, advertising adaptations, and any image that should preserve the same product/form/logo/space/key visual.
8. For each `image_generate` or `image_edit` call, pass `domainType` from `brief.json::resolvedScope.domain_type` and pass `deliverableCategory` from the manifest item or `domainContext.deliverable_categories`.
9. Write each generated PNG to the exact `file` path declared for that item in `plan/deliverable_manifest.json`. Do not invent a second filename scheme. If the manifest says `artifacts/generated-images/02-plan-zoning.png`, that is the file to create, the sidecar base name, the gallery reference, and the artifact-manifest path.
10. If `brief.json::resolvedScope.optional_video.enabled` is true, execute the
    matching `design_plan.json::video_generation_plan` after its referenced
    static anchor exists. First generate and validate the plan's dedicated
    first-frame image, then use that image for `video_generate`. Verify the
    first-frame, video, and metadata paths.
11. Create `<runDir>/artifacts/00-gallery.html` and reference every final PNG with local relative paths.
   Shape the gallery as a polished presentation page with a clear hierarchy: final generated/edited deliverables as the main section, and research references as a secondary provenance/reference section when useful.
   When adding research references, first read `<runDir>/research/assets/manifest.json` and/or list `<runDir>/research/assets/`. Use the exact stored filenames from `assets[].file`; do not invent numbered names or renamed aliases.
12. Write `<runDir>/artifacts/artifact-manifest.json`.
13. Run `artifact_lint` with `requireGallery: true`.
14. If lint fails, fix the files once if possible.
15. Post `design_done` to `design-primary` with artifact paths and lint summary.

## Optional Video Supplement

The default production contract does not generate video unless
`resolvedScope.optional_video.enabled` is true or the parent task explicitly
requires it. Video supplements the required PNG set.

When enabled:

1. Read `design_plan.json::video_generation_plan` and produce only its requested
   video entries.
2. Finish the referenced key visual, product render, poster, spatial view, or
   other consistency anchor before preparing motion.
3. Read the plan entry's mandatory `first_frame` object. Resolve its
   `source_deliverable_id` to the real static artifact, expand its prompt with
   the video narrative and consistency lock, and call `image_edit` to create
   the exact dedicated PNG at `first_frame.file` under
   `<runDir>/artifacts/video-frames/`.
4. Verify the dedicated first frame preserves the static design while setting
   the planned opening composition, camera framing, subject state, and
   motion-ready scene. Do not use the unadapted static deliverable directly as
   `referenceImagePath`.
5. Call `video_generate` with the dedicated first-frame path as
   `referenceImagePath`, plus the canonical `runId` and `runDir`, stable `id`,
   purpose, domain type, deliverable category, ratio, duration, resolution,
   audio preference, and the expanded motion prompt.
6. Preserve the established subject, palette, typography, motif, form, spatial
   language, or key visual while adding deliberate motion and camera behavior.
7. Confirm `ok: true` and verify the returned video and sidecar metadata files
   exist under `<runDir>/artifacts/generated-videos/`.
8. Add the dedicated first frame, video, and metadata to
   `artifact-manifest.json::supplementary_assets` and include a playable local
   `<video controls>` element in `00-gallery.html`.
9. Include the real first-frame, video, and metadata paths in the `design_done`
   bus message.

If a model rejects duration, ratio, resolution, audio, or another setting,
adjust the rejected parameter to a supported value and retry once. Do not start
multiple identical paid jobs or claim success from a task id alone.

## Optional 3D Supplement

The default production contract remains a curated PNG set plus a flat gallery.
Run this supplementary step only when `resolvedScope.optional_3d.enabled` is
true or the parent task explicitly requires a 3D model. A 3D model must not
replace, reduce, or delay production of required PNG deliverables.

When optional 3D production is enabled:

1. Call `hunyuan3d` as a supplementary production step.
2. Always pass the exact canonical `runDir` supplied by `design-primary`, along
   with `runId` and a stable `id`. Never use `outputs/hunyuan3d/` for a workflow
   run.
3. Choose `text`, `single_view`, or `multi_view` from the resolved request. Use
   only real local reference paths for image modes.
4. Keep returned models under `<runDir>/artifacts/models/`, preview renders under
   `<runDir>/artifacts/model-renders/`, and metadata under
   `<runDir>/artifacts/models/`.
5. Confirm the tool result has `ok: true` and every returned model, preview, and
   metadata path exists before reporting completion.
6. Add the returned preview to `00-gallery.html` as a supplementary 3D preview
   card and add a local download link to the model file. The gallery remains a
   flat review surface; an interactive viewer is not required.
7. Record the model, preview, metadata, method (`hunyuan3d`), and input mode in
   `artifact-manifest.json::supplementary_assets`.
8. Include the supplementary paths in the `design_done` bus message.

## Image Rules

- The output must be inspectable files, not only text.
- Avoid readable text inside generated images unless the brief requires it.
- Preserve protected official marks exactly when they appear in a deliverable.
- When using `image_edit`, preserve the identity of protected references and transform only the surrounding design.
- Choose the research references that best support each deliverable, cite them in sidecars, and keep the broader reference library available for provenance and future iterations.
- Keep the consistency anchor visible in prompts and sidecars. For product design, preserve form, proportions, CMF, controls, and material texture. For brand-cultural design, preserve logo/motif, palette, type roles, and layout rhythm. For poster-advertising design, preserve the key visual, headline hierarchy, palette, type roles, and graphic device. For architecture-space design, preserve massing/spatial concept, material palette, light atmosphere, and scale cues.
- When research references appear in `00-gallery.html`, present them as a secondary "Reference Library" or provenance section with smaller cards and concise captions.
- If image editing fails because a reference is invalid, generate a clean reference image first and retry once.

## Output Contract

Required artifact set:

- every required concrete PNG entry from `plan/deliverable_manifest.json`
- one self-contained `00-gallery.html`
- one `artifact-manifest.json`

When optional 3D production is enabled, additionally include the real model,
preview render, and metadata as `supplementary_assets`. These do not change the
required PNG count used by `artifact_lint`.

When optional video production is enabled, additionally include the real video,
its dedicated first-frame image, and sidecar metadata as
`supplementary_assets`. These also do not change the required PNG count used by
`artifact_lint`.

Use `write_json` for `artifact-manifest.json` and any side metadata you write
manually. Use `write_file` for `00-gallery.html` and other plain text files.

All outputs belong directly to this run's `artifacts` directory.

## Gallery Presentation Rules

`00-gallery.html` should look like a curated design-review board:

- First section: run title, short brief, design-system summary, palette swatches if available.
- Main section: final generated/edited deliverables, grouped by `deliverable_category` from the manifest and sidecars.
- Optional motion section: user-requested videos shown with local
  `<video controls>` elements and concise purpose captions.
- Optional supplementary section: show each 3D preview render and provide a
  local download link to its model file; do not present the model as a required
  PNG deliverable.
- Each category group may contain one card or many cards. Use responsive grids so expanded categories such as merchandise, product details, spatial zones, or media adaptations remain readable.
- Each final card should include a short caption: deliverable id, purpose, method (`image_generate` or `image_edit`), and reference ids used.
- Optional appendix: research references, presented as supporting source material with a lighter visual treatment.
- Reference appendix image paths must be based on real files. From `artifacts/00-gallery.html`, use `../research/assets/<exact assets[].file>` for entries from `research/assets/manifest.json`.
- Use inline CSS only, no scripts, no external network assets, no marketing copy about the harness itself.
- Do not mix research reference images into the main final-deliverables groups; keep them in the appendix when shown.

Use a presentation narrative, not a raw file-browser order:

- `architecture_space_design`: Overview / design thesis, Design System, Spatial Logic (plan, circulation, section), Experience Renders (hero, interior, site/context, facade), Detail & Atmosphere (material, lighting, accessibility/scale, detail vignettes), Reference Appendix.
- `poster_advertising_design`: Campaign thesis, Master Visual, Main Poster, System Boards (typography hierarchy, color and visual rules), Adaptations (social, banner, series), Placement/Detail, Reference Appendix.
- `product_design`: Product thesis, Anchor Form, Function & Interaction, CMF/Form Language, Scenario Renders, Detail/Scale, Reference Appendix.
- `brand_cultural_design`: Identity thesis, Key Visual, System Boards, Applications/Merchandise, Environmental or Media Extensions, Reference Appendix.

Before posting `design_done`, self-check the gallery:

- every required PNG file from `plan/deliverable_manifest.json` is embedded exactly once or intentionally shown in a coherent series;
- when optional video is enabled, every planned video path exists and is
  embedded in the motion section, and every video uses its planned dedicated
  first-frame image rather than the unadapted static anchor;
- every embedded image path exists relative to `artifacts/00-gallery.html`;
- every Reference Appendix image path exists and matches an actual filename in `research/assets/manifest.json` or the `research/assets/` directory;
- no research image appears in the final-deliverables section;
- the page has no external network references and no `<script>` tags;
- HTML tags are closed and the layout works on narrow and desktop widths.
