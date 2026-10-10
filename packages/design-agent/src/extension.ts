import { loadedRuntimeIdentity } from "./delivery-block.js";
import { ORCHESTRATOR_TOOLS } from "./orchestrator-contract.js";
import { upgradeDesignData } from "./design-context-v2.js";
import { readFileSync } from "node:fs";
import { checkHtmlBrowser } from "./html-delivery.js";
import { designTasks } from "./design-context-v2.js";
import { researchAcquisition, specialistStageContract } from "./workflow-contract.js";
import { approvedImageTask, approvedImageFingerprint, recordApprovedImage, assertApprovedImageRequest, type ApprovedImageTask } from "./approved-image.js";
import { registerContextAuthoring } from "./context-authoring.js";
import { ContextFailureTracker } from "./context-failures.js";
import { responseTimeoutReason, modelRecoveryTask, providerRequestSummary } from "./model-response-policy.js";
import { contextFailureIdentity, contextChangesExample } from "./context-tools.js";
import { roleContextSchema } from "./context-schema.js";
import { selectContextSection } from "./context-draft.js";
import { readRunContext, unifiedContextPrompt, legacyContextPrompt, canonicalContextError, writeContextFile, CONTEXT_FILES, CONTEXT_OWNERS, CONTEXT_PROJECTIONS, hasUnifiedContext, assertContextDocument, syncProjectContext, unifiedContextInstruction } from "./context-model.js";
import { recordReasoningModel, collectModelUsage, annotateModelUsage } from "./model-usage.js";
import {
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  getAgentDir,
  parseFrontmatter,
  SessionManager,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, cp, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { resolveInside, safeRunId } from "./paths.js";
import { RUN_CONTEXT_SECTIONS, RUN_DOCUMENT_ALIASES, canonicalRunDocument, runDocumentCandidates, findRunDocument } from "./run-files.js";
import { createModelImagePreview } from "./image-preview.js";
import { createIdleSleepGuard } from "./idle-sleep.js";
import { showcaseTemplate } from "./showcase-template.js";
import { annotateShowcasePrompts, appendShowcaseReferences } from "./showcase.js";
import { dreamaticProviderFromEnv, dreamaticThinkingLevel } from "./provider.js";
import { discoverResearchAssets, fetchResearchAsset, hasResearchPageCache, researchFetch, validateResearchAssets, webSearch } from "./research.js";
import { ResponseBodyTimeoutError, boundedResponseBytes, imageRequestScheduler, projectContext, serializeJsonWrite } from "./performance.js";
import { dreamaticSessionFailure, stopAfterCommittedTurn } from "./session-status.js";
import { isRetryableStatus, retryAfterMs, RetryableHttpError, withRetry, type RetryNotice } from "./retry.js";
import { DESIGN_CAPABILITIES, approvedImageEdit, approvedImageAcceptance, designSpecificationProtocol, unifiedDesignSpecificationProtocol, normalizeDraftPresentation, deliveryContract, designSourceFiles, fileHash, htmlTask, imagePlan, physicalRunFile, validateDeliveryContract } from "./design-contract.js";
import { extractUserMaterial } from "./user-material-extract.js";
import { importUserAsset, recordUserMaterialSources, userMaterialInventory } from "./user-assets.js";
import { lintHtmlSourceResources, materializeHtml } from "./html-delivery.js";
import { encodeImageOutput, imageBytesMatchPath, imageOutputFormat, type ImageOutputMime } from "./image-output.js";
import { imageSizeCeiling, assertImageSizeWithinCeiling } from "./image-size.js";
import { assertHtmlSourcePreflight } from "./html-preflight.js";
import { finalizeDelivery, pendingRequiredOutputs } from "./finalize-delivery.js";
import { skillMetadata, skillMatchesCategory, type SkillMetadata } from "./skill-metadata.js";
import { DESIGN_CATEGORIES, briefDesignScopes, designScopes, designScopeSkillProtocol, designClassificationMessage, isDesignCategory } from "./design-categories.js";
import { SkillActivation, skillReloadChecklist } from "./skill-activation.js";
import { validateDesignScopes } from "./design-scope-validation.js";
import { designerDraftReadiness, designerDraftFingerprint, designerFailureAttempts, designerHandoffError } from "./designer-recovery.js";
import { ExecutionRegistry } from "./execution-registry.js";
import { BuildIncomplete, DeliveryBlocked, deliveryRuntimeStamp } from "./delivery-block.js";

export interface DreamaticExtensionOptions {
  workspaceDir: string;
  projectId?: string | undefined;
  personaPath?: string;
  parentInvocation?: { id: string; agent: string; runId?: string };
}

export function dreamaticPersonaPromptBlock(body: string): string {
  return `<!-- DREAMATIC_ACTIVE_PERSONA -->\n${body}\n<!-- /DREAMATIC_ACTIVE_PERSONA -->`;
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
  researcher: RUN_CONTEXT_SECTIONS.research,
  designer: ["plan/design_system.json", "plan/design_plan.json", "plan/deliverable_manifest.json", "plan/acceptance_criteria.md", "plan/task_breakdown.md"],
  reviewer: ["review/design-review.md", "review/design-review.json"],
  builder: ["artifacts/artifact-manifest.json", "artifacts/00-gallery.html", "artifacts/lint-report.json"],
};

export const DREAMATIC_PERSONA_TOOL_POLICY = {
  orchestrator: ORCHESTRATOR_TOOLS,
  researcher: ["update_design_context", "commit_design_context", "user_material_extract", "user_asset_import", "read", "write", "write_json", "patch_json", "design_bus_post", "design_bus_read", "design_context_read", "websearch_batch", "research_fetch_batch", "research_asset_discover", "research_asset_fetch", "research_asset_fetch_batch"],
  designer: ["design_context_validate", "update_design_context", "commit_design_context", "user_asset_import", "read", "write", "ls", "list_skills", "use_skill", "design_bus_post", "design_bus_read", "design_context_read", "view_image"],
  reviewer: ["update_design_context", "commit_design_context", "read", "design_bus_post", "design_bus_read", "design_context_read"],
  builder: ["read", "write", "edit", "ls", "list_skills", "use_skill", "design_bus_read", "design_context_read", "execute_design_plan", "html_generate", "showcase_template", "build_finalize"],
} as const;

const DREAMATIC_SPECIALISTS = new Set(Object.keys(DREAMATIC_PERSONA_TOOL_POLICY).filter((persona) => persona !== "orchestrator"));

export function specialistRunAssignment(workspaceDir: string, runId: string, agent: string): string {
  const assignedRunId = safeRunId(runId);
  const runDir = resolveInside(workspaceDir, join("runs", assignedRunId));
  return `# Runtime-assigned Run\n\n${JSON.stringify({ agent, runId: assignedRunId, runDir })}\nThis is the authoritative assignment for this invocation, including recovery attempts. Use exactly this runId for tools that accept runId; Only update_design_context and commit_design_context omit runId and path. design_context_read uses this assigned runId; omission is filled by runtime for bound specialists. Use this assignment and this runDir for Run files. Never invent a Run id, derive it from a title, search sibling Runs, or substitute an older project with a similar subject. Start with design_context_read using this runId and your role. Missing plan outputs are normal before creation; they do not mean this assignment is wrong. If a tool rejects ownership, use the assigned id shown here rather than changing projects or retrying another write tool.`;
}

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

export function normalizeWriteJsonArguments(args: unknown, assignedRunId?: string, workspaceDir?: string): { runId: string; path: string; data: Record<string, unknown> } {
  const record = requiredRecord(args, "write_json arguments");
  const data = structuredClone(requiredRecord(record.data, "write_json.data"));
  const runId = record.runId ?? assignedRunId ?? data.runId;
  if (typeof runId !== "string" || !runId.trim()) throw new Error("write_json requires runId at the argument root");
  if (typeof data.runId === "string" && safeRunId(data.runId) !== safeRunId(runId)) throw new Error("write_json argument and data runId must agree");
  let path = record.path ?? data.path;
  if (path === undefined) {
    const candidates: string[] = [];
    if (Array.isArray(data.official_sources) && typeof data.target === "string") candidates.push("research/evidence.json");
    if (typeof data.system_thesis === "string" && data.palette && data.typography) candidates.push("plan/design_system.json");
    if (typeof data.design_intent === "string" && typeof data.design_system_ref === "string") candidates.push("plan/design_plan.json");
    if (Array.isArray(data.deliverables) && typeof data.design_system_ref === "string") candidates.push("plan/deliverable_manifest.json");
    if (candidates.length === 1) path = candidates[0];
  }
  if (typeof path !== "string" || !path.trim()) throw new Error("write_json requires an unambiguous Run-relative path at the argument root; do not nest the tool envelope inside data");
  if (isAbsolute(path) && workspaceDir) {
    const runDir = resolveInside(workspaceDir, join("runs", safeRunId(runId)));
    path = relative(runDir, resolveInside(runDir, path)).replaceAll("\\", "/");
  }
  return { runId, path: canonicalRunDocument(path as string), data };
}

export function normalizeDesignBusArguments(args: unknown, assignedRunId?: string, agent?: string): Record<string, unknown> & { runId: string; type: string } {
  const record = { ...requiredRecord(args, "design_bus_post arguments") };
  record.runId ??= assignedRunId;
  if (agent) {
    record.from_agent ??= agent;
    record.to ??= "orchestrator";
  }
  const required = agent ? ["runId", "type", "summary"] : ["runId", "type"];
  const missing = required.filter((key) => typeof record[key] !== "string" || !(record[key] as string).trim());
  if (missing.length) {
    const types = agent ? STAGE_COMPLETION_EVENTS[agent]?.join(" or ") : undefined;
    throw new Error(`design_bus_post missing root fields: ${missing.join(", ")}. ${types ? `Explicitly choose type: ${types}. ` : ""}Send {runId, type, from_agent, to, summary, artifactRefs, requestedAction} at the root; payload is optional supporting data, not the completion envelope. Correct these fields before retrying; no event was published.`);
  }
  return { ...record, runId: record.runId as string, type: record.type as string };
}

function hoistDesignPlanSections(record: Record<string, unknown>): boolean {
  const nested = record.concept_evaluation;
  if (record.image_generation_plan !== undefined || !nested || typeof nested !== "object" || Array.isArray(nested)) return false;
  const evaluation = nested as Record<string, unknown>;
  if (!Array.isArray(evaluation.image_generation_plan)) return false;
  for (const field of ["image_generation_plan", "decisions", "assumptions_and_risks", "collaboration_state", "skill_selection"]) {
    if (record[field] === undefined && evaluation[field] !== undefined) {
      record[field] = evaluation[field];
      delete evaluation[field];
    }
  }
  return true;
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

interface WorkflowBudget {
  searchQueries: number;
  sourceFetches: number;
}

const WORKFLOW_BUDGETS: Record<"compact" | "full", WorkflowBudget> = {
  compact: { searchQueries: 3, sourceFetches: 4 },
  full: { searchQueries: 8, sourceFetches: 10 },
};
const workflowUsage = new Map<string, number>();
const workflowRefinements = new Map<string, string>();
const workflowRequests = new Map<string, Set<string>>();

function currentWorkflowCycle<T extends Record<string, unknown>>(events: T[]): T[] {
  const start = events.findLastIndex((event) => ["run_revision_started", "run_brief_updated"].includes(String(event.type)));
  return events.slice(Math.max(0, start));
}

async function assertRoleWrite(workspaceDir: string, runId: string, agent: string, target: string): Promise<void> {
  const runDir = resolveInside(workspaceDir, join("runs", safeRunId(runId)));
  const path = resolveInside(runDir, target);
  const local = relative(runDir, path).replaceAll("\\", "/");
  const runtimeOwned = new Set(["brief.json", "run-state.json", "design-context.json", "bus.jsonl", "research/assets/validation.json", "artifacts/artifact-manifest.json", "artifacts/lint-report.json", "artifacts/model-usage.json", "plan/model-usage.json"]);
  const unified = await hasUnifiedContext(runDir);
  if (unified && Object.values(CONTEXT_PROJECTIONS).some((paths) => (paths as readonly string[]).includes(local))) throw new Error(`${local} is a retired read-only Context path; no such file is generated. Use named update_design_context changes followed by commit_design_context {}.`);
  const roots: Record<string, string> = { researcher: "research/", designer: "plan/", reviewer: "review/", builder: "artifacts/" };
  if (agent === "builder") {
    const plan = await readJsonRecord(runDir, "plan/design_plan.json").catch(() => undefined);
    const tasks = Array.isArray(plan?.execution_plan) ? plan.execution_plan as Record<string, unknown>[] : [];
    if (plan?.schemaVersion === 2 && tasks.filter((task) => task.method === "html_generate").some((task) => [...htmlTask(task).files, ...htmlTask(task).resources].some((file) => file.output === local))) {
      throw new Error(`Approved HTML output ${local} is generated mechanically. Use html_generate or execute_design_plan; restore changed outputs from approved sources. Design defects require Designer correction and a new Reviewer approval, not edits to artifacts or plan sources.`);
    }
  }
  const isAllowed = (candidate: string) => !(unified && Object.values(CONTEXT_PROJECTIONS).some((paths) => (paths as readonly string[]).includes(candidate))) && !runtimeOwned.has(candidate) && (CONTEXT_OWNERS[candidate] === agent || (agent === "orchestrator"
    ? candidate === "plan/progress.json" || candidate.startsWith("plan/handoff/")
    : !!roots[agent] && candidate.startsWith(roots[agent]!) && candidate !== "plan/progress.json"));
  if (!isAllowed(local)) throw new Error(`${agent} cannot write ${local}. ${agent === "designer" ? "HTML source must be plan/html/<scope-id>/index.html; map that source to artifacts/... in execution.files. Builder creates artifacts. " : ""}Write only your role-owned outputs; runtime-managed state and other roles' files are protected.`);
  const state = await readJsonRecord(runDir, "run-state.json").catch(() => undefined);
  if (state?.status === "complete") throw new Error("This Run is complete. Orchestrator must call run_revision with explicit user feedback before modifying it.");
  let ancestor = path;
  while (true) {
    try {
      const physical = await realpath(ancestor);
      const physicalRoot = await realpath(runDir);
      if (physicalRoot !== resolveInside(await realpath(workspaceDir), join("runs", safeRunId(runId)))) throw new Error("Assigned Run directory must not redirect through a symlink");
      const physicalTarget = resolveInside(physicalRoot, resolve(physical, relative(ancestor, path)));
      if (!isAllowed(relative(physicalRoot, physicalTarget).replaceAll("\\", "/"))) throw new Error("Symlink escapes the role-owned directory");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor || ancestor === runDir) break;
      ancestor = parent;
    }
  }
}

async function workflowBudget(runDir: string): Promise<{ profile: "compact" | "full"; budget: WorkflowBudget }> {
  const brief: Record<string, unknown> = await readFile(resolveInside(runDir, "brief.json"), "utf8")
    .then((source) => JSON.parse(source) as Record<string, unknown>)
    .catch((): Record<string, unknown> => ({}));
  const profile = brief.workflowProfile === "compact" ? "compact" : "full";
  return { profile, budget: WORKFLOW_BUDGETS[profile] };
}

const acquisitionLocks = new Map<string, Promise<void>>();
async function consumeWorkflowBudget(workspaceDir: string, runId: string, field: keyof WorkflowBudget, count: number, refinementReason?: string, requests: string[] = [], refreshUrls: string[] = []) {
  const safeId = safeRunId(runId);
  const runDir = resolveInside(workspaceDir, join("runs", safeId));
  const previous = acquisitionLocks.get(runDir) ?? Promise.resolve();
  let release!: () => void;
  const lock = new Promise<void>((resolve) => { release = resolve; });
  acquisitionLocks.set(runDir, lock);
  await previous;
  try {
    const { profile, budget } = await workflowBudget(runDir);
    const events = (await readFile(join(runDir, "bus.jsonl"), "utf8").catch(() => "")).split(/\r?\n/u).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
    const revision = events.findLast((event) => event.type === "run_revision_started");
    const cycle = String(revision?.id ?? revision?.at ?? "initial");
    const ledgerPath = join(runDir, ".performance", "acquisition-budget.json");
    type Entry = { used: number; requests: string[]; refinement?: string };
    const stored = await readFile(ledgerPath, "utf8").then((source) => JSON.parse(source) as { cycle: string; fields: Partial<Record<keyof WorkflowBudget, Entry>> }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
    const fields = stored?.cycle === cycle ? stored.fields : {};
    const entry = fields[field] ?? { used: 0, requests: [] };
    const identities = requests.map((request) => field === "searchQueries" ? request.trim().replace(/\s+/gu, " ").toLowerCase() : request.trim());
    if (new Set(identities).size !== identities.length) throw new Error("Research request already attempted; duplicate batch items are not allowed");
    const reusable = field === "sourceFetches" ? await Promise.all(identities.map(async (url) => !refreshUrls.includes(url) && await hasResearchPageCache(workspaceDir, safeId, url))) : identities.map(() => false);
    const seen = new Set(entry.requests);
    if (identities.some((request, index) => seen.has(request) && !reusable[index] && !refreshUrls.includes(request))) throw new Error("Research request already attempted. Reuse acquired results or change keywords/source for the unresolved gap.");
    const next = entry.used + Math.max(0, count - reusable.filter(Boolean).length);
    const refinement = entry.refinement ?? refinementReason?.trim();
    const limit = budget[field] * (refinement ? 2 : 1);
    if (next > limit) throw new Error(`${profile} workflow ${field} budget exceeded: ${next}/${limit}. A material evidence/figure gap can enable one bounded refinement reserve via refinementReason; otherwise report remaining gaps.`);
    fields[field] = { used: next, requests: [...new Set([...entry.requests, ...identities])], ...(refinement ? { refinement } : {}) };
    await mkdir(dirname(ledgerPath), { recursive: true });
    const temporary = `${ledgerPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ cycle, fields })); await rename(temporary, ledgerPath);
    return { profile, field, used: next, limit, remaining: limit - next, ...(reusable.some(Boolean) ? { cacheHits: reusable.filter(Boolean).length } : {}), ...(refinement ? { baseLimit: budget[field], refinementReason: refinement } : {}) };
  } finally { release(); if (acquisitionLocks.get(runDir) === lock) acquisitionLocks.delete(runDir); }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, operation: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      signal?.throwIfAborted();
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

async function readJsonRecord(runDir: string, path: string): Promise<Record<string, unknown>> {
  return requiredRecord(parseRunJson(await readRunContext(runDir, path), path), path);
}

function parseRunJson(source: string, path: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${path}: ${message}. Rewrite this file with valid JSON before publishing. Check nested object closures and the intended field hierarchy; do not simply append a bracket or retry design_bus_post unchanged.`, { cause: error });
  }
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
  if (await hasUnifiedContext(runDir)) {
    const path = agent === "researcher" ? CONTEXT_FILES.research : agent === "designer" ? CONTEXT_FILES.design : agent === "reviewer" ? CONTEXT_FILES.review : undefined;
    await assertContextDocument(runDir, CONTEXT_FILES.project, basename(runDir));
    if (path) await assertContextDocument(runDir, path, basename(runDir));
    if (agent === "researcher") {
      // Acquisition metadata belongs to tools; no Agent-authored second store.
      await mkdir(join(runDir, "research/assets"), { recursive: true });
      const manifest = join(runDir, "research/assets/manifest.json");
      if (!(await stat(manifest).catch(() => undefined))) await writeFile(manifest, JSON.stringify({ runId: basename(runDir), assets: [] }, null, 2));
    }
    return;
  }
  for (const required of STAGE_REQUIRED_FILES[agent] ?? []) {
    const existing = await findRunDocument(runDir, required);
    if (existing && existing.path !== required) await cp(existing.absolutePath, resolveInside(runDir, required), { errorOnExist: true, force: false });
  }
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
      if (Array.isArray(record.assets)) {
        for (const item of record.assets) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          changed = copyAlias(item as Record<string, unknown>, "file", ["local_path", "path", "localPath"]) || changed;
        }
      }
      return changed;
    });
    return;
  }
  if (agent === "designer") {
    // Typed drafts are authoritative. Failed publication must not rewrite them or invalidate SHA-256.
    if ((await readJsonRecord(runDir, "plan/design_plan.json").catch(() => undefined))?.schemaVersion === 2) return;
    await normalizeJsonFile(runDir, "plan/design_system.json", (record) => {
      let changed = copyAlias(record, "runId", ["run_id"]);
      changed = copyAlias(record, "system_thesis", ["systemThesis", "thesis"]) || changed;
      changed = copyAlias(record, "palette", ["colors", "colour_palette"]) || changed;
      changed = copyAlias(record, "typography", ["type_system", "fonts"]) || changed;
      return changed;
    });
    await normalizeJsonFile(runDir, "plan/design_plan.json", (record) => {
      let changed = hoistDesignPlanSections(record);
      changed = copyAlias(record, "runId", ["run_id"]) || changed;
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
          changed = copyAlias(deliverable, "file", ["path", "output_file", "output_path", "outputPath", "artifact_path"]) || changed;
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

function referenceReviewCoverage(manifest: Record<string, unknown> | undefined, plan: Record<string, unknown> | undefined) {
  const assets = Array.isArray(manifest?.assets) ? manifest.assets.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
  const decisions = Array.isArray(plan?.reference_use_decisions) ? plan.reference_use_decisions.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
  const missingAssetIds = assets.filter((asset) => !decisions.some((decision) => decision.asset_id === asset.id)).map((asset) => asset.id);
  const unreviewedAdoptions = decisions.filter((decision) => ["adopt", "transform"].includes(String(decision.decision)) && (decision.review_status !== "viewed" || !Array.isArray(decision.extracted_features) || decision.extracted_features.length === 0)).map((decision) => decision.asset_id);
  const warnings: string[] = [];

  if (unreviewedAdoptions.length) warnings.push(`Visual adoption requires inspection and observed features, not metadata alone: ${unreviewedAdoptions.join(", ")}.`);
  return { retainedAssets: assets.length, missingAssetIds, unreviewedAdoptions, warnings, coverageRequirement: "Record adopted or meaningfully considered references only. missingAssetIds lists unconsidered candidates, not mandatory corrections.", evidenceScope: "Declared screening coverage, not proof of actual visual reasoning" };
}

async function materializeDesignExecutionDocs(runDir: string): Promise<void> {
  if (await hasUnifiedContext(runDir)) return;
  const manifest = await readJsonRecord(runDir, "plan/deliverable_manifest.json");
  const deliverables = requiredArray(manifest, "deliverables", "plan/deliverable_manifest.json")
    .map((entry, index) => requiredRecord(entry, `deliverables[${index}]`));
  const marker = "Runtime-derived from the delivery specification.";
  const documents = {
    "plan/acceptance_criteria.md": `# Acceptance Criteria\n\n${marker}\n\n${deliverables.map((entry) => `- ${String(entry.id)}: ${String(entry.acceptance_test ?? "Must match the declared specification")} (${String(entry.file)}, ${String(entry.size ?? "manual layout")}).`).join("\n")}\n`,
    "plan/task_breakdown.md": `# Execution Index\n\n${marker}\n\nFollow dependencies in design_plan.json; independent image tasks may run concurrently.\n\n${deliverables.map((entry) => `- ${String(entry.id)}: ${String(entry.method)} → ${String(entry.file)}; ${entry.required === true ? "required" : "optional"}.`).join("\n")}\n`,
  };
  for (const [path, content] of Object.entries(documents)) {
    const existing = await readFile(resolveInside(runDir, path), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing === undefined || existing.includes(marker)) await writeFile(resolveInside(runDir, path), content, "utf8");
  }
}

async function validateStageOutputs(runDir: string, runId: string, agent: string, eventType: string, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
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
    const readiness = await designerDraftReadiness(runDir);
    if (!readiness.ok) throw new Error(readiness.issues.join("\n"));
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
    const generationPlan = imagePlan(plan);
    const contract = deliveryContract(plan, manifest);
    await validateDeliveryContract(runDir, contract);
    for (const task of contract.tasks.filter((task) => task.method === "html_generate")) {
      const issues = await lintHtmlSourceResources(runDir, htmlTask(task));
      if (issues.length) throw new Error(issues.join("; "));
    }
    await validateDesignScopes(runDir, plan, manifest);
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
      if (!["manual", "image_generate", "image_edit", ...(contract.schemaVersion === 2 ? ["html_generate"] : [])].includes(method)) throw new Error(`${label}.method is invalid`);
      if (method !== "manual" && method !== "html_generate") {
        const prompt = generationPlan.find((entry) => entry.id === id);
        if (!prompt) throw new Error(`Visual deliverable ${id} has no image_generation_plan entry with the same id. Available image ids: ${generationPlan.map((entry) => entry.id).join(", ") || "none"}. Use one identical id in both files; do not start a new generation or change only the completion event.`);
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
    await assertHtmlSourcePreflight(runDir, contract, signal);
    return;
  }
  if (agent === "reviewer") {
    const plan = await readJsonRecord(runDir, "plan/design_plan.json").catch(() => undefined);
    if (plan?.schemaVersion === 2 || briefDesignScopes(await readJsonRecord(runDir, "brief.json").catch(() => ({}))).length) await assertStageCommitted(dirname(dirname(runDir)), runId, "designer", 0, eventType === "design_review_pass");
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
    if (verdict === "pass") {
      assertReviewBuildReady(review);
      if (plan?.schemaVersion === 2) {
        const readiness = await designerDraftReadiness(runDir);
        if (!readiness.ok) throw new Error(readiness.issues.join("\n"));
        const contract = deliveryContract(plan, await readJsonRecord(runDir, "plan/deliverable_manifest.json"));
        const sourcePreflight = await assertHtmlSourcePreflight(runDir, contract, signal);
        return { policy: "generated-assets-and-approved-sources", executable: true, sourcePreflight };
      }
    }
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

function assertReviewBuildReady(review: Record<string, unknown>): void {
  const issues = Array.isArray(review.issues) ? review.issues as Record<string, unknown>[] : [];
  const unresolved = issues.filter((issue) => issue.status !== "resolved" && ["blocking", "major"].includes(String(issue.severity)));
  if (unresolved.length) throw new DeliveryBlocked("designer", unresolved.map((issue) =>
    `A passed review cannot contain an unresolved ${issue.severity} issue: ${issue.id ?? "unnamed"} (status: ${String(issue.status)}). Resolve it through the responsible specialist and a new Reviewer approval; accepted_risk cannot waive a required correction.`));
}

async function stageRequiredFiles(runDir: string, agent: string): Promise<string[]> {
  const plan = await readJsonRecord(runDir, "plan/design_plan.json").catch(() => undefined);
  if (await hasUnifiedContext(runDir)) {
    const required: string[] = [];
    if (agent === "researcher") required.push(CONTEXT_FILES.project, CONTEXT_FILES.research, "research/assets/manifest.json", "research/assets/validation.json");
    if (agent === "designer" || agent === "reviewer") {
      // Designer certifies its specification. Reviewer certifies that specification
      // against the current evidence; evidence-only corrections need no republication.
      required.push(CONTEXT_FILES.project, CONTEXT_FILES.design, ".performance/skills-designer.json", ...await designSourceFiles(runDir));
      if (agent === "reviewer") required.push(CONTEXT_FILES.research, CONTEXT_FILES.review);
    }
    if (agent !== "builder") return [...new Set(required)];
  }
  if (agent === "designer" || agent === "reviewer") {
    const scopes = briefDesignScopes(await readJsonRecord(runDir, "brief.json").catch(() => ({})));
    if (plan?.schemaVersion !== 2 && !scopes.length) return STAGE_REQUIRED_FILES[agent] ?? [];
    return [...new Set([...(STAGE_REQUIRED_FILES[agent] ?? []), ...(agent === "reviewer" ? STAGE_REQUIRED_FILES.designer! : []), ...(scopes.length ? ["brief.json", ".performance/skills-designer.json"] : []), ...await designSourceFiles(runDir)])];
  }
  if (plan?.schemaVersion !== 2) return STAGE_REQUIRED_FILES[agent] ?? [];
  if (agent === "builder") {
    const contract = deliveryContract(plan, await readJsonRecord(runDir, "plan/deliverable_manifest.json"));
    return [...new Set(["artifacts/artifact-manifest.json", "artifacts/lint-report.json", contract.presentation.entry, ...contract.deliverables.filter((item) => item.required === true).map((item) => String(item.file)), ...((await readJsonRecord(runDir, "artifacts/artifact-manifest.json")).previewFiles as string[] ?? [])])];
  }
  return STAGE_REQUIRED_FILES[agent] ?? [];
}

/** Supporting evidence may be attached read-only; canonical stage outputs are always required. */
async function publicationReferences(runDir: string, runId: string, agent: string, requiredFiles: string[], suppliedRefs: string[]): Promise<string[]> {
  const roleRoot = ({ researcher: "research/", designer: "plan/", reviewer: "review/", builder: "artifacts/" } as Record<string, string>)[agent];
  const canonicalRefs = requiredFiles.filter((path) => CONTEXT_OWNERS[path] === agent || (roleRoot && path.startsWith(roleRoot)));
  const explicitRefs: string[] = [];
  for (const supplied of suppliedRefs) {
    const prefix = `runs/${runId}/`;
    const candidate = supplied.startsWith(prefix) ? supplied.slice(prefix.length) : supplied;
    const local = canonicalRunDocument(relative(runDir, resolveInside(runDir, candidate)).replaceAll("\\", "/"));
    const researchInput = agent === "designer" && (RUN_CONTEXT_SECTIONS.research.includes(local) || local === CONTEXT_FILES.research);
    if (!requiredFiles.includes(local) && !researchInput && (!roleRoot || !local.startsWith(roleRoot))) throw new Error(`artifactRefs must reference ${agent}-owned or declared inputs in this Run: ${supplied}`);
    const existing = await findRunDocument(runDir, local);
    if (!existing || !(await stat(existing.absolutePath)).size) throw new Error(`artifactRefs file is missing or empty: ${local}. Correct or omit this extra reference; no event was published.`);
    explicitRefs.push(supplied.startsWith(prefix) ? `${prefix}${existing.path}` : existing.path);
  }
  return [...new Set([...canonicalRefs, ...explicitRefs])];
}

async function assertStageCommitted(workspaceDir: string, runId: string, agent: string, startingEventCount: number, requireExecutableDesign = false): Promise<string> {
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
  const requiredFiles = await stageRequiredFiles(runDir, agent);
  const strictReceipt = requiredFiles.includes(".performance/skills-designer.json") || (await readJsonRecord(runDir, "plan/design_plan.json").catch(() => undefined))?.schemaVersion === 2;
  for (const required of requiredFiles) {
    const existing = await findRunDocument(runDir, required);
    const path = existing?.absolutePath ?? resolveInside(runDir, required);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw new Error(`${agent} committed ${String(committed.type)} but required output is missing or empty: ${required}`);
    const expectedHash = runDocumentCandidates(required).map((candidate) => receiptFiles?.[candidate]).find((hash) => typeof hash === "string");
    if (typeof expectedHash !== "string") {
      if (strictReceipt) throw new Error(`${agent} approval receipt is missing ${required}; commit the current specification again`);
      receiptValid = false;
    } else {
      const actualHash = createHash("sha256").update(await readFile(path)).digest("hex");
      if (actualHash !== expectedHash) throw new Error(`${agent} output changed after ${String(committed.type)} was committed: ${required}`);
    }
  }
  if (agent === "builder") {
    const artifactFiles = await listFiles(join(runDir, "artifacts"));
    if (!artifactFiles.some((file) => file !== "00-gallery.html" && /\.(png|jpe?g|webp|svg|html)$/i.test(file))) throw new Error("builder committed build_done without a visual artifact");
  }
  if (agent === "designer" && requireExecutableDesign && strictReceipt) {
    const readiness = await designerDraftReadiness(runDir);
    if (!readiness.ok) throw new DeliveryBlocked("designer", readiness.issues);
  }
  // Hash receipts prove integrity, not semantic approval readiness (including older Runs).
  if (agent === "reviewer" && committed.type === "design_review_pass") assertReviewBuildReady(await readJsonRecord(runDir, "review/design-review.json"));
  if (!receiptValid) await validateStageOutputs(runDir, runId, agent, String(committed.type));
  const references = Array.isArray(committed.artifactRefs) ? committed.artifactRefs.filter((item): item is string => typeof item === "string") : [];
  for (const reference of references) {
    const workspacePath = resolveInside(workspaceDir, reference);
    const runPath = resolveInside(runDir, reference);
    if (!await stat(workspacePath).then(() => true).catch(() => false)) await stat(runPath);
    const prefix = `runs/${runId}/`;
    const local = canonicalRunDocument(reference.startsWith(prefix) ? reference.slice(prefix.length) : reference);
    if (!requiredFiles.includes(local)) {
      const expected = runDocumentCandidates(local).map((candidate) => receiptFiles?.[candidate]).find((hash) => typeof hash === "string");
      if (expected && expected !== await fileHash(runDir, (await findRunDocument(runDir, local))?.path ?? local)) throw new Error(`${agent} referenced input changed after ${String(committed.type)} was committed: ${local}`);
    }
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
  mimeType: ImageOutputMime;
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
  sections: Record<string, string | string[]>;
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

export function workflowReferencePaths(value: unknown, runId: string): string[] {
  const paths = new Set<string>();
  const escapedRunId = runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`runs/${escapedRunId}/research/assets/[^\"'\\s]+\\.(?:png|jpe?g|webp|gif)`, "giu");
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      let parsed: unknown;
      try { parsed = JSON.parse(item); } catch { parsed = undefined; }
      if (parsed && typeof parsed === "object") { visit(parsed); return; }
      for (const match of item.replaceAll("\\", "/").matchAll(pattern)) paths.add(match[0]);
    } else if (Array.isArray(item)) {
      for (const child of item) visit(child);
    } else if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) if (key !== "data") visit(child);
    }
  };
  visit(value);
  return [...paths];
}

export function modelResponseTimeoutReason(durationMs: number, idleMs: number, hasDelta: boolean, turnTimeoutMs: number, idleTimeoutMs: number): string | undefined {
  if (durationMs >= turnTimeoutMs) return "model turn deadline";
  if (hasDelta && idleMs >= idleTimeoutMs) return "stream stalled";
  return undefined;
}

interface ImageRequestProgress {
  operation: string; imageId?: string; attempt: number;
  phase: "queued" | "headers" | "body"; elapsedMs: number; responseBytes: number; idleMs: number;
}
function imageRequestUpdate(progress: ImageRequestProgress) {
  const phase = { queued: "queued", headers: "waiting for provider response", body: "receiving response" }[progress.phase];
  return { content: [{ type: "text" as const, text: `Image ${progress.imageId ?? "request"}: ${progress.operation === "image_download" ? "download · " : ""}${phase} · attempt ${progress.attempt} · ${Math.round(progress.elapsedMs / 1000)}s${progress.phase === "body" ? ` · ${Math.round(progress.responseBytes / 1024)} KiB · ${Math.round(progress.idleMs / 1000)}s since last data` : ""}` }], details: { imageRequest: progress } };
}

async function resilientFetch(
  endpoint: string,
  init: RequestInit,
  options: { workspaceDir: string; runId: string; operation: string; budgetScope?: string; signal?: AbortSignal; timeoutMs?: number; attempts?: number; onRetry?: (notice: RetryNotice) => void | Promise<void>; onProgress?: (progress: ImageRequestProgress) => void },
): Promise<Response> {
  const timeoutMs = Math.max(10_000, options.timeoutMs ?? Number(process.env.DREAMATIC_IMAGE_TIMEOUT_MS ?? 300_000));
  const attempts = Math.max(1, options.attempts ?? Number(process.env.DREAMATIC_IMAGE_RETRY_ATTEMPTS ?? 3));
  const attemptBudget = Math.max(attempts, Number(process.env.DREAMATIC_OPERATION_ATTEMPT_BUDGET ?? 5));
  const budgetKey = `${options.runId}:${options.operation}:${options.budgetScope ?? "default"}`;
  const request = async () => {
    const used = operationAttempts.get(budgetKey) ?? 0;
    if (used >= attemptBudget) {
      const lastError = operationLastErrors.get(budgetKey);
      const message = `${options.operation} retry budget exhausted after ${used} attempts; durable checkpoint preserved${lastError ? `; last error: ${lastError}` : ""}`;
      await appendFile(resolveInside(options.workspaceDir, join("runs", safeRunId(options.runId), "bus.jsonl")), `${JSON.stringify({ runId: options.runId, type: "operation_interrupted", operation: options.operation, scope: options.budgetScope, attempts: used, retryable: true, error: message, at: new Date().toISOString() })}\n`, "utf8");
      throw new Error(message);
    }
    operationAttempts.set(budgetKey, used + 1);
    let timedOut = false;
    let queueMs = 0;
    let requestMs = 0;
    let headersMs = 0;
    let bodyMs = 0;
    let responseBytes = 0, bodyIdleTimedOut = false;
    let phase: ImageRequestProgress["phase"] = "queued", lastByteAt = performance.now();
    const bodyIdleTimeoutMs = Math.min(2_147_483_647, Math.max(1, Number(process.env.DREAMATIC_IMAGE_BODY_IDLE_TIMEOUT_MS ?? 60_000) || 60_000));
    const startedAt = performance.now();
    const report = () => options.onProgress?.({ operation: options.operation, ...(options.budgetScope ? { imageId: options.budgetScope } : {}), attempt: used + 1, phase, elapsedMs: Math.round(performance.now() - startedAt), responseBytes, idleMs: phase === "body" ? Math.round(performance.now() - lastByteAt) : 0 });
    report();
    const progressTimer = options.onProgress ? setInterval(report, 15_000) : undefined;
    try {
      const response = await imageRequestScheduler().run(`${options.workspaceDir}:${options.runId}`, async () => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const requestAbort = new AbortController();
      const signal = AbortSignal.any([requestAbort.signal, timeout, ...(options.signal ? [options.signal] : [])]);
      const requestAt = performance.now();
      phase = "headers"; report();
      try {
      const response = await fetch(endpoint, { ...init, signal });
      headersMs = performance.now() - requestAt;
      const bodyAt = performance.now();
      phase = "body"; lastByteAt = bodyAt; report();
      let bytes: ArrayBuffer;
      try {
        bytes = await boundedResponseBytes(response, Math.max(1024, Number(process.env.DREAMATIC_IMAGE_RESPONSE_MAX_BYTES ?? 67_108_864) || 67_108_864), {
          signal, idleTimeoutMs: bodyIdleTimeoutMs,
          onProgress: (bytes) => { responseBytes = bytes; lastByteAt = performance.now(); },
        });
      } catch (error) {
        bodyIdleTimedOut = error instanceof ResponseBodyTimeoutError;
        throw error;
      } finally { bodyMs = performance.now() - bodyAt; }
      if (isRetryableStatus(response.status)) {
        const detail = new TextDecoder().decode(bytes).slice(0, 600);
        throw new RetryableHttpError(response.status, `${options.operation} failed (${response.status}): ${detail}`, retryAfterMs(response));
      }
      const completeResponse = new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      return completeResponse;
      } catch (error) { requestAbort.abort(error); throw error; }
      finally { timedOut = timeout.aborted; requestMs = performance.now() - requestAt; }
      }, options.signal, (waitMs) => { queueMs = waitMs; });
      operationAttempts.delete(budgetKey);
      operationLastErrors.delete(budgetKey);
      return response;
    } catch (error) {
      let failure = error instanceof Error ? error : new Error(String(error));
      if (timedOut && !options.signal?.aborted) {
        const target = new URL(endpoint);
        target.search = "";
        failure = new Error(`${options.operation} timed out after ${timeoutMs} ms while calling ${target.toString()}`);
      }
      operationLastErrors.set(budgetKey, failure.message.slice(0, 800));
      throw failure;
    } finally {
      if (progressTimer) clearInterval(progressTimer);
      await appendWorkflowLifecycleEvent(options.workspaceDir, options.runId, { type: "image_request_metrics", operation: options.operation, imageId: options.budgetScope, attempt: used + 1, queueMs: Math.round(queueMs), headersMs: Math.round(headersMs), bodyMs: Math.round(bodyMs), responseBytes, requestMs: Math.round(requestMs), durationMs: Math.round(performance.now() - startedAt), timedOut, bodyIdleTimedOut, phase, timeoutMs, bodyIdleTimeoutMs });
    }
  };
  try {
    const response = await withRetry(request, {
      attempts,
      random: Math.random,
      ...(options.signal ? { signal: options.signal } : {}),
      onRetry: async (notice) => {
        await durableRetryNotice(options.workspaceDir, options.runId, options.operation, notice, options.budgetScope);
        await options.onRetry?.(notice);
      },
    });
    await appendWorkflowLifecycleEvent(options.workspaceDir, options.runId, {
      type: "operation_finished", operation: options.operation, scope: options.budgetScope ?? "default",
      status: response.ok ? "completed" : "error", ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
    });
    return response;
  } catch (error) {
    await appendWorkflowLifecycleEvent(options.workspaceDir, options.runId, {
      type: "operation_finished", operation: options.operation, scope: options.budgetScope ?? "default",
      status: options.signal?.aborted ? "interrupted" : "error", error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
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
    `\n\n[DreamaticArt progressive Skill loading omitted ${omitted.length} characters from active context. The complete Skill remains on disk and in the durable session. Read a targeted range when a listed section is needed.]`,
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
  imageOutputFormat(path);
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
  if (eventType === "run_brief_updated") {
    state.status = "active";
    for (const stage of ["design", "review", "build", "export"] as const) state.stages[stage] = "pending";
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
  const interruptedStage = {
    researcher_interrupted: "research",
    designer_interrupted: "design",
    reviewer_interrupted: "review",
    builder_interrupted: "build",
  } as const;
  if (eventType in interruptedStage) {
    state.status = "interrupted";
    state.stages[interruptedStage[eventType as keyof typeof interruptedStage]] = "failed";
  }
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
    sections: structuredClone(RUN_CONTEXT_SECTIONS),
    updatedAt: now,
  };
  const context = await readFile(path, "utf8")
    .then((content) => JSON.parse(content) as DesignContextIndex)
    .catch(() => fallback);
  context.sections ??= structuredClone(RUN_CONTEXT_SECTIONS);
  context.sections.research = [...RUN_CONTEXT_SECTIONS.research];
  context.sections.reviewIssues = [...RUN_CONTEXT_SECTIONS.reviewIssues];
  if (eventType === "run_brief_updated") {
    context.status = "designing";
    delete context.latestVerdict;
  }
  if (["design_spec_ready", "design_revision_ready"].includes(eventType)) {
    context.sections ??= fallback.sections;
    context.sections.decisions = "plan/design_plan.json";
  }
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
  if (await hasUnifiedContext(dirname(path))) {
    context.sections = {
      project: CONTEXT_FILES.project, research: CONTEXT_FILES.research, design: CONTEXT_FILES.design, review: CONTEXT_FILES.review,
      resources: ["research/assets/manifest.json", "research/assets/validation.json", ".performance/user-materials.json"],
      implementation: "artifacts/artifact-manifest.json",
    };
  }
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
      if (/(?:url\(\s*["']?|@import\s*["'])(?:https?:|\/\/)/iu.test(html)) issues.push(`${file}: external resource found`);
      if (/<script\b/i.test(html)) issues.push(`${file}: script element found`);
      for (const tag of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*>/giu)) {
        if (/\bsrcset\s*=\s*["'][^"']*(?:https?:|\/\/)/iu.test(tag[0])) issues.push(`${file}: external image resource found`);
        for (const match of tag[0].matchAll(/\b(src|href|poster|data)\s*=\s*["']([^"']+)["']/giu)) {
          const reference = match[2]!;
          if (reference.startsWith("#")) continue;
          try {
            if (tag[1]!.toLowerCase() === "a" && match[1]!.toLowerCase() === "href" && /^https?:\/\//iu.test(reference)) {
              const url = new URL(reference.replaceAll("&amp;", "&"));
              if (url.username || url.password) throw new Error("unsafe external link");
              continue;
            }
            if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(reference)) throw new Error("non-local reference");
            const target = resolveInside(runDir, resolve(dirname(join(artifactsDir, file)), decodeURIComponent(reference.split(/[?#]/u)[0]!)));
            if (!await stat(target).then((info) => info.isFile()).catch(() => false)) throw new Error("missing local file");
          } catch {
            issues.push(`${file}: invalid or missing local reference ${reference}`);
          }
        }
      }
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

export function specialistCompletionEvent(agent: string, toolName: string, isError: boolean, args: unknown, result?: unknown): string | undefined {
  if (isError || !args || typeof args !== "object" || Array.isArray(args)) return undefined;
  if (result && typeof result === "object" && (result as { details?: { ok?: boolean } }).details?.ok === false) return undefined;
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
  if (!policy) throw new Error(`Unknown DreamaticArt persona: ${persona}`);
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

export async function validateDreamaticPersonaContracts(repoRoot: string): Promise<void> {
  for (const persona of Object.keys(DREAMATIC_PERSONA_TOOL_POLICY)) {
    const personaPath = join(repoRoot, ".pi", "agents", `${persona}.md`);
    try {
      const source = await readFile(personaPath, "utf8");
      const { frontmatter } = parseFrontmatter<PersonaFrontmatter>(source);
      dreamaticPersonaTools(persona, frontmatter.allowed_tools);
    } catch (error) {
      throw new Error(`DreamaticArt agent configuration is incompatible with the loaded runtime (${personaPath}): ${error instanceof Error ? error.message : String(error)}. This is not retryable. Rebuild and restart Server/CLI; if it persists, fix the persona tool contract. Preserve the existing Run and resume its pending stage; do not repeat completed stages or remove tool permissions to bypass this error.`);
    }
  }
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
  signal?: AbortSignal,
  onProgress?: (progress: ImageRequestProgress) => void,
): Promise<SavedImage> {
  signal?.throwIfAborted();
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
      budgetScope: imageId,
      ...(onProgress ? { onProgress } : {}),
      ...(signal ? { signal } : {}),
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
  const encoded = encodeImageOutput(bytes, imagePath);
  bytes = encoded.bytes;
  await mkdir(dirname(imagePath), { recursive: true });
  signal?.throwIfAborted();
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
      mimeType: encoded.mimeType,
      encoding: { format: encoded.format, sourceFormat: encoded.sourceFormat, converted: encoded.converted, ...("quality" in encoded ? { quality: encoded.quality } : {}) },
    }, null, 2),
    "utf8",
  );
  return {
    bytes,
    mimeType: encoded.mimeType,
    path: workspacePath,
    sidecarPath: relative(workspaceDir, sidecarPath).replaceAll("\\", "/"),
  };
}

const loadedPiVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent")), "utf8")).version;

export function orchestratorHandoffIssue(task: string): string | undefined {
  for (const [role, paths] of Object.entries(CONTEXT_PROJECTIONS)) {
    if (paths.some(path => task.includes(path))) {
      const target = ({researcher:CONTEXT_FILES.research,designer:CONTEXT_FILES.design,reviewer:CONTEXT_FILES.review} as Record<string,string>)[role];
      return `Handoff must reference ${target} through design_context_read and describe role-owned outputs. Correct the task before dispatch; no specialist was started.`;
    }
  }
  if (/\b(?:write_json|patch_json|save_design_context|patch_design_context)\b/u.test(task)) return "Handoff must use the specialist's named Context contract and completion event. Correct the task before dispatch; no specialist was started.";
  return undefined;
}

export function createDreamaticExtension(options: DreamaticExtensionOptions): ExtensionFactory {
  const workspaceDir = options.workspaceDir;
  const coordinator = !options.parentInvocation && options.personaPath !== undefined && basename(options.personaPath) === "orchestrator.md";
  const designerPersona = options.parentInvocation?.agent === "designer" || (options.personaPath !== undefined && basename(options.personaPath) === "designer.md");
  const reviewerPersona = options.parentInvocation?.agent === "reviewer" || (options.personaPath !== undefined && basename(options.personaPath) === "reviewer.md");
  const builderPersona = options.parentInvocation?.agent === "builder" || (options.personaPath !== undefined && basename(options.personaPath) === "builder.md");
  const assignedRunId = options.parentInvocation?.runId ? safeRunId(options.parentInvocation.runId) : undefined;
  const builderToolsForRun = async (runId?: string): Promise<string[]> => {
    const tools: string[] = [...DREAMATIC_PERSONA_TOOL_POLICY.builder];
    if (!runId) return tools;
    const runDir = resolveInside(workspaceDir, join("runs", safeRunId(runId)));
    const plan = await readJsonRecord(runDir, "plan/design_plan.json").catch(() => undefined);
    if (plan?.schemaVersion !== 2) return tools;
    const manifest = await readJsonRecord(runDir, "plan/deliverable_manifest.json");
    const contract = deliveryContract(plan, manifest);
    const generated = new Set(contract.tasks.filter(task => task.method === "html_generate").flatMap(task => [...htmlTask(task).files, ...htmlTask(task).resources].map(file => file.output)));
    const pureHtml = contract.presentation.mode === "html" && contract.deliverables.every(item => item.method !== "manual" || generated.has(String(item.file)));
    return pureHtml ? tools.filter(name => !["write", "edit"].includes(name)) : tools;
  };
  const assignment = assignedRunId ? specialistRunAssignment(workspaceDir, assignedRunId, options.parentInvocation!.agent) : "";
  const assertAssignedRun = (runId: string, operation: string) => {
    const projectRunId = options.projectId ? safeRunId(options.projectId) : undefined;
    if (projectRunId && safeRunId(runId) !== projectRunId) throw new Error(`${operation} must target this conversation's project. Requested runId: ${runId}; canonical runId: ${projectRunId}; runDir: ${resolveInside(workspaceDir, join("runs", projectRunId))}. Orchestrator must use run_init's returned runId for every handoff; do not invent ids or start a specialist in another Run. No cross-project operation was performed.`);
    if (assignedRunId && projectRunId && assignedRunId !== projectRunId) throw new Error(`Runtime assignment conflicts with project ownership: assigned runId ${assignedRunId}, canonical runId ${projectRunId}. Return this configuration conflict to Orchestrator and restart the specialist with the canonical id; do not retarget its writes.`);
    if (assignedRunId && safeRunId(runId) !== assignedRunId) throw new Error(`${operation} must target the assigned Run. Assigned runId: ${assignedRunId}; runDir: ${resolveInside(workspaceDir, join("runs", assignedRunId))}. Use design_context_read with this id; do not search other projects or retry through a different write tool.`);
  };
  const assertAssignedRead = async (path: string, cwd: string) => {
    const runsRoot = resolveInside(workspaceDir, "runs");
    const absolute = resolve(cwd, path);
    const runLocal = relative(runsRoot, absolute).replaceAll("\\", "/");
    if (!runLocal.startsWith("../") && !isAbsolute(runLocal)) {
      const [readRunId, ...parts] = runLocal.split("/");
      const retired = parts.join("/");
      const owner = Object.entries(CONTEXT_PROJECTIONS).find(([, paths]) => (paths as readonly string[]).includes(retired))?.[0];
      if (owner && readRunId && await hasUnifiedContext(resolveInside(runsRoot, readRunId))) {
        const canonicalPath = ({ researcher: CONTEXT_FILES.research, designer: CONTEXT_FILES.design, reviewer: CONTEXT_FILES.review } as Record<string, string>)[owner];
        throw new Error(`Retired Context path ${retired}. Unified Runs store this content in canonical Context instead. Use design_context_read ${JSON.stringify({runId: readRunId, audience: options.parentInvocation?.agent ?? "orchestrator", paths: [canonicalPath], full: true})}; do not recreate retired reports.`);
      }
    }
    if (!assignedRunId) return;
    const assignedDir = resolveInside(workspaceDir, join("runs", assignedRunId));
    const physicalRoot = await realpath(runsRoot).catch(() => runsRoot);
    const physicalPath = await realpath(absolute).catch(() => absolute);
    for (const [root, target] of [[runsRoot, absolute], [physicalRoot, physicalPath]]) {
      const local = relative(root!, target!).replaceAll("\\", "/");
      if (local !== ".." && !local.startsWith("../") && !isAbsolute(local)) {
        if (!local || local.split("/")[0] !== assignedRunId) throw new Error(`Specialist reads must stay inside the assigned Run ${assignedRunId}. Use ${resolveInside(workspaceDir, join("runs", assignedRunId))}; do not browse sibling projects to guess the assignment.`);
      }
    }
  };
  const researchPages = new Map<string, { html: string; url: string }>();
  const todos: Array<{ id: string; text: string; status: string }> = [];
  const skillCatalogs = new Map<string, Promise<ReturnType<DefaultResourceLoader["getSkills"]>["skills"]>>();
  const skillActivation = new SkillActivation();
  let skillDescriptors: Promise<Array<{ name: string; description: string; path: string } & SkillMetadata>> | undefined;
  let skillDescriptorCwd: string | undefined;
  const discoverSkills = (cwd: string, refresh = false) => {
    if (refresh) skillCatalogs.delete(cwd);
    let catalog = skillCatalogs.get(cwd);
    if (!catalog) {
      catalog = (async () => {
        const loaded = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
        await loaded.reload();
        return loaded.getSkills().skills;
      })();
      skillCatalogs.set(cwd, catalog);
      void catalog.catch(() => { if (skillCatalogs.get(cwd) === catalog) skillCatalogs.delete(cwd); });
    }
    return catalog;
  };
  const imageConcurrency = Math.max(1, Math.min(8, Math.floor(Number(process.env.DREAMATIC_IMAGE_CONCURRENCY ?? 2)) || 2));
  let activeSpecialistInvocation: { id: string; agent: string } | undefined;
  let revisionOpening = false;
  const currentSpecialistInvocation = () => activeSpecialistInvocation;
  const enqueueImageOperation = <T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    signal?.throwIfAborted();
    return operation(); // HTTP attempts use the shared scheduler; backoff releases its slot.
  };
  const preflightBeforeImageTool = async (runId: string, signal?: AbortSignal) => {
    if (options.parentInvocation?.agent !== "builder") return;
    assertAssignedRun(runId, "image execution");
    const runDir = resolveInside(workspaceDir, join("runs", safeRunId(runId)));
    const source = await readRunContext(runDir, "plan/design_plan.json").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!source) return; // Preserve standalone/legacy image tooling without a typed plan.
    const plan = JSON.parse(source) as Record<string, unknown>;
    const manifest = await readRunContext(runDir, "plan/deliverable_manifest.json").catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const strict = plan.schemaVersion === 2 || briefDesignScopes(await readJsonRecord(runDir, "brief.json").catch(() => ({}))).length > 0;
    if (manifest && strict) {
      const readiness = await designerDraftReadiness(runDir);
      if (!readiness.ok) throw new DeliveryBlocked("designer", readiness.issues);
      await assertStageCommitted(workspaceDir, runId, "designer", 0, true);
      await assertStageCommitted(workspaceDir, runId, "reviewer", 0);
      const bus = (await readFile(join(runDir, "bus.jsonl"), "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      if (currentWorkflowCycle(bus).filter((event) => ["design_spec_ready", "design_revision_ready", "design_review_pass", "design_review_fail", "build_done"].includes(String(event.type))).at(-1)?.type !== "design_review_pass") throw new Error("Image execution requires a current approved specification");
    }
    const parsed = manifest ? JSON.parse(manifest) as Record<string, unknown> : undefined;
    return parsed && Array.isArray(parsed.deliverables) ? { strict, runId, tasks: imagePlan(plan), deliverables: parsed.deliverables as Record<string, unknown>[] } : undefined;
  };
  const bindImageOutput = <T extends { id: string; outputPath?: string }>(task: T, method: ImageToolName, plan: Awaited<ReturnType<typeof preflightBeforeImageTool>>): T => {
    if (!plan) return task;
    const deliverable = plan.deliverables.find((item) => item.id === task.id);
    if (!deliverable) {
      if (plan.strict) throw new Error(`Unknown approved image deliverable: ${task.id}. Use the assigned manifest id; Builder cannot invent another output.`);
      return task;
    }
    if (deliverable.method !== method) throw new Error(`Image ${task.id} method must match its declared ${String(deliverable.method)} executor`);
    const file = requiredString(deliverable, "file", `Deliverable ${task.id}`);
    if (task.outputPath !== undefined && task.outputPath !== file) throw new Error(`Image ${task.id} outputPath conflicts with the declared file ${file}; omit outputPath to use the manifest path. Do not generate another filename.`);
    if (plan.strict) {
      const entry = plan.tasks.find(item => item.id === task.id);
      if (!entry) throw new Error(`Missing approved image task: ${task.id}`);
      assertApprovedImageRequest(task as Record<string, unknown>, approvedImageTask(workspaceDir, plan.runId, entry, deliverable), workspaceDir);
    }
    return { ...task, outputPath: file };
  };
  const generateImage = (params: ImageGenerateTask, signal?: AbortSignal, onRetry?: (notice: RetryNotice) => void, onProgress?: (progress: ImageRequestProgress) => void, approvedTask?: ApprovedImageTask): Promise<Record<string, unknown>> => enqueueImageOperation(async () => {
    const contract = approvedTask ? undefined : await preflightBeforeImageTool(params.runId, signal);
    params = bindImageOutput(params, "image_generate", contract);
    const approved = approvedTask ?? (contract?.strict ? approvedImageTask(workspaceDir, params.runId, contract.tasks.find(task => task.id === params.id)!, contract.deliverables.find(item => item.id === params.id)!) : undefined);
    const fingerprint = approved ? await approvedImageFingerprint(approved) : undefined;
    const size = params.size ?? imageSizeCeiling();
    assertImageSizeWithinCeiling(size, "image_generate.size");
    artifactOutputPath(workspaceDir, safeRunId(params.runId), safeRunId(params.id), "generated-images", params.outputPath);
    const apiKey = process.env.DREAMATIC_IMAGE_API_KEY?.trim() || process.env.DREAMATIC_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("DREAMATIC_IMAGE_API_KEY, DREAMATIC_API_KEY, or OPENAI_API_KEY is not configured");
    const baseUrl = (process.env.DREAMATIC_IMAGE_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const endpoint = process.env.DREAMATIC_IMAGE_GENERATION_ENDPOINT?.trim() || `${baseUrl}/images/generations`;
    const generationModel = { model: process.env.DREAMATIC_IMAGE_MODEL ?? "gpt-image-1", provider: new URL(endpoint).hostname, source: "request" };
    const idempotencyKey = createHash("sha256").update(`${params.runId}\0${params.id}\0${params.prompt}`).digest("hex");
    const response = await resilientFetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        model: generationModel.model,
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
      ...(onProgress ? { onProgress } : {}),
    });
    if (!response.ok) throw new Error(`Image generation failed (${response.status}): ${await response.text()}`);
    const payload = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const saved = await saveImageResponse(workspaceDir, safeRunId(params.runId), safeRunId(params.id), params.prompt, "image_generate", payload, [], params.outputPath, {
      generationModel,
      intent: params.intent,
      acceptanceCriteria: params.acceptanceCriteria,
      preserve: params.preserve ?? [],
    }, signal, onProgress);
    if (approved && fingerprint) await recordApprovedImage(approved, fingerprint);
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
  return (api: ExtensionAPI) => {
    const coordinatorTools = new Set<string>(ORCHESTRATOR_TOOLS);
    const designerTools = new Set<string>(DREAMATIC_PERSONA_TOOL_POLICY.designer);
    const reviewerTools = new Set<string>(DREAMATIC_PERSONA_TOOL_POLICY.reviewer);
    let builderTools = new Set<string>(DREAMATIC_PERSONA_TOOL_POLICY.builder);
    const pi: ExtensionAPI = coordinator || ((designerPersona || reviewerPersona || builderPersona) && options.personaPath !== undefined) ? { ...api, registerTool(tool) {
      if ((coordinator ? coordinatorTools : reviewerPersona ? reviewerTools : builderPersona ? builderTools : designerTools).has(tool.name)) api.registerTool(tool);
    } } : api;
    const userMaterialPrompts: string[] = [];
    let firstUserRequest: string | undefined;
    let requestAssignedRunId: string | undefined;
    if (options.personaPath || !options.parentInvocation || assignment) {
      pi.on("before_agent_start", async (event) => {
        if (coordinator) pi.setActiveTools([...ORCHESTRATOR_TOOLS]);
        else if (designerPersona) pi.setActiveTools([...DREAMATIC_PERSONA_TOOL_POLICY.designer]);
        else if (reviewerPersona) pi.setActiveTools([...DREAMATIC_PERSONA_TOOL_POLICY.reviewer]);
        else if (builderPersona) {
          builderTools = new Set(await builderToolsForRun(assignedRunId ?? options.projectId));
          pi.setActiveTools([...builderTools]);
        }
        if (!options.parentInvocation && typeof event.prompt === "string") {
          userMaterialPrompts.push(event.prompt);
          const materialRunId = options.projectId ?? requestAssignedRunId;
          if (materialRunId) {
            const materialRunDir = resolveInside(workspaceDir, join("runs", safeRunId(materialRunId)));
            await recordUserMaterialSources(materialRunDir, [event.prompt]);
          }
        }
        if (!options.parentInvocation && firstUserRequest === undefined && typeof event.prompt === "string" && event.prompt.trim()) {
          firstUserRequest = event.prompt.split(/\n\n\[(?:Dreamatic reference images|DREAMATIC PROJECT OWNERSHIP)\]/u)[0]!;
        }
        if (!options.personaPath) return assignment && !event.systemPrompt.includes(assignment) ? { systemPrompt: `${event.systemPrompt}\n\n${assignment}` } : undefined;
        const source = await readFile(options.personaPath!, "utf8");
        const { body } = parseFrontmatter(source);
        const promptRunId = options.parentInvocation?.runId ?? options.projectId ?? requestAssignedRunId;
        const unifiedPrompt = !promptRunId || await hasUnifiedContext(resolveInside(workspaceDir, join("runs", safeRunId(promptRunId)))) || !(await readJsonRecord(resolveInside(workspaceDir, join("runs", safeRunId(promptRunId))), "brief.json").catch(() => undefined));
        const personaBody = coordinator || unifiedPrompt ? unifiedContextPrompt(body) : legacyContextPrompt(body);
        const block = dreamaticPersonaPromptBlock(`${personaBody}${(coordinator || unifiedPrompt) && !options.parentInvocation ? `\n\n# Authoritative Context Contract\n${unifiedContextInstruction("orchestrator")}` : ""}`);
        const marker = /<!-- DREAMATIC_ACTIVE_PERSONA -->[\s\S]*?<!-- \/DREAMATIC_ACTIVE_PERSONA -->/g;
        const systemPrompt = marker.test(event.systemPrompt)
          ? event.systemPrompt.replace(marker, () => block)
          : `${event.systemPrompt}\n\n${block}`;
        return { systemPrompt: assignment && !systemPrompt.includes(assignment) ? `${systemPrompt}\n\n${assignment}` : systemPrompt };
      });
    }
    if (!options.parentInvocation) {
      const idleSleep = createIdleSleepGuard();
      pi.on("agent_start", () => { idleSleep.start(); });
      pi.on("agent_end", () => { idleSleep.stop(); });
      pi.on("session_shutdown", () => { idleSleep.stop(); });
    }
    const profile = dreamaticProviderFromEnv();
    let activeRunId = options.parentInvocation?.runId;
    let workflowStopped = false;
    pi.on("message_end", async (event) => {
      const message = event.message;
      if (message.role === "assistant") {
        await recordProviderDiagnostic("provider_response_complete", {
          stopReason: message.stopReason,
          elapsedMs: providerRequestedAt ? Date.now() - providerRequestedAt : undefined,
          reasoningChars: message.content.filter(item => item.type === "thinking").reduce((total, item) => total + (item.type === "thinking" ? item.thinking.length : 0), 0),
          usage: message.usage,
        });
      }
      const runId = options.parentInvocation?.runId ?? options.projectId ?? requestAssignedRunId;
      if (runId && message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
        await recordReasoningModel(resolveInside(workspaceDir, join("runs", safeRunId(runId))), options.parentInvocation?.agent ?? "orchestrator", message.model, message.provider);
      }
    });
    const finishWorkflow = (value: unknown, enabled = true) => {
      if (enabled) workflowStopped = true;
      return { ...textResult(value), ...(enabled ? { terminate: true } : {}) };
    };
    const contextFailures = new ContextFailureTracker();
    pi.on("agent_start", () => { workflowStopped = false; contextFailures.clear(); });
    pi.on("tool_result", async (event) => {
      const runId = options.parentInvocation?.runId;
      if (!runId || !["update_design_context", "commit_design_context", "save_design_context", "patch_design_context", "write_json", "patch_json", "design_bus_post", "read", "write", "edit"].includes(event.toolName)) return;
      const runDir = resolveInside(workspaceDir, join("runs", safeRunId(runId)));
      if (!(await hasUnifiedContext(runDir))) return;
      if (!event.isError) {
        if (event.toolName === "design_bus_post") contextFailures.clear();
        return;
      }
      const raw = event.content.filter(item => item.type === "text").map(item => (item as { text: string }).text).join("\n");
      if (!/context|review\/design-review|research\/(?:evidence|research-findings|brand_lock)|plan\/(?:design_plan|design_system|deliverable_manifest)|patch_json|write_json|review_stage|verdict/i.test(raw)) return;
      const issue = canonicalContextError(raw);
      const identity = contextFailureIdentity(event.toolName, issue, event.input);
      const key = createHash("sha256").update(identity.key).digest("hex");
      const attempts = contextFailures.record(key, event.toolCallId);
      const blocked = attempts >= 3;
      const draftTool = ["update_design_context", "commit_design_context"].includes(event.toolName);
      const recovery = { ok: false, blocked, retryable: false, repairOwner: options.parentInvocation!.agent, runId, attempts, issue, errorCode: identity.code, field: identity.location,
        instruction: blocked ? "Stop this specialist invocation and return the diagnosis to Orchestrator. Re-dispatch only for an actual canonical schema repair, never unchanged completion retries or legacy files." : draftTool ? "Repair the named working field. Read design_context_read; submit only named changes, then commit with {}. Runtime manages versions; never submit pointers, hashes or regenerate unrelated content." : "Repair the named canonical field. Do not create legacy files. Use named role fields in changes; versions are runtime-owned. No completion was committed.",
        ...(draftTool ? {} : { authoringExample: contextChangesExample(options.parentInvocation!.agent) }) };
      if (blocked) workflowStopped = true;
      return { content: textResult(recovery).content, details: recovery, isError: !blocked };
    });
    let providerRequestId: string | undefined;
    let providerRequestedAt: number | undefined;
    let providerFirstDelta = false;
    let providerFirstText = false;
    const recordProviderDiagnostic = async (type: string, data: Record<string, unknown>) => {
      const runId = options.parentInvocation?.runId ?? options.projectId ?? requestAssignedRunId;
      const runDir = runId ? resolveInside(workspaceDir, join("runs", safeRunId(runId))) : workspaceDir;
      await mkdir(join(runDir, ".performance"), { recursive: true });
      await appendFile(join(runDir, ".performance", "model-requests.jsonl"), `${JSON.stringify({ type, requestId: providerRequestId, role: options.parentInvocation?.agent ?? "orchestrator", at: new Date().toISOString(), ...data })}\n`);
    };
    pi.on("before_provider_request", async event => {
      providerRequestId = randomUUID();
      providerRequestedAt = Date.now();
      providerFirstDelta = false;
      providerFirstText = false;
      await recordProviderDiagnostic("provider_request", { ...providerRequestSummary(event.payload), runtime: { ...loadedRuntimeIdentity, designContract: 2, runtimeFingerprint: await deliveryRuntimeStamp(), piVersion: loadedPiVersion }, configuredThinkingLevel: dreamaticThinkingLevel(options.parentInvocation?.agent ?? "orchestrator") ?? "off", capabilitySource: process.env.DREAMATIC_MODEL_CAPABILITIES?.trim() ? "explicit_configuration" : "unspecified" });
    });
    pi.on("after_provider_response", async event => { await recordProviderDiagnostic("provider_response_headers", { status: event.status, elapsedMs: providerRequestedAt ? Date.now() - providerRequestedAt : undefined }); });
    pi.on("message_update", async event => {
      const update = event.assistantMessageEvent;
      if (!("delta" in update) || typeof update.delta !== "string" || !update.delta.length) return;
      if (!providerFirstDelta) {
        providerFirstDelta = true;
        await recordProviderDiagnostic("provider_first_delta", { deltaType: update.type, elapsedMs: providerRequestedAt ? Date.now() - providerRequestedAt : undefined });
      }
      if (update.type === "text_delta" && !providerFirstText) {
        providerFirstText = true;
        await recordProviderDiagnostic("provider_first_text", { elapsedMs: providerRequestedAt ? Date.now() - providerRequestedAt : undefined });
      }
    });
    if (profile) pi.registerProvider(profile.providerId, profile.registration);
    pi.on("tool_call", async (event, context) => {
        if (designerPersona && !designerTools.has(event.toolName)) return { block: true, reason: "Designer uses named Context authoring and permitted source tools only. Resume using the current role contract." };
        if (coordinator && !coordinatorTools.has(event.toolName)) return { block: true, reason: "Orchestrator uses lifecycle tools and design_context_read only. Resume using the current role contract." };
        if (workflowStopped) return { block: true, terminate: true, reason: "This turn has already committed completion, clarification or a blocking validation diagnosis. Stop; continue only in the next authorized turn." };
        if (reviewerPersona && !reviewerTools.has(event.toolName)) return { block: true, reason: "Reviewer uses Context assessment tools and source reads only. Do not write reports or alter specifications." };
        if (builderPersona && !builderTools.has(event.toolName)) return { block: true, reason: "Builder uses approved-plan execution and permitted presentation tools only. Do not restate image parameters or author Context." };
        if (!options.parentInvocation && ["run_init", "spawn_agent"].includes(event.toolName) && context?.cwd) {
          try {
            await validateDreamaticPersonaContracts(context.cwd);
          } catch (error) {
            workflowStopped = true;
            return { block: true, terminate: true, reason: error instanceof Error ? error.message : String(error) };
          }
        }
        const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
        if (coordinator && event.toolName !== "run_init" && typeof input.runId === "string" && !(await hasUnifiedContext(resolveInside(workspaceDir, join("runs", safeRunId(input.runId)))))) return {block:true,reason:"This task requires canonical Context. Preserve the Run and request an explicit data migration before continuing."};
        if (options.projectId && typeof input.runId === "string") {
          try { assertAssignedRun(input.runId, event.toolName); }
          catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
        }
        if (assignedRunId && ["read", "write", "edit", "ls", "grep", "find"].includes(event.toolName) && typeof input.path === "string" && /^runs\//u.test(input.path)) {
          try {
            const [, explicitRunId, ...parts] = input.path.split("/");
            if (explicitRunId !== assignedRunId) throw new Error(`Native Run path must target assigned Run ${assignedRunId}, not ${explicitRunId}`);
            input.path = resolveInside(resolveInside(workspaceDir, join("runs", assignedRunId)), parts.join("/"));
          }
          catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
        }
        if (assignedRunId && ["read", "write", "edit", "ls", "grep", "find"].includes(event.toolName) && typeof input.path === "string" && !isAbsolute(input.path)
          && /^(?:(?:context|research|plan|review|artifacts|inputs|\.performance)(?:\/|$)|(?:brief|run-state|design-context)\.json$|bus\.jsonl$)/u.test(input.path)) {
          try { input.path = resolveInside(resolveInside(workspaceDir, join("runs", assignedRunId)), input.path); }
          catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
        }
        if (["read", "write", "edit"].includes(event.toolName) && typeof input.path === "string") {
          const absolute = resolve(context?.cwd ?? workspaceDir, input.path);
          const local = relative(resolveInside(workspaceDir, "runs"), absolute).replaceAll("\\", "/");
          const [runId, ...parts] = local.split("/");
          const document = parts.join("/");
          const canonical = canonicalRunDocument(document);
          if (runId && runId !== ".." && RUN_DOCUMENT_ALIASES[canonical]) {
            const runDir = resolveInside(workspaceDir, join("runs", runId));
            try {
              const existing = ["read", "edit"].includes(event.toolName) ? await findRunDocument(runDir, canonical) : undefined;
              input.path = existing?.absolutePath ?? resolveInside(runDir, canonical);
            } catch (error) {
              return { block: true, reason: error instanceof Error ? error.message : String(error) };
            }
          }
        }
        if (assignedRunId || ["read", "ls", "grep", "find", "view_image", "compare_images"].includes(event.toolName)) {
          try {
            if (typeof input.runId === "string") assertAssignedRun(input.runId, event.toolName);
            if (["read", "ls", "grep", "find", "view_image", "compare_images"].includes(event.toolName)) {
              const paths = [input.path, ...(Array.isArray(input.paths) ? input.paths : [])].filter((path): path is string => typeof path === "string");
              for (const path of paths) await assertAssignedRead(path, context?.cwd ?? workspaceDir);
            }
          } catch (error) {
            return { block: true, reason: `${error instanceof Error ? error.message : String(error)}${assignedRunId ? ` Assigned runId: ${assignedRunId}; runDir: ${resolveInside(workspaceDir, join("runs", assignedRunId))}.` : ""}` };
          }
        }
        if (["write", "edit"].includes(event.toolName) && typeof input.path === "string") {
          try {
            const absolute = resolve(context?.cwd ?? workspaceDir, input.path);
            const assigned = options.parentInvocation?.runId;
            const local = relative(resolveInside(workspaceDir, "runs"), absolute).replaceAll("\\", "/");
            const inferred = local.split("/")[0];
            if (!assigned && options.projectId && inferred && inferred !== ".." && safeRunId(inferred) !== safeRunId(options.projectId)) throw new Error("Writes must target this conversation's project");
            if (assigned || (inferred && inferred !== ".." && !local.startsWith("../"))) {
              await assertRoleWrite(workspaceDir, assigned ?? inferred!, options.parentInvocation?.agent ?? "orchestrator", absolute);
            } else if (options.parentInvocation) {
              throw new Error("Specialist writes must stay inside the assigned Run");
            }
          } catch (error) {
            return { block: true, reason: `${error instanceof Error ? error.message : String(error)}${assignedRunId ? ` Assigned runId: ${assignedRunId}; runDir: ${resolveInside(workspaceDir, join("runs", assignedRunId))}. Correct this path; do not switch projects or write tools.` : ""}` };
          }
          const path = input.path.replaceAll("\\", "/");
          if (/\/context\/(?:project|research|design|review)\.json$/u.test(path)) return { block: true, reason: "Unified context documents require write_json/patch_json so model validation and revision checks remain consistent." };
          if (/(?:^|\/)runs\/[^/]+\/(?:design-context|run-state)\.json$/u.test(path)) {
            return { block: true, reason: "Run state and design-context.json are runtime-managed. Write your role's canonical outputs, then publish its completion event; the runtime updates these files. Do not retry with write or edit." };
          }
        }
        if (event.toolName === "write" && typeof input.path === "string" && typeof input.content === "string") {
          const path = input.path.replaceAll("\\", "/");
          if (/(?:^|\/)runs\/[a-zA-Z0-9._-]+\/.+\.json$/u.test(path)) {
            try {
              const data = parseRunJson(input.content, path);
              if (options.parentInvocation?.agent === "designer" && path.endsWith("/plan/deliverable_manifest.json")) {
                const normalized = normalizeDraftPresentation(requiredRecord(data, path));
                if (normalized.issues.length) return { block: true, reason: normalized.issues.join("\n") + " Use write_json for a partial draft, or declare its presentation choice before writing." };
                if (Object.keys(normalized.normalizedFields).length) input.content = `${JSON.stringify(data, null, 2)}\n`;
              }
            } catch (error) {
              return { block: true, reason: error instanceof Error ? error.message : String(error) };
            }
          }
        }
        if (options.parentInvocation) return undefined;
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
        if (state?.status === "complete") {
          if (["read", "ls", "grep", "find", "ask_user", "design_bus_read", "design_context_read", "run_revision"].includes(event.toolName)) return undefined;
          return { block: true, reason: "This Run is complete. For explicit user-requested changes, call run_revision first; do not restart the workflow automatically." };
        }
        if (state?.lastEvent !== "build_done") return undefined;
        const finalizationTools = new Set(["design_bus_read", "todo_write"]);
        if (finalizationTools.has(event.toolName)) return undefined;
        return {
          block: true,
          reason: `Run ${activeRunId} has committed build_done. The implementation and lint report are immutable at this gate; call export_package immediately. Do not read artifacts or start another specialist.`,
        };
      });
    if (!options.parentInvocation) {
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
            text: "[Reference image payload omitted from active context after its first visual pass. Reload the persisted DreamaticArt reference path above with view_image when needed.]",
          },
        ];
      }
      return { messages };
    });

    pi.registerTool({
      name: "ask_user",
      label: "Clarify design brief",
      description: "Present a compact clarification, concept-selection or revision-feedback card. Read prior intent first; ask only high-impact gaps in purpose, audience, scenario, tasks, priority, desired feeling, constraints or success criteria, not all eight every time. Offer task-specific choices: single-select for one priority or exclusive scope, multi-select for compatible needs, and allow custom input. Leave researchable facts and professional design choices to specialists. Never interrupt a running specialist. After calling this tool, end the turn and wait for the user's next message.",
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
          multiple: Type.Optional(Type.Boolean({ description: "True for compatible selections such as tasks or touchpoints; false for one main priority or mutually exclusive scope. Multi-selection does not imply ranking." })),
          custom: Type.Optional(Type.Boolean({ description: "Defaults to true; allow the user to supplement or correct the offered choices." })),
          placeholder: Type.Optional(Type.String({ maxLength: 160 })),
          required: Type.Optional(Type.Boolean()),
        }), { minItems: 1 }),
      }),
      async execute(_id, params) {
        if (currentSpecialistInvocation() || revisionOpening) throw new Error("Wait for the current workflow operation before asking for user input");
        const questions = params.questions.map((question, index) => ({
          ...question,
          id: question.id ?? `question-${index + 1}`,
          required: question.required !== false,
          custom: question.custom !== false,
        }));
        return finishWorkflow({
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
      async execute(_id, params, signal) {
        if (params.runId) await consumeWorkflowBudget(workspaceDir, params.runId, "searchQueries", 1);
        return textResult(await webSearch(params.query, params.limit, signal ? { signal } : {}));
      },
    });

    pi.registerTool({
      name: "websearch_batch",
      label: "Search multiple research questions",
      description: "Search independent research questions with bounded concurrency. Search the user's actual component, mechanism or design subject first, not a generated project name or its generic host product. Use topicGroups only for a shared subject; queryTopics overrides groups for each distinct question. Evaluate core-subject evidence before contextual background. Reserve budget for replacement after fetching blocked sources. Lexical matches and successful retrieval do not establish relevance.",
      parameters: Type.Object({
        runId: Type.String(),
        queries: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
        limitPerQuery: Type.Optional(Type.Number({ minimum: 1, maximum: 8 })),
        refinementReason: Type.Optional(Type.String({ minLength: 10, description: "Specific missing evidence or figure coverage from prior results. Enables one bounded supplemental acquisition reserve, not repeated unchanged requests." })),
        topicGroups: Type.Optional(Type.Array(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), {
          minItems: 1,
          description: "Category discovery: groups of equivalent subject terms. Every group must have a title/snippet match. Example: [[\"vibe coding\", \"vibecoding\"], [\"keyboard\", \"keypad\", \"键盘\"]]. This is a lexical lead screen, not semantic or visual verification; keep unmatched results for alias discovery.",
        })),
        queryTopics: Type.Optional(Type.Array(Type.Object({
          query: Type.String({ minLength: 1 }),
          topicGroups: Type.Array(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), { minItems: 1 }),
        }), { maxItems: 8, description: "Per-query subject groups, overriding shared topicGroups. Match query strings exactly. Use for mixed subtopics; never apply robot-brand groups to a muscle/lattice query." })),
      }),
      async execute(_id, params, signal) {
        const budget = await consumeWorkflowBudget(workspaceDir, params.runId, "searchQueries", params.queries.length, params.refinementReason, params.queries);
        signal?.throwIfAborted();
        const results = await mapWithConcurrency(params.queries, 3, async (query) => {
          signal?.throwIfAborted();
          try {
            const search = await webSearch(query, params.limitPerQuery, signal ? { signal } : {});
            const queryGroups = params.queryTopics?.find((topic) => topic.query.trim() === query.trim())?.topicGroups ?? params.topicGroups;
            const groups = queryGroups?.map((group) => group.map((term) => term.trim().toLowerCase()).filter(Boolean)).filter((group) => group.length);
            const matchedResultIndices = groups?.length ? search.results.flatMap((result, index) => {
              const text = `${result.title} ${result.snippet}`.toLowerCase();
              return groups.every((group) => group.some((term) => text.includes(term))) ? [index] : [];
            }) : undefined;
            return { ok: true, ...search, ...(matchedResultIndices ? { categoryLeads: {
              matchedResultIndices,
              count: matchedResultIndices.length,
              topicGroups: groups,
              scope: "Lexical title/snippet matches only; not verified product relevance, availability or image content.",
              nextAction: matchedResultIndices.length
                ? "Evaluate these category leads before replacing them with generic background sources. Fetch useful direct-category pages and collect their references, or record a specific exclusion reason."
                : "Category coverage remains unestablished. Simplify the combined-category query or use a discovered alias before spending remaining searches on generic background.",
            } } : {}) };
          } catch (error) {
            signal?.throwIfAborted();
            return { ok: false, query, error: error instanceof Error ? error.message : String(error) };
          }
        });
        return textResult({ ...batchSummary(results), budget });
      },
    });

    pi.registerTool({
      name: "research_fetch",
      label: "Fetch research source",
      description: "Fetch a public research page, cache readable full text when requested and extract task-focused passages from the article rather than only its opening. Supply core researchTerms; matchedTerms and extractionMethod describe the excerpt, not complete topic verification.",
      parameters: Type.Object({
        runId: Type.String(),
        url: Type.String(),
        id: Type.Optional(Type.String({ description: "Stable cache filename stem. Derived from the URL when omitted." })),
        cacheText: Type.Optional(Type.Boolean()),
        researchTerms: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 16, description: "Core concepts and supported aliases to locate relevant passages throughout the text. Do not substitute project titles or host-only keywords." })),
      }),
      async execute(_id, params, signal) {
        await consumeWorkflowBudget(workspaceDir, params.runId, "sourceFetches", 1);
        try {
          return textResult(await researchFetch(workspaceDir, params, signal ? { signal } : {}));
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
      description: "Fetch independent research pages with bounded concurrency and optionally retain metadata-screened reference candidates. Saved images still require Designer relevance judgment.",
      parameters: Type.Object({
        runId: Type.String(),
        refinementReason: Type.Optional(Type.String({ minLength: 10, description: "Specific unresolved evidence/figure gap; enables one bounded source-fetch reserve. Select new sources rather than repeating attempted URLs." })),
        sources: Type.Array(Type.Object({
          url: Type.String(),
          id: Type.Optional(Type.String()),
          cacheText: Type.Optional(Type.Boolean()),
          refresh: Type.Optional(Type.Boolean({ description: "Explicitly refetch this source and consume acquisition budget." })),
          researchTerms: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 16, description: "Core terms and supported aliases for full-text passage selection; defaults to referenceFocusTerms. Include subject terms before host/application terms." })),
          saveLeadImageAs: Type.Optional(Type.String({ description: "When provided, discover and save ranked reference candidates under this asset id, excluding obvious page utilities." })),
          referenceImageCount: Type.Optional(Type.Integer({ minimum: 1, description: "Requested number of distinct page images. If omitted, retain discovered likely and article-context candidates instead of silently selecting one. No per-page or per-Run reference-count ceiling." })),
          referenceFocusTerms: Type.Optional(Type.Array(Type.String(), { maxItems: 8, description: "Task-specific scene, material or use terms to rank candidate metadata; not proof of visual relevance." })),
          includeIdentityAssets: Type.Optional(Type.Boolean({ description: "Retain existing marks for identity research, exclusion checks, preservation or authorized redesign. Retaining an asset does not establish its reuse permissions." })),
          includeIconAssets: Type.Optional(Type.Boolean({ description: "Retain icons only when icon/pictogram design research is relevant. Page controls, QR codes and tracking images remain excluded." })),
          assetKind: Type.Optional(Type.String()),
          assetDescription: Type.Optional(Type.String()),
          assetDoNotReplace: Type.Optional(Type.Boolean()),
          assetAllowedForEdit: Type.Optional(Type.Boolean()),
        }), { minItems: 1, maxItems: 10 }),
      }),
      async execute(_id, params, signal) {
        const budget = await consumeWorkflowBudget(workspaceDir, params.runId, "sourceFetches", params.sources.length, params.refinementReason, params.sources.map((source) => source.url), params.sources.filter((source) => source.refresh).map((source) => source.url));
        const maxTextChars = Math.floor(6_000 / params.sources.length);
        const results: Array<Record<string, unknown>> = await mapWithConcurrency(params.sources, 3, async (source) => {
          signal?.throwIfAborted();
          let fetched: Record<string, unknown>;
          let pageHtml: string | undefined;
          const researchTerms = source.researchTerms ?? source.referenceFocusTerms;
          try {
            fetched = await researchFetch(workspaceDir, {
              runId: params.runId,
              url: source.url,
              ...(source.id !== undefined ? { id: source.id } : {}),
              cacheText: true,
              ...(source.refresh ? { refresh: true } : {}),
              ...(researchTerms ? { researchTerms } : {}),
            }, { ...(signal ? { signal } : {}), maxTextChars, onHtml: (html) => { pageHtml = html; } });
            if (pageHtml !== undefined) {
              const page = { html: pageHtml, url: typeof fetched.url === "string" ? fetched.url : source.url };
              researchPages.set(`${safeRunId(params.runId)}:${source.url}`, page);
              researchPages.set(`${safeRunId(params.runId)}:${page.url}`, page);
              while (researchPages.size > 48) researchPages.delete(researchPages.keys().next().value!);
            }
          } catch (error) {
            signal?.throwIfAborted();
            fetched = {
              ok: false,
              ...(source.id ? { id: source.id } : {}),
              url: source.url,
              error: error instanceof Error ? error.message : String(error),
            };
          }
          signal?.throwIfAborted();
          if (!source.saveLeadImageAs) return fetched;
          if (fetched.ok === false) return {
            ...fetched,
            leadImageError: "Image discovery skipped because the source page could not be fetched. Retain successful sources and replace only a consequential gap; do not retry this unchanged page for images.",
          };
          try {
            signal?.throwIfAborted();
            const discovery = await discoverResearchAssets(typeof fetched.url === "string" && fetched.url ? fetched.url : source.url, source.referenceImageCount ?? Number.MAX_SAFE_INTEGER, {
              ...(signal ? { signal } : {}),
              ...(source.referenceFocusTerms ? { focusTerms: source.referenceFocusTerms } : {}),
              includeIdentityAssets: source.includeIdentityAssets ?? false,
              includeIconAssets: source.includeIconAssets ?? false,
              ...(pageHtml !== undefined ? { html: pageHtml } : {}),
            });
            const candidates = discovery.candidates;
            return candidates.length
              ? { ...fetched, leadImageCandidate: candidates[0], referenceImageCandidates: candidates, excludedImageCandidates: discovery.excluded }
              : { ...fetched, excludedImageCandidates: discovery.excluded, leadImageError: "No reference candidates had sufficient task relevance and article context. Record the gap or choose a source with relevant figures; do not pad the requested count with unrelated images." };
          } catch (error) {
            signal?.throwIfAborted();
            return { ...fetched, leadImageError: error instanceof Error ? error.message : String(error) };
          }
        });
        for (const [index, source] of params.sources.entries()) {
          if (!source.saveLeadImageAs) continue;
          const result = results[index]!;
          const candidates = result.referenceImageCandidates;
          if (!Array.isArray(candidates)) continue;
          const saved: Array<Record<string, unknown>> = await mapWithConcurrency(candidates, 3, async (candidate, candidateIndex) => {
            try {
              return await fetchResearchAsset(workspaceDir, {
                runId: params.runId,
                id: candidateIndex === 0 ? source.saveLeadImageAs! : `${source.saveLeadImageAs}-${candidateIndex + 1}`,
                url: (candidate as Record<string, unknown>).url as string,
                sourcePageUrl: source.url,
                ...(source.assetKind !== undefined ? { kind: source.assetKind } : {}),
                description: [(candidate as { figureId?: string }).figureId, (candidate as { caption?: string }).caption, (candidate as { description?: string }).description, (candidate as { alt?: string }).alt].filter(Boolean).join(" — ") || "Unreviewed article-context candidate; image content is not established by the source page's subject.",
                ...(source.assetDescription ? { sourceContext: source.assetDescription } : {}),
                relevanceBasis: (candidate as { relevance_basis: string }).relevance_basis,
                relevanceStatus: (candidate as { relevance_status: "likely" | "uncertain" }).relevance_status,
                matchedTerms: (candidate as { matched_terms: string[] }).matched_terms,
                ...(source.assetDoNotReplace !== undefined ? { doNotReplace: source.assetDoNotReplace } : {}),
                ...(source.assetAllowedForEdit !== undefined ? { allowedForEdit: source.assetAllowedForEdit } : {}),
              }, signal);
            } catch (error) {
              signal?.throwIfAborted();
              return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
          });
          result.savedReferenceImages = saved;
          if (saved[0]?.ok === false) result.leadImageError = saved[0].error;
          else if (saved[0]) result.savedLeadImage = saved[0];
        }
        const resultCache = join(resolveInside(workspaceDir, join("runs", safeRunId(params.runId))), "research", "batches", `${randomUUID()}.json`);
        await mkdir(dirname(resultCache), { recursive: true });
        await writeFile(resultCache, JSON.stringify(results, null, 2));
        const resultDetailsPath = relative(workspaceDir, resultCache).replaceAll("\\", "/");
        for (const result of results) {
          delete result.referenceImageCandidates;
          delete result.excludedImageCandidates;
          delete result.leadImageCandidate;
          const assets = result.savedReferenceImages;
          if (Array.isArray(assets)) result.savedReferenceImages = assets.map(asset => {
            const item = asset as Record<string, unknown>;
            const compact = Object.fromEntries(["ok", "id", "path", "file", "error"].filter(key => key in item).map(key => [key, item[key]]));
            if (item.asset && typeof item.asset === "object") {
              const asset = item.asset as Record<string, unknown>;
              compact.asset = Object.fromEntries(["id", "allowed_for_edit", "visual_review_status", "relevance_status", "source_page_url", "source_url"].filter(key => key in asset).map(key => [key, asset[key]]));
            }
            return compact;
          });
          if (Array.isArray(result.savedReferenceImages)) result.savedLeadImage = result.savedReferenceImages[0];
        }
        const researchGaps = results.flatMap((result, index) => {
          const source = params.sources[index]!;
          const gaps: Array<{ url: string; kind: string; action: string }> = [];
          if (result.ok === false) gaps.push({ url: source.url, kind: "source_unavailable", action: "Search a changed query for an accessible primary publication, author repository or equivalent source; retain successful items." });
          const terms = source.researchTerms ?? source.referenceFocusTerms;
          if (result.ok !== false && terms?.length && Array.isArray(result.matchedTerms) && result.matchedTerms.length === 0) gaps.push({ url: source.url, kind: "core_terms_not_located", action: "Check supported aliases and source relevance; inspect targeted cached text or refine the core-subject query. This lexical gap is not proof of irrelevance." });
          const saved = Array.isArray(result.savedReferenceImages) ? result.savedReferenceImages as Array<{ ok?: boolean }> : [];
          if (source.saveLeadImageAs && result.ok !== false && !saved.some((asset) => asset.ok === true)) gaps.push({ url: source.url, kind: "usable_images_missing", action: "Search changed terms for subject figures, another primary source or a high-resolution figure page; never fill the count with unrelated page images." });
          else if (saved.some((asset) => asset.ok === false)) gaps.push({ url: source.url, kind: "some_images_unavailable", action: "Keep downloaded assets and replace only missing decision-relevant views with changed keywords or sources." });
          return gaps;
        });
        return textResult({
          ...batchSummary(results),
          resultDetailsPath,
          budget,
          researchGaps,
          nextAction: researchGaps.length ? "Assess these gaps and continue with targeted cached reading or changed-keyword/source search within remaining budget before declaring core coverage. Preserve successful acquisition; report unresolved gaps honestly." : "Assess semantic relevance and coverage; successful acquisition alone does not establish subject understanding.",
          instruction: "Saved images are unreviewed candidates, not confirmed useful references. Page relevance is not image relevance. Source excerpts are bounded to 6000 characters across this batch; full candidate and asset metadata are stored at resultDetailsPath; researchTerms select matching passages throughout the article, while complete text remains cached at cachedPath. Inspect matchedTerms, extractionMethod, core terminology and figure coverage before claiming research completion. If only opening excerpts or adjacent evidence are available, read a targeted cached passage or refine an unresolved core question within remaining budget. Do not pad missing images or treat a truncated excerpt as a full-paper reading. Write one canonical file per model response once material gaps are resolved or explicitly reported.",
        });
      },
    });

    pi.registerTool({
      name: "research_asset_discover",
      label: "Discover page images",
      description: "Discover real metadata and image URLs from a public source page before selecting references to retain. Omit limit to return all eligible candidates. Identity/icon exceptions require a task-specific visual need, not merely a brand-design task.",
      parameters: Type.Object({
        pageUrl: Type.String(),
        runId: Type.Optional(Type.String({ description: "Reuse HTML fetched earlier in this specialist session. No source refetch when cached; new pages count toward the Run source budget." })),
        refinementReason: Type.Optional(Type.String({ minLength: 10 })),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
        referenceFocusTerms: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),
        includeIdentityAssets: Type.Optional(Type.Boolean()),
        includeIconAssets: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params, signal) {
        const cached = params.runId ? researchPages.get(`${safeRunId(params.runId)}:${params.pageUrl}`) : undefined;
        if (params.runId && !cached) await consumeWorkflowBudget(workspaceDir, params.runId, "sourceFetches", 1, params.refinementReason, [params.pageUrl]);
        return textResult(await discoverResearchAssets(cached?.url ?? params.pageUrl, params.limit, {
          ...(cached ? { html: cached.html } : {}),
          ...(signal ? { signal } : {}),
          ...(params.runId ? { onHtml: (html: string) => {
            researchPages.set(`${safeRunId(params.runId!)}:${params.pageUrl}`, { html, url: cached?.url ?? params.pageUrl });
            while (researchPages.size > 48) researchPages.delete(researchPages.keys().next().value!);
          } } : {}),
          ...(params.referenceFocusTerms ? { focusTerms: params.referenceFocusTerms } : {}),
          ...(params.includeIdentityAssets !== undefined ? { includeIdentityAssets: params.includeIdentityAssets } : {}),
          ...(params.includeIconAssets !== undefined ? { includeIconAssets: params.includeIconAssets } : {}),
        }));
      },
    });

    pi.registerTool({
      name: "user_material_extract",
      label: "Extract user page content",
      description: "Extract text and concrete image links from user-provided webpages, GitHub repository READMEs, uploads or linked content. Keeps requested identity assets; selected imageUrls are imported unchanged with trusted receipts. This is user-content acquisition, not general reference research.",
      parameters: Type.Object({ runId: Type.String(), source: Type.String(), sourcePageUrl: Type.Optional(Type.String()), imageUrls: Type.Optional(Type.Array(Type.String(), { maxItems: 24 })) }),
      async execute(_id, params, signal) {
        assertAssignedRun(params.runId, "user_material_extract");
        const state = await readJsonRecord(resolveInside(workspaceDir, join("runs", safeRunId(params.runId))), "run-state.json");
        if (state.status === "complete") throw new Error("Call run_revision before acquiring new material for a completed Run");
        return textResult(await extractUserMaterial(workspaceDir, params, signal));
      },
    });

    pi.registerTool({
      name: "user_asset_import",
      label: "Import user material",
      description: "Import exact user-provided image/video/document bytes into the assigned Run. source must be an explicit user URL or persisted upload; sourcePageUrl allows an asset actually linked by a user-provided page. Returns the trusted inputs/user-assets/... source for approved HTML resource copying.",
      parameters: Type.Object({ runId: Type.String(), source: Type.String(), sourcePageUrl: Type.Optional(Type.String()) }),
      async execute(_id, params, signal) {
        assertAssignedRun(params.runId, "user_asset_import");
        const state = await readJsonRecord(resolveInside(workspaceDir, join("runs", safeRunId(params.runId))), "run-state.json");
        if (state.status === "complete") throw new Error("Call run_revision before importing new material into a completed Run");
        const asset = await importUserAsset(workspaceDir, params, signal);
        return textResult({ ok: true, ...asset, filePath: resolveInside(workspaceDir, join("runs", safeRunId(params.runId), asset.source)) });
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
      async execute(_id, params, signal) {
        return textResult(await fetchResearchAsset(workspaceDir, params, signal));
      },
    });

    pi.registerTool({
      name: "research_asset_fetch_batch",
      label: "Save multiple research assets",
      description: "Download selected reference images with bounded concurrency; manifest writes and duplicate checks are serialized for integrity.",
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
        }), { minItems: 1 }),
      }),
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const results = await mapWithConcurrency(params.assets, 3, async (asset) => {
          signal?.throwIfAborted();
          try {
            return await fetchResearchAsset(workspaceDir, { runId: params.runId, ...asset }, signal);
          } catch (error) {
            signal?.throwIfAborted();
            return { ok: false, id: asset.id, url: asset.url, error: error instanceof Error ? error.message : String(error) };
          }
        });
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
      async execute(_id, params, signal) {
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
        runId: Type.Optional(Type.String({ description: "Existing DreamaticArt Run id. Required for durable stage sessions and completion validation." })),
      }),
      async execute(invocationId, params, signal, onUpdate, context) {
        if (params.runId) assertAssignedRun(params.runId, "spawn_agent");
        if (!context.model) throw new Error("The parent session has no active model to pass to the design agent");
        if (!DREAMATIC_SPECIALISTS.has(params.agent)) {
          throw new Error(`Unknown DreamaticArt specialist: ${params.agent}. Expected researcher, designer, reviewer, or builder.`);
        }
        const initiallyRunning = currentSpecialistInvocation();
        if (revisionOpening) throw new Error("Wait for the revision handoff to finish before starting a specialist");
        if (initiallyRunning) {
          throw new Error(`Cannot start ${params.agent}; ${initiallyRunning.agent} is still running in invocation ${initiallyRunning.id}`);
        }
        const personaPath = join(context.cwd, ".pi", "agents", `${safeRunId(params.agent)}.md`);
        const source = await readFile(personaPath, "utf8");
        const { frontmatter, body } = parseFrontmatter<PersonaFrontmatter>(source);
        let tools: string[];
        try {
          tools = dreamaticPersonaTools(params.agent, frontmatter.allowed_tools);
        } catch (error) {
          return finishWorkflow({
            ok: false,
            retryable: false,
            error: error instanceof Error ? error.message : String(error),
            instruction: "Rebuild and restart Server/CLI, then resume this Run's pending stage. Do not retry this configuration error, change the task wording, remove required permissions, or repeat completed stages.",
          });
        }
        const taskRunId = runIdFromTask(params.task);
        const inferredRunId = params.runId ? safeRunId(params.runId) : taskRunId ?? (options.projectId ? safeRunId(options.projectId) : undefined);
        if (coordinator) {
          const issue = orchestratorHandoffIssue(params.task);
          if (issue) return textResult({ok:false,retryable:false,repairOwner:"orchestrator",code:"invalid_context_handoff",instruction:issue});
          if (!inferredRunId || !(await hasUnifiedContext(resolveInside(workspaceDir, join("runs", inferredRunId))))) return textResult({ok:false,retryable:false,repairOwner:"runtime",code:"context_migration_required",instruction:"This task requires canonical Context before dispatch. Preserve the Run and request an explicit data migration; no specialist was started."});
        }
        if (inferredRunId) assertAssignedRun(inferredRunId, "spawn_agent");
        if (inferredRunId && taskRunId && taskRunId !== inferredRunId) throw new Error(`spawn_agent handoff disagrees with its Run assignment. Task refers to ${taskRunId}, canonical runId: ${inferredRunId}; runDir: ${resolveInside(workspaceDir, join("runs", inferredRunId))}. Correct the handoff paths before starting the specialist.`);
        if (!inferredRunId || !(await hasUnifiedContext(resolveInside(workspaceDir, join("runs", inferredRunId))))) tools = tools.filter(name => !["update_design_context", "commit_design_context", "save_design_context", "patch_design_context"].includes(name));
        if (inferredRunId && await hasUnifiedContext(resolveInside(workspaceDir, join("runs", inferredRunId)))) tools = tools.filter(name => !["save_design_context", "patch_design_context"].includes(name));
        const runAssignment = inferredRunId ? specialistRunAssignment(workspaceDir, inferredRunId, params.agent) : "";
        const sourceBrief = inferredRunId ? await readJsonRecord(resolveInside(workspaceDir, join("runs", inferredRunId)), "brief.json").catch((error) => { throw new Error(`spawn_agent requires an initialized Run with brief.json: ${inferredRunId}. Use run_init's returned canonical runId; no specialist was started. ${error instanceof Error ? error.message : String(error)}`); }) : {};
        if (inferredRunId && typeof sourceBrief.runId === "string" && safeRunId(sourceBrief.runId) !== inferredRunId) throw new Error(`Run brief identity disagrees with ${inferredRunId}; repair the assignment before starting a specialist.`);
        if (params.agent === "designer") {
          const conflict = designerHandoffError(params.task, sourceBrief);
          if (conflict) return textResult({ ok: false, retryable: false, repairOwner: "orchestrator", error: conflict, instruction: "Correct this handoff before starting Designer. No specialist was started." });
        }
        if (inferredRunId) activeRunId = inferredRunId;
        const revisionPlan = params.agent === "designer" && inferredRunId ? await readJsonRecord(resolveInside(workspaceDir, join("runs", inferredRunId)), "plan/design_plan.json").catch(() => undefined) : undefined;
        const draftReadiness = revisionPlan && inferredRunId ? await designerDraftReadiness(resolveInside(workspaceDir, join("runs", inferredRunId))) : undefined;
        if (params.agent === "designer" && draftReadiness && !draftReadiness.ok && /only need to commit|DO NOT read any files|文件已经全部写入|只(?:需|需要).*提交/i.test(params.task)) {
          return textResult({ ok: false, retryable: false, repairOwner: "orchestrator", draftReadiness,
            instruction: "The current draft is invalid. Replace this publish-only handoff with a repair task allowing source/plan reads and corrections, then reload retained Skills. Existing files do not establish readiness. No specialist was started." });
        }
        if (["designer", "reviewer", "builder"].includes(params.agent) && (!inferredRunId || !(await hasUnifiedContext(resolveInside(workspaceDir, join("runs", inferredRunId)))))) return textResult({ok:false,retryable:false,repairOwner:"runtime",code:"context_migration_required",instruction:`${params.agent} requires canonical Context. Preserve the Run and migrate its data explicitly before dispatch; no specialist was started.`});
        const unifiedHandoff = inferredRunId && await hasUnifiedContext(resolveInside(workspaceDir, join("runs", inferredRunId))) ? `\n\n# Authoritative Unified Context Contract\n${unifiedContextInstruction(params.agent, Number(sourceBrief.designContractVersion ?? 1))}${params.agent === "builder" ? "" : `\nNamed update example (illustrative content): ${JSON.stringify(contextChangesExample(params.agent))}`}` : "";
        const recoveryHandoff = params.agent === "designer" ? `\n\n# Authoritative Designer Delivery and Recovery Contract\nFor UX, Designer authors the full HTML/CSS/JS sources; Builder only executes the approved files and image tasks. A recovery task is never publish-only until current drafts pass validation. Read/correct existing files and reload retained Skills even if a delegated task says do not read/write or claims completion. Do not invent source paths: read design_context_read. ${draftReadiness ? JSON.stringify(draftReadiness) : Number(sourceBrief.designContractVersion ?? 1) === 2 ? "Create deliverables with stable ids and nested execution; tasks are read-only projections. Keep existing image prompts unchanged." : "Create named tasks with stable ids matching deliverables; image prompts remain unchanged."}` : "";
        const reloadChecklist = skillReloadChecklist(revisionPlan, briefDesignScopes(sourceBrief).map((scope) => scope.id));
        const scopeHandoff = params.agent === "designer" ? `# Authoritative Design Scope and Skill Protocol\n\n${JSON.stringify(designScopeSkillProtocol(briefDesignScopes(sourceBrief)))}${reloadChecklist.length ? `\n\n# Revision Skill Reload Checklist\n${JSON.stringify(reloadChecklist)}\nThis is a fresh invocation: earlier Skill receipts are not loaded knowledge. Before correcting the design, load every retained primary AND supporting Skill using these exact calls. You may autonomously change selections for this task, but select through use_skill and update skill_refs to match actual loading. Do not publish until the full retained selection is loaded.` : ""}` : "";
        const requestProvenance = `# User Request Provenance\n\n${JSON.stringify({ originalRequest: sourceBrief.originalRequest ?? null, originalRequestSource: sourceBrief.originalRequestSource ?? "unavailable", projectTitle: sourceBrief.title ?? null })}\noriginalRequest is the user's source text, not the project title or the Orchestrator's rewritten brief/task. Extract search terms from that text and confirmed user clarifications. Project titles are display labels, never original wording. When originalRequest is unavailable, report the provenance gap and recover the actual user message through Orchestrator; do not invent or relabel a title as user input. Later confirmed revisions supplement the original request; they do not rewrite it.`;
        const limits = inferredRunId
          ? await workflowBudget(resolveInside(workspaceDir, join("runs", inferredRunId)))
          : { profile: "compact" as const, budget: WORKFLOW_BUDGETS.compact };
        const runtimeLimits = `# DreamaticArt Runtime Limits\n\nWorkflow profile: ${limits.profile}. Initial research acquisition budgets: ${JSON.stringify(limits.budget)}. A specific material evidence/figure gap can enable one bounded reserve per resource via refinementReason, up to twice its initial budget. Change keywords/sources rather than repeating attempted requests. Cached-page rediscovery and selected-image downloads need no new source fetch. These budgets limit searches and source fetches only. Reference images have no per-page or per-Run count ceiling; ignore obsolete referenceAssets budgets in older Briefs or tasks. Choose useful reference coverage based on user intent and retain lightweight screening, provenance and file-safety checks; uncertain article-context candidates are for Designer to evaluate, not automatically reject. These budgets do not limit design deliverables. DREAMATIC_IMAGE_DEFAULT_SIZE is ${imageSizeCeiling()} and is the hard per-image size ceiling. Unless the user explicitly sets a quantity or requests fewer images, there is no total or per-stage generation-count ceiling. Designer must map significant design conclusions, developed alternatives, scenarios, states, details and applications to adequate visual deliverables. Do not treat compact profiles, Skill examples, retry budgets or concurrency limits as output quotas. Builder executes the complete approved deliverable set. Image-specific limits apply only to imagery; HTML pages use their approved viewport/interaction requirements. No planned or executed image may exceed the image-size envelope, including when orientation is swapped.`;
        const executionProfile = params.agent === "builder" && inferredRunId
          ? await readJsonRecord(resolveInside(workspaceDir, join("runs", inferredRunId)), "plan/design_plan.json").then((plan) => plan.schemaVersion === 2 ? "\n\n# Approved Typed Execution\nUse execute_design_plan without ids first to execute all required tasks. ids selects a subset only; HTML presentation does not cancel required image tasks. HTML sources already contain the full design: do not reconstruct, copy by hand, write or edit their artifact files, even if the handoff says implement a page. Source resources and interactions are validated before approval. Do not perform another browser/visual/design audit or try image editing as a file-copy operation. Only mechanical generation/reuse and declared Gallery/manual output authoring belong to Builder." : "").catch(() => "") : "";
        if (params.agent === "builder") tools = await builderToolsForRun(inferredRunId);
        const childLoader = new DefaultResourceLoader({
          cwd: context.cwd,
          agentDir: getAgentDir(),
          systemPromptOverride: () => `${unifiedHandoff ? unifiedContextPrompt(dreamaticPersonaPromptBlock(body)) : dreamaticPersonaPromptBlock(legacyContextPrompt(body))}\n\n${runtimeLimits}\n\n${requestProvenance}\n\n${scopeHandoff}${recoveryHandoff}${unifiedHandoff}\n\n${runAssignment}${executionProfile}`,
          appendSystemPromptOverride: (base) => base,
          extensionFactories: [createDreamaticExtension({
            ...options,
            personaPath,
            parentInvocation: { id: invocationId, agent: params.agent, ...(inferredRunId ? { runId: inferredRunId } : {}) },
          })],
        });
        await childLoader.reload();
        if (STAGE_COMPLETION_EVENTS[params.agent] && !inferredRunId) {
          throw new Error(`spawn_agent requires runId for workflow stage ${params.agent}`);
        }
        let startingEventCount = 0;
        if (inferredRunId) {
          const busPath = resolveInside(workspaceDir, join("runs", inferredRunId, "bus.jsonl"));
          const allBusEvents = (await readFile(busPath, "utf8").catch(() => ""))
            .split(/\r?\n/)
            .filter(Boolean)
            .flatMap((line) => {
              try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
            });
          startingEventCount = allBusEvents.length;
          const busEvents = currentWorkflowCycle(allBusEvents);
          const state = await readJsonRecord(resolveInside(workspaceDir, join("runs", inferredRunId)), "run-state.json").catch(() => undefined);
          if (state?.status === "complete" || state?.lastEvent === "build_done") throw new Error("This Run cannot start another specialist until an explicit user revision is opened with run_revision after export.");
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
          if (params.agent === "builder") {
            try {
              await assertStageCommitted(workspaceDir, inferredRunId, "reviewer", 0);
              await assertStageCommitted(workspaceDir, inferredRunId, "designer", 0, true);
            }
            catch (error) {
              if (!(error instanceof DeliveryBlocked)) throw error;
              return textResult({ ok: false, blocked: true, retryable: false, runId: inferredRunId, repairOwner: error.repairOwner, issues: error.issues,
                instruction: "Return unresolved approval issues to Designer, then obtain a new Reviewer approval before starting Builder." });
            }
            const block = await readJsonRecord(resolveInside(workspaceDir, join("runs", inferredRunId)), ".performance/build-block.json").catch(() => undefined);
            if (block && block.reviewEventId === latestDesignGate?.id && block.runtimeStamp === await deliveryRuntimeStamp()) return textResult({ ...block, ok: false, blocked: true, retryable: false,
              instruction: "Do not start another Builder with the same failed approved specification. Route these issues to the repair owner; Designer changes require a new specification and Reviewer approval. A runtime correction can retry unchanged approved sources." });
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
        const toolProgressTimers = new Map<string, ReturnType<typeof setInterval>>();
        const toolProgressDetails = new Map<string, string>();
        const toolArguments = new Map<string, unknown>();
        const toolMetrics = new Map<string, { calls: number; durationMs: number; errors: number }>();
        const modelTurns: Array<Record<string, unknown>> = [];
        let turnStartedAt: number | undefined;
        let responseStartedAt: number | undefined;
        let firstDeltaAt: number | undefined;
        let firstTextAt: number | undefined;
        let responseFinishedAt: number | undefined;
        let committedDuringPrompt: string | undefined;
        let blockedDuringPrompt: Record<string, unknown> | undefined;
        const preparationFailures = new ContextFailureTracker();
        let modelLastActivityAt = Date.now();
        let modelResponseChars = 0;
        let modelTimer: ReturnType<typeof setInterval> | undefined;
        let modelTimeoutError: Error | undefined;
        let lastModelFailure: string | undefined;
        const modelTurnTimeoutMs = Math.max(30_000, Number(process.env[`DREAMATIC_MODEL_TURN_TIMEOUT_MS_${params.agent.toUpperCase()}`] ?? process.env.DREAMATIC_MODEL_TURN_TIMEOUT_MS ?? (params.agent === "researcher" ? 180_000 : 300_000)) || 300_000);
        const modelIdleTimeoutMs = Math.max(30_000, Number(process.env.DREAMATIC_MODEL_IDLE_TIMEOUT_MS ?? 120_000) || 120_000);
        const modelGenerationTimeoutMs = Math.max(30_000, Number(process.env.DREAMATIC_MODEL_GENERATION_TIMEOUT_MS ?? 300_000) || 300_000);
        const modelTotalTimeoutMs = Math.max(modelTurnTimeoutMs, Number(process.env.DREAMATIC_MODEL_TOTAL_TIMEOUT_MS ?? modelTurnTimeoutMs + modelGenerationTimeoutMs) || modelTurnTimeoutMs + modelGenerationTimeoutMs);
        const stopModelTimer = () => {
          if (modelTimer) clearInterval(modelTimer);
          modelTimer = undefined;
        };
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
        const restoreTurnStop = stopAfterCommittedTurn(session.agent, () => Boolean(committedDuringPrompt || blockedDuringPrompt));
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "turn_start") {
            stopModelTimer();
            turnStartedAt = Date.now();
            responseStartedAt = undefined;
            firstDeltaAt = undefined;
            firstTextAt = undefined;
            responseFinishedAt = undefined;
            modelLastActivityAt = turnStartedAt;
            modelResponseChars = 0;
            modelTimeoutError = undefined;
            modelTimer = setInterval(() => {
              const durationMs = Date.now() - (turnStartedAt ?? Date.now());
              const idleMs = Date.now() - modelLastActivityAt;
              const timeoutReason = responseTimeoutReason(durationMs, idleMs, firstDeltaAt === undefined ? undefined : Date.now() - firstDeltaAt, { firstOutputMs: modelTurnTimeoutMs, idleMs: modelIdleTimeoutMs, generationMs: modelGenerationTimeoutMs, totalMs: modelTotalTimeoutMs });
              const progress = `${params.agent}: ${firstDeltaAt ? "generating the next response" : "waiting for the model"} · ${Math.round(durationMs / 1000)}s · ${modelResponseChars} streamed characters`;
              void emitLifecycle({ type: "agent_progress", output: progress, durationMs, responseChars: modelResponseChars, status: "running" });
              onUpdate?.({ content: [{ type: "text", text: progress }], details: { agent: params.agent, running: true } });
              if (timeoutReason) {
                modelTimeoutError = new Error(`Sub-agent ${params.agent} model response timed out after ${durationMs} ms (${timeoutReason}; ${idleMs} ms without stream activity); durable tool results are preserved`);
                stopModelTimer();
                void session.abort();
              }
            }, 15_000);
            return;
          }
          if (event.type === "message_start" && event.message.role === "assistant") {
            responseStartedAt ??= Date.now();
            return;
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            stopModelTimer();
            responseFinishedAt = Date.now();
            return;
          }
          if (event.type === "turn_end") {
            stopModelTimer();
            const endedAt = Date.now();
            const assistant = event.message.role === "assistant" ? event.message : undefined;
            modelTurns.push({
              index: modelTurns.length + 1,
              turnMs: turnStartedAt ? endedAt - turnStartedAt : undefined,
              firstResponseMs: turnStartedAt && responseStartedAt ? responseStartedAt - turnStartedAt : undefined,
              firstDeltaMs: turnStartedAt && firstDeltaAt ? firstDeltaAt - turnStartedAt : undefined,
              firstTextMs: turnStartedAt && firstTextAt ? firstTextAt - turnStartedAt : undefined,
              streamedChars: modelResponseChars,
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
          if (event.type === "message_update") {
            const update = event.assistantMessageEvent;
            if ("delta" in update && typeof update.delta === "string" && update.delta.length) {
              modelLastActivityAt = Date.now();
              firstDeltaAt ??= Date.now();
              if (update.type === "text_delta") firstTextAt ??= Date.now();
              modelResponseChars += update.delta.length;
            }
            if (update.type === "text_delta") onUpdate?.({
              content: [{ type: "text", text: update.delta }],
              details: { agent: params.agent, running: true },
            });
            return;
          }
          if (event.type === "tool_execution_start") {
            stopModelTimer();
            toolStartedAt.set(event.toolCallId, Date.now());
            toolProgressTimers.set(event.toolCallId, setInterval(() => {
              const durationMs = Date.now() - (toolStartedAt.get(event.toolCallId) ?? Date.now());
              const progress = `${toolProgressDetails.get(event.toolCallId) ?? `${params.agent}: executing ${event.toolName}`} · ${Math.round(durationMs / 1000)}s elapsed`;
              void emitLifecycle({ type: "agent_progress", output: progress, toolCallId: event.toolCallId, toolName: event.toolName, durationMs, status: "running" });
              onUpdate?.({ content: [{ type: "text", text: progress }], details: { agent: params.agent, running: true } });
            }, 15_000));
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
          if (event.type === "tool_execution_update") {
            const result = event.partialResult;
            const output = Array.isArray(result?.content) ? result.content.filter((item: { type?: string; text?: unknown }) => item.type === "text" && typeof item.text === "string").map((item: { text: string }) => item.text).join("\n").slice(0, 1_200) : "";
            if (output) {
              toolProgressDetails.set(event.toolCallId, output);
              void emitLifecycle({ type: "agent_progress", output, toolCallId: event.toolCallId, toolName: event.toolName, status: "running" });
              onUpdate?.({ content: [{ type: "text", text: output }], details: { agent: params.agent, running: true } });
            }
            return;
          }
          if (event.type === "tool_execution_end") {
            const progressTimer = toolProgressTimers.get(event.toolCallId);
            if (progressTimer) clearInterval(progressTimer);
            toolProgressTimers.delete(event.toolCallId);
            toolProgressDetails.delete(event.toolCallId);
            const args = toolArguments.get(event.toolCallId);
            toolArguments.delete(event.toolCallId);
            const durationMs = Math.max(0, Date.now() - (toolStartedAt.get(event.toolCallId) ?? Date.now()));
            toolStartedAt.delete(event.toolCallId);
            const metric = toolMetrics.get(event.toolName) ?? { calls: 0, durationMs: 0, errors: 0 };
            if (event.isError && !event.result.details?.errorCode && ["update_design_context", "commit_design_context", "save_design_context", "patch_design_context"].includes(event.toolName)) {
              const issue = canonicalContextError(workflowObservation(event.result, 8_000));
              const identity = contextFailureIdentity(event.toolName, issue, args);
              const key = createHash("sha256").update(identity.key).digest("hex");
              const attempts = preparationFailures.record(key, event.toolCallId);
              if (attempts >= 3) blockedDuringPrompt = { ok: false, blocked: true, retryable: false, repairOwner: params.agent, attempts, issue, errorCode: identity.code, field: identity.location, instruction: "Correct the named input before re-dispatching. No stage completion was committed." };
            }
            const validationBlocked = !event.isError && event.result.details && typeof event.result.details === "object" && (event.result.details as Record<string, unknown>).blocked === true;
            const executionFailed = ["commit_design_context", "image_generate_batch", "image_edit_batch", "execute_image_plan", "execute_design_plan"].includes(event.toolName) && event.result.details?.ok === false;
            metric.calls += 1;
            metric.durationMs += durationMs;
            if (event.isError || validationBlocked || executionFailed) metric.errors += 1;
            toolMetrics.set(event.toolName, metric);
            const output = workflowObservation(event.result, 1_200);
            void emitLifecycle({
              type: "tool_finished",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              output,
              isError: event.isError || Boolean(validationBlocked) || executionFailed,
              status: validationBlocked ? "blocked" : event.isError || executionFailed ? "error" : "completed",
            });
            if (!event.isError && ["research_asset_fetch", "research_asset_fetch_batch", "research_fetch_batch"].includes(event.toolName) && inferredRunId) {
              for (const path of workflowReferencePaths(event.result, inferredRunId)) {
                void emitLifecycle({ type: "reference_added", toolCallId: event.toolCallId, path, status: "completed" });
              }
            }
            if (validationBlocked) blockedDuringPrompt = event.result.details as Record<string, unknown>;
            const completionEvent = specialistCompletionEvent(params.agent, event.toolName, event.isError, args, event.result);
            if (completionEvent && process.env.DREAMATIC_STOP_AFTER_COMMIT?.trim().toLowerCase() !== "false") {
              committedDuringPrompt = completionEvent;
            }
          }
        });
        const abort = () => void session.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const childSessionFile = session.sessionFile;
        try {
          try {
            await withRetry(async (attempt) => {
              try {
                const task = attempt === 1 ? params.task : modelRecoveryTask(lastModelFailure);
                const stageTask = unifiedHandoff
                  ? `${unifiedContextPrompt(task)}\n\n${specialistStageContract(params.agent, Number(sourceBrief.designContractVersion ?? 1))}\n\n# Research Acquisition Observations\n${JSON.stringify(await researchAcquisition(resolveInside(workspaceDir, join("runs", inferredRunId!))))}`
                  : task;
                await session.prompt(runAssignment ? `${runAssignment}\n\n# Stage Task\n\n${stageTask}` : stageTask);
              } catch (error) {
                const failure = modelTimeoutError ?? error;
                lastModelFailure = failure instanceof Error ? failure.message : String(failure);
                throw modelTimeoutError ?? error;
              }
              signal?.throwIfAborted();
              if (modelTimeoutError) { lastModelFailure = modelTimeoutError.message; throw modelTimeoutError; }
              if (committedDuringPrompt || blockedDuringPrompt) return;
              const failure = dreamaticSessionFailure(session.messages);
              if (failure) { lastModelFailure = failure; throw new Error(`Sub-agent ${params.agent} failed: ${failure}`); }
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
            if ((!committedDuringPrompt && !blockedDuringPrompt) || signal?.aborted || modelTimeoutError) throw error;
          }
          if (blockedDuringPrompt) {
            if (inferredRunId) await updateRunState(workspaceDir, inferredRunId, `${params.agent}_interrupted`);
            await emitLifecycle({ type: "agent_interrupted", status: "blocked", error: `${params.agent} validation requires correction before completion`, ...blockedDuringPrompt, metrics: { durationMs: Date.now() - agentStartedAt, tools: Object.fromEntries(toolMetrics), modelTurns } });
            return textResult({ ...blockedDuringPrompt, agent: params.agent, runId: inferredRunId, committedEvent: null });
          }
          const output = committedDuringPrompt
            ? `${params.agent} committed ${committedDuringPrompt}; runtime ended the completed specialist session without an additional summary round.`
            : finalAssistantText(session.messages);
          const validationStartedAt = performance.now();
          const committedEvent = inferredRunId
            ? await assertStageCommitted(workspaceDir, inferredRunId, params.agent, startingEventCount)
            : "not-required";
          const validationMs = Math.round(performance.now() - validationStartedAt);
          await lifecycleWrites;
          await emitLifecycle({
            type: "agent_finished",
            output,
            committedEvent,
            status: "completed",
            metrics: { durationMs: Date.now() - agentStartedAt, validationMs, tools: Object.fromEntries(toolMetrics), modelTurns },
          });
          const guidance = { ...(committedEvent === "build_done" ? { nextAction: { tool: "export_package", arguments: { runId: inferredRunId } }, instruction: "Call export_package immediately. Do not inspect artifacts or start another specialist." } : {}),
            ...(coordinator && committedEvent !== "build_done" ? {readArguments:{runId:inferredRunId,audience:"orchestrator",paths:[({researcher:CONTEXT_FILES.research,designer:CONTEXT_FILES.design,reviewer:CONTEXT_FILES.review} as Record<string,string>)[params.agent]],full:true}} : {}),
            ...(inferredRunId ? { researchAcquisition: await researchAcquisition(resolveInside(workspaceDir, join("runs", inferredRunId))) } : {}) };
          return {
            content: [{ type: "text", text: `${output || `${params.agent} completed without a text summary.`}\n\nRuntime completion guidance: ${JSON.stringify(guidance)}` }],
            details: { agent: params.agent, personaPath, runId: inferredRunId, childSessionDir, committedEvent, ...guidance },
          };
        } catch (error) {
          await lifecycleWrites;
          if (inferredRunId) await updateRunState(workspaceDir, inferredRunId, `${params.agent}_interrupted`);
          await emitLifecycle({
            type: "agent_interrupted",
            error: error instanceof Error ? error.message : String(error),
            status: signal?.aborted ? "interrupted" : "error",
            metrics: { durationMs: Date.now() - agentStartedAt, tools: Object.fromEntries(toolMetrics), modelTurns },
          });
          throw error;
        } finally {
          stopModelTimer();
          restoreTurnStop();
          for (const timer of toolProgressTimers.values()) clearInterval(timer);
          toolProgressTimers.clear();
          toolProgressDetails.clear();
          if (activeSpecialistInvocation?.id === invocationId) activeSpecialistInvocation = undefined;
          signal?.removeEventListener("abort", abort);
          unsubscribe();
          const cleanupStartedAt = performance.now();
          session.dispose();
          if (childSessionFile) {
            await compactVisualSession(childSessionFile).catch((error) => {
              onUpdate?.({
                content: [{ type: "text", text: `${params.agent} session compaction warning: ${error instanceof Error ? error.message : String(error)}` }],
                details: { agent: params.agent, visualSessionCompaction: "failed" },
              });
            });
          }
          await emitLifecycle({ type: "agent_cleanup_metrics", durationMs: Math.round(performance.now() - cleanupStartedAt) }).catch(() => undefined);
        }
      },
    });

    // Compatibility bridge for the existing DreamaticArt Skill contracts. Pi
    // already discovers Skills natively; these tools remain until each Skill
    // has been reviewed and migrated without losing its executable contract.
    const availableProfessionals: Record<string, string[]> = {};
    let lastSkillReceipt: string | undefined;
    const persistSkillReceipt = async () => {
      if (!assignedRunId || !options.parentInvocation) return;
      const path = resolveInside(workspaceDir, join("runs", assignedRunId, ".performance", `skills-${options.parentInvocation.agent}.json`));
      await serializeJsonWrite(path, async () => {
        const source = JSON.stringify({ runId: assignedRunId, agent: options.parentInvocation!.agent, invocationId: options.parentInvocation!.id, availableProfessionals, activeSkills: skillActivation.all() });
        if (source === lastSkillReceipt) return;
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, source); await rename(temporary, path);
        lastSkillReceipt = source;
      });
    };
    const classifiedScopes = async () => assignedRunId
      ? briefDesignScopes(await readJsonRecord(resolveInside(workspaceDir, join("runs", assignedRunId)), "brief.json").catch(() => ({})))
      : [];
    const scopeForSkill = async (scope: string | undefined) => {
      const scopes = await classifiedScopes();
      return { scopes, scope: scope?.trim() || "project" };
    };
    pi.registerTool({
      name: "list_skills",
      label: "List design skills",
      description: "Discover Pi Skills by assigned design scope/category. Designer chooses and loads professional knowledge; discovery never activates it. Refresh only after catalog changes.",
      parameters: Type.Object({ query: Type.Optional(Type.String({ description: "Search Skill names, descriptions and domain types" })), refresh: Type.Optional(Type.Boolean()), scopeId: Type.Optional(Type.String({ description: "Exact Orchestrator-assigned designScopes[].id, not a Skill name or category. Omit to discover all assigned scopes." })), category: Type.Optional(Type.String({ description: "Filter by category registry id, e.g. ux, industrial or media_communication; never a Skill name." })) }),
      async execute(_id, params, _signal, _update, context) {
        if (params.category && !isDesignCategory(params.category)) throw new Error(`Unknown design category: ${params.category}`);
        const assignment = await scopeForSkill(params.scopeId);
        const scopes = assignment.scopes;
        let scope = assignment.scope;
        if (params.refresh || skillDescriptorCwd !== context.cwd) skillDescriptors = undefined;
        skillDescriptorCwd = context.cwd;
        skillDescriptors ??= discoverSkills(context.cwd, params.refresh).then((catalog) => Promise.all(catalog.map(async (skill) => {
          const frontmatter = await readFile(skill.filePath, "utf8").then((content) => parseFrontmatter<{ metadata?: unknown }>(content).frontmatter).catch(() => undefined);
          return { name: skill.name, description: skill.description, path: skill.filePath, ...skillMetadata(frontmatter?.metadata) };
        }))).catch((error) => { skillDescriptors = undefined; throw error; });
        const skills = await skillDescriptors;
        const audience = options.parentInvocation?.agent;
        let scopeResolution: Record<string, unknown> | undefined;
        if (params.scopeId && audience === "designer" && scopes.length && !scopes.some((item) => item.id === scope)) {
          const hint = skills.find((skill) => skill.name === scope && (skill.audience === "designer" || skill.audience === "unspecified"));
          const candidates = scopes.filter((item) => hint ? hint.designCategories.includes(item.category) : item.category === scope);
          const canonical = candidates.length === 1 ? candidates[0] : undefined;
          scopeResolution = { requestedScopeId: scope, status: canonical ? "resolved_unique_hint" : "unresolved", scopeId: canonical?.id ?? null, suggestedScopes: candidates.length ? candidates : scopes,
            instruction: canonical ? `Use scopeId=${canonical.id} for subsequent discovery/loading and scope_id=${canonical.id} in the plan. ${params.scopeId} is a Skill name or category, not the assigned id. Discovery resolved only this unique assignment; no Skill was activated.` : "No unique assignment can be inferred. Choose the exact designScopes[].id for the intended task. Do not invent a scope or bind a Skill to every same-category task." };
          scope = canonical?.id ?? "project";
        }
        const requestedCategory = (params.scopeId && (!scopeResolution || scopeResolution.status === "resolved_unique_hint") ? scopes.find((item) => item.id === scope)?.category : undefined) ?? params.category;
        const category = isDesignCategory(requestedCategory) ? requestedCategory : undefined;
        if (params.category && category !== params.category) throw new Error("Skill discovery category must match the assigned scope");
        if (audience === "designer" && scopes.length) {
          for (const assignment of scopes) availableProfessionals[assignment.id] = skills.filter((skill) => (skill.audience === "designer" || skill.audience === "unspecified") && skill.moduleType === "discipline" && skill.designCategories.includes(assignment.category)).map((skill) => skill.name);
          await persistSkillReceipt();
        }
        const selected = skills.filter((skill) => (!audience || skill.audience === "unspecified" || skill.audience === audience)
          && (!category || skillMatchesCategory(skill, category))
          && (!params.query || `${skill.name} ${skill.description} ${skill.domainType}`.toLowerCase().includes(params.query.toLowerCase())));
        const bindings = skillActivation.all();
        return textResult({ ok: true, scopeId: params.scopeId && (!scopeResolution || scopeResolution.status === "resolved_unique_hint") ? scope : null, category: category ?? null, ...(scopeResolution ? { scopeResolution } : {}), scopeProtocol: designScopeSkillProtocol(scopes), count: selected.length, skills: selected.map((skill) => ({ ...skill, primaryEligible: skill.moduleType === "discipline" && (!category || skill.designCategories.includes(category)), applicableScopes: scopes.filter((item) => skillMatchesCategory(skill, item.category)).map((item) => ({ scopeId: item.id, category: item.category, task: item.task, primaryEligible: skill.moduleType === "discipline" && skill.designCategories.includes(item.category), load: { tool: "use_skill", arguments: { name: skill.name, scopeId: item.id, role: skill.moduleType === "discipline" && skill.designCategories.includes(item.category) ? "primary" : "supporting" } } })) })), designScopes: scopes, categories: DESIGN_CATEGORIES, capabilities: DESIGN_CAPABILITIES,
          activeSkills: bindings.filter((binding) => binding.scope === scope).map(({ name, role }) => ({ name, role })), skillBindings: bindings,
          source: "pi-resource-loader", instruction: "Orchestrator owns categories. Designer selects appropriate discipline Skills for each scope and supporting modules with clear contributions; candidate discovery is not loading. New invocations must load required bodies. Cross-category supporting knowledge may be found through an unfiltered query." });
      },
    });

    pi.registerTool({
      name: "use_skill",
      label: "Load design skill",
      description: "Load exactly ONE named Pi Skill. Every bindings entry applies this SAME Skill to another assigned scope; bindings is not a batch of different Skills. Use separate calls for different Skill names. Bind shared knowledge atomically via bindings:[{scopeId,role,rationale}]. Single-scope arguments remain supported. All bindings validate before selection changes.  A primary replaces only that scope's primary. Deactivate obsolete support explicitly. Unchanged bodies are reused within this invocation; reload restores compacted knowledge.",
      parameters: Type.Object({ rationale: Type.Optional(Type.String({ minLength: 1, description: "Task-specific reason for this Scope–Skill selection; runtime records it in draft skill_selection" })),
        bindings: Type.Optional(Type.Array(Type.Object({ scopeId: Type.String({ minLength: 1 }), role: Type.Optional(Type.Union([Type.Literal("primary"), Type.Literal("supporting")])), rationale: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }), { minItems: 1 })),
        name: Type.String({ description: "One exact catalog Skill name. This same name applies to EVERY binding; do not put other Skills in the bindings rationale." }), arguments: Type.Optional(Type.String()),
        role: Type.Optional(Type.Union([Type.Literal("primary"), Type.Literal("supporting")])),
        deactivate: Type.Optional(Type.Array(Type.String())), reload: Type.Optional(Type.Boolean()),
        scopeId: Type.Optional(Type.String({ description: "Orchestrator-assigned design scope id" })),
        scope: Type.Optional(Type.String({ description: "Compatibility alias of scopeId" })),
      }),
      async execute(_id, params, _signal, _update, context) {
        if (params.scopeId && params.scope && params.scopeId !== params.scope) throw new Error("scopeId and scope must agree");
        if (params.bindings) {
          if (params.deactivate) throw new Error("For deactivation use a single-scope call; no selection changed");
          if ((params.scopeId || params.scope) && !params.bindings.some(binding => binding.scopeId === (params.scopeId ?? params.scope))) throw new Error("Single scope disagrees with bindings; no selection changed");
          if (params.role && params.bindings.some(binding => binding.role && binding.role !== params.role)) throw new Error("Single role disagrees with bindings; no selection changed");
          params.bindings = params.bindings.map(binding => ({ ...binding, role: binding.role ?? params.role ?? "supporting", ...((binding.rationale ?? params.rationale) !== undefined ? { rationale: binding.rationale ?? params.rationale! } : {}) }));
        }
        if (params.bindings && new Set(params.bindings.map(item => item.scopeId)).size !== params.bindings.length) throw new Error("bindings requires unique assigned scope ids for the SAME named Skill; no selection changed. Use a separate use_skill call for each different name. Do not combine different Skills in rationale or duplicate scope ids");
        const { scopes, scope } = await scopeForSkill(params.bindings?.[0]?.scopeId ?? params.scopeId ?? params.scope);
        if (scopes.length && options.parentInvocation?.agent === "designer" && !params.bindings && !(params.scopeId ?? params.scope)?.trim()) throw new Error(`Provide an assigned scopeId when loading Designer Skills for a classified Run. Valid task ids: ${scopes.map((item) => item.id).join(", ")}; name is the Skill name.`);
        if (scopes.length && options.parentInvocation?.agent === "designer" && !scopes.some((item) => item.id === scope)) return textResult({ ok: false, error: "unknown_design_scope", requestedScopeId: scope, designScopes: scopes, scopeProtocol: designScopeSkillProtocol(scopes), instruction: "No Skill was loaded or switched. scopeId must be an exact Orchestrator-assigned task id; name is the Skill name. Call list_skills without scopeId to obtain valid per-scope load arguments, then choose the intended task." });
        let catalog = await discoverSkills(context.cwd);
        let skill = catalog.find((candidate) => candidate.name === params.name);
        if (!skill) { skillDescriptors = undefined; catalog = await discoverSkills(context.cwd, true); skill = catalog.find((candidate) => candidate.name === params.name); }
        if (!skill) return textResult({ ok: false, name: params.name, availableSkills: catalog.map((candidate) => candidate.name), instruction: "This Skill is unavailable. Select another discovered module or continue from professional judgment and record a knowledge gap; do not retry the unchanged name or block an unclassified design/presentation workflow." });
        let content: string;
        try { content = await readFile(skill.filePath, "utf8"); }
        catch (error) { skillCatalogs.delete(context.cwd); skillDescriptors = undefined; return textResult({ ok: false, name: params.name, error: error instanceof Error ? error.message : String(error), instruction: "Skill unavailable; retain the current selection and select another applicable module." }); }
        const metadata = skillMetadata(parseFrontmatter<{ metadata?: unknown }>(content).frontmatter.metadata);
        if (options.parentInvocation && metadata.audience !== "unspecified" && metadata.audience !== options.parentInvocation.agent) return textResult({ ok: false, name: params.name, instruction: `This Skill is for ${metadata.audience}, not ${options.parentInvocation.agent}. Select role-appropriate guidance; do not change the assigned design or retry this name.` });
        const requested = params.bindings ?? [{ scopeId: scope, role: params.role, rationale: params.rationale }];
        for (const binding of requested) {
          if (scopes.length && options.parentInvocation?.agent === "designer" && !scopes.some(item => item.id === binding.scopeId)) throw new Error(`Unknown assigned scope ${binding.scopeId}; no selection changed`);
          const category = scopes.find(item => item.id === binding.scopeId)?.category;
          if (binding.role === "primary" && category && (metadata.moduleType !== "discipline" || !metadata.designCategories.includes(category))) throw new Error(JSON.stringify({ ok: false, code: "skill_scope_mismatch", name: skill.name, scopeId: binding.scopeId, category, selectionChanged: false,
            eligiblePrimaryScopes: scopes.filter(item => metadata.moduleType === "discipline" && metadata.designCategories.includes(item.category)).map(item => item.id),
            suggestedCalls: (await Promise.all(catalog.map(async candidate => ({ name: candidate.name, ...skillMetadata(parseFrontmatter<{ metadata?: unknown }>(await readFile(candidate.filePath, "utf8")).frontmatter.metadata) })))).filter(candidate => candidate.moduleType === "discipline" && candidate.designCategories.includes(category)).map(candidate => ({ name: candidate.name, scopeId: binding.scopeId, role: "primary" })),
            instruction: `Primary Skill ${skill.name} does not cover ${category}. Each call loads ONE name, and all its bindings apply that same name. Load a matching primary for this scope in a separate call; preserve other scopes. No selection changed.` }));
        }
        const category = scopes.find((item) => item.id === scope)?.category;
        if (params.role === "primary" && category && (metadata.moduleType !== "discipline" || !metadata.designCategories.includes(category))) throw new Error(`Primary Skill ${skill.name} does not cover ${category}; select matching professional knowledge. Auxiliary Skills belong in supporting.`);
        const hash = createHash("sha256").update(content).digest("hex");
        const selection = await serializeJsonWrite(`${workspaceDir}/skill-activation/${options.parentInvocation?.id ?? "root"}`, async () => {
          const rollback = skillActivation.checkpoint();
          const selections = requested.map((binding, index) => skillActivation.activate(skill.name, skill.filePath, hash, metadata, binding.scopeId, binding.role, params.deactivate, index === 0 && params.reload, binding.rationale));
          try { await persistSkillReceipt(); } catch (error) { rollback(); throw error; }
          return { ...selections[0]!, bindings: selections, reused: selections.every(item => item.reused) };
        });
        const retainedPlan = assignedRunId && options.parentInvocation?.agent === "designer" ? await readJsonRecord(resolveInside(workspaceDir, join("runs", assignedRunId)), "plan/design_plan.json").catch(() => undefined) : undefined;
        const pendingSkillLoads = skillReloadChecklist(retainedPlan, scopes.map((scope) => scope.id), skillActivation.all()).filter((item) => !item.loaded);
        const instruction = `Only the active selection applies to this task. Deactivation changes applicability, not historical context. User intent and the Agent contract override Skills. ${options.parentInvocation?.agent === "builder" ? "Apply this guidance to implementation and Gallery only; do not modify Designer-owned Context or page sources." : "For draft authoring, provide rationale here once; runtime generates skill_selection from active scope bindings. "} Persisted choices are not loaded knowledge; reload after compaction when needed.`;
        return { content: [{ type: "text", text: `${JSON.stringify({ ...selection, scopeId: scope, category, registeredSelections: skillActivation.all().map(({name, role, scope, rationale}) => ({name, role, scope_id: scope, rationale})), pendingSkillLoads, instruction })}\nLoaded Skill: ${skill.name}\nBase directory: ${skill.baseDir}\n${params.arguments ? `Arguments: ${params.arguments}\n` : ""}${selection.reused ? "Unchanged Skill body already loaded in this invocation; reuse its earlier content." : content}` }], details: { name: skill.name, path: skill.filePath, sha256: hash, ...metadata, ...selection, scopeId: scope, pendingSkillLoads, instruction, source: "pi-resource-loader" } };
      },
    });

    pi.registerTool({
      name: "todo_write",
      label: "Update design plan",
      description: "Maintain the visible stage plan required by existing DreamaticArt workflow contracts.",
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
      description: "Initialize a persistent DreamaticArt workflow run, brief, directories, and coordination bus. Orchestrator must first classify the requested design work and supply designScopes (or resolvedScope.designScopes). Designer selects Skills later; task ids are not Skill names.",
      parameters: Type.Object({
        brief: Type.String({ description: "Resolved design brief, which may summarize confirmed requirements. This is not the verbatim original user request; the runtime preserves that separately from user input." }),
        projectTitle: Type.String({
          minLength: 2,
          maxLength: 48,
          description: "A concise, distinctive human-facing name created for this project. Name the design concept; do not copy the user's full request or use generic labels such as Untitled design.",
        }),
        workflowSkill: Type.Optional(Type.String()),
        workflowProfile: Type.Optional(Type.Union([Type.Literal("compact"), Type.Literal("full")])),
        context: Type.Optional(Type.String()),
        resolvedScope: Type.Optional(Type.String()),
        designScopes: Type.Optional(Type.Array(Type.Object({ id: Type.String(), category: Type.String({ description: "media_communication, industrial, ux, space, fashion, game or service; classify by user intent, not Skill availability" }), task: Type.String(), rationale: Type.Optional(Type.String()) }), { minItems: 1 })),
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
        const scopedBrief = namedScope as Record<string, unknown>;
        const scopes = designScopes(params.designScopes ?? scopedBrief.designScopes);
        if (!scopes.length) throw new Error(`New design Runs require Orchestrator-assigned designScopes before initialization. Classify the user's requested work and provide [{id, category, task, rationale}]. Categories: ${DESIGN_CATEGORIES.map((item) => item.id).join(", ")}. Task ids are not Skill names; Designer selects Skills later. Resume existing unclassified historical Runs without reinitializing them.`);
        if (params.designScopes && scopedBrief.designScopes && JSON.stringify(scopes) !== JSON.stringify(designScopes(scopedBrief.designScopes))) throw new Error("designScopes and resolvedScope.designScopes must agree");
        if (scopes.length) scopedBrief.designScopes = scopes;
        for (const directory of [
          "research/assets",
          "plan",
          "artifacts/generated-images",
          "artifacts/edits",
          "review",
          "final",
        ]) await mkdir(join(runDir, directory), { recursive: true });
        const workflowProfile = params.workflowProfile ?? "compact";
        const originalRequest = typeof existingBrief.originalRequest === "string" && existingBrief.originalRequest.trim()
          ? existingBrief.originalRequest
          : existingBrief.titleStatus === "temporary" && typeof existingBrief.brief === "string" && existingBrief.brief.trim()
          ? existingBrief.brief
          : requestAssignedRunId === undefined || requestAssignedRunId === runId ? firstUserRequest : undefined;
        const originalRequestSource = typeof existingBrief.originalRequest === "string" && existingBrief.originalRequest.trim()
          ? existingBrief.originalRequestSource ?? "persisted_user_input"
          : existingBrief.titleStatus === "temporary" && typeof existingBrief.brief === "string" && existingBrief.brief.trim()
          ? "legacy_draft_user_input"
          : originalRequest ? "pi_user_prompt" : "unavailable";
        const brief = {
          contextFormat: "unified-v1",
          designContractVersion: 2,
          runId,
          createdAt: typeof existingBrief.createdAt === "string" ? existingBrief.createdAt : new Date().toISOString(),
          ...(typeof existingBrief.sessionId === "string" ? { sessionId: existingBrief.sessionId } : {}),
          title: projectTitle,
          titleStatus: "canonical",
          brief: params.brief,
          originalRequest: originalRequest ?? null,
          originalRequestSource,
          workflowSkill: params.workflowSkill ?? "",
          workflowProfile,
          budgets: WORKFLOW_BUDGETS[workflowProfile],
          context,
          resolvedScope: namedScope,
          domainContext,
        };
        await writeFile(join(runDir, "brief.json"), JSON.stringify(brief, null, 2), "utf8");
        await syncProjectContext(runDir, brief);
        await recordUserMaterialSources(runDir, userMaterialPrompts.length ? userMaterialPrompts : originalRequest ? [originalRequest] : []);
        if (originalRequestSource === "pi_user_prompt") requestAssignedRunId = runId;
        await writeFile(join(runDir, "bus.jsonl"), "", { encoding: "utf8", flag: "a" });
        await updateRunState(workspaceDir, runId, "initialized");
        await updateDesignContextIndex(workspaceDir, runId, "initialized");
        await appendWorkflowLifecycleEvent(workspaceDir, runId, { id: randomUUID(), type: "design_categories_identified", from_agent: "orchestrator", designScopes: scopes, ...designClassificationMessage(scopes) });
        return textResult({
          ok: true,
          runId,
          projectTitle,
          runDir,
          designScopes: scopes,
          scopeProtocol: designScopeSkillProtocol(scopes),
          contextFormat: "unified-v1",
          contextFiles: CONTEXT_FILES,
          authoringContract: unifiedContextInstruction("orchestrator"),
          ...(coordinator ? {readArguments:{runId,audience:"orchestrator"},finalDir:join(runDir,"final")} : {
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
          }),
        });
      },
    });

    pi.registerTool({
      name: "design_bus_post",
      label: "Post workflow event",
      description: "Validate and publish a workflow result. Specialists report completion to Orchestrator: omit from/from_agent/to and let runtime bind identity and recipient, or use from_agent=<your role>, to=orchestrator. Designer's next stage is Reviewer, represented by requestedAction=review and runtime nextAgent, never by to=reviewer. Pass runId, type and summary at the root. artifactRefs is optional; runtime attaches validated canonical outputs. No event is published on validation failure.",
      parameters: Type.Object({
        runId: Type.String(),
        type: Type.String(),
        phase: Type.Optional(Type.String()),
        from: Type.Optional(Type.String()),
        to: Type.Optional(options.parentInvocation ? Type.Literal("orchestrator", { description: "Completion recipient; omit to use the bound Orchestrator. This is not the next stage." }) : Type.String()),
        from_agent: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        severity: Type.Optional(Type.String()),
        round: Type.Optional(Type.Number()),
        artifactRefs: Type.Optional(Type.Array(Type.String({ description: "Additional existing assigned-Run files. Runtime automatically attaches validated canonical stage outputs; omit rather than invent paths." }))),
        requestedAction: Type.Optional(Type.String()),
        payload: Type.Optional(Type.Union([Type.String(), Type.Record(Type.String(), Type.Unknown())])),
        replyTo: Type.Optional(Type.String()),
        runDir: Type.Optional(Type.String()),
      }),
      prepareArguments: (args) => normalizeDesignBusArguments(args, options.parentInvocation?.runId ?? options.projectId, options.parentInvocation?.agent),
      async execute(_id, params, signal) {
        const runId = safeRunId(params.runId);
        if (options.parentInvocation) {
          if (!assignedRunId) throw new Error("Specialist completion requires a runtime-assigned Run. Ask Orchestrator to provide runId; do not invent or discover one.");
          assertAssignedRun(runId, `${options.parentInvocation.agent} completion`);
          const allowed = STAGE_COMPLETION_EVENTS[options.parentInvocation.agent] ?? [];
          if (!allowed.includes(params.type)) throw new Error(`${options.parentInvocation.agent} may only post ${allowed.join(" or ")}`);
          if (params.from_agent !== options.parentInvocation.agent) throw new Error(`from_agent must be ${options.parentInvocation.agent}`);
          if (params.to !== "orchestrator") throw new Error('Specialist completion events must be addressed to orchestrator. Omit to or set to:"orchestrator"; use requestedAction:"review" for Designer follow-up. No event was published.');
          if (!params.summary?.trim()) throw new Error("Specialist completion events require a summary");
          if (params.artifactRefs && params.artifactRefs.some((path) => typeof path !== "string" || !path.trim())) throw new Error("artifactRefs entries must be nonempty existing Run-relative file paths; omit artifactRefs to attach validated canonical outputs automatically.");
        }
        const runDir = resolveInside(workspaceDir, join("runs", runId));
        const state = await readJsonRecord(runDir, "run-state.json").catch(() => undefined);
        if (state?.status === "complete") throw new Error("Open an explicit user revision before posting to a completed Run");
        if (!options.parentInvocation && Object.values(STAGE_COMPLETION_EVENTS).flat().includes(params.type)) throw new Error("Only the responsible specialist can commit stage completion");
        await mkdir(runDir, { recursive: true });

        if (options.parentInvocation && params.artifactRefs) params.artifactRefs = params.artifactRefs.map((path) => {
          const prefix = `runs/${runId}/`;
          return path.startsWith(prefix) ? `${prefix}${canonicalRunDocument(path.slice(prefix.length))}` : canonicalRunDocument(path);
        });
        let requiredFiles: string[] = [];
        let executionReadiness: Record<string, unknown> | undefined;
        if (options.parentInvocation) {
          try {
            await normalizeStageOutputs(runDir, options.parentInvocation.agent);
            if (options.parentInvocation.agent === "designer") {
              if ((await classifiedScopes()).length) await persistSkillReceipt();
              await materializeDesignExecutionDocs(runDir);
            }
            if (options.parentInvocation.agent === "researcher") await writeResearchAcquisitionStatus(runDir, runId);
            executionReadiness = await validateStageOutputs(runDir, runId, options.parentInvocation.agent, params.type, signal);
            requiredFiles = await stageRequiredFiles(runDir, options.parentInvocation.agent);
            params.artifactRefs = await publicationReferences(runDir, runId, options.parentInvocation.agent, requiredFiles, params.artifactRefs ?? []);
          }
          catch (error) {
            signal?.throwIfAborted();
            if (options.parentInvocation.agent !== "designer") throw new Error(await hasUnifiedContext(runDir) ? canonicalContextError(error instanceof Error ? error.message : String(error)) : error instanceof Error ? error.message : String(error));
            const issue = await hasUnifiedContext(runDir) ? canonicalContextError(error instanceof Error ? error.message : String(error)) : error instanceof Error ? error.message : String(error);
            const fingerprint = await designerDraftFingerprint(runDir, skillActivation.all());
            const recoveryPath = join(runDir, ".performance/designer-recovery.json");
            const previous = await readFile(recoveryPath, "utf8").then(JSON.parse).catch(() => undefined);
            const readiness = await designerDraftReadiness(runDir);
            const issues = [...new Set([...(error instanceof DeliveryBlocked ? error.issues : [issue]), ...readiness.issues].flatMap((message) => message.split("\n")).filter(Boolean))];
            const { attempts, failureAttempts } = designerFailureAttempts(previous, issues);
            const repairOwner = error instanceof DeliveryBlocked ? error.repairOwner : "designer";
            const recovery = { ok: false, blocked: repairOwner === "runtime" || attempts >= 3, retryable: false, repairOwner, fingerprint, attempts, issue: issues[0] ?? issue, issues, okDraft: readiness.ok,
              instruction: repairOwner === "runtime" ? "Restore the HTML validation browser runtime before retrying. Do not redesign sources or generate images to repair a browser runtime failure." : "Correct the specific draft fields/sources and load retained Skills before publishing. Changing summary, artifactRefs, path or runDir cannot repair specification validation. Three failures of an unresolved issue return control to Orchestrator; unrelated draft/envelope changes do not reset the count; re-dispatch only with an actual repair task, never a publish-only task." };
            await mkdir(dirname(recoveryPath), { recursive: true });
            await writeFile(recoveryPath, JSON.stringify({ ...recovery, failureAttempts }, null, 2));
            if (recovery.blocked) return { ...finishWorkflow(recovery), details: recovery };
            throw new Error(`${recovery.issue}\nDesigner recovery: ${JSON.stringify(recovery)}`);
          }
        }
        const commitReceipt = options.parentInvocation
          ? {
              schemaVersion: 1,
              ...(executionReadiness ? { executionReadiness } : {}),
              files: Object.fromEntries(await Promise.all([...new Set([...requiredFiles, ...(params.artifactRefs ?? []).map((path) => canonicalRunDocument(path.startsWith(`runs/${runId}/`) ? path.slice(`runs/${runId}/`.length) : path))])].map(async (path) => {
                const existing = await findRunDocument(runDir, path);
                if (!existing || !(await stat(existing.absolutePath)).size) throw new Error(`Cannot publish completion: required output is missing or empty: ${path}`);
                return [path, createHash("sha256").update(await readFile(existing.absolutePath)).digest("hex")];
              }))),
            }
          : undefined;
        const submittedRequestedAction = params.requestedAction;
        const nextAgent = options.parentInvocation?.agent === "designer" ? "reviewer" : undefined;
        if (nextAgent) params.requestedAction = "review";
        const event = { id: randomUUID(), ...params, runId, ...(nextAgent ? { nextAgent, ...(submittedRequestedAction && submittedRequestedAction !== "review" ? { submittedRequestedAction } : {}) } : {}), ...(commitReceipt ? { commitReceipt } : {}), at: new Date().toISOString() };
        await appendFile(join(runDir, "bus.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
        await updateRunState(workspaceDir, runId, params.type);
        await updateDesignContextIndex(workspaceDir, runId, params.type);
        return finishWorkflow({ ok: true, event }, Boolean(options.parentInvocation) && process.env.DREAMATIC_STOP_AFTER_COMMIT?.trim().toLowerCase() !== "false");
      },
    });

    pi.registerTool({
      name: "run_brief_update",
      label: "Update confirmed active-run requirements",
      description: "Orchestrator records explicit user clarifications or requirement changes during an initialized active Run. Preserve originalRequest. Invalidate previous design/review gates and route the delta to Designer, with Researcher first only if needed. Never use this for unconfirmed agent preferences. Completed Runs require run_revision.",
      parameters: Type.Object({
        runId: Type.String(),
        feedback: Type.String({ minLength: 1, description: "The confirmed user clarification/change, preserving their meaning." }),
        brief: Type.Optional(Type.String({ minLength: 1 })),
        context: Type.Optional(Type.String()),
        domainContext: Type.Optional(Type.String()),
        designScopes: Type.Optional(Type.Array(Type.Object({ id: Type.String(), category: Type.String(), task: Type.String(), rationale: Type.Optional(Type.String()) }), { minItems: 1 })),
      }),
      async execute(_id, params) {
        if (options.parentInvocation) throw new Error("Only Orchestrator may update confirmed requirements");
        assertAssignedRun(params.runId, "run_brief_update");
        if (currentSpecialistInvocation() || revisionOpening) throw new Error("Wait for the current workflow operation before updating requirements");
        const scopes = params.designScopes ? designScopes(params.designScopes) : undefined;
        if (!params.feedback.trim()) throw new Error("A confirmed user clarification is required");
        revisionOpening = true;
        try {
          const runId = safeRunId(params.runId);
          const runDir = resolveInside(workspaceDir, join("runs", runId));
          const state = await readJsonRecord(runDir, "run-state.json");
          if (state.status === "draft" || state.status === "complete" || (state.stages as Record<string, unknown> | undefined)?.build === "completed") throw new Error("Update only an initialized active Run before build_done; completed Runs require run_revision");
          const brief = await readJsonRecord(runDir, "brief.json");
          const at = new Date().toISOString();
          const change = { id: randomUUID(), feedback: params.feedback.trim(), at };
          const updated = { ...brief,
            ...(params.brief !== undefined ? { brief: params.brief } : {}),
            ...(params.context !== undefined ? { context: params.context } : {}),
            ...(params.domainContext !== undefined ? { domainContext: params.domainContext } : {}),
            ...(scopes ? { resolvedScope: { ...(brief.resolvedScope && typeof brief.resolvedScope === "object" ? brief.resolvedScope : {}), designScopes: scopes } } : {}),
            confirmedUpdates: [...(Array.isArray(brief.confirmedUpdates) ? brief.confirmedUpdates : []), change],
          };
          if (await hasUnifiedContext(runDir)) await syncProjectContext(runDir, updated);
          else await writeFile(join(runDir, "brief.json"), JSON.stringify(updated, null, 2));
          await appendFile(join(runDir, "bus.jsonl"), `${JSON.stringify({ ...change, runId, type: "run_brief_updated", from_agent: "orchestrator", to: "designer", summary: change.feedback })}\n`);
          await updateRunState(workspaceDir, runId, "run_brief_updated");
          await updateDesignContextIndex(workspaceDir, runId, "run_brief_updated");
          activeRunId = runId;
          return textResult({ ok: true, runId, confirmedUpdate: change, instruction: "Read the updated project Context. Preserve unchanged work; route this confirmed delta to Designer (Researcher first only if needed). A new Designer completion and Reviewer approval are required before Builder." });
        } finally { revisionOpening = false; }
      },
    });

    pi.registerTool({
      name: "run_revision",
      label: "Open user-requested revision",
      description: "Reopen this completed project only for explicit user feedback. Archive the previous delivery, preserve research and design context, invalidate old approval gates, and hand the change request to Designer.",
      parameters: Type.Object({
        runId: Type.String(),
        feedback: Type.String({ minLength: 1 }),
        preserve: Type.Optional(Type.Array(Type.String())),
        needsResearch: Type.Optional(Type.Boolean()),
        upgradeDesignContract: Type.Optional(Type.Boolean({ description: "Explicitly upgrade a historical completed Run to design contract v2 within this archived revision. Never changes the archived delivery or its receipts; Designer must reconcile the converted draft and obtain new approval." })),
        designScopes: Type.Optional(Type.Array(Type.Object({ id: Type.String(), category: Type.String(), task: Type.String(), rationale: Type.Optional(Type.String()) }), { minItems: 1 })),
      }),
      async execute(_id, params) {
        if (options.parentInvocation) throw new Error("Only Orchestrator can open a revision");
        if (currentSpecialistInvocation()) throw new Error("Wait for the running specialist before opening a revision");
        if (revisionOpening) throw new Error("A revision is already opening");
        const runId = safeRunId(params.runId);
        if (options.projectId && runId !== safeRunId(options.projectId)) throw new Error("Revision must belong to this conversation's project");
        if (!params.feedback.trim()) throw new Error("Explicit user feedback is required");
        const revisedScopes = params.designScopes ? designScopes(params.designScopes) : undefined;
        revisionOpening = true;
        try {
          const runDir = resolveInside(workspaceDir, join("runs", runId));
          const state = await readJsonRecord(runDir, "run-state.json");
          if (state.status !== "complete") throw new Error("run_revision requires a completed Run; do not overlap active workflows");
          if (params.upgradeDesignContract && !(await hasUnifiedContext(runDir))) throw new Error("Contract upgrade requires unified Context; no revision was opened");
          if (params.upgradeDesignContract) {
            const { schemaVersion: _s, runId: _r, revision: _v, ...domain } = await readJsonRecord(runDir, CONTEXT_FILES.design);
            upgradeDesignData(domain); // Validate conversion before archiving/moving any delivery.
          }
          const revisionId = randomUUID();
          const archive = resolveInside(runDir, join("history", revisionId));
          await mkdir(archive, { recursive: true });
          for (const name of ["brief.json", "run-state.json", "design-context.json", "bus.jsonl", "research", "plan", "review", "artifacts", "context"]) {
            const source = join(runDir, name);
            if (await stat(source).then(() => true).catch(() => false)) await cp(source, join(archive, name), { recursive: true });
          }
          const finalPath = join(runDir, "final");
          if (await stat(finalPath).then(() => true).catch(() => false)) await rename(finalPath, join(archive, "final"));
          const now = new Date().toISOString();
          const revisionRequest = { id: revisionId, feedback: params.feedback, preserve: params.preserve ?? [], needsResearch: params.needsResearch === true, baseSnapshot: relative(runDir, archive), requestedAt: now };
          const brief = await readJsonRecord(runDir, "brief.json");
          if (params.upgradeDesignContract && Number(brief.designContractVersion ?? 1) !== 2) {
            if (!(await hasUnifiedContext(runDir))) throw new Error("Contract upgrade requires unified Context; historical split-file Runs retain their original storage contract");
            const source = await readFile(join(runDir, CONTEXT_FILES.design), "utf8");
            const { schemaVersion: _schema, revision: _revision, runId: _run, ...domain } = JSON.parse(source);
            const data = upgradeDesignData(domain);
            const draftDirectory = join(runDir, ".performance");
            await mkdir(draftDirectory, { recursive: true });
            await writeContextFile(runDir, ".performance/context-draft-designer.json", JSON.stringify({ data, baseSha256: createHash("sha256").update(source).digest("hex") }));
            brief.designContractVersion = 2;
          }
          await writeFile(join(runDir, "brief.json"), JSON.stringify({ ...brief, ...(revisedScopes ? { resolvedScope: { ...(brief.resolvedScope && typeof brief.resolvedScope === "object" ? brief.resolvedScope : {}), designScopes: revisedScopes } } : {}), revisionRequest }, null, 2));
          if (await hasUnifiedContext(runDir)) await syncProjectContext(runDir, await readJsonRecord(runDir, "brief.json"));
          const index = await readJsonRecord(runDir, "design-context.json");
          await writeFile(join(runDir, "design-context.json"), JSON.stringify({ ...index, status: "designing", latestVerdict: null, revisionRequest, updatedAt: now, lastEvent: "run_revision_started" }, null, 2));
          await appendFile(join(runDir, "bus.jsonl"), `${JSON.stringify({ id: revisionId, runId, type: "run_revision_started", from_agent: "orchestrator", to: "designer", summary: params.feedback, revisionRequest, at: now })}\n`);
          await writeFile(join(runDir, "run-state.json"), JSON.stringify({ ...state, status: "active", lastEvent: "run_revision_started", updatedAt: now, stages: { research: params.needsResearch ? "pending" : "completed", design: "pending", review: "pending", build: "pending", export: "pending" } }, null, 2));
          for (const key of workflowUsage.keys()) if (key.startsWith(`${runId}:`)) workflowUsage.delete(key);
          for (const key of operationAttempts.keys()) if (key.startsWith(`${runId}:`)) operationAttempts.delete(key);
          for (const key of operationLastErrors.keys()) if (key.startsWith(`${runId}:`)) operationLastErrors.delete(key);
          activeRunId = runId;
          if (revisedScopes) await appendWorkflowLifecycleEvent(workspaceDir, runId, { id: randomUUID(), type: "design_categories_identified", from_agent: "orchestrator", designScopes: revisedScopes, ...designClassificationMessage(revisedScopes, true) });
          return textResult({ ok: true, runId, revisionRequest, instruction: "Preserve confirmed content and existing unchanged deliverables. Route the feedback delta to Designer (Researcher first only if needed), then obtain a new review before Builder. Previous approval and build events no longer authorize this revision." });
        } finally {
          revisionOpening = false;
        }
      },
    });

    const writeJsonToolUnlocked = defineTool({
      name: "write_json",
      label: "Write structured project data",
      description: "Atomically serialize permitted auxiliary Run JSON, or legacy split-file outputs. The envelope is {runId,path,data}; data is an object, not a serialized string. Never use this tool for canonical Context: use update_design_context({changes:{...named role fields}}), then commit_design_context({}). Runtime-owned manifests, state and indexes are protected. Legacy Designer manifests may derive a missing fixed presentation entry; mixed outputs require an explicit mode/entry.",
      parameters: Type.Object({
        runId: Type.String(),
        path: Type.String({ pattern: "^(?!context/).+", description: "Permitted auxiliary or legacy Run-relative JSON path. Canonical context/* files require update_design_context and commit_design_context, not write_json." }),
        data: Type.Record(Type.String(), Type.Unknown()),
      }),
      prepareArguments: (args) => normalizeWriteJsonArguments(args, options.parentInvocation?.runId ?? options.projectId, workspaceDir),
      async execute(_id, params, signal, _onUpdate, _context) {
        const runId = safeRunId(params.runId);
        assertAssignedRun(runId, "write_json");
        if (["design-context.json", "run-state.json"].includes(params.path)) {
          return textResult({ ok: false, writePerformed: false, runtimeManaged: true, instruction: "This file belongs to the runtime. Do not retry with write or edit. Persist only your role's canonical outputs and publish the completion event; the runtime updates the context index and Run state automatically." });
        }
        if (!/^(research|plan|review|artifacts|context)\/.+\.json$/.test(params.path) || params.path.split("/").includes("..")) {
          throw new Error("write_json requires a Run-relative JSON path under context, research, plan, review or artifacts; use context/research.json, context/design.json or context/review.json without a runs/<id>/ prefix");
        }
        const runDir = resolveInside(workspaceDir, join("runs", runId));
        const path = resolveInside(runDir, params.path);
        await assertRoleWrite(workspaceDir, runId, options.parentInvocation?.agent ?? "orchestrator", path);
        const data = requiredRecord(params.data, params.path);
        if (CONTEXT_OWNERS[params.path]) throw new Error("Unified Context uses update_design_context with named changes, then commit_design_context {}. Runtime manages versions.");

        const warnings: string[] = [], normalizedFields: Record<string, string> = {};
        if (options.parentInvocation?.agent === "designer") {
          data.runId ??= runId;
          if (["plan/design_plan.json", "plan/deliverable_manifest.json"].includes(params.path)) data.design_system_ref ??= "plan/design_system.json";
          if (params.path === "plan/design_plan.json") hoistDesignPlanSections(data);
          const entries = data.execution_plan ?? data.image_generation_plan ?? data.deliverables;
          if (Array.isArray(entries)) {
            for (const item of entries) {
              if (item && typeof item === "object" && !Array.isArray(item)) {
                const entry = item as Record<string, unknown>;
                if (params.path === "plan/deliverable_manifest.json") copyAlias(entry, "file", ["path", "output_file", "output_path", "outputPath", "artifact_path"]);
                copyAlias(entry, "size", ["resolution", "dimensions"]);
                normalizeImageSize(entry);
              }
            }
          }
        }
        if (options.parentInvocation?.agent === "designer" && params.path === "plan/deliverable_manifest.json") {
          const normalized = normalizeDraftPresentation(data);
          Object.assign(normalizedFields, normalized.normalizedFields);
          warnings.push(...normalized.issues);
        }
        const source = `${JSON.stringify(data, null, 2)}\n`;
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        await mkdir(dirname(path), { recursive: true });
        try {
          signal?.throwIfAborted();
          await writeFile(temporaryPath, source, "utf8");
          signal?.throwIfAborted();
          await rename(temporaryPath, path);
        } finally {
          await unlink(temporaryPath).catch(() => undefined);
        }
        if (params.path === "plan/design_plan.json") {
          if (data.schemaVersion !== 2 && !Array.isArray(data.image_generation_plan)) warnings.push("image_generation_plan must be an array at the file root, beside concept_evaluation, not inside it. Complete this checkpoint before publishing.");
          const references = await readJsonRecord(runDir, "research/assets/manifest.json").catch(() => undefined);
          warnings.push(...referenceReviewCoverage(references, data).warnings);
        }
        if (["plan/design_plan.json", "plan/deliverable_manifest.json"].includes(params.path)) {
          if (params.path === "plan/deliverable_manifest.json" && Array.isArray(data.deliverables)) {
            for (const item of data.deliverables) {
              if (!item || typeof item !== "object" || Array.isArray(item)) continue;
              const entry = item as Record<string, unknown>;
              if (typeof entry.file !== "string" || !entry.file.trim()) warnings.push(`Deliverable ${String(entry.id)} needs an explicit file: artifacts/....png; neither the runtime nor Builder will invent its output path. Correct the manifest before design_bus_post.`);
            }
          }
          const plan = await readJsonRecord(runDir, "plan/design_plan.json").catch(() => undefined);
          const manifest = await readJsonRecord(runDir, "plan/deliverable_manifest.json").catch(() => undefined);
          if (plan && manifest && (plan.schemaVersion === 2 || briefDesignScopes(await readJsonRecord(runDir, "brief.json").catch(() => ({}))).length)) {
            warnings.push(...(await designerDraftReadiness(runDir)).issues.map((issue) => `Delivery checkpoint: ${issue}`));
            try { await validateDesignScopes(runDir, plan, manifest); } catch (error) { warnings.push(`Skill/scope checkpoint: ${error instanceof Error ? error.message : String(error)}`); }
          }
          if (Array.isArray(plan?.image_generation_plan) && Array.isArray(manifest?.deliverables)) {
            const promptIds = new Set(plan.image_generation_plan.map((entry) => entry && typeof entry === "object" ? (entry as Record<string, unknown>).id : undefined));
            for (const entry of manifest.deliverables) {
              if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
              const deliverable = entry as Record<string, unknown>;
              if (["image_generate", "image_edit"].includes(String(deliverable.method)) && !promptIds.has(deliverable.id)) {
                warnings.push(`Deliverable ${String(deliverable.id)} has no image plan with the same id; available image ids: ${[...promptIds].filter(Boolean).join(", ") || "none"}. Align ids in both files before design_bus_post.`);
              }
            }
          }
        }
        return textResult({ ok: true, path: relative(workspaceDir, path), bytes: Buffer.byteLength(source), sha256: createHash("sha256").update(source).digest("hex"), ...(Object.keys(normalizedFields).length ? { normalizedFields } : {}), ...(warnings.length ? { warnings, instruction: "The file was saved. Correct the cross-file warnings before publishing completion; do not rewrite unrelated successful outputs." } : {}) });
      },
    });

    const writeJsonTool = defineTool({
      ...writeJsonToolUnlocked,
      async execute(id, input, signal, onUpdate, context) {
        const params = requiredRecord(input, "write_json arguments");
        const path = resolveInside(workspaceDir, join("runs", safeRunId(requiredString(params, "runId", "write_json")), requiredString(params, "path", "write_json")));
        return serializeJsonWrite(path, () => writeJsonToolUnlocked.execute(id, input, signal, onUpdate, context));
      },
    });
    pi.registerTool(writeJsonTool);
    const role = options.parentInvocation?.agent;
    const boundRunId = options.parentInvocation?.runId;
    const contractVersion = (() => {
      if (!boundRunId) return 1;
      try { return Number(JSON.parse(readFileSync(resolveInside(workspaceDir, join("runs", boundRunId, "brief.json")), "utf8")).designContractVersion ?? 1); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 1; throw error; }
    })();
    if (![1, 2].includes(contractVersion)) throw new Error(`Unsupported Run design contract version: ${contractVersion}`);
    const readBoundContextDraft = role && boundRunId && ["researcher", "designer", "reviewer"].includes(role)
      ? registerContextAuthoring(pi, { contractVersion, workspaceDir, role, boundRunId, skillActivation, classifiedScopes, availableProfessionals, persistSkillReceipt, assertRoleWrite, finishWorkflow })
      : undefined;

    const validationFailures = new ContextFailureTracker();
    if (role === "designer" && boundRunId) pi.registerTool({
      name: "design_context_validate", label: "Validate committed design",
      description: "Validate committed structural/Skill/output requirements and exact HTML sources before publication. Optional diagnostic: publication runs the same checks automatically. Do not call after every small update. Returns execution evidence separately from draft readiness. Does not commit or publish. Repair only the exact Context field/source; cache invalidates on changed bytes/contracts/runtime.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id, _params, signal) {
        const runDir = resolveInside(workspaceDir, join("runs", boundRunId));
        const diagnose = (result: Record<string, unknown> & {issues:string[]}) => {
          const attempts = validationFailures.record(JSON.stringify([...result.issues].sort()), _id);
          const blocked = attempts >= 3;
          const diagnosis = { ...result, attempts, blocked, repairOwner:"designer", instruction:blocked ? "Stop this invocation; the same unresolved diagnostic repeated three times. Return exact fields/sources to Orchestrator." : "Repair the exact named field/source. Do not regenerate the entire design or repeat commits of an unchanged invalid specification." };
          return { ...finishWorkflow(diagnosis, blocked), details:diagnosis };
        };
        const readiness = await designerDraftReadiness(runDir);
        if (!readiness.ok) return diagnose({ ok: false, structuralReadiness: "blocked", executionValidation: "not_run", issues: readiness.issues });
        try {
          const contract = deliveryContract(await readJsonRecord(runDir, "plan/design_plan.json"), await readJsonRecord(runDir, "plan/deliverable_manifest.json"));
          const validation = await assertHtmlSourcePreflight(runDir, contract, signal);
          validationFailures.clear();
          return textResult({ ok: true, structuralReadiness: "ready", executionValidation: validation });
        } catch (error) {
          signal?.throwIfAborted();
          return diagnose({ ok: false, structuralReadiness: "ready", executionValidation: "failed", issues: error instanceof DeliveryBlocked ? error.issues : [String(error)] });
        }
      },
    });

    pi.registerTool({
      name: "patch_json",
      label: "Patch structured project data",
      description: "Update changed JSON fields using JSON pointers; updates must be an actual array of {pointer,value} objects, never a JSON string. Canonical Context uses named update_design_context changes and commit_design_context {}; runtime manages versions. /array/- appends one item. Pass the exact 64-character sha256 from a prior context read/save. All normal role and schema validation applies; never rewrite unrelated completed content.",
      parameters: Type.Object({ runId: Type.String(), path: Type.String(), sha256: Type.String(), updates: Type.Array(Type.Object({ pointer: Type.String(), value: Type.Unknown() }), { minItems: 1 }) }),
      async execute(id, params, signal, onUpdate, context) {
        if (!Array.isArray(params.updates) || params.updates.some(update => !update || typeof update !== "object" || Array.isArray(update))) throw new Error('patch_json updates must be an actual array of {pointer,value} objects, never a JSON string. Canonical Context uses named update_design_context changes and commit_design_context {}.');
        if (CONTEXT_OWNERS[params.path]) throw new Error("Use update_design_context with named changes, then commit_design_context {} for canonical Context; omit paths and hashes.");
        assertAssignedRun(params.runId, "patch_json");
        const runDir = resolveInside(workspaceDir, join("runs", safeRunId(params.runId)));
        const path = resolveInside(runDir, params.path);
        return serializeJsonWrite(path, async () => {
          signal?.throwIfAborted();
          await assertRoleWrite(workspaceDir, params.runId, options.parentInvocation?.agent ?? "orchestrator", path);
          const source = await readFile(path, "utf8");
          const currentHash = createHash("sha256").update(source).digest("hex");
          if (currentHash !== params.sha256) throw new Error(`JSON changed since it was read; reload this file before patching. Use design_context_read with paths [\"${params.path}\"] and full:true to obtain the current content and sha256; never guess a hash. Current sha256: ${currentHash}`);
          const data = parseRunJson(source, params.path);
          for (const update of params.updates) {
            if (!update.pointer.startsWith("/") || /~(?![01])/u.test(update.pointer)) throw new Error("Use a non-root valid JSON pointer");
            const keys = update.pointer.slice(1).split("/").map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
            if (keys.some((key) => ["__proto__", "prototype", "constructor"].includes(key))) throw new Error("Unsafe JSON pointer");
            let target: Record<string, unknown> | unknown[] = requiredRecord(data, "JSON root");
            for (const key of keys.slice(0, -1)) {
              const child: unknown = Reflect.get(target, key);
              if (!child || typeof child !== "object") throw new Error(`Missing JSON parent: ${update.pointer}`);
              target = child as Record<string, unknown>;
            }
            const key = keys.at(-1)!;
            if (Array.isArray(target) && key === "-") { target.push(update.value); continue; }
            if (Array.isArray(target) && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= target.length)) throw new Error("Array patches must address an existing item");
            Reflect.set(target, key, update.value);
          }
          return writeJsonToolUnlocked.execute(id, { runId: params.runId, path: params.path, data }, signal, onUpdate, context);
        });
      },
    });

    const contextReadParameters = Type.Object({
        runId: Type.String(),
        audience: coordinator ? Type.Literal("orchestrator") : Type.Union([Type.Literal("orchestrator"), Type.Literal("researcher"), Type.Literal("designer"), Type.Literal("reviewer"), Type.Literal("builder")]),
        paths: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
        full: Type.Optional(Type.Boolean({ description: "Read complete selected JSON files only when omitted details are required." })),
        select: Type.Optional(Type.Object({
          section: Type.Union(["brief", "evidence", "findings", "usageConditions", "system", "strategy", "tasks", "deliverables", "presentation", "acceptanceNotes", "executionNotes", "assessment", "intentCoverage"].map(field => Type.Literal(field))),
          ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Select complete tasks/deliverables by stable id." })),
        }, { additionalProperties: false, description: "Read a complete canonical section from exactly one paths entry. Cannot combine with draft section/ids/canonical. Returned content is read-only." })),
        ...(["researcher", "designer", "reviewer"].includes(role ?? "") ? {
        canonical: Type.Optional(Type.Boolean({ description: "Read the complete canonical role Context and observe its version before intentionally resetting a retained draft." })),
        section: Type.Optional(Type.Union(Object.keys(roleContextSchema(role!, contractVersion).properties).map(field => Type.Literal(field)), { description: "A field of your own role's working draft. For another role's canonical content use paths and select instead." })),
        ...(role === "designer" ? { ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Stable ids within your working tasks or deliverables; requires section." })) } : {}),
        } : {}),
      }, { additionalProperties: false });
    pi.registerTool({
      name: "design_context_read",
      label: "Read compact Design Context",
      description: coordinator ? "Read authoritative project, research, design, review and workflow state. Use audience:orchestrator. Expand needed details with paths:[context/research.json] (or context/design.json or context/review.json), full:true, or select:{section,ids?} for a single canonical document. Follow returned readArguments/expansionReads. Reading does not author or approve content." : "Bound specialists may omit runId; runtime supplies only the assigned identity. Read a compact authoritative Context overview. Expand canonical detail with paths:[context/design.json], select:{section:tasks,ids:[task-id]}; select reads only that document and never a working draft. Use paths with full:true for a complete file. Top-level section/ids/canonical read only the bound author's own draft. Follow each overview file's readArguments/expansionReads for omitted detail.",
      parameters: contextReadParameters,
      prepareArguments: args => {
        const record = requiredRecord(args, "design_context_read arguments");
        return { ...record, ...(record.runId === undefined && boundRunId ? { runId: boundRunId } : {}) } as Static<typeof contextReadParameters>;
      },
      async execute(_id, params) {
        if (coordinator && params.audience !== "orchestrator") throw new Error("Orchestrator Context reads require audience:orchestrator.");
        assertAssignedRun(params.runId, "design_context_read");
        const draftParams = params as typeof params & { section?: string; ids?: string[]; canonical?: boolean };
        const runDir = resolveInside(workspaceDir, join("runs", safeRunId(params.runId)));
        const acquisition = await researchAcquisition(runDir);
        if (coordinator && !(await hasUnifiedContext(runDir))) throw new Error("This task requires canonical Context. Preserve the Run and request an explicit data migration before reading or dispatching.");
        if ((draftParams.section !== undefined || draftParams.ids !== undefined || draftParams.canonical !== undefined) && params.audience !== role) {
          const target = ({ research: CONTEXT_FILES.research, design: CONTEXT_FILES.design, review: CONTEXT_FILES.review } as Record<string, string>)[draftParams.section ?? ""];
          throw new Error(`Working Context section reads require your own bound role in a unified Run. For cross-role canonical reads, omit section/ids/canonical and use design_context_read ${JSON.stringify({runId: params.runId, audience: params.audience, ...(target ? {paths:[target]} : {}), full:true})}. Do not fall back to retired split files.`);
        }
        const common = ["brief.json", "design-context.json", ".performance/user-materials.json"];
        let byAudience: Record<string, readonly string[]> = {
          orchestrator: [...RUN_CONTEXT_SECTIONS.research, ...STAGE_REQUIRED_FILES.designer!, "review/design-review.json"],
          researcher: RUN_CONTEXT_SECTIONS.research.filter((path) => !path.endsWith("validation.json")),
          designer: [...RUN_CONTEXT_SECTIONS.research.filter((path) => !path.endsWith("validation.json")), "review/design-review.json", ...STAGE_REQUIRED_FILES.designer!],
          reviewer: [...RUN_CONTEXT_SECTIONS.research.filter((path) => !path.endsWith("validation.json")), "plan/design_system.json", "plan/design_plan.json", "plan/deliverable_manifest.json", "plan/acceptance_criteria.md", "plan/task_breakdown.md", "review/design-review.json"],
          builder: ["research/brand_lock.md", "plan/design_system.json", "plan/design_plan.json", "plan/deliverable_manifest.json", "plan/acceptance_criteria.md", "plan/task_breakdown.md", "review/design-review.json"],
        };
        const unified = await hasUnifiedContext(runDir);
        if (unified) {
          common.splice(0, common.length, CONTEXT_FILES.project, "design-context.json", ".performance/user-materials.json");
          byAudience = {
            orchestrator: [CONTEXT_FILES.research, CONTEXT_FILES.design, CONTEXT_FILES.review],
            researcher: [CONTEXT_FILES.research, "research/assets/manifest.json"],
            designer: [CONTEXT_FILES.research, CONTEXT_FILES.design, CONTEXT_FILES.review, "research/assets/manifest.json"],
            reviewer: [CONTEXT_FILES.research, CONTEXT_FILES.design, CONTEXT_FILES.review, "research/assets/manifest.json"],
            builder: [CONTEXT_FILES.research, CONTEXT_FILES.design, CONTEXT_FILES.review],
          };
        }
        if (params.select) {
          if (draftParams.section !== undefined || draftParams.ids !== undefined || draftParams.canonical !== undefined) throw new Error("Use canonical select or draft section/ids/canonical, not both.");
          if (!unified || params.paths?.length !== 1) throw new Error("Canonical select requires a unified Run and exactly one paths entry.");
          const path = params.paths[0]!;
          if (![...common, ...byAudience[params.audience]!].includes(path)) throw new Error(`Context path is not available to ${params.audience}: ${path}`);
          const owner = ({ [CONTEXT_FILES.research]: "researcher", [CONTEXT_FILES.design]: "designer", [CONTEXT_FILES.review]: "reviewer" } as Record<string, string>)[path];
          const allowed = owner ? Object.keys(roleContextSchema(owner).properties) : path === CONTEXT_FILES.project ? ["brief"] : [];
          if (!allowed.includes(params.select.section)) throw new Error(`Canonical section ${params.select.section} is not available in ${path}. Available sections: ${allowed.join(", ")}`);
          if (params.select.ids && !["tasks", "deliverables"].includes(params.select.section)) throw new Error("Canonical ids selects only tasks or deliverables.");
          const source = await readFile(resolveInside(runDir, path), "utf8");
          const document = requiredRecord(parseRunJson(source, path), path);
          const content = owner ? selectContextSection(owner, owner === "designer" && document.schemaVersion === 2 ? { ...document, tasks: designTasks(document) } : document, params.select.section, params.select.ids) : { brief: document.brief };
          return textResult({ ok: true, contextFormat: "unified-v1", runId: params.runId, audience: params.audience, researchAcquisition: acquisition,
            files: [{ path, sha256: createHash("sha256").update(source).digest("hex"), content: JSON.stringify(content), complete: true, truncated: false, omittedPointers: [], selection: params.select }],
            instruction: "Complete selected canonical content. No working draft was read or changed. Use your own role's draft read before authoring; do not treat this subset as a complete document." });
        }
        const briefForRead = await readJsonRecord(runDir, "brief.json").catch((): Record<string, unknown> => ({}));
        const designVersion = Number(briefForRead.designContractVersion ?? 1);
        const designScopeList = briefDesignScopes(briefForRead);
        if (draftParams.canonical && (draftParams.section !== undefined || draftParams.ids !== undefined)) throw new Error("canonical:true reads the complete role Context; omit section/ids before reset.");
        if (draftParams.section !== undefined || draftParams.ids !== undefined) {
          if (!draftParams.section) throw new Error("ids requires a Context section");
          if (params.paths) throw new Error("Use section/ids or paths, not both");
          if (!unified || !readBoundContextDraft || params.audience !== role) throw new Error("Working Context section reads require your own bound role in a unified Run");
          if (!Object.hasOwn(roleContextSchema(role!, contractVersion).properties, draftParams.section)) {
            const designFields = Object.keys(roleContextSchema("designer").properties);
            const target = designFields.includes(draftParams.section) ? CONTEXT_FILES.design : undefined;
            const repairRead = { runId: params.runId, audience: params.audience, ...(target ? { paths: [target], select: { section: draftParams.section, ...(draftParams.ids ? { ids: draftParams.ids } : {}) } } : { full: true }) };
            throw new Error(`Context section is not available to ${role}: ${draftParams.section}. This selector reads your own draft. For canonical input use design_context_read ${JSON.stringify(repairRead)}.`);
          }
          const draft = await readBoundContextDraft({ section: draftParams.section, canonical: draftParams.canonical === true, ...(draftParams.ids ? { ids: draftParams.ids } : {}) });
          return textResult({ ok: true, contextFormat: "unified-v1", runId: params.runId, audience: params.audience, researchAcquisition: acquisition,
            workingContext: { ...draft, section: draftParams.section, ...(draftParams.ids ? { ids: draftParams.ids } : {}), complete: true, omittedPointers: [] },
            instruction: "Complete selected working Context. Unselected fields remain unchanged; omitted fields in updates are retained. No files were written." });
        }
        const skillRecords = params.audience === "researcher" || !designScopeList.length ? [] : [".performance/skills-designer.json"];
        const sourcePaths = params.audience === "researcher" ? [] : await designSourceFiles(runDir).catch(() => []);
        const ownContextPath = unified && readBoundContextDraft && params.audience === role
          ? ({ researcher: CONTEXT_FILES.research, designer: CONTEXT_FILES.design, reviewer: CONTEXT_FILES.review } as Record<string, string>)[role!] : undefined;
        const files = [];
        const missingFiles: string[] = [];
        for (const path of params.paths ?? [...common, ...byAudience[params.audience]!.filter(path => params.audience !== "researcher" || params.full || path !== "research/assets/manifest.json"), ...skillRecords]) {
          if (!params.paths && path === ownContextPath) continue;
          if (![...common, ...byAudience[params.audience]!, ...skillRecords, ...sourcePaths].includes(path)) throw new Error(`Context path is not available to ${params.audience}: ${path}`);
          const existing = await findRunDocument(runDir, path);
          const source = await readFile(existing?.absolutePath ?? resolveInside(runDir, path), "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          if (source === undefined) { missingFiles.push(path); continue; }
          const limit = (path.endsWith("design_plan.json") || path === CONTEXT_FILES.design) ? 24_000 : 12_000;
          const isJson = path.endsWith(".json");
          const projected = isJson && !params.full ? projectContext(parseRunJson(source, path), limit) : undefined;
          const compactSource = isJson ? JSON.stringify(projected?.content ?? parseRunJson(source, path)) : source;
          files.push({
            path: existing?.path ?? path,
            ...(existing && existing.path !== path ? { canonicalPath: path } : {}),
            sha256: createHash("sha256").update(source).digest("hex"),
            lines: source.split(/\r?\n/u).length,
            truncated: projected ? projected.omittedPointers.length > 0 : !params.full && !isJson && compactSource.length > limit,
            ...(projected ? { omittedPointers: projected.omittedPointers } : {}),
            readArguments: { runId: params.runId, audience: params.audience, paths: [path], full: true },
            ...(unified && projected?.omittedPointers.length && Object.values(CONTEXT_FILES).includes(path as typeof CONTEXT_FILES[keyof typeof CONTEXT_FILES]) ? {
              expansionReads: [...new Set(projected.omittedPointers.map(pointer => pointer.split("/")[1]!))].map(section => ({ runId: params.runId, audience: params.audience, paths: [path], select: { section } })),
            } : {}),
            content: !params.full && !isJson && compactSource.length > limit ? `${compactSource.slice(0, limit)}\n[truncated; use read for a targeted detail]` : compactSource,
          });
        }
        const busSource = await readFile(resolveInside(runDir, "bus.jsonl"), "utf8").catch(() => "");
        const recentEvents = busSource.split(/\r?\n/).filter(Boolean).flatMap((line) => {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (/^(agent_|tool_|orchestrator_tool_|operation_|image_item_|image_request_)/.test(String(event.type))) return [];
            return [{ id: event.id, type: event.type, from_agent: event.from_agent, to: event.to, summary: event.summary, artifactRefs: event.artifactRefs, requestedAction: event.requestedAction, round: event.round, at: event.at }];
          } catch { return []; }
        });
        const cycleEvents = currentWorkflowCycle(recentEvents).slice(-10);
        const referenceManifest = await readJsonRecord(runDir, "research/assets/manifest.json").catch(() => undefined);
        const referenceInventory = Array.isArray(referenceManifest?.assets) ? referenceManifest.assets.map((item) => {
          const asset = item && typeof item === "object" ? item as Record<string, unknown> : {};
          const file = asset.file ?? asset.local_path ?? asset.path ?? asset.localPath;
          let viewPath: string | undefined;
          if (typeof file === "string" && file.trim()) {
            try {
              const candidate = isAbsolute(file) || file.startsWith("research/") ? file : file.startsWith(`runs/${safeRunId(params.runId)}/`) ? file.slice(`runs/${safeRunId(params.runId)}/`.length) : join("research/assets", file);
              viewPath = resolveInside(resolveInside(runDir, "research/assets"), resolveInside(runDir, candidate));
            } catch { viewPath = undefined; }
          }
          return { asset_id: asset.id, file, viewPath, visual_review_status: asset.visual_review_status ?? "unreviewed", relevance_status: asset.relevance_status ?? "uncertain", relevance_basis: asset.relevance_basis, likely_relevance: asset.likely_relevance ?? asset.description, instruction: viewPath ? params.audience === "designer" ? "Use view_image(paths) for adopted or meaningfully considered references; metadata is not visual evidence." : "Designer owns visual reference inspection; acquisition metadata is not visual evidence." : "Missing or invalid asset path; record the acquisition gap." };
        }) : [];
        const draft = unified && readBoundContextDraft && params.audience === role ? await readBoundContextDraft({ canonical: draftParams.canonical === true }) : undefined;
        const draftData = draft?.data as Record<string, unknown> | undefined;
        const canonicalPlan = await readJsonRecord(runDir, "plan/design_plan.json").catch(() => undefined);
        const guidancePlan = role === "designer" && draftData ? draftData.strategy as Record<string, unknown> | undefined : canonicalPlan;
        const guidanceSource = role === "designer" && draft ? draft.source : (unified ? "canonical" : "legacy");
        const referenceReview = { ...referenceReviewCoverage(referenceManifest, guidancePlan), source: guidanceSource };
        const skillLoading = params.audience === "designer" ? { source: guidanceSource, selectionChecklist: skillReloadChecklist(guidancePlan, designScopeList.map((scope) => scope.id), skillActivation.all()),
          instruction: "This checklist follows the current working selection and does not activate knowledge. Load retained primary and supporting Skills before commit; change selections through use_skill and update actual skill_refs." } : undefined;
        const workingContext = draft ? (() => { const projection = params.full || draftParams.canonical ? undefined : projectContext(draft.data, 8000); return { ...draft, data: projection?.content ?? draft.data, ...(projection ? { omittedPointers: projection.omittedPointers } : {}) }; })() : undefined;
        return textResult({ ok: true, ...(unified ? { contextFormat: "unified-v1", authoringContract: unifiedContextInstruction(params.audience, designVersion), ...(["researcher", "designer", "reviewer"].includes(params.audience) ? { authoringExample: contextChangesExample(params.audience) } : {}), ...(workingContext ? { workingContext } : {}), ...(params.audience === "designer" ? { associationContract: { assignedScopes: designScopeList, loadedSkills: skillActivation.all(), rule: designVersion === 2 ? "Deliverables own identity, scope, output and nested execution; tasks are derived read-only views. Declare production, user_requested and presentation access separately. Use execution.uses for deliverable references. " : "Tasks and deliverables share one stable id. New deliverables require kind,purpose,acceptance_test,required,file. Choose each deliverable's assigned scope_id and actually used skill_refs. Runtime derives category from that scope and task scope/category from the matching deliverable id; supplied conflicting values are rejected. contributing_scopes contains only additional scopes, excluding the primary; [] clears additional contributions. A unified design requires system, strategy, tasks, deliverables and presentation in the same saved document; runtime provides the section skeleton; supply actual content through named changes." } } : {}) } : { contextFormat: "legacy" }), runId: params.runId, audience: params.audience, researchAcquisition: acquisition, designScopes: designScopeList, scopeProtocol: designScopeSkillProtocol(designScopeList), ...(params.audience === "designer" ? { draftReadiness: { ...await designerDraftReadiness(runDir), source: unified ? "canonical" : "legacy", purpose: "Publication/execution checks on committed specifications and sources; working readiness is separate." }, outputContract: unified ? unifiedDesignSpecificationProtocol(imageSizeCeiling(), designVersion) : designSpecificationProtocol(imageSizeCeiling()) } : {}), ...(skillLoading ? { skillLoading } : {}), files, missingFiles, designSources: sourcePaths.map((path) => ({ path })), userMaterials: await userMaterialInventory(runDir), capabilities: DESIGN_CAPABILITIES, recentEvents: cycleEvents, referenceInventory, referenceReview,
          instruction: "files contains existing authoritative data; missingFiles is an inventory, not a tool failure. Do not read a missing file. On recovery, preserve valid existing outputs and create the missing outputs. For repairs to your working draft, use section and optional ids for complete affected objects. paths/full reads authoritative files; an overview may omit working fields. Preserve all deliverable and reference identities; an overview is not the complete specification." });
      },
    });

    pi.registerTool({
      name: "design_bus_read",
      label: "Read workflow events",
      description: "Read structured workflow events for a DreamaticArt design run.",
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
        assertAssignedRun(params.runId, "design_bus_read");
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
      description: "Load or reload local images for reference screening. Use path for one image or paths for a labelled batch; there is no stage-wide image-count quota. Inspect useful content rather than infer it from filenames.",
      parameters: Type.Object({ path: Type.Optional(Type.String()), paths: Type.Optional(Type.Array(Type.String(), { minItems: 1 })) }),
      prepareArguments: (args) => {
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("view_image arguments must be an object");
        const input = args as Record<string, unknown>;
        return { ...input, ...(Array.isArray(input.paths) ? { paths: input.paths.map((item) => item && typeof item === "object" && typeof item.path === "string" ? item.path : item) } : {}) } as { path?: string; paths?: string[] };
      },
      async execute(_id, params) {
        for (const path of [params.path, ...(params.paths ?? [])]) if (path) await assertAssignedRead(path, workspaceDir);
        if (params.paths) {
          if (params.path) throw new Error("Use either path or paths, not both");
          const content: Awaited<ReturnType<typeof imageBlock>>["block"][] = [];
          const results: Array<Record<string, unknown>> = [];
          for (const path of [...new Set(params.paths)]) {
            try {
              const image = await imageBlock(workspaceDir, path);
              results.push({ ok: true, path, label: `${content.length + 1}: ${basename(image.path)}`, bytes: image.bytes, preview: image.preview });
              content.push(image.block);
            } catch (error) {
              results.push({ ok: false, path, error: error instanceof Error ? error.message : String(error) });
            }
          }
          return { content: [jsonText({ ...batchSummary(results), instruction: "Image blocks follow successful results in label order. Record observed features and per-asset decisions before moving to the next batch; omitted historical image bytes can be reloaded." }), ...content], details: { results } as Record<string, unknown> };
        }
        if (!params.path) throw new Error("Provide path or a non-empty paths array");
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
      description: "Generate complete design artwork, including copy and typography specified in the prompt, and save it inside a DreamaticArt run. Include exact wording, language, hierarchy and placement when text is required.",
      parameters: Type.Object({
        runId: Type.String(),
        id: Type.String({ description: "Stable filename stem" }),
        intent: Type.String({ description: "What this visual must communicate or accomplish" }),
        prompt: Type.String(),
        acceptanceCriteria: Type.Array(Type.String(), { minItems: 1 }),
        preserve: Type.Optional(Type.Array(Type.String())),
        outputPath: Type.Optional(Type.String({ description: "PNG/JPG/JPEG Run-relative path under artifacts/. For planned Builder images, omit this field: the runtime uses the manifest file by id. An explicit path must match that file." })),
        size: Type.Optional(Type.String()),
      }),
      async execute(_id, params, signal, onUpdate) {
        const summary = await generateImage(params, signal, (notice) => onUpdate?.({
            content: [{ type: "text", text: `Image generation retry ${notice.nextAttempt}: ${notice.error}` }],
            details: { retry: notice },
          }), (progress) => onUpdate?.(imageRequestUpdate(progress)));
        return { content: [jsonText(summary)], details: summary };
      },
    });

    pi.registerTool({
      name: "image_generate_batch",
      label: "Generate image batch",
      description: "Generate independent approved images concurrently. Only specify anchorId when all other tasks genuinely depend on its successful generation; explicit anchors retain anchor-first compatibility.",
      parameters: Type.Object({
        runId: Type.String(),
        anchorId: Type.Optional(Type.String()),
        tasks: Type.Array(Type.Object({
          id: Type.String(),
          intent: Type.String(),
          prompt: Type.String(),
          acceptanceCriteria: Type.Array(Type.String(), { minItems: 1 }),
          preserve: Type.Optional(Type.Array(Type.String())),
          outputPath: Type.Optional(Type.String({ description: "For planned Builder images omit this field; the runtime uses the manifest file by id. Otherwise choose an artifacts/...png, jpg or jpeg path." })),
          size: Type.Optional(Type.String()),
        }), { minItems: 1 }),
      }),
      async execute(_id, params, signal, onUpdate) {
        const contract = await preflightBeforeImageTool(params.runId, signal);
        const tasks = params.tasks.map((task) => bindImageOutput({ runId: params.runId, ...task }, "image_generate", contract));
        if (new Set(tasks.map((task) => safeRunId(task.id))).size !== tasks.length) throw new Error("Image task ids must be unique");
        const outputs = tasks.map((task) => {
          assertImageSizeWithinCeiling(task.size ?? imageSizeCeiling(), `image_generate_batch.${task.id}.size`);
          return artifactOutputPath(workspaceDir, safeRunId(params.runId), safeRunId(task.id), "generated-images", task.outputPath);
        });
        if (new Set(outputs).size !== outputs.length) throw new Error("Image output paths must be unique");
        const anchorIndex = params.anchorId ? tasks.findIndex((task) => task.id === params.anchorId) : 0;
        if (anchorIndex < 0) throw new Error(`Unknown anchorId: ${params.anchorId}`);
        const anchor = tasks[anchorIndex]!;
        const notify = (notice: RetryNotice) => onUpdate?.({ content: [{ type: "text", text: `Image generation retry ${notice.nextAttempt}: ${notice.error}` }], details: { retry: notice } });
        await appendWorkflowLifecycleEvent(workspaceDir, params.runId, { type: "agent_progress", invocationId: options.parentInvocation?.id, agent: options.parentInvocation?.agent ?? "builder", toolCallId: _id, total: tasks.length, output: `Preparing ${tasks.length} design images`, status: "running" });
        let completed = 0;
        const generate = async (task: ImageGenerateTask): Promise<Record<string, unknown>> => {
          signal?.throwIfAborted();
          const itemStartedAt = performance.now();
          let result: Record<string, unknown>;
          try {
            result = await generateImage(task, signal, notify, (progress) => onUpdate?.(imageRequestUpdate(progress)), contract?.strict ? approvedImageTask(workspaceDir, params.runId, contract.tasks.find(entry => entry.id === task.id)!, contract.deliverables.find(item => item.id === task.id)!) : undefined);
          } catch (error) {
            signal?.throwIfAborted();
            result = { ok: false, id: task.id, error: error instanceof Error ? error.message : String(error) };
          }
          completed += 1;
          await appendWorkflowLifecycleEvent(workspaceDir, params.runId, { type: "image_item_finished", imageId: task.id, durationMs: Math.round(performance.now() - itemStartedAt), status: result.ok ? "completed" : "error", result });
          const output = `Image ${task.id}: ${result.ok ? "saved" : "failed"} · ${completed}/${tasks.length}`;
          onUpdate?.({ content: [{ type: "text", text: output }], details: { id: task.id, completed, total: tasks.length, result } });
          await appendWorkflowLifecycleEvent(workspaceDir, params.runId, {
            type: "agent_progress", invocationId: options.parentInvocation?.id, agent: options.parentInvocation?.agent ?? "builder", toolCallId: _id,
            output, status: "running", imageId: task.id, completed, total: tasks.length, result,
          });
          return result;
        };
        if (!params.anchorId) {
          const results = await mapWithConcurrency(tasks, imageConcurrency, generate, signal);
          const summary = { action: "image_generate_batch", count: results.length, ...batchSummary(results) };
          return { content: [jsonText(summary)], details: summary };
        }
        const anchorResult = await generate(anchor);
        const remaining = tasks.filter((_, index) => index !== anchorIndex);
        const results = anchorResult.ok === true
          ? [anchorResult, ...await mapWithConcurrency(remaining, imageConcurrency, generate, signal)]
          : [anchorResult, ...remaining.map((task) => ({ ok: false, id: task.id, skipped: true, error: `Skipped because consistency anchor ${anchor.id} failed` }))];
        const summary = { action: "image_generate_batch", anchorId: anchor.id, count: results.length, ...batchSummary(results) };
          return { content: [jsonText(summary)], details: summary };
      },
    });

    const imageEditTaskParameters = Type.Object({
      id: Type.String(),
      intent: Type.String({ description: "What the edited visual must accomplish" }),
      diagnosis: Type.Array(Type.String(), { minItems: 1 }),
      changes: Type.Array(Type.String(), { minItems: 1 }),
      preserve: Type.Array(Type.String(), { minItems: 1 }),
      prompt: Type.String(),
      referenceImagePaths: Type.Array(Type.String(), { minItems: 1 }),
      acceptanceCriteria: Type.Array(Type.String(), { minItems: 1 }),
      outputPath: Type.Optional(Type.String({ description: "PNG/JPG/JPEG Run-relative path under artifacts/. For planned Builder images, omit this field: the runtime uses the manifest file by id. An explicit path must match that file." })),
      size: Type.Optional(Type.String()),
    });
    const imageEditTool = defineTool({
      name: "image_edit",
      label: "Edit image",
      description: "Edit one or more reference images and save the result inside a DreamaticArt run. Can integrate or revise approved copy, typography, labels and other visual content. Include exact wording and preservation rules in the prompt; generative editing does not guarantee character-perfect or pixel-exact results.",
      parameters: Type.Object({ runId: Type.String(), ...imageEditTaskParameters.properties }),
      async execute(_id, params, signal, onUpdate) {
        const contract = await preflightBeforeImageTool(params.runId, signal);
        params = bindImageOutput(params, "image_edit", contract);
        approvedImageEdit(params);
        const approved = contract?.strict ? approvedImageTask(workspaceDir, params.runId, contract.tasks.find(task => task.id === params.id)!, contract.deliverables.find(item => item.id === params.id)!) : undefined;
        const fingerprint = approved ? await approvedImageFingerprint(approved) : undefined;
        return enqueueImageOperation(async () => {
        const size = params.size ?? imageSizeCeiling();
        assertImageSizeWithinCeiling(size, "image_edit.size");
        artifactOutputPath(workspaceDir, safeRunId(params.runId), safeRunId(params.id), "edits", params.outputPath);
        const apiKey = process.env.DREAMATIC_IMAGE_API_KEY?.trim() || process.env.DREAMATIC_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
        if (!apiKey) throw new Error("DREAMATIC_IMAGE_API_KEY, DREAMATIC_API_KEY, or OPENAI_API_KEY is not configured");
        const baseUrl = (process.env.DREAMATIC_IMAGE_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
        const endpoint = process.env.DREAMATIC_IMAGE_EDIT_ENDPOINT?.trim() || `${baseUrl}/images/edits`;
        const form = new FormData();
        const generationModel = { model: process.env.DREAMATIC_IMAGE_MODEL ?? "gpt-image-1", provider: new URL(endpoint).hostname, source: "request" };
        form.set("model", generationModel.model);
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
          onProgress: (progress) => onUpdate?.(imageRequestUpdate(progress)),
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
            generationModel,
            intent: params.intent,
            diagnosis: params.diagnosis,
            changes: params.changes,
            preserve: params.preserve,
            acceptanceCriteria: params.acceptanceCriteria,
          }, signal, (progress) => onUpdate?.(imageRequestUpdate(progress)),
        );
        if (approved && fingerprint) await recordApprovedImage(approved, fingerprint);
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
    pi.registerTool(imageEditTool);

    pi.registerTool({
      name: "image_edit_batch",
      label: "Edit image batch",
      description: "Execute independent approved image edits concurrently with bounded concurrency and per-item results. All reference files must already exist; shared-source siblings can run together, but source/edit chains require separate batches. Preserve successes and retry only failed required ids.",
      parameters: Type.Object({
        runId: Type.String(),
        tasks: Type.Array(imageEditTaskParameters, { minItems: 1 }),
      }),
      async execute(_id, params, signal, onUpdate, context) {
        const contract = await preflightBeforeImageTool(params.runId, signal);
        params = { ...params, tasks: params.tasks.map((task) => { approvedImageEdit(task); return bindImageOutput(task, "image_edit", contract); }) };
        if (new Set(params.tasks.map((task) => safeRunId(task.id))).size !== params.tasks.length) throw new Error("Image task ids must be unique");
        const outputPaths = new Set<string>();
        for (const task of params.tasks) {
          const output = artifactOutputPath(workspaceDir, safeRunId(params.runId), safeRunId(task.id), "edits", task.outputPath);
          if (outputPaths.has(output)) throw new Error("Image output paths must be unique");
          outputPaths.add(output);
        }
        for (const task of params.tasks) {
          for (const source of task.referenceImagePaths) {
            if (outputPaths.has(resolveInside(workspaceDir, source))) throw new Error("Batch edit sources must already exist outside this batch's outputs; execute dependent edits in a later batch");
          }
        }
        await appendWorkflowLifecycleEvent(workspaceDir, params.runId, { type: "agent_progress", invocationId: options.parentInvocation?.id, agent: options.parentInvocation?.agent ?? "builder", toolCallId: _id, total: params.tasks.length, output: `Preparing ${params.tasks.length} image edits`, status: "running" });
        let completed = 0;
        const results = await mapWithConcurrency(params.tasks, imageConcurrency, async (task) => {
          signal?.throwIfAborted();
          const itemStartedAt = performance.now();
          let result: Record<string, unknown>;
          try {
            const edited = await imageEditTool.execute(`${_id}:${task.id}`, { runId: params.runId, ...task }, signal, onUpdate, context);
            result = { ...(edited.details as Record<string, unknown>), id: task.id };
          } catch (error) {
            signal?.throwIfAborted();
            result = { ok: false, id: task.id, error: error instanceof Error ? error.message : String(error) };
          }
          completed += 1;
          await appendWorkflowLifecycleEvent(workspaceDir, params.runId, { type: "image_item_finished", imageId: task.id, durationMs: Math.round(performance.now() - itemStartedAt), status: result.ok ? "completed" : "error", result });
          const output = `Image ${task.id}: ${result.ok ? "saved" : "failed"} · ${completed}/${params.tasks.length}`;
          onUpdate?.({ content: [{ type: "text", text: output }], details: { id: task.id, completed, total: params.tasks.length, result } });
          await appendWorkflowLifecycleEvent(workspaceDir, params.runId, {
            type: "agent_progress", invocationId: options.parentInvocation?.id, agent: options.parentInvocation?.agent ?? "builder", toolCallId: _id,
            output, status: "running", imageId: task.id, completed, total: params.tasks.length, result,
          });
          return result;
        });
        const summary = { action: "image_edit_batch", count: results.length, ...batchSummary(results) };
          return { content: [jsonText(summary)], details: summary };
      },
    });

    const imagePlanTool = defineTool({
      name: "execute_image_plan",
      label: "Execute approved image plan",
      description: "Execute approved stored image tasks by id without restating prompts. Reuses outputs only when prompt, size and image hash match. Pass independent ids together; edit dependencies within this request are scheduled after their sources. No design decisions are invented.",
      parameters: Type.Object({ runId: Type.String(), ids: Type.Array(Type.String(), { minItems: 1 }), reuse: Type.Optional(Type.Boolean()) }),
      async execute(id, params, signal, onUpdate, context) {
        if (options.parentInvocation?.agent !== "builder") throw new Error("Only Builder may execute an approved plan");
        assertAssignedRun(params.runId, "execute_image_plan");
        const runDir = resolveInside(workspaceDir, join("runs", safeRunId(params.runId)));
        const bus = (await readFile(join(runDir, "bus.jsonl"), "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
        const gate = currentWorkflowCycle(bus).filter((event) => ["design_spec_ready", "design_revision_ready", "design_review_pass", "design_review_fail", "build_done"].includes(String(event.type))).at(-1);
        if (gate?.type !== "design_review_pass") throw new Error("A current approved specification is required");
        await assertStageCommitted(workspaceDir, params.runId, "reviewer", 0);
        await assertStageCommitted(workspaceDir, params.runId, "designer", 0, true);
        const plan = await readJsonRecord(runDir, "plan/design_plan.json");
        const manifest = await readJsonRecord(runDir, "plan/deliverable_manifest.json");
        const entries = imagePlan(plan);
        const deliverables = requiredArray(manifest, "deliverables", "manifest").map((item) => requiredRecord(item, "deliverable"));
        if (new Set(params.ids).size !== params.ids.length) throw new Error("Plan ids must be unique");
        const tasks = params.ids.map(taskId => {
          const entry = entries.find(item => item.id === taskId), deliverable = deliverables.find(item => item.id === taskId);
          if (!entry || !deliverable) throw new Error(`Unknown approved deliverable: ${taskId}`);
          return approvedImageTask(workspaceDir, params.runId, entry, deliverable);
        });
        const pending = [...tasks];
        const results: Record<string, unknown>[] = [];
        const unsuccessful = new Set<string>();
        while (pending.length) {
          signal?.throwIfAborted();
          const ready = pending.filter((task) => !task.referenceImagePaths.some((path) => pending.some((candidate) => candidate.path === path)));
          if (!ready.length) throw new Error("Image plan contains cyclic edit dependencies");
          const batch = await mapWithConcurrency(ready, imageConcurrency, async (task) => {
            const startedAt = performance.now();
            let result: Record<string, unknown>;
            try {
              if (task.referenceImagePaths.some((path) => unsuccessful.has(path))) throw new Error("Required source generation failed");
              for (const path of task.referenceImagePaths) await assertAssignedRead(path, context?.cwd ?? workspaceDir);
              const fingerprint = await approvedImageFingerprint(task);
              const sidecar = params.reuse !== false ? await readFile(`${task.path}.json`, "utf8").then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => undefined) : undefined;
              const bytes = sidecar?.planFingerprint === fingerprint ? await readFile(task.path).catch(() => undefined) : undefined;
              if (bytes?.length && imageBytesMatchPath(bytes, task.outputPath) && createHash("sha256").update(bytes).digest("hex") === sidecar?.imageSha256) {
                result = { ok: true, id: task.id, path: relative(workspaceDir, task.path), reused: true };
              } else {
                if (task.method === "image_generate") result = await generateImage({ runId: params.runId, ...task }, signal, (notice) => onUpdate?.(textResult({ retry: notice, id: task.id })), (progress) => onUpdate?.(imageRequestUpdate(progress)), task);
                else {
                  if (!task.referenceImagePaths.length || !task.diagnosis.length || !task.changes.length || !task.preserve.length) throw new Error(`Plan ${task.id} needs explicit referenceImagePaths, diagnosis, changes and preserve; request specification correction`);
                  const edited = await imageEditTool.execute(`${id}:${task.id}`, { runId: params.runId, ...task }, signal, onUpdate, context);
                  result = { ...(edited.details as Record<string, unknown>), id: task.id };
                }
                await recordApprovedImage(task, fingerprint);
              }
            } catch (error) {
              signal?.throwIfAborted();
              unsuccessful.add(task.path);
              result = { ok: false, id: task.id, error: error instanceof Error ? error.message : String(error) };
            }
            await appendWorkflowLifecycleEvent(workspaceDir, params.runId, { type: "image_item_finished", imageId: task.id, invocationId: options.parentInvocation?.id, agent: "builder", durationMs: Math.round(performance.now() - startedAt), status: result.ok ? "completed" : "error", result });
            onUpdate?.(textResult(result));
            return result;
          }, signal);
          results.push(...batch);
          for (const task of ready) pending.splice(pending.indexOf(task), 1);
        }
        const summary = { action: "execute_image_plan", ...batchSummary(results) };
          return { content: [jsonText(summary)], details: summary };
      },
    });
    pi.registerTool(imagePlanTool);

    pi.registerTool({
      name: "html_generate", label: "Generate approved HTML page",
      description: "Generate one approved HTML/CSS/JS page task from Designer sources. No redesign. Use execute_design_plan for dependency-aware mixed batches.",
      parameters: Type.Object({ runId: Type.String(), id: Type.String(), reuse: Type.Optional(Type.Boolean()) }),
      async execute(_id, params, signal) {
        if (options.parentInvocation?.agent !== "builder") throw new Error("html_generate is available only to Builder");
        assertAssignedRun(params.runId, "html_generate");
        const runDir = resolveInside(workspaceDir, join("runs", safeRunId(params.runId)));
        const bus = (await readFile(join(runDir, "bus.jsonl"), "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
        if (currentWorkflowCycle(bus).filter((event) => ["design_spec_ready", "design_revision_ready", "design_review_pass", "design_review_fail", "build_done"].includes(String(event.type))).at(-1)?.type !== "design_review_pass") throw new Error("html_generate requires a current approved specification");
        await assertStageCommitted(workspaceDir, params.runId, "designer", 0, true);
        await assertStageCommitted(workspaceDir, params.runId, "reviewer", 0);
        const contract = deliveryContract(await readJsonRecord(runDir, "plan/design_plan.json"), await readJsonRecord(runDir, "plan/deliverable_manifest.json"));
        await validateDeliveryContract(runDir, contract);
        const task = contract.tasks.find((task) => task.id === params.id && task.method === "html_generate");
        if (!task) throw new Error(`Unknown approved HTML task: ${params.id}`);
        return textResult(await materializeHtml(runDir, htmlTask(task), params.reuse !== false, signal));
      },
    });

    pi.registerTool({
      name: "execute_design_plan",
      label: "Execute approved design plan",
      description: "Execute approved typed image/HTML tasks by id. Images use the existing image executor; HTML copies approved source files without redesign. Resolves actual dependencies and preserves independent successes.",
      parameters: Type.Object({ runId: Type.String(), ids: Type.Optional(Type.Array(Type.String(), { minItems: 1 })), reuse: Type.Optional(Type.Boolean()) }),
      async execute(id, params, signal, onUpdate, context) {
        if (options.parentInvocation?.agent !== "builder") throw new Error("Only Builder may execute an approved plan");
        assertAssignedRun(params.runId, "execute_design_plan");
        const runDir = resolveInside(workspaceDir, join("runs", safeRunId(params.runId)));
        const bus = (await readFile(join(runDir, "bus.jsonl"), "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
        if (currentWorkflowCycle(bus).filter((event) => ["design_spec_ready", "design_revision_ready", "design_review_pass", "design_review_fail", "build_done"].includes(String(event.type))).at(-1)?.type !== "design_review_pass") throw new Error("A current approved specification is required");
        await assertStageCommitted(workspaceDir, params.runId, "designer", 0, true);
        await assertStageCommitted(workspaceDir, params.runId, "reviewer", 0);
        const plan = await readJsonRecord(runDir, "plan/design_plan.json");
        const contract = deliveryContract(plan, await readJsonRecord(runDir, "plan/deliverable_manifest.json"));
        await validateDeliveryContract(runDir, contract);
        const dependencies = (task: Record<string, unknown>): string[] => [...new Set([
          ...(Array.isArray(task.dependencies) ? task.dependencies.filter((value): value is string => typeof value === "string") : []),
          ...(Array.isArray(task.referenceImagePaths ?? task.reference_image_paths) ? (task.referenceImagePaths ?? task.reference_image_paths) as string[] : []).flatMap((path) => {
            const producer = contract.deliverables.find((item) => item.file === path || resolveInside(runDir, String(item.file)) === path);
            return producer ? [String(producer.id)] : [];
          }),
        ])];
        const selected = new Set<string>();
        const visiting = new Set<string>();
        const include = (taskId: string) => {
          if (visiting.has(taskId)) throw new Error("Execution plan has cyclic dependencies");
          if (selected.has(taskId)) return;
          const task = contract.tasks.find((item) => item.id === taskId);
          if (!task) throw new Error(`Unknown approved task: ${taskId}`);
          visiting.add(taskId); for (const dependency of dependencies(task)) include(dependency); visiting.delete(taskId); selected.add(taskId);
        };
        for (const taskId of params.ids ?? contract.deliverables.filter((item) => item.required === true && item.method !== "manual").map((item) => String(item.id))) include(taskId);
        if (!params.ids) {
          const presentationTask = contract.tasks.find((task) => task.method === "html_generate" && htmlTask(task).files.some((file) => file.output === contract.presentation.entry));
          if (presentationTask) include(String(presentationTask.id));
        }
        const pending = contract.tasks.filter((task) => selected.has(String(task.id)));
        const completed = new Set<string>();
        const failed = new Set<string>();
        const results: Record<string, unknown>[] = [];
        while (pending.length) {
          signal?.throwIfAborted();
          const ready = pending.filter((task) => dependencies(task).every((dependency) => completed.has(dependency) || failed.has(dependency)));
          if (!ready.length) throw new Error("Execution plan has unresolved dependencies");
          const blocked = ready.filter((task) => dependencies(task).some((dependency) => failed.has(dependency)));
          for (const task of blocked) { failed.add(String(task.id)); results.push({ ok: false, id: task.id, error: "Required dependency failed" }); }
          const runnable = ready.filter((task) => !blocked.includes(task));
          const registry = new ExecutionRegistry()
            .register(["image_generate", "image_edit"], async (images) => {
              const result = await imagePlanTool.execute(`${id}:images`, { runId: params.runId, ids: images.map((task) => String(task.id)), ...(params.reuse === undefined ? {} : { reuse: params.reuse }) }, signal, onUpdate, context);
              return (JSON.parse((result.content[0] as { text: string }).text) as { results: Record<string, unknown>[] }).results;
            })
            .register(["html_generate"], (tasks) => mapWithConcurrency(tasks, imageConcurrency, async (task) => {
              try { return await materializeHtml(runDir, htmlTask(task), params.reuse !== false, signal); }
              catch (error) { signal?.throwIfAborted(); return { ok: false, id: task.id, error: error instanceof Error ? error.message : String(error) }; }
            }, signal));
          const groups = await registry.execute(runnable);
          for (const result of groups) { (result.ok ? completed : failed).add(String(result.id)); results.push(result); onUpdate?.(textResult(result)); }
          for (const task of ready) pending.splice(pending.indexOf(task), 1);
        }
        const pendingOutputs = await pendingRequiredOutputs(runDir, contract);
        return textResult({ action: "execute_design_plan", ...batchSummary(results), deliveryComplete: pendingOutputs.length === 0, pendingOutputs,
          ...(pendingOutputs.length ? { instruction: "Only selected tasks have executed. Complete pending required outputs before build_finalize; call execute_design_plan without ids to execute/reuse the full approved plan. Presentation mode does not remove required deliverables." } : {}) });
      },
    });

    pi.registerTool({
      name: "showcase_template",
      label: "Build showcase from captions",
      description: "Render a local responsive gallery from approved deliverable ids, captions and thematic sections. Include required images and links to required HTML pages. Finalization adds references and prompt attribution. Pure HTML presentation uses its approved page instead of this gallery.",
      parameters: Type.Object({ runId: Type.String(), title: Type.String(), sections: Type.Array(Type.Object({ title: Type.String(), items: Type.Array(Type.Object({ id: Type.String(), caption: Type.String() }), { minItems: 1 }) }), { minItems: 1 }) }),
      async execute(_id, params, signal) {
        if (options.parentInvocation?.agent !== "builder") throw new Error("Only Builder may render a showcase");
        assertAssignedRun(params.runId, "showcase_template");
        signal?.throwIfAborted();
        const runDir = resolveInside(workspaceDir, join("runs", safeRunId(params.runId)));
        const manifest = await readJsonRecord(runDir, "plan/deliverable_manifest.json");
        const deliverables = requiredArray(manifest, "deliverables", "manifest").map((item) => requiredRecord(item, "deliverable"));
        const covered = new Set(params.sections.flatMap((section) => section.items.map((item) => item.id)));
        for (const item of deliverables) if (item.required === true && !covered.has(String(item.id))) throw new Error(`Showcase omits required deliverable: ${String(item.id)}`);
        const sections = [];
        for (const section of params.sections) {
          const items = [];
          for (const item of section.items) {
            const entry = deliverables.find((entry) => entry.id === item.id);
            if (!entry) throw new Error(`Unknown deliverable: ${item.id}`);
            const file = requiredString(entry, "file", "deliverable");
            const path = entry.method === "html_generate"
              ? await physicalRunFile(runDir, file)
              : artifactOutputPath(workspaceDir, params.runId, item.id, "generated-images", file);
            if (!(await stat(path)).isFile()) throw new Error(`Missing output: ${item.id}`);
            items.push({ ...item, path, ...(entry.method === "html_generate" ? { kind: "html" as const } : {}) });
          }
          sections.push({ title: section.title, items });
        }
        const path = join(runDir, "artifacts", "00-gallery.html");
        await writeFile(path, showcaseTemplate(params.title, sections, dirname(path)));
        return textResult({ ok: true, path: relative(workspaceDir, path), instruction: "Showcase saved; call build_finalize when all required outputs are ready." });
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
      description: "Finalize approved outputs and presentation: create delivery metadata, run mechanical lint, and commit build_done. For gallery presentation, first author artifacts/00-gallery.html; finalization appends research citations. For HTML presentation, generate its declared approved page, without an extra gallery. No fallback page is generated. This is not a visual or engineering audit.",
      parameters: Type.Object({
        runId: Type.String(),
        summary: Type.Optional(Type.String()),
        requestedAction: Type.Optional(Type.String()),
      }),
      async execute(_id, params, signal) {
        if (options.parentInvocation?.agent !== "builder") throw new Error("build_finalize is available only inside a Builder invocation");
        const runId = safeRunId(params.runId);
        if (runId !== options.parentInvocation.runId) throw new Error("Builder may finalize only its assigned Run");
        const runDir = resolveInside(workspaceDir, join("runs", runId));
        const plan = await readJsonRecord(runDir, "plan/design_plan.json");
        const buildBus = (await readFile(join(runDir, "bus.jsonl"), "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
        const currentGate = currentWorkflowCycle(buildBus).filter((event) => ["design_spec_ready", "design_revision_ready", "design_review_pass", "design_review_fail", "build_done"].includes(String(event.type))).at(-1);
        if (currentGate?.type !== "design_review_pass") throw new Error("build_finalize requires a current approved specification and may commit only once");
        if (plan.schemaVersion === 2) {
          let delivery: Awaited<ReturnType<typeof finalizeDelivery>>;
          try {
            await assertStageCommitted(workspaceDir, runId, "designer", 0, true);
            await assertStageCommitted(workspaceDir, runId, "reviewer", 0);
            delivery = await finalizeDelivery(runDir, runId, signal);
          }
          catch (error) {
            signal?.throwIfAborted();
            if (error instanceof BuildIncomplete) {
              const incomplete = { ok: false, blocked: false, retryable: true, runId, repairOwner: "builder", pendingOutputs: error.pendingOutputs,
                instruction: "Required outputs remain incomplete. Execute missing approved tasks with execute_design_plan (omit ids for the full plan; existing successes are reused), or finish declared manual outputs. Do not remove image deliverables because presentation is HTML. Then retry build_finalize." };
              return { ...textResult(incomplete), details: incomplete };
            }
            if (!(error instanceof DeliveryBlocked)) throw error;
            const block = { ok: false, blocked: true, retryable: false, runId, repairOwner: error.repairOwner, issues: error.issues,
              reviewEventId: currentGate.id, runtimeStamp: await deliveryRuntimeStamp(),
              instruction: error.repairOwner === "designer" ? "The approved source or acceptance checks need correction. Return to Orchestrator, then Designer and Reviewer. Do not edit approved artifacts/source, repeat unchanged finalization, or regenerate images." : "Restore HTML browser validation availability, then retry the same approved sources. Do not redesign or regenerate images." };
            await mkdir(join(runDir, ".performance"), { recursive: true });
            await writeFile(join(runDir, ".performance/build-block.json"), JSON.stringify(block, null, 2));
            return { ...finishWorkflow(block), details: block };
          }
          const commitReceipt = { schemaVersion: 2, files: Object.fromEntries(await Promise.all(delivery.files.map(async (path) => [path, await fileHash(runDir, path)]))) };
          const event = { id: randomUUID(), runId, type: "build_done", from: "builder", from_agent: "builder", to: "orchestrator", phase: "build", summary: params.summary?.trim() || `Implemented ${delivery.artifacts.length} approved deliverables; mechanical validation passed.`, artifactRefs: delivery.files, requestedAction: params.requestedAction?.trim() || "Export the approved delivery.", commitReceipt, at: new Date().toISOString() };
          await appendFile(join(runDir, "bus.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
          await updateRunState(workspaceDir, runId, "build_done");
          await updateDesignContextIndex(workspaceDir, runId, "build_done");
          return finishWorkflow({ ok: true, runId, event, ...delivery, nextAction: { tool: "export_package", arguments: { runId } }, instruction: "Build committed. Stop this specialist. Orchestrator must call export_package immediately without reading artifacts or starting a specialist." }, process.env.DREAMATIC_STOP_AFTER_COMMIT?.trim().toLowerCase() !== "false");
        }
        if (briefDesignScopes(await readJsonRecord(runDir, "brief.json").catch(() => ({}))).length) {
          await assertStageCommitted(workspaceDir, runId, "designer", 0, true);
          await assertStageCommitted(workspaceDir, runId, "reviewer", 0);
        }
        const deliverableManifest = await readJsonRecord(runDir, "plan/deliverable_manifest.json");
        const prompts = requiredArray(plan, "image_generation_plan", "plan/design_plan.json")
          .map((item, index) => requiredRecord(item, `plan/design_plan.json.image_generation_plan[${index}]`));
        const deliverables = requiredArray(deliverableManifest, "deliverables", "plan/deliverable_manifest.json")
          .map((item, index) => requiredRecord(item, `plan/deliverable_manifest.json.deliverables[${index}]`));
        const requiredDeliverables = deliverables.filter((deliverable) => deliverable.required === true);
        const runtimeOwnedFiles = new Set([
          "artifacts/artifact-manifest.json",
          "artifacts/lint-report.json",
          "artifacts/model-usage.json",
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
        const galleryPath = join(artifactsDir, "00-gallery.html");
        const authoredGallery = await readFile(galleryPath, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") throw new Error("Builder must author artifacts/00-gallery.html before build_finalize. Write the layout, overall description, image captions and conclusion; preserve completed images.");
          throw error;
        });
        if (!authoredGallery.trim()) throw new Error("Builder-authored artifacts/00-gallery.html is empty; write the Showcase before build_finalize");
        const artifactManifestPath = join(artifactsDir, "artifact-manifest.json");
        const modelUsage = await collectModelUsage(runDir, artifacts);
        await writeFile(join(runDir, "plan/model-usage.json"), JSON.stringify(modelUsage, null, 2));
        await writeFile(join(artifactsDir, "model-usage.json"), JSON.stringify(modelUsage, null, 2));
        await writeFile(artifactManifestPath, JSON.stringify({ modelUsage, runId, generatedAt: new Date().toISOString(), qualityEvidence: { designSpec: "reviewed", fileIntegrity: "pending", visualFidelity: "not_assessed", engineeringFeasibility: "not_validated", userAcceptance: "pending" }, artifacts }, null, 2), "utf8");
        await writeFile(galleryPath, await appendShowcaseReferences(runDir, await annotateShowcasePrompts(runDir, annotateModelUsage(authoredGallery, modelUsage))), "utf8");
        const visualCount = implementationDeliverables.filter((deliverable) => /\.(png|jpe?g|webp)$/iu.test(String(deliverable.file ?? ""))).length;
        const lint = { runId, ...await lintArtifactDirectory(runDir, artifactsDir, visualCount, true) };
        const lintPath = join(artifactsDir, "lint-report.json");
        await writeFile(lintPath, JSON.stringify(lint, null, 2), "utf8");
        if (!lint.ok) throw new Error(`Build mechanical validation failed: ${lint.issues.join("; ")}`);
        const finalizedManifest = await readJsonRecord(runDir, "artifacts/artifact-manifest.json");
        (finalizedManifest.qualityEvidence as Record<string, unknown>).fileIntegrity = "passed";
        await writeFile(artifactManifestPath, JSON.stringify(finalizedManifest, null, 2), "utf8");
        await validateStageOutputs(runDir, runId, "builder", "build_done");
        const artifactRefs = [
          ...implementationDeliverables.map((deliverable) => requiredString(deliverable, "file", "deliverable")),
          "artifacts/artifact-manifest.json",
          "artifacts/lint-report.json",
          "artifacts/model-usage.json",
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
        return finishWorkflow({ ok: true, runId, event, artifacts, lint, nextAction: { tool: "export_package", arguments: { runId } }, instruction: "Build committed. Stop this specialist. Orchestrator must call export_package immediately without reading artifacts or starting a specialist." }, process.env.DREAMATIC_STOP_AFTER_COMMIT?.trim().toLowerCase() !== "false");
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
      description: "Package the finalized presentation, artifacts, plans, research and review. Preserve content and layout. HTML delivery keeps its actual page entry; Gallery delivery only adapts the resource base. Never generate replacement presentation content.",
      parameters: Type.Object({
        runId: Type.String(),
        runDir: Type.Optional(Type.String({ description: "Compatibility path; defaults to the canonical runs/<runId> directory and cannot target another Run." })),
        finalDir: Type.Optional(Type.String()),
        brief: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        const runId = safeRunId(params.runId);
        assertAssignedRun(runId, "export_package");
        const canonicalRunDir = resolveInside(workspaceDir, join("runs", runId));
        const runDir = resolveInside(workspaceDir, params.runDir ?? join("runs", runId));
        if (runDir !== canonicalRunDir) throw new Error("export_package runDir must match its canonical runId; no files were exported");
        const busEvents = (await readFile(join(runDir, "bus.jsonl"), "utf8").catch(() => ""))
          .split(/\r?\n/)
          .filter(Boolean)
          .flatMap((line) => {
            try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
          });
        const finalGateEvents = currentWorkflowCycle(busEvents).filter((event) => ["design_spec_ready", "design_revision_ready", "design_review_pass", "design_review_fail", "build_done"].includes(String(event.type ?? "")));
        const buildDoneIndex = finalGateEvents.findLastIndex((event) => event.type === "build_done");
        const precedingDesignGate = finalGateEvents.slice(0, buildDoneIndex).findLast((event) => ["design_spec_ready", "design_revision_ready", "design_review_pass", "design_review_fail"].includes(String(event.type ?? "")));
        if (buildDoneIndex < 0 || buildDoneIndex !== finalGateEvents.length - 1 || precedingDesignGate?.type !== "design_review_pass") {
          throw new Error(`Run ${runId} cannot be exported before an approved Design Context is implemented and build_done is committed`);
        }
        const lint = await readJsonRecord(runDir, "artifacts/lint-report.json");
        if (lint.ok !== true) throw new Error(`Run ${runId} cannot be exported before Builder mechanical lint passes`);
        const builtManifest = await readJsonRecord(runDir, "artifacts/artifact-manifest.json").catch(() => undefined);
        const exportContract = builtManifest?.schemaVersion === 2 ? deliveryContract(await readJsonRecord(runDir, "plan/design_plan.json"), await readJsonRecord(runDir, "plan/deliverable_manifest.json")) : undefined;
        if (exportContract?.deliverables.some(item => (item.presentation as { required?: boolean } | undefined)?.required)) {
          const validation = await checkHtmlBrowser(runDir, exportContract);
          if (validation.status !== "completed") throw new DeliveryBlocked("runtime", [validation.reason ?? "Export presentation validation unavailable"]);
          if (!validation.passed) throw new DeliveryBlocked("designer", validation.issues);
        }
        const typedPresentation = builtManifest?.schemaVersion === 2 ? deliveryContract(await readJsonRecord(runDir, "plan/design_plan.json"), await readJsonRecord(runDir, "plan/deliverable_manifest.json")).presentation : undefined;
        if (typedPresentation || briefDesignScopes(await readJsonRecord(runDir, "brief.json").catch(() => ({}))).length) {
          await assertStageCommitted(workspaceDir, runId, "designer", 0);
          await assertStageCommitted(workspaceDir, runId, "reviewer", 0);
          await assertStageCommitted(workspaceDir, runId, "builder", 0);
        }
        const entryPath = typedPresentation?.entry ?? "artifacts/00-gallery.html";
        const gallery = await readFile(resolveInside(runDir, entryPath), "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") throw new Error("Builder Showcase artifacts/00-gallery.html is missing. Export cannot create a substitute page.");
          throw error;
        });
        if (!gallery.trim()) throw new Error("Builder Showcase is empty; export cannot create a substitute page");
        await updateRunState(workspaceDir, runId, "export_started");
        const finalDir = params.finalDir
          ? resolveInside(workspaceDir, params.finalDir)
          : resolveInside(workspaceDir, join("runs", runId, "final"));
        await mkdir(finalDir, { recursive: true });
        const retired = await hasUnifiedContext(runDir) ? new Set<string>(Object.values(CONTEXT_PROJECTIONS).flat()) : new Set<string>();
        for (const name of ["research", "plan", "artifacts", "review", "context"]) {
          const source = join(runDir, name);
          if (await stat(source).then(() => true).catch(() => false)) await cp(source, join(finalDir, name), { recursive: true, force: true, filter: (path) => !retired.has(relative(runDir, path).replaceAll("\\", "/")) });
        }
        const busPath = join(runDir, "bus.jsonl");
        if (await stat(busPath).then(() => true).catch(() => false)) await cp(busPath, join(finalDir, "bus.jsonl"), { force: true });
        const files = await listFiles(finalDir);
        await writeFile(join(finalDir, "package-manifest.json"), JSON.stringify({ runId, exportedAt: new Date().toISOString(), ...(typedPresentation ? { schemaVersion: 2, presentation: typedPresentation, entry: typedPresentation.mode === "html" ? typedPresentation.entry : "00-index.html" } : {}), files }, null, 2), "utf8");

        const html = /<base\b/i.test(gallery)
          ? gallery
          : gallery.replace(/<head([^>]*)>/i, '<head$1><base href="artifacts/">');
        if (typedPresentation?.mode !== "html") await writeFile(join(finalDir, "00-index.html"), html, "utf8");
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
        return finishWorkflow({ ok: true, runId, finalDir, files: await listFiles(finalDir) });
      },
    });
  };
}
