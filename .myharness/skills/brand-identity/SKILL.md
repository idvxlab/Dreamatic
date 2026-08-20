---
name: brand-identity
description: "Brand identity fundamentals — what counts as identity, how to extend without replacing, palette and typography decisions, and how to avoid generic AI-design clichés."
license: MIT
metadata:
  audience: researcher, planner, designer, reviewer
  workflow: ai-design-harness
  domain_type: brand_cultural_design
---

# Brand Identity Skill

This skill is the domain skill for `brand_cultural_design`. Use it for brand,
institutional identity, cultural merchandise, campaign extensions, and visual
systems. Other domains should load their own domain skill first and only use
`brand-identity` when the run explicitly depends on existing identity assets,
brand lockups, or cultural/institutional recognition.

In the domain-aware workflow, MI / BI / VI are required only for `brand_cultural_design`.

## 0. Positioning before visual identity (the upstream principle)

The single most important rule for designing for an institution or company is **not** "make it look good" and **not** "build a design system first". It is:

> **Design must serve identity recognition and trust building.** Visual identity is the visualisation of an organisation's positioning, values, and credibility. A design system is the layer beneath that — it answers *how to stay consistent*, not *what to be consistent about*. If positioning is unclear, even a perfectly consistent design system is "consistently wrong".

The correct authoring order is:

> **品牌定位 (positioning) → 核心信息 (core message) → 视觉语言 (visual language) → 应用场景 (application scenarios) → design system**

Before anyone writes `plan/design_system.json`, three questions must be answered:

1. **Who is it?** — what does this organisation represent, who does it serve, what is its unique character?
2. **What feelings should it evoke?** — knowledge, professionalism, future-orientation, public trust, warmth, openness, authority, innovation, etc.
3. **What should people remember and trust about it?** — the credibility signal that makes a viewer believe the organisation in 5 seconds.

These are captured for `brand_cultural_design` in `brief.json::resolvedScope.domain_scope.mind_identity`: `identity_essence` (archetype), `feelings_to_evoke` (array of words), `core_mission_or_values` (1-2 lines or `let-research-infer`), and `trust_anchors` (1-2 line credibility signal or `let-research-infer`). They are part of the MI -> BI -> VI clarify flow for brand/cultural runs. Research consumes them when scoping peer references and flagging credibility signals. Planner consumes them when authoring brand/cultural `design_system.json::system_thesis` + `voice` + `acceptance_criteria.md`. Reviewer verifies the design reads as the chosen archetype's feelings within 2 seconds.

### Domain-specific feeling palettes (use as Planner starting points)

| Domain                                       | Feelings to bias toward                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Schools / research institutes / academies    | knowledge, professionalism, future-orientation, public-trust, growth, cultural depth |
| Tech orgs / R&D centers / accelerators       | innovation, efficiency, clarity, reliability, scalability, technical aesthetics       |
| Cultural orgs / NGOs / community programs    | warmth, openness, accessibility, care, humanism                                       |
| Government / foundations / professional bodies | authority, gravitas, permanence, public-trust, continuity                            |
| Design studios / architecture / premium      | craft, restraint, taste, considered restraint, editorial calm                         |

These are *starting points*, not prescriptions. The user's stated `feelings_to_evoke` always wins. When the user picks `let-the-system-choose`, Planner picks from this table based on the brief's surface signals (target domain, language, official slogan) and records the choice in `task_breakdown.md`.

### When positioning is missing

If `resolvedScope.domain_scope.mind_identity` is absent, Planner must:
1. Infer the archetype from research evidence + brief surface signals.
2. Record the inferred archetype + 1-line rationale in `task_breakdown.md`.
3. Treat the inference as low-confidence; Reviewer will flag any drift between the inferred positioning and the rendered set as a `system_consistency` issue.

## 0.5 The MI / BI / VI framework (CIS / 企业识别系统)

Positioning is captured across three concrete layers — the Corporate Identity System (CIS) framework. Master elicits all three at CLARIFY time across three sequential rounds; Planner consumes them in order; Reviewer verifies the rendered set reads as the stated identity.

| Layer | Chinese | What it captures | Where it lives in `brief.json::resolvedScope` | Where it shows up in `plan/design_system.json` |
| ----- | ------- | ---------------- | --------------------------------------------- | ---------------------------------------------- |
| **MI** Mind Identity | 理念识别 | Who is this org, what does it believe, what should people feel + trust? | `mind_identity.identity_essence`, `feelings_to_evoke`, `core_mission_or_values`, `trust_anchors` | `system_thesis`, `voice.principle_keywords`, `derived_from.brief` |
| **BI** Behavior Identity | 行为识别 | How does it act, speak, who is it talking to, what behaviors define it? | `behavior_identity.voice_register`, `primary_audience`, `behavior_signals` | `voice.register`, `voice.do_say`, `voice.do_not_say`, `imagery_strategy.approach` |
| **VI** Visual Identity | 视觉识别 | How should it look — design system choice, style direction, constraints? | `visual_identity.design_system_preference`, `style_axis_preference`, `aesthetic_constraints` | All palette / typography / grid / motif / lockup, plus `do_not_use` (from `aesthetic_constraints`) |

**Authoring order is strict.** MI is upstream of BI; BI is upstream of VI. You cannot pick palette tokens (VI) before deciding the voice register (BI), and you cannot pick the voice register before deciding the identity essence (MI). This is why Master asks them in MI → BI → VI order, and Planner reads them in the same order.

**`let-the-system-derive` for BI/VI fields means "derive from the layer above".** If `behavior_identity.voice_register = "let-the-system-derive"`, Planner uses the `identity_essence` → `voice.register` map. If `visual_identity.style_axis_preference = "let-the-system-derive"`, Planner uses the combined `(identity_essence, voice_register)` → `style_axis` map. Both maps live in `planner.md` and are the only place this derivation logic exists.

**Why all three layers matter for `brand_cultural_design`.** A design system grounded only in MI lacks tone; one grounded only in MI + VI lacks behavioral consistency across applications (the headline copy on a poster will not match the voice of the campus signage). Reviewer's `system_consistency` rubric checks all three layers; missing any layer creates a "consistently wrong" output that Reviewer will hard-fail.

## 1. What "brand identity" actually includes

When Research finds an organisation's identity, it usually contains:

- **Wordmark / logotype** — the typeset name. Often more legally protected than the symbol.
- **Symbol / mark** — the abstract glyph paired with the wordmark.
- **Color system** — primary + secondary palette, often with neutral and semantic ramps.
- **Typography** — display, body, function (UI), CJK + Latin pairing.
- **Voice & tone** — sentence rhythm, register, key phrases.
- **Photography & illustration style**.
- **Naming conventions** — how products, programs, campaigns are named.
- **Lockups** — the canonical pairing of mark + wordmark with required clear space.

Identity is a *system*, not a logo. If you only think about "the logo", you will under-deliver.

## 1.5 Lean Research Priority

For `brand_cultural_design`, keep official identity evidence, but avoid a bloated
reference library. A useful compact research set is:

- 1 official logo, wordmark, or official application screenshot when available
- 1-2 target-owned context/application/cultural references
- 1-2 peer-system or merchandise/application references with clear learning value

Keep extra campus, news, event, or mood images only when they directly affect the
application matrix, motif selection, cultural translation, or protected-asset
rules. Logo and official identity evidence should not be dropped just to reduce
research time.

## 2. Three operating modes

Pick one explicitly in `design_plan.json::mode`:

1. **Extension** — Existing identity is preserved. We design campaigns, applications, sub-brands, and applied surfaces that *honour* the existing system. This is the default whenever Research finds an official identity.
2. **Rebrand** — User explicitly asked to replace the identity. Only triggered by user-resolved scope.
3. **Speculative concept** — No existing identity exists, or the brief is hypothetical / academic. We invent a new system from scratch.

The Reviewer's `non_duplication` hard gate keys off this mode. In **Extension** mode, generating a competing "official logo" is an automatic fail.

## 3. Palette decisions

A serviceable palette needs:

- 1 primary brand color (the "owned" color)
- 1 accent color (used sparingly)
- 1 neutral ink (text)
- 1 neutral paper (background)
- 1–2 semantic colors (warn, success) only if the deliverable set includes UI

Avoid:
- Default-tier blues (#1976D2-ish) that read as "generic SaaS"
- Eight-step random gradients with no system
- Pure black `#000` for text (use `#0d1117` or similar; pure black is harsh in print)
- Sub-AA contrast between text and background

Carry every color choice **into the image_edit / image_generate prompt** as a hex anchor under "PALETTE:". The harness no longer ships a separate `color-tokens.json` deliverable — the rendered PNG is the canonical palette.

## 4. Typography decisions

- Pick **at most 2** typefaces. If CJK is needed, choose the CJK family first and find a Latin companion with matching x-height and weight ramp.
- Define roles: `display`, `headline`, `body`, `caption`, `code` (only if needed).
- Always include a **fallback stack** for HTML deliverables (`"PingFang SC", "Noto Sans SC", "Source Han Sans", system-ui, sans-serif`).
- For zh: prefer humanist / modern sans (PingFang SC, Source Han Sans, Noto Sans SC). For an academic brand, consider Source Han Serif as accent display.

## 5. Logo extension principles

When in **Extension** mode and you need a *secondary* mark (campaign badge, sub-mark, social avatar variant):

- Derive geometry from the existing mark *only if licensed*. Otherwise, design a complementary device that lives alongside, not on top of.
- Maintain the official mark's clear space rules.
- Never call your extension "the new logo of <official org>".

SVG is NOT a deliverable in this harness. If you need a secondary mark, render it as a PNG via `image_edit` (composing the official mark with a complementary device on a plain background) and capture the design intent in the prompt's "EDIT INSTRUCTION" block — geometry, clear-space, palette anchors.

## 6. AI-design clichés to avoid

The Reviewer will flag these automatically. Designer must self-check:

- Random radial / linear gradients without semantic purpose
- "AI glowing nodes" or "neural net" motifs
- Hexagonal honeycombs, brain silhouettes, circuit boards as generic tech-ness
- Holographic / iridescent foil because "futuristic"
- Sans-serif type set in all-caps with extreme letter-spacing as the only "design move"
- Lorem ipsum, fake Latin, or `Sample Headline` placeholder copy
- Center-aligned everything (no hierarchy)
- Emoji as design elements when the brand is professional

## 7. Cultural & contextual checks (CJK-specific)

- Use **full-width** punctuation in CJK paragraphs (，。：；！？), not half-width.
- Don't mix simplified and traditional characters unless the brand explicitly does.
- Vertical-set CJK is acceptable for posters; ensure ruby / annotation handling is correct if used.
- Names of real organisations must match Research evidence exactly, including company suffix and translation.

## 8. Deliverable craftsmanship checklist

For every deliverable produced:

- Does it reference at least one palette token by name?
- Does it have a clear focal point?
- Would you ship it to a paying client?
- Could a designer hand it off as a starting point for production?
- Is the language register consistent with the voice declared in the plan?
- Is there *one* idea you can name in a single sentence?

If the answer to any is "no", revise before posting `design_done`.

## 9. Baseline Brand-Cultural Outputs

For `brand_cultural_design`, Planner should normally cover these required
categories:

- key visual
- color system board
- typography system board
- application and merchandise
- visual-system board

Optional additional categories include poster series, social media cards,
environmental applications, and motif/detail boards.

These are categories. If the brief names several applications or merchandise
items, Planner should expand `application and merchandise` into multiple
concrete PNG entries in `plan/deliverable_manifest.json`, while keeping the same
`deliverable_category` for traceability.

Planner should reason from the concrete brand/cultural problem before
finalizing the manifest:

- several named merchandise items -> split application/merchandise into one PNG per item or coherent item group
- public campaign or recruitment communication -> add poster or social-media adaptations
- physical place, exhibition, campus, or event context -> add signage/environmental application
- rich cultural symbol system -> add motif/detail board
- strong official identity assets -> use key visual, logo/mark, or motif as the consistency anchor for all applications

Record selected and omitted expansions in `design_plan.json::domain_handoff` so
Designer and Reviewer can understand why the package has that shape.
