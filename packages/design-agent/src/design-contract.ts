import { readRunContext, CONTEXT_FILES } from "./context-model.js";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { resolveInside } from "./paths.js";
import { validateUserAsset } from "./user-assets.js";
import { IMAGE_OUTPUT_FORMATS, imageOutputFormat } from "./image-output.js";

export const DESIGN_CAPABILITIES = [
  { method: "image_generate", output: "image", description: "Generate approved design imagery" },
  { method: "image_edit", output: "image", description: "Edit approved source imagery" },
  { method: "html_generate", output: "html", description: "Materialize approved HTML/CSS/JS source without redesign" },
] as const;

export interface SourceMapping { source: string; output: string }
export interface InteractionStep { action: "click" | "fill" | "press" | "expect_visible" | "expect_hidden" | "expect_text" | "expect_value"; selector: string; value?: string; match?: "any" | "all" | "unique" }
export interface HtmlTask {
  id: string;
  method: "html_generate";
  files: SourceMapping[];
  resources: SourceMapping[];
  dependencies: string[];
  interaction_checks: Array<{ name: string; page?: string; viewport?: { min_width?: number; max_width?: number }; steps: InteractionStep[] }>;
  viewports: Array<{ width: number; height: number }>;
}
export const GALLERY_ENTRY = "artifacts/00-gallery.html";
export interface Presentation { mode: "gallery" | "html"; entry: string }
export interface DeliveryContract {
  schemaVersion: 1 | 2;
  tasks: Record<string, unknown>[];
  deliverables: Record<string, unknown>[];
  presentation: Presentation;
}

export function record(value: unknown, label = "record"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}
export function runPath(value: unknown, root: string, label = "path"): string {
  const path = string(value, label);
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..") || !path.startsWith(`${root}/`)) throw new Error(`${label}: Path must stay under ${root}/: ${path}`);
  return path;
}
export function imagePlan(plan: Record<string, unknown>): Record<string, unknown>[] {
  const entries = plan.schemaVersion === 2 ? plan.execution_plan : plan.image_generation_plan;
  if (!Array.isArray(entries)) throw new Error(`${plan.schemaVersion === 2 ? "execution_plan" : "image_generation_plan"} must be an array`);
  return entries.map((entry) => record(entry, "execution task")).filter((task) => task.method !== "html_generate");
}
/** Read only declared criteria; manifest fallback is already part of the approved design. */
export function approvedImageAcceptance(entry: Record<string, unknown>, deliverable: Record<string, unknown>): string[] {
  const value = entry.acceptanceCriteria ?? entry.acceptance_criteria ?? entry.acceptance_test ?? entry.acceptance ?? deliverable.acceptance_test;
  const criteria = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : typeof value === "string" && value.trim() ? [value] : [];
  if (!criteria.length) throw new Error(`Plan ${String(entry.id)} needs declared acceptance criteria (acceptance_test, acceptanceCriteria, acceptance_criteria or acceptance; otherwise deliverable.acceptance_test)`);
  return criteria;
}

/** The same edit payload is checked before approval and consumed by execution.
 * reference_ids_or_paths is provenance, never pixel conditioning. */
export function approvedImageEdit(entry: Record<string, unknown>) {
  const list = (value: unknown, field: string): string[] => {
    const values = typeof value === "string" ? [value] : value;
    if (!Array.isArray(values) || !values.length || values.some((item) => typeof item !== "string" || !item.trim()))
      throw new Error(`Plan ${String(entry.id)} needs explicit ${field}; request specification correction before approval`);
    return values as string[];
  };
  const referenceImagePaths = list(entry.referenceImagePaths ?? entry.reference_image_paths, "referenceImagePaths (reference_ids_or_paths is provenance only)");
  const diagnosis = list(entry.diagnosis ?? entry.edit_diagnosis, "diagnosis");
  const changes = list(entry.changes ?? entry.edit_changes, "changes");
  const preserve = list(entry.preserve ?? entry.preservation_rules ?? entry.preservation, "preserve");
  // These are explicit copy instructions, not edits. A meaningful edit may still
  // preserve unrelated elements, and different assets may use different methods.
  if (changes.every((change) => /^(?:(?:copy|reuse|retain|keep|reproduce)\b.*(?:without (?:any )?(?:visual )?(?:modification|changes?)|unchanged|exactly|identical)|(?:原样|直接)(?:复制|复用|使用)|不(?:做|作|进行)?(?:任何)?(?:视觉)?(?:修改|改动))/i.test(change.trim())))
    throw new Error(`Plan ${String(entry.id)} declares image_edit but requests unchanged reuse. Import user material with user_asset_import and map inputs/user-assets/ directly; remove the redundant image producer. Do not use an image model to copy files.`);
  return { referenceImagePaths, diagnosis, changes, preserve };
}

/** Collect independent identity failures before path or payload validation can mask them. */
export function taskIdentityIssues(tasks: Record<string, unknown>[], deliverables: Record<string, unknown>[]): string[] {
  const issues: string[] = [], ids = new Set<string>();
  for (const [index, task] of tasks.entries()) {
    const label = `plan/design_plan.json execution_plan[${index}]`;
    if (typeof task.id !== "string" || !task.id.trim()) {
      issues.push(`${label}.id must be a non-empty string matching deliverables[].id.${task.deliverable_id ? ` Use id: ${JSON.stringify(task.deliverable_id)} instead of deliverable_id.` : ""}`);
      continue;
    }
    if (ids.has(task.id)) issues.push(`${label}.id: duplicate task ${task.id}`);
    ids.add(task.id);
    const deliverable = deliverables.find((item) => item.id === task.id);
    if (!deliverable) issues.push(`${label} (${task.id}): no matching deliverables[].id. Each image requires its own task with the same id as its deliverable; put prompts/sizes in execution_plan for schemaVersion 2. A group/batch id cannot replace the individual image tasks.`);
    else if (deliverable.method !== task.method) issues.push(`${label} (${task.id}).method must match deliverable ${task.id}.method`);
  }
  for (const item of deliverables) if (item.method !== "manual" && !ids.has(String(item.id))) issues.push(`deliverables.${item.id}: no execution_plan task. Retain its approved design and add the task with this exact id.`);
  if (issues.length) issues.push("SchemaVersion 2 requires one executable task per image with identical task/deliverable ids. Groups/deliverable_ids cannot replace tasks; retain/copy complete prompt_seed, negative_prompt_seed, size and size_rationale into execution_plan instead of relying on a legacy image_generation_plan array.");
  return issues;
}

/** Complete only deterministic presentation metadata while Designer saves a draft.
 * Never run this on publication/approved reads: receipts bind the saved bytes.
 * An HTML deliverable's file is its declared main page, not the first task file.
 */
export function normalizeDraftPresentation(manifest: Record<string, unknown>) {
  const normalizedFields: Record<string, string> = {}, issues: string[] = [];
  if (manifest.schemaVersion !== 2) return { normalizedFields, issues };
  const deliverables = Array.isArray(manifest.deliverables) ? manifest.deliverables : [];
  const validRecords = deliverables.every((item) => item && typeof item === "object" && !Array.isArray(item));
  let presentation: Record<string, unknown>;
  try { presentation = manifest.presentation === undefined ? {} : record(manifest.presentation, "plan/deliverable_manifest.json.presentation"); }
  catch (error) { return { normalizedFields, issues: [error instanceof Error ? error.message : String(error)] }; }
  if (presentation.mode === undefined) {
    const mode = validRecords && deliverables.length && deliverables.every((item) => ["image_generate", "image_edit"].includes(item.method)) ? "gallery"
      : validRecords && deliverables.length && deliverables.every((item) => item.method === "html_generate" && item.kind === "html_page") ? "html" : undefined;
    if (!mode) return { normalizedFields, issues: ["plan/deliverable_manifest.json.presentation.mode: mixed, manual or incomplete outputs require an explicit gallery/html presentation choice; the runtime cannot choose the intended Showcase."] };
    presentation.mode = mode;
    normalizedFields["/presentation/mode"] = mode;
  }
  if (!["gallery", "html"].includes(String(presentation.mode))) return { normalizedFields, issues: ["plan/deliverable_manifest.json.presentation.mode must be gallery or html"] };
  manifest.presentation = presentation;
  if (presentation.entry === undefined) {
    if (presentation.mode === "gallery") presentation.entry = GALLERY_ENTRY;
    else {
      const pages = validRecords ? deliverables.filter((item) => item.method === "html_generate" && item.kind === "html_page") : [];
      if (pages.length !== 1) return { normalizedFields, issues: [`plan/deliverable_manifest.json.presentation.entry: declare the intended HTML homepage explicitly when there are ${pages.length} HTML deliverables. Candidates: ${pages.map((item) => String(item.file)).join(", ") || "none"}. artifacts[] is a file list, not a homepage choice.`] };
      try {
        const entry = runPath(pages[0].file, "artifacts", "plan/deliverable_manifest.json.deliverables HTML page.file");
        if (!entry.endsWith(".html")) throw new Error("HTML page.file must be an HTML file");
        presentation.entry = entry;
      } catch (error) { return { normalizedFields, issues: [error instanceof Error ? error.message : String(error)] }; }
    }
    normalizedFields["/presentation/entry"] = String(presentation.entry);
  }
  // Preserve explicit invalid values for diagnosis; never silently change a choice.
  try {
    const entry = runPath(presentation.entry, "artifacts", "plan/deliverable_manifest.json.presentation.entry");
    if (!entry.endsWith(".html")) issues.push("plan/deliverable_manifest.json.presentation.entry must be an HTML file");
    if (presentation.mode === "gallery" && entry !== GALLERY_ENTRY) issues.push(`Gallery presentation uses ${GALLERY_ENTRY}`);
  } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
  return { normalizedFields, issues };
}

/** Runtime-discovered executable schema, separate from creative/design instructions. */
export function designSpecificationProtocol(sizeCeiling: string) {
  return {
    imageSizeCeiling: sizeCeiling, imageOutputExtension: ".png", imageOutputFormats: IMAGE_OUTPUT_FORMATS, imageOutputRule: "Default PNG; .png/.jpg/.jpeg select the actual saved encoding. b64_json/url select transport only. Builder binds the output path to deliverables[].file by id; omit outputPath instead of inventing or restating a path.",
    imageOnly: { schemaVersion: 1, imageTasks: "plan/design_plan.json.image_generation_plan" },
    typed: { schemaVersion: 2, imageTasks: "plan/design_plan.json.execution_plan", rule: "Same schemaVersion in plan and manifest. One task per deliverable with identical id; deliverable_id, groups and legacy prompt arrays do not substitute for executable tasks.", imageEditFields: ["referenceImagePaths", "diagnosis", "changes", "preserve"], imageEditRule: "image_edit requires a real visual change, explicit pixel sources and preservation rules. reference_ids_or_paths is provenance only. Unchanged reuse uses user_asset_import and HTML resources, never a generation/edit task for that same asset.", imageTaskFields: ["id", "scope_id", "category", "method", "prompt_seed", "negative_prompt_seed", "size", "size_rationale"], htmlSkill: "html-interface" },
    presentation: { gallery: { mode: "gallery", entry: GALLERY_ENTRY }, html: { mode: "html", entry: "artifacts/<scope-id>/index.html" }, rule: "entry is the single Showcase homepage, not an artifacts[] list. Designer saves deterministically fill a missing Gallery entry or the sole html_page deliverable.file before hashing. Pure image/HTML deliverables also determine a missing mode. Mixed/manual outputs require an explicit mode; multiple HTML deliverables require an explicit entry. Explicit choices are preserved and validated, never guessed from file order." },
    resourcePolicy: { researchAssets: "Researcher-discovered materials remain reference-only. Exception: explicitly user-provided URLs/uploads can be imported with user_asset_import and reused unchanged.", userMaterials: "Call user_asset_import(runId, source, sourcePageUrl?) before review. It verifies the user source and saves exact image/video/document bytes under inputs/user-assets/. Map its returned source to artifacts/<page>/assets/<file> in resources; no image producer dependency is needed. Never embed remote assets or copy arbitrary repository/research files.", pageImages: "Declare image_generate/image_edit tasks with complete prompts, sizes and acceptance. Map their artifacts/... outputs in HTML resources and include producer ids in dependencies. Designer-authored SVG/CSS/JS belongs in files.", approval: "All local references must resolve to declared outputs before publication and Reviewer approval, including lazy images and fallbacks.", builder: "Execute approved producers and HTML mappings; check paths, integrity and source equality. No second browser/visual/design audit." },
    publication: { artifactRefs: "Optional additional existing owned outputs or canonical read-only research inputs. Runtime always attaches validated Designer plan/source outputs. Changing the publication envelope cannot repair draft fields." },
  };
}

/** Canonical authoring protocol; execution schema versions are not storage versions. */
export function unifiedDesignSpecificationProtocol(sizeCeiling: string) {
  const { imageOnly: _legacy, typed, ...shared } = designSpecificationProtocol(sizeCeiling);
  return { ...shared,
    storage: { path: CONTEXT_FILES.design, schemaVersion: 1, fields: ["schemaVersion", "runId", "revision", "system", "strategy", "tasks", "deliverables", "presentation"], rule: "Save a single canonical document with write_json/patch_json. Positive increasing revision. No legacy files or design_system_ref. Method and size belong only to tasks; deliverables derive them from the same id." },
    typed: { ...typed, schemaVersion: 1, imageTasks: "context/design.json.tasks", rule: "One task per deliverable with identical id. Manual tasks are allowed; other tasks follow the typed execution fields. No execution_plan/image_generation_plan arrays in the saved model." },
    presentation: { ...shared.presentation, rule: "Declare presentation.mode and entry explicitly in context/design.json. Mixed/manual outputs require an explicit choice; multiple HTML outputs require an explicit entry." },
  };
}

export function deliveryContract(plan: Record<string, unknown>, manifest: Record<string, unknown>): DeliveryContract {
  if (plan.schemaVersion !== undefined && plan.schemaVersion !== 1 && plan.schemaVersion !== 2) throw new Error(`Unsupported design schemaVersion: ${String(plan.schemaVersion)}`);
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== (plan.schemaVersion ?? 1)) throw new Error("Plan and manifest schemaVersion must agree");
  if (!Array.isArray(manifest.deliverables)) throw new Error("deliverables must be an array");
  const deliverables = manifest.deliverables.map((item) => record(item, "deliverable"));
  const ids = new Set<string>();
  for (const deliverable of deliverables) {
    const id = string(deliverable.id, "deliverable.id");
    if (ids.has(id)) throw new Error(`Duplicate deliverable id: ${id}`);
    ids.add(id);
  }
  if (plan.schemaVersion !== 2) return { schemaVersion: 1, tasks: imagePlan(plan), deliverables, presentation: { mode: "gallery", entry: GALLERY_ENTRY } };
  if (!Array.isArray(plan.execution_plan)) throw new Error("execution_plan must be an array");
  const tasks = plan.execution_plan.map((item) => record(item, "execution task"));
  const issues: string[] = [];
  let presentation: Record<string, unknown> = {}, entry = "";
  try {
    presentation = record(manifest.presentation, "plan/deliverable_manifest.json.presentation");
    if (!["gallery", "html"].includes(String(presentation.mode))) issues.push("plan/deliverable_manifest.json.presentation.mode must be gallery or html");
    entry = runPath(presentation.entry, "artifacts", "plan/deliverable_manifest.json.presentation.entry");
    if (!entry.endsWith(".html")) issues.push("plan/deliverable_manifest.json.presentation.entry must be an HTML file");
  } catch (error) {
    issues.push(`${error instanceof Error ? error.message : String(error)}. Use presentation: {mode: "gallery", entry: "artifacts/00-gallery.html"} or {mode: "html", entry: "artifacts/<scope-id>/index.html"}; artifacts[] does not supply entry.`);
  }
  if (issues.length) throw new Error(issues.join("\n"));
  return { schemaVersion: 2, tasks, deliverables, presentation: { mode: presentation.mode as Presentation["mode"], entry } };
}
export function htmlTask(value: Record<string, unknown>): HtmlTask {
  const id = string(value.id, "task.id");
  if (value.method !== "html_generate") throw new Error("Expected html_generate task");
  if (!Array.isArray(value.files) || !value.files.length) throw new Error(`HTML task ${id} needs source files`);
  const mappings = (items: unknown, resource: boolean): SourceMapping[] => {
    if (!Array.isArray(items)) throw new Error("Source mappings must be arrays");
    return items.map((item, index) => {
      const label = `plan/design_plan.json execution_plan task ${id}.${resource ? "resources" : "files"}[${index}]`;
      const mapping = record(item, label);
      if (resource && (mapping.type === "external_url" || mapping.url !== undefined)) throw new Error(`${label}: external_url/url declarations are unsupported. resources must map a declared generated artifact with {source: "artifacts/<image-file>", output: "artifacts/<page>/images/<file>"} and depend on its producer. Research assets are reference-only; user_asset_import returns a trusted inputs/user-assets/... alternative for explicit user URLs/uploads. For Google Fonts, use system-font stacks and remove remote stylesheets/@import from HTML/CSS; adding a URL or license does not make it executable.`);
      const source = string(mapping.source, `${label}.source`);
      const output = runPath(string(mapping.output, `${label}.output`), "artifacts");
      if (resource) {
        if (!source.startsWith("artifacts/") && !source.startsWith("inputs/user-assets/")) throw new Error(`${label}: research/repository assets are reference-only, not delivery resources. Declare an image_generate/image_edit task, use its artifacts/... output here, and add its id to dependencies. For explicit user URLs/uploads, call user_asset_import and map its returned inputs/user-assets/... source. Author vector/UI code in plan/html/... files; use system fonts.`);
        runPath(source, source.startsWith("inputs/user-assets/") ? "inputs/user-assets" : "artifacts");
        if (source.startsWith("inputs/user-assets/") && source.split(".").at(-1)?.replace("jpeg", "jpg") !== output.split(".").at(-1)?.replace("jpeg", "jpg")) throw new Error(`${label}: imported material source/output extensions must agree; copying preserves original bytes`);
      } else {
        runPath(source, "plan/html");
        if (!/\.(html|css|js|json|svg)$/u.test(source)) throw new Error("HTML design sources must be HTML, CSS, JS, JSON or SVG");
      }
      if (["artifacts/artifact-manifest.json", "artifacts/lint-report.json"].includes(output) || output.includes("/.")) throw new Error("HTML output targets a runtime-owned path");
      if (/\.(html|css|js)$/u.test(source) && source.split(".").at(-1) !== output.split(".").at(-1)) throw new Error("Source/output extensions must agree");
      return { source, output };
    });
  };
  const checks = value.interaction_checks;
  if (!Array.isArray(checks)) throw new Error(`HTML task ${id} needs interaction_checks (empty only for a static page)`);
  const interaction_checks = checks.map((item, checkIndex) => {
    const check = record(item, "interaction check");
    const checkPath = `execution_plan.${id}.interaction_checks[${checkIndex}]`;
    if (check.min_width !== undefined || check.max_width !== undefined) throw new Error(`${checkPath}: put bounds inside check.viewport, not beside steps`);
    if (!Array.isArray(check.steps) || !check.steps.length) throw new Error("Interaction checks need steps");
    const steps = check.steps.map((item, stepIndex) => {
      const step = record(item, "interaction step");
      if (step.viewport !== undefined || step.min_width !== undefined || step.max_width !== undefined) throw new Error(`${checkPath}.steps[${stepIndex}]: viewport belongs on the whole interaction check, beside name and steps. Move viewport to ${checkPath}.viewport; step-level bounds are not supported and must not be silently ignored.`);
      if (!["click", "fill", "press", "expect_visible", "expect_hidden", "expect_text", "expect_value"].includes(String(step.action))) throw new Error("Unsupported interaction action");
      const action = step.action as InteractionStep["action"];
      const selector = string(step.selector, "step.selector");
      if (step.match !== undefined && (!["any", "all", "unique"].includes(String(step.match)) || !action.startsWith("expect_"))) throw new Error("match applies only to assertions and must be any, all or unique");
      if (["fill", "press", "expect_text", "expect_value"].includes(action) && typeof step.value !== "string") throw new Error(`${action} requires value`);
      return { action, selector, ...(typeof step.value === "string" ? { value: step.value } : {}), ...(step.match ? { match: step.match as NonNullable<InteractionStep["match"]> } : {}) };
    });
    const viewport = check.viewport === undefined ? undefined : record(check.viewport, "check.viewport");
    if (viewport) {
      if (!Object.keys(viewport).length || Object.keys(viewport).some((key) => !["min_width", "max_width"].includes(key))) throw new Error(`${checkPath}.viewport accepts only min_width and max_width; declare actual viewport dimensions in task.viewports`);
      for (const key of ["min_width", "max_width"]) if (viewport[key] !== undefined && (!Number.isInteger(viewport[key]) || Number(viewport[key]) < 240 || Number(viewport[key]) > 3840)) throw new Error(`${checkPath}.viewport.${key} must be 240–3840 pixels; omit min_width for an unbounded lower limit rather than using 0`);
      if (Number(viewport.min_width ?? 240) > Number(viewport.max_width ?? 3840)) throw new Error("Check viewport bounds are reversed");
    }
    return { name: string(check.name, "check.name"), ...(check.page === undefined ? {} : { page: runPath(check.page, "artifacts") }), ...(viewport ? { viewport: viewport as { min_width?: number; max_width?: number } } : {}), steps };
  });
  if (value.dependencies !== undefined && (!Array.isArray(value.dependencies) || value.dependencies.some((id) => typeof id !== "string"))) throw new Error("dependencies must be task ids");
  const viewports = value.viewports ?? [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
  if (!Array.isArray(viewports) || !viewports.length || viewports.length > 6) throw new Error("HTML task needs one to six viewports");
  for (const check of interaction_checks) if (check.viewport && !viewports.some((item) => {
    const width = Number(record(item, "viewport").width);
    return width >= (check.viewport?.min_width ?? 240) && width <= (check.viewport?.max_width ?? 3840);
  })) throw new Error(`Interaction check ${check.name} applies to no declared viewport`);
  return { id, method: "html_generate", files: mappings(value.files, false), resources: mappings(value.resources ?? [], true), dependencies: (value.dependencies ?? []) as string[], interaction_checks, viewports: viewports.map((item) => {
    const viewport = record(item, "viewport");
    for (const key of ["width", "height"]) if (!Number.isInteger(viewport[key]) || Number(viewport[key]) < 240 || Number(viewport[key]) > 3840) throw new Error("Viewport dimensions must be 240–3840 pixels");
    return { width: viewport.width as number, height: viewport.height as number };
  }) };
}

/** Resolve physical paths as well as lexical paths; drafts and resources cannot escape their Run. */
export async function physicalRunFile(runDir: string, path: string): Promise<string> {
  const absolute = resolveInside(runDir, path);
  const root = await realpath(runDir);
  const physical = await realpath(absolute);
  resolveInside(root, physical);
  if (!(await stat(physical)).isFile()) throw new Error(`Not a file: ${path}`);
  return absolute;
}
export async function validateDeliveryContract(runDir: string, contract: DeliveryContract): Promise<void> {
  if (contract.schemaVersion === 1) return;
  const ids = new Set<string>();
  // Resolve identity before using paths, so unmatched batch ids cannot masquerade as missing paths.
  const identityIssues = taskIdentityIssues(contract.tasks, contract.deliverables);
  if (identityIssues.length) throw new Error(identityIssues.join("\n"));
  ids.clear();
  const outputs = new Map<string, string>();
  const producers = new Map<string, string>();
  for (const task of contract.tasks) {
    const deliverable = contract.deliverables.find((item) => item.id === task.id);
    const files = task.method === "html_generate" ? htmlTask(task).files : [{ source: runPath(string(deliverable?.file, `deliverables.${String(task.id)}.file`), "artifacts"), output: runPath(string(deliverable?.file, `deliverables.${String(task.id)}.file`), "artifacts") }];
    for (const file of files) {
      if (outputs.has(file.output)) throw new Error(`Duplicate output: ${file.output}`);
      outputs.set(file.output, file.source); producers.set(file.output, String(task.id));
    }
  }
  for (const task of contract.tasks) {
    const id = string(task.id, "task.id");
    if (ids.has(id)) throw new Error(`Duplicate execution task: ${id}`);
    ids.add(id);
    if (!DESIGN_CAPABILITIES.some((capability) => capability.method === task.method)) throw new Error(`Unsupported executor: ${String(task.method)}`);
    const deliverable = contract.deliverables.find((item) => item.id === id);
    if (!deliverable || deliverable.method !== task.method) throw new Error(`Task ${id} does not match its deliverable`);
    if (task.method !== "html_generate") approvedImageAcceptance(task, deliverable);
    if (task.method === "image_edit") {
      const edit = approvedImageEdit(task);
      for (const source of edit.referenceImagePaths) {
        const producer = producers.get(source);
        if (producer) {
          if (!Array.isArray(task.dependencies) || !task.dependencies.includes(producer)) throw new Error(`Image edit ${id} source ${source} needs its producing task in dependencies`);
        } else await physicalRunFile(runDir, source);
      }
    }
    if (task.method !== "html_generate") imageOutputFormat(String(deliverable.file), `Image task ${id} output`);
    if (task.method === "html_generate") {
      if (deliverable.kind !== "html_page") throw new Error(`HTML task ${id} requires kind html_page`);
      const html = htmlTask(task);
      if (!html.files.some((mapping) => mapping.output === deliverable.file && mapping.output.endsWith(".html"))) throw new Error(`HTML task ${id} must produce its declared page entry`);
      for (const mapping of [...html.files, ...html.resources]) {
        const owner = outputs.get(mapping.output);
        if (html.resources.includes(mapping) && owner && owner !== mapping.source && mapping.source !== mapping.output) throw new Error(`Duplicate output: ${mapping.output}`);
        if (!owner) outputs.set(mapping.output, mapping.source);
        if (mapping.source.startsWith("artifacts/")) {
          const producer = producers.get(mapping.source);
          if (!producer || !html.dependencies.includes(producer)) throw new Error(`HTML resource ${mapping.source} needs its producing task in dependencies`);
          if (html.resources.includes(mapping) && !["image_generate", "image_edit"].includes(String(contract.tasks.find((item) => item.id === producer)?.method))) throw new Error(`HTML resource ${mapping.source} must come from an approved image_generate/image_edit producer. Designer-authored SVG/CSS/JS belongs in files.`);
        } else {
          if (mapping.source.startsWith("inputs/user-assets/")) await validateUserAsset(runDir, mapping.source);
          await physicalRunFile(runDir, mapping.source);
        }
      }
      for (const check of html.interaction_checks) if (check.page && !html.files.some((mapping) => mapping.output === check.page)) throw new Error(`Check page is not owned by task ${id}`);
    }
  }
  for (const deliverable of contract.deliverables) if (deliverable.method !== "manual" && !ids.has(String(deliverable.id))) throw new Error(`Deliverable ${String(deliverable.id)} has no execution task`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Execution plan has cyclic dependencies");
    if (visited.has(id)) return;
    visiting.add(id);
    const task = contract.tasks.find((item) => item.id === id)!;
    const deps = task.dependencies ?? [];
    if (!Array.isArray(deps)) throw new Error("dependencies must be an array");
    for (const dep of deps) { if (typeof dep !== "string" || !ids.has(dep)) throw new Error(`Unknown dependency: ${String(dep)}`); visit(dep); }
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  if (contract.presentation.mode === "html" && !contract.tasks.some((task) => task.method === "html_generate" && htmlTask(task).files.some((file) => file.output === contract.presentation.entry))) throw new Error("HTML presentation must reference a declared HTML output");
  if (contract.presentation.mode === "gallery" && contract.presentation.entry !== GALLERY_ENTRY) throw new Error("Gallery presentation uses artifacts/00-gallery.html");
}
export async function designSourceFiles(runDir: string): Promise<string[]> {
  const plan = JSON.parse(await readRunContext(runDir, "plan/design_plan.json")) as Record<string, unknown>;
  if (plan.schemaVersion !== 2) return [];
  if (!Array.isArray(plan.execution_plan)) throw new Error("execution_plan must be an array");
  return [...new Set(plan.execution_plan.map((item) => record(item)).filter((task) => task.method === "html_generate").flatMap((task) => {
    const html = htmlTask(task);
    return [...html.files, ...html.resources.filter((file) => !file.source.startsWith("artifacts/"))].map((file) => file.source).concat(html.resources.some((file) => file.source.startsWith("inputs/user-assets/")) ? [".performance/user-materials.json"] : []);
  }))];
}
export async function fileHash(runDir: string, path: string): Promise<string> {
  return createHash("sha256").update(await readFile(await physicalRunFile(runDir, path))).digest("hex");
}
export async function assertSafeOutput(runDir: string, path: string): Promise<string> {
  runPath(path, "artifacts");
  const absolute = resolveInside(runDir, path);
  let parent = absolute;
  while (true) {
    try { resolveInside(await realpath(runDir), await realpath(parent)); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; parent = dirname(parent); }
  }
  return absolute;
}
