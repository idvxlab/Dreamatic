# Skills in Dreamatic

Dreamatic uses Pi's native Skill parser, catalog disclosure and read tool. The
application selects the sources and role visibility; it does not fork the runtime.
Skills supply professional methods. Tool availability, image editing policy,
citation identities and final output formats remain application contracts.

## Built-in roles

| Role | Built-in knowledge |
| --- | --- |
| Orchestrator | No mandatory Skill; task framing and routing stay in its role prompt |
| Researcher | design-research |
| Designer | Professional disciplines, relevant supporting methods, image-prompting and design-review |
| Builder | concept-showcase-storytelling, html-interface, visual-composition, typographic-detail, design-system, accessible-interface, interface-writing and design-review |
| Editor | image-prompting, visual-composition, typographic-detail, design-system and design-review |

`metadata.dreamatic-roles` controls reviewed built-ins. The standard metadata map
contains only strings. `dreamatic-categories` uses the current project taxonomy;
`dreamatic-capabilities` and `dreamatic-outputs` describe knowledge, not executable
permissions. Skills remain automatically discoverable within their approved role.
Pi's `disable-model-invocation: true` and the client extension
`agents/openai.yaml` → `policy.allow_implicit_invocation: false` both mark a Skill
explicit-only. Either restriction wins if the declarations disagree. Malformed,
escaping or dangling policy files reject that source with a diagnostic. Optional
display metadata is not a new UI; dependency declarations generate an unverified
warning and never install packages or connect MCP servers.

Designer produces an image plan; Builder returns a static exhibition. Interactive
product behavior, SVG/procedural authoring and executable prototypes require an
appropriate host and are not implied by the presence of design knowledge. Review
methods do not give a text-only Builder permission to inspect generated pixels.

## Approved third-party knowledge

Use **Settings → System → Approved Skill paths by role (JSON)**, or the matching
`DREAMATIC_SKILL_PATHS` environment setting:

```json
{"designer":["/absolute/path/to/campaign-method"],"researcher":["~/skills/research-method/SKILL.md"]}
```

Each path must name an individual directory containing `SKILL.md`, or that file
itself. Approve individual methods rather than an entire user/project collection.
Supported keys are orchestrator, researcher, designer, builder and editor. An empty
object or removing a path disables that third-party source for future sessions.
Active sessions retain the catalog they started with. No package is downloaded,
installed or enabled by this setting.

Ambient `~/.agents/skills`, user Pi Skills, project `.agents/skills` and run `.pi/skills`
are not application sources. A Pi loader override supplies only the reviewed role
catalog; project trust settings cannot silently expand it. Built-in names are
reserved across roles. Otherwise, the first configured path wins a name collision,
with a diagnostic. A Skill cannot use metadata to expand its configured role scope.

Portable knowledge with readable resources can be used without granting execution.
The experimental `allowed-tools` field describes allowed tools, not a list of
mandatory dependencies. Dreamatic retains the declaration and warns about missing
tools while keeping usable knowledge available. Tool argument patterns such as
`Bash(python:*)` are advisory; this application does not enforce a separate
per-Skill permission sandbox. Host role tools and authorization remain authoritative.
Only `metadata.dreamatic-requires-tools` declares mandatory tool dependencies;
missing required tools hide the Skill with a diagnostic. Neither field creates
permissions. Free-text compatibility
requirements remain unverified declarations, and are logged as such. A Skill without
machine-readable requirements may still describe unavailable Python, browser or MCP
operations: the agent must report those limits rather than pretend execution.

## Explicit user invocation

Begin a human request with `$skill-name` or `/skill:skill-name`, followed by the
task. Multiple directives can precede the task, separated by whitespace:

```text
$campaign-method /skill:design-review Design a launch campaign.
```

Selection uses the original human request, before application prompt wrapping.
It does not scan research, quoted documents, model-produced delegation or arbitrary
mentions later in a sentence. Each role injects only names approved in its own
catalog; a name unavailable in that role is skipped, not granted. A Skill must
already be configured for that role. In a design run, clarification answers and
resume commands retain the most recent leading selection; a new leading selection
replaces it. There is no autocomplete or Skill-selection widget in this repair.

The application prompt adapter loads the full instructions with source and policy
hash validation, records an explicit read, then calls Pi's public prompt API with
native command expansion disabled. Explicit-only Skills are hidden from automatic
disclosure and their entry files cannot be read by the model until the human
selects them. Direct SDK callers must use the returned `prompt` adapter to obtain
these guarantees; calling raw `session.prompt` is not the application entry point.

## Read boundaries and resources

The native reader is scoped to the current run, approved Skill directories and
application role prompts. Canonical paths prevent a reference or symlink from
escaping those roots. Unregistered `SKILL.md` files cannot become knowledge merely
by being placed inside a run. Approved scripts can be read as text, including by
Builder; this does not execute them or add a shell. Builder still rejects image reads.
Skill entry and existing invocation-policy hashes are frozen per catalog; a changed
file requires a new session and validation before instruction loading. Other
references remain live resources, not a fully versioned snapshot. A deleted or
replaced optional directory cannot break unrelated project/built-in reads or
broaden the originally approved resource root.

Skill catalogs are not an operating-system sandbox. Ordinary run documents remain
task evidence, and model instructions do not substitute for host authorization.
Extensions remain disabled and the existing limited tool sets remain in force.

## Diagnostics and evidence

For each agent session:

- `sessions/<role>/skills/skill-catalog-<id>.json` records approved names, paths,
  source type, content hashes, versions, compatibility declarations and diagnostics.
- `sessions/<role>/skills/skill-activations.jsonl` records successful Skill-file reads
  with their catalog ID, session ID, content hash and requested read range.
  `invocation` distinguishes model reads from full explicit instruction loading.

Read records are evidence that the file was read, not proof that a model followed
all instructions or that a complete behavioral evaluation occurred. These records
live below a nested metadata directory so historical Pi transcript discovery does
not mistake them for agent sessions. They contain no provider credentials or Skill
bodies. Missing/invalid sources, same-name collisions and unavailable tools can be
diagnosed from the catalog manifest.

## Validation

Run the Skill policy tests from the repository root after building project-data and
server:

```sh
node --test apps/server/test/skill-policy.test.mjs
```

They check strict metadata, categories, role catalogs, ambient isolation, collision
precedence, tool requirements, resource boundaries, immutable reads and actual Pi
catalog/activation behavior through a local model fixture. The local fixture proves
the integration contract, not real-model choice quality or visual design quality.
