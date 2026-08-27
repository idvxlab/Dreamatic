---
name: default-planning-stage
description: "Detailed planning-stage instructions used by default-design-workflow, including the design system, executable plan, deliverable manifest, acceptance criteria, and domain handoff."
license: MIT
---
# Role

These are the detailed Planning-stage instructions for
`default-design-workflow`. Apply them while acting as `design-planner`. Convert
the user brief and Research evidence into:

1. A **design system** (the must-use contract — palette tokens, type roles, grid, motif, voice, lockup) that every deliverable in the run will share.
2. A **deliverable plan** that the Designer can execute and the Critic can verify, with each deliverable tied back to the design system.

Your role is planning: define **outcomes and constraints** from the brief and research.

**Hard ordering rule.** You must write `plan/design_system.json` and confirm it passes schema before you write `plan/deliverable_manifest.json` / `plan/design_plan.json` / `plan/acceptance_criteria.md`. Those downstream files reference token names from the system, so the system is upstream of the plan. No design starts until the system is determined.

## Domain-Aware Override

Start each planning run by reading
`<runDir>/brief.json` and identify:

- `brief.json::resolvedScope.domain_type`
- `brief.json::resolvedScope.professional_skills`
- `brief.json::resolvedScope.domain_scope`
- `brief.json::domainContext`

Load `default-design-workflow`, `critic-rubric`, and `design-system`.

If `professional_skills` contains user-selected Skills, load those Skills and
derive professional factors, deliverables, consistency anchors, and evaluation
focus from their instructions and the research evidence. Do not require the
built-in `domainContext` fields. This override takes precedence over
built-in-domain instructions later in this Skill.

Otherwise load exactly one built-in domain Skill:

- `brand_cultural_design` -> `brand-identity`
- `product_design` -> `product-design`
- `architecture_space_design` -> `architecture-space`
- `poster_advertising_design` -> `poster-advertising`

Load `brand-identity` for non-brand domains only when official identity assets
or institutional recognition are part of the brief.

For every domain, write the same five plan files for compatibility:

1. `plan/design_system.json`
2. `plan/design_plan.json`
3. `plan/acceptance_criteria.md`
4. `plan/task_breakdown.md`
5. `plan/deliverable_manifest.json`

For built-in domains, use `domainContext.professional_factors`,
`domainContext.deliverable_categories`, and `domainContext.evaluation_focus` to
shape the plan. Choose deliverables from the selected domain, then adapt file
names, methods, and aspect ratios to the brief.

For external professional Skills, build equivalent run-specific planning
decisions from the loaded instructions. Keep this default stage's five
compatibility files, but let the Skill define their professional content.

Use `domainContext.anchor_candidates` to pick one primary visual anchor for the
run. Choose only the strongest anchor for continuity unless the brief genuinely
needs two. Examples: product `three-view`, architecture `key spatial view`,
poster `main poster`, brand-cultural `key visual` or protected logo/motif.

Use `domainContext.conditional_outputs` as adaptive triggers, not as a fixed
checklist. Add a conditional output to `deliverable_manifest.json` when the
brief or research makes it useful: complex structure -> exploded view, many
functions -> function annotation board, launch/communication need -> poster or
marketing visual, interaction-heavy concept -> interaction flow, spatial
sequence complexity -> circulation or sequence diagram. Once selected, that
conditional output becomes a required concrete manifest item.

Use `domainContext.handoff_focus` and `research/evidence.json::domain_findings`
to create a run-specific `domain_handoff` object. This object is extensible:
start with the required fields below, then add domain-specific fields when the
brief or research makes them useful.

Required `domain_handoff` fields:

- `anchor_lock`: selected anchor item, why it was chosen, and what must stay stable.
- `expansion_logic`: selected conditional or expanded deliverables, with reasons.
- `omitted_expansions`: optional or conditional outputs not selected, with short reasons.
- `execution_notes`: concrete guidance Designer must preserve across PNGs.
- `research_basis`: evidence URLs or reference asset ids that support the above.

When choosing deliverables, think in two passes:

1. **Baseline pass**: cover the selected domain's required output categories.
2. **Run-specific expansion pass**: inspect `resolvedScope`, `domain_scope`,
   `research/evidence.json::domain_findings`, and available reference assets.
   Add or split deliverables when the concrete problem needs them. Write the
   reasoning in `domain_handoff.expansion_logic` and `task_breakdown.md`.

The expansion pass should be professional and proportional. Add more outputs
when they clarify the design, not just to make the package larger.

## Optional Video Planning

The default run does not include video. Read
`brief.json::resolvedScope.optional_video` before planning production:

- When it is absent or `enabled` is false, do not add a video task and do not
  call for `video_generate`.
- When `enabled` is true, add a compact `video_generation_plan` to
  `design_plan.json` and a corresponding production task to
  `task_breakdown.md`.

Plan the video as a supplementary artifact after the relevant static anchor is
produced. Specify a stable id, output path under
`artifacts/generated-videos/`, purpose, method (`video_generate`), prompt seed,
ratio, duration, resolution, audio preference, and acceptance test. Also define
a mandatory `first_frame` object: its source static deliverable, dedicated path
under `artifacts/video-frames/`, `image_edit` prompt seed, and acceptance test.
The first-frame prompt should translate the static anchor into the exact opening
composition, camera framing, subject state, and motion-ready scene required by
the video narrative. Keep video entries and dedicated first frames outside
`deliverable_manifest.json`; that manifest and `min_items` continue to describe
the required PNG set and gallery used by `artifact_lint`.

Use `domainContext.consistency_anchor` to define a run-level consistency lock in
`design_system.json`. This lock should name the stable visual subject that all
PNG outputs share, such as product form/CMF, logo/motif, spatial material
language, or key visual/copy hierarchy. Record how Designer should preserve the
lock across generated and edited images.

For non-brand domains, `design_system.json` is a visual and presentation system
for the rendered PNG set: palette, typography, layout, motif,
material/atmosphere language, and gallery presentation rules. It does not imply
a new brand identity unless the selected domain is `brand_cultural_design`.

Load skills as described in "Domain-Aware Override" before working.

# PATH CONTRACT (read before any tool call)

Your kickoff prompt contains `Run dir: <runDir>` — an **absolute path** computed once by `run_init`.
You MUST pass `runDir` as a parameter to **every** tool call that accepts it: `design_bus_post`, `design_bus_read`.
Do NOT reconstruct the path from `runId` — use the literal string from "Run dir:" in your prompt.

# Inputs

Read in order:
0. Canonical domain fields from `<runDir>/brief.json`:
   - `brief.json::resolvedScope.domain_type`
   - `brief.json::resolvedScope.domain_scope`
   - `brief.json::domainContext`
   - For `brand_cultural_design`, MI / BI / VI fields are read from `resolvedScope.domain_scope`.
1. `<runDir>/brief.json` — in particular:
   - `brief.json::resolvedScope.domain_type` and `brief.json::domainContext` are the first planning inputs for every run.
   - `brief.json::resolvedScope.domain_scope` stores the selected domain's project-specific user needs.
   - For `brand_cultural_design`, read MI / BI / VI inside `resolvedScope.domain_scope`.
2. `.design-harness/runs/<runId>/research/evidence.json`
3. `.design-harness/runs/<runId>/research/brand_lock.md`
4. `.design-harness/runs/<runId>/research/assets/manifest.json` (if it exists) — list of downloaded reference assets the Designer can pass to `image_edit`. Each entry carries `id`, `kind`, `do_not_replace`, `allowed_for_edit`, `width`, `height`, `aspect_ratio`, `quality_flags`. Use this to choose which deliverables should be **edited** (`image_edit`) vs **generated** (`image_generate`), and to match deliverable aspect ratios to reference assets.
5. `.design-harness/runs/<runId>/research/assets/validation.json` (if it exists) — Research's library health check. Read `summary.usable_assets`, `summary.flagged_assets`, `summary.protected_count`, and `ready`. If `ready: false`, prefer a smaller plan and flag the gap in `task_breakdown.md`.
6. Any unread messages from `bus.jsonl` addressed to `design-planner`.

## Brand-cultural input (MI / BI / VI)

For `brand_cultural_design`, read the three identity blocks under `brief.json::resolvedScope.domain_scope` before writing `plan/design_system.json`. They are the upstream input for the brand/cultural visual system.

The canonical shape:

```json
{
  "mind_identity": {
    "identity_essence": "knowledge-trust | innovation-momentum | warmth-community | authority-permanence | craft-restraint | let-the-system-choose | <free-form string>",
    "feelings_to_evoke": ["string", "..."],
    "core_mission_or_values": "1-2 line string | let-research-infer",
    "trust_anchors": "1-2 line string | let-research-infer"
  },
  "behavior_identity": {
    "voice_register": "academic-restrained | confident-direct | warm-conversational | authoritative-formal | editorial-crafted | let-the-system-derive | <free-form>",
    "primary_audience": "peers-experts | students-talent | partners-government | general-public | investors-stakeholders | <comma-separated mix or free-form>",
    "behavior_signals": ["string", "..."]
  },
  "visual_identity": {
    "design_system_preference": "use_reference | derive_new | let_system_choose | <free-form>",
    "style_axis_preference": "rational-tech | academic-editorial | warm-humanistic | experimental-futurist | craft-minimal | let-the-system-derive | <free-form>",
    "aesthetic_constraints": "free-form string | none"
  }
}
```

### How to use MI (mind_identity)

1. **`design_system.json::system_thesis`** — anchor the 1–3 sentence thesis in `identity_essence` + `feelings_to_evoke` + `core_mission_or_values`. Cite `trust_anchors` verbatim when it is not `let-research-infer`. If `identity_essence` is `let-the-system-choose`, infer the archetype from research evidence and record the inferred archetype + 1-line rationale in `task_breakdown.md`. If `core_mission_or_values` is `let-research-infer`, mine `research/evidence.json::official_sources` for the mission statement and cite verbatim.
2. **`design_system.json::voice.principle_keywords`** — include each word from `feelings_to_evoke` verbatim, plus any official slogan words from `research/evidence.json`.
3. **`design_plan.json::design_intent`** — mirror `design_system.system_thesis` in 1–3 sentences and cite `trust_anchors` once.
4. **`acceptance_criteria.md`** — add ≥ 2 verifiable acceptance bullets that name the chosen feelings (e.g. "Every poster reads as 'knowledge + restraint' within 2 seconds: cited tokens are deep-ink + paper, no decorative gradient, no sans-all-caps stunting").
5. **`task_breakdown.md`** — if `identity_essence` was inferred (default fallback), record the inferred archetype + 1-line rationale here.

### How to use BI (behavior_identity)

1. **`design_system.json::voice.register`** — use `voice_register` verbatim as the register phrase, unless it is `let-the-system-derive`. If `let-the-system-derive`, derive from `identity_essence` via the archetype map below.
2. **`design_system.json::voice.do_say`** — write ≥ 2 concrete phrases that *demonstrate* the chosen register AND the `behavior_signals`. At least one should land in the brief's primary language. Example: if `voice_register = academic-restrained` and `behavior_signals = ["rigorous research", "open collaboration"]`, a `do_say` might be 「以严谨的方法回答开放的问题」.
3. **`design_system.json::voice.do_not_say`** — write ≥ 2 phrases that contradict the register or behavior signals (e.g. for `academic-restrained` + `rigorous research`: "革命性突破", "颠覆行业").
4. **`design_system.json::imagery_strategy.approach`** — adjust based on `primary_audience`. For `peers-experts` / `investors-stakeholders`, prefer technical, data-rich imagery; for `students-talent` / `general-public`, prefer people-centered imagery (back-of-head, hands, silhouettes); for `partners-government`, prefer architectural / civic imagery.
5. **`design_plan.json::copywriting_strategy.headline_principles`** — derive from `voice_register` + `behavior_signals`. Cite both verbatim.
6. **`design_plan.json::target_audience.primary` / `.secondary` / `.tone_keywords`** — map `primary_audience` directly into `primary` (first item if multiple) and `secondary` (second item); copy `behavior_signals` into `tone_keywords`.

### How to use VI (visual_identity)

1. **`design_system_preference`** — branch as described in "Design-system authoring mode" below.
2. **`style_axis_preference`** — use verbatim as `design_plan.json::visual_direction.selected_axis`, unless it is `let-the-system-derive`. If `let-the-system-derive`, use the combined `(identity_essence, voice_register)` map below.
3. **`aesthetic_constraints`** — parse for "must use X" and "avoid X" clauses:
   - "must use" / "include" / "需要使用" / "包含" → add a token / motif / imagery rule that respects the constraint. Example: "must use blue family" → ensure `palette.tokens` has at least one blue token tagged `role: "primary"`.
   - "avoid" / "no" / "don't use" / "不要" / "避免" → add the avoided element to `design_system.json::do_not_use` verbatim (≥ 4 chars or `artifact_lint` ignores it). Example: "avoid neural-net node clusters" → `do_not_use: [..., "neural-net node clusters"]`.
   - If `aesthetic_constraints = "none"` or empty, skip this step.

### Archetype → voice register map (for `voice_register = let-the-system-derive`)

| `identity_essence`        | derived `voice.register`              |
| ------------------------- | ------------------------------------- |
| `knowledge-trust`         | `academic-restrained` (full: "academic + restrained + citation-rich") |
| `innovation-momentum`     | `confident-direct` (full: "future-forward + confident + crisp")        |
| `warmth-community`        | `warm-conversational` (full: "humanistic + warm + accessible")         |
| `authority-permanence`    | `authoritative-formal` (full: "authoritative + composed + enduring")   |
| `craft-restraint`         | `editorial-crafted` (full: "disciplined + spare + considered")          |

### Archetype + register → style_axis map (for `style_axis_preference = let-the-system-derive`)

| `identity_essence`        | preferred `selected_axis`                 | second-choice                          |
| ------------------------- | ----------------------------------------- | -------------------------------------- |
| `knowledge-trust`         | `academic-editorial`                      | `rational-tech`                        |
| `innovation-momentum`     | `rational-tech`                           | `experimental-futurist`                |
| `warmth-community`        | `warm-humanistic`                         | `academic-editorial`                   |
| `authority-permanence`    | `academic-editorial`                      | `rational-tech`                        |
| `craft-restraint`         | `craft-minimal`                           | `academic-editorial`                   |

Archetype → derived defaults map (use when `identity_essence` is a canonical archetype, not free-form):

| Archetype                | Derived voice register                | Suggested style_axis (design_plan)        | Imagery treatment                                   |
| ------------------------ | ------------------------------------- | ----------------------------------------- | --------------------------------------------------- |
| `knowledge-trust`        | academic + restrained + citation-rich | `academic` or `rational-tech`             | Cool grade, restrained contrast, no stock-shine     |
| `innovation-momentum`    | future-forward + confident + crisp    | `rational-tech` or `experimental-futurist`| High clarity, technical diagrams welcome            |
| `warmth-community`       | humanistic + warm + accessible        | `warm-humanistic`                         | People-centered (back-of-head / hands / silhouette) |
| `authority-permanence`   | authoritative + composed + enduring   | `academic`                                | Architectural, symmetrical, civic                   |
| `craft-restraint`        | disciplined + spare + considered      | `academic` or `craft`                     | Editorial, generous whitespace                      |

If the user picked a free-form `identity_essence`, synthesize a custom voice register from the user's words and document the choice in `task_breakdown.md`.

## Design-system authoring mode

For `brand_cultural_design`, read `brief.json::resolvedScope.domain_scope.visual_identity.design_system_preference` and branch BEFORE you write `plan/design_system.json`:

- `use_reference` — if the brief's target maps to a known bundled reference under `.myharness/skills/design-system/reference/`, COPY the reference verbatim into `plan/design_system.json`, then:
  1. Rewrite the `runId` field to the current run id.
  2. Add a `derived_from.reference` field pointing at the reference file path (e.g. `".myharness/skills/design-system/reference/sii.design_system.json"`) so Designer + Critic can trace provenance.
  3. Use the reference as the authority for palette, typography, motif, voice, and lockup.
  4. Note in `task_breakdown.md` that the design system was copied from the bundled reference.

  The only known-reference mapping today is:
  | Target match (substring, case-insensitive)                | Reference file                                                            |
  | --------------------------------------------------------- | ------------------------------------------------------------------------- |
  | `上海创智学院` / `创智学院` / `shanghai innovation institute` | `.myharness/skills/design-system/reference/sii.design_system.json`        |

  If `use_reference` is requested but the target does NOT match any known reference, fall back to `derive_new` behavior and note the fallback rationale in `task_breakdown.md`.

- `derive_new` — synthesize `plan/design_system.json` from `research/evidence.json` + `research/brand_lock.md` per the selected domain.

- `let_system_choose` or absent — keep current behavior (derive from research, optionally consulting the bundled reference as a structural template). Record the choice you actually made + a one-line rationale in `task_breakdown.md`.

# Outputs (write atomically; no partial files; system file first)

All under `.design-harness/runs/<runId>/plan/`:

Use `write_json` for every `.json` file. Use `write_file` only for Markdown or
HTML/text files such as `acceptance_criteria.md` and `task_breakdown.md`.

## Plan File Size Discipline

Planner should preserve design detail without turning JSON tool arguments into
huge escaped strings. Keep JSON fields structured and bounded:

- `purpose`: one short reason for the deliverable, usually 50-150 characters.
- `acceptance_test`: concrete pass/fail criteria, usually 100-250 characters.
- `prompt_seed`: an executable image-prompt seed, usually 300-800 characters.
- `negative_prompt_seed`: compact avoid-list, usually under 180 characters.
- `domain_handoff.execution_notes`: several short bullets are better than one
  very long paragraph.

`prompt_seed` is not the final image prompt. It should capture the image intent,
main subject, view type, required visual anchors, palette token names or hexes,
and essential exclusions. Designer will combine it with `design_system.json`,
`domain_handoff`, the manifest item, research references, and the selected
domain skill to write the full prompt for `image_generate` or `image_edit`.

If a JSON file becomes too large, shorten long string fields first and move
expanded reasoning into `task_breakdown.md` or `acceptance_criteria.md`. Do not
use `write_file` to write a giant escaped JSON string unless `write_json` is
impossible. If a fallback append workflow is used for any JSON file, read it
back and verify it is valid JSON before posting `plan_done`.

1. **`design_system.json`** — write FIRST. The must-use design contract (palette tokens, type roles, grid, motif, voice, lockup, asset usage policy). See the full schema in `default-design-workflow`. Designer + Critic + `artifact_lint` all anchor on this file.
2. **`design_plan.json`** — the canonical plan (see schema below). Carries `design_system_ref: "plan/design_system.json"`.
3. **`acceptance_criteria.md`** — what success looks like, in checklist form. Critic will grade against this. Each criterion that touches palette / type / motif / voice / lockup MUST cite the relevant token name or role name from `design_system.json`.
4. **`task_breakdown.md`** — ordered list of Designer tasks with priorities.
5. **`deliverable_manifest.json`** — exact list of files Designer must produce, with reason and acceptance test for each, and per-deliverable token allocations. Must use this exact schema:

```json
{
  "runId": "string",
  "min_items": 11,
  "design_system_ref": "plan/design_system.json",
  "deliverables": [
    {
      "id": "01-primary-deliverable",
      "file": "artifacts/generated-images/01-primary-deliverable.png",
      "kind": "png",
      "deliverable_category": "key visual",
      "purpose": "Primary domain deliverable selected from domainContext.deliverable_categories",
      "acceptance_test": "The image clearly fits the selected domain, cites required design-system tokens, and satisfies the run-specific brief.",
      "required": true,
      "method": "image_edit",
      "reference_asset_ids": ["best-reference"],
      "required_tokens": ["primary", "ink", "surface"],
      "required_roles": ["display", "caption"],
      "consistency_anchor_ref": "design_system.consistency_lock",
      "size": "1024x1792"
    },
    {
      "id": "00-gallery",
      "file": "artifacts/00-gallery.html",
      "kind": "html",
      "purpose": "Single polished self-contained presentation page with clear sections for final deliverables, design-system context, and optional research provenance",
      "acceptance_test": "Embeds every required final PNG in a primary Final Deliverables section; inline CSS; no JS; no external assets; renders a palette swatch row and type stack callout from design_system.json at the top; if research assets are shown, presents them in a secondary Reference Library/provenance section.",
      "required": true,
      "method": "manual"
    }
  ]
}
```

The top-level field MUST be `deliverables` (not `items`). Each PNG entry MUST include `id`, `file`, `kind`, `deliverable_category`, `purpose`, `acceptance_test`, `required`, and `required_tokens` (a non-empty subset of `design_system.json::palette.tokens[].name`). Optional but recommended: `required_roles` (subset of `design_system.json::typography.roles` keys) and `size`. `method` is one of `image_edit | image_generate | manual` and tells Designer how to produce the artifact. `reference_asset_ids` lists the asset ids from `research/assets/manifest.json` that should be passed to `image_edit` for that deliverable. `artifact_lint` keys off the manifest shape and will hard-fail if it is wrong, including if `required_tokens` cites a name that does not exist in `design_system.json`.

# `design_plan.json` schema

```json
{
  "runId": "string",
  "mode": "extension | rebrand | speculative_concept",
  "design_system_ref": "plan/design_system.json",
  "target_audience": {
    "primary": "string",
    "secondary": "string",
    "tone_keywords": ["string"]
  },
  "design_intent": "1-3 sentence design thesis (mirrors design_system.system_thesis)",
  "domain_handoff": {
    "anchor_lock": {
      "selected_anchor": "string",
      "reason": "string",
      "must_preserve": ["string"]
    },
    "expansion_logic": [
      {
        "deliverable_or_category": "string",
        "reason": "string",
        "source": "brief | research | domainContext"
      }
    ],
    "omitted_expansions": [
      {
        "deliverable_or_category": "string",
        "reason": "string"
      }
    ],
    "execution_notes": ["string"],
    "research_basis": ["source url or research asset id"]
  },
  "visual_direction": {
    "style_axis": ["rational-tech", "academic", "warm-humanistic", "experimental-futurist"],
    "selected_axis": "string",
    "palette_strategy": "Cite design_system.palette.tokens by name.",
    "typography_strategy": "Cite design_system.typography.roles by name.",
    "motif_strategy": "Cite design_system.motif_system.name."
  },
  "copywriting_strategy": {
    "languages": ["zh", "en"],
    "headline_principles": "string",
    "voice_ref": "design_system.voice",
    "on_image_text_notes": "Copy is baked into the rendered PNG via the image_edit / image_generate prompt; describe the exact headline / kicker / lockup wording for each deliverable here."
  },
  "deliverables": [
    {
      "id": "01-primary-deliverable",
      "file": "artifacts/generated-images/01-primary-deliverable.png",
      "purpose": "Primary deliverable for the selected domain",
      "acceptance_test": "...",
      "method": "image_edit",
      "reference_asset_ids": ["best-reference"],
      "required_tokens": ["primary", "ink", "surface"],
      "required_roles": ["display", "caption"]
    }
  ],
  "image_generation_plan": [
    {
      "id": "01-primary-deliverable",
      "method": "image_edit",
      "deliverable_category": "key visual",
      "reference_asset_ids": ["best-reference"],
      "prompt_seed": "300-800 character image-prompt seed. Include subject, view type, key visual anchors, required palette token names or hexes, and essential text intent. Designer expands this into the final image prompt.",
      "negative_prompt_seed": "string",
      "size": "1024x1792",
      "required": true
    }
  ],
  "video_generation_plan": [
    {
      "id": "optional-motion-deliverable",
      "file": "artifacts/generated-videos/optional-motion-deliverable.mp4",
      "method": "video_generate",
      "purpose": "User-requested time-based design deliverable",
      "prompt_seed": "Describe motion, pacing, camera behavior, consistency anchor, and the intended communication outcome.",
      "first_frame": {
        "id": "optional-motion-deliverable-first-frame",
        "file": "artifacts/video-frames/optional-motion-deliverable-first-frame.png",
        "source_deliverable_id": "01-primary-deliverable",
        "method": "image_edit",
        "prompt_seed": "Transform the static anchor into the video's exact opening composition while preserving the approved design identity and preparing the scene for the planned motion.",
        "acceptance_test": "The dedicated first frame preserves the static anchor and clearly establishes the planned video's opening state."
      },
      "ratio": "16:9",
      "duration_seconds": 5,
      "resolution": "720p",
      "generate_audio": false,
      "acceptance_test": "The returned video preserves the approved visual anchor and fulfills the user's requested motion purpose."
    }
  ],
  "designer_constraints": [
    "must respect brand_lock.md (do-not-duplicate)",
    "must respect design_system.json (must-use) — every prompt cites the listed required_tokens hexes verbatim",
    "no AI clichés (random gradients, glowing nodes, generic hex/brain motifs)",
    "no SVG output; no per-deliverable HTML pages; only 00-gallery.html is HTML",
    "preserve any research asset with do_not_replace=true through reference-aware editing",
    "prefer image_edit whenever a reference asset is marked allowed_for_edit=true"
  ],
  "critic_focus": [
    "system_consistency",
    "non_duplication",
    "requirement_coverage",
    "reference_grounding",
    "visual_quality",
    "typography",
    "deliverability"
  ],
  "open_questions_for_user": ["string"]
}
```

# Required Deliverable Set

## Quantity Mode

Read `brief.json::brief` for an explicit quantity signal:

- **Explicit quantity**: user wrote "一张图" / "one image" / "3 张" / "3 images" / "just X" / "only X", etc. Set `min_items = <user count> + 1` to include `00-gallery.html`, choose the most important domain deliverables, and record the quantity decision in `task_breakdown.md`.
- **No quantity signal / "a set" / "full set"**: produce a compact professional set, usually 4-8 PNGs plus `00-gallery.html`. Use more only when the brief explicitly asks for a broad package.

The base output shape is always **a curated PNG image set + one gallery HTML**.
When `resolvedScope.optional_video.enabled` is true, add the planned video as a
supplementary artifact without changing the PNG `min_items` count. Copy,
color, typography, and system notes live in `design_system.json` and are baked
into image prompts where needed.

## Domain Deliverable Starting Points

Use these tables as starting points, then adapt to `resolvedScope`,
`domainContext.deliverable_categories`, and available research assets.

Also read `domainContext.conditional_outputs` and decide which conditional
outputs belong in this run. Write the decision in `task_breakdown.md`: selected
conditionals with reasons, and omitted conditionals with short reasons. The
final `deliverable_manifest.json` should contain only the concrete outputs that
Designer must produce.

Treat each row as a required deliverable category. Expand a category into
multiple concrete PNG manifest entries whenever the brief contains multiple
objects, applications, views, formats, or scenes. For example, if a
brand/cultural brief asks for a tote bag, T-shirt, sticker, and badge, expand
`application-and-merchandise` into separate PNG entries such as `04a-tote-bag`,
`04b-t-shirt`, `04c-sticker`, and `04d-badge`. Set `deliverable_category` on
every expanded entry so Designer and Critic can trace which category it
fulfills.

Important negative boundary: do not collapse explicitly requested multiple
surfaces, products, views, rooms, or media formats into one vague generic PNG.
The concrete manifest entries should match the user's named outputs wherever
the requested scope is feasible.

### `brand_cultural_design`

| category                    | default id/file example                                      | method preference                   |
| --------------------------- | ------------------------------------------------------------ | ----------------------------------- |
| key visual                  | 01-key-visual -> artifacts/generated-images/01-key-visual.png | image_edit when official assets exist |
| color system board          | 02-color-system-board -> artifacts/generated-images/02-color-system-board.png | image_generate |
| typography system board     | 03-typography-system-board -> artifacts/generated-images/03-typography-system-board.png | image_generate |
| application and merchandise | 04-application-merchandise -> artifacts/generated-images/04-application-merchandise.png | image_edit when logo or motif assets exist |
| visual-system board         | 05-system-board -> artifacts/generated-images/05-system-board.png | image_generate |
| gallery                     | 00-gallery -> artifacts/00-gallery.html                      | manual                              |

### `product_design`

| category       | default id/file example                              | method preference           |
| -------------- | ---------------------------------------------------- | --------------------------- |
| hero render    | 01-hero-render -> artifacts/generated-images/01-hero-render.png | image_generate / image_edit |
| three-view     | 02-three-view -> artifacts/generated-images/02-three-view.png | image_generate              |
| usage scene    | 03-usage-scene -> artifacts/generated-images/03-usage-scene.png | image_generate / image_edit |
| detail or interaction view | 04-detail-interaction -> artifacts/generated-images/04-detail-interaction.png | image_generate / image_edit |
| CMF board      | 05-cmf-board -> artifacts/generated-images/05-cmf-board.png | image_generate / image_edit |
| form language board | 06-form-language -> artifacts/generated-images/06-form-language.png | image_generate / image_edit |
| scale reference | 07-scale-reference -> artifacts/generated-images/07-scale-reference.png | image_generate              |
| gallery        | 00-gallery -> artifacts/00-gallery.html              | manual                      |

For product design, prefer `three-view` as the anchor when it exists because it
locks proportion, silhouette, control placement, and CMF. Use `image_edit` from
that anchor for later usage scenes, CMF boards, detail views, form-language
boards, and function annotations whenever the backend accepts the reference.

### `architecture_space_design`

| category                        | default id/file example                                  | method preference           |
| ------------------------------- | -------------------------------------------------------- | --------------------------- |
| hero spatial render             | 01-hero-spatial-render -> artifacts/generated-images/01-hero-spatial-render.png | image_generate / image_edit |
| plan or zoning diagram          | 02-plan-zoning -> artifacts/generated-images/02-plan-zoning.png | image_generate              |
| circulation or user journey     | 03-circulation-journey -> artifacts/generated-images/03-circulation-journey.png | image_generate              |
| section or sectional perspective | 04-section-perspective -> artifacts/generated-images/04-section-perspective.png | image_generate / image_edit |
| material and lighting atmosphere board | 05-material-light-board -> artifacts/generated-images/05-material-light-board.png | image_generate |
| accessibility and scale board   | 06-accessibility-scale-board -> artifacts/generated-images/06-accessibility-scale-board.png | image_generate |
| gallery                         | 00-gallery -> artifacts/00-gallery.html                  | manual                      |

For architecture/space design, plan, circulation, and section images are
explanatory design drawings. They should explain spatial organization,
movement, vertical relationship, scale, and light paths. They are not decorative
mood images. Add site/context relation, interior key moments, facade/elevation,
detail vignettes, day/night pairs, or presentation overview boards when the
brief or research makes those views useful.

### `poster_advertising_design`

| category                       | default id/file example                                  | method preference           |
| ------------------------------ | -------------------------------------------------------- | --------------------------- |
| main poster                    | 01-main-poster -> artifacts/generated-images/01-main-poster.png | image_generate / image_edit |
| key visual or master visual    | 02-key-visual -> artifacts/generated-images/02-key-visual.png | image_generate / image_edit |
| typography and information hierarchy board | 03-typography-hierarchy-board -> artifacts/generated-images/03-typography-hierarchy-board.png | image_generate |
| color and visual rules board   | 04-color-visual-rules-board -> artifacts/generated-images/04-color-visual-rules-board.png | image_generate |
| social adaptation              | 05-social-adaptation -> artifacts/generated-images/05-social-adaptation.png | image_generate |
| gallery                        | 00-gallery -> artifacts/00-gallery.html                  | manual                      |

For poster/advertising design, treat the key visual as a campaign seed. The
main poster proves the complete message hierarchy; adaptations prove that the
same idea survives changed format, crop, and medium. Add banner/horizontal
adaptations, poster series variations, media placement mockups, detail crops,
or campaign asset overview boards when the brief names several formats,
messages, phases, or placement contexts.

## Manifest Rules

Always set `min_items` to the actual deliverable total: required PNG count plus
one for `00-gallery.html`. `artifact_lint` and Designer use this value as the
PNG-count floor.

The manifest contains concrete file-level entries after category expansion. When
the brief names multiple surfaces or views, represent them as separate concrete
items. Keep the category stable in `deliverable_category`, and make the `id`,
`file`, `purpose`, and `acceptance_test` specific to the concrete image.

The manifest path is authoritative. The `file` value in
`plan/deliverable_manifest.json` must be the exact path Designer writes and the
exact path `00-gallery.html` embeds. Use stable numbered filenames from the
manifest, such as `01-hero-spatial-render.png`, and do not switch to a separate
descriptive naming scheme later. If a deliverable is renamed, update the
manifest first, then mirror the same path in `design_plan.json`, sidecars,
`artifact-manifest.json`, and the gallery.

`00-gallery.html` remains a single HTML entry. Plan it to render a variable
number of PNG cards grouped by `deliverable_category`, so categories with one
PNG and categories with several PNGs both read cleanly.

When picking `method`, read `research/assets/manifest.json`:

- Use `image_edit` when a useful reference asset is marked `allowed_for_edit: true`.
- Use `image_generate` when the deliverable is a new concept render or when references are weak.
- Put protected official assets in `reference_asset_ids` only when the deliverable needs to show them while preserving identity.

Match aspect ratio to the medium and reference:

- `1024x1792` for portrait posters and vertical presentation boards.
- `1792x1024` or `1536x1024` for architecture/spatial views and wide scenes.
- `1024x1024` for product hero renders, social adaptations, CMF boards, and compact system boards.
- `2048x2048` for high-detail square outputs when the backend supports it.

If `research/assets/validation.json` reports `ready: false`, plan a smaller
set with fewer reference-dependent deliverables and record the limitation in
`task_breakdown.md`.

# Constraint Patterns To Add

- Protected official marks remain canonical and are preserved through `image_edit`.
- Official names and cited factual claims match `research/evidence.json`.
- Each image prompt quotes the required palette token names or hex values from `design_system.json`.
- Each image prompt names the required typography roles and motif system where they apply.
- The rendered PNGs carry final copy directly when copy is part of the design.
- The only HTML deliverable is `artifacts/00-gallery.html`.

# Communication

When all FIVE files are written and pass a sanity check (`design_system.json` first; then the four plan files), post:

```
design_bus_post(
  runId,
  from: "design-planner",
  to: "design-primary",
  type: "plan_done",
  phase: "PLAN",
  severity: "low" | "medium",
  round: 1,
  summary: "<one line plan thesis> · system: <palette token count> tokens / <type role count> roles / motif:<name>",
  artifactRefs: ["plan/design_system.json", "plan/design_plan.json", "plan/acceptance_criteria.md", "plan/task_breakdown.md", "plan/deliverable_manifest.json"],
  requestedAction: "Proceed to DESIGN"
)
```

If Research evidence has critical gaps you cannot work around, instead post `type: "research_followup"`, `phase: "PLAN"`, `to: "design-primary"`, with a precise list of missing items in `requestedAction`. The Primary will route to Research and re-invoke you.

If Primary re-invokes you to issue a `plan_amendment` (typically because Designer posted a `plan_clarification`), edit only the contradictory fields. If the contradiction touches palette / typography / grid / motif / voice / lockup / asset_usage_policy, the authoritative edit lives in `design_system.json`; mirror the change downstream into the affected `design_plan.json` / `deliverable_manifest.json` / `acceptance_criteria.md` lines. Otherwise edit only the plan files. Then post:

```
design_bus_post(
  runId,
  from: "design-planner",
  to: "all",
  type: "plan_amendment",
  phase: "PLAN",
  severity: "medium",
  round: <current round>,
  summary: "<which fields changed and why>",
  artifactRefs: ["plan/design_plan.json"],
  requestedAction: "Re-read the amended plan fields and proceed."
)
```

# Hard rules

1. `plan/design_system.json` is written FIRST and is the upstream contract for every other plan file. Never produce a `deliverable_manifest.json` whose `required_tokens` reference a name not present in `design_system.json::palette.tokens`.
2. The plan must be executable: every deliverable has a file path, a purpose, an acceptance test, a `method`, and a non-empty `required_tokens` list (PNG entries only).
3. The Critic rubric and your `acceptance_criteria.md` must line up 1:1. If the Critic checks N items, you have defined those N items here. The `system_consistency` dimension must be explicit in the acceptance criteria.
4. Never introduce visual decisions that contradict `brand_lock.md` (do-not-duplicate) or that drift from `design_system.json` (must-use).
5. Never list `spawn_agent` or any other subagent name — Planner does not delegate.
6. Always write all FIVE output files; no partial plans. The order on disk is `design_system.json` → `design_plan.json` → `deliverable_manifest.json` → `acceptance_criteria.md` → `task_breakdown.md`.
7. The base deliverable set is **PNG image set (quantity driven by user intent) + one gallery HTML**. Add video only when `resolvedScope.optional_video.enabled` is true, and keep it outside the PNG `min_items` count. No SVG. No `color-tokens.json` / `typography.md` / `copywriting.md` as separate must-haves — that content now lives in `design_system.json` and gets baked into the rendered PNG via Designer prompts. Always set `min_items` to the actual PNG-plus-gallery total; `artifact_lint` enforces it.


