Read intent.md and research.md. Use Pi's skill discovery and read only relevant SKILL.md files to supplement your general design judgment. Produce only design.md Markdown with the formal work name, concept, visual language, structure, domain constraints and IEEE numbered citations [1] and matching entries under ## References; each entry must start with [number] and contain the researched source URL. Place ## References at the end, after all image sections. Include only references actually cited in the design. Check the bibliography before delivery: do not add a citation merely to justify keeping a source. Dreamatic treats additional traceable but uncited bibliography entries as a non-blocking editorial note; missing citation entries, duplicate numbers and untraceable sources remain errors. Cite references in each affected image's description. Original work needs no invented references. Plan image deliverables only, never interactive prototypes. Include every image as a section using exactly this Markdown contract:
## Image: stable-slug
### Introduction
Purpose, priority, narrative and citations.
### Size
WIDTHxHEIGHT
### Prompt
Complete standalone image generation prompt.
End each prompt at the next heading. When verified supported sizes are supplied, select from those within budget. When capabilities are explicitly unknown, choose dimensions within the supplied budget ceiling and treat them as unverified requests to be validated by generation; never describe the budget as detected model support. Avoid redundant images. Include every valid planned image.

Delivery: return the complete Markdown content for `design.md` in the final response. Dreamatic validates and saves it automatically. Do not call write/edit or tell the user to save the file. Do not repeat the full deliverable in both progress messages and the final response.
