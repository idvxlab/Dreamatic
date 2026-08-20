---
name: default-design-workflow
description: "Dreamatic's stable default workflow for full design runs. Use when the user asks for a complete design deliverable and does not explicitly select another workflow; lightweight operations do not need this workflow."
license: MIT
---
# Default Design Workflow

This skill defines Dreamatic's stable built-in workflow for full design runs. It is the fallback only when the user asks for a complete design deliverable and does not explicitly select another workflow Skill. Lightweight design operations do not need this Skill or a run directory.

## Runtime Mapping

- `ask_user`: structured clarification.
- `spawn_agent`: subagent execution.
- `run_init`: create run directory and `brief.json`.
- `design_bus_post` / `design_bus_read`: phase handoff.
- `research_fetch`, `research_asset_discover`, `research_asset_fetch`, `research_asset_validate`: research and reference assets.
- `image_generate`, `image_edit`: image creation and editing.
- `artifact_lint`: validation.
- `export_package`: final package.

Use the Dreamatic runtime tools named above when coordinating the workflow.
For this design workflow, subagent execution is serial: Research finishes before
Planner starts, Planner finishes before Designer starts, and Designer finishes
before Reviewer starts.

## Workflow

Use this single-path chain:

`master -> researcher -> planner -> designer -> reviewer -> export_package`

Each full design run produces one run with one final curated artifact set. Lightweight `/design` operations may be handled without this Skill and without a run directory.

Each child must load this workflow Skill and its detailed default stage Skill:

- `researcher` loads `default-research-stage`.
- `planner` loads `default-planning-stage`.
- `designer` loads `default-production-stage`.
- `reviewer` loads `default-critique-stage`.

Master must include both Skill names in each child task. The stage Skills own
the detailed default file schemas, research budget, production procedure, and
critique rules. The base personas only provide reusable role behavior.

### Master orchestration

1. If the user explicitly named a professional Skill for a design area outside
   the built-in domains, use that Skill as the professional authority and skip
   built-in domain classification. Otherwise infer exactly one supported
   `domain_type`; do not ask the user to confirm the classification.
2. Select the matching fixed `domainContext` only for a built-in domain.
3. Build `resolvedScope` from the brief and separate source-bound facts from
   design preferences.
4. Use `ask_user` once when a missing design choice materially changes the
   direction. Merge the answer and record minor inferred defaults.
5. Derive a readable lowercase ASCII run slug.
6. Call `run_init` once with the raw brief, `workflowSkill:
   "default-design-workflow"`, `resolvedScope`, optional built-in
   `domainContext`, and the slug as `runIdOverride`.
7. Capture the exact returned run paths.
8. Spawn `researcher`. Its task must name `default-design-workflow`,
   `default-research-stage`, and the selected domain Skill, and must include the
   run paths, brief, `resolvedScope`, optional `domainContext`, expected
   research files, and `research_done` completion signal.
9. Verify both the Research outputs and `research_done`. A child error or
   partial files do not complete the stage.
10. Spawn `planner` with `default-design-workflow`,
    `default-planning-stage`, the selected domain Skill, Research outputs, and
    the five required plan files. Verify the files and `plan_done`.
11. Spawn `designer` with `default-design-workflow`,
    `default-production-stage`, the selected domain Skill, research/plan paths,
    and the required artifact contract. Verify PNG artifacts,
    `artifacts/00-gallery.html`, lint result, and `design_done`.
12. Spawn `reviewer` with `default-design-workflow`,
    `default-critique-stage`, the selected domain Skill, artifact paths, and
    review requirements.
13. If Reviewer posts `evaluator_fail`, allow one Designer repair invocation with
    the critique, followed by one more Reviewer invocation.
14. Call `export_package`.
15. Report run name, run id, domain type, final folder, deliverables, verdict,
    and remaining risks.

The stages are serial. Do not spawn the next dependent stage until the current
child has returned successfully and its required files and completion message
exist.

## Built-In Design Domains

When the user has not explicitly selected another professional Skill,
`master` infers one built-in `domain_type` from the brief. Do not ask
the user to choose or confirm it unless the user later corrects the result.

Supported `domain_type` values:

- `brand_cultural_design`: brand identity, cultural merchandise, institutional visual systems, campaign extensions, and branded applications.
- `product_design`: product or industrial-design concepts, including product appearance, usage scenes, CMF, and detail renders.
- `architecture_space_design`: architecture, interior, spatial, exhibition, retail, and environmental concept design.
- `poster_advertising_design`: poster, advertising, event key visual, and campaign communication design.

When the user explicitly selects an installed professional Skill outside these
four domains:

- do not force the brief into the closest built-in domain;
- add the Skill name to `resolvedScope.professional_skills`;
- allow `domain_type` and `domainContext` to be absent;
- pass the Skill name to every stage;
- use its instructions for clarification, research focus, planning factors,
  production guidance, deliverables, and critique;
- keep this default workflow's serial stages, run layout, planning compatibility
  files, image-set production, gallery, review, and packaging unless the Skill
  explicitly narrows an output.

The final deliverable shape is always a curated PNG image set plus one polished
`artifacts/00-gallery.html`. The harness produces concept/effect images and
presentation material, not CAD, BIM, engineering drawings, manufacturing files,
or construction documents.

## Scope Contract

`resolvedScope` stores the clarified user request. It should answer: what is
being designed, for whom, in what language, with what intent, style preference,
and constraints. For a built-in domain it includes `domain_type`; for an
explicit external professional Skill it includes `professional_skills`
instead. It should not become a general professional rulebook.

Master must keep source-bound facts separate from design intent. When the
brief includes a URL or official reference, save the URL in `reference_sources`
and set `fact_status` to `pending_research`. Before Research verifies the
source, do not fill dates, locations, organizers, editions, themes, official
slogans, brand ownership, venue names, product specs, or other external facts
by inference. Put only user-explicit facts in `unverified_claims`. Design
defaults can go in `assumptions`, but factual claims about real entities should
wait for Research.

Recommended shape:

```json
{
  "run_name": "short-ascii-slug",
  "human_title": "Human-readable title",
  "domain_type": "optional built-in domain id",
  "professional_skills": ["optional explicitly selected Skill name"],
  "target": "string",
  "audience": "string",
  "language": "zh | en | mixed",
  "deliverable_intent": "string",
  "style_preferences": "string",
  "constraints": "string",
  "reference_sources": ["url"],
  "fact_status": "pending_research | verified | clarified",
  "unverified_claims": {},
  "domain_scope": {}
}
```

For built-in domains, `domain_scope` is domain-specific:

- `brand_cultural_design`: `mind_identity`, `behavior_identity`, `visual_identity`.
- `product_design`: `user_context`, `function_experience`, `form_material`.
- `architecture_space_design`: `site_context`, `program_spatial`, `atmosphere_material`.
- `poster_advertising_design`: `communication_goal`, `message_hierarchy`, `visual_direction`.

`domainContext` stores the fixed professional context for a built-in domain. It
is selected from the table below, saved beside `resolvedScope`, and passed
through bus payloads and subagent task prompts. An external professional Skill
does not need to produce this structure.

Recommended shape:

```json
{
  "domain_type": "product_design",
  "label": "Product Design",
  "description": "string",
  "professional_factors": ["string"],
  "reference_strategy": ["string"],
  "deliverable_categories": ["string"],
  "required_outputs": ["string"],
  "optional_outputs": ["string"],
  "conditional_outputs": ["string"],
  "anchor_candidates": ["string"],
  "consistency_anchor": ["string"],
  "handoff_focus": ["string"],
  "evaluation_focus": ["string"],
  "research_keywords": ["string"],
  "common_outputs": ["string"]
}
```

`deliverable_categories` and `required_outputs` are planning categories. Planner
may expand a category into multiple concrete PNG entries when the brief asks for
several applications, views, or formats. Example: `application and merchandise`
may become separate manifest items for tote bag, T-shirt, badge, packaging, and
signage while keeping the same `deliverable_category` value for traceability.
Do not reduce named multiple outputs to a single generic image when the request
clearly asks for several separate deliverables.

`conditional_outputs` are optional at the domain level but become required once
Planner selects them for the current brief. Use them as adaptive triggers:
complex product structure can add an exploded view; many functions can add a
function annotation board; public communication needs can add a poster or
marketing visual; interaction-heavy concepts can add an interaction flow; and
spatial sequence complexity can add a circulation or sequence diagram.

`anchor_candidates` lists the strongest first images or references for visual
continuity. Choose only one or two per run. Examples: product three-view,
brand key visual, architecture key spatial view, or poster main visual.

`consistency_anchor` names the stable visual subject for the whole run. The
anchor changes by domain: product form and CMF for product design,
logo/motif/identity for brand-cultural design, spatial language and material
atmosphere for architecture-space design, and key visual plus copy hierarchy
for poster-advertising design. Planner records the anchor in
`design_system.json`; Designer should establish a canonical anchor image or
reference set early, then use `image_edit` from that anchor whenever a later
deliverable needs visual continuity.

`handoff_focus` lists the domain-specific information that should travel from
Research to Planner to Designer. It is not a rigid schema. Research should
record evidence under these headings when available. Planner should turn them
into a run-specific `domain_handoff` object in `design_system.json` and
`design_plan.json`. Designer should read that object before generating images.

Domain outputs are a starting framework, not a closed checklist. For each run,
Planner should first satisfy the selected domain's required outputs, then reason
from the concrete brief and research evidence to expand, merge, or specialize
deliverables. The expansion decision should be explicit: what was added, what
was intentionally omitted, and why. For example, a simple product may not need
an exploded view, while a multi-module device should add one; a poster with
several media formats should expand adaptations; a spatial brief with vertical
organization should add a section perspective.

Initial domain-context table:

```json
{
  "brand_cultural_design": {
    "label": "Brand & Cultural Design",
    "description": "Brand, institutional identity, cultural merchandise, and applied visual systems.",
    "professional_factors": ["identity recognition", "cultural translation", "visual-system coherence", "audience fit", "application consistency"],
    "reference_strategy": ["official identity assets", "cultural context", "peer brand systems", "merchandise and application examples"],
    "deliverable_categories": ["key visual", "color system board", "typography system board", "motif/system board", "application and merchandise", "visual-system board"],
    "required_outputs": ["key visual PNG", "color system board PNG", "typography system board PNG", "motif/system board PNG", "application/merchandise PNG set", "gallery HTML"],
    "optional_outputs": ["poster series PNG", "social media card PNG", "environmental application PNG", "motif/detail board PNG"],
    "conditional_outputs": ["add separate merchandise mockups when named by the user", "add poster or campaign visuals when the brief has a communication goal", "add signage/environmental applications when the identity appears in space"],
    "anchor_candidates": ["key visual", "official or derived logo/mark", "core motif"],
    "consistency_anchor": ["official or derived logo/mark", "core motif", "palette tokens", "typography roles", "layout rhythm"],
    "handoff_focus": ["identity lock", "motif lock", "palette and type roles", "application matrix", "protected official assets"],
    "evaluation_focus": ["recognizability", "cultural fit", "system consistency", "reference grounding", "production readiness"],
    "research_keywords": ["official site", "logo", "visual identity", "brand guideline", "cultural symbol", "merchandise"],
    "common_outputs": ["key visual PNG", "color system board PNG", "typography system board PNG", "application/merchandise PNG set", "visual-system board PNG", "gallery HTML"]
  },
  "product_design": {
    "label": "Product Design",
    "description": "Product and industrial-design concepts expressed as renderings and usage visuals.",
    "professional_factors": ["user scenario", "core function", "form language", "CMF", "ergonomics", "scale", "manufacturing plausibility"],
    "reference_strategy": ["competing products", "usage scenarios", "materials and finishes", "details and mechanisms", "ergonomics and scale cues", "lifestyle context"],
    "deliverable_categories": ["hero render", "three-view", "usage scene", "detail or interaction view", "CMF board", "form language board", "scale reference"],
    "required_outputs": ["hero product render PNG", "three-view PNG", "usage scene PNG", "detail/interaction PNG", "CMF board PNG", "form language board PNG", "scale reference PNG", "gallery HTML"],
    "optional_outputs": ["exploded view PNG", "function annotation board PNG", "interaction flow PNG", "form variation PNG", "packaging/display PNG", "marketing visual PNG"],
    "conditional_outputs": ["add exploded view for complex structure or visible internal modules", "add function annotation board for multi-function products", "add interaction flow for screen, voice, gesture, or service interactions", "add poster/marketing visual when the brief asks for launch or promotion", "add multiple usage scenes when the brief names multiple environments"],
    "anchor_candidates": ["three-view", "canonical product hero render"],
    "consistency_anchor": ["canonical product form", "three-view proportions", "CMF palette", "control/button placement", "surface texture and detail language"],
    "handoff_focus": ["product form lock", "CMF lock", "function and interaction lock", "scenario matrix", "deliverable expansion reasons", "reference usage policy"],
    "evaluation_focus": ["function clarity", "user fit", "form-material coherence", "scale plausibility", "render completeness"],
    "research_keywords": ["product reference", "industrial design", "CMF", "ergonomics", "usage scenario", "detail design"],
    "common_outputs": ["hero product render PNG", "three-view PNG", "usage scene PNG", "detail render PNG", "CMF board PNG", "gallery HTML"]
  },
  "architecture_space_design": {
    "label": "Architecture & Space Design",
    "description": "Architecture, interior, exhibition, and spatial concepts expressed as atmospheric renderings.",
    "professional_factors": ["site relationship", "program", "spatial sequence", "scale", "material atmosphere", "light"],
    "reference_strategy": ["site/context images", "precedent spaces", "plan and zoning examples", "section and circulation diagrams", "materials", "lighting atmosphere", "human-scale use scenes"],
    "deliverable_categories": ["hero spatial render", "site/context relation", "plan or zoning diagram", "circulation or user journey", "section or sectional perspective", "interior key moment", "elevation or facade study", "material and lighting atmosphere board", "accessibility and scale board", "detail vignette", "presentation overview"],
    "required_outputs": ["hero spatial render PNG", "plan/zoning diagram PNG", "circulation/user journey diagram PNG", "section or sectional perspective PNG", "material and lighting atmosphere board PNG", "accessibility and scale board PNG", "gallery HTML"],
    "optional_outputs": ["site/context relation PNG", "interior key moment PNG", "elevation/facade study PNG", "detail vignette PNG", "day-night atmosphere pair PNG", "presentation overview PNG"],
    "conditional_outputs": ["add site/context relation when urban, campus, landscape, or surrounding fit matters", "add elevation/facade study when exterior identity or entrance interface matters", "add interior key moment when the brief focuses on interior, retail, exhibition, or user experience", "add detail vignette when material junctions, display systems, furniture, or craft are important", "add day-night atmosphere pair when lighting experience is central", "add multiple interior/key views when several zones or rooms are named"],
    "anchor_candidates": ["key spatial view", "massing or arrival view"],
    "consistency_anchor": ["massing or spatial concept", "material palette", "light atmosphere", "human scale cues", "circulation logic"],
    "handoff_focus": ["spatial concept lock", "program and adjacency matrix", "site/context relationship", "circulation and user journey logic", "section/vertical organization logic", "material and light lock", "accessibility and scale logic", "scale and human activity cues", "view expansion reasons"],
    "evaluation_focus": ["spatial logic", "site fit", "atmosphere", "material coherence", "human scale"],
    "research_keywords": ["architecture precedent", "interior design", "exhibition design", "spatial atmosphere", "material palette", "site context"],
    "common_outputs": ["hero spatial render PNG", "plan/zoning PNG", "circulation/user journey PNG", "section/sectional perspective PNG", "material-light board PNG", "accessibility/scale board PNG", "gallery HTML"]
  },
  "poster_advertising_design": {
    "label": "Poster & Advertising Design",
    "description": "Posters, event key visuals, and campaign communication images.",
    "professional_factors": ["communication goal", "message hierarchy", "visual hook", "medium adaptation", "copy-image relationship"],
    "reference_strategy": ["campaign references", "poster systems", "key visual systems", "typographic hierarchy", "media formats", "audience mood", "placement contexts"],
    "deliverable_categories": ["main poster", "key visual or master visual", "typography and information hierarchy board", "color and visual rules board", "social square adaptation", "banner or horizontal adaptation", "media placement mockup", "poster series variation", "detail crop", "campaign asset overview"],
    "required_outputs": ["main poster PNG", "key visual/master visual PNG", "typography and information hierarchy board PNG", "color and visual rules board PNG", "social adaptation PNG", "gallery HTML"],
    "optional_outputs": ["banner/horizontal adaptation PNG", "poster series variation PNG", "media placement mockup PNG", "detail crop PNG", "campaign asset overview PNG"],
    "conditional_outputs": ["add poster series variations for multi-message, multi-date, multi-speaker, or multi-phase campaigns", "add banner or horizontal adaptation when web, screen, or wide media are requested", "add media placement mockup when public placement, launch, or environmental media context matters", "add detail crop when typography, texture, illustration, or graphic device needs close reading", "add campaign asset overview when several formats need to be understood as one system"],
    "anchor_candidates": ["main poster", "key visual"],
    "consistency_anchor": ["main key visual", "headline hierarchy", "palette tokens", "typography roles", "graphic device"],
    "handoff_focus": ["message hierarchy lock", "key visual/master visual lock", "copy and typography lock", "color and visual rules", "format adaptation matrix", "media placement context", "campaign expansion reasons"],
    "evaluation_focus": ["message clarity", "visual impact", "hierarchy", "audience fit", "format readiness"],
    "research_keywords": ["poster design", "advertising campaign", "key visual", "event poster", "typographic hierarchy", "social media visual"],
    "common_outputs": ["main poster PNG", "key visual/master visual PNG", "typography/hierarchy board PNG", "color/visual rules board PNG", "social adaptation PNG", "gallery HTML"]
  }
}
```

## Clarification Contract

Master may still use `ask_user` to confirm missing user needs. The domain type
itself is not a question. Ask at most one compact clarification card before
`run_init`, and only ask questions that materially change the design direction.

Clarification flow:

1. Use explicitly selected professional Skills when present; otherwise infer a
   built-in `domain_type`.
2. Build an initial `resolvedScope` from user intent and explicit user claims.
3. If the brief includes URLs or official references, store them in
   `reference_sources`, set `fact_status` to `pending_research`, and leave
   source-bound facts for Research.
4. Select the fixed `domainContext` for a built-in domain, or use the external
   professional Skill instructions directly.
5. Check missing common fields and the selected built-in domain's
   `domain_scope`, or the external Skill's clarification guidance.
6. If critical design choices are missing, call `ask_user` once.
7. Merge the answer into `resolvedScope`; fill remaining minor design gaps with
   clear defaults, not unverified external facts.
8. Call `run_init` with `brief`, `workflowSkill:
   "default-design-workflow"`, JSON-stringified `resolvedScope`, and the
   JSON-stringified `domainContext` only when one exists.

## Run Directory

`run_init` returns `runId` and `runDir`.

Before calling `run_init`, Master should derive a readable run slug and pass it as `runIdOverride` whenever possible. The slug should be lowercase ASCII, stable, and descriptive, such as `tongji-idvx-lab-visual-system`. Also store a human-facing `run_name` or `human_title` in `resolvedScope`. This keeps both the internal run directory and `outputs/runs/<runId>/final/` easy to find later.

Expected layout:

```text
<runDir>/
  brief.json
  bus.jsonl
  research/
    evidence.json
    research.md
    brand_lock.md
    assets/
      manifest.json
      validation.json
  plan/
    design_system.json
    design_plan.json
    deliverable_manifest.json
    acceptance_criteria.md
    task_breakdown.md
  artifacts/
    generated-images/
    edits/
    00-gallery.html
    artifact-manifest.json
  review/
    critique.md
    critique.json
```

`export_package` writes the final deliverable to `outputs/runs/<runId>/final/`.

## Bus Messages

Canonical message types:

- `kickoff`
- `research_done`
- `research_followup`
- `plan_done`
- `design_done`
- `evaluator_pass`
- `evaluator_fail`
- `status`

Sender names:

- `master`
- `researcher`
- `planner`
- `designer`
- `reviewer`

Use `evaluator_pass` and `evaluator_fail` for critic verdicts to stay compatible with the tool schema.

## Done Conditions

Research is done when evidence, notes, brand lock, asset validation, and the
canonical `research_done` bus message are present. Research should include
`official_facts` or `verified_facts` for source-bound facts when official
sources are available, and should explicitly flag conflicts between verified
facts and `resolvedScope.unverified_claims`. If the Research subagent returns
`Error:`, Master must not treat partial files as completion and must not start
Planner until the same phase is retried/resumed or the run is reported blocked.

Research should save a compact but sufficient reference image library in
`research/assets/`. Keep official logos, wordmarks, or protected application
screenshots when the target has real identity assets. For other references, keep
only images that directly support planning or generation: form, CMF, usage,
site, spatial atmosphere, message hierarchy, format adaptation, cultural symbol,
or application context. Unused generic inspiration images are not useful.

Planning is done when design system, design plan, manifest, acceptance
criteria, task breakdown, and the canonical `plan_done` bus message are present.

Design is done when PNG artifacts, gallery, artifact manifest, lint result, and
the canonical `design_done` bus message exist.

Critique is done when critique files exist and a pass/fail bus message is posted.

Package is done when `export_package` returns `ok: true`.

## Failure Handling

If research has no usable public source, document that and continue with a speculative concept.

If image editing fails, try a generated valid reference once, then continue with image generation.

If the critic fails the artifact set, the primary may request exactly one designer repair pass before packaging or reporting remaining risks.

If a subagent returns `Error: sub-agent ... did not complete`, that phase is not
done. Do not advance to the next phase based only on partial files. Retry or
resume the same phase once when the cause is transient; otherwise report the
blocked phase and the missing canonical bus message.
