# Dreamatic

Dreamatic is a professional design-agent workspace built on the Pi Agent
Harness. Pi supplies the model, session, tool-call, skill, compaction, and
extension runtime. Dreamatic supplies the design workflow, visual tools,
artifact model, canvas, and product UI.

## Repository shape

```text
apps/web                 React design workspace
apps/server              Pi SDK host and HTTP streaming API
apps/cli                 One-shot and interactive command-line client
packages/design-agent    Dreamatic Pi extensions and design tools
.pi/skills               Existing Dreamatic workflow and domain skills
workspace                Local runs, assets, and sessions
docs/FRONTEND-DESIGN-SYSTEM.md  UI and responsive interaction contract
docs/REBUILD-PLAN.md      Durable workflow and product rebuild plan
```

## Local development

The Pi SDK is pinned to version `0.85.1`. The local Pi checkout can be used for
upstream inspection, but Dreamatic never imports its source tree or modifies it.

```powershell
Copy-Item .env.example .env
npm install --ignore-scripts
npm run dev
```

Open `http://localhost:5173`. Pi model credentials are read from the normal Pi
configuration. Image generation uses the `DREAMATIC_IMAGE_*` variables.

## Command line

The CLI runs the same `design-primary` persona, Skills, extensions, and output
workspace as the React application. Runs created under that workspace are
indexed by the server and appear as projects in the React sidebar, including
their generated assets and workflow status. The server continuously discovers
new Pi CLI session files and links a Run to the session that created it, so a
CLI-created or interrupted task appears in the Web workspace without restarting
the server.

```powershell
# One task
npm run cli -- "为一家当代茶品牌设计主视觉和包装系列"

# Attach reference images
npm run cli -- --image .\references\logo.png "保留标志，设计一套发布海报"

# Interactive session
npm run cli

# Scriptable NDJSON event stream
npm run cli -- --json "设计一个科技展览主视觉"

# Pipe a long brief
Get-Content .\brief.md | npm run cli --
```

Run `npm link` once from the repository root to install the shorter `dreamatic`
executable globally for the current Node installation.

Both entry points must use the same workspace. By default that is
`<repo>/workspace`; set `DREAMATIC_WORKSPACE` or pass CLI `--workspace` when a
different shared location is required.

## Run state and context

Each design project is a persistent run under `workspace/runs/<run-id>`:

- `plan/*` stores the design plan and optional `progress.json` task list.
- `run-state.json` stores automatic workflow-stage status.
- `bus.jsonl` is the append-only Design Bus used for stage commits and repair
  requests.
- `sessions/<persona>/*` stores resumable Pi child histories per Run and stage.
- `canvas/canvas-state.json` stores world coordinates and camera state.
- `artifacts/*`, `review/*`, and `final/*` store visual outputs and decisions.

Full-resolution image tool results are persisted to the Run. Uploaded references from both CLI
and web are capped at four, validated, and persisted under
`workspace/references/<prompt-scope>`. They are visually present for the first
model pass, then their base64 blocks are removed from active context while the
reloadable paths remain. Only the newest image-bearing tool result stays
visually expanded; older results can be loaded explicitly with `view_image`.
Every model-facing image is converted to a bounded preview (1400 px / 1.2 MB by
default), and the same path or candidate set cannot be loaded twice in one
stage invocation. At stage completion, Dreamatic creates a lightweight
resumable Pi history without image payloads and retains the full history beside
it as a recoverable `.visual-full.bak` file.

Provider retries are durable and scoped to the concrete image operation, so a
failed edit of one artifact cannot consume another artifact's retry budget.
Transient image failures remain visible in the Design Bus without marking the
whole Run interrupted when the stage recovers.

## Current vertical slice

- Create an isolated Pi-backed design session.
- Stream agent text and tool activity to a React workspace.
- Load the existing Dreamatic workflow and domain Skills through Pi.
- Create design runs and exchange workflow bus messages.
- Resume persistent Research, Planner, Designer, and Critic Pi sessions.
- Search and cache sources, discover/download references, and validate the
  research asset manifest.
- Generate images through an OpenAI-compatible image endpoint.
- Return local images to a vision-capable model for visual inspection.
- Lint and browse generated artifacts on a persistent pan/zoom canvas.
- Preview the Run's standalone gallery in Showcase mode.

See `docs/MIGRATION.md` for parity status with the legacy `dev` and `dev-UI`
branches.
