---
name: html-interface
description: "Express project showcases and approved UX/UI design as complete responsive HTML, CSS and local JavaScript with explicit resources and interaction checks. Supporting knowledge for page delivery."
metadata:
  audience: designer
  domain_type: html_interface_expression
  design_categories: []
  module_type: execution
  supported_outputs: [html]
---

# HTML Interface Expression

Translate the selected design into complete responsive HTML/CSS/local JavaScript.
Designer authors sources; Builder materializes approved files without redesign.
Every project has one required HTML entry. An existing product page can be that
entry; this Skill does not require extra pages, scopes or a fixed section count.

## Author complete sources

Write under `plan/html/<scope-id>/`, with `path` before `content`. For substantial
pages, use a small HTML entry linking local CSS and JavaScript; move repeated
content or diagrams into local modules/data rendered by that JavaScript, without fetch.
Save one complete file per response, retaining successful files as checkpoints.
Keep small pages simple; this is source organization, not extra pages or reduced coverage.
After truncation, split the failed source before retrying. Do not append incomplete
markup, rely on unsaved streamed code, or resend the entire page merely shortened.
Map every local module in the page's `execution.files` and resolve links from outputs.
Use semantic markup, realistic copy, accessible controls, visible focus and
responsive relationships. Implement relevant navigation, states and recovery with
local state or mock data; record real integrations as unresolved dependencies.

For showcases, shape the story around actual work with meaningful captions and
inspectable full/detail views. Preserve image proportions. Keep prompts, generation
logs and invented technical claims out of visitor-facing copy.

Use local assets and native browser features. Remote embedded scripts, styles,
fonts, network requests, iframe, eval, service workers and base elements are
unsupported. Use system fonts and local constants instead of fetch; prevent local
forms from submitting. Ordinary navigation and evidence links may use HTTPS,
mailto, tel, query or hash URLs.

## Declare the current deliverable

Author `deliverables` through `update_design_context({changes:{...}})`. Identity,
scope, file, purpose and acceptance belong on the deliverable. Put method, source
mappings, resources, producer references, viewports and checks inside `execution`.
Use the exact assigned scope id and actually loaded Skill names.

```json
{
  "id": "project-page", "scope_id": "actual-owning-scope",
  "skill_refs": ["loaded-professional-skill", "html-interface"],
  "kind": "html_page", "file": "artifacts/project/index.html",
  "purpose": "Present the project", "acceptance_test": "Required works are accessible",
  "required": true, "user_requested": false,
  "presentation": {"required": true, "access": "embed"},
  "execution": {
    "method": "html_generate",
    "files": [{"source": "plan/html/actual-owning-scope/index.html", "output": "artifacts/project/index.html"}],
    "uses": [], "resources": [],
    "viewports": [{"width": 1440, "height": 900}, {"width": 390, "height": 844}],
    "interaction_checks": []
  }
}
```

Set project `presentation` to `{"mode":"html","entry":"artifacts/project/index.html"}`.
`required` means production; deliverable `presentation.required` means user access.
Set `user_requested` from actual intent; requested outputs require both production
and embed/link/download access from the entry. Internal-only outputs need a rationale.
For shared work keep one owning scope and one output; `contributing_scopes` records
other scopes' `scope_id`, `category`, loaded `skill_refs` and `purpose`.

## Map assets and links

`files` maps authored HTML/CSS/JS/SVG sources to `artifacts/`. `resources` maps concrete
asset `{source,output}` pairs. Source/output mapping does not rewrite page URLs:
resolve URLs relative to the containing output. From `artifacts/cabin/index.html`
to `artifacts/seats/index.html`, use `../seats/index.html`.

New/changed images need their own image deliverables. Reference producer ids in
`execution.uses`; runtime derives execution order. Supply edit pixels through
`referenceImagePaths`, with diagnosis, changes and preserve; provenance alone
cannot supply them. Keep asset intent and resource paths consistent with the
canonical design. A missing-image fallback cannot replace a required producer.

For a page needing a designed hero image, declare an image deliverable `hero-image`
with file `artifacts/hero-image.png`, acceptance and complete image execution fields.
Add these fields to the page's existing execution, retaining its files and checks:

```json
{
  "resources": [{"source": "artifacts/hero-image.png", "output": "artifacts/control-ui/images/hero.png"}],
  "uses": ["hero-image"]
}
```

A page output under `artifacts/control-ui/` uses `images/hero.png`. Adapt all paths
together to the actual page. No research reference is implicitly copied as a hero.

User-requested originals can be reused unchanged after `user_asset_import` returns
a verified `inputs/user-assets/...` source. Map it to a local resource; unchanged
reuse needs no image producer. Import before approval, using `sourcePageUrl` only
for an asset actually linked on the user's page. Research-discovered images remain
reference-only. Local audio/video and document downloads are supported; remote
embeds and script/HTML material imports are not. Builder copies approved mappings,
without downloading or reselecting materials.

## Declare observable interactions

Use `execution.interaction_checks:[{name,viewport?,page?,steps:[...]}]` once for
consequential scripted flows. Optional `interaction_requirements` are descriptive
notes. Static pages and native anchors do not require duplicate test specifications.

Step actions are click/fill/press/expect_visible/expect_hidden/expect_text/
expect_value/expect_url/expect_in_viewport. Selectors are required except for
expect_url; fill, press and text/value/URL assertions require `value`.
Click/fill/press need unique targets. Scope repeated controls precisely or use
`>> nth=0` intentionally. Assertions support `match:any|all|unique`; visibility
usually defaults to any, hidden to all, text/value to unique.

Put responsive `{min_width,max_width}` bounds on the whole check, alongside name
and steps; tested dimensions belong in `execution.viewports`. Bounds are inclusive
and must include a declared viewport. Match actual CSS breakpoints. Test mobile
menus by opening them before selecting links; a desktop-only check does not verify
mobile navigation. Filtering checks should show matching content, hide nonmatches
and reset. Repair failing behavior instead of removing necessary checks or viewports.
Use `expect_in_viewport` to verify navigation reaches its target; it waits for
arrival within a bounded timeout. `expect_visible` checks rendered visibility,
including offscreen content, and cannot substitute for navigation arrival.

## Validate and publish

Author all required sources, commit ready Context and publish. Publication and
Reviewer approval preview exact sources and declared interactions. Generated assets
use private preview placeholders: access errors concern source visibility/reachability,
not an instruction to write final image files. Normal scrolling and declared
interactions must reveal required content; retain readable reduced-motion behavior.

Repair the reported field, source, selector or responsive flow. Optional
`design_context_validate` provides targeted diagnostics. Receipts distinguish passed,
failed and unavailable browser verification; previews do not certify final imagery
or user research. Builder checks approved source bytes and actual file/resource
integrity after execution. Unchanged inputs can reuse preflight results.
