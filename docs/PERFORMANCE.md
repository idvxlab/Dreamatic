# DreamaticArt performance changes

## Behavior and ownership

Pi remains the agent/session runtime. These changes live in DreamaticArt's design
workflow tools, server transport/indexing, and React UI. They do not copy Pi
internals, bypass review approval, reduce deliverable coverage, or claim visual
inspection from successful generation.

- `design_context_read` returns valid JSON overviews with `omittedPointers`,
  complete identity inventories and source hashes. `paths` plus `full: true`
  loads selected authoritative files. An overview is not an executable spec.
- `patch_json` serializes JSON writers per file, checks the supplied source hash,
  updates explicit JSON pointers, and reuses role/identity/schema validation and
  atomic saves. It does not silently repair unrelated fields.
- `execute_image_plan` is Builder-only. It verifies the current approval gate
  and committed spec/review receipts, loads stored tasks by id, honors edit
  dependencies, rejects ambiguous edit instructions, and preserves independent
  successes. Reuse requires matching task/reference fingerprints and output
  hashes. Generation remains controlled by approved method and output paths.
- `showcase_template` produces a local responsive gallery from ids, sections and
  public captions. It requires every required deliverable; use custom HTML for
  non-PNG media or a brief requiring a distinctive presentation. Normal
  finalization still supplies references, attribution, metadata and lint.
- Image HTTP attempts share process-wide admission control with rotating project
  queues. Backoff releases request slots; queued cancellation removes work. Queue,
  header, body, byte-count and request timing are recorded separately. Image
  downloads inherit cancellation and per-image retry scopes. Response bodies
  have a byte ceiling. This scheduler is process-wide, not cross-process.
- Retry-After is respected beyond the local exponential backoff cap; production
  network retries add jitter. Permanent validation errors are not retried.
- Research caches validated raw source content per Run/URL with a TTL. Excerpts
  are recomputed for current terms and limits, and HTML remains available for
  reference discovery. `research_fetch_batch.sources[].refresh` explicitly
  refetches and consumes acquisition budget. Failed/verification pages are not
  cached. Search, fetch and downloads inherit cancellation. Acquisition budgets
  persist atomically under `.performance/` and reset on revision cycles.
- Server JSONL indexes read appended bytes and parse new complete records. They
  handle partial UTF-8, complete trailing JSON without a newline, replacement and
  truncation. Directory-entry caches invalidate by directory modification time.
  All caches are bounded; indexes are rebuilt after a server restart.
- `GET /api/runs?summary=1` omits heavy notes/activity/session detail.
  `GET /api/runs/:id` retains full single-project details. Existing full-list
  consumers remain supported. Conditional responses use ETag/304.
- The UI polls summaries plus selected project details/assets. Requests within a
  poll do not overlap the next poll; intervals are 3s active, 15s idle, 60s hidden.
  The selected workflow uses one SSE snapshot and incremental events. Text deltas
  are combined over 60ms; clearing a message also cancels pending text updates.
- Web prompt transport sends only consumed text deltas/tool status and a light
  final session snapshot (`compactEvents: true`), avoiding repeated full Pi
  message payloads. Other clients retain the raw event contract by default.
- SSE and prompt streams respect socket backpressure with bounded pending bytes
  plus the current in-flight frame.
  Slow connections are closed rather than buffering without a limit. Workflow
  EventSource reconnects from a fresh durable snapshot; agent execution continues.

## Configuration

New defaults (also in `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `DREAMATIC_IMAGE_GLOBAL_CONCURRENCY` | 4 | Total image HTTP requests in this Node process, 1–32 |
| `DREAMATIC_IMAGE_CONCURRENCY` | 2 | Per-project admission and batch width, 1–8 |
| `DREAMATIC_IMAGE_RESPONSE_MAX_BYTES` | 67108864 | Max response body bytes, including base64 JSON |
| `DREAMATIC_RESEARCH_CACHE_TTL_MS` | 86400000 | Raw-page cache TTL; 0 disables reuse/storage |

Existing image/model timeouts, models, sizes, and retry counts are preserved.
The running installation previously configured image timeout to 3,000,000ms
(50 minutes); this change does not silently replace that preference. Tune it
using new per-request timing, successful completion distributions and provider
behavior, including uncertain generation outcomes. The presence of an
Idempotency-Key header does not prove the provider honors it. No status-query
API is assumed when the provider contract does not expose one.

## Measurement

`npm run diagnose:performance -- /absolute/workspace` reads historical Bus
records and reports stage latency, model output, image queue/request latency and
retries. Missing old image timing is reported as unmeasured. Mixed historical
models, versions and task sizes are not a controlled performance comparison.

`GET /api/performance` reports process memory, event-loop delay and recent
HTTP route P50/P95. Route samples include request lifetime; long-lived streaming
connections must be interpreted separately from ordinary list requests.
Image events are telemetry and do not appear as user-facing workflow milestones.
Agent completion includes validation timing; cleanup has a separate event.

Read-only measurements on the existing workspace (41 projects, 512 assets),
after both implementations warmed their caches:

| Operation | Before | After | Returned JSON |
| --- | ---: | ---: | ---: |
| Full project inventory | 224–226ms | 100–101ms | 545,934 bytes |
| Project summary inventory | n/a | 28ms | 18,662 bytes |
| Selected project detail | n/a | 3ms | 15,346 bytes |
| Selected project assets | n/a | 1–2ms | 4,175 bytes |
| Selected workflow | earlier 40–43ms | 9–11ms | 145,125 bytes |

Cold full inventory was slower in this sample (437ms before, 534ms after).
The UI benefit comes mainly from lightweight summaries, project-scoped loading,
cache reuse and conditional transport, not an unconditional speedup to all
operations. These are module timings, not browser/network latency measurements.

## Validation and follow-up

Tests cover queue limits/cancellation/release, Retry-After, bounded response
bodies, compact/full context, stale JSON patches, approval gates, matching image
reuse and tampering, source cache refresh/cancellation, persisted acquisition,
JSONL append/replacement/truncation/Unicode and stream backpressure. HTTP smoke
validation covers summary/detail routes, ETag/304, SSE snapshots and telemetry.

Validate real model speed and quality with fixed briefs, image dimensions and
model/provider versions. Compare cold/warm and single/multiple project runs:

1. Stage wall time, first delta, response time, output tokens and repair rounds.
2. Every required deliverable, professional review findings and design coherence.
3. Image queue/request P50/P95, timeout/429 rates, successful reuse and cost.
4. Research cache hit rate, useful source coverage and acquisition consumption.
5. HTTP latency/bytes, peak RSS, event-loop delay and browser interaction latency.

Do not add parallelism across dependent approval stages or weaken professional
review to improve a timing number. Select persona models/thinking levels using
existing Pi/provider configuration only after quality comparisons. Real provider
speedups and P95 improvements are not claimed from mocked regression tests.

## v2.0.3 scoped Skills and HTML

Category assignment uses the existing Orchestrator call; Skill discovery uses Pi
and cached descriptors, with bodies loaded only on selection. Unchanged activation
records avoid redundant writes. HTML generation copies approved source bytes and
reuses matching outputs without another model call. Browser dependencies load
only for HTML validation. The existing image adapter, queue, retry budgets and
provider contract remain in use. Preview initialization is lazy, and UI preview
requests follow build/entry changes rather than each polling timestamp.

These choices bound new work by the actual assigned scopes and HTML outputs.
They do not establish a provider latency or creative-quality improvement. See
[v2.0.3](V2.0.3.md) for configuration and evidence limits.


### Image response body stalls

Image generation/edit/download retains its configured per-request deadline.
`DREAMATIC_IMAGE_TIMEOUT_MS=300000` is five minutes; `3000000` is fifty minutes.
Once response headers arrive, `DREAMATIC_IMAGE_BODY_IDLE_TIMEOUT_MS` independently
bounds time without real body bytes (default 60000 ms). Active slow streams may
continue up to the overall deadline; empty chunks do not reset the idle timer.
Cancellation does not wait for transport cleanup or schedule another retry.
Timeouts reuse the existing bounded retry budget and idempotency keys, and release
image admission capacity. Failed reads preserve partial-byte and body-duration
metrics rather than reporting zero. Pi tool updates expose the image, phase and
attempt while work is pending; snapshots and live tool cards retain those updates.
PNG/output/size validation precedes generation or editing requests. A failed
structured image batch is shown as an error without discarding saved siblings.

## Model response diagnosis and recovery

Model telemetry uses Pi extension events and is written to
`.performance/model-requests.jsonl` in the Run (or workspace before initialization).
It records a local request id, request time, response-header time/status, first
nonempty delta/text, completion, usage/cache counts, reasoning character counts,
input character count and selected control values. It never logs request content,
API keys, authorization headers or response bodies. Character counts are not token
estimates. Request/header timestamps help distinguish provider waiting from
streaming; they cannot independently distinguish gateway buffering and queueing.

`DREAMATIC_MODEL_TURN_TIMEOUT_MS[_ROLE]` now limits waiting for first output.
`DREAMATIC_MODEL_GENERATION_TIMEOUT_MS` independently limits generation after the
first nonempty delta (default 300 seconds). The idle limit refreshes only on actual
nonempty deltas. `DREAMATIC_MODEL_TOTAL_TIMEOUT_MS` bounds the complete response;
its default is first-output limit plus generation limit, and an explicit value
is bounded below by the first-output allowance. Tool execution retains
its separate limits. User cancellation still propagates. The timer checks at
15-second intervals, so enforcement may overshoot by up to one interval.

Recoveries distinguish first-output waiting, connection/stall and long generation.
Long generation recovery requests concise, complete domain content with source
references, not repeated quotations or asset metadata. Partial/aborted JSON is
never executed, completed or silently salvaged. Retry counts remain bounded.

Endpoint reasoning capabilities can be configured by exact model id with
`DREAMATIC_MODEL_CAPABILITIES`. For example, a verified Qwen-compatible endpoint
can use `{"qwen3.7-plus":{"reasoning":true,"thinkingFormat":"qwen"}}` so Pi
sends `enable_thinking:false` when thinking is off. Unknown endpoints preserve
existing behavior; model names alone do not establish parameter support. Supported
formats are openai, qwen, qwen-chat-template and zai. Validate the actual endpoint
before enabling a format. Mock Pi request construction verifies parameter emission,
not whether a live gateway honors it.

Research fetch batches supply at most 6000 excerpt characters across their
sources. Full text remains in cachedPath, and complete acquisition/candidate
results remain at resultDetailsPath under research/batches. Model-facing asset
records retain paths, provenance and key permissions without repeating complete
sidecars and candidate lists. Compact Researcher Context reads omit the raw asset
manifest unless full:true or its canonical path is explicitly requested; the
reference inventory remains available. Reviewer still receives its required
manifest. New Orchestrator prompts use unified rules before initialization, and
unified specialist task text translates retired paths to canonical field references.

Context authoring uses named role fields and runtime-managed versions to avoid
model-generated JSON pointers and repeated hash exchanges. Strict sampling is
opt-in through exact-model `supportsStrictMode:true`, only after endpoint
verification. Unknown endpoints disable it; Pi's preferred strict conversion can
fall back for open creative schemas. These changes reduce avoidable repair calls;
end-to-end latency improvements require measurements on real runs.

Request diagnostics now include loaded runtime fingerprint, actual Pi version,
configured thinking level and whether thinking controls were actually emitted.
Unknown capabilities are not proof that remote reasoning is disabled. `length`
stops have bounded recovery distinct from network failures; partial JSON is never
salvaged. `use_skill.bindings` validates multi-scope selections before mutation and
returns a Skill body once per invocation. Source validation caches bind runtime,
contract, browser and source bytes; final validation uses real assets and export
rechecks required access. Tests establish behavior, not live-provider latency.
