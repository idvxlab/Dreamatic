---
name: poster-advertising
description: "Poster, advertising, event key-visual, and campaign communication guidance for Dreamatic: message hierarchy, visual hook, media adaptation, and critique focus."
license: MIT
metadata:
  audience: researcher, planner, designer, reviewer
  workflow: ai-design-harness
  domain_type: poster_advertising_design
---

# Poster & Advertising Design Skill

This skill supports `poster_advertising_design` runs. It is a first-pass domain
framework for communication-first visuals.

## 1. Domain Positioning

`poster_advertising_design` covers:

- standalone posters
- event key visuals
- advertising campaign images
- recruitment or announcement posters
- social-format adaptations of one communication idea

Use this domain when the main deliverable is the communication visual itself.
If the brief asks for a broader identity and merchandise system, prefer
`brand_cultural_design`.

## 2. Scope Fields

Read `brief.json::resolvedScope.domain_scope`:

```json
{
  "communication_goal": {
    "campaign_goal": "string",
    "target_action": "string",
    "audience": "string"
  },
  "message_hierarchy": {
    "key_message": "string",
    "supporting_info": ["string"],
    "info_density": "minimal | moderate | dense | string"
  },
  "visual_direction": {
    "visual_tone": "string",
    "visual_hook": "string",
    "format_requirements": "string"
  }
}
```

Master should ask for missing key message, audience/action, or format only
when these are not inferable from the brief.

## 3. Research Guidance

Research should keep research lean. Collect references only when they can shape
message hierarchy, key visual, typography, format adaptation, or placement. A
useful compact set is:

- 1-2 similar campaign, event, or poster references
- 1 key visual or master-visual-system reference
- 1 typography or information hierarchy reference
- 1 media-format, placement, or adaptation reference when the brief requests multiple formats
- 1 cultural or subject-matter image only when it affects the visual hook

Research should prioritize communication references, not only institutional
identity assets.
Skip generic mood-board images that do not change copy hierarchy, format,
placement, or the key visual.

## 4. Planner Guidance

Planner should define:

- communication thesis
- key message and supporting information hierarchy
- visual hook and key visual/master visual logic
- format set and aspect ratios
- color and visual rules for adaptation
- adaptation matrix: which message, crop, CTA, and visual element survives in each medium
- image-generation plan tied to message hierarchy

Recommended deliverable categories:

- main poster
- key visual or master visual
- color and visual rules board
- typography and information hierarchy board
- social adaptation

Optional additional categories:

- banner or horizontal adaptation
- poster series variation
- typographic/detail crop
- media placement mockup
- campaign asset overview

These are categories. If the brief names multiple media formats, campaign
phases, or poster sizes, Planner may expand one category into several concrete
PNG entries in `deliverable_manifest.json`.

Planner should reason from the concrete communication problem before finalizing
the manifest:

- several messages, dates, speakers, products, or campaign phases -> add poster series variations
- multiple channels or aspect ratios -> add banner/social/adaptation entries
- dense information -> add typography or copy hierarchy detail board
- public placement or launch context matters -> add media placement mockup
- the brief needs a reusable campaign look -> make the key visual the anchor for every adaptation
- several formats need to be understood as one system -> add a campaign asset overview
- format constraints differ strongly, such as portrait poster plus wide web banner plus square social post -> define a format adaptation matrix before writing the manifest

Record selected and omitted expansions in `design_plan.json::domain_handoff` so
Designer and Reviewer can understand why the package has that shape.

## 5. Designer Guidance

Designer should produce PNGs that communicate quickly and clearly.

Each image prompt should include:

- key message or headline intent
- visual hook and key visual/master visual logic
- hierarchy: what should be seen first, second, third
- color and visual rules that must carry across adaptations
- tone and audience
- format and aspect ratio
- how the crop changes while preserving the same key visual, headline hierarchy, palette, and graphic device
- required language or text handling
- the selected consistency anchor, usually the main poster or key visual
- any `domain_handoff.execution_notes` relevant to this deliverable

Avoid generic decorative graphics with no message hierarchy.

## 6. Reviewer Guidance

Reviewer should evaluate:

- whether the message is clear within a few seconds
- whether hierarchy supports the intended action
- whether visual impact fits the audience and topic
- whether adaptations retain the same campaign idea
- whether color, typography, and visual rules carry consistently across formats
- whether the key message and CTA survive each format adaptation
- whether the outputs are usable as poster/advertising visuals

## 7. Later Professional Deepening

Future work should add stronger references for:

- campaign strategy
- poster typography
- information hierarchy systems
- media adaptation rules
- copy/image relationship
