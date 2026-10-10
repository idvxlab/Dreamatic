import { designTasks, designDeliverables } from "./design-context-v2.js";
import { Check, Errors } from "typebox/value";
import { serializeJsonWrite } from "./performance.js";
import { roleContextSchema, contextSemanticIssues } from "./context-schema.js";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveInside } from "./paths.js";

export const CONTEXT_FILES = { project: "context/project.json", research: "context/research.json", design: "context/design.json", review: "context/review.json" } as const;
export const CONTEXT_OWNERS: Record<string, string> = { [CONTEXT_FILES.project]: "runtime", [CONTEXT_FILES.research]: "researcher", [CONTEXT_FILES.design]: "designer", [CONTEXT_FILES.review]: "reviewer" };
export const CONTEXT_PROJECTIONS = {
  researcher: ["research/evidence.json", "research/research-findings.md", "research/brand_lock.md"],
  designer: ["plan/design_system.json", "plan/design_plan.json", "plan/deliverable_manifest.json", "plan/acceptance_criteria.md", "plan/task_breakdown.md"],
  reviewer: ["review/design-review.json", "review/design-review.md"],
} as const;
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};
const array = (value: unknown, label: string): Record<string, unknown>[] => {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry) => object(entry, label));
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
};
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function contextField(path: string, pointer: string, message: string): never {
  throw new Error(`${path}#${pointer}: ${message}. Repair this canonical field; no legacy file is read or written.`);
}

/** Reject misplaced fields and incomplete envelopes before changing any durable bytes. */
export function validateContextDocument(path: string, data: Record<string, unknown>, runId: string): void {
  const fail = (pointer: string, message: string): never => contextField(path, pointer, message);
  const obj = (value: unknown, pointer: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail(pointer, "must be an object");
    return value as Record<string, unknown>;
  };
  if (data.schemaVersion !== 1 && !(path === CONTEXT_FILES.design && data.schemaVersion === 2)) fail("/schemaVersion", "unsupported Context document version");
  if (data.runId !== runId) fail("/runId", "must match the assigned Run");
  if (!Number.isSafeInteger(data.revision) || Number(data.revision) < 1) fail("/revision", "must be a positive integer");
  if (path === CONTEXT_FILES.project) {
    for (const key of Object.keys(data)) if (!["schemaVersion", "runId", "revision", "brief"].includes(key)) fail(`/${key}`, "unexpected root field");
    obj(data.brief, "/brief"); return;
  }
  const role = CONTEXT_OWNERS[path];
  if (!role) fail("", "unknown Context document");
  const { schemaVersion: _schema, runId: _run, revision: _revision, ...domain } = data;
  const schema = roleContextSchema(role!, Number(data.schemaVersion));
  for (const key of Object.keys(domain)) if (!Object.hasOwn(schema.properties, key)) fail(`/${key}`, `unexpected root field; supply named role fields${role === "reviewer" ? " inside assessment" : ""}`);
  if (!Check(schema, domain)) {
    const error = [...Errors(schema, domain)][0]!;
    const required = error.keyword === "required" ? error.params.requiredProperties[0] : undefined;
    fail(`${error.instancePath}${required ? `/${required}` : ""}`, error.message);
  }
  const semanticIssue = contextSemanticIssues(role!, domain)[0];
  if (semanticIssue) fail(semanticIssue.pointer, semanticIssue.message);
}

/** Translate internal execution labels into actionable canonical JSON pointers. */
export function canonicalContextError(source: string): string {
  const roots: Record<string, string> = {
    "review/design-review.json": "context/review.json#/assessment", "review/design-review.md": "context/review.json#/assessment",
    "research/evidence.json": "context/research.json#/evidence", "research/research-findings.md": "context/research.json#/findings", "research/brand_lock.md": "context/research.json#/usageConditions",
    "plan/design_system.json": "context/design.json#/system", "plan/design_plan.json": "context/design.json#/strategy", "plan/deliverable_manifest.json": "context/design.json#",
  };
  for (const [legacy, canonical] of Object.entries(roots)) source = source.replaceAll(legacy, canonical);
  source = source.replaceAll("context/design.json#/strategy.execution_plan", "context/design.json#/tasks");
  source = source.replace(/context\/(?:research|design|review)\.json#[A-Za-z0-9_/.\[\]-]*/gu, match => { const [path, pointer] = match.split("#"); return `${path}#${pointer!.replaceAll(".", "/").replace(/\[(\d+)\]/gu, "/$1")}`; });
  return source;
}

/** Validate the canonical model and derive execution/report views in memory only. */
export function contextProjections(path: string, data: Record<string, unknown>, runId: string): Record<string, string> {
  validateContextDocument(path, data, runId);
  if (path === CONTEXT_FILES.project) return { "brief.json": json(object(data.brief, "project.brief")) };
  if (path === CONTEXT_FILES.research) {
    const evidence = object(data.evidence, "research.evidence");
    return { "research/evidence.json": json({ ...evidence, runId }), "research/research-findings.md": text(data.findings, "research.findings"), "research/brand_lock.md": text(data.usageConditions, "research.usageConditions") };
  }
  if (path === CONTEXT_FILES.review) {
    const review = object(data.assessment, "review.assessment");
    return { "review/design-review.json": json({ ...review, runId }), "review/design-review.md": `# Design Review\n\n${String(review.summary ?? "")}\n\nVerdict: ${String(review.verdict ?? "pending")}\n\n${json(review)}` };
  }
  if (path !== CONTEXT_FILES.design) throw new Error(`Unknown context document: ${path}`);
  const system = object(data.system, "design.system"), strategy = object(data.strategy, "design.strategy");
  for (const key of ["runId", "schemaVersion", "design_system_ref", "execution_plan", "image_generation_plan", "deliverables", "presentation"]) if (key in strategy) contextField(path, `/strategy/${key}`, "belongs to the root model, not strategy");
  const tasks = designTasks(data);
  const ids = new Set<string>();
  for (const task of tasks) { const id = text(task.id, "task.id"); if (ids.has(id)) contextField(path, "/tasks", `Duplicate task id: ${id}`); ids.add(id); }
  const deliverables: Record<string, unknown>[] = data.schemaVersion === 2 ? designDeliverables(data) : array(data.deliverables, "design.deliverables").map((item) => {
    if ("method" in item || "size" in item) contextField(path, "/deliverables", "Deliverable method/size are derived from its task; maintain them only in tasks");
    const task = tasks.find((entry) => entry.id === item.id);
    if (!task) contextField(path, "/tasks", `Deliverable ${String(item.id)} needs a task with the same id`);
    return { ...item, method: task.method, ...(task.size === undefined ? {} : { size: task.size }) };
  });
  const plan = { ...strategy, runId, schemaVersion: 2, design_system_ref: "plan/design_system.json", execution_plan: tasks.filter((task) => task.method !== "manual") };
  const manifest = { runId, schemaVersion: 2, design_system_ref: "plan/design_system.json", deliverables, presentation: object(data.presentation, "design.presentation") };
  const criteria = deliverables.map((item) => `- ${String(item.id)}: ${String(item.acceptance_test ?? "")} (${String(item.file)}).`).join("\n");
  const execution = tasks.map((task) => `- ${String(task.id)}: ${String(task.method)}; dependencies: ${JSON.stringify(task.dependencies ?? [])}`).join("\n");
  return { "plan/design_system.json": json({ ...system, runId }), "plan/design_plan.json": json(plan), "plan/deliverable_manifest.json": json(manifest), "plan/acceptance_criteria.md": `# Acceptance Criteria\n\n${criteria}\n\n${String(data.acceptanceNotes ?? "")}\n`, "plan/task_breakdown.md": `# Execution Index\n\n${execution}\n\n${String(data.executionNotes ?? "")}\n` };
}

export async function hasUnifiedContext(runDir: string): Promise<boolean> {
  const brief = await readFile(resolveInside(runDir, "brief.json"), "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (brief?.contextFormat === "unified-v1") return true;
  try { const path = resolveInside(runDir, CONTEXT_FILES.project); resolveInside(await realpath(runDir), await realpath(path)); await readFile(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export async function writeContextFile(runDir: string, path: string, source: string): Promise<void> {
  const target = resolveInside(runDir, path);
  const physicalRoot = await realpath(runDir);
  let ancestor = dirname(target);
  while (true) {
    try { resolveInside(physicalRoot, await realpath(ancestor)); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ancestor = dirname(ancestor); }
  }
  await mkdir(dirname(target), { recursive: true });
  resolveInside(physicalRoot, await realpath(dirname(target)));
  // Reject an existing symlink target too; rename must never redirect writes.
  try { resolveInside(await realpath(runDir), await realpath(target)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, source); await rename(temporary, target); }
  finally { await unlink(temporary).catch(() => undefined); }
}

export function prepareContextDocument(runDir: string, path: string, data: Record<string, unknown>, runId: string) {
  const document = structuredClone(data);
  const projections = Object.freeze(contextProjections(path, document, runId));
  const source = json(document);
  return { projections, persist: async () => {
    if (path === CONTEXT_FILES.project) await writeContextFile(runDir, "brief.json", projections["brief.json"]!);
    await writeContextFile(runDir, path, source);
  } };
}
export async function saveContextDocument(runDir: string, path: string, data: Record<string, unknown>, runId: string) {
  await serializeJsonWrite(resolveInside(runDir, path), () => prepareContextDocument(runDir, path, data, runId).persist());
}

/** Read canonical data safely; unified runs never fall back to stale legacy Context files. */
export async function readRunContext(runDir: string, path: string): Promise<string> {
  const owner = Object.entries(CONTEXT_PROJECTIONS).find(([, paths]) => (paths as readonly string[]).includes(path))?.[0];
  if (owner && await hasUnifiedContext(runDir)) {
    const canonical = owner === "researcher" ? CONTEXT_FILES.research : owner === "designer" ? CONTEXT_FILES.design : CONTEXT_FILES.review;
    const data = object(JSON.parse(await readRunContext(runDir, canonical)), canonical);
    return contextProjections(canonical, data, String(data.runId))[path]!;
  }
  const target = resolveInside(runDir, path);
  resolveInside(await realpath(runDir), await realpath(target));
  return readFile(target, "utf8");
}

export async function assertContextDocument(runDir: string, path: string, runId: string) {
  const data = object(JSON.parse(await readRunContext(runDir, path)), path);
  contextProjections(path, data, runId);
}

/** Format-specific prompt view: old paths become field references, never writable files. */
export function unifiedContextPrompt(source: string): string {
  source = source.replace(/<!-- legacy-context-start -->[\s\S]*?<!-- legacy-context-end -->/gu, "");
  const fields: Record<string, string> = {
    "research/evidence.json": "context/research.json (evidence)",
    "research/research-findings.md": "context/research.json (findings)",
    "research/brand_lock.md": "context/research.json (usageConditions)",
    "plan/design_system.json": "context/design.json (system)",
    "plan/design_plan.json": "context/design.json (strategy and tasks)",
    "plan/deliverable_manifest.json": "context/design.json (deliverables and presentation)",
    "plan/acceptance_criteria.md": "context/design.json (deliverables[].acceptance_test and acceptanceNotes)",
    "plan/task_breakdown.md": "context/design.json (tasks and executionNotes)",
    "review/design-review.json": "context/review.json (assessment)",
    "review/design-review.md": "context/review.json (assessment.summary and issues)",
  };
  for (const [path, field] of Object.entries(fields)) source = source.replaceAll(path, field);

  source = source.replace(/(?<![A-Za-z0-9_./-])research-findings\.md(?![A-Za-z0-9_./-])/gu, "context/research.json (findings)")
    .replace(/(?<![A-Za-z0-9_./-])evidence\.json(?![A-Za-z0-9_./-])/gu, "context/research.json (evidence)");
  return source;
}

export async function syncProjectContext(runDir: string, brief: Record<string, unknown>) {
  const path = CONTEXT_FILES.project;
  const previous = await readFile(resolveInside(runDir, path), "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
  await saveContextDocument(runDir, path, { schemaVersion: 1, runId: brief.runId, revision: Number(previous?.revision ?? 0) + 1, brief }, String(brief.runId));
}

// Shared mechanics have one source; domain requirements and capabilities are role-specific.
export const UNIFIED_CONTEXT_INSTRUCTION = `Use the runtime's role-specific Context contract. design_context_read observes authoritative content without changing files. Expand canonical input with paths:["context/design.json"], select:{section:"tasks",ids:["actual-task-id"]}; follow files[].expansionReads/readArguments. Top-level section/ids/canonical select only your own working draft, never another role's input. Never write canonical Context through file tools, retired split files or companion reports. Preserve IDs, source paths, evidence and confirmed user requirements. Runtime owns project metadata, versions and completion receipts. Successful authoring commits do not publish completion or approve a design.`;

export function unifiedContextInstruction(role: string, version = 1): string {
  const base = UNIFIED_CONTEXT_INSTRUCTION;
  if (role === "orchestrator") return `Read authoritative Context through design_context_read with audience:"orchestrator"; use paths:["context/research.json"], paths:["context/design.json"] or paths:["context/review.json"], with full:true for needed details. Follow returned readArguments/expansionReads. Specialists own research/design/review authoring and source paths. Handoffs name canonical inputs, objectives, constraints and completion conditions. Runtime persists progress, handoffs and stage events. Use todo_write for progress, run_brief_update for confirmed changes during an active Run, and run_revision after completion. Delegate material extraction/import to Researcher. Export after build_done. Do not author specialist content.`;
  if (role === "builder") return `${base} Read with audience:"builder". Context is read-only for Builder; do not call authoring tools or select Designer Skills. Execute approved tasks and author only permitted artifacts/Gallery presentation. Use list_skills/use_skill to discover and load relevant Builder-compatible Gallery presentation Skills. Load showcase-layout as supporting knowledge before authoring a Gallery; Builder Skill receipts remain separate from Designer selections.`;
  const authoring = ` Author only your bound role through update_design_context({changes:{...named role fields}}), then commit_design_context({}). Update arguments are changes and optional reset only; omit runId/path/schemaVersion/revision and hashes. No JSON pointers, full-save or pointer/value envelopes. Put ALL role fields inside changes; use small section/item updates rather than regenerating whole documents. Objects merge by field; ordinary arrays replace when supplied; [] clears arrays; omitted fields remain. unsetFields deletes optional fields. changes:{} inspects working content without writing. Check saved and readiness; repair named issues using section/ids reads for complete working objects. Runtime checks versions and rejects stale updates until reread and reconciled. reset:true discards working changes only after a complete canonical:true read. Publish after a successful commit; publication performs required validation. Completion events may omit artifactRefs; runtime attaches required outputs.`;
  if (role === "researcher") return `${base}${authoring} Your fields are evidence, findings and usageConditions. No task/deliverable editing or Designer Skill loading belongs to Researcher. Tool-owned acquisition manifests remain separate.`;
  if (role === "reviewer") return `${base}${authoring} Your fields are assessment and optional intentCoverage. assessment contains review_stage, verdict, round, summary, scores, issues, resolved_issue_ids and remaining_risks. Diagnose the current specification against current evidence; do not edit tasks, select/reload Designer Skills or author replacement designs.`;
  if (role === "designer") {
    const shape = version === 2
      ? "Design contract v2: author system, strategy, deliverables, presentation and optional acceptanceNotes/executionNotes. Each deliverable owns id/scope_id/category/skill_refs/file/kind/purpose/acceptance_test/required/user_requested, execution:{method,...} and presentation:{required,access:embed|link|download,rationale}. required means production; presentation.required means user access. User-requested outputs require both. execution.uses references deliverable ids; runtime derives dependencies/resources. tasks is a read-only projection; never author tasks/removeTasks/replaceTasks or execution identity/scope. Put method/size only in execution. system owns typography/palette/consistency rules; strategy owns creative decisions. HTML outputs require kind:html_page, even when their purpose is a design document. Deliverables upsert by stable id; removeDeliverables deletes items, replaceDeliverables replaces a complete collection. Declare interactions once in execution.interaction_checks:[{name,viewport?:{min_width?,max_width?},steps:[{action,selector?,value?}]}]. No duplicate interaction_requirements/outcome assertions are required; optional requirements are descriptive notes. Commit ready content and publish; publication performs source validation. design_context_validate is an optional diagnostic, not an extra mandatory step after each commit. Source validation uses private placeholders and cannot replace final real-asset checks."
      : "Historical design contract v1: author system, strategy, tasks, deliverables, presentation and optional acceptanceNotes/executionNotes. Tasks/deliverables upsert by stable id; removeTasks/removeDeliverables delete items; replaceTasks/replaceDeliverables replace complete collections. Tasks own method/size; deliverables omit them. Runtime derives category and missing matching task scope. Existing Runs do not upgrade implicitly.";
    return `${base}${authoring} ${shape} Choose assigned scope_id and actually loaded skill_refs. contributing_scopes contains additional scopes only; [] clears it. Select Skills through use_skill with task-specific rationale; Every use_skill call loads exactly one name; all bindings:[{scopeId,role,rationale}] apply that same Skill to several scopes atomically, never different Skills. Runtime records skill_selection; never author it. Reload all retained primary/supporting Skills before committing in a fresh invocation. Persisted selections are evidence, not loaded knowledge.`;
  }
  throw new Error(`Unknown Context role: ${role}`);
}

export function legacyContextPrompt(source: string): string {
  return source.replace(/<!-- unified-context-start -->[\s\S]*?<!-- unified-context-end -->/gu, "");
}
