# Legacy parity matrix

Historical migration checklist for the union of Atelier's `dev` and `dev-UI`
branches. Checkmarks record migration milestones, not current role permissions or
workflow instructions. See [Architecture](ARCHITECTURE.md) and
[Unified Design Context](DESIGN-CONTEXT.md) for current contracts.

Current visual policy: Designer inspects reference images; Builder performs
approved one-pass execution without generated-image comparison, selection or
post-generation visual audits. Historical compare/selection tool implementations
do not grant any active role permission to use them. Generated outputs are passed
as persisted paths and metadata, not returned for a second visual approval loop.

## Runtime delegated to Pi

- [x] Model providers and multimodal message protocol
- [x] Tool-call loop, cancellation, event streaming, and compaction
- [x] Skill discovery and progressive loading
- [x] Session storage and branching foundation
- [x] Extension lifecycle

## `dev` visual and reliability work

- [x] Image messages accepted by the API
- [x] Vision inspection through `view_image`
- [x] Tool output is streamed to the UI
- [ ] Recovery tests for every DreamaticArt media tool
- [x] Dedicated visual compare tool for two or more artifacts
- [x] Generated and edited images return directly to the model for inspection
- [x] Run-scoped artifact selection with persisted rationale and risks
- [ ] Port legacy web search/fetch policy where Pi extensions do not cover it

## `dev-UI` product work

- [x] React application shell replaces the single large HTML file
- [x] Session list, prompt composer, tool timeline, asset rail, and canvas
- [x] Generated assets served from the active workspace
- [x] Persist canvas positions and zoom per project
- [x] Preview existing workflow gallery HTML in Showcase mode
- [ ] Agent-authored HTML composition publishing from user-edited canvas state
- [ ] Full asset upload/edit flow
- [ ] Video generation panel and job progress
- [ ] 3D preview and Hunyuan3D adapter

## Runtime entry points

- [x] React design workspace
- [x] HTTP streaming API
- [x] One-shot CLI tasks
- [x] Interactive CLI sessions
- [x] Reference-image attachments and NDJSON event output in CLI
- [x] CLI-created runs indexed and displayed as React projects
- [x] Resume a CLI conversation from its project in the React application

## Context and run state

- [x] Keep only the newest generated visual observation in active model context
- [x] Persist automatic multi-stage status in `run-state.json`
- [x] Persist optional operational todos in `plan/progress.json`
- [x] Persist uploaded references as paths and prune their base64 message blocks
- [ ] Avoid retaining full image payloads in durable Pi session history

## Existing DreamaticArt workflow

- [x] Optional Designer domain and craft Skills maintained in `.pi/skills`
- [x] Default design-agent system instructions
- [x] Design run and workflow bus tools
- [x] OpenAI-compatible image generation
- [x] Basic artifact lint and inventory
- [x] Image edit adapter
- [x] Research search/fetch and asset discovery/download/validation adapters
- [ ] Exact legacy artifact-manifest and gallery contracts
- [x] Persona/subagent adapter matching the current five design roles
- [x] Self-contained final package export

## Design contract v2

New Run initialization pins `designContractVersion: 2`. Existing unified/split-file
Runs retain their version. An explicit completed unified Run revision can request
`upgradeDesignContract:true`; conversion is checked before opening the revision,
then a v2 draft is created against the original canonical hash after archival.
Archived delivery/receipts and current canonical bytes stay unchanged until Designer
reconciles and commits. New approval and build are mandatory. Split-file upgrades
are rejected before archival; ordinary reads/revisions never migrate data.
