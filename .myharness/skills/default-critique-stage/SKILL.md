---
name: default-critique-stage
description: "Detailed critique-stage instructions used by default-design-workflow, including domain-aware review, artifact lint, hard failures, repair guidance, and final verdict."
license: MIT
---
# Role

These are the detailed Critique-stage instructions for
`default-design-workflow`. Apply them while acting as `design-critic`.

You review one artifact set under `<runDir>/artifacts/`.

## Domain-Aware Override

Before reviewing, read `<runDir>/brief.json` and identify:

- `brief.json::resolvedScope.domain_type`
- `brief.json::resolvedScope.professional_skills`
- `brief.json::resolvedScope.domain_scope`
- `brief.json::domainContext`

Load `default-design-workflow` and `critic-rubric`.

If `professional_skills` contains user-selected Skills, load them and derive
the professional scoring lens from their instructions, the plan, and the
acceptance criteria. Do not require a built-in domain or `domainContext`.
This override takes precedence over built-in-domain instructions later in this
Skill.

Otherwise load exactly one built-in domain Skill:

- `brand_cultural_design` -> `brand-identity`
- `product_design` -> `product-design`
- `architecture_space_design` -> `architecture-space`
- `poster_advertising_design` -> `poster-advertising`

For built-in domains, use `domainContext.evaluation_focus` as the
domain-specific scoring lens. For external professional Skills, evaluate
against their instructions and the run-specific acceptance criteria.

## Workflow

1. Load skills as described in "Domain-Aware Override".
2. Read brief, research, plan, artifacts, and gallery.
3. Run `artifact_lint` with `requireGallery: true`.
4. Inspect whether the output satisfies:
   - brief fit
   - research grounding
   - visual coherence
   - consistency anchor preservation
   - artifact completeness
   - required deliverable category coverage
   - manifest/gallery path consistency
   - presentation-page narrative quality
   - production readiness
   - requested video completeness and anchor consistency when
     `resolvedScope.optional_video.enabled` is true
5. Write `<runDir>/review/critique.md`.
6. Write `<runDir>/review/critique.json`.
7. Post `evaluator_pass` if the package is ready.
8. Post `evaluator_fail` if there are hard failures, with concrete repair instructions for one designer repair pass.

Use `write_json` for `review/critique.json`. Use `write_file` for
`review/critique.md`.

## Hard Failures

Fail the artifact set if:

- required files are missing
- gallery does not reference the generated PNGs
- `artifact_lint` reports errors
- required deliverable categories from the manifest/domain context are missing
- gallery shows only one representative PNG for a category while omitting other required concrete PNGs
- a required manifest file path does not exist because Designer wrote the artifact under a different filename
- placeholder text remains
- protected identity assets are replaced or misused
- the output is only prose and no image artifact exists
- final PNGs visibly drift from the run's declared consistency anchor
- `resolvedScope.optional_video.enabled` is true but the dedicated first frame,
  planned video, or metadata is missing, unplayable, absent from
  `artifact-manifest.json`, or the video is not presented in the gallery

For `architecture_space_design`, treat missing explanatory spatial logic as a
serious domain issue: if the plan required plan/zoning, circulation/user
journey, or section/sectional perspective images and they are absent from the
gallery or artifact set, fail `domain_fit` and request repair.

For `poster_advertising_design`, treat adaptation drift as a serious domain
issue: if social/banner/series/placement outputs exist but do not preserve the
same key visual, message hierarchy, palette, and graphic device, fail
`professional_fit` and request repair.

## Critique JSON Shape

Write a compact JSON object:

```json
{
  "verdict": "pass",
  "scores": {
    "brief_fit": 4,
    "research_grounding": 4,
    "visual_coherence": 4,
    "consistency_anchor": 4,
    "domain_fit": 4,
    "professional_fit": 4,
    "artifact_completeness": 5,
    "production_readiness": 4
  },
  "domain_type": "product_design",
  "domain_specific_findings": [],
  "hard_failures": [],
  "repair_instructions": [],
  "summary": "Ready to package."
}
```

Use `"verdict": "fail"` when hard failures exist.

## Bus Contract

Post to `design-primary`:

- `type: "evaluator_pass"` when ready
- `type: "evaluator_fail"` when a repair pass is needed

Use `from_agent: "design-critic"`.
