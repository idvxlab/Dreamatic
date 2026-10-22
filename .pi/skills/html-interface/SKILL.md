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
Use a clear HTML entry that gives access to the requested work. An existing
product page can serve as the entry.

## Selection boundary

Load when approved or still-developing design decisions must become inspectable
HTML sources. The professional primary owns what is designed; this supporting
module explains how to express it in the browser. Here execution knowledge means
source organization, asset mapping and browser behavior.

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

Use project-relative source paths and keep resources organized alongside the page.
For substantial pages, separate long styles and needed behavior/content modules
from a small HTML entry. Use JavaScript modules/data when the design needs them,
without fetch; static showcases need no scripted content rendering.
Choose this structure before the first write; keep index.html as the entry rather
than embedding all sections, diagrams and behavior in one large call.
Save one complete file per response, retaining successful files as checkpoints.
Keep small pages simple; this is source organization, not extra pages or reduced coverage.
After truncation, split the failed source before retrying. Do not append incomplete
markup, rely on unsaved streamed code, or resend the entire page merely shortened.
Map local modules and resolve links relative to their delivered output.
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
List sources actually used to inform the proposal and retain source receipts. Preserve original titles/languages and verified metadata. Include adopted
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

## Verify delivery

Keep a manifest of authored pages, styles, scripts and assets. Resolve every local
link relative to its delivered file. Verify the requested flows, responsive layouts,
keyboard access, visible focus, error states and access to each required output.
Test the actual presentation in a browser; record missing integrations and failed
checks without claiming successful delivery.
