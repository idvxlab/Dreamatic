# Dreamatic · Art

**An AI design team that turns your brief into research-informed design concepts, generated visuals, and curated showcase pages.**

Dreamatic · Art **v2.3.0** is an open-source, local-first design application for designers, researchers, educators, and product teams. Four specialist agents clarify your intent, research the subject, develop a design proposal, and produce the design images and a project-specific showcase page. The workflow runs on the Pi SDK, with project documents and generated work saved in a local workspace.

[Official website](https://www.dreamatic.art/) · [Source code](https://github.com/idvxlab/Dreamatic) · [MIT license](LICENSE)

## What changed since v2.2.0

v2.3.0 replaces the previous agent implementation with a smaller, four-stage design pipeline while retaining the Web and desktop interfaces, Canvas, Settings, project management, preview, export, and Gallery publication.

| Area | v2.2.0 | v2.3.0 |
| --- | --- | --- |
| Workflow | Orchestrator, Researcher, Designer, Reviewer, and Builder with review approval contracts | Orchestrator → Researcher → Designer → Builder; no separate Reviewer stage |
| Project handoff | Structured Context JSON documents and execution contracts | Markdown handoffs: `intent.md`, `research.md`, and `design.md` |
| Execution architecture | Dedicated `packages/design-agent` runtime policy and tooling | Pi SDK sessions with application policy in `apps/server`; the old package has been removed |
| Presentation ownership | Designer-authored presentation specifications executed by Builder | Builder generates all planned images, records an independent exhibition direction, and composes a static showcase |
| Execution entry points | Web, desktop, and CLI | Web and desktop; CLI design execution is currently unavailable |

This version also improves saved-output recovery, image reference validation, long-running image progress feedback, completion reporting, and historical log processing. It unifies the product name as **Dreamatic · Art**.

Some v2.2.0 configuration fields and historical project readers remain for compatibility. Their presence does not mean every previous execution feature is available in the new pipeline. In particular, the current pipeline does not implement the former review/approval loop, interactive application generation, or document/video input extraction.

## From brief to showcase

| Stage | Responsibility | Saved output |
| --- | --- | --- |
| **Orchestrator** | Understand the brief and request clarification when needed | `intent.md` |
| **Researcher** | Gather findings and traceable sources relevant to the design | `research.md` |
| **Designer** | Develop the concept and specify each design image, including its introduction, prompt, and dimensions | `design.md` |
| **Builder** | Generate every planned image, determine exhibition art direction, and compose the showcase | Images, `showcase.md`, and `final/00-index.html` |

Designer draws on reusable professional Skills for areas such as brand identity, product design, visual communication, editorial design, architecture, and UX/UI. These Skills supply design knowledge; they do not add CAD, video, or other production tools.

Builder uses the design proposal, each image's prompt and description, and the material inventory to determine hierarchy, sequence, typography, color, and explanation placement. It completes a distinct `plan_showcase` step before writing the page. **Every planned image must be included**; curation changes how the works are presented rather than selecting a smaller subset.

Showcase composition uses text evidence rather than image inspection. Builder's reasoning model does not need vision support, and successful images are not regenerated just to change the layout. New showcases are self-contained static HTML with inline CSS, local imagery, native navigation, and system or available local fonts. They do not depend on JavaScript or remote imports.

## Working with projects

- **Live conversation:** follow specialist output, stage milestones, questions, and tool activity inside the existing conversation interface.
- **Image progress:** see the total image count, saved and reused work, active images, elapsed generation time, and the observed average for successfully generated images. Generation may take several minutes; keep the application running until it finishes.
- **Completion report:** see delivered outputs, total elapsed time, per-stage durations, and reported token usage. Retries and resumed work are included; unavailable usage is marked rather than counted as zero.
- **Canvas and preview:** inspect project assets and the generated showcase, with saved thumbnails remaining available after generation.
- **Local project management:** reopen, rename, revise, or move projects to recoverable local trash.
- **Export and publication:** download a project ZIP or publish eligible image-based designs to the official Gallery from Preview. Replacing an existing publication requires confirmation. Pure HTML projects without delivered design images are not currently eligible for Gallery publication.
- **English and Chinese UI:** switch interface languages without automatically translating project content.

### Recovery and output integrity

Completed stage checkpoints and matching image receipts let **Continue workflow** reuse valid work. Changed requests, upstream documents, or relevant configuration can invalidate affected checkpoints. Resume is conditional on saved evidence and input compatibility; it is not a guarantee that any arbitrary interrupted response can be continued in place.

Stage documents are saved by the application after validation. Agents return their deliverables without needing general-purpose write permissions. Designer drafts are retained before validation so compatible complete drafts can be recovered without another model call. Unused but traceable bibliography entries produce a warning; missing or invalid references still fail validation.

Builder uses stable image identifiers that the server resolves to verified local files. The server checks image coverage and content digests before delivery. Compatible saved HTML and its paired exhibition direction can be finalized locally on resume without new model or image calls. Unknown references, unsafe paths, missing work, and incompatible saved outputs remain errors.

Historical workflow logs are filtered for public display without exposing embedded image payloads. This avoids loading large Base64 image results into the conversation and reduces project loading stalls; original session records and image files are preserved.

## Run from source

Use **Node.js 22.19 or newer** and npm.

```sh
git clone https://github.com/idvxlab/Dreamatic.git
cd Dreamatic
npm ci
cp .env.example .env
npm run build
npm start
```

Open **http://localhost:4310**. Configure your providers through **Settings** before starting a design task.

The source configuration is loaded from `.env` at the repository root unless `DREAMATIC_CONFIG_DIR` selects another directory. The default workspace is `./workspace`; use `DREAMATIC_WORKSPACE` to choose another location. Keep API keys, sessions, and generated runs out of source control.

### Provider setup

Settings supports compatible Chat Completions and Responses endpoints, with optional reasoning models and thinking levels per active role. Image generation uses a separately configurable endpoint and model; its API key falls back to the reasoning API key when omitted.

| Setting | Purpose |
| --- | --- |
| `DREAMATIC_API_KEY` | Reasoning provider credential |
| `DREAMATIC_BASE_URL` | Reasoning API base URL |
| `DREAMATIC_MODEL` | Default reasoning model |
| `DREAMATIC_PROVIDER_TYPE` | Provider API mode, such as `openai-compatible` or `openai-responses` |
| `DREAMATIC_MODEL_ORCHESTRATOR`, `DREAMATIC_MODEL_RESEARCHER`, `DREAMATIC_MODEL_DESIGNER`, `DREAMATIC_MODEL_BUILDER` | Optional per-role model overrides |
| `DREAMATIC_CONTEXT_WINDOW`, `DREAMATIC_MAX_TOKENS` | Limits for custom models absent from Pi's catalog, unless supplied in model capabilities |
| `DREAMATIC_MODEL_CAPABILITIES` | Explicit endpoint-specific model capabilities |
| `DREAMATIC_IMAGE_BASE_URL`, `DREAMATIC_IMAGE_MODEL`, `DREAMATIC_IMAGE_API_KEY` | Image provider configuration |
| `DREAMATIC_IMAGE_GENERATION_ENDPOINT` | Optional override for the standard image generation URL |
| `DREAMATIC_IMAGE_DEFAULT_SIZE` | Image dimension ceiling used as a budget, not proof of model support |
| `DREAMATIC_IMAGE_CAPABILITIES` | Optional verified sizes, for example `{"sizes":["1024x1024"]}` |
| `DREAMATIC_IMAGE_CONCURRENCY`, `DREAMATIC_IMAGE_GLOBAL_CONCURRENCY` | Per-project and process-wide image concurrency |
| `DREAMATIC_SITE_URL` | Gallery publication destination |

Image size information can come from model metadata, explicitly verified settings, or observed successful generations. When capabilities are unknown, requests within the configured ceiling are validated by actual generation; the ceiling itself is not treated as supported-size metadata. Capability discovery does not make a separate paid generation probe.

Research uses DuckDuckGo by default or Serper when configured with `DREAMATIC_SEARCH_PROVIDER=serper` and `DREAMATIC_SEARCH_API_KEY`.

The `.env.example` template retains historical compatibility fields and comments. Use Settings and the [pipeline documentation](apps/server/DESIGN-PIPELINE.md) to distinguish current execution controls from retained legacy values. A model name alone does not establish support for reasoning controls or tool schemas.

### Desktop application

The Electron shell uses the same interface and design pipeline.

On an Apple Silicon Mac:

```sh
npm run desktop
```

On Windows 10 or 11 (x64):

```sh
npm run desktop:win
```

Create platform packages with `npm run desktop:package` or `npm run desktop:package:win` on the corresponding supported platform. Preparation builds the application and stages its runtime dependencies; it may download required runtime components. Release scripts also support `npm run release:mac` and `npm run release:win`.

## Development

```sh
npm ci
npm run check
npm run build
npm run dev
```

The development UI is served at **http://localhost:5173**, with the API on **port 4310** by default. `npm run dev` builds the shared package and server before starting them; rebuild server code and restart the process after backend changes.

Run server regression tests after building the workspace:

```sh
npm run build
npm run test -w @dreamatic/server
```

Additional test entry points:

```sh
node --test apps/web/test/*.test.mjs
npm run desktop:test
```

Browser UI tests use an available Chromium executable. Set `DREAMATIC_HTML_BROWSER_EXECUTABLE` when it cannot be discovered automatically; tests that require a browser may skip when none is available. Automated provider tests use local fixtures and do not establish live model quality or visual fidelity.

### Repository structure

| Directory | Responsibility |
| --- | --- |
| `apps/web` | React interface, conversation, Canvas, Settings, and preview |
| `apps/server` | Transport, session registry, application design policy, assets, recovery, and delivery |
| `apps/server/prompts` | Instructions for the four active design roles |
| `apps/desktop` | Electron application shell |
| `apps/cli` | Compatibility entry point; design execution is unavailable |
| `packages/project-data` | Shared configuration validation and historical project display/export helpers |
| `.pi/skills` | Reusable professional design knowledge |
| `workspace` | Local runtime records and generated output; do not commit runs |

Pi **1.4.0** provides model sessions, providers, resource discovery, Skills, tools, and session persistence. Dreamatic · Art owns design policy, image generation, checkpoints, showcase validation, and delivery. Pi runtime internals are not copied or forked into this repository.

## Current scope and limitations

- The active pipeline produces **design images and static showcase pages**, rather than production applications or interactive UX/UI implementations.
- Image attachments can enter the workflow. Document and video input extraction are not implemented in the current pipeline.
- There is no separate Reviewer or formal approval gate in the four-stage pipeline.
- CAD, engineering-grade 3D, video production, and game-engine delivery are not implemented.
- Showcase checks verify structural constraints, image references, and coverage; they do not certify aesthetic quality. Composition is based on documented intent rather than visual inspection of generated images.
- Citation checks verify numbering and source traceability, not the factual accuracy of research claims.
- Completion usage reflects provider-reported data. Missing image or model token reports remain explicitly unknown.
- Historical projects remain available through compatibility readers and export helpers. The old runtime and execution contracts are not restored by opening an older project.

## Documentation

- [Design pipeline, configuration, recovery, and delivery](apps/server/DESIGN-PIPELINE.md)
- [Design Skill sources and attribution](docs/DESIGN-SKILL-SOURCES.md)
- [Frontend design system](docs/FRONTEND-DESIGN-SYSTEM.md)
- [Refactor preparation and historical boundaries](docs/REFACTOR-PREPARATION.md)

Created by [Intelligent Design & Innovation Lab](https://idvxlab.com/). Released under the [MIT license](LICENSE).
