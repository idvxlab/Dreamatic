---
name: interaction-motion
description: "Specify interface motion through state continuity, interruption handling and reduced-motion alternatives. Use when movement communicates an interface state or viewing action; express transition intent or implemented behavior according to available host capabilities."
metadata:
  dreamatic-roles: "designer"
  dreamatic-domain: "interaction_motion"
  dreamatic-categories: ""
  dreamatic-module: "cross_domain"
  dreamatic-capabilities: "microinteractions browser-motion transition-design reduced-motion"
  dreamatic-outputs: "html"
  version: "2.1"
---

# Interaction Motion

Define motion through what it communicates: an action was received, a state
changed, two views are related, or attention belongs at a meaningful moment.
Use the selected visual direction to shape movement; routine controls should
remain quick to use.

## Describe a transition completely

Identify its trigger, initial/final state, moving property, duration and easing.
State what happens on repeated input, reversal or interruption. Visual animation
must follow the actual state instead of delaying the operation until a flourish
finishes. Keep essential content available if script or animation does not run.

Choose timing by task and perceived distance. A toggle acknowledgement should
not feel like waiting for a scene transition. Related objects can share a motion
relationship; unrelated sections need not all arrive with the same scroll reveal.
Avoid changing interaction geometry while a person is aiming at a control.

## Author within the browser budget

When the host provides executable interface authoring, prefer CSS for simple state
changes and native browser animation APIs for interruptible sequences. In a concept
image workflow, specify the states and transition intent without claiming implementation. Animate explicit properties, favoring transforms and
opacity where they express the intended effect. Bound complex drawing and avoid
unnecessary layout work. Stop continuous work when hidden or offscreen; size
effects for mobile as well as desktop. Do not introduce an external animation
dependency for an effect expressible with local code.

## Preserve control

Provide a reduced-motion path that keeps the result understandable without large
spatial movement. Keep keyboard and touch flows equivalent to pointer behavior;
hover must not be the only way to reveal essential actions. A continuous effect
needs appropriate pause/control behavior. No decorative animation should block
reading, navigation or the final state.

Carry consequential behavior into the existing interaction checks, including
rapid repeated input where it could cause inconsistent state. Specify desired
timing without claiming measured smoothness until it has been observed.

## Method reference

[Impeccable: animate](https://github.com/pbakaus/impeccable/blob/d631a8827f99414d2b6daba4ef08b7f8701751d7/.agents/skills/impeccable/reference/animate.md).
