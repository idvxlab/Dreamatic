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
- Orchestrator owns routing, state, gates, and bounded loops.
- Builder executes only an approved Design Context.
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
See [v2.0.3 contracts and Skill mapping](V2.0.3.md) for ownership, compatibility,
output contracts and extension points.
