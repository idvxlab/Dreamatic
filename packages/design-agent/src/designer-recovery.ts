import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { briefDesignScopes } from "./design-categories.js";
import { deliveryContract, htmlTask, physicalRunFile, validateDeliveryContract, runPath, taskIdentityIssues, approvedImageEdit, approvedImageAcceptance, record } from "./design-contract.js";
import { imageOutputFormat } from "./image-output.js";
import { assertImageSizeWithinCeiling } from "./image-size.js";
import { lintHtmlSourceDependencies, lintHtmlSourceResources } from "./html-delivery.js";

export function designerHandoffError(task: string, brief: Record<string, unknown>): string | undefined {
  if (!briefDesignScopes(brief).some((scope) => scope.category === "ux")) return;
  if (/不需要编写\s*HTML|HTML代码[（(]Builder|(?:do not|don't|no need to)\s+(?:write|author)\s+(?:any\s+)?HTML/i.test(task)) return "UX Designer owns complete HTML/CSS/JS sources. Builder mechanically materializes them. Remove the conflicting no-HTML instruction before dispatching Designer.";
}

/** Read-only draft diagnostics. File existence is never approval, and no prior Skill is activated here. */
export async function designerDraftReadiness(runDir: string) {
  const issues: string[] = [];
  const read = async (path: string) => { try { return JSON.parse(await readFile(await physicalRunFile(runDir, path), "utf8")) as Record<string, unknown>; } catch { issues.push(`${path}: missing or invalid JSON`); return undefined; } };
  const plan = await read("plan/design_plan.json"), manifest = await read("plan/deliverable_manifest.json");
  if (plan && manifest) {
    try { const contract = deliveryContract(plan, manifest); await validateDeliveryContract(runDir, contract); issues.push(...await lintHtmlSourceDependencies(runDir, contract)); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
    const deliverables = Array.isArray(manifest.deliverables) ? manifest.deliverables : [];
    if ((manifest.schemaVersion === 2 || plan.schemaVersion === 2) && Array.isArray(plan.execution_plan)) {
      try { issues.push(...taskIdentityIssues(plan.execution_plan.map((item) => record(item, "execution task")), deliverables.map((item) => record(item, "deliverable")))); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
    }
    for (const [index, item] of deliverables.entries()) {
      const label = `plan/deliverable_manifest.json.deliverables[${index}] (${String(item?.id ?? "missing id")})`;
      if (!item || typeof item !== "object" || Array.isArray(item)) { issues.push(`${label} must be an object`); continue; }
      try {
        const file = runPath(item.file, "artifacts", `${label}.file`);
        if (["image_generate", "image_edit"].includes(item.method)) imageOutputFormat(file, `${label}.file`);
      } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
      for (const key of ["purpose", "acceptance_test", "kind"]) if (typeof item[key] !== "string" || !item[key].trim()) issues.push(`${label}.${key} must be a non-empty string`);
      if (typeof item.required !== "boolean") issues.push(`${label}.required must be boolean`);
    }
    const key = plan.schemaVersion === 2 ? "execution_plan" : "image_generation_plan";
    for (const [index, item] of (Array.isArray(plan[key]) ? plan[key] : []).entries()) {
      const label = `plan/design_plan.json.${key}[${index}] (${String(item?.id ?? item?.deliverable_id ?? "missing id")})`;
      if (!item || typeof item !== "object" || Array.isArray(item)) { issues.push(`${label} must be an object`); continue; }
      if (item.method === "html_generate") continue;
      if (item.method === "image_edit") try { approvedImageEdit(item); } catch (error) { issues.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
      const deliverable = deliverables.find((entry) => entry?.id === item.id);
      if (!deliverable && plan.schemaVersion !== 2) issues.push(`${label}.id must match a deliverables[].id; use the identical id in both files`);
      const missing = ["prompt_seed", "negative_prompt_seed", "size", "size_rationale"].filter((field) => typeof item[field] !== "string" || !item[field].trim());
      if (missing.length) issues.push(`${label}: required fields must be non-empty strings: ${missing.join(", ")}`);
      if (plan.schemaVersion === 2 && missing.includes("size") && Array.isArray(plan.image_generation_plan)) {
        const legacyIndex = plan.image_generation_plan.findIndex((entry) => entry?.id === (item.id ?? item.deliverable_id));
        const legacy = plan.image_generation_plan[legacyIndex];
        if (typeof legacy?.size === "string") try { assertImageSizeWithinCeiling(legacy.size, `plan/design_plan.json.image_generation_plan[${legacyIndex}].size (legacy specification to retain/copy)`); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
      }
      if (typeof item.size === "string" && item.size.trim()) {
        try { assertImageSizeWithinCeiling(item.size, `${label}.size`); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
        if (deliverable?.size !== item.size) issues.push(`${label}.size must match plan/deliverable_manifest.json deliverable ${String(item.id)}.size`);
      }
      if (deliverable) try { approvedImageAcceptance(item, deliverable); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
    }
    if (plan.schemaVersion === 2 && Array.isArray(plan.execution_plan)) for (const task of plan.execution_plan) {
      if (task?.method !== "html_generate") continue;
      try { htmlTask(task); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
      // Source diagnostics remain available even when a viewport or unrelated image task is invalid.
      for (const [index, mapping] of (Array.isArray(task.files) ? task.files : []).entries()) try {
        const source = runPath(mapping?.source, "plan");
        if (!(await stat(await physicalRunFile(runDir, source))).size) throw new Error("empty source");
        issues.push(...await lintHtmlSourceResources(runDir, { id: task.id, files: [{ source, output: String(mapping.output) }] }));
      } catch (error) { issues.push(`${task.id}.files[${index}]: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  return { ok: issues.length === 0, issues: [...new Set(issues.flatMap((issue) => issue.split("\n")).filter(Boolean))], instruction: "Repair the specific plan/source fields before publication. Retain all images and exact prompts. For schema v2 use one execution task per image deliverable, then an HTML task depending on their ids. Read and correct existing drafts; do not just retry the completion envelope. Reload every retained Skill in a fresh invocation." };
}

/** Publication envelope changes do not reset a deterministic draft failure. */
export async function designerDraftFingerprint(runDir: string, activeSkills: unknown) {
  const hash = createHash("sha256");
  const files = ["plan/design_plan.json", "plan/deliverable_manifest.json", "plan/design_system.json"];
  const plan = await physicalRunFile(runDir, files[0]!).then((path) => readFile(path, "utf8")).then(JSON.parse).catch(() => ({}));
  for (const task of Array.isArray(plan.execution_plan) ? plan.execution_plan : []) if (task?.method === "html_generate") for (const file of Array.isArray(task.files) ? task.files : []) if (typeof file?.source === "string" && file.source.startsWith("plan/") && !file.source.split("/").includes("..")) files.push(file.source);
  for (const file of [...new Set(files)].sort()) hash.update(file).update(await physicalRunFile(runDir, file).then((path) => readFile(path)).catch(() => "missing"));
  return hash.update(JSON.stringify(activeSkills)).digest("hex");
}

/** Count unresolved diagnostic issues, so unrelated draft/envelope edits cannot buy more retries. */
export function designerFailureAttempts(previous: Record<string, unknown> | undefined, issues: string[]) {
  const counts = previous?.failureAttempts && typeof previous.failureAttempts === "object" ? previous.failureAttempts as Record<string, unknown> : {};
  const previousIssues = typeof previous?.issue === "string" ? previous.issue.split("\n") : [];
  const failureAttempts = Object.fromEntries(issues.map((issue) => {
    const key = createHash("sha256").update(issue).digest("hex");
    const prior = Number(counts[key] ?? (previousIssues.includes(issue) ? previous?.attempts : 0));
    return [key, (Number.isSafeInteger(prior) && prior > 0 ? prior : 0) + 1];
  }));
  return { attempts: Math.max(1, ...Object.values(failureAttempts)), failureAttempts };
}
