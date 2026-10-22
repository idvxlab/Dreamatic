---
name: accessible-interface
description: "Design interface accessibility for HTML pages and project showcases, including keyboard access, focus, semantics, contrast and reflow. Use when access barriers need detailed treatment; supports the owning design discipline rather than replacing it."
metadata:
  audience: designer
  domain_type: accessible_interface
  design_categories: []
  module_type: cross_domain
  capabilities: [accessibility, keyboard-navigation, semantic-html, contrast, responsive-layout]
  supported_outputs: [html]
  version: "1.0"
---

# Accessible Interface

Apply to the page experience, including showcases for physical design projects.
Translate access needs into authored behavior and observable checks rather than
adding a slogan.

## Reading and meaning

Keep essential content in semantic HTML. Give informative images descriptions
of their relevant information; decorative images should not repeat nearby copy.
Provide text alongside a canvas visualization when its meaning matters. Label
controls persistently and distinguish actions from navigation. Selected, error
and status states need a cue beyond color. Names exposed to assistive technology
should agree with visible wording.

## Keyboard and focus

Use native elements first. Make keyboard order follow the task and keep focus
visible above sticky regions. For custom dialogs, define initial focus, Escape,
focus containment and return to the trigger; background controls must not remain
accidentally operable. Opening a section must not unexpectedly move focus. For
changing status, announce the useful result without repeatedly reading the page.

## Contrast and adaptation

For WCAG 2.2 AA text contrast, target at least 4.5:1 for ordinary text and 3:1 for
large text (at least 18pt, or 14pt bold); check actual foreground/background pairs.
Necessary control and graphical boundaries generally need 3:1 contrast with
adjacent colors. Preserve text resizing and narrow-width reflow, allowing
two-dimensional layouts only where their meaning requires it. Make touch targets
and spacing usable; provide buttons for interactions otherwise requiring dragging.

Choose checks around real access risks: keyboard completion of a primary action,
dialog dismissal and focus return, readable errors, or zoom without lost content.
Automated interaction checks are partial evidence; do not claim WCAG conformance
or completed assistive-technology testing without corresponding verification.

## Method references

[W3C WCAG 2.2 quick reference](https://www.w3.org/WAI/WCAG22/quickref/) and
[Vercel interface guidelines](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/command.md).
