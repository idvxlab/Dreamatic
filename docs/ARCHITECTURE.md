# Architecture

## Dependency rule

DreamaticArt depends on Pi. Pi does not depend on DreamaticArt, and DreamaticArt does not
modify Pi internals. Integration happens through `createAgentSession`,
`DefaultResourceLoader`, and extension factories.

## Runtime trace

```text
React workspace
  -> POST /api/sessions/:id/messages (NDJSON stream)
  -> Dreamatic session registry
  -> Pi AgentSession
  -> Dreamatic extension tools
  -> workspace/runs/<run-id>/...
  -> asset API
  -> React canvas
```

The CLI enters at the shared session factory instead of the HTTP server:

```text
dreamatic CLI
  -> createDreamaticSession
  -> the same Orchestrator persona, runtime contracts, tools, and Pi AgentSession
  -> workspace/runs and workspace/sessions/cli
```

## Agent architecture

```text
User -> Orchestrator -> Researcher -> Designer -> Reviewer
                                  Designer <- issues
                    approved Design Context -> Builder -> Product
```

- Agents reason.
- Design Context remembers through durable Run files.
- Orchestrator routes work and bounded loops through runtime lifecycle tools.
- Runtime persists state and enforces ownership, approval and execution gates.
- Builder executes approved deliverables and owns their Gallery presentation;
  Designer owns deliverable HTML page design.
- Reviewer challenges Designer's proposal and never becomes a second Designer.

## Ownership

- Pi owns provider calls, conversation state, tool-call protocol, context
  compaction, session persistence, Skills discovery, and extension lifecycle.
- DreamaticArt owns design runs, media generation jobs, visual review semantics,
  artifact manifests, workflow messages, and the design workspace.
- The frontend never imports Pi packages. It consumes a stable DreamaticArt API.

## Runtime dependency choice

The first implementation uses the mature coding-agent SDK rather than Pi's
experimental server/client coordinator. The API boundary allows replacing the
host later without rewriting the React application.

## Scoped knowledge and typed delivery (v2.0.3)

Orchestrator assigns design categories and task scopes. Designer discovers and
activates appropriate Pi Skills per scope, then produces image plans or complete
HTML page sources. Reviewer approves that specification; Builder mechanically
dispatches approved image/HTML tasks. Existing image execution is retained.
HTML pages can be the presentation themselves; mixed Galleries link the pages.
The server serves interactive previews on an isolated committed-file origin.
See [Design Context](DESIGN-CONTEXT.md) for current authoring and approval contracts,
and [v2.0.3](V2.0.3.md) for the versioned execution and Skill mapping background.

## Unified Design Context

New Runs use four authoritative documents under `context/`: runtime-owned project
metadata and specialist-authored research, design and review. Execution and UI
report views derive from those documents in memory;
new Runs never persist the old research/plan/review Context files.
Legacy Runs retain their storage and approval contracts. See
[Design Context](DESIGN-CONTEXT.md) for schema, ownership, derived reports,
revision/hash rules and recovery behavior.

New Runs pin design contract v2 in Brief. One authored deliverable owns identity,
scope, output, production/user-access obligations and nested execution; task views
are derived. Scoped Skill bindings are independent of invocation-local body loading.
Structure, source preflight, final real-asset validation and user acceptance remain
separate evidence. Presentation and interaction obligations gate publication,
review, finalization and export; Reviewer severity cannot waive them. Explicit
completed-Run revision upgrades create converted drafts behind archived receipts.
