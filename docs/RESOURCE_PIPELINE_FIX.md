# Resource pipeline consistency fix

The DreamaticArt minimal homepage Run `project-2026-10-05-a8170a6f` declared
unchanged reuse in its task breakdown while declaring 22 image edits in its
execution plan. Reviewer accepted that major inconsistency as a risk. Approval
checked HTML interactions but omitted the edit fields required by execution.
Builder attempted HTML before its image dependencies, then submitted generative
requests whose changes were “Retain original image without visual modification”.

## Changes

- Designer and HTML workflow instructions distinguish faithful user-material reuse
  from new generation and real edits at the point where resource methods are chosen.
  Each asset's method must agree across plan, task breakdown, manifest and mappings.
- Reviewer traces those documents per asset. Contradictory strategies and pending
  required corrections must fail review; Builder cannot be assigned plan cleanup.
- Blocking/major issues must be resolved before passing, including historical
  approvals whose issues were relabelled accepted_risk. Minor suggestions and
  ordinary conceptual uncertainty remain permitted.
- Approval and execution share the same edit parameter validator. Provenance-only
  reference_ids_or_paths does not replace referenceImagePaths. Pixel sources must
  exist in the Run or have a declared producer dependency. Missing fields fail
  before publication, review or provider requests.
- Explicit unchanged-copy edit instructions are rejected by planned and direct edit
  tooling. This is a targeted check for common copy-only wording, not a general
  semantic proof; Reviewer remains responsible for cross-document intent consistency.
  Valid edits preserving unrelated elements and different methods for different
  assets remain allowed.
- Failed execute_design_plan structured results now count as lifecycle errors,
  matching existing image-batch failure reporting.

## Validation

- The original Run now fails read-only designerDraftReadiness with the exact
  missing pixel-source field; before the fix it returned ok: true.
- TypeScript build and repository type checks.
- Design workflow and user asset tests: 66 pass, 3 browser-dependent tests skipped
  with DREAMATIC_HTML_BROWSER=off. Browser launch is unavailable in the sandbox;
  the initial browser-enabled suite could not complete its fixture approvals.
- Five targeted Builder/extension tests pass, covering persona policies, early
  contract rejection, edit batches, approved execution and output preflight.
- Regressions cover accepted-risk bypass (including authentic historical receipts),
  missing edit parameters/sources, provenance-only references, copy-only edits,
  meaningful edits and unchanged trusted originals.

The original Run is preserved. It requires a Designer correction using trusted
original imports and renewed Reviewer approval, rather than resuming its old
22-edit specification. Running processes must reload the rebuilt extension and
updated persona instructions; this change does not silently restart an active Run.
