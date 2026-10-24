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

This version also introduces a six-view workbench with resizable panels, a project overview, a media canvas, unified document and reference reading, and portfolio PDF export. It improves saved-output recovery, image reference validation, long-running image progress feedback, completion reporting, and historical log processing. The product name is unified as **Dreamatic · Art**.

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

The interface separates project navigation on the left, a tool panel in the middle, and the content workspace on the right. New projects open in **Workbench**. The navigation and tool panels can be hidden independently; on desktop, drag the tool panel's right divider to resize it, with a minimum width of **320 px**. Narrow windows use drawers.

| View | Tool panel | Content workspace |
| --- | --- | --- |
| **Workbench** | Talk to Agent conversation | Project Overview |
| **Canvas** | Categorized project assets | Editable media canvas |
| **Preview** | Hidden initially; reopen to talk to the agent | Showcase and floating export, publish, and share controls |
| **Context** | Design-context file list | Selected document |
| **Asset Library** | Uploaded files, generated works, and research materials | Selected asset |
| **References** | Bibliography, research sources, and local references | Reader mode or original webpage |

### Conversation and project overview

**Talk to Agent** retains messages, specialist output, clarification questions, and expandable tool activity. The input area's action button sends a message when idle and stops the run while working; it is disabled while a stop request is pending. Stopping preserves unsent drafts and attachments. Enter sends a message; Shift+Enter inserts a new line.

Live runtime status appears in **Project Overview**, rather than a duplicate panel above the conversation. It includes the current activity, elapsed time, image-generation counts, saved and reused work, and observed generation durations. Image generation may take several minutes; keep the application running until it finishes.

Overview sections can be expanded or collapsed independently:

- **Design Context:** compact, responsive cards with independently scrollable summaries and links to the full documents.
- **References:** links to recorded bibliography entries and research materials.
- **Generated Works:** generated design images and the Showcase page; click a card to open its asset or preview.
- **Runtime Summary:** delivered outputs, elapsed time, per-stage durations, and reported token usage. Retries and resumed work are included; unavailable usage remains explicitly unknown.

Projects carry one primary discipline and optional secondary disciplines from a shared eight-category taxonomy. Header tags update live, and exports preserve compatible category metadata for DreamaticSite. Projects can be reopened, renamed, revised, or moved to recoverable local trash. English and Chinese interface languages are available; switching languages does not translate project content.

### Media canvas

The Canvas begins empty: project assets are listed in the tool panel rather than automatically placed on the board. Historical automatic asset inventories and informational labels are filtered out; manually added elements remain available.

- Drag a project image or video from the asset list onto the canvas, or use its **Add to canvas** button. Each addition creates an independent instance, including repeated uses of the same file.
- Select and move elements, resize media proportionally with the corner handle, and remove selected elements with the toolbar or Delete/Backspace. Removing an element does not delete its source file.
- Play, pause, seek, and adjust volume using native video controls. Supported containers include MP4, WebM, and MOV; actual playback depends on the browser's codec support. Videos pause when leaving Canvas.
- Pan, zoom, fit the current contents, or reflow the existing elements. Reflow preserves media instances and custom content.
- Toggle **Positioning dots** and **Grid lines** independently in the bottom toolbar. Both follow camera movement and zoom; visibility preferences are remembered locally.

Element positions, dimensions, and the camera are saved per project. Restore and save failures show retry controls. Canvas editing currently means composition and media playback, not pixel editing, image filters, or video trimming.

### Documents and reference reading

Context, Asset Library, and References share one document viewer. File lists show image thumbnails when available, otherwise type-specific icons and format labels. The viewer supports Markdown, text, JSON/CSV, HTML, PDF, images, and video. Other cataloged formats, including Office documents and 3D models, provide an original-file opening or download fallback.

Context reading supports current Markdown handoffs and historical structured Context files. New projects no longer generate the obsolete `design-context.json` index; existing copies remain readable for compatibility.

Web references default to **Reader mode**, which extracts readable text, images, and links from a registered public source without executing its scripts. **Original page** attempts embedded viewing with script support for external sites. **Open original** is always available. Some websites prohibit embedding; sign-in, paywalls, anti-bot protection, JavaScript-only content, and network failures can also prevent extraction. The reader reports failures and offers retry and alternate opening options.

Viewing a file in the library or placing it on Canvas does not make it an input to the design agents. The current pipeline accepts image attachments; document and video input extraction remain unavailable.

### Preview, export, and publication

Preview displays the generated Showcase and floating controls for opening the page, downloading a project ZIP, creating a **Portfolio PDF**, publishing, and sharing. It initially hides the tool panel to make room for the work; reopen the panel to continue the agent conversation alongside the preview.

Eligible image-based designs can be published to the official Gallery. Replacing an existing publication requires confirmation. Share becomes available after successful publication. Pure HTML projects without delivered design images are not currently eligible for Gallery publication. Compatible historical interactive HTML presentations can still be previewed; the active generation pipeline produces static showcases.

Portfolio PDF export uses existing project images and the saved exhibition direction, with representative selection, duplicate suppression, and page layouts adapted to the works. PDF curation can omit repetitive works; the HTML Showcase retains its all-planned-images policy. PDF export does not start another design or image-generation run.

For a completed project, PDF export is also available from the repository root:

```sh
npm run portfolio -- <completed-run-id>
```

The command uses `DREAMATIC_WORKSPACE` or `./workspace` and prints the generated file path and export details. PDF rendering requires an available Chromium executable; set `DREAMATIC_HTML_BROWSER_EXECUTABLE` if automatic discovery fails. Font coverage must include the project's language; optionally set `DREAMATIC_PDF_FONT` to a licensed embeddable TTF, OTF, WOFF, or WOFF2 file.

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

Research uses DuckDuckGo by default or Serper when configured with `DREAMATIC_SEARCH_PROVIDER=serper`. Serper uses `DREAMATIC_SEARCH_API_KEY`, falling back to the legacy `SERPER_API_KEY` when the primary key is empty.

Settings and `.env.example` expose current execution controls. Retired settings already present in `.env` are preserved when saving, but cannot be edited through the settings API. Reviewer overrides, image editing, research caching, old agent retry budgets, visual preview limits and browser approval controls are not active runtime settings. Browser executable overrides remain available to development tests and portfolio PDF rendering. `DREAMATIC_PROVIDER_NAME` is an optional connection label; it does not switch profiles. A model name alone does not establish support for reasoning controls or tool schemas.

Model timeouts apply per response and exclude tool execution: `DREAMATIC_MODEL_TURN_TIMEOUT_MS` bounds first-output wait (Researcher uses its own override), `DREAMATIC_MODEL_GENERATION_TIMEOUT_MS` bounds generation after output begins, and `DREAMATIC_MODEL_IDLE_TIMEOUT_MS` bounds silence between nonempty streamed outputs. `DREAMATIC_MODEL_TOTAL_TIMEOUT_MS` optionally caps the whole response.

`DREAMATIC_IMAGE_RESPONSE_MAX_BYTES` limits each image API response, including base64 JSON, and each image download. Responses are read incrementally; exceeding the limit produces a nonretryable failure. Adjust the limit before explicitly retrying oversized images.

In the macOS and Windows desktop app, `DREAMATIC_PREVENT_IDLE_SLEEP` prevents idle system sleep while any task is running, then releases the wake lock when tasks finish, fail, stop or pause for input or image retry. It does not prevent display sleep or explicit system sleep. This setting is hidden in the web app. `PORT` controls the web server; the desktop app assigns its own port.

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
| `apps/web` | React workbench, conversation, project overview, media canvas, document/reference readers, Settings, and preview |
| `apps/server` | Transport, session registry, application design policy, project files, reference extraction, media delivery, recovery, and PDF export |
| `apps/server/prompts` | Instructions for the four active design roles |
| `apps/desktop` | Electron application shell |
| `apps/cli` | Compatibility entry point; design execution is unavailable |
| `scripts/portfolio.mjs` | Export an existing completed project as a portfolio PDF |
| `packages/project-data` | Shared configuration validation and historical project display/export helpers |
| `.pi/skills` | Reusable professional design knowledge |
| `workspace` | Local runtime records and generated output; do not commit runs |

Pi **1.4.0** provides model sessions, providers, resource discovery, Skills, tools, and session persistence. Dreamatic · Art owns design policy, image generation, checkpoints, showcase validation, and delivery. Pi runtime internals are not copied or forked into this repository.

## Current scope and limitations

- The active pipeline produces **design images and static showcase pages**, rather than production applications or interactive UX/UI implementations.
- Image attachments can enter the workflow. Document and video input extraction are not implemented; document viewing and video playback on Canvas are separate UI capabilities.
- Embedded webpages and reference extraction depend on source-site access policies. Reader mode does not bypass authentication or paywalls.
- Canvas supports media placement, proportional resizing, and playback; image pixel editing and video timeline editing are not implemented.
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
