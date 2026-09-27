# Architecture

## Dependency rule

Dreamatic depends on Pi. Pi does not depend on Dreamatic, and Dreamatic does not
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
  -> the same design-primary persona, Skills, tools, and Pi AgentSession
  -> workspace/runs and workspace/sessions/cli
```

## Ownership

- Pi owns provider calls, conversation state, tool-call protocol, context
  compaction, session persistence, Skills discovery, and extension lifecycle.
- Dreamatic owns design runs, media generation jobs, visual review semantics,
  artifact manifests, workflow messages, and the design workspace.
- The frontend never imports Pi packages. It consumes a stable Dreamatic API.

## Initial compatibility choice

The first implementation uses the mature coding-agent SDK rather than Pi's
experimental server/client coordinator. The API boundary allows replacing the
host later without rewriting the React application.
