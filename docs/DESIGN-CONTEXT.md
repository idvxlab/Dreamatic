# Design Context contract

Pi remains the upstream runtime. Dreamatic owns the domain schema, authoring
validation, workflow gates and delivery evidence.

New Runs keep unified storage (`contextFormat: "unified-v1"`) and pin
`brief.designContractVersion: 2`. This format label describes file organization;
it does not imply that the design document is version 1. Research, review and
project documents retain schemaVersion 1; new design documents use schemaVersion 2.
Historical Runs retain their original storage and design versions. Reading, opening
or ordinary revision does not migrate them or rewrite completion receipts.

## Ownership and authoring

| Document | Writer | Domain fields |
| --- | --- | --- |
| `context/project.json` | Runtime | `brief`: original request, confirmed requirements, scopes, version, revision request |
| `context/research.json` | Researcher | `evidence`, `findings`, `usageConditions` |
| `context/design.json` | Designer | `system`, `strategy`, `deliverables`, `presentation`, optional `acceptanceNotes`, `executionNotes` |
| `context/review.json` | Reviewer | `assessment`, optional `intentCoverage` |

The runtime owns `runId`, `schemaVersion`, positive `revision` and Skill receipts.
Authors use `update_design_context({changes:{...named fields}})` followed by
`commit_design_context({})`. Native file tools, generic JSON tools and retired split
files cannot write canonical Context. Research acquisition manifests remain tool-owned.

Orchestrator exposes only ask_user, todo_write, run_init, run_brief_update,
run_revision, spawn_agent, design_bus_read, design_context_read and export_package.
It has no native file tools, structured file writers or event publication tool.
Runtime persists coordination records; specialists publish their own completion.
Coordinator prompts and reads use only the current Context contract. A task without
canonical Context requires explicit migration before dispatch. Handoffs containing
retired report paths or file-authoring tools are rejected before a specialist starts,
so the coordinator receives the correction instead of retaining a false output path.

Designer system fields (`system_thesis`, `palette`, `typography`,
`consistency_rules`, `asset_rules`, `consistency_anchor`, `prohibited`) belong inside
`changes.system`; creative strategy belongs inside `changes.strategy`. Updates
omit Run identity, paths and version metadata. Preparation can relocate a declared
system field with a unique owner without changing its value; duplicate/conflicting
placements and unknown fields are rejected rather than guessed.

Objects merge by field. Ordinary arrays replace when supplied; omitted fields stay.
Designer deliverables upsert by stable id. `removeDeliverables` removes complete
items; `replaceDeliverables` replaces the entire collection with full items and
cannot combine with upserts/removals. `[]` clears a collection. `unsetFields` removes
optional fields locally, without JSON pointers. Protected/required fields cannot be
unset. `changes:{}` inspects work without writing.

Updates save an editable working draft, not canonical content. Runtime serializes
updates, observes canonical/draft hashes and rejects unnoticed concurrent changes.
Fresh invocations read before resuming retained work. To discard work, first read
complete `canonical:true`, then explicitly update with `reset:true`. Changed canonical
content cannot be overwritten using a stale draft. Commits are atomic; failures retain
work. Idempotent commits do not increment revision. Three repeated identical field/
payload failures stop the invocation; changing unrelated prose does not reset them.

## One authored deliverable

```json
{
  "id": "cutaway",
  "scope_id": "concept",
  "skill_refs": ["industrial-design", "image-prompting"],
  "kind": "image",
  "purpose": "Explain the internal mechanism",
  "acceptance_test": "Recognizable cutaway and preserved silhouette",
  "file": "artifacts/cutaway.png",
  "required": true,
  "user_requested": true,
  "presentation": {"required": true, "access": "embed"},
  "execution": {
    "method": "image_generate",
    "prompt_seed": "Actual approved design prompt",
    "negative_prompt_seed": "Actual exclusions",
    "size": "1024x1024",
    "size_rationale": "Mechanism detail needs this resolution"
  }
}
```

Identity, scope, category, output path and Skill references belong only to the
deliverable. Runtime infers an omitted category from its assigned scope; conflicting
explicit categories are errors. `execution` owns method and method-specific parameters.
There is no authored `tasks` array in v2 and no repeated execution id/scope/category.

An HTML deliverable's execution contains approved `files` mappings, local external
`resources` mappings, `uses:["other-deliverable-id"]`, interaction requirements,
checks and viewports. Runtime derives producer dependencies and artifact resource
mappings from `uses`; invalid/self references fail. Existing explicit resource aliases
remain usable. Reference assets and imported originals retain their own provenance.
HTML/CSS/JS/SVG source design belongs to Designer; Builder copies approved bytes.

Read-only execution/manifest views are derived in memory for existing Dreamatic
executors. They are not split files or a second authored source. An output shared
across disciplines has one owner plus `contributing_scopes`, each with its actual
scope/Skills/purpose. Non-UX scopes do not automatically require image generation;
coverage follows the requested design contribution. UX continues to require HTML.

## Production and presentation are separate obligations

`required` means the file must be produced. `presentation.required` means users
must be able to access it from the presentation entry at applicable viewports.
`access` is `embed`, `link` or `download`. User-requested outputs require both
production and presentation access. Internal/supporting outputs may omit presentation
only with an explicit rationale. A copied file or a source reference alone does not
prove access: hidden elements and unreachable pages fail rendered coverage.

The same browser validator supports Designer source preflight, Reviewer approval,
Builder finalization and export. Source preflight uses temporary private image
placeholders; no placeholder is written into Run artifacts. Final checks use real
assets, approved source hashes and image execution fingerprints. Reviewer severity
and accepted risks cannot waive objective production/access/interaction failures.

## Interaction checks

Executable flows have a single representation in `execution.interaction_checks`:

```json
{
  "name": "Mobile navigation",
  "viewport": {"max_width": 768},
  "steps": [
    {"action":"click","selector":"#navToggle"},
    {"action":"click","selector":"a[href='#mechanism']"},
    {"action":"expect_url","value":"#mechanism"},
    {"action":"expect_hidden","selector":"#navLinks"}
  ]
}
```

Optional interaction_requirements record descriptive design intent; they do not
require a duplicate assertion list, matching ids or identical steps. The prior
mandatory requirement/outcome protocol created two competing copies of every test
and is no longer an executable gate. Static content and native anchor links need
no handcrafted test matrix. Browser validation directly checks that local anchor
targets exist, and executes authored checks for consequential scripted flows.
The model-visible schema describes names, steps, actions, selectors, values and
viewport bounds; malformed v2 fields are rejected before draft storage.

Supported actions are click/fill/press and expect_visible/expect_hidden/expect_text/
expect_value/expect_url/expect_in_viewport. Visibility is different from scroll target
position: navigation should use URL or viewport assertions. Viewport bounds belong
on the whole check; step-level bounds are rejected. Each flow starts from its page;
assertions can declare any/all/unique matching where supported.

## Scoped Skill loading

Designer chooses professional/supporting knowledge through `use_skill` with a
specific rationale. A primary replaces only the primary in its scope. One call may
load a Skill once and bind it to multiple scopes:

```json
{"name":"image-prompting","bindings":[
  {"scopeId":"concept","role":"supporting","rationale":"Mechanism imagery"},
  {"scopeId":"communication","role":"supporting","rationale":"Explain structure"}
]}
```

All bindings validate before selection changes; failed persistence restores activation
state. The body is returned once, reused within the invocation, and loaded again in a
fresh invocation. Bindings and body-loading state are separate. Legacy single-scope
arguments remain supported. Stored receipts never prove knowledge loaded in the current
invocation. Builder may load presentation Skills; it cannot change Designer selections.

## Reads, readiness and completion

`design_context_read` provides compact summaries and complete expansion calls.
Cross-role details use `paths:["context/design.json"]` and
`select:{section:"deliverables",ids:["actual-id"]}`. `select:{section:"tasks"}`
returns derived task details in v2 and authored task details in historical v1.
Selections are read-only and do not observe another role's working draft.
Top-level section/ids/canonical select only the bound author's own work; `full:true`
expands a complete file. Bound specialists may omit runId for runtime injection;
foreign explicit ids still fail. No fallback to retired Context files is needed.

Structural readiness is separate from executable validation. Update readiness diagnoses
HTML parameter structure before commit. Publication validates actual Designer sources;
`design_context_validate` is optional for targeted diagnostics, not a required extra
round trip after every commit. Interaction checks are the single executable assertion
format; optional interaction_requirements are descriptive notes. Gallery access is
validated after Builder creates Gallery, never against a missing Gallery during source preview. Cache fingerprints bind contract, sources, browser and loaded runtime;
changed bytes invalidate source evidence. Designer publishes design_spec_ready or
design_revision_ready, Reviewer publishes design_review_pass/fail, Builder's
build_finalize publishes build_done, and Orchestrator exports. Commits alone do not
publish completion or approve a design. Required unavailable browser checks return
runtime-owned blocks, not a pass. Evidence does not certify visual quality, engineering
feasibility or user acceptance.

## Historical compatibility and explicit upgrade

Historical unified v1 retains authored `tasks` plus `deliverables` and its existing
schema. Historical split-file Runs retain their original files and validated readers.
An explicit `run_revision({...,upgradeDesignContract:true})` archives a completed
unified Run before creating a converted v2 working draft. Its canonical specification
and archived receipts remain unchanged until Designer reconciles and commits a new
revision. Converted interaction goals require semantic review; they do not become
verified merely through conversion. Split-file upgrade is rejected before opening a
revision. Active Run versions remain fixed; there is no silent migration on read.


### Designer authoring boundary

Designer uses named Context updates and commits, with read/write/ls retained for
page sources and supporting assets. Its role excludes write_json, patch_json and
full-save/pointer authoring tools. MD, shared instructions and supporting Skills
do not teach split-file persistence. Managed sessions register only this tool set,
restore it before each turn, and block calls outside it. Starting Designer on a
split-file Run requires explicit migration; dispatch preserves the existing data.


### Reviewer authoring boundary

Reviewer exposes six tools: read, design_context_read, update_design_context,
commit_design_context, design_bus_read and design_bus_post. It reads design inputs
and exact page sources, authors assessment/intentCoverage through named Context
updates, commits, and publishes the matching review verdict. It cannot write
separate reports, change specifications/sources, load Skills or perform production.
Managed registration and per-turn permissions enforce this boundary. Starting it
on a split-file Run requires explicit migration and preserves existing data.


### Builder execution boundary

Builder exposes twelve capabilities: Context/Bus reads, native presentation
read/write/edit/ls, presentation Skill discovery/loading, execute_design_plan,
html_generate, showcase_template and build_finalize. It cannot author Context,
use JSON report tools or restate image-generation/edit parameters. The stored-plan
executor retains its internal image scheduling, generation, editing and reuse
implementation; removing agent-facing raw tools does not remove production.

Managed registration, per-turn restoration and call guards enforce the role.
Gallery/manual presentation retains native write/edit, while pure generated HTML
remains read-only on every turn. Split-file dispatch requires explicit migration
without changing existing output data.
