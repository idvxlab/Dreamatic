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
when handling it locally. Relative page links and system/local fonts are valid.

Use schemaVersion 2 in design_plan.json and deliverable_manifest.json. Each
execution task has the same id/scope_id/category as its deliverable, method
html_generate, files (source/output mappings), resources (local asset mappings),
dependencies (producer ids), interaction_checks and applicable viewports.
For mixed delivery, keep one image task per image deliverable in execution_plan
with its exact id, prompt_seed, negative_prompt_seed, size, size_rationale and
acceptance. Put all producing image ids in the HTML task dependencies. A group
id such as decorative-images is not a replacement for these tasks. Do not keep
executable image prompts solely in the legacy image_generation_plan when using
schemaVersion 2. Builder batches those individual tasks without changing them.
All outputs stay under artifacts/. Preserve relative URLs in the source code.
Resources come from research/assets/ or declared generated artifacts; generated
resources need a dependency on their producing task. Every resource is a concrete
{source, output} local mapping, not an external_url/url/license declaration.
Google Fonts URLs remain remote styles/fonts even if declared here: use acquired
local font files or system-font stacks and remove remote imports from HTML/CSS. Author all required sources
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

Declare a matching deliverable with kind html_page, method html_generate, file
artifacts/control-ui/index.html, purpose, acceptance_test, required, scope_id,
category and skill_refs (names actually loaded for that scope). The manifest's
presentation is `{"mode":"html","entry":"artifacts/control-ui/index.html"}`
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

Before committing a Designer specification, runtime previews these exact sources
and runs declared interactions at each applicable viewport. Failures identify
the task, check, viewport, step and selector; correct the check or actual source
before publishing. Generated image dependencies use private preview placeholders;
this does not certify the final imagery or layout. Builder still runs full final
validation with real assets. Unchanged source/checks reuse the preflight result.
