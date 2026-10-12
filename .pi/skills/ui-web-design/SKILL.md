---
name: ui-web-design
description: "Specify visual interfaces, responsive layouts and component states for websites, dashboards and mobile screens. Use when interface composition and behavior must be explicit."
metadata:
  audience: designer
  domain_type: ui_web_design
  design_categories: [ux]
  module_type: discipline
  supported_outputs: [html]
---

# UI and Web Design

Specify interface composition, responsive relationships and consequential states.

## Establish structure

Identify content priority, task frequency, density and reading/interaction order.
Design navigation, primary actions and information regions with realistic copy
and data. Compare layout families through grouping, task focus and disclosure,
not theme swaps. Stress-test long content, sparse data, permissions and narrow widths.

Design responsive relationships explicitly: reorder, wrap, stack, collapse or reveal.
State what stays visible and how displaced functions remain accessible; shrinking
an oversized desktop layout is insufficient.

## Resolve components

Define anatomy, variants, inputs, outputs and relevant focus, selected, disabled,
loading, empty, error and success behavior. Include actual wording and distinguish
status from controls. Assign type, color and spacing roles. Meaning needs cues beyond
color; specify keyboard order, focus, labels and semantic roles.

Compare hierarchy, interaction cost, resilience and component complexity. Carry
selected rules and real integration needs into the specification.

## Author meaningful coverage

Choose pages and states from primary tasks, navigation, secondary journeys and
consequential errors across device contexts. A home and detail screen are not
automatically complete; avoid both missing flows and duplicate views.

Deliver complete HTML page designs under `plan/html/<scope-id>/`, with CSS/JS as
needed: realize layout, hierarchy, typography, exact copy, values and behavior.
Builder materializes approved sources without redesign. Cover consequential scripted
flows and responsive behavior with interaction checks; use html-interface for the
execution contract. Image assets support rather than replace inspectable behavior.
A local prototype does not prove backend integration or deployed services.

## Knowledge source

[W3C: accessibility tips for designers](https://www.w3.org/WAI/tips/designing/).
