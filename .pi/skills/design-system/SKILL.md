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

Do not freeze the first attractive motif into a consistency anchor before the
concept is selected. Keep materially different candidate systems separate and
test each against the same demanding applications. Compare expressive range,
recognition, content resilience and production complexity; a system must support
the subject rather than force every artifact into identical minimal geometry.
On feedback, distinguish confirmed invariants from revisable proposals and
trace a changed token or rule to affected components, views and prompts. Preserve
user-approved relationships while revisiting the underlying thesis when rejected.

Define only the dimensions that affect the requested artifacts:

- palette roles, contrast behavior, and material or lighting implications;
- typography roles, hierarchy, density, and alignment behavior;
- grid, spacing rhythm, framing, and compositional structure;
- form language, motif, geometry, material, or surface behavior;
- imagery, illustration, rendering, photography, or diagram treatment;
- voice and textual tone when language is part of the design;
- one or more consistency anchors that must recur across outputs;
- protected assets and explicit `do_not` constraints.

For each prohibition, state whether it comes from user intent, an evidenced
asset condition, a runtime limit or Designer's own consistency decision. Only
the latter is a revisable creative rule. Do not import an upstream assumption
as a universal ban or convert subject recognition into prohibited copying.
Allow detailed, expressive and contextual applications while preserving the
identity features that actually unify the family.
Derive expressive density and medium from communication needs and the selected
direction, not from an assumption that a coherent system must be restrained.
Distinguish accurate subject depiction from copying an existing design.

Adapt the system to the domain. A spatial system may prioritize material, light, and thresholds; a product system may prioritize geometry and CMF; a graphic system may prioritize grid, type, and image treatment.

Separate conceptual invariants from their execution mechanism. For each critical
invariant, specify whether written instructions suffice or a source asset and
dependent editing are needed. Name source/output ids and preservation rules in
the Design Spec; do not call a token or label an actual image input. Preserve
identity-defining relationships while allowing different compositions, contexts
and expressive density. Consistency is not uniform minimalism or identical layouts.

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
