# Unified Design Context

New Runs use `unified-v1`. Existing Runs retain their original split-file contract;
opening or revising them does not silently rewrite their specifications or receipts.
Pi remains the upstream runtime. This storage contract belongs to Dreamatic.

## Authoritative documents

| Path | Writer | Content |
| --- | --- | --- |
| `context/project.json` | Runtime | Original request, resolved brief, design scopes, configuration and revision request in `brief` |
| `context/research.json` | Researcher | `evidence`, `findings`, `usageConditions` |
| `context/design.json` | Designer | `system`, `strategy`, `tasks`, `deliverables`, `presentation`, optional `acceptanceNotes` / `executionNotes` |
| `context/review.json` | Reviewer | `assessment`, optional `intentCoverage` |

Each document has `schemaVersion: 1`, assigned `runId`, and positive integer
`revision`. Increment revision on every save/patch. This schema version describes
storage, independently of the existing execution contract's schema version 2.
Use `write_json` or `patch_json`; native write/edit cannot maintain these files.
`patch_json` requires the SHA-256 of the complete canonical file, even when a
compact read omits parts of its content.

The envelope uses camelCase. Embedded `system`, `strategy`, `evidence` and
`assessment` preserve existing domain field names and content requirements for
compatibility; they are not a second schema invented by each Agent. The runtime
injects the authoring contract from `src/context-model.ts`, the shared mapping and
projection implementation. Existing semantic and execution validators still apply.

## Design example

```json
{
  "schemaVersion": 1,
  "runId": "example",
  "revision": 1,
  "system": {
    "system_thesis": "A coherent visual identity",
    "palette": {},
    "typography": {}
  },
  "strategy": {
    "design_intent": "Communicate the brand concept",
    "decisions": [],
    "skill_selection": []
  },
  "tasks": [{
    "id": "hero",
    "method": "image_generate",
    "prompt_seed": "Complete approved image specification",
    "negative_prompt_seed": "Watermark",
    "size": "1024x1024",
    "size_rationale": "Square concept view",
    "dependencies": []
  }],
  "deliverables": [{
    "id": "hero",
    "kind": "image",
    "purpose": "Brand overview",
    "acceptance_test": "Required brand elements are represented",
    "required": true,
    "file": "artifacts/hero.png"
  }],
  "presentation": {
    "mode": "gallery",
    "entry": "artifacts/00-gallery.html"
  }
}
```

Add scope/category/Skill associations as required by the assigned scopes. A
manual deliverable has a matching `{id, method: "manual"}` task. Non-manual task
IDs match deliverable IDs. Production method and size live only in tasks;
deliverables cannot duplicate them. The runtime derives their execution-adapter
fields, preserving prompts, dimensions and source mappings exactly. Strategy
cannot redeclare tasks, delivery lists or other root-owned fields.

HTML source files remain under `plan/html/` to preserve path safety, approved
source hashing and mechanical execution. Source files and binary assets are
references, not embedded into context JSON.

## Execution and reports without legacy files

Unified Runs never generate the ten old research/plan/review Context files.
`readRunContext` is the shared, format-aware internal reader: it reads canonical
JSON and derives execution data or report text in memory. Existing domain
validators and executors use those views without changing task prompts, image
sizes, dependencies, resource safety, Skills or approval rules. Legacy Runs
retain their physical-file contract and aliases. New Runs never fall back to
stale split files if a canonical document is missing or malformed.

`contextProjections` names the pure in-memory conversion, not filesystem outputs.
`saveContextDocument` validates the model and atomically replaces the canonical
file. `brief.json` remains runtime metadata for project/session discovery and is
synchronized with `context/project.json`; it is not an Agent-authored report.
Tool-owned manifests, assets and execution receipts remain separate files.

Stage completion receipts seal canonical project/research/design/review documents
as applicable, Skill receipts and source files. Recovery fingerprints use the
canonical design and its source files. Canonical edits after approval invalidate
execution. The persistent format marker prevents missing context/project.json
from downgrading a Run to legacy mode. Revision snapshots archive context/ and
revoke prior approval. Existing legacy files are not automatically deleted:
historical approvals and projects remain readable, and stale files in unified
Runs are ignored and omitted from newly copied export packages. A pre-change unified approval that lacks the new canonical
receipt inputs must be republished and reviewed before execution.

Product notes render research findings, task rationale and assessment from
canonical documents on demand and link to their canonical JSON paths. No second
Markdown report is persisted. Format-specific specialist prompts and the unified
output protocol specify the canonical schema. Native reads/writes of retired
Context paths are rejected in unified Runs.

## Read views and external records

`design-context.json` remains a runtime-owned index. For unified Runs its sections
are project, research, design, review, resources and implementation, without
repeated component/decision pointers. `design_context_read` returns canonical
role-specific files by default, their hashes and omission markers. Retired
adapter paths are unavailable to Agents, including explicit targeted reads. Legacy Runs keep
their existing read behavior.

Tool-owned asset manifests, import receipts, execution state/events, actual
artifact manifests and binary files retain their independent authority. The
project context is synchronized by runtime initialization/revision and server
project metadata updates. This change consolidates storage; it does not yet
implement a new intent negotiation UI, semantic dependency graph, or automatic
proof of aesthetic quality.

## Validation and recovery

Canonical writes reject unexpected root fields and missing required nested fields
before replacing the existing document. Review state lives entirely under
`assessment`: review_stage, verdict, round, summary, scores, issues,
resolved_issue_ids and remaining_risks. `assessment` is not the score object.
A failed assessment needs an open issue; a passed assessment cannot contain
unresolved blocking/major issues. Classified design saves also validate actual
scope/category/Skill associations for the current specialist invocation.

Unified specialist prompts exclude legacy persistence instructions. Context reads
and handoffs include illustrative nesting examples; these are not evidence,
design recommendations or approvals. Patches use an actual array of pointer/value
objects and increase /revision in the same operation. Error feedback names
canonical documents and JSON pointers. Three identical Context errors in an
invocation return a blocking diagnosis to Orchestrator; unrelated acquisition or
network errors do not activate this guard. Correct the named fields and dispatch
a repair task instead of retrying the unchanged completion envelope. Existing
invalid documents remain readable through canonical Context reads for repair;
execution and publication never accept them as valid approvals.
