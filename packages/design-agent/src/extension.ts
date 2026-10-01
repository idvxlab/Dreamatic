import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  parseFrontmatter,
  SessionManager,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, cp, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { resolveInside, safeRunId } from "./paths.js";
import { createModelImagePreview } from "./image-preview.js";
import { dreamaticProviderFromEnv, dreamaticThinkingLevel } from "./provider.js";
import { discoverResearchAssets, fetchResearchAsset, researchFetch, validateResearchAssets, webSearch } from "./research.js";
import { dreamaticSessionFailure } from "./session-status.js";
import { isRetryableStatus, retryAfterMs, RetryableHttpError, withRetry, type RetryNotice } from "./retry.js";

export interface DreamaticExtensionOptions {
  workspaceDir: string;
  projectId?: string;
  parentInvocation?: { id: string; agent: string; runId?: string };
}

const IMAGE_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: {},
  };
}

const STAGE_COMPLETION_EVENTS: Record<string, string[]> = {
  researcher: ["research_done"],
  designer: ["design_spec_ready", "design_revision_ready"],
  reviewer: ["design_review_pass", "design_review_fail"],
  builder: ["build_done"],
};

const STAGE_REQUIRED_FILES: Record<string, string[]> = {
  researcher: ["research/evidence.json", "research/research.md", "research/brand_lock.md", "research/assets/manifest.json", "research/assets/validation.json"],
  designer: ["plan/design_system.json", "plan/design_plan.json", "plan/deliverable_manifest.json", "plan/acceptance_criteria.md", "plan/task_breakdown.md"],
  reviewer: ["review/design-review.md", "review/design-review.json"],
  builder: ["artifacts/artifact-manifest.json", "artifacts/00-gallery.html", "artifacts/lint-report.json"],
};

export const DREAMATIC_PERSONA_TOOL_POLICY = {
  orchestrator: ["read", "write", "edit", "ls", "grep", "find", "ask_user", "todo_write", "run_init", "spawn_agent", "design_bus_post", "design_bus_read", "export_package"],
  researcher: ["read", "write", "design_bus_post", "design_bus_read", "design_context_read", "websearch_batch", "research_fetch_batch"],
  designer: ["read", "write", "ls", "list_skills", "use_skill", "design_bus_post", "design_bus_read", "design_context_read", "view_image"],
  reviewer: ["read", "write", "ls", "design_bus_post", "design_bus_read", "design_context_read"],
  builder: ["read", "write", "edit", "ls", "design_bus_read", "design_context_read", "image_generate", "image_generate_batch", "image_edit", "build_finalize"],
} as const;

const DREAMATIC_SPECIALISTS = new Set(Object.keys(DREAMATIC_PERSONA_TOOL_POLICY).filter((persona) => persona !== "orchestrator"));

function runIdFromTask(task: string): string | undefined {
  const explicit = task.match(/\bRun\s*id\s*:\s*([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})/i)?.[1];
  if (explicit) return safeRunId(explicit);
  const path = task.replaceAll("\\", "/").match(/\/runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})(?:\/|\b)/)?.[1];
  return path ? safeRunId(path) : undefined;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}.${key} must be a non-empty string`);
  return value;
}

function requiredArray(record: Record<string, unknown>, key: string, label: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`${label}.${key} must be an array`);
  return value;
}

function parseImageSize(value: string, label: string): [number, number] {
  const match = value.trim().match(/^(\d+)x(\d+)$/u);
  if (!match) throw new Error(`${label} must use WIDTHxHEIGHT pixels`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error(`${label} must contain positive integer dimensions`);
  return [width, height];
}

function imageSizeCeiling(): string {
  return process.env.DREAMATIC_IMAGE_DEFAULT_SIZE?.trim() || "1536x1024";
}

interface WorkflowBudget {
  searchQueries: number;
  sourceFetches: number;
  referenceAssets: number;
}

const WORKFLOW_BUDGETS: Record<"compact" | "full", WorkflowBudget> = {
  compact: { searchQueries: 3, sourceFetches: 4, referenceAssets: 3 },
  full: { searchQueries: 8, sourceFetches: 10, referenceAssets: 8 },
};
const workflowUsage = new Map<string, number>();

async function workflowBudget(runDir: string): Promise<{ profile: "compact" | "full"; budget: WorkflowBudget }> {
  const brief: Record<string, unknown> = await readFile(resolveInside(runDir, "brief.json"), "utf8")
    .then((source) => JSON.parse(source) as Record<string, unknown>)
    .catch((): Record<string, unknown> => ({}));
  const profile = brief.workflowProfile === "compact" ? "compact" : "full";
  return { profile, budget: WORKFLOW_BUDGETS[profile] };
}

async function consumeWorkflowBudget(workspaceDir: string, runId: string, field: keyof WorkflowBudget, count: number): Promise<void> {
  const safeId = safeRunId(runId);
  const { profile, budget } = await workflowBudget(resolveInside(workspaceDir, join("runs", safeId)));
  const key = `${safeId}:${field}`;
  const next = (workflowUsage.get(key) ?? 0) + count;
  if (next > budget[field]) throw new Error(`${profile} workflow ${field} budget exceeded: ${next}/${budget[field]}`);
  workflowUsage.set(key, next);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await operation(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function batchSummary(results: Array<Record<string, unknown>>) {
  const succeeded = results.filter((result) => result.ok === true).length;
  const failed = results.length - succeeded;
  return { ok: failed === 0, partial: succeeded > 0 && failed > 0, succeeded, failed, results };
}

function assertImageSizeWithinCeiling(value: string, label: string): void {
  const requested = parseImageSize(value, label).sort((left, right) => right - left);
  const ceiling = parseImageSize(imageSizeCeiling(), "DREAMATIC_IMAGE_DEFAULT_SIZE").sort((left, right) => right - left);
  if (requested[0] > ceiling[0] || requested[1] > ceiling[1]) {
    throw new Error(`${label} ${value} exceeds DREAMATIC_IMAGE_DEFAULT_SIZE ceiling ${imageSizeCeiling()}`);
  }
}

async function readJsonRecord(runDir: string, path: string): Promise<Record<string, unknown>> {
  return requiredRecord(JSON.parse(await readFile(resolveInside(runDir, path), "utf8")) as unknown, path);
}

function copyAlias(record: Record<string, unknown>, target: string, aliases: string[]): boolean {
  if (record[target] !== undefined) return false;
  for (const alias of aliases) {
    if (record[alias] !== undefined) {
      record[target] = record[alias];
      return true;
    }
  }
  return false;
}

function normalizeMethod(record: Record<string, unknown>): boolean {
  if (record.method === "generate") { record.method = "image_generate"; return true; }
  if (record.method === "edit") { record.method = "image_edit"; return true; }
  return false;
}

function normalizeImageSize(record: Record<string, unknown>, key = "size"): boolean {
  const value = record[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const dimensions = value as Record<string, unknown>;
    const width = Number(dimensions.width);
    const height = Number(dimensions.height);
    if (Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0) {
      record[key] = `${width}x${height}`;
      return true;
    }
    return false;
  }
  if (typeof value !== "string") return false;
  const match = value.trim().match(/^(\d+)\s*(?:x|×|by)\s*(\d+)(?:\s*(?:px|pixels?|png|jpe?g|webp))?$/iu);
  if (!match) return false;
  const canonical = `${match[1]}x${match[2]}`;
  if (canonical === value) return false;
  record[key] = canonical;
  return true;
}

async function normalizeJsonFile(runDir: string, path: string, normalize: (record: Record<string, unknown>) => boolean): Promise<void> {
  const absolutePath = resolveInside(runDir, path);
  const record = await readJsonRecord(runDir, path);
  if (normalize(record)) await writeFile(absolutePath, JSON.stringify(record, null, 2), "utf8");
}

async function normalizeStageOutputs(runDir: string, agent: string): Promise<void> {
  if (agent === "researcher") {
    await normalizeJsonFile(runDir, "research/evidence.json", (record) => {
      let changed = copyAlias(record, "runId", ["run_id"]);
      changed = copyAlias(record, "official_sources", ["officialSources", "sources"]) || changed;
      changed = copyAlias(record, "open_questions", ["openQuestions"]) || changed;
      return changed;
    });
    await normalizeJsonFile(runDir, "research/assets/manifest.json", (record) => {
      let changed = copyAlias(record, "runId", ["run_id"]);
      changed = copyAlias(record, "assets", ["items", "references"]) || changed;
      return changed;
    });
    return;
  }
  if (agent === "designer") {
    await normalizeJsonFile(runDir, "plan/design_system.json", (record) => {
      let changed = copyAlias(record, "runId", ["run_id"]);
      changed = copyAlias(record, "system_thesis", ["systemThesis", "thesis"]) || changed;
      changed = copyAlias(record, "palette", ["colors", "colour_palette"]) || changed;
      changed = copyAlias(record, "typography", ["type_system", "fonts"]) || changed;
      return changed;
    });
    await normalizeJsonFile(runDir, "plan/design_plan.json", (record) => {
      let changed = copyAlias(record, "runId", ["run_id"]);
      changed = copyAlias(record, "design_system_ref", ["designSystemRef"]) || changed;
      changed = copyAlias(record, "design_intent", ["designIntent", "intent"]) || changed;
      changed = copyAlias(record, "image_generation_plan", ["imageGenerationPlan", "generation_plan"]) || changed;
      if (Array.isArray(record.image_generation_plan)) {
        for (const item of record.image_generation_plan) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const entry = item as Record<string, unknown>;
          changed = normalizeMethod(entry) || changed;
          changed = copyAlias(entry, "prompt_seed", ["prompt", "generation_prompt"]) || changed;
          changed = copyAlias(entry, "negative_prompt_seed", ["negative_prompt", "negativePrompt"]) || changed;
          changed = copyAlias(entry, "size", ["resolution", "dimensions"]) || changed;
          changed = normalizeImageSize(entry) || changed;
          changed = copyAlias(entry, "size_rationale", ["resolution_rationale", "sizeRationale"]) || changed;
        }
      }
      return changed;
    });
    await normalizeJsonFile(runDir, "plan/deliverable_manifest.json", (record) => {
      let changed = copyAlias(record, "runId", ["run_id"]);
      changed = copyAlias(record, "design_system_ref", ["designSystemRef"]) || changed;
      changed = copyAlias(record, "deliverables", ["items", "outputs"]) || changed;
      if (Array.isArray(record.deliverables)) {
        for (const item of record.deliverables) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const deliverable = item as Record<string, unknown>;
          changed = normalizeMethod(deliverable) || changed;
          changed = copyAlias(deliverable, "file", ["path", "output_path", "outputPath", "artifact_path"]) || changed;
          changed = copyAlias(deliverable, "acceptance_test", ["acceptance_criteria", "acceptanceCriteria"]) || changed;
          changed = copyAlias(deliverable, "size", ["resolution", "dimensions"]) || changed;
          changed = normalizeImageSize(deliverable) || changed;
        }
      }
      return changed;
    });
    const planPath = resolveInside(runDir, "plan/design_plan.json");
    const manifestPath = resolveInside(runDir, "plan/deliverable_manifest.json");
    const plan = await readJsonRecord(runDir, "plan/design_plan.json");
    const manifest = await readJsonRecord(runDir, "plan/deliverable_manifest.json");
    const prompts = Array.isArray(plan.image_generation_plan) ? plan.image_generation_plan : [];
    const deliverables = Array.isArray(manifest.deliverables) ? manifest.deliverables : [];
    let planChanged = false;
    let manifestChanged = false;
    for (const item of deliverables) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const deliverable = item as Record<string, unknown>;
      const prompt = prompts.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).id === deliverable.id) as Record<string, unknown> | undefined;
      if (!prompt || deliverable.method === "manual") continue;
      if ((typeof deliverable.size !== "string" || !deliverable.size.trim()) && typeof prompt.size === "string" && prompt.size.trim()) {
        deliverable.size = prompt.size;
        manifestChanged = true;
      }
      if ((typeof prompt.size !== "string" || !prompt.size.trim()) && typeof deliverable.size === "string" && deliverable.size.trim()) {
        prompt.size = deliverable.size;
        planChanged = true;
      }
      if ((typeof deliverable.file !== "string" || !deliverable.file.trim()) && typeof prompt.output_file === "string" && prompt.output_file.trim()) {
        deliverable.file = prompt.output_file;
        manifestChanged = true;
      }
      if ((typeof prompt.output_file !== "string" || !prompt.output_file.trim()) && typeof deliverable.file === "string" && deliverable.file.trim()) {
        prompt.output_file = deliverable.file;
        planChanged = true;
      }
    }
    if (planChanged) await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
    if (manifestChanged) await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    return;
  }
  if (agent === "reviewer") {
    await normalizeJsonFile(runDir, "review/design-review.json", (record) => {
      let changed = copyAlias(record, "review_stage", ["reviewStage", "stage"]);
      changed = copyAlias(record, "verdict", ["decision", "result"]) || changed;
      changed = copyAlias(record, "round", ["reviewRound", "review_round"]) || changed;
      changed = copyAlias(record, "resolved_issue_ids", ["resolvedIssueIds"]) || changed;
      changed = copyAlias(record, "remaining_risks", ["remainingRisks"]) || changed;
      return changed;
    });
    return;
  }
  if (agent === "builder") {
    await normalizeJsonFile(runDir, "artifacts/artifact-manifest.json", (record) => {
      let changed = copyAlias(record, "runId", ["run_id"]);
      changed = copyAlias(record, "artifacts", ["items", "files", "outputs"]) || changed;
      return changed;
    });
  }
}

async function writeResearchAcquisitionStatus(runDir: string, runId: string): Promise<void> {
  const manifest = await readJsonRecord(runDir, "research/assets/manifest.json");
  const assets = requiredArray(manifest, "assets", "research/assets/manifest.json");
  const path = resolveInside(runDir, "research/assets/validation.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    runId,
    generatedAt: new Date().toISOString(),
    ready: true,
    mode: "acquisition_status",
    summary: { candidate_assets: assets.length },
    issues: [],
  }, null, 2), "utf8");
}

async function validateStageOutputs(runDir: string, runId: string, agent: string, eventType: string): Promise<void> {
  if (agent === "researcher") {
    const evidence = await readJsonRecord(runDir, "research/evidence.json");
    if (requiredString(evidence, "runId", "research/evidence.json") !== runId) throw new Error("research/evidence.json.runId does not match the Run");
    requiredArray(evidence, "official_sources", "research/evidence.json");
    requiredArray(evidence, "open_questions", "research/evidence.json");
    requiredArray(await readJsonRecord(runDir, "research/assets/manifest.json"), "assets", "research/assets/manifest.json");
    const validation = await readJsonRecord(runDir, "research/assets/validation.json");
    if (typeof validation.ready !== "boolean") throw new Error("research/assets/validation.json.ready must be boolean");
    return;
  }
  if (agent === "designer") {
    const system = await readJsonRecord(runDir, "plan/design_system.json");
    const plan = await readJsonRecord(runDir, "plan/design_plan.json");
    const manifest = await readJsonRecord(runDir, "plan/deliverable_manifest.json");
    if (requiredString(system, "runId", "plan/design_system.json") !== runId) throw new Error("plan/design_system.json.runId does not match the Run");
    requiredString(system, "system_thesis", "plan/design_system.json");
    requiredRecord(system.palette, "plan/design_system.json.palette");
    requiredRecord(system.typography, "plan/design_system.json.typography");
    if (requiredString(plan, "runId", "plan/design_plan.json") !== runId) throw new Error("plan/design_plan.json.runId does not match the Run");
    if (requiredString(plan, "design_system_ref", "plan/design_plan.json") !== "plan/design_system.json") throw new Error("plan/design_plan.json.design_system_ref must point to plan/design_system.json");
    requiredString(plan, "design_intent", "plan/design_plan.json");
    const generationPlan = requiredArray(plan, "image_generation_plan", "plan/design_plan.json").map((item, index) => requiredRecord(item, `plan/design_plan.json.image_generation_plan[${index}]`));
    if (requiredString(manifest, "runId", "plan/deliverable_manifest.json") !== runId) throw new Error("plan/deliverable_manifest.json.runId does not match the Run");
    if (requiredString(manifest, "design_system_ref", "plan/deliverable_manifest.json") !== "plan/design_system.json") throw new Error("plan/deliverable_manifest.json.design_system_ref must point to plan/design_system.json");
    const deliverables = requiredArray(manifest, "deliverables", "plan/deliverable_manifest.json").map((item, index) => requiredRecord(item, `plan/deliverable_manifest.json.deliverables[${index}]`));
    if (!deliverables.length) throw new Error("plan/deliverable_manifest.json.deliverables must not be empty");
    const ids = new Set<string>();
    for (const [index, deliverable] of deliverables.entries()) {
      const label = `plan/deliverable_manifest.json.deliverables[${index}]`;
      const id = requiredString(deliverable, "id", label);
      if (ids.has(id)) throw new Error(`Duplicate deliverable id: ${id}`);
      ids.add(id);
      const file = requiredString(deliverable, "file", label).replaceAll("\\", "/");
      if (!file.startsWith("artifacts/") || file.includes("../")) throw new Error(`${label}.file must stay inside artifacts/`);
      requiredString(deliverable, "purpose", label);
      requiredString(deliverable, "acceptance_test", label);
      requiredString(deliverable, "kind", label);
      if (typeof deliverable.required !== "boolean") throw new Error(`${label}.required must be boolean`);
      const method = requiredString(deliverable, "method", label);
      if (!["manual", "image_generate", "image_edit"].includes(method)) throw new Error(`${label}.method is invalid`);
      if (method !== "manual") {
        const prompt = generationPlan.find((entry) => entry.id === id);
        if (!prompt) throw new Error(`Visual deliverable ${id} has no image_generation_plan entry`);
        if (prompt.method !== method) throw new Error(`Visual deliverable ${id} method does not match its image_generation_plan entry`);
        requiredString(prompt, "prompt_seed", `image_generation_plan.${id}`);
        requiredString(prompt, "negative_prompt_seed", `image_generation_plan.${id}`);
        const deliverableSize = requiredString(deliverable, "size", label);
        const promptSize = requiredString(prompt, "size", `image_generation_plan.${id}`);
        if (deliverableSize !== promptSize) throw new Error(`${label}.size must match image_generation_plan.${id}.size`);
        assertImageSizeWithinCeiling(promptSize, `image_generation_plan.${id}.size`);
        requiredString(prompt, "size_rationale", `image_generation_plan.${id}`);
      }
    }
    return;
  }
  if (agent === "reviewer") {
    const review = await readJsonRecord(runDir, "review/design-review.json");
    if (review.review_stage !== "design_context") throw new Error("review/design-review.json.review_stage must be design_context");
    const verdict = requiredString(review, "verdict", "review/design-review.json");
    const expectedVerdict = eventType === "design_review_pass" ? "pass" : "fail";
    if (verdict !== expectedVerdict) throw new Error(`Reviewer event ${eventType} conflicts with review verdict ${verdict}`);
    if (typeof review.round !== "number" || review.round < 1) throw new Error("review/design-review.json.round must be a positive number");
    requiredString(review, "summary", "review/design-review.json");
    requiredRecord(review.scores, "review/design-review.json.scores");
    const issues = requiredArray(review, "issues", "review/design-review.json").map((item, index) => requiredRecord(item, `review/design-review.json.issues[${index}]`));
    if (verdict === "fail" && !issues.some((issue) => issue.status === "open")) throw new Error("A failed review must contain at least one open issue");
    if (verdict === "pass" && issues.some((issue) => issue.severity === "blocking" && issue.status === "open")) throw new Error("A passed review cannot contain an open blocking issue");
    return;
  }
  if (agent === "builder") {
    const manifest = await readJsonRecord(runDir, "artifacts/artifact-manifest.json");
    if (requiredString(manifest, "runId", "artifacts/artifact-manifest.json") !== runId) throw new Error("artifacts/artifact-manifest.json.runId does not match the Run");
    requiredArray(manifest, "artifacts", "artifacts/artifact-manifest.json");
    const lint = await readJsonRecord(runDir, "artifacts/lint-report.json");
    if (lint.ok !== true) throw new Error("artifacts/lint-report.json.ok must be true before build_done");
  }
}

async function assertStageCommitted(workspaceDir: string, runId: string, agent: string, startingEventCount: number): Promise<string> {
  const allowed = STAGE_COMPLETION_EVENTS[agent];
  if (!allowed) return "not-required";
  const busPath = resolveInside(workspaceDir, join("runs", runId, "bus.jsonl"));
  const runDir = resolveInside(workspaceDir, join("runs", runId));
  const source = await readFile(busPath, "utf8").catch(() => "");
  const events = source
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
  const committed = events
    .slice(startingEventCount)
    .findLast((event) => allowed.includes(String(event.type ?? "")) && event.from_agent === agent && event.to === "orchestrator");
  if (!committed) throw new Error(`${agent} returned without committing ${allowed.join(" or ")} to the Design Bus for Run ${runId}`);
  const receipt = committed.commitReceipt && typeof committed.commitReceipt === "object" && !Array.isArray(committed.commitReceipt)
    ? committed.commitReceipt as Record<string, unknown>
    : undefined;
  const receiptFiles = receipt?.files && typeof receipt.files === "object" && !Array.isArray(receipt.files)
    ? receipt.files as Record<string, unknown>
    : undefined;
  let receiptValid = Boolean(receiptFiles);
  for (const required of STAGE_REQUIRED_FILES[agent] ?? []) {
    const path = resolveInside(runDir, required);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw new Error(`${agent} committed ${String(committed.type)} but required output is missing or empty: ${required}`);
    const expectedHash = receiptFiles?.[required];
    if (typeof expectedHash !== "string") {
      receiptValid = false;
    } else {
      const actualHash = createHash("sha256").update(await readFile(path)).digest("hex");
      if (actualHash !== expectedHash) throw new Error(`${agent} output changed after ${String(committed.type)} was committed: ${required}`);
    }
  }
  if (agent === "builder") {
    const artifactFiles = await listFiles(join(runDir, "artifacts"));
    if (!artifactFiles.some((file) => /\.(png|jpe?g|webp)$/i.test(file))) throw new Error("builder committed build_done without a visual artifact");
  }
  if (!receiptValid) await validateStageOutputs(runDir, runId, agent, String(committed.type));
  const references = Array.isArray(committed.artifactRefs) ? committed.artifactRefs.filter((item): item is string => typeof item === "string") : [];
  for (const reference of references) {
    const workspacePath = resolveInside(workspaceDir, reference);
    const runPath = resolveInside(runDir, reference);
    if (!await stat(workspacePath).then(() => true).catch(() => false)) await stat(runPath);
  }
  return String(committed.type);
}

type ImageToolName = "image_generate" | "image_edit";

interface ImageGenerateTask {
  runId: string;
  id: string;
  intent: string;
  prompt: string;
  acceptanceCriteria: string[];
  preserve?: string[];
  outputPath?: string;
  size?: string;
}

interface SavedImage {
  bytes: Buffer;
  mimeType: "image/png";
  path: string;
  sidecarPath: string;
}

interface RunState {
  runId: string;
  status: "active" | "needs_revision" | "interrupted" | "complete";
  stages: Record<"research" | "design" | "review" | "build" | "export", "pending" | "in_progress" | "completed" | "failed">;
  createdAt: string;
  updatedAt: string;
  lastEvent?: string;
}

interface DesignContextIndex {
  schemaVersion: 1;
  runId: string;
  status: "collecting" | "designing" | "in_review" | "needs_revision" | "approved" | "implemented" | "complete";
  revision: number;
  sections: {
    requirements: string;
    research: string[];
    designSpec: string[];
    tokens: string;
    components: string;
    decisions: string;
    reviewIssues: string[];
    implementation: string;
  };
  latestVerdict?: "pass" | "fail";
  lastEvent?: string;
  updatedAt: string;
}

const MAX_ACTIVE_SKILL_CHARS = 18_000;
const operationAttempts = new Map<string, number>();
const operationLastErrors = new Map<string, string>();

function omitPersistedImagePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitPersistedImagePayload);
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  if (item.type === "image" && typeof item.data === "string") {
    return {
      type: "text",
      text: `[Visual payload omitted from resumable session (${item.mimeType ?? "image"}, ${item.data.length} base64 characters). Reload the persisted path with view_image when visual evidence is needed.]`,
    };
  }
  return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, omitPersistedImagePayload(child)]));
}

/**
 * Produce a lightweight resumable Pi history while preserving the full visual
 * history beside it as a recoverable backup. No original session data is
 * deleted by this operation.
 */
export async function compactVisualSession(sessionFile: string): Promise<{ omitted: number; beforeBytes: number; afterBytes: number; backupPath?: string }> {
  const beforeBytes = (await stat(sessionFile)).size;
  const temporary = `${sessionFile}.${process.pid}.visual-compact.tmp`;
  const backupPath = `${sessionFile}.${new Date().toISOString().replace(/[:.]/gu, "-")}.visual-full.bak`;
  const reader = createInterface({ input: createReadStream(sessionFile, { encoding: "utf8" }), crlfDelay: Infinity });
  const writer = createWriteStream(temporary, { encoding: "utf8" });
  let omitted = 0;
  for await (const line of reader) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as unknown;
    const source = JSON.stringify(parsed);
    omitted += source.split('"type":"image"').length - 1;
    if (!writer.write(`${JSON.stringify(omitPersistedImagePayload(parsed))}\n`)) await once(writer, "drain");
  }
  writer.end();
  await once(writer, "finish");
  if (omitted === 0) {
    await unlink(temporary);
    return { omitted, beforeBytes, afterBytes: beforeBytes };
  }
  await rename(sessionFile, backupPath);
  await rename(temporary, sessionFile);
  return { omitted, beforeBytes, afterBytes: (await stat(sessionFile)).size, backupPath };
}

async function durableRetryNotice(
  workspaceDir: string,
  runId: string,
  operation: string,
  notice: RetryNotice,
  scope?: string,
): Promise<void> {
  const path = resolveInside(workspaceDir, join("runs", safeRunId(runId), "bus.jsonl"));
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({
    runId: safeRunId(runId),
    type: "operation_retry",
    operation,
    ...(scope ? { scope } : {}),
    attempt: notice.attempt,
    nextAttempt: notice.nextAttempt,
    delayMs: notice.delayMs,
    error: notice.error,
    at: new Date().toISOString(),
  })}\n`, "utf8");
}

async function appendWorkflowLifecycleEvent(
  workspaceDir: string,
  runId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const path = resolveInside(workspaceDir, join("runs", safeRunId(runId), "bus.jsonl"));
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ runId: safeRunId(runId), ...event, at: new Date().toISOString() })}\n`, "utf8");
}

function workflowObservation(value: unknown, limit = 1_200): string {
  let text: string;
  try {
    text = JSON.stringify(omitPersistedImagePayload(value));
  } catch {
    text = String(value);
  }
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function workflowReferencePath(value: unknown, runId: string): string | undefined {
  const source = workflowObservation(value, 12_000).replaceAll("\\", "/");
  const escapedRunId = runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`runs/${escapedRunId}/research/assets/[^\"'\\s]+\\.(?:png|jpe?g|webp|gif)`, "iu"))?.[0];
}

async function resilientFetch(
  endpoint: string,
  init: RequestInit,
  options: { workspaceDir: string; runId: string; operation: string; budgetScope?: string; signal?: AbortSignal; timeoutMs?: number; attempts?: number; onRetry?: (notice: RetryNotice) => void | Promise<void> },
): Promise<Response> {
  const timeoutMs = Math.max(10_000, options.timeoutMs ?? Number(process.env.DREAMATIC_IMAGE_TIMEOUT_MS ?? 300_000));
  const attempts = Math.max(1, options.attempts ?? Number(process.env.DREAMATIC_IMAGE_RETRY_ATTEMPTS ?? 3));
  const attemptBudget = Math.max(attempts, Number(process.env.DREAMATIC_OPERATION_ATTEMPT_BUDGET ?? 5));
  const budgetKey = `${options.runId}:${options.operation}:${options.budgetScope ?? "default"}`;
  return withRetry(async () => {
    const used = operationAttempts.get(budgetKey) ?? 0;
    if (used >= attemptBudget) {
      const lastError = operationLastErrors.get(budgetKey);
      const message = `${options.operation} retry budget exhausted after ${used} attempts; durable checkpoint preserved${lastError ? `; last error: ${lastError}` : ""}`;
      await appendFile(resolveInside(options.workspaceDir, join("runs", safeRunId(options.runId), "bus.jsonl")), `${JSON.stringify({ runId: options.runId, type: "operation_interrupted", operation: options.operation, scope: options.budgetScope, attempts: used, retryable: true, error: message, at: new Date().toISOString() })}\n`, "utf8");
      throw new Error(message);
    }
    operationAttempts.set(budgetKey, used + 1);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await fetch(endpoint, { ...init, signal });
      if (isRetryableStatus(response.status)) {
        const detail = (await response.text()).slice(0, 600);
        throw new RetryableHttpError(response.status, `${options.operation} failed (${response.status}): ${detail}`, retryAfterMs(response));
      }
      operationAttempts.delete(budgetKey);
      operationLastErrors.delete(budgetKey);
      return response;
    } catch (error) {
      let failure = error instanceof Error ? error : new Error(String(error));
      if (timeout.aborted && !options.signal?.aborted) {
        const target = new URL(endpoint);
        target.search = "";
        failure = new Error(`${options.operation} timed out after ${timeoutMs} ms while calling ${target.toString()}`);
      }
      operationLastErrors.set(budgetKey, failure.message.slice(0, 800));
      throw failure;
    }
  }, {
    attempts,
    ...(options.signal ? { signal: options.signal } : {}),
    onRetry: async (notice) => {
      await durableRetryNotice(options.workspaceDir, options.runId, options.operation, notice, options.budgetScope);
      await options.onRetry?.(notice);
    },
  });
}

function compactSkillObservation(text: string): string {
  if (text.length <= MAX_ACTIVE_SKILL_CHARS || !/^---[\s\S]*?\n# /m.test(text)) return text;
  const headLength = 12_000;
  const tailLength = 4_000;
  const omitted = text.slice(headLength, -tailLength);
  const headings = omitted
    .split(/\r?\n/)
    .filter((line) => /^#{1,4}\s+/.test(line))
    .slice(0, 40);
  return [
    text.slice(0, headLength),
    `\n\n[Dreamatic progressive Skill loading omitted ${omitted.length} characters from active context. The complete Skill remains on disk and in the durable session. Read a targeted range when a listed section is needed.]`,
    ...(headings.length ? ["Omitted section index:", ...headings.map((heading) => `- ${heading}`)] : []),
    "\n[End omitted section; completion and failure contracts follow.]\n",
    text.slice(-tailLength),
  ].join("\n");
}

function jsonText(value: unknown): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

async function imageBlock(workspaceDir: string, workspacePath: string) {
  const path = resolveInside(workspaceDir, workspacePath);
  const mimeType = IMAGE_MIME.get(extname(path).toLowerCase());
  if (!mimeType) throw new Error(`Unsupported image: ${workspacePath}`);
  const info = await stat(path);
  if (info.size > 20 * 1024 * 1024) throw new Error(`Image exceeds the 20 MiB inspection limit: ${workspacePath}`);
  const preview = createModelImagePreview(await readFile(path), mimeType);
  return {
    block: { type: "image" as const, data: preview.data, mimeType: preview.mimeType },
    bytes: info.size,
    preview: { bytes: preview.bytes, width: preview.width, height: preview.height, originalWidth: preview.originalWidth, originalHeight: preview.originalHeight },
    path,
  };
}

function artifactOutputPath(
  workspaceDir: string,
  runId: string,
  imageId: string,
  defaultDirectory: "generated-images" | "edits",
  outputPath?: string,
): string {
  const runArtifactsDir = resolveInside(workspaceDir, join("runs", runId, "artifacts"));
  const requested = outputPath?.trim()
    ? outputPath.replaceAll("\\", "/")
    : `artifacts/${defaultDirectory}/${imageId}.png`;
  if (isAbsolute(requested)) throw new Error("outputPath must be relative to the run directory");
  const path = resolveInside(workspaceDir, join("runs", runId, requested));
  const fromArtifacts = relative(runArtifactsDir, path);
  if (fromArtifacts === ".." || fromArtifacts.startsWith(`..\\`) || fromArtifacts.startsWith("../")) {
    throw new Error("outputPath must stay inside the run's artifacts directory");
  }
  if (extname(path).toLowerCase() !== ".png") throw new Error("Image outputs must use a .png path");
  return path;
}

async function updateRunState(workspaceDir: string, runId: string, eventType: string): Promise<void> {
  const path = resolveInside(workspaceDir, join("runs", runId, "run-state.json"));
  const now = new Date().toISOString();
  const fallback: RunState = {
    runId,
    status: "active",
    stages: { research: "pending", design: "pending", review: "pending", build: "pending", export: "pending" },
    createdAt: now,
    updatedAt: now,
  };
  const state = await readFile(path, "utf8")
    .then((content) => JSON.parse(content) as RunState)
    .catch(() => fallback);
  if (eventType === "researcher_started") state.stages.research = "in_progress";
  if (eventType === "designer_started") state.stages.design = "in_progress";
  if (eventType === "reviewer_started") {
    state.stages.design = "completed";
    state.stages.review = "in_progress";
  }
  if (eventType === "builder_started") state.stages.build = "in_progress";
  if (eventType === "export_started") state.stages.export = "in_progress";
  if (eventType === "kickoff") state.stages.research = "in_progress";
  if (eventType === "research_done") {
    state.status = "active";
    state.stages.research = "completed";
    state.stages.design = "pending";
  }
  if (["design_spec_ready", "design_revision_ready"].includes(eventType)) {
    state.status = "active";
    state.stages.design = "completed";
    state.stages.review = "pending";
  }
  if (eventType === "design_review_fail") {
    state.status = "needs_revision";
    state.stages.review = "failed";
    state.stages.design = "pending";
  }
  if (eventType === "design_review_pass") {
    state.status = "active";
    state.stages.review = "completed";
    state.stages.build = "pending";
  }
  if (eventType === "build_done") {
    state.status = "active";
    state.stages.build = "completed";
    state.stages.export = "pending";
  }
  // A single provider operation may exhaust its own retry budget while the
  // stage agent recovers with another asset or strategy. Keep the Run active;
  // a genuinely terminated Pi session is classified by the Run inventory.
  if (eventType === "operation_interrupted" && state.status === "interrupted") state.status = "active";
  if (eventType === "export_done") {
    state.status = "complete";
    state.stages.export = "completed";
  }
  state.lastEvent = eventType;
  state.updatedAt = now;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
  await rename(temporary, path);
}

async function updateDesignContextIndex(workspaceDir: string, runId: string, eventType: string): Promise<void> {
  const path = resolveInside(workspaceDir, join("runs", runId, "design-context.json"));
  const now = new Date().toISOString();
  const fallback: DesignContextIndex = {
    schemaVersion: 1,
    runId,
    status: "collecting",
    revision: 0,
    sections: {
      requirements: "brief.json",
      research: ["research/evidence.json", "research/research.md", "research/brand_lock.md", "research/assets/manifest.json", "research/assets/validation.json"],
      designSpec: ["plan/design_plan.json", "plan/deliverable_manifest.json", "plan/acceptance_criteria.md"],
      tokens: "plan/design_system.json",
      components: "plan/design_plan.json",
      decisions: "plan/task_breakdown.md",
      reviewIssues: ["review/design-review.json", "review/design-review.md"],
      implementation: "artifacts/artifact-manifest.json",
    },
    updatedAt: now,
  };
  const context = await readFile(path, "utf8")
    .then((content) => JSON.parse(content) as DesignContextIndex)
    .catch(() => fallback);
  if (eventType === "research_done") context.status = "designing";
  if (eventType === "design_spec_ready") context.status = "in_review";
  if (eventType === "design_revision_ready") {
    context.status = "in_review";
    context.revision += 1;
  }
  if (eventType === "design_review_fail") {
    context.status = "needs_revision";
    context.latestVerdict = "fail";
  }
  if (eventType === "design_review_pass") {
    context.status = "approved";
    context.latestVerdict = "pass";
  }
  if (eventType === "build_done") context.status = "implemented";
  if (eventType === "export_done") context.status = "complete";
  context.lastEvent = eventType;
  context.updatedAt = now;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(context, null, 2), "utf8");
  await rename(temporary, path);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else files.push(relative(root, path).replaceAll("\\", "/"));
  }
  return files;
}

async function lintArtifactDirectory(runDir: string, artifactsDir: string, minImages: number, requireGallery: boolean) {
  const files = await listFiles(artifactsDir);
  const issues: string[] = [];
  for (const file of files) {
    const info = await stat(join(artifactsDir, file));
    if (info.size === 0) issues.push(`${file}: empty file`);
    if (file.endsWith(".html")) {
      const html = await readFile(join(artifactsDir, file), "utf8");
      if (/https?:\/\//i.test(html)) issues.push(`${file}: external URL found`);
      if (/<script\b/i.test(html)) issues.push(`${file}: script element found`);
    }
  }
  const images = files.filter((file) => /\.(png|jpe?g|webp)$/i.test(file));
  if (images.length < minImages) issues.push(`Expected at least ${minImages} visual artifacts, found ${images.length}`);
  if (requireGallery && !files.some((file) => file.endsWith("00-gallery.html"))) issues.push("Required 00-gallery.html is missing");
  return {
    ok: issues.length === 0,
    checkedAt: new Date().toISOString(),
    scope: "artifacts",
    stats: { files: files.length, images: images.length, required_png_count: minImages },
    issues,
  };
}

export function specialistCompletionEvent(agent: string, toolName: string, isError: boolean, args: unknown): string | undefined {
  if (isError || !args || typeof args !== "object" || Array.isArray(args)) return undefined;
  if (agent === "builder" && toolName === "build_finalize") return "build_done";
  if (toolName !== "design_bus_post") return undefined;
  const type = String((args as Record<string, unknown>).type ?? "");
  return STAGE_COMPLETION_EVENTS[agent]?.includes(type) ? type : undefined;
}

type PersonaFrontmatter = {
  name?: unknown;
  allowed_tools?: unknown;
};

export function dreamaticPersonaTools(persona: string, value: unknown): string[] {
  const policy = DREAMATIC_PERSONA_TOOL_POLICY[persona as keyof typeof DREAMATIC_PERSONA_TOOL_POLICY];
  if (!policy) throw new Error(`Unknown Dreamatic persona: ${persona}`);
  if (!Array.isArray(value)) throw new Error(`Persona ${persona} must declare allowed_tools`);
  const declared = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  const actual = [...new Set(declared)];
  const missing = policy.filter((tool) => !actual.includes(tool));
  const extra = actual.filter((tool) => !(policy as readonly string[]).includes(tool));
  if (missing.length || extra.length) {
    throw new Error(`Persona ${persona} tool contract mismatch; missing: ${missing.join(", ") || "none"}; disallowed: ${extra.join(", ") || "none"}`);
  }
  return [...policy];
}

function finalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") continue;
    if (!("content" in message) || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => (
        Boolean(block) && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string"
      ))
      .map((block) => block.text)
      .join("\n");
    if (text) return text;
  }
  return "";
}

async function saveImageResponse(
  workspaceDir: string,
  runId: string,
  imageId: string,
  prompt: string,
  tool: ImageToolName,
  payload: { data?: Array<{ b64_json?: string; url?: string }> },
  references: string[] = [],
  outputPath?: string,
  metadata: Record<string, unknown> = {},
): Promise<SavedImage> {
  const item = payload.data?.[0];
  if (!item) throw new Error("Image provider returned no image data");
  let bytes: Buffer;
  if (item.b64_json) {
    bytes = Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    const response = await resilientFetch(item.url, { method: "GET" }, {
      workspaceDir,
      runId,
      operation: "image_download",
    });
    if (!response.ok) throw new Error(`Failed to download generated image: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } else {
    throw new Error("Image provider returned neither b64_json nor url");
  }

  const imagePath = artifactOutputPath(
    workspaceDir,
    runId,
    imageId,
    tool === "image_edit" ? "edits" : "generated-images",
    outputPath,
  );
  await mkdir(dirname(imagePath), { recursive: true });
  await writeFile(imagePath, bytes);
  const workspacePath = relative(workspaceDir, imagePath).replaceAll("\\", "/");
  const sidecarPath = `${imagePath}.json`;
  await writeFile(
    sidecarPath,
    JSON.stringify({
      runId,
      id: imageId,
      path: workspacePath,
      tool,
      prompt,
      references,
      createdAt: new Date().toISOString(),
      ...metadata,
    }, null, 2),
    "utf8",
  );
  return {
    bytes,
    mimeType: "image/png",
    path: workspacePath,
    sidecarPath: relative(workspaceDir, sidecarPath).replaceAll("\\", "/"),
  };
}

export function createDreamaticExtension(options: DreamaticExtensionOptions): ExtensionFactory {
  const workspaceDir = options.workspaceDir;
  const todos: Array<{ id: string; text: string; status: string }> = [];
  const imageConcurrency = Math.max(1, Math.min(2, Number(process.env.DREAMATIC_IMAGE_CONCURRENCY ?? 2)));
  let activeImageOperations = 0;
  const imageOperationWaiters: Array<() => void> = [];
  let activeSpecialistInvocation: { id: string; agent: string } | undefined;
  const currentSpecialistInvocation = () => activeSpecialistInvocation;
  const enqueueImageOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    return (async () => {
      if (activeImageOperations >= imageConcurrency) {
        await new Promise<void>((resolve) => imageOperationWaiters.push(resolve));
      }
      activeImageOperations += 1;
      try {
        return await operation();
      } finally {
        activeImageOperations -= 1;
        imageOperationWaiters.shift()?.();
      }
    })();
  };
  const generateImage = (params: ImageGenerateTask, signal?: AbortSignal, onRetry?: (notice: RetryNotice) => void): Promise<Record<string, unknown>> => enqueueImageOperation(async () => {
    const size = params.size ?? imageSizeCeiling();
    assertImageSizeWithinCeiling(size, "image_generate.size");
    const apiKey = process.env.DREAMATIC_IMAGE_API_KEY?.trim() || process.env.DREAMATIC_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("DREAMATIC_IMAGE_API_KEY, DREAMATIC_API_KEY, or OPENAI_API_KEY is not configured");
    const baseUrl = (process.env.DREAMATIC_IMAGE_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const endpoint = process.env.DREAMATIC_IMAGE_GENERATION_ENDPOINT?.trim() || `${baseUrl}/images/generations`;
    const idempotencyKey = createHash("sha256").update(`${params.runId}\0${params.id}\0${params.prompt}`).digest("hex");
    const response = await resilientFetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        model: process.env.DREAMATIC_IMAGE_MODEL ?? "gpt-image-1",
        prompt: params.prompt,
        size,
        n: 1,
        response_format: process.env.DREAMATIC_IMAGE_RESPONSE_FORMAT ?? "b64_json",
      }),
    }, {
      workspaceDir,
      runId: params.runId,
      operation: "image_generate",
      budgetScope: params.id,
      ...(signal ? { signal } : {}),
      ...(onRetry ? { onRetry } : {}),
    });
    if (!response.ok) throw new Error(`Image generation failed (${response.status}): ${await response.text()}`);
    const payload = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const saved = await saveImageResponse(workspaceDir, safeRunId(params.runId), safeRunId(params.id), params.prompt, "image_generate", payload, [], params.outputPath, {
      intent: params.intent,
      acceptanceCriteria: params.acceptanceCriteria,
      preserve: params.preserve ?? [],
    });
    return {
      ok: true,
      action: "image_generate",
      id: params.id,
      path: saved.path,
      sidecarPath: saved.sidecarPath,
      intent: params.intent,
      acceptanceCriteria: params.acceptanceCriteria,
      instruction: "The declared output file was created. Continue directly without a second visual audit.",
    };
  });
  return (pi: ExtensionAPI) => {
    const profile = dreamaticProviderFromEnv();
    let activeRunId = options.parentInvocation?.runId;
    if (profile) pi.registerProvider(profile.providerId, profile.registration);
    if (!options.parentInvocation) {
      pi.on("tool_call", async (event) => {
        const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
        if (typeof input.runId === "string") activeRunId = safeRunId(input.runId);
        if (event.toolName === "read") {
          const requestedPath = typeof input.path === "string" ? input.path.replaceAll("\\", "/") : "";
          const pathRunId = requestedPath.match(/(?:^|\/)runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})(?:\/|$)/u)?.[1];
          if (pathRunId) activeRunId = safeRunId(pathRunId);
          if (/\.(?:png|jpe?g|webp|gif|avif|bmp|tiff?)$/iu.test(requestedPath)) {
            return {
              block: true,
              reason: "Orchestrator must not load binary images or add a post-build visual audit. Use Builder's build_done and persisted lint evidence, then export_package.",
            };
          }
        }
        if (!activeRunId || event.toolName === "export_package") return undefined;
        const statePath = resolveInside(workspaceDir, join("runs", activeRunId, "run-state.json"));
        const state = await readFile(statePath, "utf8")
          .then((source) => JSON.parse(source) as RunState)
          .catch(() => undefined);
        if (state?.lastEvent !== "build_done") return undefined;
        const finalizationTools = new Set(["design_bus_read", "todo_write"]);
        if (finalizationTools.has(event.toolName)) return undefined;
        return {
          block: true,
          reason: `Run ${activeRunId} has committed build_done. The implementation and lint report are immutable at this gate; call export_package immediately. Do not read artifacts or start another specialist.`,
        };
      });
      pi.on("tool_execution_start", async (event) => {
        const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
        if (typeof args.runId === "string") activeRunId = safeRunId(args.runId);
        if (!activeRunId || ["run_init", "spawn_agent"].includes(event.toolName)) return;
        await appendWorkflowLifecycleEvent(workspaceDir, activeRunId, {
          type: "orchestrator_tool_started",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: workflowObservation(event.args, 900),
          status: "running",
          from: "orchestrator",
        });
      });
      pi.on("tool_execution_end", async (event) => {
        if (event.toolName === "run_init" && !event.isError) {
          const match = workflowObservation(event.result, 4_000).match(/"runId"\s*:\s*"([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})"/u);
          if (match?.[1]) activeRunId = safeRunId(match[1]);
        }
        if (!activeRunId || ["run_init", "spawn_agent"].includes(event.toolName)) return;
        await appendWorkflowLifecycleEvent(workspaceDir, activeRunId, {
          type: "orchestrator_tool_finished",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: workflowObservation(event.result, 1_200),
          isError: event.isError,
          status: event.isError ? "error" : "completed",
          from: "orchestrator",
        });
      });
    }
    // Keep every visual result from the current tool batch so parallel views or
    // comparisons can actually be inspected together. On later model turns,
    // compact historical visual payloads to the newest observation; any older
    // path can be reloaded because view_image is intentionally idempotent.
    pi.on("context", (event) => {
      const messages = structuredClone(event.messages);
      let latestAssistantIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if ((messages[index] as unknown as { role?: string }).role === "assistant") {
          latestAssistantIndex = index;
          break;
        }
      }
      let historicalVisualMessagesKept = 0;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index] as unknown as {
          role?: string;
          toolName?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
        if (message.role !== "toolResult" || !Array.isArray(message.content)) continue;
        if (message.toolName === "read" || message.toolName === "use_skill") {
          message.content = message.content.map((block) => block.type === "text" && typeof block.text === "string"
            ? { ...block, text: compactSkillObservation(block.text) }
            : block);
        }
        const hasImage = message.content.some((block) => block.type === "image");
        if (!hasImage) continue;
        if (latestAssistantIndex >= 0 && index > latestAssistantIndex) continue;
        historicalVisualMessagesKept += 1;
        if (historicalVisualMessagesKept <= 1) continue;
        message.content = [
          ...message.content.filter((block) => block.type !== "image"),
          {
            type: "text",
            text: `[Older visual observation omitted from active context: ${message.toolName ?? "visual tool"}. Use the persisted path above with view_image to inspect it again.]`,
          },
        ];
      }
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index] as unknown as {
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
        if (message.role !== "user" || !Array.isArray(message.content)) continue;
        if (!message.content.some((block) => block.type === "image")) continue;
        const hasLaterModelOutput = messages.slice(index + 1).some((candidate) => {
          const role = (candidate as unknown as { role?: string }).role;
          return role === "assistant" || role === "toolResult";
        });
        if (!hasLaterModelOutput) continue;
        message.content = [
          ...message.content.filter((block) => block.type !== "image"),
          {
            type: "text",
            text: "[Reference image payload omitted from active context after its first visual pass. Reload the persisted Dreamatic reference path above with view_image when needed.]",
          },
        ];
      }
      return { messages };
    });

    pi.registerTool({
      name: "ask_user",
      label: "Clarify design brief",
      description: "Present one compact structured clarification card to the user before run_init. Use only when missing information materially changes the design. After calling this tool, end the turn and wait for the user's next message.",
      parameters: Type.Object({
        title: Type.Optional(Type.String({ maxLength: 90 })),
        context: Type.Optional(Type.String({ maxLength: 280 })),
        questions: Type.Array(Type.Object({
          id: Type.Optional(Type.String({ minLength: 1, maxLength: 48 })),
          header: Type.String({ minLength: 1, maxLength: 30 }),
          question: Type.String({ minLength: 1, maxLength: 240 }),
          options: Type.Optional(Type.Array(Type.Object({
            label: Type.String({ minLength: 1, maxLength: 40 }),
            description: Type.String({ minLength: 1, maxLength: 180 }),
          }), { minItems: 2, maxItems: 4 })),
          multiple: Type.Optional(Type.Boolean()),
          custom: Type.Optional(Type.Boolean()),
          placeholder: Type.Optional(Type.String({ maxLength: 160 })),
          required: Type.Optional(Type.Boolean()),
        }), { minItems: 1, maxItems: 3 }),
      }),
      async execute(_id, params) {
        const questions = params.questions.map((question, index) => ({
          ...question,
          id: question.id ?? `question-${index + 1}`,
          required: question.required !== false,
          custom: question.custom !== false,
        }));
        return textResult({
          status: "waiting_for_user",
          title: params.title ?? "A few details before we begin",
          context: params.context,
          questions,
          instruction: "End this turn now. Continue only after the user answers in the same session.",
        });
      },
    });

    pi.registerTool({
      name: "websearch",
      label: "Search design references",
      description: "Search the public web for design research sources. Returns compact titles, URLs, and snippets; fetch important sources separately.",
      parameters: Type.Object({ runId: Type.Optional(Type.String()), query: Type.String(), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 12 })) }),
      async execute(_id, params) {
        if (params.runId) await consumeWorkflowBudget(workspaceDir, params.runId, "searchQueries", 1);
        return textResult(await webSearch(params.query, params.limit));
      },
    });

    pi.registerTool({
      name: "websearch_batch",
      label: "Search multiple research questions",
      description: "Search independent research questions with bounded concurrency in one tool call.",
      parameters: Type.Object({ runId: Type.String(), queries: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }), limitPerQuery: Type.Optional(Type.Number({ minimum: 1, maximum: 8 })) }),
      async execute(_id, params) {
        await consumeWorkflowBudget(workspaceDir, params.runId, "searchQueries", params.queries.length);
        const results = await mapWithConcurrency(params.queries, 3, async (query) => {
          try {
            return { ok: true, ...await webSearch(query, params.limitPerQuery) };
          } catch (error) {
            return { ok: false, query, error: error instanceof Error ? error.message : String(error) };
          }
        });
        return textResult(batchSummary(results));
      },
    });

    pi.registerTool({
      name: "research_fetch",
      label: "Fetch research source",
      description: "Fetch a public research page, extract compact readable text, and optionally cache it in the Run for auditability.",
      parameters: Type.Object({
        runId: Type.String(),
        url: Type.String(),
        id: Type.Optional(Type.String({ description: "Stable cache filename stem. Derived from the URL when omitted." })),
        cacheText: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params) {
        await consumeWorkflowBudget(workspaceDir, params.runId, "sourceFetches", 1);
        try {
          return textResult(await researchFetch(workspaceDir, params));
        } catch (error) {
          return textResult({
            ok: false,
            ...(params.id ? { id: params.id } : {}),
            url: params.url,
            error: error instanceof Error ? error.message : String(error),
            instruction: "Record the access limitation and continue from search metadata or another primary source. Do not retry this unchanged URL.",
          });
        }
      },
    });

    pi.registerTool({
      name: "research_fetch_batch",
      label: "Fetch multiple research sources",
      description: "Fetch independent research pages with bounded concurrency and optionally retain each page's lead reference image in the same tool call.",
      parameters: Type.Object({
        runId: Type.String(),
        sources: Type.Array(Type.Object({
          url: Type.String(),
          id: Type.Optional(Type.String()),
          cacheText: Type.Optional(Type.Boolean()),
          saveLeadImageAs: Type.Optional(Type.String({ description: "When provided, discover and save the page's first metadata/lead image under this asset id." })),
          assetKind: Type.Optional(Type.String()),
          assetDescription: Type.Optional(Type.String()),
          assetDoNotReplace: Type.Optional(Type.Boolean()),
          assetAllowedForEdit: Type.Optional(Type.Boolean()),
        }), { minItems: 1, maxItems: 10 }),
      }),
      async execute(_id, params) {
        await consumeWorkflowBudget(workspaceDir, params.runId, "sourceFetches", params.sources.length);
        const assetRequests = params.sources.filter((source) => source.saveLeadImageAs);
        if (assetRequests.length) await consumeWorkflowBudget(workspaceDir, params.runId, "referenceAssets", assetRequests.length);
        const results: Array<Record<string, unknown>> = await mapWithConcurrency(params.sources, 3, async (source) => {
          let fetched: Record<string, unknown>;
          try {
            fetched = await researchFetch(workspaceDir, {
              runId: params.runId,
              url: source.url,
              ...(source.id !== undefined ? { id: source.id } : {}),
              ...(source.cacheText !== undefined ? { cacheText: source.cacheText } : {}),
            });
          } catch (error) {
            fetched = {
              ok: false,
              ...(source.id ? { id: source.id } : {}),
              url: source.url,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          if (!source.saveLeadImageAs) return fetched;
          try {
            const discovery = await discoverResearchAssets(source.url, 8);
            const candidate = discovery.candidates[0];
            return candidate
              ? { ...fetched, leadImageCandidate: candidate }
              : { ...fetched, leadImageError: "No supported lead image was discovered" };
          } catch (error) {
            return { ...fetched, leadImageError: error instanceof Error ? error.message : String(error) };
          }
        });
        for (const [index, source] of params.sources.entries()) {
          if (!source.saveLeadImageAs) continue;
          const result = results[index]!;
          const candidate = result.leadImageCandidate;
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || typeof (candidate as Record<string, unknown>).url !== "string") continue;
          try {
            result.savedLeadImage = await fetchResearchAsset(workspaceDir, {
              runId: params.runId,
              id: source.saveLeadImageAs,
              url: (candidate as Record<string, unknown>).url as string,
              sourcePageUrl: source.url,
              ...(source.assetKind !== undefined ? { kind: source.assetKind } : {}),
              ...(source.assetDescription !== undefined ? { description: source.assetDescription } : {}),
              ...(source.assetDoNotReplace !== undefined ? { doNotReplace: source.assetDoNotReplace } : {}),
              ...(source.assetAllowedForEdit !== undefined ? { allowedForEdit: source.assetAllowedForEdit } : {}),
            });
          } catch (error) {
            result.leadImageError = error instanceof Error ? error.message : String(error);
          }
        }
        return textResult(batchSummary(results));
      },
    });

    pi.registerTool({
      name: "research_asset_discover",
      label: "Discover page images",
      description: "Discover real metadata and image URLs from a public source page before selecting references to retain.",
      parameters: Type.Object({ pageUrl: Type.String(), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 24 })) }),
      async execute(_id, params) {
        return textResult(await discoverResearchAssets(params.pageUrl, params.limit));
      },
    });

    pi.registerTool({
      name: "research_asset_fetch",
      label: "Save research asset",
      description: "Download a selected reference image into the Run and update its idempotent research asset manifest and sidecar.",
      parameters: Type.Object({
        runId: Type.String(),
        id: Type.String(),
        url: Type.String(),
        kind: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        sourcePageUrl: Type.Optional(Type.String()),
        doNotReplace: Type.Optional(Type.Boolean()),
        allowedForEdit: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params) {
        await consumeWorkflowBudget(workspaceDir, params.runId, "referenceAssets", 1);
        return textResult(await fetchResearchAsset(workspaceDir, params));
      },
    });

    pi.registerTool({
      name: "research_asset_fetch_batch",
      label: "Save multiple research assets",
      description: "Save selected reference images in one call. Manifest updates remain sequential for integrity.",
      parameters: Type.Object({
        runId: Type.String(),
        assets: Type.Array(Type.Object({
          id: Type.String(),
          url: Type.String(),
          kind: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          sourcePageUrl: Type.Optional(Type.String()),
          doNotReplace: Type.Optional(Type.Boolean()),
          allowedForEdit: Type.Optional(Type.Boolean()),
        }), { minItems: 1, maxItems: 8 }),
      }),
      async execute(_id, params) {
        await consumeWorkflowBudget(workspaceDir, params.runId, "referenceAssets", params.assets.length);
        const results: Array<Record<string, unknown>> = [];
        for (const asset of params.assets) {
          try {
            results.push(await fetchResearchAsset(workspaceDir, { runId: params.runId, ...asset }));
          } catch (error) {
            results.push({ ok: false, id: asset.id, url: asset.url, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return textResult(batchSummary(results));
      },
    });

    pi.registerTool({
      name: "research_asset_validate",
      label: "Validate reference library",
      description: "Validate the Run's reference manifest, files, hashes, minimum coverage, duplicates, and protected-logo requirement.",
      parameters: Type.Object({
        runId: Type.String(),
        minUsableAssets: Type.Optional(Type.Number({ minimum: 0, maximum: 30 })),
        requireLogo: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params) {
        return textResult(await validateResearchAssets(workspaceDir, params));
      },
    });

    pi.registerTool({
      name: "spawn_agent",
      label: "Spawn design agent",
      description: "Run a Researcher, Designer, Reviewer, or Builder persona in an isolated Pi session and return its final response. Pass runId for every invocation that belongs to a Run so the session is persisted and appears in the workflow stream.",
      parameters: Type.Object({
        agent: Type.String({ description: "Persona name: researcher, designer, reviewer, or builder" }),
        task: Type.String(),
        runId: Type.Optional(Type.String({ description: "Existing Dreamatic Run id. Required for durable stage sessions and completion validation." })),
      }),
      async execute(invocationId, params, signal, onUpdate, context) {
        if (!context.model) throw new Error("The parent session has no active model to pass to the design agent");
        if (!DREAMATIC_SPECIALISTS.has(params.agent)) {
          throw new Error(`Unknown Dreamatic specialist: ${params.agent}. Expected researcher, designer, reviewer, or builder.`);
        }
        const initiallyRunning = currentSpecialistInvocation();
        if (initiallyRunning) {
          throw new Error(`Cannot start ${params.agent}; ${initiallyRunning.agent} is still running in invocation ${initiallyRunning.id}`);
        }
        const personaPath = join(context.cwd, ".pi", "agents", `${safeRunId(params.agent)}.md`);
        const source = await readFile(personaPath, "utf8");
        const { frontmatter, body } = parseFrontmatter<PersonaFrontmatter>(source);
        const inferredRunId = params.runId ? safeRunId(params.runId) : runIdFromTask(params.task);
        if (inferredRunId) activeRunId = inferredRunId;
        const limits = inferredRunId
          ? await workflowBudget(resolveInside(workspaceDir, join("runs", inferredRunId)))
          : { profile: "compact" as const, budget: WORKFLOW_BUDGETS.compact };
        const runtimeLimits = `# Dreamatic Runtime Limits\n\nWorkflow profile: ${limits.profile}. Research acquisition budgets: ${JSON.stringify(limits.budget)}. These budgets limit searches, source fetches, and retained references only; they do not limit the number of design deliverables. DREAMATIC_IMAGE_DEFAULT_SIZE is ${imageSizeCeiling()} and is the hard per-image size ceiling. Designer decides how many distinct views are needed for complete design communication. No planned or executed image may exceed the image-size envelope, including when orientation is swapped.`;
        const childLoader = new DefaultResourceLoader({
          cwd: context.cwd,
          agentDir: getAgentDir(),
          systemPromptOverride: () => `${body}\n\n${runtimeLimits}`,
          appendSystemPromptOverride: (base) => base,
          extensionFactories: [createDreamaticExtension({
            ...options,
            parentInvocation: { id: invocationId, agent: params.agent, ...(inferredRunId ? { runId: inferredRunId } : {}) },
          })],
        });
        await childLoader.reload();
        const tools = dreamaticPersonaTools(params.agent, frontmatter.allowed_tools);
        if (STAGE_COMPLETION_EVENTS[params.agent] && !inferredRunId) {
          throw new Error(`spawn_agent requires runId for workflow stage ${params.agent}`);
        }
        let startingEventCount = 0;
        if (inferredRunId) {
          const busPath = resolveInside(workspaceDir, join("runs", inferredRunId, "bus.jsonl"));
          const busEvents = (await readFile(busPath, "utf8").catch(() => ""))
            .split(/\r?\n/)
            .filter(Boolean)
            .flatMap((line) => {
              try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
            });
          startingEventCount = busEvents.length;
          const latestDesignGate = busEvents.filter((event) => ["design_spec_ready", "design_revision_ready", "design_review_pass", "design_review_fail"].includes(String(event.type ?? ""))).at(-1);
          const hasDesignSpec = busEvents.some((event) => ["design_spec_ready", "design_revision_ready"].includes(String(event.type ?? "")));
          const latestReviewInput = busEvents.filter((event) => ["design_spec_ready", "design_revision_ready", "design_review_pass", "design_review_fail", "research_done"].includes(String(event.type ?? ""))).at(-1);
          const researchCorrectionReady = hasDesignSpec
            && latestDesignGate?.type === "design_review_fail"
            && latestReviewInput?.type === "research_done";
          if (params.agent === "reviewer" && !["design_spec_ready", "design_revision_ready"].includes(String(latestDesignGate?.type ?? "")) && !researchCorrectionReady) {
            throw new Error(`Reviewer cannot start for Run ${inferredRunId} until Designer commits a new Design Spec or Researcher commits evidence for a failed research-owned issue`);
          }
          if (params.agent === "builder" && latestDesignGate?.type !== "design_review_pass") {
            throw new Error(`Builder cannot start for Run ${inferredRunId} until the latest Design Context event is design_review_pass`);
          }
        }
        const childSessionDir = inferredRunId
          ? resolveInside(workspaceDir, join("runs", inferredRunId, "sessions", safeRunId(params.agent)))
          : resolveInside(workspaceDir, join("sessions", "subagents", safeRunId(params.agent)));
        await mkdir(childSessionDir, { recursive: true });
        const concurrentlyStarted = currentSpecialistInvocation();
        if (concurrentlyStarted) {
          throw new Error(`Cannot start ${params.agent}; ${concurrentlyStarted.agent} is still running in invocation ${concurrentlyStarted.id}`);
        }
        activeSpecialistInvocation = { id: invocationId, agent: params.agent };
        const agentStartedAt = Date.now();
        const toolStartedAt = new Map<string, number>();
        const toolArguments = new Map<string, unknown>();
        const toolMetrics = new Map<string, { calls: number; durationMs: number; errors: number }>();
        const modelTurns: Array<Record<string, unknown>> = [];
        let turnStartedAt: number | undefined;
        let responseStartedAt: number | undefined;
        let responseFinishedAt: number | undefined;
        let committedDuringPrompt: string | undefined;
        const childModel = profile && context.model.provider === profile.providerId
          ? profile.modelForPersona(params.agent)
          : context.model;
        const childThinkingLevel = dreamaticThinkingLevel(params.agent, context.thinkingLevel);
        const { session } = await createAgentSession({
          cwd: context.cwd,
          model: childModel,
          resourceLoader: childLoader,
          // Design Context is durable memory. Start a fresh specialist history
          // for each invocation so revisions do not accumulate stale prose.
          sessionManager: SessionManager.create(context.cwd, childSessionDir),
          ...(childThinkingLevel ? { thinkingLevel: childThinkingLevel } : {}),
          ...(tools ? { tools } : {}),
        }).catch((error) => {
          activeSpecialistInvocation = undefined;
          throw error;
        });
        let lifecycleWrites = Promise.resolve();
        const emitLifecycle = (event: Record<string, unknown>): Promise<void> => {
          if (!inferredRunId) return Promise.resolve();
          lifecycleWrites = lifecycleWrites.then(() => appendWorkflowLifecycleEvent(workspaceDir, inferredRunId, {
            invocationId,
            agent: params.agent,
            ...event,
          }));
          return lifecycleWrites;
        };
        await emitLifecycle({ type: "agent_started", task: params.task, status: "running", from: "orchestrator" });
        if (inferredRunId) await updateRunState(workspaceDir, inferredRunId, `${params.agent}_started`);
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "turn_start") {
            turnStartedAt = Date.now();
            responseStartedAt = undefined;
            responseFinishedAt = undefined;
            return;
          }
          if (event.type === "message_start" && event.message.role === "assistant") {
            responseStartedAt ??= Date.now();
            return;
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            responseFinishedAt = Date.now();
            return;
          }
          if (event.type === "turn_end") {
            const endedAt = Date.now();
            const assistant = event.message.role === "assistant" ? event.message : undefined;
            modelTurns.push({
              index: modelTurns.length + 1,
              turnMs: turnStartedAt ? endedAt - turnStartedAt : undefined,
              firstResponseMs: turnStartedAt && responseStartedAt ? responseStartedAt - turnStartedAt : undefined,
              responseMs: responseStartedAt && responseFinishedAt ? responseFinishedAt - responseStartedAt : undefined,
              toolResults: event.toolResults.length,
              ...(assistant && "stopReason" in assistant ? { stopReason: assistant.stopReason } : {}),
              ...(assistant && "usage" in assistant ? { usage: assistant.usage } : {}),
            });
            turnStartedAt = undefined;
            responseStartedAt = undefined;
            responseFinishedAt = undefined;
            return;
          }
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            onUpdate?.({
              content: [{ type: "text", text: event.assistantMessageEvent.delta }],
              details: { agent: params.agent, running: true },
            });
            return;
          }
          if (event.type === "tool_execution_start") {
            toolStartedAt.set(event.toolCallId, Date.now());
            toolArguments.set(event.toolCallId, event.args);
            void emitLifecycle({
              type: "tool_started",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: workflowObservation(event.args, 900),
              status: "running",
            });
            return;
          }
          if (event.type === "tool_execution_end") {
            const args = toolArguments.get(event.toolCallId);
            toolArguments.delete(event.toolCallId);
            const durationMs = Math.max(0, Date.now() - (toolStartedAt.get(event.toolCallId) ?? Date.now()));
            toolStartedAt.delete(event.toolCallId);
            const metric = toolMetrics.get(event.toolName) ?? { calls: 0, durationMs: 0, errors: 0 };
            metric.calls += 1;
            metric.durationMs += durationMs;
            if (event.isError) metric.errors += 1;
            toolMetrics.set(event.toolName, metric);
            const output = workflowObservation(event.result, 1_200);
            void emitLifecycle({
              type: "tool_finished",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              output,
              isError: event.isError,
              status: event.isError ? "error" : "completed",
            });
            if (!event.isError && ["research_asset_fetch", "research_asset_fetch_batch", "research_fetch_batch"].includes(event.toolName) && inferredRunId) {
              const path = workflowReferencePath(event.result, inferredRunId);
              if (path) void emitLifecycle({ type: "reference_added", toolCallId: event.toolCallId, path, status: "completed" });
            }
            const completionEvent = specialistCompletionEvent(params.agent, event.toolName, event.isError, args);
            if (completionEvent && process.env.DREAMATIC_STOP_AFTER_COMMIT?.trim().toLowerCase() !== "false") {
              committedDuringPrompt = completionEvent;
              queueMicrotask(() => void session.abort());
            }
          }
        });
        const abort = () => void session.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const childSessionFile = session.sessionFile;
        try {
          try {
            await withRetry(async (attempt) => {
              await session.prompt(attempt === 1
                ? params.task
                : "The previous provider call failed transiently. Resume this same stage from the durable Run files and completed tool results. Do not repeat completed work or create a new Run.");
              const failure = dreamaticSessionFailure(session.messages);
              if (failure) throw new Error(`Sub-agent ${params.agent} failed: ${failure}`);
            }, {
              attempts: Math.max(1, Number(process.env.DREAMATIC_AGENT_RETRY_ATTEMPTS ?? 3)),
              ...(signal ? { signal } : {}),
              onRetry: async (notice) => {
                await emitLifecycle({ type: "agent_retry", attempt: notice.attempt, nextAttempt: notice.nextAttempt, delayMs: notice.delayMs, error: notice.error, status: "running" });
                onUpdate?.({
                  content: [{ type: "text", text: `${params.agent} reconnecting (attempt ${notice.nextAttempt}): ${notice.error}` }],
                  details: { agent: params.agent, retry: notice },
                });
              },
            });
          } catch (error) {
            if (!committedDuringPrompt) throw error;
          }
          const output = committedDuringPrompt
            ? `${params.agent} committed ${committedDuringPrompt}; runtime ended the completed specialist session without an additional summary round.`
            : finalAssistantText(session.messages);
          const committedEvent = inferredRunId
            ? await assertStageCommitted(workspaceDir, inferredRunId, params.agent, startingEventCount)
            : "not-required";
          await lifecycleWrites;
          await emitLifecycle({
            type: "agent_finished",
            output,
            committedEvent,
            status: "completed",
            metrics: { durationMs: Date.now() - agentStartedAt, tools: Object.fromEntries(toolMetrics), modelTurns },
          });
          return {
            content: [{ type: "text", text: output || `${params.agent} completed without a text summary.` }],
            details: { agent: params.agent, personaPath, runId: inferredRunId, childSessionDir, committedEvent },
          };
        } catch (error) {
          await lifecycleWrites;
          await emitLifecycle({
            type: "agent_interrupted",
            error: error instanceof Error ? error.message : String(error),
            status: signal?.aborted ? "interrupted" : "error",
            metrics: { durationMs: Date.now() - agentStartedAt, tools: Object.fromEntries(toolMetrics), modelTurns },
          });
          throw error;
        } finally {
          if (activeSpecialistInvocation?.id === invocationId) activeSpecialistInvocation = undefined;
          signal?.removeEventListener("abort", abort);
          unsubscribe();
          session.dispose();
          if (childSessionFile) {
            await compactVisualSession(childSessionFile).catch((error) => {
              onUpdate?.({
                content: [{ type: "text", text: `${params.agent} session compaction warning: ${error instanceof Error ? error.message : String(error)}` }],
                details: { agent: params.agent, visualSessionCompaction: "failed" },
              });
            });
          }
        }
      },
    });

    // Compatibility bridge for the existing Dreamatic Skill contracts. Pi
    // already discovers Skills natively; these tools remain until each Skill
    // has been reviewed and migrated without losing its executable contract.
    pi.registerTool({
      name: "list_skills",
      label: "List design skills",
      description: "List project Dreamatic Skills during the compatibility migration to Pi-native Skill loading.",
      parameters: Type.Object({ query: Type.Optional(Type.String()) }),
      async execute(_id, params, _signal, _update, context) {
        const loaded = new DefaultResourceLoader({ cwd: context.cwd, agentDir: getAgentDir() });
        await loaded.reload();
        const skills = loaded.getSkills().skills
          .filter((skill) => !params.query || `${skill.name} ${skill.description}`.toLowerCase().includes(params.query.toLowerCase()))
          .map((skill) => ({ name: skill.name, description: skill.description, path: skill.filePath }));
        return textResult({ count: skills.length, skills, source: "pi-resource-loader" });
      },
    });

    pi.registerTool({
      name: "use_skill",
      label: "Load design skill",
      description: "Load a Pi-discovered Skill by name while legacy Dreamatic Skill contracts are migrated.",
      parameters: Type.Object({ name: Type.String(), arguments: Type.Optional(Type.String()) }),
      async execute(_id, params, _signal, _update, context) {
        const loaded = new DefaultResourceLoader({ cwd: context.cwd, agentDir: getAgentDir() });
        await loaded.reload();
        const skill = loaded.getSkills().skills.find((candidate) => candidate.name === params.name);
        if (!skill) throw new Error(`Unknown Pi Skill: ${params.name}`);
        const content = await readFile(skill.filePath, "utf8");
        return {
          content: [{
            type: "text",
            text: `Loaded Skill: ${skill.name}\nBase directory: ${skill.baseDir}\n${params.arguments ? `Arguments: ${params.arguments}\n` : ""}\n${content}`,
          }],
          details: { name: skill.name, path: skill.filePath, source: "pi-resource-loader" },
        };
      },
    });

    pi.registerTool({
      name: "todo_write",
      label: "Update design plan",
      description: "Maintain the visible stage plan required by existing Dreamatic workflow contracts.",
      parameters: Type.Object({
        runId: Type.Optional(Type.String()),
        items: Type.Array(Type.Object({
          id: Type.String(),
          text: Type.String(),
          status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
        })),
      }),
      async execute(_id, params) {
        todos.splice(0, todos.length, ...params.items);
        let path: string | undefined;
        if (params.runId) {
          const runId = safeRunId(params.runId);
          const progressPath = resolveInside(workspaceDir, join("runs", runId, "plan", "progress.json"));
          await mkdir(dirname(progressPath), { recursive: true });
          await writeFile(progressPath, JSON.stringify({ runId, updatedAt: new Date().toISOString(), items: todos }, null, 2), "utf8");
          path = relative(workspaceDir, progressPath).replaceAll("\\", "/");
        }
        return textResult({ ok: true, items: todos, persistedPath: path ?? null });
      },
    });

    pi.registerTool({
      name: "run_init",
      label: "Initialize design run",
      description: "Initialize a persistent Dreamatic workflow run, brief, directories, and coordination bus.",
      parameters: Type.Object({
        brief: Type.String(),
        projectTitle: Type.String({
          minLength: 2,
          maxLength: 48,
          description: "A concise, distinctive human-facing name created for this project. Name the design concept; do not copy the user's full request or use generic labels such as Untitled design.",
        }),
        workflowSkill: Type.Optional(Type.String()),
        workflowProfile: Type.Optional(Type.Union([Type.Literal("compact"), Type.Literal("full")])),
        context: Type.Optional(Type.String()),
        resolvedScope: Type.Optional(Type.String()),
        domainContext: Type.Optional(Type.String()),
        runIdOverride: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        const generatedId = `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
        const runId = safeRunId(options.projectId ?? params.runIdOverride ?? generatedId);
        const runDir = resolveInside(workspaceDir, join("runs", runId));
        const existingBrief: Record<string, unknown> = await readFile(join(runDir, "brief.json"), "utf8").then((source) => JSON.parse(source) as Record<string, unknown>).catch(() => ({}));
        const existingState: Record<string, unknown> = await readFile(join(runDir, "run-state.json"), "utf8").then((source) => JSON.parse(source) as Record<string, unknown>).catch(() => ({}));
        if (typeof existingState.status === "string" && existingState.status !== "draft") {
          throw new Error(`Run ${runId} is already initialized; resume it instead of calling run_init again`);
        }
        function parsed(value: string | undefined): unknown {
          if (!value?.trim()) return null;
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return value;
          }
        }
        const context = parsed(params.context);
        const resolvedScope = parsed(params.resolvedScope);
        const domainContext = parsed(params.domainContext);
        const projectTitle = params.projectTitle.trim();
        if (!projectTitle) throw new Error("projectTitle must be a concise human-facing project name");
        const namedScope = resolvedScope && typeof resolvedScope === "object" && !Array.isArray(resolvedScope)
          ? { ...(resolvedScope as Record<string, unknown>), human_title: projectTitle }
          : { human_title: projectTitle };
        for (const directory of [
          "research/assets",
          "plan",
          "artifacts/generated-images",
          "artifacts/edits",
          "review",
          "final",
        ]) await mkdir(join(runDir, directory), { recursive: true });
        const workflowProfile = params.workflowProfile ?? "compact";
        const brief = {
          runId,
          createdAt: typeof existingBrief.createdAt === "string" ? existingBrief.createdAt : new Date().toISOString(),
          ...(typeof existingBrief.sessionId === "string" ? { sessionId: existingBrief.sessionId } : {}),
          title: projectTitle,
          titleStatus: "canonical",
          brief: params.brief,
          workflowSkill: params.workflowSkill ?? "",
          workflowProfile,
          budgets: WORKFLOW_BUDGETS[workflowProfile],
          context,
          resolvedScope: namedScope,
          domainContext,
        };
        await writeFile(join(runDir, "brief.json"), JSON.stringify(brief, null, 2), "utf8");
        await writeFile(join(runDir, "bus.jsonl"), "", { encoding: "utf8", flag: "a" });
        await updateRunState(workspaceDir, runId, "initialized");
        await updateDesignContextIndex(workspaceDir, runId, "initialized");
        return textResult({
          ok: true,
          runId,
          projectTitle,
          runDir,
          designContext: join(runDir, "design-context.json"),
          researchDir: join(runDir, "research"),
          researchAssetsDir: join(runDir, "research", "assets"),
          planDir: join(runDir, "plan"),
          artifactsDir: join(runDir, "artifacts"),
          generatedImagesDir: join(runDir, "artifacts", "generated-images"),
          editsDir: join(runDir, "artifacts", "edits"),
          reviewDir: join(runDir, "review"),
          finalDir: join(runDir, "final"),
          bus: join(runDir, "bus.jsonl"),
        });
      },
    });

    pi.registerTool({
      name: "design_bus_post",
      label: "Post workflow event",
      description: "Append a structured event to a design run's workflow bus.",
      parameters: Type.Object({
        runId: Type.String(),
        type: Type.String(),
        phase: Type.Optional(Type.String()),
        from: Type.Optional(Type.String()),
        to: Type.Optional(Type.String()),
        from_agent: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        severity: Type.Optional(Type.String()),
        round: Type.Optional(Type.Number()),
        artifactRefs: Type.Optional(Type.Array(Type.String())),
        requestedAction: Type.Optional(Type.String()),
        payload: Type.Optional(Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())])),
        replyTo: Type.Optional(Type.String()),
        runDir: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        const runId = safeRunId(params.runId);
        if (options.parentInvocation) {
          if (runId !== options.parentInvocation.runId) throw new Error(`${options.parentInvocation.agent} may only post to its assigned Run`);
          const allowed = STAGE_COMPLETION_EVENTS[options.parentInvocation.agent] ?? [];
          if (!allowed.includes(params.type)) throw new Error(`${options.parentInvocation.agent} may only post ${allowed.join(" or ")}`);
          if (params.from_agent !== options.parentInvocation.agent) throw new Error(`from_agent must be ${options.parentInvocation.agent}`);
          if (params.to !== "orchestrator") throw new Error("Specialist completion events must be addressed to orchestrator");
          if (!params.summary?.trim()) throw new Error("Specialist completion events require a summary");
          if (!params.artifactRefs?.length) throw new Error("Specialist completion events require artifactRefs");
        }
        const runDir = resolveInside(workspaceDir, join("runs", runId));
        await mkdir(runDir, { recursive: true });
        if (options.parentInvocation) await normalizeStageOutputs(runDir, options.parentInvocation.agent);
        if (options.parentInvocation?.agent === "researcher") await writeResearchAcquisitionStatus(runDir, runId);
        if (options.parentInvocation) await validateStageOutputs(runDir, runId, options.parentInvocation.agent, params.type);
        const commitReceipt = options.parentInvocation
          ? {
              schemaVersion: 1,
              files: Object.fromEntries(await Promise.all((STAGE_REQUIRED_FILES[options.parentInvocation.agent] ?? []).map(async (path) => [
                path,
                createHash("sha256").update(await readFile(resolveInside(runDir, path))).digest("hex"),
              ]))),
            }
          : undefined;
        const event = { id: randomUUID(), ...params, runId, ...(commitReceipt ? { commitReceipt } : {}), at: new Date().toISOString() };
        await appendFile(join(runDir, "bus.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
        await updateRunState(workspaceDir, runId, params.type);
        await updateDesignContextIndex(workspaceDir, runId, params.type);
        return textResult({ ok: true, event });
      },
    });

    pi.registerTool({
      name: "design_context_read",
      label: "Read compact Design Context",
      description: "Read one role-specific, compact, hashed view of the authoritative Run files.",
      parameters: Type.Object({
        runId: Type.String(),
        audience: Type.Union([Type.Literal("researcher"), Type.Literal("designer"), Type.Literal("reviewer"), Type.Literal("builder")]),
      }),
      async execute(_id, params) {
        const runDir = resolveInside(workspaceDir, join("runs", safeRunId(params.runId)));
        const common = ["brief.json", "design-context.json"];
        const byAudience = {
          researcher: ["research/evidence.json", "research/research.md", "research/brand_lock.md", "research/assets/manifest.json"],
          designer: ["research/evidence.json", "research/research.md", "research/brand_lock.md", "research/assets/manifest.json", "review/design-review.json"],
          reviewer: ["research/evidence.json", "research/research.md", "research/brand_lock.md", "plan/design_system.json", "plan/design_plan.json", "plan/deliverable_manifest.json", "plan/acceptance_criteria.md", "plan/task_breakdown.md", "review/design-review.json"],
          builder: ["research/brand_lock.md", "plan/design_system.json", "plan/design_plan.json", "plan/deliverable_manifest.json", "plan/acceptance_criteria.md", "plan/task_breakdown.md", "review/design-review.json"],
        } as const;
        const files = [];
        for (const path of [...common, ...byAudience[params.audience]]) {
          const source = await readFile(resolveInside(runDir, path), "utf8").catch(() => undefined);
          if (source === undefined) continue;
          const limit = path.endsWith("design_plan.json") ? 24_000 : 12_000;
          files.push({
            path,
            sha256: createHash("sha256").update(source).digest("hex"),
            truncated: source.length > limit,
            content: source.length > limit ? `${source.slice(0, limit)}\n[truncated; use read for a targeted detail]` : source,
          });
        }
        const busSource = await readFile(resolveInside(runDir, "bus.jsonl"), "utf8").catch(() => "");
        const recentEvents = busSource.split(/\r?\n/).filter(Boolean).slice(-30).flatMap((line) => {
          try { return [JSON.parse(line) as unknown]; } catch { return []; }
        });
        return textResult({ ok: true, runId: params.runId, audience: params.audience, files, recentEvents });
      },
    });

    pi.registerTool({
      name: "design_bus_read",
      label: "Read workflow events",
      description: "Read structured workflow events for a Dreamatic design run.",
      parameters: Type.Object({
        runId: Type.String(),
        runDir: Type.Optional(Type.String()),
        agent: Type.Optional(Type.String()),
        type: Type.Optional(Type.String()),
        minRound: Type.Optional(Type.Number()),
        sinceMessageId: Type.Optional(Type.String()),
        includeAll: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id, params) {
        const path = resolveInside(workspaceDir, join("runs", safeRunId(params.runId), "bus.jsonl"));
        const content = await readFile(path, "utf8").catch(() => "");
        let events = content
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        if (params.type) events = events.filter((event) => event.type === params.type);
        if (params.agent && !params.includeAll) events = events.filter((event) => event.to === params.agent || event.to === "all");
        if (params.minRound !== undefined) events = events.filter((event) => typeof event.round !== "number" || event.round >= params.minRound!);
        events = events.slice(-(params.limit ?? 200));
        return textResult({ ok: true, events });
      },
    });

    pi.registerTool({
      name: "view_image",
      label: "View image",
      description: "Load or reload a local image into the model's visual context for design inspection.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, params) {
        const image = await imageBlock(workspaceDir, params.path);
        return {
          content: [
            { type: "text", text: `Visual inspection target: ${basename(image.path)}` },
            image.block,
          ],
          details: { path: params.path, bytes: image.bytes, preview: image.preview },
        };
      },
    });

    pi.registerTool({
      name: "image_generate",
      label: "Generate image",
      description: "Generate a design image and save it inside a Dreamatic run.",
      parameters: Type.Object({
        runId: Type.String(),
        id: Type.String({ description: "Stable filename stem" }),
        intent: Type.String({ description: "What this visual must communicate or accomplish" }),
        prompt: Type.String(),
        acceptanceCriteria: Type.Array(Type.String(), { minItems: 1 }),
        preserve: Type.Optional(Type.Array(Type.String())),
        outputPath: Type.Optional(Type.String({ description: "PNG path relative to the run directory; must stay under artifacts/" })),
        size: Type.Optional(Type.String()),
      }),
      async execute(_id, params, signal, onUpdate) {
        const summary = await generateImage(params, signal, (notice) => onUpdate?.({
            content: [{ type: "text", text: `Image generation retry ${notice.nextAttempt}: ${notice.error}` }],
            details: { retry: notice },
          }));
        return { content: [jsonText(summary)], details: summary };
      },
    });

    pi.registerTool({
      name: "image_generate_batch",
      label: "Generate image batch",
      description: "Generate an approved image set: the consistency anchor first, then independent images with bounded concurrency.",
      parameters: Type.Object({
        runId: Type.String(),
        anchorId: Type.Optional(Type.String()),
        tasks: Type.Array(Type.Object({
          id: Type.String(),
          intent: Type.String(),
          prompt: Type.String(),
          acceptanceCriteria: Type.Array(Type.String(), { minItems: 1 }),
          preserve: Type.Optional(Type.Array(Type.String())),
          outputPath: Type.Optional(Type.String()),
          size: Type.Optional(Type.String()),
        }), { minItems: 1 }),
      }),
      async execute(_id, params, signal, onUpdate) {
        const tasks = params.tasks.map((task) => ({ runId: params.runId, ...task }));
        const anchorIndex = params.anchorId ? tasks.findIndex((task) => task.id === params.anchorId) : 0;
        if (anchorIndex < 0) throw new Error(`Unknown anchorId: ${params.anchorId}`);
        const anchor = tasks[anchorIndex]!;
        const notify = (notice: RetryNotice) => onUpdate?.({ content: [{ type: "text", text: `Image generation retry ${notice.nextAttempt}: ${notice.error}` }], details: { retry: notice } });
        const generate = async (task: ImageGenerateTask): Promise<Record<string, unknown>> => {
          try {
            return await generateImage(task, signal, notify);
          } catch (error) {
            return { ok: false, id: task.id, error: error instanceof Error ? error.message : String(error) };
          }
        };
        const anchorResult = await generate(anchor);
        const remaining = tasks.filter((_, index) => index !== anchorIndex);
        const results = anchorResult.ok === true
          ? [anchorResult, ...await mapWithConcurrency(remaining, imageConcurrency, generate)]
          : [anchorResult, ...remaining.map((task) => ({ ok: false, id: task.id, skipped: true, error: `Skipped because consistency anchor ${anchor.id} failed` }))];
        return textResult({ action: "image_generate_batch", anchorId: anchor.id, count: results.length, ...batchSummary(results) });
      },
    });

    pi.registerTool({
      name: "image_edit",
      label: "Edit image",
      description: "Edit one or more reference images and save the result inside a Dreamatic run. Use for visual changes that benefit from generative editing, not deterministic typography, labels, arrows, or precision diagram layout.",
      parameters: Type.Object({
        runId: Type.String(),
        id: Type.String(),
        intent: Type.String({ description: "What the edited visual must accomplish" }),
        diagnosis: Type.Array(Type.String(), { minItems: 1 }),
        changes: Type.Array(Type.String(), { minItems: 1 }),
        preserve: Type.Array(Type.String(), { minItems: 1 }),
        prompt: Type.String(),
        referenceImagePaths: Type.Array(Type.String(), { minItems: 1 }),
        acceptanceCriteria: Type.Array(Type.String(), { minItems: 1 }),
        outputPath: Type.Optional(Type.String({ description: "PNG path relative to the run directory; must stay under artifacts/" })),
        size: Type.Optional(Type.String()),
      }),
      async execute(_id, params, signal, onUpdate) {
        return enqueueImageOperation(async () => {
        const size = params.size ?? imageSizeCeiling();
        assertImageSizeWithinCeiling(size, "image_edit.size");
        const apiKey = process.env.DREAMATIC_IMAGE_API_KEY?.trim() || process.env.DREAMATIC_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
        if (!apiKey) throw new Error("DREAMATIC_IMAGE_API_KEY, DREAMATIC_API_KEY, or OPENAI_API_KEY is not configured");
        const form = new FormData();
        form.set("model", process.env.DREAMATIC_IMAGE_MODEL ?? "gpt-image-1");
        form.set("prompt", params.prompt);
        form.set("size", size);
        form.set("n", "1");
        form.set("response_format", process.env.DREAMATIC_IMAGE_RESPONSE_FORMAT ?? "b64_json");
        for (const referencePath of params.referenceImagePaths) {
          const path = resolveInside(workspaceDir, referencePath);
          const mimeType = IMAGE_MIME.get(extname(path).toLowerCase());
          if (!mimeType) throw new Error(`Unsupported reference image: ${referencePath}`);
          const bytes = await readFile(path);
          form.append("image", new Blob([Uint8Array.from(bytes)], { type: mimeType }), basename(path));
        }
        const baseUrl = (process.env.DREAMATIC_IMAGE_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
        const endpoint = process.env.DREAMATIC_IMAGE_EDIT_ENDPOINT?.trim() || `${baseUrl}/images/edits`;
        const idempotencyKey = createHash("sha256").update(`${params.runId}\0${params.id}\0${params.prompt}\0${params.referenceImagePaths.join("|")}`).digest("hex");
        const response = await resilientFetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Idempotency-Key": idempotencyKey },
          body: form,
        }, {
          workspaceDir,
          runId: params.runId,
          operation: "image_edit",
          budgetScope: params.id,
          timeoutMs: Number(process.env.DREAMATIC_IMAGE_EDIT_TIMEOUT_MS ?? 180_000),
          attempts: Number(process.env.DREAMATIC_IMAGE_EDIT_RETRY_ATTEMPTS ?? 2),
          ...(signal ? { signal } : {}),
          onRetry: (notice) => onUpdate?.({
            content: [{ type: "text", text: `Image editing retry ${notice.nextAttempt}: ${notice.error}` }],
            details: { retry: notice },
          }),
        });
        if (!response.ok) throw new Error(`Image edit failed (${response.status}): ${await response.text()}`);
        const payload = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
        const saved = await saveImageResponse(
          workspaceDir,
          safeRunId(params.runId),
          safeRunId(params.id),
          params.prompt,
          "image_edit",
          payload,
          params.referenceImagePaths,
          params.outputPath,
          {
            intent: params.intent,
            diagnosis: params.diagnosis,
            changes: params.changes,
            preserve: params.preserve,
            acceptanceCriteria: params.acceptanceCriteria,
          },
        );
        const summary = {
          ok: true,
          action: "image_edit",
          path: saved.path,
          sidecarPath: saved.sidecarPath,
          references: params.referenceImagePaths,
          intent: params.intent,
          diagnosis: params.diagnosis,
          changes: params.changes,
          preserve: params.preserve,
          acceptanceCriteria: params.acceptanceCriteria,
          instruction: "The declared edited file was created. Continue directly without a second visual audit.",
        };
        return {
          content: [jsonText(summary)],
          details: summary,
        };
        });
      },
    });

    pi.registerTool({
      name: "compare_images",
      label: "Compare design images",
      description: "Load two to six labeled local images together so the model can compare real visual evidence against explicit criteria.",
      parameters: Type.Object({
        candidates: Type.Array(Type.Object({
          id: Type.String(),
          path: Type.String(),
        }), { minItems: 2, maxItems: 6 }),
        criteria: Type.Array(Type.String(), { minItems: 1 }),
      }),
      async execute(_id, params) {
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          jsonText({
            action: "compare_images",
            criteria: params.criteria,
            candidates: params.candidates,
            instruction: "Compare only what is visible. Name the strongest candidate, criterion-by-criterion evidence, regressions, and remaining risks.",
          }),
        ];
        const details: Array<{ id: string; path: string; bytes: number; preview: { bytes: number; width: number | undefined; height: number | undefined; originalWidth: number | undefined; originalHeight: number | undefined } }> = [];
        for (const candidate of params.candidates) {
          const image = await imageBlock(workspaceDir, candidate.path);
          content.push({ type: "text", text: `Candidate ${candidate.id}: ${candidate.path}` });
          content.push(image.block);
          details.push({ id: candidate.id, path: candidate.path, bytes: image.bytes, preview: image.preview });
        }
        return { content, details: { criteria: params.criteria, candidates: details } };
      },
    });

    pi.registerTool({
      name: "select_artifact",
      label: "Select final artifact",
      description: "Persist the selected visual artifact and evidence-based decision for a run.",
      parameters: Type.Object({
        runId: Type.String(),
        selectedPath: Type.String(),
        rejectedPaths: Type.Optional(Type.Array(Type.String())),
        reason: Type.Array(Type.String(), { minItems: 1 }),
        remainingRisks: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, params) {
        const runId = safeRunId(params.runId);
        const runDir = resolveInside(workspaceDir, join("runs", runId));
        const artifactsDir = resolveInside(workspaceDir, join("runs", runId, "artifacts"));
        const validateArtifact = async (workspacePath: string) => {
          const normalized = workspacePath.replaceAll("\\", "/");
          const path = normalized.startsWith("artifacts/")
            ? resolveInside(runDir, normalized)
            : resolveInside(workspaceDir, workspacePath);
          const fromArtifacts = relative(artifactsDir, path);
          if (fromArtifacts === ".." || fromArtifacts.startsWith(`..\\`) || fromArtifacts.startsWith("../")) {
            throw new Error(`Artifact must belong to run ${runId}: ${workspacePath}`);
          }
          await stat(path);
          return relative(workspaceDir, path).replaceAll("\\", "/");
        };
        const selectedPath = await validateArtifact(params.selectedPath);
        const rejectedPaths = await Promise.all((params.rejectedPaths ?? []).map(validateArtifact));
        const selection = {
          runId,
          selectedPath,
          rejectedPaths,
          reason: params.reason,
          remainingRisks: params.remainingRisks ?? [],
          selectedAt: new Date().toISOString(),
        };
        const selectionPath = join(artifactsDir, "selection.json");
        await writeFile(selectionPath, JSON.stringify(selection, null, 2), "utf8");
        return textResult({
          ok: true,
          selectionPath: relative(workspaceDir, selectionPath).replaceAll("\\", "/"),
          selection,
        });
      },
    });

    pi.registerTool({
      name: "build_finalize",
      label: "Finalize build",
      description: "Deterministically create the artifact manifest and local gallery, run mechanical lint, and commit build_done in one call after all approved outputs exist.",
      parameters: Type.Object({
        runId: Type.String(),
        summary: Type.Optional(Type.String()),
        requestedAction: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        if (options.parentInvocation?.agent !== "builder") throw new Error("build_finalize is available only inside a Builder invocation");
        const runId = safeRunId(params.runId);
        if (runId !== options.parentInvocation.runId) throw new Error("Builder may finalize only its assigned Run");
        const runDir = resolveInside(workspaceDir, join("runs", runId));
        const plan = await readJsonRecord(runDir, "plan/design_plan.json");
        const deliverableManifest = await readJsonRecord(runDir, "plan/deliverable_manifest.json");
        const prompts = requiredArray(plan, "image_generation_plan", "plan/design_plan.json")
          .map((item, index) => requiredRecord(item, `plan/design_plan.json.image_generation_plan[${index}]`));
        const deliverables = requiredArray(deliverableManifest, "deliverables", "plan/deliverable_manifest.json")
          .map((item, index) => requiredRecord(item, `plan/deliverable_manifest.json.deliverables[${index}]`));
        const requiredDeliverables = deliverables.filter((deliverable) => deliverable.required === true);
        const runtimeOwnedFiles = new Set([
          "artifacts/artifact-manifest.json",
          "artifacts/lint-report.json",
          "artifacts/00-gallery.html",
        ]);
        const implementationDeliverables = requiredDeliverables.filter((deliverable) => {
          const file = typeof deliverable.file === "string" ? deliverable.file.replaceAll("\\", "/") : "";
          return !runtimeOwnedFiles.has(file);
        });
        const artifacts = [];
        for (const [index, deliverable] of implementationDeliverables.entries()) {
          const label = `plan/deliverable_manifest.json.deliverables[${index}]`;
          const id = requiredString(deliverable, "id", label);
          const file = requiredString(deliverable, "file", label).replaceAll("\\", "/");
          if (!file.startsWith("artifacts/") || file.includes("../")) throw new Error(`${label}.file must stay inside artifacts/`);
          const absolutePath = resolveInside(runDir, file);
          const info = await stat(absolutePath).catch(() => null);
          if (!info?.isFile() || info.size === 0) throw new Error(`Required build output is missing or empty: ${file}`);
          const method = requiredString(deliverable, "method", label);
          const prompt = prompts.find((entry) => entry.id === id);
          artifacts.push({
            deliverableId: id,
            path: file,
            method,
            bytes: info.size,
            sourceReferencePaths: Array.isArray(prompt?.reference_ids_or_paths) ? prompt.reference_ids_or_paths : [],
            provenance: {
              plan: "plan/design_plan.json",
              ...(prompt ? {
                prompt: "Approved image_generation_plan entry executed without design changes.",
                size: prompt.size,
                preservationRules: Array.isArray(prompt.preservation_rules) ? prompt.preservation_rules : [],
              } : { implementation: "Approved manual deliverable" }),
            },
            executionResult: "created",
            knownMechanicalDeviations: [],
          });
        }
        const artifactsDir = resolveInside(runDir, "artifacts");
        await mkdir(artifactsDir, { recursive: true });
        const artifactManifestPath = join(artifactsDir, "artifact-manifest.json");
        await writeFile(artifactManifestPath, JSON.stringify({ runId, generatedAt: new Date().toISOString(), artifacts }, null, 2), "utf8");
        const brief = await readJsonRecord(runDir, "brief.json");
        const title = typeof brief.projectTitle === "string" && brief.projectTitle.trim() ? brief.projectTitle : runId;
        const figures = implementationDeliverables.map((deliverable) => {
          const file = requiredString(deliverable, "file", "deliverable").replaceAll("\\", "/").replace(/^artifacts\//u, "");
          const purpose = typeof deliverable.purpose === "string" ? deliverable.purpose : "Approved design output";
          return /\.(png|jpe?g|webp|gif)$/iu.test(file)
            ? `<figure><img src="${escapeHtml(file)}" alt=""><figcaption>${escapeHtml(purpose)}</figcaption></figure>`
            : `<p><a href="${escapeHtml(file)}">${escapeHtml(file)}</a> — ${escapeHtml(purpose)}</p>`;
        }).join("\n");
        const gallery = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;background:#171813;color:#f4f2e9;font:15px/1.6 system-ui;padding:clamp(20px,5vw,72px)}main{max-width:1200px;margin:auto}h1{font-size:clamp(32px,6vw,72px);letter-spacing:-.04em}figure{margin:32px 0}img{display:block;max-width:100%;height:auto;border-radius:12px;background:#292a25}figcaption,p{color:#b9bbb1}a{color:#d7e99b}</style></head><body><main><small>DREAMATIC / ${escapeHtml(runId)}</small><h1>${escapeHtml(title)}</h1>${figures}</main></body></html>`;
        const galleryPath = join(artifactsDir, "00-gallery.html");
        await writeFile(galleryPath, gallery, "utf8");
        const visualCount = implementationDeliverables.filter((deliverable) => /\.(png|jpe?g|webp)$/iu.test(String(deliverable.file ?? ""))).length;
        const lint = { runId, ...await lintArtifactDirectory(runDir, artifactsDir, visualCount, true) };
        const lintPath = join(artifactsDir, "lint-report.json");
        await writeFile(lintPath, JSON.stringify(lint, null, 2), "utf8");
        if (!lint.ok) throw new Error(`Build mechanical validation failed: ${lint.issues.join("; ")}`);
        await validateStageOutputs(runDir, runId, "builder", "build_done");
        const artifactRefs = [
          ...implementationDeliverables.map((deliverable) => requiredString(deliverable, "file", "deliverable")),
          "artifacts/artifact-manifest.json",
          "artifacts/lint-report.json",
          "artifacts/00-gallery.html",
        ];
        const commitReceipt = {
          schemaVersion: 1,
          files: Object.fromEntries(await Promise.all((STAGE_REQUIRED_FILES.builder ?? []).map(async (path) => [
            path,
            createHash("sha256").update(await readFile(resolveInside(runDir, path))).digest("hex"),
          ]))),
        };
        const event = {
          id: randomUUID(),
          runId,
          type: "build_done",
          from: "builder",
          from_agent: "builder",
          to: "orchestrator",
          phase: "build",
          summary: params.summary?.trim() || `Implemented ${implementationDeliverables.length} approved deliverable(s); deterministic mechanical validation passed.`,
          artifactRefs,
          requestedAction: params.requestedAction?.trim() || "Export the approved implementation package.",
          commitReceipt,
          at: new Date().toISOString(),
        };
        await appendFile(join(runDir, "bus.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
        await updateRunState(workspaceDir, runId, "build_done");
        await updateDesignContextIndex(workspaceDir, runId, "build_done");
        return textResult({ ok: true, runId, event, artifacts, lint });
      },
    });

    pi.registerTool({
      name: "artifact_lint",
      label: "Lint artifacts",
      description: "Check a run for empty files, missing generated images, and unsafe external gallery references.",
      parameters: Type.Object({
        runId: Type.String(),
        runDir: Type.Optional(Type.String()),
        artifactsDir: Type.Optional(Type.String()),
        minPngs: Type.Optional(Type.Number()),
        requireGallery: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params) {
        const runId = safeRunId(params.runId);
        const runDir = params.runDir ? resolveInside(workspaceDir, params.runDir) : resolveInside(workspaceDir, join("runs", runId));
        const reportPath = resolveInside(runDir, "artifacts/lint-report.json");
        const existingReport = await readFile(reportPath, "utf8")
          .then((source) => JSON.parse(source) as Record<string, unknown>)
          .catch(() => undefined);
        if (existingReport?.ok === true) return textResult({ ...existingReport, reused: true });
        const artifactsDir = params.artifactsDir
          ? resolveInside(runDir, params.artifactsDir)
          : resolveInside(runDir, "artifacts");
        const requiredImages = Math.max(0, params.minPngs ?? 1);
        const report = {
          runId,
          ...await lintArtifactDirectory(runDir, artifactsDir, requiredImages, params.requireGallery === true),
          scope: relative(runDir, artifactsDir).replaceAll("\\", "/") || ".",
        };
        await mkdir(resolveInside(runDir, "artifacts"), { recursive: true });
        await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
        return textResult(report);
      },
    });

    pi.registerTool({
      name: "export_package",
      label: "Export design package",
      description: "Assemble a self-contained final delivery folder with artifacts, plans, research, review, manifest, and index.",
      parameters: Type.Object({
        runId: Type.String(),
        runDir: Type.String(),
        finalDir: Type.Optional(Type.String()),
        brief: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        const runId = safeRunId(params.runId);
        const runDir = resolveInside(workspaceDir, params.runDir);
        const busEvents = (await readFile(join(runDir, "bus.jsonl"), "utf8").catch(() => ""))
          .split(/\r?\n/)
          .filter(Boolean)
          .flatMap((line) => {
            try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
          });
        const finalGateEvents = busEvents.filter((event) => ["design_spec_ready", "design_revision_ready", "design_review_pass", "design_review_fail", "build_done"].includes(String(event.type ?? "")));
        const buildDoneIndex = finalGateEvents.findLastIndex((event) => event.type === "build_done");
        const precedingDesignGate = finalGateEvents.slice(0, buildDoneIndex).findLast((event) => ["design_spec_ready", "design_revision_ready", "design_review_pass", "design_review_fail"].includes(String(event.type ?? "")));
        if (buildDoneIndex < 0 || buildDoneIndex !== finalGateEvents.length - 1 || precedingDesignGate?.type !== "design_review_pass") {
          throw new Error(`Run ${runId} cannot be exported before an approved Design Context is implemented and build_done is committed`);
        }
        const lint = await readJsonRecord(runDir, "artifacts/lint-report.json");
        if (lint.ok !== true) throw new Error(`Run ${runId} cannot be exported before Builder mechanical lint passes`);
        await updateRunState(workspaceDir, runId, "export_started");
        const finalDir = params.finalDir
          ? resolveInside(workspaceDir, params.finalDir)
          : resolveInside(workspaceDir, join("runs", runId, "final"));
        await mkdir(finalDir, { recursive: true });
        for (const name of ["research", "plan", "artifacts", "review"]) {
          const source = join(runDir, name);
          if (await stat(source).then(() => true).catch(() => false)) await cp(source, join(finalDir, name), { recursive: true, force: true });
        }
        const busPath = join(runDir, "bus.jsonl");
        if (await stat(busPath).then(() => true).catch(() => false)) await cp(busPath, join(finalDir, "bus.jsonl"), { force: true });
        const files = await listFiles(finalDir);
        await writeFile(join(finalDir, "package-manifest.json"), JSON.stringify({ runId, exportedAt: new Date().toISOString(), files }, null, 2), "utf8");

        // The Designer-authored gallery is the reviewed design narrative. Keep it as the
        // package entry instead of flattening the delivery back into a filename grid.
        // The base element preserves its artifact-relative image paths after the page is
        // promoted from final/artifacts/00-gallery.html to final/00-index.html.
        const galleryPath = join(finalDir, "artifacts", "00-gallery.html");
        const gallery = await readFile(galleryPath, "utf8").catch(() => "");
        const html = gallery
          ? /<base\b/i.test(gallery)
            ? gallery
            : gallery.replace(/<head([^>]*)>/i, '<head$1><base href="artifacts/">')
          : `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(runId)}</title><style>body{margin:0;background:#ebe9e2;color:#24251f;font:15px system-ui;padding:6vw}header{max-width:800px}h1{font-size:clamp(36px,7vw,86px);letter-spacing:-.06em;margin:.2em 0}p{color:#74766d;line-height:1.6}</style></head><body><header><small>DREAMATIC / ${escapeHtml(runId)}</small><h1>Design delivery</h1><p>${escapeHtml(params.brief ?? "A complete, inspectable design run.")}</p></header></body></html>`;
        await writeFile(join(finalDir, "00-index.html"), html, "utf8");
        await updateRunState(workspaceDir, runId, "export_done");
        await updateDesignContextIndex(workspaceDir, runId, "export_done");
        const progressPath = join(runDir, "plan", "progress.json");
        const progress = await readFile(progressPath, "utf8")
          .then((source) => JSON.parse(source) as { runId?: string; items?: Array<{ id: string; text: string; status: string }> })
          .catch(() => undefined);
        if (progress?.items) {
          await writeFile(progressPath, JSON.stringify({
            ...progress,
            runId,
            updatedAt: new Date().toISOString(),
            items: progress.items.map((item) => ({ ...item, status: "completed" })),
          }, null, 2), "utf8");
        }
        return textResult({ ok: true, runId, finalDir, files: await listFiles(finalDir) });
      },
    });
  };
}
