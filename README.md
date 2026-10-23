# Dreamatic

Dreamatic is being prepared for a system redesign. The previous agent runtime,
role instructions, tools and workflow contracts have been removed. A replacement
agent architecture is outside this change.

This repository is **Dreamatic**. DreamaticMake and DreamaticWeb are separate
projects. Nothing in this preparation changes those repositories.

## Retained application

- Existing React pages, layout, visual styling, interactions, Canvas and Settings.
- Existing `.env` configuration, environment variables, field definitions, secret
  handling and `GET /api/config` / `PUT /api/config` response contracts.
- Configuration validation, hot application, workspace switching, port switching
  and rollback when a requested port is unavailable.
- Project management, historical session/workflow display, assets, Canvas storage,
  isolated previews, export and publication transport.
- Reusable design knowledge in `.pi/skills` and its source attribution.

Design execution is temporarily unavailable. Sending a task returns HTTP 503 with
`code: "AGENT_RUNTIME_UNAVAILABLE"` before changing project files. The CLI reports
that execution is unavailable and exits with status 1; `--help` exits normally.
Historical model and role configuration fields remain available for compatibility;
saving them does not activate an agent.

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

Pi remains an upstream dependency for reading historical session files. The server
never creates Pi AgentSession instances or loads extensions/role instructions.

See [reconstruction preparation](docs/REFACTOR-PREPARATION.md) for the retained
boundaries, removal scope, latest cleanup audit and configuration integration requirements.
