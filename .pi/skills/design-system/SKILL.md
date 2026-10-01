---
name: design-system
description: "Define a compact cross-artifact design system with a clear thesis, visual tokens, consistency anchors, protected assets, and domain-specific rules."
license: MIT
metadata:
  audience: designer
  domain_type: cross_domain_design_system
---

# Design System

Use this optional module when several outputs must feel like one designed family. The system should be concise enough to guide execution and specific enough to evaluate consistency.

## System Thesis

Start with one sentence describing the intended character and the principle that unifies the work. Every token or rule should support that thesis.

## Core Decisions

Define only the dimensions that affect the requested artifacts:

- palette roles, contrast behavior, and material or lighting implications;
- typography roles, hierarchy, density, and alignment behavior;
- grid, spacing rhythm, framing, and compositional structure;
- form language, motif, geometry, material, or surface behavior;
- imagery, illustration, rendering, photography, or diagram treatment;
- voice and textual tone when language is part of the design;
- one or more consistency anchors that must recur across outputs;
- protected assets and explicit `do_not` constraints.

Adapt the system to the domain. A spatial system may prioritize material, light, and thresholds; a product system may prioritize geometry and CMF; a graphic system may prioritize grid, type, and image treatment.

## Design Spec Contract

When expressing the system as structured data, keep the contract compact and explicit. Include:

- `runId`;
- `system_thesis`;
- palette and typography as objects with named roles;
- `consistency_rules` and `asset_rules`;
- at least one `consistency_anchor`;
- `prohibited` treatments or transformations.

Add domain-specific fields only when they improve execution. Avoid copying research notes, workflow state, or review history into the design system.

## Quality Lens

Check whether the system is traceable to the brief, internally coherent, discriminating enough to guide choices, flexible across outputs, and free of rules that exist only for decoration.
