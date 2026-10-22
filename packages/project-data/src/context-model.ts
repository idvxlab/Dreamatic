import { readFile, realpath, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolveInside } from "./paths.js";
import { designTasks, designDeliverables } from "./design-views.js";
export const CONTEXT_FILES = { project: "context/project.json", research: "context/research.json", design: "context/design.json", review: "context/review.json" } as const;
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

function contextField(path: string, pointer: string, message: string): never { throw new Error(`${path}${pointer}: ${message}`); }
export function contextProjections(path: string, data: Record<string, unknown>, runId: string): Record<string, string> {
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

// Application metadata synchronization only; no role authoring or workflow execution.
export async function syncProjectContext(runDir: string, brief: Record<string, unknown>) {
  const path = resolveInside(runDir, CONTEXT_FILES.project);
  resolveInside(await realpath(runDir), await realpath(path));
  const previous = JSON.parse(await readFile(path, "utf8"));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ ...previous, revision: Number(previous.revision ?? 0) + 1, brief }, null, 2));
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
