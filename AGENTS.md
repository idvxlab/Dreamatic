# Dreamatic development rules

Dreamatic is a professional design-agent system built on Pi. Pi remains an
upstream dependency. Do not copy or fork Pi runtime internals into this repo.

## Boundaries

- `apps/web`: React product UI and canvas only.
- `apps/server`: transport, session registry, assets, and application policy.
- `packages/design-agent`: Dreamatic extensions, design tools, and workflow adapters.
- `.pi/skills`: design knowledge and workflow instructions.
- `workspace`: runtime output; never commit generated runs.

Prefer Pi SDK, Extensions, Skills, sessions, providers, and tool contracts over
new infrastructure. Domain-specific image, video, 3D, artifact, and design-run
semantics belong to Dreamatic.

