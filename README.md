# Dreamatic

Dreamatic turns design briefs into image-based design work through Pi 1.4.0 and
four stages: Orchestrator → Researcher → Designer → Builder. Design context is
handed over in Markdown; the existing UI, Settings and historical project readers
remain available.

## Retained application

- Existing React pages, layout, visual styling, interactions, Canvas and Settings.
- Existing `.env` configuration, environment variables, field definitions, secret
  handling and `GET /api/config` / `PUT /api/config` response contracts.
- Configuration validation, hot application, workspace switching, port switching
  and rollback when a requested port is unavailable.
- Project management, historical session/workflow display, assets, Canvas storage,
  isolated previews, export and publication transport.
- Reusable design knowledge in `.pi/skills` and its source attribution.

The server streams design execution through the existing messages endpoint.
Each role uses its own configured model. Interrupted tasks can resume through
Continue workflow, reusing valid stages and generated images. The CLI execution
entrypoint remains unavailable; use the web or desktop application.

See [pipeline configuration and limitations](apps/server/DESIGN-PIPELINE.md).

## Development

Use Node.js 22.19 or newer and install locked dependencies:

```sh
npm ci
npm run check
npm run build
npm run dev
```

For the built application, use `npm start`. The default API and built frontend are
served at port 4310; the development frontend uses port 5173.

| Directory | Responsibility |
| --- | --- |
| `apps/web` | Existing React UI and Canvas |
| `apps/server` | HTTP transport, configuration, project/session records, assets |
| `apps/cli` | Explicit unavailable execution entrypoint |
| `apps/desktop` | Existing desktop shell |
| `packages/project-data` | Shared configuration validation and historical data readers/display helpers |
| `.pi/skills` | Reusable design knowledge |
| `workspace` | Runtime data; do not commit generated output |

Pi provides AgentSession, model runtime, tools and Skill discovery. Dreamatic owns
design policy, image generation, checkpoints and artifact delivery.

See [reconstruction preparation](docs/REFACTOR-PREPARATION.md) for the retained
boundaries, removal scope, latest cleanup audit and configuration integration requirements.
