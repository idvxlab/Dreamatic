---
name: design-system
description: "How to author `plan/design_system.json` — the must-use contract every deliverable in a run shares (palette tokens, type roles, grid, motif, voice, lockup, imagery, asset usage). Owned by design-planner; consumed by Designer + Critic + artifact_lint. Includes a worked SII example."
license: MIT
metadata:
  audience: design-planner, design-designer, design-critic
  workflow: ai-design-harness
---

# Design System Skill

## 1. Why this exists

A design system is the set of **must-use** rules every deliverable in a run shares: palette tokens, typography stack and roles, grid, motif language, voice / tone, lockup geometry, imagery treatment, asset-usage policy, and the cross-deliverable "do not use" list. Without a single source of truth, each PNG re-derives palette / type / motif from scratch and the resulting set never coheres.

**Domain context is upstream of this file.** `design_system.json` answers how the PNG set stays visually coherent. For `brand_cultural_design`, this coherence is grounded in MI / BI / VI from `resolvedScope.domain_scope` and the `brand-identity` skill. For `product_design`, `architecture_space_design`, and `poster_advertising_design`, this coherence is grounded in `domainContext`, the selected domain skill, and the run's deliverable categories.

For non-brand domains, a design system is a presentation and visual-system contract: palette, typography, layout, motif language, material/atmosphere cues, imagery treatment, and cross-deliverable consistency. It does not imply a new corporate identity or mandatory lockup unless the brief requires one.

The harness writes the system to `plan/design_system.json`. Planner owns it. Designer reads it before every prompt. Critic verifies cross-PNG consistency against it. `artifact_lint` enforces presence + schema + per-sidecar citation.

This is distinct from `brand_lock.md`, which is the **do-not-duplicate** contract (Research-owned). The lock says what the existing identity already owns; the system says what the run will use.

Reference assets are broader than final assets. Research may save many useful images in `research/assets/` so the team can inspect the visual territory; the design system should describe how to select from that library, not require every reference to appear in the final PNG set. Put protected official marks in `asset_usage_policy.do_not_replace_asset_ids`, and describe which kinds of references are preferred for editing, mood, layout, or citation.

## 2. The canonical schema

The schema is defined in `default-design-workflow`. Required top-level keys:

- `schema_version` (SemVer string)
- `runId`
- `mode` (`extension | rebrand | speculative_concept`)
- `palette` — `tokens[]` (≥ 4 entries with `name`, `hex` matching `/^#[0-9a-fA-F]{6}$/`, `role`), `contrast_rules`, `do_not`
- `typography` — `stack_cjk` / `stack_latin` / `stack_mono`, `roles` (at least `display` + `headline` + `body`), `cjk_punctuation`, `lockup_rule`
- `grid` — at least one of `poster_1024x1792` / `social_1024x1024` / `banner_1792x1024`
- `motif_system` — `name`, `description`, `do`, `do_not`
- `imagery_strategy` — `approach`, `photo_treatment`, `no_stock_cliches`
- `voice` — `register`, `principle_keywords`, `do_say` (≥ 2), `do_not_say` (≥ 2)
- `lockup` — at least one of `string_zh` / `string_en`, `clear_space_px`, `placement_rules`
- `asset_usage_policy` — `do_not_replace_asset_ids`, `preferred_tool`, `image_generate_use_when`
- `do_not_use` — cross-deliverable cliché list

Optional but recommended: `derived_from`, `system_thesis`.

## 3. How to choose palette tokens

Aim for **5–7 tokens**. Fewer than 4 fails the lint. More than 8 confuses Designer.

| Role        | What it does                                                                     |
| ----------- | -------------------------------------------------------------------------------- |
| `primary`   | The brand-owned color. Headlines and identity. **Exactly one token has this role.** |
| `secondary` | Optional second hue for system extension. At most one.                           |
| `text`      | Ink for body / headlines on paper. Usually near-black (#0A1A2F, not pure #000).  |
| `surface`   | Paper / background. Light surface for print; deep surface for dark-mode variants.|
| `accent`    | ≤ 5 % visual area. Use `usage_pct_max: 5` to advise.                              |
| `semantic`  | Optional warn / success / info colors (only when UI deliverables exist).         |
| `mono`      | A neutral grey for meta strips / dividers.                                       |

Pull primary + (when relevant) secondary from `research/evidence.json::existing_brand_assets` color clues. Invent the rest with restraint.

Avoid:
- Two blues (Critic flags "palette split").
- Eight-step gradient as a token.
- Pure black (#000) for text — harsh in print and on screen.

## 4. How to choose typography roles

Pick at most **2 typefaces** (one CJK family + one Latin companion). The mono is for meta strips only and may share an existing system font.

Required roles:

| Role     | Use                                            | Size at 1024×1792 |
| -------- | ---------------------------------------------- | ----------------- |
| display  | Poster hero headline                           | 96–140 px         |
| headline | Section heading; signage primary line          | 48–80 px          |
| body     | Supporting copy; letter body                   | 18–24 px          |

Optional roles:

| Role     | Use                                            | Size at 1024×1792 |
| -------- | ---------------------------------------------- | ----------------- |
| subhead  | Kicker; signage secondary line                 | 28–40 px          |
| caption  | Footer meta; swatch labels                     | 14–18 px          |
| mono     | Data strips; room codes; date/location         | 14–18 px          |

When `brief.json::language` contains `zh`, `stack_cjk` is required. The CJK family is chosen FIRST; the Latin family is its companion.

## 5. How to choose motif and voice

- **Motif:** a single auxiliary graphic language that supports — never competes with — the official mark. Give it a name (English + zh) that Designer can quote verbatim in prompts. Provide ≥ 2 `do` rules and ≥ 2 `do_not` rules.
- **Voice:** the register the brand speaks in. `do_say` and `do_not_say` each need ≥ 2 concrete phrases (not categories). `do_not_say` is how `artifact_lint` detects voice drift via the `sidecar.do_not_use` rule.

## 6. How to choose lockup

- For brands with both Chinese and English names: `string_zh` and `string_en` both filled, and `placement_rules` describes the bilingual stack (CJK on top, Latin under-line, by convention).
- `clear_space_px`: a numeric minimum (we use 32 px at 1024-wide; scale linearly for larger sizes).

## 7. How Designer consumes the system

Every `image_edit` / `image_generate` prompt MUST contain these blocks verbatim (see `design-designer.md` §"Production order"):

```
PALETTE:
  brand-blue #0168B7
  ink        #0A1A2F
  paper      #F7F8FA
TYPE:
  display:  Source Han Sans CN Bold / Montserrat Bold @ 112–140 px
  caption:  Source Han Sans CN Regular @ 14–18 px
MOTIF:
  Frontier Signal Grid — thin blueprint rule lines + monospaced coord tags
LOCKUP:
  "上海创智学院 / Shanghai Innovation Institute"
ON-IMAGE TEXT (verbatim):
  headline (zh): "..."
  headline (en): "..."
DO NOT:
  - Do not introduce a second blue or 'sky blue'.
  - Do not draw neural-net node clusters, glowing brains, or honeycombs.
```

Paraphrasing a hex (`"deep blue"` instead of `#0168B7`) is a `sidecar.token_citation` warning. The primary token's hex OR name MUST appear in ≥ 70 % of required PNG sidecars.

## 8. How Critic verifies (cross-PNG)

`design-critic` reads every sidecar's `prompt` field and computes mechanical signals:

- `primary_token_coverage_pct` — fraction of sidecars citing the primary token's name OR hex.
- `palette_drift_count` — hex literals that are NOT in the token set.
- `motif_usage_count` — sidecars naming `motif_system.name`.
- `lockup_string_drift_count` — sidecars showing the lockup but quoting a different string.
- `do_not_use_violation_count` — sidecars containing any `do_not_use` phrase.

`artifact_lint` also emits these in `report.stats`. Critic's `system_consistency` score is the **minimum** band across the five signals (see `critic-rubric` SKILL §10). `< 4` is a hard fail.

## 9. Reference example: 上海创智学院 / Shanghai Innovation Institute

See `reference/sii.design_system.json` in this skill directory for a fully-formed example that:

- Cites a real official source (sii.edu.cn) with `--mainColor: #0168B7` and `SourceHanSansCN-Regular` + `Montserrat-Medium` in the CSS.
- Defines six palette tokens, six typography roles, three grid sizes, the "Frontier Signal Grid" motif, an explicit `do_say` / `do_not_say` voice, a bilingual lockup, and a five-item `do_not_use` cliché list.
- Marks `official-logo` and `official-logo-page-screenshot` as `do_not_replace_asset_ids`.

Use it as a template — **copy the structure, replace every field with content derived from THIS run's research evidence**. The SII example assets (logo, slogan, address) only apply to a 上海创智学院 brief; for any other target, regenerate the content while keeping the schema shape.

### 9.1 Preference flow (`design_system_preference`)

This flow applies primarily to `brand_cultural_design`, where the user may choose whether to preserve a known reference system, derive a new extension, or let the system choose. For other domains, Planner may still record a visual-system preference, but it should be inferred from `domainContext`, the selected domain skill, and the brief instead of forcing a VI clarification round.

| Value                | Planner behavior                                                                                                                                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `use_reference`      | If the target maps to a bundled reference (see §9.2), copy the reference into `plan/design_system.json`, rewrite the `runId` field, and add `derived_from.reference: "<reference path>"`. If no reference matches, fall back to `derive_new` and note the fallback rationale in `task_breakdown.md`. |
| `derive_new`         | Synthesize a brand-new design system from `research/evidence.json` + `research/brand_lock.md` per the selected domain and brief. |
| `let_system_choose`  | Keep current behavior (derive from research, optionally consulting the bundled reference as a structural template). Record the actual choice + rationale in `task_breakdown.md`.                                                                                                                                                          |
| absent / free-form   | Treat as `let_system_choose`. Free-form answers are recorded verbatim in `task_breakdown.md` so they are not lost.                                                                                                                                                                                                                        |

Primary does not always ask a `design_system_preference` question. Ask it only when the selected domain and brief make the choice consequential, most commonly for `brand_cultural_design` runs that may use a bundled or official identity reference. Otherwise infer a reasonable visual-system approach and record it in `task_breakdown.md`.
- If the target name maps to a known reference (see §9.2), Planner prefers `use_reference`.
- Otherwise, Planner falls back to `derive_new` or a domain-appropriate visual-system approach and records the rationale in `task_breakdown.md`.

### 9.2 Known-reference target map

The lookup is a literal substring match, not a registry. The only mapping today is:

| Target match (substring, case-insensitive)                  | Reference file                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| `上海创智学院` / `创智学院` / `shanghai innovation institute` | `.myharness/skills/design-system/reference/sii.design_system.json`        |

To add a new reference, drop a new `<slug>.design_system.json` under this skill's `reference/` directory and add a substring-match rule in §9.2.

## 10. Hard rules

1. Write `plan/design_system.json` BEFORE any other plan file. Other plan files reference its tokens by name.
2. Every `palette.tokens[].hex` MUST match `/^#[0-9a-fA-F]{6}$/`. Lowercase preferred.
3. Exactly one token should carry `role: "primary"`. If you don't pick, `loadDesignSystem` falls back to `tokens[0]`.
4. `typography.roles` MUST include `display`, `headline`, `body`. Other roles are optional.
5. `voice.do_say` and `voice.do_not_say` MUST each have ≥ 2 concrete entries.
6. `lockup` should define at least one of `string_zh` / `string_en` when the run has a brand, institution, event title, or repeated public-facing name. For product and spatial concepts without a lockup, record an empty or minimal lockup with a rationale.
7. `motif_system.name` is required and must be a non-empty string Designer can quote verbatim in prompts.
8. `do_not_use` is the cross-deliverable cliché list; `artifact_lint` scans every sidecar prompt for these phrases. Keep entries ≥ 4 chars or they are ignored to avoid false positives.
9. Never modify `design_system.json` from Designer or Critic. Edits go through Planner via a `plan_amendment` round routed by Primary.
