---
name: ui-web-design
description: "Specify visual interfaces, responsive layouts and component states for websites, dashboards and mobile screens. Use when interface composition and behavior must be explicit."
metadata:
  audience: designer
  domain_type: ui_web_design
---

# UI and Web Design

Use this independent knowledge module to inform the canonical Design Spec.
Select the dimensions relevant to the brief; the Agent contract governs tools,
output formats, image-size ceilings and stage completion.

## Interface structure
Establish content priority and the intended reading and interaction order.
Choose a layout model appropriate to information density, task frequency and
device context. Specify navigation, primary actions, content regions and
supporting information with realistic text lengths and data variation.

Design responsiveness as changes in relationships: reorder, wrap, stack,
collapse or progressively reveal. State what remains visible and how users
access displaced functions; simply shrinking desktop layouts is insufficient.

## Components and states

Explore layout and interaction families through density, information grouping,
navigation, task focus and progressive disclosure, not theme swaps. Stress-test
each with realistic long content, sparse data, small viewports and permission
differences. Borrow a cross-domain organizational principle only if it improves
the task. Compare visual hierarchy, interaction cost and component/state
complexity; document the selected rules and unresolved implementation dependencies.
Define component anatomy, variants, inputs, outputs and interaction states.
Specify focus, selected, disabled, loading, empty, error and success states
when relevant, including their wording and behavior. Distinguish informational
status from interactive affordances.

Assign typography, color and spacing roles; explain density and hierarchy.
Avoid using color alone for meaning. Describe keyboard order, focus visibility,
alternative text and semantic roles where they affect implementation.

## Visual coverage
Choose views that demonstrate the primary task, meaningful navigation,
secondary journeys, relevant alternatives, important component details and
normal/empty/loading/error states across applicable device contexts. Do not
stop at a home screen and one detail screen without covering the developed
design. There is no default output-count ceiling. Include different content
densities and consequential states. Include device layouts
when responsive behavior changes the design. Exact copy, numerical values and
component behavior belong in structured content and specification; generated
screen images illustrate the direction rather than certify pixel accuracy.

Carry layout rules, component states, tokens and responsive decisions into the
canonical Design Spec. Under the current image-based runtime, plan screen
visuals and behavior specifications without claiming a functioning website.

## Quality judgment
Evaluate hierarchy, legibility, clear affordances, content resilience and
coherence across screen sizes. Decorative expression is welcome when it
preserves task clarity.

## Knowledge source
W3C's designer guidance provides practical accessibility considerations:
https://www.w3.org/WAI/tips/designing/
