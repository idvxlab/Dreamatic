import { Type } from "typebox";

/** Required storage shape is explicit; creative/domain additions remain open. */
export function roleContextSchema(role: string, version = 1) {
  const open = Type.Record(Type.String(), Type.Unknown());
  const strings = Type.Array(Type.String());
  const scopeFields = { scope_id: Type.Optional(Type.String({ description: "Exact assigned designScopes[].id; not a Skill name." })), category: Type.Optional(Type.String({ description: "Assigned scope category (e.g. industrial, media_communication), not a content genre. Omit for runtime inference." })) };
  const sourceFiles = version === 1 ? Type.Array(Type.Object({source:Type.String(),output:Type.String()},{additionalProperties:true})) : Type.Array(Type.Object({ source: Type.String({ pattern: "^(plan/html/|artifacts/|inputs/user-assets/)", description: "Designer sources: plan/html/<scope>/index.html. Generated/imported resource: artifacts/... or inputs/user-assets/..." }), output: Type.String({ pattern: "^artifacts/", description: "Builder output path, always artifacts/..." }) }, { additionalProperties: true }));
  const viewportBounds = Type.Object({ min_width: Type.Optional(Type.Integer({minimum:240,maximum:3840})), max_width: Type.Optional(Type.Integer({minimum:240,maximum:3840})) }, {additionalProperties:false});
  const step = Type.Object({action: Type.Union(["click","fill","press","expect_visible","expect_hidden","expect_text","expect_value","expect_url","expect_in_viewport"].map(action => Type.Literal(action))), selector: Type.Optional(Type.String({minLength:1,description:"CSS target; required except expect_url"})), value: Type.Optional(Type.String({description:"Required for fill, press, text/value/URL assertions"})), expected:Type.Optional(Type.String({description:"Design note only; use expect_* steps for executable assertions"})), match:Type.Optional(Type.Union(["any","all","unique"].map(value=>Type.Literal(value))))},{additionalProperties:false});
  const interactionChecks = Type.Array(Type.Object({name:Type.String({minLength:1}),steps:Type.Array(step,{minItems:1}),viewport:Type.Optional(viewportBounds),page:Type.Optional(Type.String({pattern:"^artifacts/"})),requirement_id:Type.Optional(Type.String({description:"Optional descriptive goal reference; assertions live only in steps"}))},{additionalProperties:false}));
  if (role === "reviewer") return Type.Object({ assessment: Type.Object({
    review_stage: Type.Literal("design_context"), verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
    round: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), summary: Type.String({ minLength: 1, pattern: "\\S" }), scores: open,
    issues: Type.Array(open), resolved_issue_ids: strings, remaining_risks: Type.Array(Type.Unknown()),
  }, { additionalProperties: true }), intentCoverage: Type.Optional(Type.Unknown()) }, { additionalProperties: false });
  if (role === "researcher") return Type.Object({ evidence: Type.Object({ target: Type.String({ minLength: 1, pattern: "\\S" }), summary: Type.String({ minLength: 1, pattern: "\\S" }), official_sources: Type.Array(open), open_questions: Type.Array(Type.Unknown()) }, { additionalProperties: true }), findings: Type.String({ minLength: 1, pattern: "\\S" }), usageConditions: Type.String({ minLength: 1, pattern: "\\S" }) }, { additionalProperties: false });
  const schema = Type.Object({
    system: Type.Object({ system_thesis: Type.String({ minLength: 1, pattern: "\\S" }), palette: open, typography: open,
      consistency_rules: Type.Optional(Type.Unknown({ description: "Shared design rules; owned by changes.system, never the changes root." })),
      asset_rules: Type.Optional(Type.Unknown({ description: "Design asset-use rules, inside changes.system." })),
      consistency_anchor: Type.Optional(Type.Unknown({ description: "Identity features shared across outputs, inside changes.system." })),
      prohibited: Type.Optional(Type.Unknown({ description: "Grounded prohibited treatments, inside changes.system." })),
    }, { additionalProperties: true }),
    strategy: Type.Object({ design_intent: Type.String({ minLength: 1, pattern: "\\S" }) }, { additionalProperties: true }),
    tasks: Type.Array(Type.Object({ id: Type.String({ minLength: 1, pattern: "\\S", description: "Stable id shared by the matching task and deliverable. Preserve during repairs." }), ...scopeFields, size: Type.Optional(Type.String()), prompt_seed: Type.Optional(Type.String()), negative_prompt_seed: Type.Optional(Type.String()), size_rationale: Type.Optional(Type.String()), files: Type.Optional(sourceFiles), resources: Type.Optional(sourceFiles), dependencies: Type.Optional(strings), interaction_checks: Type.Optional(version === 2 ? interactionChecks : Type.Array(open)), viewports: Type.Optional(version === 1 ? Type.Unknown() : Type.Array(Type.Object({width:Type.Integer({minimum:240,maximum:3840}),height:Type.Integer({minimum:240,maximum:3840})},{additionalProperties:false}),{minItems:1,maxItems:6})), method: Type.Union([Type.Literal("manual"), Type.Literal("image_generate"), Type.Literal("image_edit"), Type.Literal("html_generate")]) }, { additionalProperties: true })),
    deliverables: Type.Array(Type.Object({ id: Type.String({ minLength: 1, pattern: "\\S", description: "Stable id shared by the matching task and deliverable. Preserve during repairs." }), ...scopeFields, skill_refs: Type.Optional(Type.Array(Type.String(), { description: "Skills actually loaded via use_skill in this scope; loading in another scope does not bind them here." })), contributing_scopes: Type.Optional(Type.Array(Type.Object({ scope_id: Type.String(), category: Type.Optional(Type.String()), skill_refs: strings, purpose: Type.String() }, { additionalProperties: true }))), kind: Type.String({ minLength: 1, pattern: "\\S", description: "html_generate requires html_page (even for a design document); image methods use image. Describe its domain purpose in purpose." }), purpose: Type.String({ minLength: 1, pattern: "\\S" }), acceptance_test: Type.String({ minLength: 1, pattern: "\\S" }), required: Type.Boolean(), file: Type.String({ minLength: 1, pattern: version === 2 ? "^artifacts/" : "\\S", description: "Exact Run-relative output, e.g. artifacts/cabin-interior/xinjiang.png" }) }, { additionalProperties: true }), { minItems: 1 }),
    presentation: Type.Object({ mode: Type.Union([Type.Literal("html"), Type.Literal("gallery")]), entry: Type.String({ minLength: 1, pattern: "\\S" }) }, { additionalProperties: true }),
    acceptanceNotes: Type.Optional(Type.String()), executionNotes: Type.Optional(Type.String()),
  }, { additionalProperties: false });
  if (version !== 2) return schema;
  const execution = schema.properties.tasks.items;
  const { id: _id, scope_id: _scope, category: _category, dependencies: _deps, ...executionFields } = execution.properties;
  const { tasks: _tasks, deliverables: _deliverables, ...fields } = schema.properties;
  return Type.Object({ ...fields, deliverables: Type.Array(Type.Object({
    ...schema.properties.deliverables.items.properties,
    execution: Type.Object({ ...executionFields, id: Type.Optional(Type.Never()), scope_id: Type.Optional(Type.Never()), category: Type.Optional(Type.Never()), dependencies: Type.Optional(Type.Never()), file: Type.Optional(Type.Never()), outputPath: Type.Optional(Type.Never()), skill_refs: Type.Optional(Type.Never()), uses: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })), interaction_requirements: Type.Optional(Type.Array(open)) }, { additionalProperties: true }),
    user_requested: Type.Boolean(),
    presentation: Type.Object({ required: Type.Boolean(), access: Type.Optional(Type.Union([Type.Literal("embed"), Type.Literal("link"), Type.Literal("download")])), rationale: Type.Optional(Type.String()) }, { additionalProperties: false }),
  }, { additionalProperties: true }), { minItems: 1 }) }, { additionalProperties: false });
}


/** Content-only invariants shared by working readiness and canonical storage. */
export function contextSemanticIssues(role: string, data: Record<string, unknown>) {
  const issues: { code: string; pointer: string; message: string }[] = [];
  const add = (pointer: string, message: string) => issues.push({ code: "invalid_context_semantics", pointer, message });
  if (role === "reviewer") {
    const review = data.assessment as Record<string, unknown> | undefined;
    const entries = Array.isArray(review?.issues) ? review.issues as Record<string, unknown>[] : [];
    if (review?.verdict === "fail" && !entries.some(issue => issue?.status === "open")) add("/assessment/issues", "a failed review requires an open issue");
    if (review?.verdict === "pass" && entries.some(issue => issue && ["blocking", "major"].includes(String(issue.severity)) && issue.status !== "resolved")) add("/assessment/issues", "a passed review cannot contain an unresolved blocking or major issue");
  }
  if (role === "designer" && Array.isArray(data.deliverables)) {
    const ids = new Set<unknown>();
    for (const [index, value] of data.deliverables.entries()) {
      const item = value as Record<string, unknown>;
      if (ids.has(item.id)) add(`/deliverables/${index}/id`, `Duplicate deliverable id ${item.id}`);
      ids.add(item.id);
      if (!item.execution) continue; // Historical version.
      const execution = item.execution as Record<string, unknown>;
      if (execution.method === "html_generate" && item.kind !== "html_page") add(`/deliverables/${index}/kind`, "html_generate requires kind html_page, including HTML design documents; describe the document's purpose in purpose");

      const presentation = item.presentation as Record<string, unknown> | undefined;
      if (item.user_requested === true && item.required !== true) add(`/deliverables/${index}/required`, "User-requested outputs require production as well as presentation access");
      if (item.user_requested === true && presentation?.required !== true) add(`/deliverables/${index}/presentation`, "User-requested outputs must be accessible from presentation; review severity cannot waive this requirement");
      if (presentation?.required === true && !presentation.access) add(`/deliverables/${index}/presentation/access`, "Declare embed, link or download access");
      if (presentation?.required === false && !(typeof presentation.rationale === "string" && presentation.rationale.trim())) add(`/deliverables/${index}/presentation/rationale`, "Explain why this output is internal/supporting only");
      for (const field of ["method", "size"]) if (field in item) add(`/deliverables/${index}/${field}`, `Keep ${field} only in execution`);
    }
  }
  if (role === "designer" && data.strategy && typeof data.strategy === "object") {
    for (const key of ["runId", "schemaVersion", "design_system_ref", "execution_plan", "image_generation_plan", "deliverables", "presentation"])
      if (key in data.strategy) add(`/strategy/${key}`, "belongs to the root model, not strategy");
  }
  return issues;
}
