# Skill alignment implementation plan

Date: 2026-10-26

## Scope and invariants

Keep Pi 1.4.0 responsible for parsing, discovery, disclosure and agent sessions.
Dreamatic owns the approved knowledge sources, role policy, diagnostics and audit
records. Keep the current design.md image-plan and static exhibition contracts;
Skills do not add tools or permissions. Do not copy Pi runtime internals.

## 1. Align reusable knowledge

- Convert all metadata values to strings and migrate category IDs to the current
  taxonomy. Namespace Dreamatic routing metadata.
- Keep physical product/industrial and digital product/UX/UI methods separate.
- Replace mandatory interactive HTML, old output paths, per-file write sequences,
  tool names and obsolete edit parameter contracts with medium-aware methods.
- Preserve supplied project citation identities rather than renumbering them.
- Add focused design-research and design-review knowledge. Reuse image-prompting
  for Editor, including reference roles and preservation intent.

Acceptance: native Pi parses every entry; strict format/category checks pass;
no built-in Skill requires a tool or output contract absent from its assigned role.

## 2. Control knowledge sources

- Disable ambient Skill discovery for every application agent.
- Load reviewed built-ins through Pi, with explicit role routing.
- Add per-role approved third-party Skill paths to existing settings; default empty.
- Preserve built-in precedence, report collisions, reject paths escaping approved
  Skill roots and explicit unavailable-tool requirements. Never install dependencies
  or enable Extensions based on Skill content.
- Restrict native read tools to the run, approved Skill resources and role prompts.

Acceptance: user/project ambient skills cannot shadow built-ins; approved read-only
knowledge works; a Skill cannot grant tools or escape its resource directories.

## 3. Wire roles and traceability

- Researcher receives research methods; Designer receives domain/planning knowledge;
  Builder receives exhibition, static HTML and relevant presentation methods;
  Editor receives image specification and review methods.
- Persist role catalog manifests with sources, versions, hashes and diagnostics.
- Record successful Skill-file reads with the actual content digest and session ID.
- Keep visual-review limitations explicit: a text-only role cannot certify image quality.

Acceptance: supplied Skills are discoverable and readable in real Pi sessions;
activation evidence and blocked dependency/collision diagnostics survive reload.

## 4. Validation and regression

- Test strict metadata, role catalogs, collisions, trust independence, symlink
  boundaries, missing tools, resources and explicit third-party paths.
- Use local model fixtures to verify actual discovery/read activation and role output
  contracts without paid provider calls.
- Run project checks/build and relevant server/browser regressions.

No new installation marketplace or automatic third-party execution is part of this
change. Read-only method compatibility and executable workflow compatibility remain
separate. Real-model selection quality is a documented validation limit.

## Execution results

Completed on 2026-10-26. All four phases are implemented.

| Phase | Delivered |
| --- | --- |
| Knowledge | Standardized 28 existing Skills and added design-research and design-review; corrected medium, citation and Editor contract conflicts. |
| Sources | Added per-role approved paths, disabled ambient discovery, preserved built-in precedence and restricted knowledge reads. |
| Roles and traceability | Connected role catalogs through public Pi APIs; persisted source/version/hash diagnostics and successful Skill-read records. |
| Validation | Verified format, source boundaries, role routing, actual Pi session integration and existing application regressions. |

Validation results:

- All 30 Skills pass the bundled skill-creator format validator.
- `npm run check` and `npm run build` pass.
- Server regression: 171 tests pass, zero failures.
- Browser regression: 17 tests pass, zero failures.
- `git diff --check` passes.

Pi integration uses a local model fixture; no paid provider calls were made.
These checks establish loading, disclosure, reading and policy behavior, but do
not establish real-model selection quality or visual design quality. Skill-read
records establish access, not that the model followed every instruction.
Third-party executable workflows still require independently available tools;
approved Skill paths do not install dependencies or grant capabilities.

Configuration, role coverage and audit paths are documented in
[SKILL-POLICY.md](SKILL-POLICY.md).
