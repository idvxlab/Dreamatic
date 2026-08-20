---
name: architecture-space
description: "Architecture, interior, exhibition, and spatial-design domain guidance for Dreamatic: site, program, spatial sequence, atmosphere, material, and presentation render deliverables."
license: MIT
metadata:
  audience: researcher, planner, designer, reviewer
  workflow: ai-design-harness
  domain_type: architecture_space_design
---

# Architecture & Space Design Skill

This skill supports `architecture_space_design` runs. It is a first-pass domain
framework for concept/effect images, not CAD, BIM, construction drawings, or
technical detailing.

## 1. Domain Positioning

`architecture_space_design` covers:

- architectural concept design
- interiors and retail spaces
- exhibition, booth, installation, and environmental design
- visitor centers, labs, studios, campus spaces, and cultural spaces

The expected final result is a curated PNG set plus `00-gallery.html`.

## 2. Scope Fields

Read `brief.json::resolvedScope.domain_scope`:

```json
{
  "site_context": {
    "location_or_site_type": "string",
    "context_relationship": "string",
    "environmental_cues": "string"
  },
  "program_spatial": {
    "core_functions": ["string"],
    "spatial_sequence": "string",
    "scale": "string"
  },
  "atmosphere_material": {
    "atmosphere": "string",
    "material_direction": "string",
    "light_strategy": "string"
  }
}
```

Master should ask the user only when missing function, scale, site, or
atmosphere would lead to a materially different concept.

## 3. Research Guidance

Research should keep research lean. Collect references only when they can shape
site response, spatial organization, circulation, material/light, or human scale.
A useful compact set is:

- 1 site/context or analogous environmental image
- 1-2 precedent buildings, interiors, exhibitions, or spatial installations
- 1 plan, zoning, section, or circulation reference
- 1 material/light or human-scale reference
- 1 accessibility/comfort reference only when the users include elders, children, public visitors, or accessibility-sensitive groups

When real site data is unavailable, collect analogous references and label the
run as a concept based on assumptions.
Skip decorative mood references that do not inform a view, diagram, material
decision, or `domain_handoff` note.

## 4. Planner Guidance

Planner should define:

- spatial thesis and intended experience
- program/zoning priorities
- site or context relationship
- atmosphere, material, and light direction
- image-generation plan tied to view categories

Recommended deliverable categories:

- hero spatial render or key perspective
- plan or zoning diagram
- circulation or user journey diagram
- section or sectional perspective
- material and lighting atmosphere board
- accessibility and scale board

Optional additional categories:

- site relation view
- interior key moment render
- elevation or facade study
- detail vignette
- day-night atmosphere pair
- human-scale use scene
- presentation overview board

These are categories. If the brief names several zones, rooms, user flows, or
atmosphere moments, Planner may expand one category into several concrete PNG
entries in `deliverable_manifest.json`.

Planner should reason from the concrete spatial problem before finalizing the
manifest:

- strong site/context dependency -> add site relation view
- exterior identity, threshold, or entrance expression matters -> add elevation/facade study
- vertical organization, mezzanine, atrium, slope, or stacked program -> add section perspective
- several rooms or zones -> split interior/key view into multiple concrete views
- visitor journey or operational flow matters -> add circulation or sequence diagram
- lighting atmosphere is central -> add day/night or alternate light scene
- envelope, craft, facade, or installation detail matters -> add detail vignette
- elders, children, care, public service, accessibility, or comfort-sensitive users -> keep accessibility and scale visible in a dedicated board and in at least one experiential render

Record selected and omitted expansions in `design_plan.json::domain_handoff` so
Designer and Reviewer can understand why the package has that shape.

## 5. Designer Guidance

Designer should produce PNGs that read as architectural or spatial concept
presentation images.

Each image prompt should include:

- space type and function
- view type: hero render, site relation, plan/zoning, circulation, section, interior key moment, facade/elevation, material board, or detail vignette
- spatial organization and human-scale cues
- atmosphere and lighting
- material direction
- accessibility or comfort cues when relevant: handrails, ramps, resting points, glare control, clear circulation, seating scale, doorway width, or surface safety
- context or site relationship when relevant
- the selected consistency anchor, usually the key spatial view or massing/arrival view
- any `domain_handoff.execution_notes` relevant to this deliverable

Avoid purely decorative mood images that do not show usable space.

## 6. Reviewer Guidance

Reviewer should evaluate:

- whether spatial logic and program are understandable
- whether scale and human use feel plausible
- whether plan, section, and circulation images explain the design rather than merely decorate it
- whether material and light support the intended atmosphere
- whether accessibility and scale are visible when the brief names sensitive users or public access
- whether site/context is addressed when the brief requires it
- whether outputs read as spatial design, not only abstract branding

## 7. Later Professional Deepening

Future work should add stronger references for:

- spatial typologies
- circulation and program diagrams
- architectural atmosphere precedents
- material-light relationships
- basic accessibility and public-space heuristics
