---
name: critic-rubric
description: "The canonical scoring rubric used by reviewer for the PNG-set + gallery shape, with thresholds and hard-fail rules. Planner and Designer load this to make sure their work targets the same bar."
license: MIT
metadata:
  audience: planner, designer, reviewer
  workflow: ai-design-harness
---

# Reviewer Rubric Skill

## 1. Dimensions, 1–5 each

| Dimension                    | What it scores                                                                                                | Threshold |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | --------- |
| `requirement_coverage`       | Every deliverable declared in `plan/deliverable_manifest.json` is present (all required PNGs + `00-gallery.html`) and on-brief. The count is driven by `min_items` and the selected domain's manifest, so compact and expanded runs may have different PNG totals.    | ≥ 4       |
| `research_compliance`        | Designer respected `research/brand_lock.md` and cited facts from `research/evidence.json`                      | ≥ 4       |
| `non_duplication`            | No replacement of any reference asset flagged `do_not_replace: true`; no copied marks                          | = 5       |
| `reference_grounding`        | Each generated PNG ties back to a Research asset (used by `image_edit`) or a Research fact in the prompt       | ≥ 4       |
| `system_consistency`         | Every required PNG cites the same `design_system.json` palette tokens, type roles, motif, voice, lockup; no palette/type/motif drift across the set | ≥ 4       |
| `visual_quality`             | Composition, hierarchy, restraint, intentionality across the PNG set                                           | ≥ 4       |
| `typography`                 | On-image text hierarchy clean, contrast OK, CJK rules respected                                                | ≥ 4       |
| `layout_hierarchy`           | One focal point per PNG; consistent system across the set                                                      | ≥ 4       |
| `professionalism`            | Reads like a real proposal, not a prompt experiment                                                            | ≥ 4       |
| `cultural_appropriateness`   | Language, names, punctuation, idioms correct in PNG text + gallery                                             | ≥ 4       |
| `deliverability`             | `artifact-manifest.json` accurate; gallery embeds every PNG; lint clean; no external assets                    | ≥ 4       |

## 2. Score band semantics

- **5** — Excellent. Could ship to a paying client.
- **4** — Acceptable. Some polish possible but no blockers.
- **3** — Needs revision. Identify what's missing.
- **2** — Poor. Substantive issues across the dimension.
- **1** — Fail. Off-brief, broken, or AI-default.

## 3. Hard-fail rules (any one triggers `hard_fail: true`)

1. A required PNG or `00-gallery.html` is missing or empty.
2. `non_duplication < 5` while plan mode is `extension` — **Designer regenerated any asset flagged `do_not_replace: true`**.
3. Fewer PNG files exist under `artifacts/` than the number of required PNG deliverables declared in `plan/deliverable_manifest.json` (i.e. `artifact_lint` stat `required_png_count`). Use `artifact_lint`'s `stats.required_png_count` as the floor — do NOT hard-code 10.
4. `00-gallery.html` does not embed every required PNG.
5. `artifact_lint` returns `ok: false` after Designer claimed `design_done`.
6. Gallery HTML has external `https://` references, `<script>` blocks, or other non-self-contained content.
7. Designer rationale directly contradicts `research/evidence.json`.
8. `plan/design_system.json` is missing, schema-invalid, or referenced by a `required_tokens` entry that does not exist in `palette.tokens` — Designer should not have entered DESIGN; route a `plan_amendment` to Planner via Master.
9. `system_consistency < 4` — Designer drifted from the design system across the PNG set (palette splits, motif missing on > half, lockup string drift, or do_not_use violations).

When `hard_fail: true`, set `verdict: "fail"` regardless of other scores.

Gallery presentation note: a strong `00-gallery.html` uses clear sections for final deliverables, design-system context, and optional research provenance. Reference images should read as supporting source material rather than competing with the final generated/edited outputs.

Manifest/gallery path consistency: every required PNG path declared in
`plan/deliverable_manifest.json` must exist and must be the same path embedded
by `00-gallery.html` and recorded in `artifacts/artifact-manifest.json`. Treat
renamed or substituted files as a deliverability issue; hard-fail when the
declared required file is missing.

## 3.1 Domain-Aware Scoring

Read `brief.json::resolvedScope.domain_type` and `brief.json::domainContext`
before scoring. The same file completeness and lint gates apply to every run,
but the professional lens changes by domain.

Add these two scores to `critique.json::scores`:

- `domain_fit`: whether the artifact set fits the selected `domain_type` and uses the expected deliverable categories from `domainContext`.
- `professional_fit`: whether the work addresses the selected domain's professional factors rather than only looking visually pleasant.

Category coverage rule:

- Read `domainContext.required_outputs` and `domainContext.deliverable_categories`.
- Read every required PNG entry in `plan/deliverable_manifest.json`.
- Treat manifest entries as concrete files and `deliverable_category` as the broader requirement they satisfy.
- A category may be satisfied by one or more PNGs; multiple PNGs for one category are expected when the brief asks for several objects, applications, scenes, or formats.
- Flag a `requirement_coverage` or `domain_fit` issue when a required category is absent from the manifest, when a required manifest PNG is missing, or when all PNGs in a category are off-brief.
- Flag a hard failure when `00-gallery.html` hides expanded outputs by showing only one representative PNG while required concrete PNG files for that category exist.

Domain lenses:

- `brand_cultural_design`: identity recognition, cultural translation, visual-system coherence, reference grounding, and production readiness.
- `product_design`: user scenario, functional clarity, form/material coherence, scale plausibility, CMF, and product-render completeness.
- `architecture_space_design`: spatial logic, program fit, plan/zoning clarity, circulation/user journey, section or vertical relationship, site/context relationship, material atmosphere, lighting, accessibility, and human scale.
- `poster_advertising_design`: message clarity, hierarchy, visual hook, key visual consistency, audience fit, format readiness, placement readiness, CTA survival, and campaign consistency.

Domain-specific gallery quality:

- Architecture/space galleries should read as a design presentation: concept,
  system, spatial logic, experience renders, detail/atmosphere, and references.
  A gallery that only lists render cards without explaining plan, circulation,
  section, material/light, and scale relationships should lose
  `professional_fit`.
- Poster/advertising galleries should read as a campaign presentation: campaign
  thesis, master visual, main poster, visual rules, format adaptations, and
  placement or detail views when present. A gallery that shows unrelated poster
  variants without a shared key visual/message hierarchy should lose
  `system_consistency` and `professional_fit`.

Do not force non-brand domains through MI / BI / VI. For non-brand domains,
`design_system.json` is judged as the visual/presentation system for the PNG
set, not as a corporate identity replacement.

## 4. Soft-fail rule

Even without `hard_fail`, if **any** threshold in §1 is missed, set `verdict: "fail"` and `next_action: "revise"`.

## 5. Patch list format

The patch list must be **specific**. Each item:

```json
{
  "id": "p1",
  "artifact": "artifacts/edits/01-primary-deliverable.png",
  "severity": "high | medium | low",
  "issue": "Concrete description of what's wrong",
  "fix": "Concrete instruction Designer can act on (e.g. re-run image_edit with referenceImagePaths=...)"
}
```

Bad patch item: `"poster needs more contrast"`.

Good patch item: `"01-primary-deliverable.png sidecar lists no references; re-run image_edit with referenceImagePaths=['research/assets/official-logo.png'] and a prompt that places the protected mark in a clearly specified position while preserving its identity."`

## 6. Nice-to-have list

Use sparingly. Only items that would lift a 4 to a 5. Designer is **not** required to act on these unless Master requests it.

## 7. Confidence

Reviewer must declare its own confidence in the verdict: `low | medium | high`. Low confidence is acceptable when:

- The brief is genuinely ambiguous and Research found little evidence.
- A creative judgment call could go either way.

When confidence is `low`, Master should consider escalating to the user with a `ask_user` tool call before triggering a revision round.

## 8. Regression vigilance

For rounds ≥ 2, additionally check:

- Did any dimension that scored 4+ in the previous round drop below 4 in this round?
- Did any dimension that was the subject of a previous repair instruction still fail in this review?
- Did this repair round introduce new clichés or drift from an amended constraint?

If yes to any, set `severity: "high"` in the `evaluator_fail` message and call out the regression explicitly.

## 9. Reviewer ethics

- Do not soften the verdict to be polite.
- Do not invent issues to look thorough.
- Do not score against your personal taste; score against `plan/acceptance_criteria.md`, `brand_lock.md`, and `research/assets/manifest.json`.
- Cite the exact file (and PNG id) you are referencing when calling out an issue.

## 10. `system_consistency` mechanics

`system_consistency` is the cross-PNG coherence dimension. Score it from mechanical signals, then validate with vision.

Mechanical signals (Reviewer computes by reading every required PNG sidecar's `prompt` field; `artifact_lint` also emits these in `report.stats`):

- `primary_token_coverage_pct` — fraction of required PNG sidecars that mention the primary token's hex OR name.
- `palette_drift_count` — number of unique hex literals in any sidecar prompt that are NOT in `design_system.palette.tokens[].hex`.
- `motif_usage_count` — number of sidecars whose prompt names `design_system.motif_system.name`.
- `lockup_string_drift_count` — number of sidecars that show the lockup region but quote a lockup string that does not match `design_system.lockup.string_zh` / `string_en`.
- `do_not_use_violation_count` — number of sidecars whose prompt contains any string from `design_system.do_not_use`.

Score band reference (must be filled into `critique_round_<N>.json::system_consistency_signals`):

| Signal                          | 5 (excellent) | 4 (acceptable) | 3 (fail) | 2 (poor) | 1 (broken) |
| ------------------------------- | ------------- | -------------- | -------- | -------- | ---------- |
| `primary_token_coverage_pct`    | ≥ 0.90        | ≥ 0.70         | ≥ 0.50   | ≥ 0.30   | < 0.30     |
| `palette_drift_count`           | ≤ 1           | ≤ 2            | ≤ 4      | ≤ 6      | > 6        |
| `motif_usage_count`             | ≥ N/2         | ≥ N/3          | ≥ N/4    | ≥ 1      | 0          |
| `lockup_string_drift_count`     | 0             | ≤ 1            | ≤ 2      | ≤ 3      | > 3        |
| `do_not_use_violation_count`    | 0             | 0              | ≤ 2      | ≤ 4      | > 4        |

Score is the **minimum** band across the five signals. A single drift signal at band 3 drops `system_consistency` to 3 and triggers hard fail.

Vision validation (mandatory): use `view_image` to confirm the mechanical signals. If the signals say "consistent" but vision shows two visibly different blues, the visual finding wins.

## 11. Hard rules

1. `non_duplication` is the absolute hardest gate. Re-checking the sidecar of every required PNG:
   - if `tool: "image_edit"` and the sidecar's `references` include a `do_not_replace` asset, that is OK.
   - if `tool: "image_generate"` produced a PNG whose id matches a `do_not_replace` asset id, that is an automatic fail.
2. `reference_grounding` HARD-FAILS on the lowest band when the asset library has multiple `allowed_for_edit` assets and Designer used none of them.
3. `system_consistency` HARD-FAILS at `< 4` and MUST cite the mechanical signals — a vibes-based score is invalid.
4. Reviewer does NOT regrade the PNG by re-running the model. Reviewer reads the sidecar, looks at the embedded image in the gallery, and judges accordingly.
5. Anchor tallies on `artifact_lint`'s `stats` block — `required_png_count`, `grounded_png_count`, `edited_png_count`, `generated_png_count`, `editable_asset_count`, `protected_asset_count`, `protected_assets_edited`, `primary_token_coverage_pct`, `palette_drift_count`, `motif_usage_count`, `lockup_string_drift_count`, `do_not_use_violation_count`. These are computed directly from sidecars and should not be re-derived by counting in your head.

