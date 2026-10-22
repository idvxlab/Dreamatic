# Skill discovery and loading

Pi remains responsible for configured resource discovery, name precedence and file
validation. Dreamatic uses its SDK and does not copy its runtime implementation.
Designer discovers installed knowledge with `list_skills` and loads entry files
with `use_skill`. Other roles retain their existing tool permissions. Native Skill
catalog injection is suppressed to avoid conflicting instructions to load through
`read`; referenced resources remain readable relative to the returned base directory.

## Selecting knowledge by need

Names are identifiers returned by discovery, not routing rules. Search descriptions
with `query`, require free-form `metadata.capabilities` tags with `capabilities`, or
filter `metadata.supported_outputs` with `output`. Query terms use case-insensitive
AND substring matching; capability and output filters use case-insensitive exact
matching. The Agent interprets relevance; this is not semantic vector search.

```json
{"output":"html"}
```

```json
{"capabilities":["html-authoring"],"scopeId":"product-concept"}
```

Use the returned name and per-scope load arguments, adding a task-specific rationale.
Optional capability tags require no code registration. Existing Skills without tags
remain discoverable through descriptions and other metadata. Discovery returns
available capability tags and Pi diagnostics, including name collisions.

For example, a newly installed Skill can declare:

```yaml
---
name: studio-pages
description: Author responsive pages to present physical product concepts.
metadata:
  audience: designer
  module_type: execution
  capabilities: [html-authoring, responsive-layout]
  supported_outputs: [html]
---
```

Its name is arbitrary. Add professional `design_categories` and
`module_type: discipline` when it is intended to qualify as primary knowledge.

A scope's category constrains professional primary eligibility. It does not restrict
supporting knowledge: scope discovery includes candidates from other categories.
Explicit `category` filters still narrow the catalog. Skills never grant tool access.

## Bundled knowledge metadata

The repository keeps stable Skill names and paths. Names are used by saved Context
selections, deliverable references and receipts; improve discovery through descriptions
and capabilities before considering a rename.

- `design_categories` lists the professional categories a discipline module can own
  as primary. It does not list every field it could help. Common supporting and
  expression modules declare `[]`. A professional module can retain multiple
  categories when it actually guides their core decisions, such as package structure
  and package graphics, visitor circulation and signage, or explanatory graphics
  and data-centered interfaces.
- `module_type` distinguishes `discipline`, `cross_domain` and `execution` knowledge.
  `execution` describes expression/specification methods; it does not authorize
  Designer to run Builder tools.
- `capabilities` uses non-empty, lowercase hyphenated tags in the bundled library.
  Tags name methods and useful search terms, not installed Skill identities. They
  remain free-form; adding a capability does not require code registration.
- `supported_outputs` lists the core media the method can guide: `image` and/or
  `html`. It describes knowledge, not new production tools. Editorial HTML, a game
  browser prototype and browser motion are intended expressions; an illustration's
  HTML caption or a physical product's showcase container does not by itself make
  that image-focused method an HTML-authoring Skill. No video executor is implied.
- `domain_type` is a descriptive lowercase underscore identifier, not another
  controlled category registry. `version` is an optional knowledge revision label;
  source hashes remain authoritative for loaded-body identity and reuse.

Descriptions identify the main decision, the selection trigger, neighboring
responsibilities and relevant delivery limits. Product framing, industrial
realization, digital product strategy, task interaction and visual UI composition
remain distinct emphases. Their selection-boundary sections explain when to use
each as primary or supporting without inventing additional scopes.

Game, illustration and service knowledge retain their names but no longer qualify
as general UX primaries. They remain available as supporting knowledge in UX scopes.
Existing receipts and files are preserved. A fresh Designer invocation reloads the
current definitions and must choose an eligible UX primary if an earlier selection
used one of these modules in that role; this is a selection correction, not a rename.

Run `npm run check:skills` for the standalone library check. `npm run check` also
checks it after building design-agent. The checker delegates Agent Skills syntax
checks to Pi and adds bundled-library checks for complete directories, matching
identities, metadata, primary categories, non-empty capabilities, supported output
values and local reference existence. There is no fixed Skill-name or capability
whitelist. These build-time requirements do not reject third-party Pi Skills whose
optional metadata is absent. Long references may live inside a Skill's `references/`
directory and be loaded on demand; central source/commit rules remain in the entry.

The incomplete `canvas-html-publishing` configuration and empty `showcase-layout`
directory were removed. Historical release/audit notes retain their original names.
Generated desktop and release copies are rebuilt from the source library; do not
edit their Skill copies independently.

## State and refresh

Discovery uses one invocation-local snapshot of descriptors, paths and diagnostics.
`refresh:true` refreshes it; an unknown name also triggers rediscovery. Loading reads
the current entry, validates current metadata and hashes the complete source. A
changed source invalidates the discovery snapshot for the next lookup.

Selection and knowledge availability are separate. The invocation-local activation
state records both; receipts persist `activeSkills` and `loadedSkills`. Compaction
invalidates loaded bodies and updates the receipt, retaining selections. Commit and
publication require loaded knowledge, so selected Skills must be loaded again.
Historical receipts without `loadedSkills` remain readable. Fresh invocations never
restore knowledge availability from an earlier receipt.

Repeated loads reuse unchanged bodies by source path and hash. A multi-scope call
binds one Skill atomically and returns its body once. Deactivation changes selection;
it does not erase historical messages. Dependencies and referenced files are read on
demand by the Agent; there is no automatic dependency execution.
