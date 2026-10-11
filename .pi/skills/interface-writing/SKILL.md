---
name: interface-writing
description: "Write precise labels, actions, guidance and recovery messages for HTML interfaces and showcases. Use when terminology, state copy or localization affects comprehension."
metadata:
  audience: designer
  domain_type: interface_writing
  design_categories: []
  module_type: cross_domain
  supported_outputs: [html]
  version: "1.0"
---

# Interface Writing

Write for the reader's task and knowledge; preserve supplied facts and terminology.

## Keep the vocabulary stable

Name an object consistently through navigation, controls and outcomes. An action
label should predict its consequence: distinguish saving a draft, publishing and
downloading. Do not vary the same operation's name for stylistic variety. Use
specialist terms when the audience needs them, explaining them at first use if
necessary. Remove internal workflow vocabulary from visitor-facing copy.

## Write consequential states

An error identifies the affected operation and a feasible recovery. State a cause
only when known. Differentiate no content yet, no matching results and failed
loading; each implies a different next action. Success confirms what actually
completed. Loading wording should describe the real activity, without fabricated
percentages or delivery times. Match tone to the consequence of the situation.

For forms, put format requirements where they prevent errors. Placeholders can
illustrate input but do not replace labels. Explain irreversible consequences
where relevant; the confirmation action should name the operation. Add guidance
only when it changes a decision, rather than repeating the heading.

## Fit the reading context

For concept showcases, separate concept intentions from implemented features and
tested results. Captions should explain what a view reveals, not merely call it
beautiful or innovative. Make link wording identify its destination or file.
Keep alternative text informative without duplicating the full caption.

Use complete localizable messages, retaining units and variables as meaningful
parts. Check longer translations and mixed-language terms in the layout. Carry
exact final copy into authored sources; a list of copy suggestions is insufficient
when the page itself still contains generic filler.

## Method reference

[Impeccable: clarify](https://github.com/pbakaus/impeccable/blob/d631a8827f99414d2b6daba4ef08b7f8701751d7/.agents/skills/impeccable/reference/clarify.md).
