# Dreamatic

**A professional AI design harness for turning creative briefs into
traceable design processes and organized visual deliveries.**

![Dreamatic hero illustration](docs/assets/dreamatic-hero.png)

Dreamatic is designed for work that needs more than a single generated image.
It coordinates research, design reasoning, adversarial review, implementation,
and delivery as one inspectable workflow. Every project keeps its
brief, references, design rationale, intermediate decisions, generated assets,
review evidence, and final presentation together.

## What Dreamatic does

```text
creative brief
  → scope and clarification
  → reference research
  → shared Design Context
  → Designer / Reviewer challenge loop
  → Builder implementation
  → validated artifact set
  → interactive Canvas + standalone Showcase
```

Dreamatic turns this process into a persistent **Run** rather than a disposable
chat. Orchestrator controls Researcher, Designer, Reviewer, and Builder
sessions. Agents reason, Design Context remembers, Orchestrator controls the
flow, and Builder executes.

## Key features

| Feature | What it provides |
| --- | --- |
| Brief-to-delivery workflow | One continuous process from requirements and research to reviewed visual output and export |
| Five-role agent architecture | Orchestrator coordinates Researcher, Designer, Reviewer, and Builder without overlapping ownership |
| Design-domain knowledge | Designer selects and loads relevant modules before concept development and reassesses them when scope changes; Agent contracts remain self-contained |
| Evidence-grounded research | Web search, source reading, reference-image collection, validation, deduplication, and a persistent research library |
| Visual production toolchain | Image generation, multi-reference editing, visual inspection, side-by-side comparison, artifact selection, and linting |
| Artifact-set delivery | Produces an organized family of visuals, plans, research, review records, manifests, and a self-contained final package—not just one image |
| Bounded reasoning loop | Researcher informs Designer; Reviewer challenges the proposal; Designer revises only concrete issues before Builder starts |
| Durable and resumable projects | Run state, session histories, workflow events, files, and canvas layout survive interruption and can be reopened |
| Shared Web and CLI workflow | Browser and command-line tasks use the same agents, contracts, tools, workspace, and project files |
| Live, inspectable execution | The interface streams primary-agent actions, dynamically created child-agent sessions, references, tool activity, and outputs as they happen |
| Canvas and Showcase | Arrange references, design notes, and visual outcomes on a persistent pan-and-zoom canvas, then switch to the generated presentation page |
| Resilient local runtime | Operation-level retries, durable checkpoints, recoverable project deletion, provider diagnostics, and reconnection-aware Web startup |

## Design outputs

A completed Run can contain:

- a normalized brief and acceptance criteria;
- verified research notes, sources, and a reusable reference-image library;
- a design system, rationale, production plan, and deliverable manifest;
- multiple generated and edited visual assets with inspection records;
- design-review issues, decisions, selection, and artifact-lint evidence;
- a persistent Canvas layout for working with the project;
- a self-contained Showcase and final delivery package.

The built-in workflow currently supports **brand and cultural identity**,
**product and industrial design**, **architecture and spatial design**, and
**poster and advertising design**. Its deliverable plan adapts to the brief:
for example, a product may add an exploded view when its structure is complex,
while a campaign may add format adaptations when several media placements are
required.

## Two ways to work

- **Web workspace:** create and manage projects, answer clarification cards,
  watch the nested workflow stream, inspect references and outputs, arrange the
  Canvas, and open the final Showcase.
- **CLI:** run the same workflow from a terminal, attach reference images,
  stream machine-readable events, use interactive mode, or resume an
  interrupted Run. CLI-created projects automatically appear in the Web
  workspace when both use the same workspace directory.

The current release focuses on image-based design deliverables. Video and 3D
branches documented by earlier experiments are not active in this runtime.

## Architecture boundary

Dreamatic uses Pi as a versioned upstream runtime and extends it through its
SDK, Extensions, Skills, and session APIs. Pi supplies the general agent loop;
Dreamatic owns the design-specific behavior and product experience.

| Runtime foundation | Dreamatic product layer |
| --- | --- |
| Model/provider abstraction | Design personas and domain Skills |
| Agent sessions and streaming | Multi-stage design orchestration |
| Tool registration and lifecycle | Image generation, editing, inspection, and comparison |
| Skill discovery/loading | Design Bus and artifact contracts |
| Context compaction and persistence | Image-context control and resumable Run files |
| General filesystem/shell tools | React project workspace and design CLI |

The same persistent Run is used by both Web and CLI:

```text
brief → Orchestrator → Researcher → Designer ↔ Reviewer
      → approved Design Context → Builder → Canvas + Showcase
```

## Requirements

- Node.js 22 LTS recommended; Node.js 20.19 or newer is required by the current
  Vite toolchain.
- npm 10 or newer.
- A vision-capable OpenAI-compatible text model.
- An OpenAI-compatible image generation endpoint. Image editing is strongly
  recommended for consistency and repair passes.

Python, a virtual environment, `uvicorn`, and the old `config.yaml` are no
longer used by this branch.

## Quick start

### macOS / Linux

```bash
git clone --branch dev https://github.com/idvxlab/Dreamatic.git
cd Dreamatic
cp .env.example .env
nano .env                         # fill in text and image provider settings
npm install
npm run dev
```

Open the Web URL printed by Vite, normally `http://localhost:5173`. The local
Dreamatic API listens on `http://localhost:4310`.

### Windows PowerShell

```powershell
git clone --branch dev https://github.com/idvxlab/Dreamatic.git
Set-Location Dreamatic
Copy-Item .env.example .env
notepad .env
npm install
npm run dev
```

If port `5173` is occupied, Vite automatically prints and uses the next free
port. Do not close the terminal while a Web-started task is running.

After changing runtime code or an Agent's `allowed_tools`, stop and restart the
development server with `npm run dev`. `npm run dev` and `npm start` rebuild the
runtime before launch; rebuilding alone does not update an already running
Node process. Persona/tool contracts are checked before session creation and
workflow dispatch. Configuration mismatches stop the turn instead of repeatedly
spawning an incompatible agent. Resume the pending stage in the existing Run
after restarting; completed research and design do not need to be repeated.

## Configuration

Dreamatic loads `<repo>/.env` for both Web and CLI. The Web Settings panel can
update the same provider fields, but keeping a local `.env` is the clearest
way to reproduce an environment. Never commit real API keys.

### Text / vision model

```env
DREAMATIC_API_KEY=your-text-model-key
DREAMATIC_BASE_URL=https://your-openai-compatible-host/v1
DREAMATIC_MODEL=your-vision-capable-model
DREAMATIC_PROVIDER_TYPE=openai-compatible
DREAMATIC_PROVIDER_NAME=Local profile
```

Each Agent uses `DREAMATIC_MODEL` and the active thinking level by default.
Optional `DREAMATIC_MODEL_ORCHESTRATOR`, `DREAMATIC_MODEL_RESEARCHER`,
`DREAMATIC_MODEL_DESIGNER`, `DREAMATIC_MODEL_REVIEWER`, and
`DREAMATIC_MODEL_BUILDER` values select a different model from the same
provider for that role. Matching `DREAMATIC_THINKING_LEVEL_<ROLE>` values may
be `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. A typical
cost-conscious setup uses a stronger model for Designer and faster models for
Orchestrator and Builder.

Set `DREAMATIC_PROVIDER_TYPE=openai-responses` only when the endpoint implements
the OpenAI Responses protocol. Otherwise the default OpenAI-compatible chat
completions protocol is used.

### Web research

Dreamatic uses DuckDuckGo without an API key by default. To use Serper instead,
configure:

```env
DREAMATIC_SEARCH_PROVIDER=serper
DREAMATIC_SEARCH_API_KEY=your-serper-key
```

Researcher keeps the same `websearch` tool contract with either
provider. `SERPER_API_KEY` is also accepted for compatibility with older
Dreamatic configurations. If Serper is not configured, Dreamatic automatically
uses DuckDuckGo.

### Image generation and editing

```env
DREAMATIC_IMAGE_API_KEY=your-image-key
DREAMATIC_IMAGE_BASE_URL=https://your-image-host/v1
DREAMATIC_IMAGE_MODEL=your-image-model
DREAMATIC_IMAGE_GENERATION_ENDPOINT=https://your-image-host/v1/images/generations
DREAMATIC_IMAGE_EDIT_ENDPOINT=https://your-image-host/v1/images/edits
DREAMATIC_IMAGE_RESPONSE_FORMAT=b64_json
DREAMATIC_IMAGE_DEFAULT_SIZE=1536x1024
```

`DREAMATIC_IMAGE_API_KEY` may be omitted when the image endpoint accepts the
same key as `DREAMATIC_API_KEY`. Explicit generation/edit endpoints are optional
when the provider follows the standard `/images/generations` and `/images/edits`
paths.

To diagnose image editing without running the full agent workflow:

```bash
# Configuration, DNS, and endpoint reachability only; does not create an image
npm run diagnose:image-edit

# One real image-edit request using the exact .env configuration; may be billable
npm run diagnose:image-edit -- --image "/absolute/path/to/reference.png"
```

The diagnostic hides the API key and reports the resolved endpoint, model,
input size, timeout, HTTP status, elapsed time, request ID, retry guidance, and
the provider error body. It works the same way on macOS, Linux, and Windows.

### Workspace and recovery

Model watchdogs distinguish first-output waiting from a stalled active stream.
Before the first content delta, the role's model-turn deadline applies; only
after streaming begins does the idle-stream timeout apply. This avoids aborting
buffered design responses at 120 seconds while retaining bounded deadlines.
Designer recovery reads existing Design Spec checkpoints and explicit
`missingFiles` through Design Context; absent unfinished outputs are not errors.

Design quality is specified before production: Designer retains concise distinct
concepts, criterion-based comparisons, decision links, implementation assumptions
and user-feedback preservation/change intent in the existing Design Plan.
Domain Skills provide specialized exploration and development methods, while
the five Agent contracts remain usable without them. Research distinguishes
source freshness, corroborated findings and opportunity hypotheses; Reviewer
challenges concept quality as well as executable contracts. Evidence review
respects information type: external factual assertions and
operational claims need appropriate verification; original design hypotheses,
metaphors and clearly speculative concepts need coherent design reasoning, not
proof of an existing precedent. Uncertainty is assessed by consequence and
project stage, not automatically converted into a creativity-blocking defect.
Exploration breadth
does not impose an image quota. Unless the user explicitly sets a count or asks
for fewer images, developed alternatives, scenarios, details, states and
applications should receive enough visual coverage to communicate the design
conclusions. A task-specific visual coverage matrix maps those conclusions to
deliverables; a few heroes or one crowded overview are not the default complete
result. Discarded duplicates need not be rendered. Optimize size and concurrency
rather than silently narrowing the approved image set.
Builder remains a one-pass executor without an unrequested visual-audit loop.
Prompt guidance cannot validate physical engineering, guarantee current sources,
or visually certify generated outputs. Explicit user feedback can reopen a
completed project with `run_revision`, preserving prior evidence and confirmed
decisions in an archived snapshot and carrying the feedback delta forward.
Agents never overwrite runtime-owned `design-context.json` or `run-state.json`;
completion events update these indexes.

Specialist invocations receive their authoritative Run id and directory in both
the system context and initial/recovery task. Run ownership errors identify the
correct assignment. Context, bus and visual reads reject mismatched Runs;
filesystem hooks also prevent browsing sibling Runs or reading through symlinks
into them, without blocking shared Skills. Specialists never infer their Run
from an artistic title or a similar older project.

Structured attempts return actionable
managed-file guidance, while fallback `write`/`edit` attempts are blocked.
`write_json` reports mismatched image-plan/deliverable ids before publication
without guessing or changing design content. Failed research pages are not
fetched again for image discovery in the same batch.

Reference acquisition is coverage-driven, not a fixed one-or-two-image quota.
`research_fetch_batch` accepts `referenceImageCount` (positive integer); when
omitted, it retains discovered likely and article-context candidates instead
of defaulting to one image. Explicit counts still select the highest-ranked set
alongside `saveLeadImageAs`, retaining several page images in the same call.
Neither compact nor full Runs impose a per-page or per-Run reference-count
ceiling, including Runs whose older Briefs still contain referenceAssets budgets.
`research_asset_discover` also returns all eligible candidates when `limit` is
omitted; explicit limits remain available for deliberate subsets. Keep initial
search capacity for image-specific follow-up when important visual coverage is missing.
Initial budgets remain compact: 3 queries/4 fetches; full: 8 queries/10 fetches.
A specific `refinementReason` enables one bounded reserve per resource up to
twice its initial budget. Attempted queries/URLs are tracked to prevent unchanged
requests, including failed attempts, from consuming that reserve. Discovery screens obvious
QR codes, print/share controls, page icons and small decorations before applying
the candidate limit. Optional `referenceFocusTerms` prioritizes image metadata
matches without rejecting article-context images solely for different captions
or terminology. Such candidates carry `relevance_status: "uncertain"`; matching
candidates are `likely`, not visually verified. Unmatched images without article
support remain excluded. Navigation, footer, author
portraits and placeholders are screened separately from article figures.
`includeIdentityAssets` explicitly retains existing marks for a task-specific
visual study, preservation or adaptation need. Ordinary brand research records
existing-identity evidence as source URLs instead of downloading site logos for
duplication checks; identity evidence does not fill subject-image coverage.
These heuristics do not verify image content.
Filtering uses decoded filenames (including camel-case and numbered names),
image captions, alt/title, per-image descriptions and accessible labels.
Explicit logo/icon and page-utility evidence overrides a subject keyword match
before downloads or reference-count selection. Logos require explicit
`includeIdentityAssets`; `assetKind` alone no longer enables them. Icon/pictogram
research can explicitly set `includeIconAssets`; QR codes, favicons and sharing
controls remain excluded. Unknown candidates remain unreviewed, not proven
relevant. Exclusion reasons are returned for audit and replacement selection.
Existing-identity preservation or authorized redesign can also request those
assets; inclusion itself does not establish reuse permissions. Research reports
source-backed usage conditions and unknowns, not creative prohibitions.
The runtime retains actual input in `brief.json::originalRequest` with
`originalRequestSource`. The Server captures it before clarification; CLI/Pi
initialization preserves the initial prompt separately from resolved `brief` and
creative `title`. Specialists receive this provenance independently of their
assigned task. Titles and Agent summaries must never be reported as original
wording or substituted for research seed terms. Legacy Runs without recoverable
source text expose a provenance gap, not an invented quote.

Research uses terminology-first discovery across domains, preserving the user's
subject and resolving useful scientific, cultural or other specialist terms from
relevant sources before convergence. Source selection combines primary or
institutional evidence, trusted general/specialist reporting, and practice/user
context. Relevant reporting can be a first-choice source of background, current
developments and credited reference images, not just a lead to academic papers.
Consequential technical claims still require appropriately scoped original
evidence or an explicit reported/unverified label. Full research seeks three
applicable source classes and compact research two; unavailable/inapplicable
classes are explained rather than enforced as tool gates or padded with noise.
Research records source categories and coverage in existing evidence files;
syndicated copies of one story do not count as independent origins.
Visual-concept delivery does not remove this research step. HTML discovery
ranks figure captions with task terms, retains figure ids,
and prefers linked full-size images or responsive `srcset`/`picture` candidates
to thumbnails. Captions and figure labels are preserved in saved descriptions;
they remain metadata, not visual verification. Access-verification pages,
including Anubis challenges, are rejected instead of cached or mined for images.
PDF text/figure extraction is not supported: seek accessible HTML or author
pages and report any remaining evidence gap rather than treating an abstract
or generic photo as full-paper/structure coverage.
`research_fetch` and batch sources accept `researchTerms` to select relevant
passages anywhere in readable HTML article content, while retaining the full
readable page in the text cache. Responses expose `matchedTerms`,
`extractionMethod` and `contentScope`; lexical matches are retrieval clues,
not proof of substantive relevance. Batch image discovery reuses the fetched
HTML rather than requesting the same source again. Researcher can also select
references using `research_asset_discover` and `research_asset_fetch_batch`;
discovery with `runId` reuses available session HTML. Downloads run with a
concurrency of three, while manifest writes and hash duplicate checks are
serialized per Run. Saved descriptions contain
image-specific captions and labels; page-level context is stored separately as
`source_context`.
Batch results expose `researchGaps` for unavailable sources, missing terms and
unusable images. Researcher uses these clues to inspect cached passages or
search changed terminology, languages or primary sources, preserving useful
results. It reserves search capacity for this refinement rather than exhausting
all queries before reading any evidence. Iteration stops when coverage is
adequate or remaining search/source budgets are exhausted, with unresolved
gaps reported explicitly; it does not repeat unchanged failed requests.
Saved assets carry `visual_review_status: "unreviewed"`. Designer first screens
the retained library using labelled `view_image(paths)` batches; clearly
identified utilities may be rejected from metadata. Useful or ambiguous images
get deeper analysis, without repeated audits. Design Context exposes canonical
view paths, including legacy `local_path` aliases, and reports missing asset
dispositions or metadata-only visual adoption. These checks assess declared
coverage, not prove actual reasoning. Designer records adoption, transformation, rejection or
deferral in `design_plan.json::reference_use_decisions`, linking adopted features
to decisions and prompts. Uninspected assets cannot be claimed as visually
verified. Text-only `image_generate` receives prompts, not reference pixels;
reference paths are provenance unless an approved `image_edit` uploads them.
Studying existing marks or design examples is allowed and differs from directly
reproducing them. Inspiration, sending pixels and final asset reuse require
separate decisions; do not derive blanket reference bans from uncertain rights.
Designer distinguishes a real subject from its source photo and existing marks:
new product concepts call for independently developed solutions, while place
branding and subject communication may require recognizable identifying features.
Designer owns creative judgment; specialist Skills contain discipline-specific
methods. `brand_lock.md` and legacy research fields remain interface-compatible
evidence inputs, not a whitelist of permissible design styles.
Each saved path is published to the live reference library, including all
items in batch results. `list_skills` uses Pi discovery cached per invocation
and exposes discipline metadata; `refresh` discovers catalog changes. Designer
chooses Skills from intent and deliverables, not hard-coded keyword routing.
`use_skill` supports `role: primary|supporting`, explicit `deactivate`, and
`reload`. Switching the primary replaces the prior primary; unchanged bodies
are not duplicated, changed files are reloaded, and unavailable modules yield
actionable fallback guidance without changing the active selection. Switching
changes applicability, not historical model context. New specialist invocations
start fresh and must load needed Skill bodies from their persisted selection
rationale; a saved selection is not loaded knowledge.
Skill combinations use one domain lead and scoped
application/craft support. Reviewer checks style-intent fit and prompt quality
before Builder executes, without adding post-generation visual audits.

On macOS, active Dreamatic tasks prevent idle system sleep with a scoped
`caffeinate -i` assertion. It ends when the agent finishes, stops, or the session
shuts down. Set `DREAMATIC_PREVENT_IDLE_SLEEP=false` to disable it. This does not
keep the display on, change power settings, or override lid-close/manual sleep.
Host sleep pauses local execution and delays timeout/heartbeat callbacks; do
not attribute those wall-clock gaps entirely to remote provider latency.

Operation retries receive a terminal status on recovery, failure or cancellation.
The live UI and persisted workflow also reconcile older retry records when the
owning stage or Run completes, so historical timeouts do not remain spinning.

```env
PORT=4310
DREAMATIC_WORKSPACE=./workspace
DREAMATIC_AGENT_RETRY_ATTEMPTS=3
DREAMATIC_IMAGE_RETRY_ATTEMPTS=3
DREAMATIC_OPERATION_ATTEMPT_BUDGET=5
DREAMATIC_IMAGE_TIMEOUT_MS=300000
DREAMATIC_IMAGE_CONCURRENCY=2
DREAMATIC_IMAGE_EDIT_RETRY_ATTEMPTS=2
DREAMATIC_IMAGE_EDIT_TIMEOUT_MS=180000
```

Image generation uses a bounded concurrency of two by default, configurable
from one to eight with `DREAMATIC_IMAGE_CONCURRENCY`. Independent tasks in
`image_generate_batch` start concurrently, including views sharing written
consistency rules. An explicit `anchorId` retains anchor-first scheduling for
dependent batches. Each completed image emits progress immediately; successful
outputs are retained when another item fails. Raise concurrency only when the
provider supports it. Image editing has a shorter, separate retry budget
because a stalled edit endpoint should not block the Run for fifteen minutes.
`image_edit_batch` applies the same concurrency bound to ready independent edits,
including siblings sharing a completed source image. It rejects duplicate ids,
output paths and source dependencies inside the batch, reports per-item progress
and preserves partial success. Run source/edit chains in successive groups;
use text-only generation for companions that need shared style, not exact pixels.
Batching reduces serial waiting; it does not fix provider timeouts. Retry failed
required items only within the existing limits, without regenerating successes.

Run JSON can be persisted with `write_json(runId, path, data)`: `path` is relative
to the Run and `data` is an object. Runtime serialization and atomic replacement
avoid malformed nested JSON and partial writes; existing stage schemas and the
legacy `write` tool remain supported. Compact Design Context excludes tool and
heartbeat events, minifies JSON without truncating execution-critical prompts,
and retains file hashes. Specialist metrics record first streamed delta and
first visible text separately from the SDK's assistant-message start time.

Web and CLI must point to the same `DREAMATIC_WORKSPACE`. This is what makes a
CLI-created, interrupted, or completed project appear in the React workspace.

## Web workspace

```bash
npm run dev
```

The React workspace provides project navigation, a live nested workflow stream,
reference and output previews, a persistent pan/zoom Canvas, and a Showcase
mode for the generated standalone gallery. Runs can be renamed or moved to the
recoverable local trash from the sidebar.

For a production-style local build:

```bash
npm run build
npm start
# open http://localhost:4310
```

## CLI

The CLI runs the same Orchestrator, Extensions, child sessions, and
workspace as the Web application.

```bash
# One complete design task
npm run cli -- "为一家当代茶品牌设计主视觉和包装系列"

# Attach one or more references
npm run cli -- --image ./references/logo.png "保留标志，设计一套发布海报"

# Interactive mode
npm run cli

# Machine-readable Pi event stream
npm run cli -- --json "设计一个科技展览主视觉"

# Long brief from a file (macOS/Linux)
cat brief.md | npm run cli --

# Resume a stopped Run; do this only after the original CLI process has ended
npm run cli -- --resume <run-id>
```

After `npm run build`, `npm link` can install the shorter `dreamatic` command
for the active Node installation.

## Durable Run model

Every project is stored under `workspace/runs/<run-id>`:

```text
brief.json                    normalized brief and domain scope
design-context.json           authoritative context index, revision, and approval state
run-state.json                persisted workflow state
bus.jsonl                     append-only Design Bus and live lifecycle events
plan/                         task breakdown, design system, acceptance criteria
research/                     evidence, cached sources, and reference images
sessions/<persona>/           resumable Pi child-session histories
artifacts/                    generated, edited, and selected design artifacts
review/                       Design Context challenges and verdict
final/                        exported self-contained package
canvas/canvas-state.json      Canvas positions and camera state
```

Large visual payloads are persisted as files instead of accumulating in model
history. Dreamatic sends bounded previews to the model, prevents duplicate
inspection of the same image within one stage invocation, prunes old base64
blocks from active context, and retains reloadable paths. Provider failures are
retried per concrete operation, and committed domain milestones can close a
specialist card even if its final transport event is lost.

## Repository layout

```text
apps/web                 React + Vite design workspace
apps/server              Local HTTP/SSE API and Run inventory
apps/cli                 One-shot, interactive, JSON, and resume CLI
packages/design-agent    Dreamatic Pi extension and visual tools
.pi/agents               Orchestrator, Researcher, Designer, Reviewer, Builder
.pi/skills               Optional Designer domain and craft Skills
workspace                Local Runs and Pi sessions (gitignored)
docs                     Architecture, migration, and UI contracts
```

## Development checks

```bash
npm run check
npm run build
npm test -w @dreamatic/design-agent
npm test -w @dreamatic/server
```

## Preserved design examples

The following visual examples are retained from the earlier Dreamatic README.
They describe prior design outputs, not the current TypeScript architecture.

### Brand & Merchandise: Jingju Guochao Series

| Product system | Packaging | Series overview |
|---|---|---|
| <img src="examples/jingju-guochao-merch/final/artifacts/generated-images/01-product-overview.png" width="220"> | <img src="examples/jingju-guochao-merch/final/artifacts/generated-images/07-packaging-application.png" width="220"> | <img src="examples/jingju-guochao-merch/final/artifacts/generated-images/10-series-overview.png" width="220"> |

### Brand & Merchandise: Tongji IDVX Lab

| Tote hero | Notebook cover | Badge system |
|---|---|---|
| <img src="examples/tongji-idvx-lab-merch/final/artifacts/generated-images/01-tote-hero-front.png" width="220"> | <img src="examples/tongji-idvx-lab-merch/final/artifacts/generated-images/03-notebook-cover.png" width="220"> | <img src="examples/tongji-idvx-lab-merch/final/artifacts/generated-images/05-badge-set-board.png" width="220"> |

### Product Design: Elderly AI Companion Device

| Hero render | Three-view | CMF board |
|---|---|---|
| <img src="examples/elderly-ai-companion-device/final/artifacts/generated-images/01-hero-render.png" width="220"> | <img src="examples/elderly-ai-companion-device/final/artifacts/generated-images/02-three-view.png" width="220"> | <img src="examples/elderly-ai-companion-device/final/artifacts/generated-images/06-cmf-board.png" width="220"> |

### Architecture: Zhujiajiao Visitor Center

| Site context | Zoning | Entry hall |
|---|---|---|
| <img src="examples/zhujiajiao-visitor-center-space/final/artifacts/generated-images/01-site-context-relation.png" width="220"> | <img src="examples/zhujiajiao-visitor-center-space/final/artifacts/generated-images/02-master-plan-zoning.png" width="220"> | <img src="examples/zhujiajiao-visitor-center-space/final/artifacts/generated-images/06-hero-entry-hall.png" width="220"> |

### Poster & Advertising: IEEE VIS 2026

| Main poster | Key visual | Social post |
|---|---|---|
| <img src="examples/ieee-vis-2026-promo/final/artifacts/generated-images/01-main-poster.png" width="220"> | <img src="examples/ieee-vis-2026-promo/final/artifacts/generated-images/02-key-visual.png" width="220"> | <img src="examples/ieee-vis-2026-promo/final/artifacts/generated-images/05-social-twitter-post.png" width="220"> |

### Campus Campaign: Shanghai Innovation Institute

| Logo poster | Chinese poster | Merch mockup |
|---|---|---|
| <img src="examples/shanghai-chuangzhi-college-merch-system/final/artifacts/generated-images/01-logo-application-poster.png" width="220"> | <img src="examples/shanghai-chuangzhi-college-merch-system/final/artifacts/generated-images/02-campaign-poster-zh.png" width="220"> | <img src="examples/shanghai-chuangzhi-college-merch-system/final/artifacts/generated-images/07-merch-mockup.png" width="220"> |

### Product Design: VibeCoding Creative Compact Input

| Hero render | Usage scene | Form language |
|---|---|---|
| <img src="examples/vibecoding-creative-compact-input/final/artifacts/generated-images/01-hero-render.png" width="220"> | <img src="examples/vibecoding-creative-compact-input/final/artifacts/generated-images/03-usage-scene.png" width="220"> | <img src="examples/vibecoding-creative-compact-input/final/artifacts/generated-images/05-exploded-view.png" width="220"> |

## Role Ownership and Revisions

- Run writes are enforced by role: Researcher → research, Designer → plan,
  Reviewer → review, Builder → artifacts, Orchestrator → progress/handoff notes.
  The runtime owns Brief, state, context, bus, acquisition validation and delivery metadata.
- Designer authors three canonical JSON specifications. Completion derives the
  acceptance and execution Markdown companions when not custom-authored; existing
  consumers still receive the same five files. Runtime normalization never invents
  prompts or decides creative direction.
- Designer first establishes source-linked understanding of consequential subject
  terms and informative reference figures, retaining concise `subject_understanding`
  entries in the existing Design Spec. Decisions, prompts and acceptance criteria
  carry the defining properties rather than relying on a specialist name or
  decorative resemblance. Reviewer challenges material meaning mismatches without
  requiring literal imitation, exhaustive research or proven concept performance.
  This descriptive addition does not introduce a new stage, schema gate, mandatory
  Skill or Builder image audit; legacy plans remain valid.
- Run files use a fixed layout under `workspace/runs/<runId>/`: research narrative
  `research/research-findings.md`, evidence `research/evidence.json`, specifications
  `plan/design_system.json`/`plan/design_plan.json`, deliverables
  `plan/deliverable_manifest.json`, acceptance `plan/acceptance_criteria.md`,
  execution `plan/task_breakdown.md`, review `review/design-review.md`/`.json`,
  Showcase `artifacts/00-gallery.html`, exported delivery `final/00-index.html`.
  Runtime and Server share this contract. Legacy `research/research.md` and
  `review/review.md`/`.json` remain readable; new Agent writes use canonical names.
  Do not rename these paths in prompts or use project titles as filenames.
- Builder authors local HTML/SVG layouts and all Showcase content. Finalization
  uses its existing page, never Orchestrator-generated replacement content.
  Before writing the page, Builder loads the independent `showcase-layout`
  Skill for theme headings/separators, weighted principal/supporting/context
  image grids, responsive typography and presentation interactions. Its base
  Agent contract remains sufficient if that Skill is removed. Skill discovery
  and loading respect the specialist audience, avoiding Designer/Builder mixing.
  Finalization
  requires a nonempty Builder-authored gallery; no substitute page is generated.
  Orchestrator packages the existing page and gives a text-only delivery summary,
  without writing page content or changing its layout.
  Showcase copy describes the works: title and collection overview, distinct
  captions for each image, then a concluding summary. Internal reasoning,
  prompts and workflow logs remain outside visible page copy. Generated/edited
  images expose Prompts on hover, matched by exact local path and preferring
  actual generation sidecars; missing sidecars use explicitly labeled plan
  Prompts. Reference captions clamp to two lines with full text on hover/focus,
  without expanding the grid on focus, while citation/source links remain visible.
  Reference thumbnails open their original source in a new window/tab; unknown
  sources remain non-clickable. Optional `design_plan.json`
  `showcase` copy supplies `overview`, deliverable-id-keyed `captions` and `summary`.
  Finalization appends every retained reference image and a deduplicated source
  list from research evidence and cached sources. Missing images are labeled;
  the appendix uses compact 88px-high thumbnails, 11px captions and 12px
  bibliography text, retaining source links and readable theme colors.
  Numbered figure-source links point to IEEE-style bibliography entries. Available authors,
  publication dates, journal/publisher, volume/issue/pages, DOI and access dates
  are formatted in a consistent numbered academic layout; duplicate records
  enrich missing metadata and matching DOIs are deduplicated. Missing citation
  details are never invented, and formatting requires no additional retrieval.
  reference sections refresh on revisions without duplicating the appendix.
  HTTP(S) source hyperlinks are allowed, but all embedded resources stay local
  and are included in the exported package. No extra network or model calls are needed.
  Designer specifies copy and typography directly in image prompts; existing
  generation/editing tools can render them in the artwork without a separate
  compositor. Gallery captions are supplementary, not substitutes for required
  in-image copy. Generative rendering does not guarantee flawless text accuracy.
- `ask_user` supports kickoff, concept choices and revisions. Explicit feedback
  after completion opens `run_revision` on the same project, archiving the previous
  delivery and invalidating old approval gates. Unchanged outputs can be retained;
  changed outputs require a new Designer/Reviewer cycle before execution.
- Delivery metadata separates reviewed specifications, mechanically valid files,
  unassessed visual fidelity, unvalidated engineering feasibility and pending user
  acceptance. Fast one-pass production does not add a second visual audit.

## License

[MIT License](LICENSE)
