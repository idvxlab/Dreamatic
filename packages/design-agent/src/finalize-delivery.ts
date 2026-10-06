import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deliveryContract, fileHash, htmlTask, physicalRunFile, validateDeliveryContract } from "./design-contract.js";
import { lintGalleryPresentation, lintHtmlDelivery } from "./html-delivery.js";
import { appendShowcaseReferences, annotateShowcasePrompts } from "./showcase.js";
import { imageBytesMatchPath, imageOutputFormat } from "./image-output.js";
import { resolveInside } from "./paths.js";
import { BuildIncomplete, DeliveryBlocked } from "./delivery-block.js";

/** Presentation is a viewing entry, not a filter on the approved deliverables. */
export async function pendingRequiredOutputs(runDir: string, contract: ReturnType<typeof deliveryContract>) {
  const pending: Array<{ id: string; method: string; files: string[] }> = [];
  for (const deliverable of contract.deliverables.filter((item) => item.required === true)) {
    const task = contract.tasks.find((item) => item.id === deliverable.id);
    const files = [String(deliverable.file), ...(task?.method === "html_generate" ? [...htmlTask(task).files, ...htmlTask(task).resources].map((file) => file.output) : [])];
    const missing: string[] = [];
    for (const file of new Set(files)) if (!await physicalRunFile(runDir, file).then(async (path) => (await stat(path)).size > 0).catch(() => false)) missing.push(file);
    if (missing.length) pending.push({ id: String(deliverable.id), method: String(deliverable.method), files: missing });
  }
  return pending;
}

/** New typed delivery finalization is isolated from the v2.0.2 image/Gallery path. */
export async function finalizeDelivery(runDir: string, runId: string, signal?: AbortSignal) {
  const plan = JSON.parse(await readFile(join(runDir, "plan/design_plan.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(runDir, "plan/deliverable_manifest.json"), "utf8"));
  const contract = deliveryContract(plan, manifest);
  await validateDeliveryContract(runDir, contract);
  const pending = await pendingRequiredOutputs(runDir, contract);
  if (pending.length) throw new BuildIncomplete(pending);
  const artifacts: Array<Record<string, unknown> & { path: string; deliverableId: unknown }> = [];
  for (const deliverable of contract.deliverables) {
    const path = String(deliverable.file);
    const info = await physicalRunFile(runDir, path).then(stat).catch(() => undefined);
    if (!info?.size) { if (deliverable.required === true) throw new Error(`Required build output is missing or empty: ${path}`); continue; }
    const generatedImage = ["image_generate", "image_edit"].includes(String(deliverable.method));
    if (generatedImage && !imageBytesMatchPath(await readFile(await physicalRunFile(runDir, path)), path)) throw new DeliveryBlocked("runtime", [`Image encoding does not match the declared output path: ${path}. Use the image output encoder; do not rename bytes or change the approved manifest.`]);
    const mimeType = generatedImage ? imageOutputFormat(path) === "png" ? "image/png" : "image/jpeg" : undefined;
    artifacts.push({ ...(mimeType ? { mimeType } : {}), deliverableId: deliverable.id, path, method: deliverable.method, scope_id: deliverable.scope_id, category: deliverable.category, skill_refs: deliverable.skill_refs, contributing_scopes: deliverable.contributing_scopes, bytes: info.size, sha256: await fileHash(runDir, path), provenance: { plan: "plan/design_plan.json" }, executionResult: "created" });
  }
  const completed = { ...contract, tasks: contract.tasks.filter((task) => artifacts.some((artifact) => artifact.deliverableId === task.id)) };
  for (const task of completed.tasks.filter((item) => item.method === "html_generate")) {
    const html = htmlTask(task);
    for (const file of [...html.files, ...html.resources]) if (await fileHash(runDir, file.source) !== await fileHash(runDir, file.output)) throw new Error(`HTML output differs from approved source: ${file.output}. Execute the approved task; do not redesign it.`);
  }
  const artifactsDir = resolveInside(runDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  if (contract.presentation.mode === "gallery") {
    const galleryPath = resolveInside(runDir, contract.presentation.entry);
    const gallery = await readFile(galleryPath, "utf8").catch(() => "");
    if (!gallery.trim()) throw new Error("Builder must author artifacts/00-gallery.html before finalization");
    await writeFile(galleryPath, await appendShowcaseReferences(runDir, await annotateShowcasePrompts(runDir, gallery)));
  }
  const lint = await lintHtmlDelivery(runDir, completed);
  if (contract.presentation.mode === "gallery") {
    lint.issues.push(...await lintGalleryPresentation(runDir, contract.presentation.entry));
    lint.ok = lint.issues.length === 0;
  }
  if (!await physicalRunFile(runDir, contract.presentation.entry).then(async (path) => (await stat(path)).size > 0).catch(() => false)) { lint.ok = false; lint.issues.push("Presentation entry is missing or empty"); }
  // Source interaction/viewport validation belongs to Designer publication and Reviewer approval.
  // Builder validates exact approved output bytes and resource/file integrity only.
  const browser = { status: "not_run", passed: false, issues: [] as string[], reason: "Builder performs integrity checks only; source interactions are validated before approval." };
  const lintReport = { runId, ...lint, browser };
  await writeFile(join(artifactsDir, "lint-report.json"), JSON.stringify(lintReport, null, 2));
  if (!lint.ok) throw new DeliveryBlocked("designer", lint.issues);
  const artifactManifest = { schemaVersion: 2, runId, generatedAt: new Date().toISOString(), presentation: contract.presentation, previewFiles: lint.files, htmlEntries: completed.tasks.filter((task) => task.method === "html_generate").flatMap((task) => htmlTask(task).files.filter((file) => file.output.endsWith(".html")).map((file) => file.output)), qualityEvidence: { designSpec: "reviewed", fileIntegrity: "passed", interactions: "not_assessed", visualFidelity: "not_assessed", engineeringFeasibility: "not_validated", userAcceptance: "pending" }, artifacts };
  await writeFile(join(artifactsDir, "artifact-manifest.json"), JSON.stringify(artifactManifest, null, 2));
  return { artifacts, lint: lintReport, presentation: contract.presentation, files: [...new Set(["artifacts/artifact-manifest.json", "artifacts/lint-report.json", contract.presentation.entry, ...artifacts.map((item) => item.path), ...lint.files])] };
}
