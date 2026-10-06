# DreamaticArt

**An AI design system that turns creative briefs into reviewed visual designs and interactive HTML interfaces.**

![DreamaticArt](docs/assets/dreamatic-hero.png)

DreamaticArt coordinates research, design, review and implementation in a persistent
project workspace. Each project retains its requirements, references, design
specifications, review records and delivered files.

The current **v2.0.3 development line** supports:

- **Design category recognition:** Orchestrator identifies the categories and
  tasks required by a brief, including projects that combine several disciplines.
- **Dynamic Skills:** Designer discovers, selects, loads and switches professional
  and supporting Skills for each task.
- **Image and HTML delivery:** Existing image generation/editing serves visual
  design; UX/UI work produces responsive HTML/CSS/JS with local interactions.
- **Canvas, Preview and Export:** Inspect and arrange project assets, preview the
  delivered design, open it in a new tab, or download the project as a ZIP.
- **Persistent Web and CLI workflows:** Both interfaces share the same agents,
  workspace, project state and recovery mechanism.

## Workflow and agents

```text
User brief
  → Orchestrator: clarify requirements and assign categories/tasks
  → Researcher: gather evidence and references
  → Designer: load task-specific Skills and design the deliverables
  ↔ Reviewer: assess the design and request concrete revisions
  → Builder: execute approved image/HTML tasks and validate outputs
  → Canvas + Preview → Open / Export
```

Orchestrator coordinates the stages; Researcher supplies evidence throughout the
design process. Builder starts after the design has passed review.

| Agent | Responsibility |
| --- | --- |
| Orchestrator | Understand requirements, identify design categories, assign tasks and manage workflow transitions |
| Researcher | Research the subject, collect sources and references, and document evidence |
| Designer | Choose and load Skills; develop concepts, image specifications or complete HTML/CSS/JS sources |
| Reviewer | Assess design quality, task coverage and executable specifications; approve or request revisions |
| Builder | Implement approved results using the declared tools, build the image Gallery when needed, and perform mechanical checks |

Orchestrator determines **what design work is needed**; Designer determines
**which Skills to use and how to design it**. Skill mappings cover media
communication, industrial, UX, architecture/space, fashion/textiles, game
experience and service design. Cross-domain Skills support composition and design
systems; output Skills guide image expression and HTML delivery. Video, 3D and
game-engine execution are not implemented.

## macOS desktop app

On an Apple Silicon Mac, open the DMG from `release/`, drag **DreamaticArt** to
**Applications**, and launch it. The desktop app includes Node, Pi tools and the
HTML review browser; it starts and stops its local service automatically.
Configure your model and search providers through **Designer → Settings**.

Configuration and projects are stored in `~/Library/Application Support/Dreamatic/`
and survive app upgrades. Existing web projects are not imported automatically.
**Preview → Open** opens a desktop preview window; **Export** uses a native save dialog.
The app still needs internet access to call configured model/search providers.

### Build the macOS installer

Requirements: an **Apple Silicon Mac (arm64)**, **Node.js 22.19 or newer**,
npm 10 or newer, internet access and a logged-in macOS desktop session.
Run from the DreamaticArt project directory:

```bash
npm run release:mac
```

The release script installs locked dependencies, builds and checks the project,
prepares the bundled runtime, runs regression and desktop UI tests, then creates
and verifies the DMG from a read-only mount outside the development directory.
Electron downloads fall back to a mirror when needed and must match the official
SHA256 checksum. A failed release stops without replacing the previous DMG.

| Output | Location |
| --- | --- |
| Installer | `release/DreamaticArt-<version>-mac-arm64.dmg` |
| SHA256 checksum | `release/DreamaticArt-<version>-mac-arm64.dmg.sha256` |
| Release log | `release/logs/<timestamp>.log` |

The version is read from `apps/desktop/package.json`; update it yourself before
releasing a new version. The script does not change versions, commit to Git,
modify `.env` or overwrite existing user projects.

To reuse installed dependencies while retaining all release checks:

```bash
npm run release:mac -- --skip-install
```

For development, use `npm run desktop`. For packaging without the full regression
and desktop UI checks, use `npm run desktop:package` after installing dependencies
with `npm ci`; installer integrity and independent startup checks still run.

Local builds use ad-hoc signing. Distribution without Gatekeeper confirmation
requires an Apple Developer ID and notarization credentials. Agent instructions
and Skills are shared with the Web/CLI versions.

## Web and CLI installation

### Requirements

- Node.js **22.19 or newer** and npm 10 or newer.
- A vision-capable OpenAI-compatible text model.
- An OpenAI-compatible image provider for image generation/editing tasks.
- The server's `zip` command for project downloads.
- An installed Chromium-based browser for HTML interaction validation. Static
  validation is available without a browser; no browser is downloaded automatically.

### Setup

```bash
git clone --branch dev https://github.com/idvxlab/Dreamatic.git
cd Dreamatic
cp .env.example .env
npm install
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`. Ensure
that a compatible `zip` executable is available on the server's `PATH`.

Edit `.env` to configure your providers:

```env
DREAMATIC_API_KEY=your-text-model-key
DREAMATIC_BASE_URL=https://your-text-provider/v1
DREAMATIC_MODEL=your-vision-capable-model

DREAMATIC_IMAGE_API_KEY=your-image-provider-key
DREAMATIC_IMAGE_BASE_URL=https://your-image-provider/v1
DREAMATIC_IMAGE_MODEL=your-image-model
```

Text requests use OpenAI-compatible chat completions by default. Use
`DREAMATIC_PROVIDER_TYPE=openai-responses` only for a provider implementing that
protocol. Standard image endpoints are inferred from the image base URL;
nonstandard endpoints can be configured explicitly in `.env.example`.
The image key falls back to the text key when omitted.

Web research uses DuckDuckGo by default. Optional Serper settings, role-specific
models, timeout/concurrency controls and HTML validation settings are documented
in [.env.example](.env.example). Keep API keys out of Git.

## Run and deploy locally

### Development

```bash
npm run dev
```

Open the URL printed by Vite, normally **http://localhost:5173**. The API runs
on **http://localhost:4310**. The command builds the agent and server packages
before starting them; keep the process running while using the workspace.

### Built application

```bash
npm run build
npm start
```

Open **http://localhost:4310** to use the built Web application and API together.
After changing frontend code, rebuild the Web application; after changing runtime
code or Agent tool contracts, restart the server. Building alone does not update
an already running backend.

Both modes load the repository's `.env`. `DREAMATIC_WORKSPACE=./workspace` is
resolved from the repository root. Web and CLI must use the same workspace to
share projects. HTML previews currently use a separate loopback origin; these
instructions cover local deployment, not a public multi-user service.

## Usage

### Web workspace

Click the **Designer** user button at the bottom left, then **Settings**, to
edit the project `.env`. Configuration is grouped into search, reasoning models,
image models and system parameters, with an example for every field. Only changed
fields are saved; blank key inputs retain existing secrets. Model changes apply
to new sessions; server port and workspace changes require a restart.

1. Create a project, enter the brief and add references if needed.
2. Answer clarification questions. The conversation displays the recognized
   design categories and streams agent progress.
3. Inspect references, notes and outputs on the persistent **Canvas**.
4. After the build completes, click **Preview** to display the delivered result.
5. Use **Open** to open the presentation in a new tab, or **Export** to download
   `<run-id>.zip`.

| Result | Preview behavior |
| --- | --- |
| Image design | Displays the image Gallery |
| UX/UI design | Displays the actual designed HTML page with its local interactions |
| Mixed design | Displays the declared HTML entry or Gallery with page links |

HTML previews fit the available width without a Viewport panel; multi-page
results retain a page selector. Designer authors the page; Builder copies its
approved sources and resources without redesigning it. Researcher-discovered
and repository images are reference-only; needed image assets are designed as generation/editing tasks
and produced before the page is assembled. Prototypes use local
logic and assets; real backend integration is separate work.

Export includes built artifacts, HTML sources, resources, design plans, research,
review and project metadata. It preserves relative paths and adds an `index.html`
launcher. Extract the ZIP before opening the launcher or serving the project
locally. Sessions, caches and historical revisions are excluded. Export does not
invoke an agent or regenerate results.

Projects can be reopened, renamed or moved to recoverable local trash. Feedback
on a completed project can start a revision while preserving the previous delivery.

User-provided material: explicitly supplied URLs and uploaded images, videos or
documents can be reused unchanged. `user_asset_import` saves verified originals
under `inputs/user-assets/`; Designer declares their local output mappings and
Builder copies them after approval. Assets linked from a user-supplied page must
be verified against that page. Researcher-discovered material remains reference
only. Upload up to four files (images: 12 MB; other files: 128 MB; 160 MB total); local documents use
download links, and all delivered files are included in Export.

### CLI

Build once before using the CLI:

```bash
npm run build

# Image-based design
npm run cli -- "为一家当代茶品牌设计主视觉和包装系列"

# Interactive HTML interface
npm run cli -- "设计一个响应式中英双语学术主页，包含论文筛选和移动端导航"

# Attach a reference
npm run cli -- --image ./reference.png "保留标志，设计一套发布海报"

# Interactive mode / machine-readable event stream
npm run cli
npm run cli -- --json "设计一个科技展览主视觉"

# Resume after the original process has stopped
npm run cli -- --resume <run-id>
```

## System architecture

DreamaticArt extends **Pi** through its SDK, Extensions, Skills and session APIs.
Pi remains an upstream dependency and provides the agent runtime, providers,
streaming, tools and persistence. DreamaticArt implements design-specific workflow,
contracts, production tools and the product interface.

```text
apps/web                  React + Vite UI, Canvas and Preview
apps/server               HTTP/SSE transport, sessions, assets, preview and download
apps/cli                  Terminal interface to the shared workflow
packages/design-agent     Pi extension, design contracts, Skill management and tools
.pi/agents                Five Agent prompt contracts
.pi/skills                Professional, supporting and output-expression Skills
workspace/runs/<run-id>/   Project files, state, workflow events and sessions
```

The shared **Design Context** indexes project evidence and specifications. An
append-only **Design Bus** records handoffs and lifecycle events. Approval
receipts bind reviewed files to execution; changed inputs require renewed review.

Builder dispatches approved tasks by method: image tools for visual outputs and
`html_generate` for pages. PNG is the default; JPG/JPEG is also supported with
matching file encoding. HTML validation checks approved-source equality and
local resources. Source viewport/interaction checks run before approval when a
browser is available; Builder does not repeat browser or visual/design audits. These checks do not certify aesthetics, engineering feasibility or
user acceptance. Interactive previews use an isolated local origin and
committed-file checks.

## Application examples

Representative design concepts and visual deliverables from DreamaticArt projects.

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

## Development and troubleshooting

```bash
npm run check
npm run build
node --test packages/design-agent/test/*.test.mjs apps/server/test/*.test.mjs apps/web/test/*.test.mjs
```

If a new feature is unavailable after an update, restart the server and refresh
the browser. Resume interrupted work in the existing project to reuse completed
stages. Image requests have bounded retries and body-stall timeouts; successful
outputs are retained when another item fails.

Further details:

- [Architecture](docs/ARCHITECTURE.md)
- [v2.0.3 design and execution contracts](docs/V2.0.3.md)
- [Performance and diagnostics](docs/PERFORMANCE.md)
- [Observed failures and fixes](docs/ACTION_FAILURE_ANALYSIS.md)

## License

[MIT](LICENSE)
