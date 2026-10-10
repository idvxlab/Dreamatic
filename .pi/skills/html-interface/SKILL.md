---
name: html-interface
description: "Express approved UX/UI design as complete responsive HTML, CSS and local JavaScript with explicit resources and interaction checks. Supporting knowledge for page delivery."
metadata:
  audience: designer
  domain_type: html_interface_expression
  design_categories: [ux]
  module_type: execution
  supported_outputs: [html]
---

# HTML Interface Expression

Apply alongside suitable UX/UI professional knowledge. User intent determines
content, style and scope; this module defines executable expression, not a theme.
Designer owns the complete page design; Builder generates the approved files.
Use one cohesive source per write, with path before content in write arguments.
Split unusually large sources into meaningful local modules instead of risking
a truncated tool response; this is not a feature, page or design-coverage quota.

Author complete HTML/CSS/JS under `plan/html/<scope-id>/`. Use semantic markup,
realistic copy/content, clear hierarchy and controls, visible focus, appropriate
labels, and responsive relationships. Design relevant loading/empty/error states,
navigation and recovery. Implement declared local interactions with mock data
or local state. Record real backend dependencies without pretending they exist.
Use native browser features and local assets; no remote scripts/styles/fonts,
network requests, iframe embeds, eval, service workers or base elements. Use inline
data or local JS constants instead of fetch. Prevent default form submission
when handling it locally. Relative page links and system fonts are valid.

Follow the runtime-injected design contract version. In unified v2, each deliverable
owns id/scope/file and nested execution:{method:"html_generate",files,resources,
uses,interaction_requirements,interaction_checks,viewports}. execution.uses references
other deliverable ids; runtime derives dependencies and artifact resource mappings.
Keep image prompts/sizes inside each image deliverable's execution. Never author a
second task list or duplicate scope/identity. Historical unified v1 retains tasks;
Builder consumes the derived execution view.
Production required and presentation required are separate. Explicitly declare
user_requested and presentation access (embed/link/download); user-requested imagery
must be visible or accessible from the entry, rather than only copied to artifacts.

Declare executable interaction_checks once: {name, viewport?:{min_width?,max_width?},
steps:[{action,selector?,value?}]}. Optional interaction_requirements are descriptive
notes, not a second copy of outcome assertions or a publication prerequisite.
Native anchor navigation does not require a separate test list; test meaningful
scripted user flows and responsive menu behavior. Commit then publish; publication
validates sources. Use design_context_validate for optional targeted diagnostics
and repair the reported exact fields/sources. Final validation
checks the Gallery and real assets after Builder creates them.
All outputs stay under artifacts/. Resolve local URLs relative to the containing
HTML output, not the Run root or source directory: from artifacts/cabin/index.html
to artifacts/seats/index.html use href="../seats/index.html", not
href="artifacts/seats/index.html". Source and output mappings do not rewrite URLs.
Researcher-discovered images are reference-only. User-specified existing works
can be imported unchanged with user_asset_import and mapped directly from
inputs/user-assets/; do not regenerate originals merely to deliver them. For new
or meaningfully changed imagery declare image_generate/image_edit tasks, map
the resulting artifacts/... files and include producer dependencies. For edits
supply referenceImagePaths, diagnosis, actual changes and preserve; provenance
reference_ids_or_paths alone does not supply pixels. Keep each asset strategy
consistent across the plan, task breakdown, manifest and resource mappings. A missing-image
fallback, lazy loading or a changed src does not replace this execution plan.
Every resource is a concrete {source, output} mapping, not an external_url/url/license
declaration. Author icons/vector/UI code under plan/html/... using files mappings.
Use system-font stacks and remove remote Google Fonts imports. Author all required sources
before posting completion. An HTML page has no image prompts or image sizes.

Example execution task (adapt coverage to the actual design):

```json
{
  "id": "settings-page", "scope_id": "control-ui", "category": "ux",
  "method": "html_generate",
  "files": [
    {"source": "plan/html/control-ui/index.html", "output": "artifacts/control-ui/index.html"},
    {"source": "plan/html/control-ui/style.css", "output": "artifacts/control-ui/style.css"},
    {"source": "plan/html/control-ui/app.js", "output": "artifacts/control-ui/app.js"}
  ],
  "resources": [], "dependencies": [],
  "viewports": [{"width": 1440, "height": 900}, {"width": 390, "height": 844}],
  "interaction_checks": [{"name": "Save settings", "steps": [
    {"action": "fill", "selector": "#name", "value": "Living room"},
    {"action": "click", "selector": "#save"},
    {"action": "expect_text", "selector": "#status", "value": "Saved"}
  ]}]
}
```

Declare a matching deliverable with id, kind html_page, file
artifacts/control-ui/index.html, purpose, acceptance_test, required, scope_id,
category and skill_refs (names actually loaded for that scope). In unified
Context, method belongs only to the task; omit method and size from deliverables.

The presentation field is `{"mode":"html","entry":"artifacts/control-ui/index.html"}`
for page-first delivery. For mixed image/page delivery, mode gallery uses
artifacts/00-gallery.html; Builder links the pages from it. One task may include
multiple pages and shared files. Distinct tasks may depend on each other's assets.
`entry` is the single Showcase homepage, not an `artifacts[]` collection. Designer
saves fill a missing HTML entry from the sole html_page deliverable's declared
file, even when its task has multiple pages. With multiple HTML deliverables,
explicitly choose the homepage; with mixed delivery, explicitly choose the mode.

Checks use click/fill/press/expect_visible/expect_hidden/expect_text/expect_value;
fill/press/expect_text/expect_value require value. A check can declare page as its
artifacts/... HTML path. Empty checks are appropriate only for a static page.
Cover consequential flows and applicable viewports, not a fixed page/test quota.
Passing declared checks is mechanical evidence, not completed user research.

Use `viewport: {min_width, max_width}` on checks that apply only to a responsive
layout (for example, mobile menu below 768px or desktop navigation above it).
Put viewport beside name and steps on the whole check, never inside a step.
Use the CSS breakpoints of the actual page, not example numbers. For mobile
navigation/language checks, open its menu first; do not click hidden controls.
`:first-of-type` can still match one button in each card. Use a unique scoped
selector or `>> nth=0` when intentionally testing one repeated instance.
Filtering checks must assert both matching content visible and nonmatching
content hidden, then reset the filter. Do not remove required interactions or
viewport coverage merely to avoid a failing test.
Bounds must include at least one task viewport. Do not require hidden desktop
controls to be clickable on mobile. Actions click/fill/press require a unique
target. Visibility defaults to any matching visible element; hidden defaults to
all matching elements hidden/absent. Assertions can declare match any/all/unique;
text/value default to unique. Use all when every result must satisfy the assertion.
Normal contact/navigation hyperlinks may use mailto:, tel:, https:, query or hash
links; these are navigation, not permission for remote embedded resources.

For explicit cross-domain contributions to a page, bind contributing_scopes on
one deliverable and keep one execution task for its HTML/CSS/JS. Each contribution
has scope_id, category, skill_refs and purpose; do not duplicate output files.

On Designer publication and Reviewer approval, runtime previews these exact
sources and runs declared interactions at applicable viewports when a browser is
available. Required-browser configuration blocks unavailable validation; otherwise
the receipt reports it unverified. Failures identify task, check, viewport, step
and selector; repair the actual source/check before publishing. Generated image
dependencies use private preview placeholders, which do not certify final imagery
or layout. Builder finalization checks approved bytes and file/resource integrity,
without another browser or visual audit. Unchanged inputs reuse preflight results.

For a page needing a designed hero image, declare an image task (e.g. hero-image)
with full prompt/negative prompt, size and rationale, plus a matching deliverable
with its output file and acceptance criterion. Then add to the HTML task:

```json
{
  "resources": [{"source": "artifacts/hero-image.png", "output": "artifacts/control-ui/images/hero.png"}],
  "dependencies": ["hero-image"]
}
```

The HTML uses images/hero.png. The producer is executed before page copying;
no reference image is copied as the hero. Designer/Reviewer validate all local
references and declared interactions before approval. Builder only executes the
approved producers/mappings and verifies file integrity/source equality.

User-specified material exception: explicitly user-provided URLs and uploads may
be reused unchanged. Researcher/Designer calls user_asset_import
before approval (sourcePageUrl only for an asset actually linked on the user's
page). The tool returns a verified inputs/user-assets/<hash>.<ext> source. Designer
maps it in resources to artifacts/<page>/assets/<file>; no image producer
dependency is required for this imported resource. Reviewer checks the trusted
import receipt, source hash and every output mapping. Builder copies approved
mappings mechanically; never download/reselect/reinterpret materials during
building. Researcher-discovered sources remain reference-only. Local video/audio
is supported; documents are local download links. Remote embeds and script/HTML
material imports are unsupported.
