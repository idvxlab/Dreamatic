# Design pipeline

Pi 1.4.0 owns model execution, persisted specialist sessions, tool invocation,
resource discovery and Skill loading. Dreamatic's server owns the fixed sequence
Orchestrator → Researcher → Designer → Builder and delivery policy. Role prompts
live in `prompts/`; professional knowledge remains in the repository `.pi/skills`.
No Pi runtime source is copied into Dreamatic.

The design handoff is `intent.md`, `research.md`, `design.md` at the run root.
JSON files store transport data, image receipts and checkpoint metadata only.
Each Image section in design.md contains Introduction, Size and Prompt headings.
Builder generates every image and returns a project-specific exhibition page.
The final page and gallery export contain the same work; the existing artifact
manifest and build receipt keep preview/export/publication compatible.

System Settings retains per-role model and thinking controls. Custom models
absent from the Pi catalog need explicit context/output limits. Image ceiling
defaults to 1024x1024; any positive WIDTHxHEIGHT ceiling is configurable.
Capabilities come from `supported_sizes` in endpoint model metadata or explicitly
verified image settings. Missing capability information is explicitly marked unknown. Designer may choose
unverified request dimensions within the configured budget; normal generation
validates those requests without a separate paid probe. Budget candidates are
never cached as model capabilities. Successful generation sizes are cached as
observed accepted requests, not an exhaustive list of model limits. The persistent cache lives under configuration-directory/cache or
~/.dreamatic/cache, outside individual projects, keyed by endpoint, model,
capability settings and a credential digest.

Continue workflow resumes matching checkpoints. Request, attachment, upstream document and output-content changes invalidate
affected checkpoints. Role prompt maintenance and delivery-policy updates do not
invalidate already valid work. Image settings affect Designer/Builder only. Images use prompt/model/endpoint signatures
and content hashes; successful matching images survive retries. Image batches
respect per-run and global concurrency settings. Session abort and timeout leave
an interrupted checkpoint. Independent images use one batched tool call.

Current limitations: execution accepts image attachments; document/video input
extraction is not implemented. Capability discovery supports metadata exposing
supported_sizes, with verified manual settings as fallback. IEEE checks validate
numbered references and source traceability, not the factual accuracy of a paper.
Live provider quality, exhibition art direction and latency require real model
credentials and representative design tasks; automated tests use a local provider.

Citation validation treats References as a Markdown section ending at the next
heading of equal or higher level. Citations before and after that section are
checked, including adjacent numbers, grouped numbers and ranges. Missing entries
and duplicate numbers are rejected; additional uncited entries produce a
non-blocking completion note and still require source traceability. Multiline
reference entries retain URLs.
Designer places References last by convention. Before validation, its complete
output is retained in a private .design-draft.json keyed to current stage inputs.
Resume revalidates a matching draft before calling the model; invalid or stale
drafts do not block a fresh Designer attempt. Only validated text becomes design.md.

All role prompts and the shared system delivery policy explicitly instruct models
to return the complete deliverable without calling write/edit or asking the user
to save it. Dreamatic retains public output privately before validation, writes
validated UTF-8 content to a temporary sibling file, verifies it, then atomically
renames it over the destination. Only successful publication updates the stage
checkpoint and emits Completed and saved with the output path. Real validation or
filesystem errors remain visible; they do not become false successful stages.

Resume checkpoints use v2 input fingerprints separated from role prompt text and
reasoning model selection. Legacy checksums are migrated only when historical
system instructions reproduce the saved checksum using the current request,
attachments, dependencies, configuration and output. Missing or mismatched
completion evidence causes regeneration rather than blindly accepting a file.
Legacy draft recovery follows the same evidence check. Migration does not call
models or change original Pi session history.

Model response timeouts follow Pi turn_start and assistant message_end events.
Each model call gets a first-output allowance and, after its first nonempty text,
thinking or tool-call output, a separate generation allowance. The optional total
cap applies to that single model response. Tool execution, concurrency queues and
image downloads do not consume model response time; image tools retain their own
configured timeout. Timers are canceled on response end, user abort and session
cleanup, and subsequent model turns receive fresh budgets.

## Exhibition art direction

Builder retains its existing batch image generation. Pi discovers the focused
concept-showcase-storytelling Skill for Builder. The inventory includes every
planned image's Introduction, Size, stable source and generation state; exact Prompts are already
supplied in design.md and are not duplicated in the inventory. Builder reads
textual design documents and existing HTML, not images; its reasoning model uses
text input and does not receive image attachments. The text read wrapper delegates
pagination/truncation to Pi and rejects image paths/blocks.

After generating all planned images, the required plan_showcase tool persists an
independent project-specific direction in showcase.md: concept thesis, hero,
every work's role/group/purpose in narrative order, necessary explanation,
art direction and mobile sequence. Unknown, duplicate or missing planned ids are
rejected. Designer determines the works; Builder determines their presentation.
All works must appear; there is no secondary selection or image inspection. These
steps happen inside one Builder session without a separate review agent, fixed
page template or regeneration for layout changes.

The page must contain all planned real images and work as static HTML: inline CSS,
local imagery, system/local fonts, no scripts or remote imports. Full enclosing
Markdown fences are normalized before delivery. Objective checks verify paths,
files and full image coverage, excluding comments, inactive containers, explicit
hiding and tiny placeholders. Static checks cover simple unconditional CSS and
inline hiding, not arbitrary computed layout or aesthetic quality. Prompts require
full source proportions, no guessed focal-point crops/overlays, meaningful image
scale and readable desktop/mobile composition. The manifest records all imageIds,
per-work arrangements, hero and direction document. Exports include showcase.md.
Historic completed exhibitions are not silently overwritten; new Builder work
uses this procedure. Visual quality depends on the model's textual design reasoning
and composition ability, with no vision requirement.

## Image wait feedback

The existing fixed conversation status region shows real per-image receipts:
queued, generating, saved, failed and reused. The total is the full design image
plan, even when Builder calls the generator in smaller batches. Progress snapshots
are persisted through existing agent_progress events, keeping native workflow
reload and UI updates aligned. Timings start after acquiring the global image
slot and end after the image and its receipt are saved. Only successful newly
generated images contribute to the observed mean; reused and failed images do not.
Parallel active works are listed separately. The UI explains that generation can
take minutes and Dreamatic should remain running; it does not invent a remaining
time estimate. Waiting hints disappear when the image tool stops; saved thumbnails
remain accessible. Legacy completion-only receipts continue to render.

## Safe public workflow logs and historical recovery

Public workflow events omit image blocks, Base64 fields and data URLs before
broadcasting or writing bus.jsonl. Pi execution/session content and original image
artifacts are preserved. Historical JSONL indexing applies the same projection in
memory, including JSON-encoded tool results; original logs are never rewritten.
Path recovery traverses structured text/path fields and skips binary fields. It
uses a literal directory search with bounded anchored path candidates rather than
an unanchored wildcard prefix, so multi-megabyte image reads cannot monopolize the
event loop through regex backtracking. Regression tests run recovery in a child
with an external deadline, which can terminate synchronous regressions.

Creation, conditional project/session list reads and health requests have a
15-second response deadline covering headers and body. A timeout releases the
creating state and offers reconnect; creation is never automatically retried,
because the server may already have saved the new project.

## Designer bibliography warnings and resume stability

A listed, traceable source that is not cited in design prose is an editorial
warning, not an execution failure. The validator returns unused reference ids;
Designer completion reports them while preserving the exact Markdown, numbering,
image ids, prompts and sizes. Missing entries, duplicate/invalid numbers, malformed
citation ranges and untraceable URLs still fail validation.

The same checks run before publishing a new design and when recovering a saved
.design-draft.json. A draft previously rejected only for uncited sources now passes
and is published byte-for-byte without a new Designer model session. Upstream
checkpoints are reused as before. Hard-invalid or incompatible drafts still
follow the existing retry policy; this change does not bypass substantive checks.

## Project completion message

After every deliverable has been validated and saved, the server publishes one
project_completed conversation message and completion-summary.json. A stable id
combines the completed Builder checkpoint and delivery invocation, so reload or
continue of an unchanged completed run does not add a duplicate. A new delivery
gets its own summary; statistics start after the previous completion and include
all retries/resumes for that task. No extra model call is made for the summary.

Stage durations come from durable lifecycle intervals and include model/tool work
and retries. Total elapsed time includes waiting and interruption gaps; execution
time uses active run intervals. Incomplete crash intervals count only observed time
and are marked incomplete. Pi assistant usage is summed from saved sessions;
provider totalTokens already includes reasoning and cache usage, so those details
are not added again. Image generation records optional reported usage in progress
receipts. Missing image/model reports are marked unknown, never invented as zero;
known subtotals carry a plus sign when incomplete. The conversation renders a
localized compact table, product counts/image names, and project view/download
links. Historical completion messages without structured data keep their text.

## Stable work references and local Builder recovery

Builder tools and the text inventory supply dreamatic-image:ID sources. The model
uses them in ordinary img elements and full-resolution anchor links; the server
binds them to verified generated paths before final/gallery publication. Original
image filenames, signatures and bytes are unchanged. Legacy canonical sources
remain accepted. A wrong legacy hash may be corrected only when the work id is
exact, the local path/extension is valid, the hash differs by one edit and the
planned work association is unique. Remote/traversal/unknown/conflicting sources,
duplicate source attributes and srcset overrides remain errors. All planned images
must still pass visible coverage and digest checks. Repairs are recorded in private
.builder-delivery.json; raw model output is retained unchanged.

Successful art direction is saved in showcase.md and .showcase-direction.json with
the current input fingerprint and image path/digest snapshot. Complete Builder
output also stores its paired direction/snapshot. Resume first validates this
pair, resolves references and publishes the existing HTML locally, before provider
or image-capability setup, without new model/image calls. A compatible saved plan
may also be restored when further model work is needed. Incompatible inputs,
changed images or an invalid/incomplete page do not bypass validation.

Older drafts without paired metadata are eligible only when a saved Pi final
message exactly matches the draft and its own Builder invocation has a successful
all-work plan whose source receipt matches the current generated inventory. A
later invocation's direction is never borrowed. Recovery uses the same delivery,
manifest, receipt/checkpoint and completion-summary path as a fresh Builder result.
