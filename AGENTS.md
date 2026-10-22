# Dreamatic development rules

Dreamatic is being prepared for redesign. The previous agent implementation has
been removed. Pi remains an upstream dependency for historical session reading.
Do not copy or fork Pi runtime internals into this repo.

## Boundaries

- `apps/web`: React product UI and canvas only.
- `apps/server`: transport, session registry, assets, and application policy.
- `packages/project-data`: configuration validation and historical project display/export helpers; no agent execution.
- `.pi/skills`: reusable design knowledge; no old runtime tool contracts.
- `workspace`: runtime output; never commit generated runs.

Prefer Pi SDK, Extensions, Skills, sessions, providers, and tool contracts over
new infrastructure. Domain-specific image, video, 3D, artifact, and design-run
semantics belong to Dreamatic.

