# Dreamatic frontend design system

This specification formalizes the existing Dreamatic visual language. It is a
constraint for the React rebuild, not a rebrand.

## 1. Product character

Dreamatic should feel like a calm professional design workspace: editorial,
precise, warm, and tool-like. The interface stays visually quiet so references
and generated work carry the color. Avoid generic dashboard gradients, glowing
AI decoration, oversized cards, and dense developer logs.

## 2. Foundation tokens

```css
--color-ink: #20211d;
--color-ink-soft: #565851;
--color-muted: #85877f;
--color-canvas: #e7e6e0;
--color-panel: #f6f5f0;
--color-paper: #fffefb;
--color-sidebar: #20211d;
--color-line: rgb(36 37 32 / 11%);
--color-accent: #d76942;
--color-agent: #c9e46b;
--color-success: #638245;
--color-warning: #9a6b32;
--color-error: #a34c3a;

--radius-xs: 4px;
--radius-sm: 7px;
--radius-md: 10px;
--radius-lg: 14px;
--shadow-float: 0 12px 35px rgb(47 48 42 / 14%);
--shadow-overlay: 0 24px 70px rgb(25 26 22 / 28%);

--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
```

Use Segoe UI Variable first, with the system sans-serif fallback. Display text
may use the display cut. Body copy must remain at least 12 CSS pixels and
interactive labels at least 11 CSS pixels; the old 8–10 pixel labels are only
appropriate for tertiary metadata and become unreadable under browser scaling.

## 3. Layout contract

- The app occupies `100dvh`; the document body never owns workspace scrolling.
- Every nested grid/flex child that may scroll uses `min-width: 0` and
  `min-height: 0`.
- Sidebar, canvas, and agent panel own independent scroll regions.
- The agent header and composer never scroll away with the timeline.
- No component assumes a fixed monitor resolution or browser zoom.

Responsive modes:

| Mode | Available width | Behaviour |
| --- | ---: | --- |
| Wide | `>= 1440px` | Left rail, canvas, and agent panel visible. Resizable-feeling proportions with bounded rail widths. |
| Compact desktop | `1024–1439px` | Narrow left rail; agent panel remains visible but may be collapsed. Nonessential header labels hide. |
| Tablet/narrow | `< 1024px` | Canvas is primary. Left rail and agent panel become modal drawers with scrims and explicit close buttons. |
| Short viewport | any width | Headers stay fixed, content regions scroll, composer remains visible, modals use internal scrolling. |

The breakpoints are behavioural thresholds, not device targets. Components must
also survive intermediate widths through `minmax()`, `clamp()`, and container
queries where useful.

## 4. Workspace hierarchy

1. **Global navigation** — dark left rail, projects and settings.
2. **Project header** — title, persistence state, assets, share, panel controls.
3. **Design surface** — the largest and quietest area.
4. **Agent panel** — stage-aware conversation, references, decisions, and
   recovery controls.

Only one control in a local group receives the dark primary treatment. Lime is
reserved for the Dreamatic agent identity and active automation, while terracotta
marks selection and authored design actions.

## 5. Canvas interaction

- Canvas data uses world coordinates; camera pan and zoom are separate state.
- Pointer drag on empty space pans. Wheel/trackpad zoom anchors under the cursor.
- Dragging an element changes its world position without fighting camera pan.
- Toolbar provides select/hand mode, zoom out/in, percentage reset, and fit.
- Keyboard: `Space` temporarily pans, `0` fits, `1` resets to 100%, `+/-` zoom.
- Minimum zoom is 20%, maximum is 240%.
- Reference, narrative, and final-output groups have quiet headings and distinct
  metadata, not decorative card chrome.
- Canvas changes are saved with a short debounce and restored by Run id.

The top-left view switch has two explicit states: **Canvas** and **Showcase**.
Showcase renders the Run's validated HTML in a sandboxed frame and provides open
and export actions.

## 6. Agent panel

- Timeline groups transport retries under the affected operation rather than
  rendering one row per retry.
- Stage events show stage, status, concise summary, and relevant artifact links.
- Reference discoveries render as a collapsible thumbnail grid with provenance.
- Raw payloads and stack traces live behind disclosure controls.
- The composer is always reachable, supports attachments, and clearly indicates
  running, reconnecting, interrupted, and resumable states.

## 7. Motion and feedback

Use 120–180 ms transitions for hover, selection, drawers, and canvas controls.
Avoid continuous animation except a running spinner. Respect
`prefers-reduced-motion`. A successful stage should update in place; do not use
toast spam for normal workflow progress.

## 8. Accessibility

- All icon-only controls require accessible names and visible focus rings.
- Hit targets are at least 32×32 CSS pixels; primary touch targets target 40×40.
- Text and controls meet WCAG AA contrast.
- Selection is not communicated by color alone.
- Drawers trap focus; Escape closes overlays; keyboard canvas actions do not
  capture keystrokes while typing in form fields.

## 9. Acceptance

- No horizontal page scroll from 768 px through large desktop widths.
- At viewport heights down to 640 px, the composer and primary canvas controls
  remain reachable.
- Browser zoom from 100% through 200% does not hide essential actions.
- The supplied 2549×1191 and 2560×1440 examples look balanced, but no code uses
  those dimensions as special cases.
- Empty, running, failed, interrupted, complete, and no-network states all have
  intentional layouts.
