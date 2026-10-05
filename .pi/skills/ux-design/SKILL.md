---
name: ux-design
description: "Design user experiences through task analysis, information architecture, journeys, interaction behavior and usability hypotheses. Use for workflows across digital or physical touchpoints."
metadata:
  audience: designer
  domain_type: ux_design
  design_categories: [ux]
  module_type: discipline
  supported_outputs: [html]
---

# User Experience Design

Use this independent knowledge module to inform the canonical Design Spec.
Select the dimensions relevant to the brief; the Agent contract governs tools,
output formats, image-size ceilings and stage completion.

## Task and mental model
Start from actors, goals, context, frequency, consequences of error and the
information available to users. Distinguish observed behavior from inferred
needs. Identify the user's mental model and avoid exposing internal system
structure when it does not help the task.

Map an end-to-end journey with decisions, dependencies, interruptions and
handoffs. Use scenarios grounded in research; do not invent user interview
quotes, validated personas or usability-test results.

## Information and interaction

Explore different mental models and task sequences before drawing screens:
guided versus direct manipulation, object versus activity organization, or
different physical/digital handoffs where appropriate. Compare candidates using
the same realistic task, first-use comprehension, effort, interruptions and
error recovery. Challenge an existing convention through a specific user benefit,
not novelty for its own sake. Develop the selected state-transition model and
identify what a task-based prototype would test; a walkthrough is a reasoned
hypothesis, not evidence of observed usability.
Define information grouping, navigation, labels and progressive disclosure.
Prefer recognition where recall creates unnecessary effort. Explain object
states and transitions: action, prerequisites, feedback, success and recovery.
Account for undo, cancellation, partial progress and destructive actions when
their consequences warrant it.

Consider keyboard, touch, pointer, assistive technology, language, cognition
and situational constraints. Match error prevention and confirmation to actual
risk rather than adding confirmation everywhere.

## Design evidence
Specify key journeys, interaction sequences, wireframe logic and edge states
according to coverage needs. Link each view to a task or decision. An attractive
screen does not demonstrate that a journey works.

For UI/page tasks, develop these decisions into actual HTML/CSS/JS sources
under plan/html/<scope-id>/, not only screen-image prompts. Choose UI/Web and
HTML expression support as the task warrants. Declare observable primary-flow
checks; Builder generates the approved page design. Preserve the conceptual
status of hypotheses and future research.

Write behavior and content rules into the existing Design Spec. Include a
proposed evaluation approach: realistic tasks, participant needs, observable
success, errors or friction and the assumptions being tested. Proposed tests
are future validation, not completed evidence.

## Quality judgment
Assess comprehension, discoverability, task continuity, feedback and recovery.
Allow novel interaction when its learning and use remain understandable.
Do not equate visual familiarity with usability.

## Knowledge source
W3C explains how accessibility, usability and inclusion complement each other:
https://www.w3.org/WAI/fundamentals/accessibility-usability-inclusion/
