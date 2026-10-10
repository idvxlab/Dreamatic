# DreamaticArt rebuild plan

Historical rebuild plan. Its directory layout describes the original split-file
workflow. New Runs use [Unified Design Context](DESIGN-CONTEXT.md); legacy Runs
retain their original contract. Current boundaries are in
[Architecture](ARCHITECTURE.md), rather than this delivery checklist.

## Product outcome

DreamaticArt turns one design brief into a durable, inspectable design package.
The same Run can be started from the CLI or Web UI, resumed after interruption,
and opened in the React workspace. The package contains research references,
an executable Design Context, a coherent image set, review challenges, revision history, and
a standalone responsive showcase page.

## Architectural boundaries

- Pi owns model/provider access, message streaming, tool calls, context
  compaction, base session persistence, Skills discovery, and Extensions.
- `packages/design-agent` owns design-stage tools and domain contracts.
- `apps/server` owns durable Runs, stage orchestration, asset indexing,
  publication jobs, and the Web API.
- `apps/cli` and `apps/web` are two clients of the same Run contract.
- `.pi/skills` remains optional design knowledge; Agent descriptions and
  runtime contracts define required behavior and stage interfaces.

The server must not accumulate another monolith. Run storage, workflow
orchestration, asset indexing, canvas persistence, and HTTP routing are separate
modules with explicit data contracts.

## Durable Run

Each Run has one authoritative directory:

```text
workspace/runs/<run-id>/
  brief.json
  design-context.json
  run-state.json
  bus.jsonl
  sessions/<stage>/
  research/
  plan/
  artifacts/
    artifact-manifest.json
    generated-images/
    edits/
    00-gallery.html
  review/
  canvas/canvas-state.json
  final/
```

`run-state.json` is a materialized view of committed bus events. Stage
completion requires both its declared files and a valid completion event. A
model's prose response is never sufficient evidence of completion.

## Workflow

The default workflow is a controlled reasoning graph:

```text
researcher -> designer -> reviewer
                 ^           |
                 +-- issues -+
             approved context -> builder -> publish -> complete
```

Orchestrator selects the workflow and supervises it. Researcher, Designer,
Reviewer, and Builder run in isolated persistent Pi sessions. Reviewer
challenges the Design Context without authoring a replacement design. One
bounded Designer revision is allowed by default. Every responsibility is
idempotent and can resume from its durable checkpoint.

## Design Bus

The bus is an append-only coordination log. Events have stable ids, timestamps,
run/stage/agent identity, summaries, artifact references, attempt/round, and an
optional structured payload. It carries decisions and references, not full
image payloads or duplicated documents.

## Asset and visual-context policy

References and generated images are stored once and passed between stages as
paths plus compact metadata. Researcher screens acquisition metadata; Designer
may inspect bounded reference previews while originals retain their resolution. Builder
uses one-pass generation/editing and receives persisted paths rather than image
payloads, so successful production does not trigger a second visual audit.
Base64 image blocks are not copied into Design Bus events. Resumable stage
histories omit visual payloads; complete source assets remain recoverable from
their persisted paths.

Retry budgets are scoped by Run, operation, and artifact id. A recoverable
image failure records `operation_retry` or `operation_interrupted` without
incorrectly terminating the entire Run; successful later stage commits return
the state machine to `active`.

## Web workspace

The UI uses a responsive application shell rather than fixed viewport rules.
Each column owns its scrolling; the agent composer remains reachable at every
supported height. At narrower desktop widths the sidebars collapse or overlay.

The canvas stores world coordinates independently of screen pixels and supports
pan, wheel/button zoom, fit, reset, drag, and persisted layouts. It presents
reference, narrative, and final-artifact groups. A top-left mode switch changes
between the editable canvas and the Run's standalone showcase page.

## Delivery order

1. Extract typed Run storage, inventory, and bus contracts.
2. Persist child stage sessions and add resumable orchestration.
3. Make CLI and Web create/open the same Run representation.
4. Add canvas/assets/publication APIs.
5. Replace the fixed React layout and implement the interactive canvas.
6. Add showcase preview, failure-injection tests, and browser acceptance tests.

## Definition of done

- A real brief completes from CLI without manual file repair.
- The resulting Run appears in Web with its complete timeline and assets.
- Restarting during a retryable failure resumes from the last committed stage.
- References appear as collapsible cards while research is running.
- The canvas is usable across continuous desktop/tablet widths and restores its
  layout after reload.
- The final artifact set and responsive `00-gallery.html` contain no missing or
  invented asset paths.

## Verified vertical slice

`urban-rider-clip-safety-light` completed the full CLI path with 11 research
references, seven coordinated product-design boards, one targeted revision,
an approved Design Context, and an exported `final/00-index.html`. The same
Run is indexed by the Web API with research, plan, review notes, canvas state,
and a final Showcase URL.
