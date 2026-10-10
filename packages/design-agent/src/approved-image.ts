import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { approvedImageAcceptance, approvedImageEdit } from "./design-contract.js";
import { imageSizeCeiling } from "./image-size.js";
import { resolveInside } from "./paths.js";

/** One approved request shape for direct execution, reuse and finalization. */
export function approvedImageTask(workspaceDir: string, runId: string, entry: Record<string, unknown>, deliverable: Record<string, unknown>) {
  const id = String(entry.id), method = String(entry.method ?? deliverable.method);
  if (!["image_generate", "image_edit"].includes(method) || typeof entry.prompt_seed !== "string" || !entry.prompt_seed.trim()) throw new Error(`Invalid approved image task: ${id}`);
  const outputPath = String(deliverable.file), runDir = resolveInside(workspaceDir, join("runs", runId));
  const path = resolveInside(runDir, outputPath);
  const negative = typeof entry.negative_prompt_seed === "string" ? entry.negative_prompt_seed.trim() : "";
  const edit = method === "image_edit" ? approvedImageEdit(entry) : undefined;
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" && value.trim() ? [value] : [];
  return { id, method, path, outputPath, prompt: negative ? `${entry.prompt_seed}\n\nAvoid: ${negative}` : entry.prompt_seed,
    size: typeof entry.size === "string" ? entry.size : imageSizeCeiling(),
    intent: typeof entry.intent === "string" ? entry.intent : typeof deliverable.purpose === "string" ? deliverable.purpose : id,
    acceptanceCriteria: approvedImageAcceptance(entry, deliverable),
    preserve: edit?.preserve ?? strings(entry.preserve ?? entry.preservation_rules ?? entry.preservation),
    referenceImagePaths: (edit?.referenceImagePaths ?? []).map(path => isAbsolute(path) ? resolveInside(workspaceDir, path) : path.startsWith("runs/") ? resolveInside(workspaceDir, path) : resolveInside(runDir, path)),
    diagnosis: edit?.diagnosis ?? [], changes: edit?.changes ?? [] };
}
export type ApprovedImageTask = ReturnType<typeof approvedImageTask>;
export async function approvedImageFingerprint(task: ApprovedImageTask) {
  const referenceHashes = await Promise.all(task.referenceImagePaths.map(async path => createHash("sha256").update(await readFile(path)).digest("hex")));
  return createHash("sha256").update(JSON.stringify({ task, referenceHashes })).digest("hex");
}
export async function recordApprovedImage(task: ApprovedImageTask, fingerprint: string) {
  const sidecar = JSON.parse(await readFile(`${task.path}.json`, "utf8"));
  await writeFile(`${task.path}.json`, JSON.stringify({ ...sidecar, planFingerprint: fingerprint, imageSha256: createHash("sha256").update(await readFile(task.path)).digest("hex") }, null, 2));
}
/** Compatibility callers may restate the approved request, but cannot redesign it. */
export function assertApprovedImageRequest(request: Record<string, unknown>, approved: ApprovedImageTask, workspaceDir: string) {
  for (const key of ["prompt", "intent", "acceptanceCriteria", "preserve", "diagnosis", "changes", "referenceImagePaths", "size"] as const) {
    let supplied = request[key];
    if (key === "size" && supplied === undefined) supplied = imageSizeCeiling();
    if (["preserve", "diagnosis", "changes", "referenceImagePaths"].includes(key) && supplied === undefined) supplied = [];
    if (key === "referenceImagePaths" && Array.isArray(supplied)) supplied = supplied.map(path => resolveInside(workspaceDir, String(path)));
    if (JSON.stringify(supplied) !== JSON.stringify(approved[key])) throw new Error(`Image ${approved.id} ${key} differs from the approved task. Use execute_image_plan by id.`);
  }
}
