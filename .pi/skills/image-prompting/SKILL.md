---
name: image-prompting
description: "Craft for both text-to-image (image_generate) and image-edit (image_edit) prompts. How to specify subject, framing, palette, on-image text — and, for edits, how to phrase the prompt so the result respects the reference's geometry / palette / framing."
license: MIT
metadata:
  audience: design-designer
  workflow: ai-design-harness
---

# Image Prompting Skill

The harness now produces a curated **PNG image set** as the headline deliverable. Every required PNG is written by either `image_edit` (when a reference exists in `research/assets/`) or `image_generate` (when no reference is available). This skill covers both.

## 1. Decide: edit or generate

Open `research/assets/manifest.json`. For every plan deliverable, check whether an asset is appropriate:

| Reference status                                                | Tool                | Notes |
| --------------------------------------------------------------- | ------------------- | ----- |
| `allowed_for_edit: true`, kind matches deliverable              | **image_edit**      | Pass the asset path in `referenceImagePaths`. |
| `do_not_replace: true` and deliverable must show that asset     | **image_edit**      | NEVER regenerate; reference the original verbatim. |
| No relevant reference exists (moodboard, abstract texture, etc.) | **image_generate**  | Use the six-part prompt anatomy below. |

When in doubt, prefer `image_edit`. Free-generating when a reference exists is a `reference_grounding` fail.

## 2. Text-to-image prompt anatomy (image_generate)

Six parts, in this order:

```
<subject>, <framing>, <lighting>, <lens / medium>, <palette anchors>, <style / mood + negative clause>
```

Example:

```
A small group of graduate students reviewing physical design boards in a glass-walled studio,
medium-wide composition with subjects at thirds,
late-afternoon side light pouring through floor-to-ceiling windows, soft contact shadows,
shot on 35mm full-frame at f/2.0, slight grain,
warm ivory walls (#f7f5f0) and a single muted red accent (#c8302a) on a folder,
calm, deliberate, editorial photograph; no logos, no fake text, no AI-brain motifs.
```

## 3. Image-edit prompt anatomy (image_edit)

Edit prompts are NOT free-form regenerations. They must explicitly tell the model **what to preserve from each reference** and **what to add on top**. Use this structure:

```
EDIT INSTRUCTION:
- Preserve from reference 1 (<short label>): <geometry / palette / typography to keep verbatim>
- Preserve from reference 2 (<short label>): <…>
- ADD: <new background / layout / on-image text>
- COMPOSITION: <how the references should be placed in the final frame; alignment, scale, hierarchy>
- PALETTE: <hex anchors; usually drawn from research/evidence.json + the reference itself>
- ON-IMAGE TEXT (verbatim, do not paraphrase):
    headline (zh): "..."
    headline (en): "..."
    kicker:        "..."
    lockup:        "..."
- DO NOT: redraw or alter <protected reference> in any way; produce fake Latin; add glowing nodes.
```

Worked example — applying the official 创智学院 logo onto a poster:

```
EDIT INSTRUCTION:
- Preserve from reference 1 (official-logo): keep the wordmark and mark exactly as-is, do not redraw,
  do not change colors, place at top-left, 96px from the top edge, baseline-aligned to the column grid.
- ADD: a calm ivory background (#f7f5f0) with a thin 1px hairline rule at 1080px from the top,
  a generous 240px lower margin reserved for typographic copy.
- COMPOSITION: portrait 1024×1792, lockup top-left, headline bottom-left, kicker beneath headline,
  meta line at bottom-right; subject anchored at lower-right thirds.
- PALETTE: ivory #f7f5f0 (paper), ink #0d1117 (text), muted red #c8302a (single accent).
- ON-IMAGE TEXT (verbatim):
    headline (zh): "在创新之前，先理解人"
    headline (en): "Innovation begins with people"
    kicker:        "上海创智学院 · 2026 招生季"
    lockup:        official-logo from reference 1
- DO NOT: redraw or recolor the official logo; produce fake Latin or "Sample Headline";
  add glowing nodes / hex / circuit motifs.
```

## 4. What to specify vs. what to leave open

Specify when it carries brand meaning:

- Palette anchors with real hex codes (cite `evidence.json` if possible)
- Motif geometry (if the brand owns a shape language)
- Tone (calm vs. energetic; observed vs. participatory)
- Exact on-image text in the declared language(s)

Leave open when there is no brand meaning:

- Micro-expressions, exact gestures
- Background props that don't carry the message
- Specific furniture that is not signature

Over-specifying produces stiff outputs. Under-specifying produces generic moodboards.

## 5. Negative clauses that earn their keep

For brand work, always include something like:

```
no fake logos, no on-screen UI text, no readable foreign signage,
no random gradients, no lens flares, no holographic foil,
no AI brain / neural net / glowing node motifs,
no exaggerated bokeh, no over-sharpening, no obvious model artefacts on faces or hands.
```

For posters specifically, add:

```
plate negative space top-left for headline placement, subject anchored bottom-right at the rule of thirds.
```

## 6. Size strategy

The live `gpt-image-2` backend enforces a **minimum 1024 × 1024 pixel budget** — sub-1024 sizes are rejected at the tool layer with `image_generate: invalid size` / `image_edit: invalid size`. Allowed sizes are: `1024x1024`, `1024x1792`, `1792x1024`, `1024x1536`, `1536x1024`, `2048x2048`. Pick the aspect that fits the deliverable's medium:

| Purpose                         | Size         | Notes                                   |
| ------------------------------- | ------------ | --------------------------------------- |
| Poster (vertical)               | 1024 × 1792  | Tall composition with headline space    |
| Social square                   | 1024 × 1024  | Default                                 |
| Wide application (banner)       | 1792 × 1024  | Horizontal                              |
| Moodboard tile                  | 1024 × 1024  | Multiple tiles for a grid               |
| Signage / merch mockup          | 1024 × 1024 / 1792 × 1024 | Pick based on aspect of the mockup |
| Hero / pitch image              | 2048 × 2048  | Reserve for one or two hero PNGs        |

## 7. Sidecar discipline

Both tools write a sidecar `.png.json` automatically. The sidecar records:

- The full prompt (image_generate) OR the edit instruction (image_edit)
- The list of `referenceImagePaths` with sha256 (image_edit only)
- The output sha256 + bytes
- The model + backend + timestamp

Critic uses these sidecars to compute the `reference_grounding` score. Make every prompt grounded enough that the sidecar tells a clear story.

## 8. Hard rules

1. Never request real human faces of identifiable people. Use anonymized framings (back of head, hands, silhouette).
2. Never ask `image_generate` for "the official logo of <org>". This is an instant `non_duplication` fail.
3. Always pass the official-logo asset through `image_edit` instead of regenerating it.
4. On-image text MUST be written verbatim in the prompt, in the correct language(s) declared by the plan.
5. Keep prompts focused; aim for 400–900 characters per call. Longer prompts dilute, not strengthen.
6. The output filename id MUST match the deliverable id in `plan/deliverable_manifest.json` so the gallery can embed it by name.
