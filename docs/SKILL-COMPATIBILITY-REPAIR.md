# Skill portability and compatibility repair

Date: 2026-10-26

## Analysis and scope

Built-in Skill format is valid, but some reusable instructions still assume a
specific Designer/Builder sequence. Third-party allowed-tools declarations are
mistakenly treated as required dependencies. Pi reads its own explicit-only flag,
but not agents/openai.yaml; application prompt wrapping also prevents native
explicit commands from reaching Pi. Finally, resolving every optional root on
every read couples unrelated file reads to optional source availability.

## Execution plan

1. Move mandatory exhibition process to the Builder prompt. Describe concepts and
   methods independently from SVG, browser or image execution capabilities.
2. Keep allowed-tools as an advisory declaration intersecting host capabilities;
   only dreamatic-requires-tools blocks loading for missing required tools. Adapt
   openai.yaml invocation policy, reject malformed/escaping policy files and warn
   about unverified external dependencies without installing anything.
3. Recognize leading user directives ($name or /skill:name), pass only original
   human requests to selection, and inject matching approved role instructions
   through the public Pi prompt API. Explicit-only methods remain hidden and
   unreadable until selected. Validate hashes/policy and audit explicit reads.
4. Isolate missing optional roots while retaining canonical path boundaries.
5. Add regressions for policies, declarations, isolated failures, explicit
   activation, modified content and real Pi request integration. Run checks/build
   and relevant application regressions; update the usage policy.

## Acceptance

- Reusable Skills no longer mandate Dreamatic role sequencing or extra artifacts.
- Optional unavailable tools do not suppress otherwise usable knowledge.
- Both Pi and openai.yaml explicit-only policies are respected, including when
  they disagree; neither a policy nor a Skill grants new tools.
- A human's leading directives work despite application request wrapping, with
  the same role, source, hash and audit constraints as model-driven reads.
- Removing or replacing an optional directory cannot break unrelated reads or
  silently broaden an approved resource root.

No Skill marketplace, dependency installer, shell executor, new rendering medium,
autocomplete UI or unrelated visual-review pipeline is part of this repair.

## Execution results

Completed all planned repairs on 2026-10-26.

- Updated exhibition knowledge and capability-sensitive descriptions; the
  mandatory curation phase remains in the existing Builder prompt/tool contract.
- Separated advisory allowed-tools declarations from required dependencies.
- Adapted both explicit-only policies, including conflicts, invalid policies,
  canonical source boundaries and policy hashes.
- Added the public-Pi prompt adapter for leading human directives; wired design
  stages and Editor, retained selection across clarification/resume, and disabled
  unchecked native command expansion in application entry points.
- Isolated missing/replaced optional roots and retained source/audit checks.
- Updated Skill policy documentation with syntax and compatibility limits.

Validation:

- 30 Skills pass the bundled skill-creator format validator.
- 12 Skill policy tests pass, including local-model Pi integration.
- Full server regression: 177 tests pass, zero failures. The design pipeline test
  also verifies role-scoped explicit instructions after clarification and resume.
- `npm run check`, `npm run build` and `git diff --check` pass.

No paid model calls were made. Fixtures verify integration behavior, not real-model
selection quality. Other client UI metadata, dependency execution, argument-pattern
permission enforcement and fully versioned reference resources remain outside this
repair; these limits are explicit in SKILL-POLICY.md.
