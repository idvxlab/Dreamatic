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
  const str = (value: unknown, pointer: string) => { if (typeof value !== "string" || !value.trim()) fail(pointer, "must be a non-empty string"); };
  const arr = (value: unknown, pointer: string): unknown[] => { if (!Array.isArray(value)) return fail(pointer, "must be an array"); return value; };
  if (data.schemaVersion !== 1) fail("/schemaVersion", "must be 1; the internal execution schema version is not the document version");
  if (data.runId !== runId) fail("/runId", "must match the assigned Run");
  if (!Number.isSafeInteger(data.revision) || Number(data.revision) < 1) fail("/revision", "must be a positive integer");
  const allowed: Record<string, string[]> = {
    [CONTEXT_FILES.project]: ["brief"], [CONTEXT_FILES.research]: ["evidence", "findings", "usageConditions"],
    [CONTEXT_FILES.design]: ["system", "strategy", "tasks", "deliverables", "presentation", "acceptanceNotes", "executionNotes"],
    [CONTEXT_FILES.review]: ["assessment", "intentCoverage"],
  };
  if (!allowed[path]) fail("", "unknown Context document");
  for (const key of Object.keys(data)) if (!["schemaVersion", "runId", "revision", ...allowed[path]!].includes(key)) {
    const section = path === CONTEXT_FILES.review ? "assessment" : path === CONTEXT_FILES.research ? "evidence" : "system or strategy";
    fail(`/${key}`, `unexpected root field; domain fields belong inside ${section}. For reviews move verdict/review_stage/round/summary/issues/risks into assessment and use assessment.scores for scores`);
  }
  if (path === CONTEXT_FILES.project) { obj(data.brief, "/brief"); return; }
  if (path === CONTEXT_FILES.research) {
    const evidence = obj(data.evidence, "/evidence");
    str(evidence.target, "/evidence/target"); str(evidence.summary, "/evidence/summary");
    arr(evidence.official_sources, "/evidence/official_sources"); arr(evidence.open_questions, "/evidence/open_questions");
    str(data.findings, "/findings"); str(data.usageConditions, "/usageConditions"); return;
  }
  if (path === CONTEXT_FILES.review) {
    const review = obj(data.assessment, "/assessment");
    if (review.review_stage !== "design_context") fail("/assessment/review_stage", 'must be "design_context"');
    if (!["pass", "fail"].includes(String(review.verdict))) fail("/assessment/verdict", 'must be "pass" or "fail"');
    if (!Number.isSafeInteger(review.round) || Number(review.round) < 1) fail("/assessment/round", "must be a positive integer");
    str(review.summary, "/assessment/summary"); obj(review.scores, "/assessment/scores");
    const issues = arr(review.issues, "/assessment/issues").map((issue, index) => obj(issue, `/assessment/issues/${index}`));
    arr(review.resolved_issue_ids, "/assessment/resolved_issue_ids"); arr(review.remaining_risks, "/assessment/remaining_risks");
    if (review.verdict === "fail" && !issues.some(issue => issue.status === "open")) fail("/assessment/issues", "a failed review requires an open issue");
    if (review.verdict === "pass" && issues.some(issue => ["blocking", "major"].includes(String(issue.severity)) && issue.status !== "resolved")) fail("/assessment/issues", "a passed review cannot contain an unresolved blocking or major issue");
    return;
  }
  const system = obj(data.system, "/system"), strategy = obj(data.strategy, "/strategy");
  str(system.system_thesis, "/system/system_thesis"); obj(system.palette, "/system/palette"); obj(system.typography, "/system/typography");
  str(strategy.design_intent, "/strategy/design_intent");
  const tasks = arr(data.tasks, "/tasks").map((task, index) => obj(task, `/tasks/${index}`));
  for (const [index, task] of tasks.entries()) {
    str(task.id, `/tasks/${index}/id`);
    if (!["manual", "image_generate", "image_edit", "html_generate"].includes(String(task.method))) fail(`/tasks/${index}/method`, "must be manual, image_generate, image_edit or html_generate");
  }
  const deliverables = arr(data.deliverables, "/deliverables");
  if (!deliverables.length) fail("/deliverables", "must not be empty");
  for (const [index, entry] of deliverables.entries()) {
    const item = obj(entry, `/deliverables/${index}`);
    for (const key of ["id", "kind", "purpose", "acceptance_test", "file"]) str(item[key], `/deliverables/${index}/${key}`);
    if (typeof item.required !== "boolean") fail(`/deliverables/${index}/required`, "must be boolean");
  }
  const presentation = obj(data.presentation, "/presentation");
  if (!["html", "gallery"].includes(String(presentation.mode))) fail("/presentation/mode", "must be html or gallery");
  str(presentation.entry, "/presentation/entry");
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
  const tasks = array(data.tasks, "design.tasks");
  const ids = new Set<string>();
  for (const task of tasks) { const id = text(task.id, "task.id"); if (ids.has(id)) contextField(path, "/tasks", `Duplicate task id: ${id}`); ids.add(id); }
  const deliverables: Record<string, unknown>[] = array(data.deliverables, "design.deliverables").map((item) => {
    if ("method" in item || "size" in item) contextField(path, "/deliverables", "Deliverable method/size are derived from its task; maintain them only in tasks");
    const task = tasks.find((entry) => entry.id === item.id);
    if (!task) contextField(path, "/tasks", `Deliverable ${String(item.id)} needs a task with the same id (manual tasks may contain only id/method)`);
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

export async function saveContextDocument(runDir: string, path: string, data: Record<string, unknown>, runId: string) {
  const projections = contextProjections(path, data, runId);
  // brief.json is runtime project metadata, not a specialist Context document.
  if (path === CONTEXT_FILES.project) await writeContextFile(runDir, "brief.json", projections["brief.json"]!);
  await writeContextFile(runDir, path, json(data));
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
  return source;
}

export async function syncProjectContext(runDir: string, brief: Record<string, unknown>) {
  const path = CONTEXT_FILES.project;
  const previous = await readFile(resolveInside(runDir, path), "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
  await saveContextDocument(runDir, path, { schemaVersion: 1, runId: brief.runId, revision: Number(previous?.revision ?? 0) + 1, brief }, String(brief.runId));
}

export const UNIFIED_CONTEXT_INSTRUCTION = `This Run uses unified context schemaVersion 1. Author only context/research.json (Researcher), context/design.json (Designer), context/review.json (Reviewer) with write_json/patch_json. All documents have runId and positive revision. Research: evidence object (existing evidence schema), findings and usageConditions Markdown strings. Design: system object (existing design-system fields), strategy object (existing design-plan descriptive fields including design_intent and skill_selection), tasks array (existing schema-v2 execution tasks; manual tasks allowed), deliverables array (existing fields except method/size, derived from matching task id), presentation object, optional acceptanceNotes/executionNotes. Review: assessment contains review_stage:"design_context", verdict:"pass"|"fail", positive round, summary, scores object, issues/resolved_issue_ids/remaining_risks arrays; none of those fields belong at the root. Optional intentCoverage. A failed verdict needs an open issue. A pass requires blocking/major issues resolved. Project contains runtime-owned brief. Old research/plan/review documents do not exist for this Run. Never read/write them or maintain a second report. Read canonical documents with design_context_read; use full:true with paths for details. Descriptions of existing execution schemas are field-level guidance only: execution_plan maps to tasks, descriptive plan fields to strategy, system fields to system, review fields to assessment. Never place design_system_ref/schemaVersion/runId inside strategy. Deliverables must omit method/size; maintain those only in matching tasks. Save each role document once per revision, including all its fields; do not overwrite it separately for each report section. Author HTML sources under plan/html as before. All original source, resource, Skill, approval and execution gates still apply. Use canonical context paths in completion artifactRefs, or omit artifactRefs. Increment revision in the SAME save/patch as the change. patch_json updates must be an actual array of {pointer,value} objects, never a JSON string; add {pointer:"/revision",value:currentRevision+1}. Never invent user confirmation.`;

/** Small valid nesting examples; content is illustrative, never evidence or approval. */
export function contextAuthoringExample(role: string, runId: string) {
  const envelope = { schemaVersion: 1, runId, revision: 1 };
  if (role === "researcher") return { runId, path: CONTEXT_FILES.research, data: { ...envelope, evidence: { target: "Actual researched subject", summary: "Evidence-backed summary", official_sources: [], open_questions: [] }, findings: "Source-linked findings and gaps", usageConditions: "Actual provenance and scoped usage conditions" } };
  if (role === "reviewer") return { runId, path: CONTEXT_FILES.review, data: { ...envelope, assessment: { review_stage: "design_context", verdict: "fail", round: 1, summary: "Illustrative diagnosis; replace with actual assessment", scores: {}, issues: [{ id: "example", severity: "major", status: "open", owner: "designer", diagnosis: "Replace with an actual issue" }], resolved_issue_ids: [], remaining_risks: [] } } };
  return { runId, path: CONTEXT_FILES.design, instruction: "Illustrative manual task only; use the actual image/HTML task contract and assigned scope/Skill ids. This is not a deliverable count or method recommendation.", data: { ...envelope, system: { system_thesis: "Actual design thesis", palette: {}, typography: {} }, strategy: { design_intent: "Actual user-aligned intent", skill_selection: [] }, tasks: [{ id: "example", method: "manual" }], deliverables: [{ id: "example", kind: "image", purpose: "Actual purpose", acceptance_test: "Observable criterion", required: true, file: "artifacts/example.png" }], presentation: { mode: "gallery", entry: "artifacts/00-gallery.html" } } };
}

export function legacyContextPrompt(source: string): string {
  return source.replace(/<!-- unified-context-start -->[\s\S]*?<!-- unified-context-end -->/gu, "");
}
