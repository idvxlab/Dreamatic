---
name: html-interface
description: "Author complete HTML/CSS/JS product prototypes or design showcases, including responsive structure, local resources and observable interactions. Use when a design must become inspectable browser sources; this is supporting HTML authoring knowledge, not the primary design discipline or production execution permission."
metadata:
  audience: designer
  domain_type: html_interface_expression
  design_categories: []
  module_type: execution
  capabilities: [html-authoring, responsive-layout, interaction-implementation, asset-mapping]
  supported_outputs: [html]
---

# HTML Interface Expression

For UI/UX, HTML pages are the design outcome: realize visual composition, realistic
copy, components, responsive relationships and relevant states/flows. For other
disciplines, HTML integrates the primary design images with concise introductions
and explanations; default to clear static layouts and add interaction for useful
inspection or comparison. Use local JavaScript as needed. Motion requires a design
purpose or confirmed intent, not merely an HTML deliverable.
Designer authors sources; Builder materializes approved files without redesign.
Every project has one required HTML entry. An existing product page can be that
entry; this Skill does not require extra pages, scopes or a fixed section count.

## Selection boundary

Load when approved or still-developing design decisions must become inspectable
HTML sources. The professional primary owns what is designed; this supporting
module explains how to express it in the browser. Here execution knowledge means
source/specification methods, not permission for Designer to execute production.
Use returned catalog names and the owning scope; do not create a UX scope merely
because another discipline needs a showcase.

## Lightweight showcase default

For non-UI/UX work, start with semantic HTML and a local stylesheet. Use system
fonts, a natural chapter order, native anchor links, ordinary images and captions.
Keep required content visible from first render. Scroll-reveal, opacity:0 content,
parallax, carousels and custom navigation are additions only when a concrete viewing
task or confirmed intent needs them; record that purpose in the design decisions.
Static showcases need no JavaScript by default. Do not add controls just to make
the page seem complete.

Use one column on narrow screens and at most two on wide screens by default.
Images should fit their container with preserved proportions; grid/flex children
must be able to shrink (e.g. min-width:0). Prefer minmax(0,1fr) for equal grid columns.
On mobile, turn dense technical cards into a single-column list, reduce excessive
padding, and allow long text to wrap. Preserve all requested sections, evidence
boundaries and access to full/detail images; reduce implementation complexity,
not design coverage. Choose visual hierarchy, spacing and color for the actual work
rather than applying a mandatory template.

For UI/UX products, the requested navigation, states and flows remain part of the
design outcome. Keep the complexity needed for those requirements and verify it.

## Author complete sources

Use Run-relative `path` for source read/write/edit, e.g.
`plan/html/<scope-id>/styles.css`; runtime binds the assigned Run. Do not prepend
runDir, workspace/runs/<runId> or an absolute path. Write `path` before `content`.
For substantial pages, separate long styles and needed behavior/content modules
from a small HTML entry. Use JavaScript modules/data when the design needs them,
without fetch; static showcases need no scripted content rendering.
Choose this structure before the first write; keep index.html as the entry rather
than embedding all sections, diagrams and behavior in one large call.
Save one complete file per response, retaining successful files as checkpoints.
Keep small pages simple; this is source organization, not extra pages or reduced coverage.
After truncation, split the failed source before retrying. Do not append incomplete
markup, rely on unsaved streamed code, or resend the entire page merely shortened.
Map every local module in the page's `execution.files` and resolve links from outputs.
Use semantic markup, realistic copy, accessible controls, visible focus and
responsive relationships. For interactive designs, implement relevant navigation,
states and recovery with local state or mock data; record real integrations as
unresolved dependencies.

For showcases, shape the story around actual work with meaningful captions and
inspectable full/detail views. Preserve image proportions. Keep prompts, generation
logs and invented technical claims out of visitor-facing copy.

Use local assets and native browser features. Remote embedded scripts, styles,
fonts, network requests, iframe, eval, service workers and base elements are
unsupported. Use system fonts and local constants instead of fetch; prevent local
forms from submitting. Ordinary navigation and evidence links may use HTTPS,
mailto, tel, query or hash URLs.

## References for non-UI/UX showcases

Include a visible final `<section id="references">` headed
"参考文献 / References" in the existing project entry. Use a plain semantic list
with hanging-indent styling and wrapping links; no JavaScript or extra page is needed.
List sources actually used to inform the proposal, primarily from Researcher's
`context/research.json` evidence.bibliography, official_sources, findings and source
receipts. Preserve original titles/languages and verified metadata. Include adopted
visual precedents with creator/project/publication provenance, not generated outputs.

Default to IEEE numeric citation style, unless the user specifies another academic
style. Assign consecutive [1], [2], ... by first citation; repeated citations reuse
the same source number. Show an explicit text label before every entry, e.g.
`<li id="ref-source-id"><span class="ref-number">[1]</span> ...</li>`.
An ordered list alone is insufficient when CSS hides its markers. Keep the label
visible on every viewport; never hide it for decoration. With explicit labels,
list-style:none prevents duplicate markers. Use hanging indents and wrapping links.

For a webpage, retain author/organization, page title, website, attributable date,
canonical URL and actual access date. For a journal article, retain authors, title,
journal, volume/issue, pages or article number, year and verified DOI. Format these
elements according to the selected style and source type. Omit unavailable details
honestly; never invent them or substitute a copyright/review/access date for
publication. User-requested author-date styles use their own citation and ordering
rules; do not mix those rules with numeric labels.

Use linked [n] citations beside evidence-based claims or captions, targeting stable
reference ids (e.g. `<a href="#ref-source-id">[1]</a>`). Each link's number must
match the visible label of its target entry. Check all entries and repeated citations
before publication; link existence alone is insufficient. Deduplicate, and do not dump all collected
URLs: unused results and inaccessible/search-only leads belong in research limitations,
not as evidence for claims. If no external source was used, keep the section and state
that explicitly; never add filler references. Keep assumptions and original design
proposals distinguishable from sourced facts.

Formatting guidance: [IEEE Reference Guide](https://journals.ieeeauthorcenter.ieee.org/wp-content/uploads/sites/7/IEEE_Reference_Guide.pdf).

## Declare the current deliverable

Author `deliverables` through `update_design_context({changes:{...}})`. Identity,
scope, file, purpose and acceptance belong on the deliverable. Put method, source
mappings, resources, producer references, viewports and checks inside `execution`.
Use the exact assigned scope id and actually loaded Skill names.

```json
{
  "id": "project-page", "scope_id": "actual-owning-scope",
  "skill_refs": ["loaded-professional-skill", "loaded-html-authoring-skill"],
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
resolve each URL relative to the containing file's output, then verify it matches a
declared `files[].output` or `resources[].output`. Use the mapped resource output,
not its producer source path. From `artifacts/cabin/index.html` to
`artifacts/seats/index.html`, use `../seats/index.html`.

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
menus by opening them before selecting links. Without bounds a check runs at every
declared viewport; limit direct clicks on desktop navigation to widths where it is
visible, and declare a separate mobile flow. Filtering checks should show matching
content, hide nonmatches and reset. Repair failing behavior instead of removing
necessary checks or viewports.
Each check reloads the page and starts without earlier scroll/menu state. Reveal
scroll-dependent navigation first (for example, press PageDown on body until the
navigation appears, then expect_visible on its container before clicking). Preserve
intentional reveal behavior instead of making navigation always visible for a test.
Bounds include their endpoints: if CSS hides desktop links at max-width:768px,
use min_width:769 for the desktop flow and test the actual mobile entry separately
at widths up to 768. A not_applicable desktop result is not mobile navigation evidence;
do not raise bounds just to skip a required failing flow.
Use `expect_in_viewport` to verify navigation reaches its target; it waits for
arrival within a bounded timeout. `expect_visible` checks rendered visibility,
including offscreen content, and cannot substitute for navigation arrival.
`expect_in_viewport` does not scroll. Put the actual navigation click or keyboard
scroll before the arrival assertion, not after it. For static content whose requirement
is rendered visibility rather than arrival, use `expect_visible`.

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
