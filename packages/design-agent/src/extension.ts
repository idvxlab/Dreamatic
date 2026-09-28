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
import { appendFile, cp, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { resolveInside, safeRunId } from "./paths.js";
import { createModelImagePreview } from "./image-preview.js";
import { dreamaticProviderFromEnv } from "./provider.js";
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
  "design-research": ["research_done"],
  "design-planner": ["plan_done"],
  "design-designer": ["design_done"],
  "design-critic": ["evaluator_pass", "evaluator_fail"],
};

const STAGE_REQUIRED_FILES: Record<string, string[]> = {
  "design-research": ["research/evidence.json", "research/research.md", "research/brand_lock.md", "research/assets/manifest.json", "research/assets/validation.json"],
  "design-planner": ["plan/design_system.json", "plan/design_plan.json", "plan/deliverable_manifest.json", "plan/acceptance_criteria.md", "plan/task_breakdown.md"],
  "design-designer": ["artifacts/artifact-manifest.json", "artifacts/00-gallery.html"],
  "design-critic": ["review/critique.md", "review/critique.json"],
};

function runIdFromTask(task: string): string | undefined {
  const explicit = task.match(/\bRun\s*id\s*:\s*([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})/i)?.[1];
  if (explicit) return safeRunId(explicit);
  const path = task.replaceAll("\\", "/").match(/\/runs\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})(?:\/|\b)/)?.[1];
  return path ? safeRunId(path) : undefined;
}

async function assertStageCommitted(workspaceDir: string, runId: string, agent: string): Promise<string> {
  const allowed = STAGE_COMPLETION_EVENTS[agent];
  if (!allowed) return "not-required";
  const busPath = resolveInside(workspaceDir, join("runs", runId, "bus.jsonl"));
  const runDir = resolveInside(workspaceDir, join("runs", runId));
  const source = await readFile(busPath, "utf8").catch(() => "");
  const committed = source
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    })
    .findLast((event) => allowed.includes(String(event.type ?? "")));
  if (!committed) throw new Error(`${agent} returned without committing ${allowed.join(" or ")} to the Design Bus for Run ${runId}`);
  for (const required of STAGE_REQUIRED_FILES[agent] ?? []) {
    const path = resolveInside(runDir, required);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw new Error(`${agent} committed ${String(committed.type)} but required output is missing or empty: ${required}`);
    if (required.endsWith(".json")) JSON.parse(await readFile(path, "utf8"));
  }
  if (agent === "design-designer") {
    const artifactFiles = await listFiles(join(runDir, "artifacts"));
    if (!artifactFiles.some((file) => /\.(png|jpe?g|webp)$/i.test(file))) throw new Error("design-designer committed design_done without a visual artifact");
  }
  const references = Array.isArray(committed.artifactRefs) ? committed.artifactRefs.filter((item): item is string => typeof item === "string") : [];
  for (const reference of references) {
    const workspacePath = resolveInside(workspaceDir, reference);
    const runPath = resolveInside(runDir, reference);
    if (!await stat(workspacePath).then(() => true).catch(() => false)) await stat(runPath);
  }
  return String(committed.type);
}

type ImageToolName = "image_generate" | "image_edit";

interface SavedImage {
  bytes: Buffer;
  mimeType: "image/png";
  path: string;
  sidecarPath: string;
}

interface RunState {
  runId: string;
  status: "active" | "needs_repair" | "interrupted" | "complete";
  stages: Record<"research" | "planning" | "design" | "critique" | "export", "pending" | "in_progress" | "completed" | "failed">;
  createdAt: string;
  updatedAt: string;
  lastEvent?: string;
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
export async function compactVisualSession(sessionFile: string): Promise<{ omitted: number; beforeBytes: number; afterBytes: number; backupPath: string }> {
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
  options: { workspaceDir: string; runId: string; operation: string; budgetScope?: string; signal?: AbortSignal; onRetry?: (notice: RetryNotice) => void | Promise<void> },
): Promise<Response> {
  const timeoutMs = Math.max(10_000, Number(process.env.DREAMATIC_IMAGE_TIMEOUT_MS ?? 300_000));
  const attempts = Math.max(1, Number(process.env.DREAMATIC_IMAGE_RETRY_ATTEMPTS ?? 3));
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
    stages: { research: "pending", planning: "pending", design: "pending", critique: "pending", export: "pending" },
    createdAt: now,
    updatedAt: now,
  };
  const state = await readFile(path, "utf8")
    .then((content) => JSON.parse(content) as RunState)
    .catch(() => fallback);
  if (eventType === "kickoff") state.stages.research = "in_progress";
  if (eventType === "research_done") {
    state.status = "active";
    state.stages.research = "completed";
    state.stages.planning = "in_progress";
  }
  if (eventType === "plan_done") {
    state.status = "active";
    state.stages.planning = "completed";
    state.stages.design = "in_progress";
  }
  if (eventType === "design_done") {
    state.status = "active";
    state.stages.design = "completed";
    state.stages.critique = "in_progress";
  }
  if (eventType === "evaluator_fail") {
    state.status = "needs_repair";
    state.stages.critique = "failed";
    state.stages.design = "in_progress";
  }
  if (eventType === "evaluator_pass") {
    state.status = "active";
    state.stages.critique = "completed";
    state.stages.export = "in_progress";
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

type PersonaFrontmatter = {
  name?: unknown;
  allowed_tools?: unknown;
};

function personaTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(tools)];
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
  const viewedPaths = new Set<string>();
  const comparedSets = new Set<string>();
  return (pi: ExtensionAPI) => {
    const profile = dreamaticProviderFromEnv();
    let activeRunId = options.parentInvocation?.runId;
    if (profile) pi.registerProvider(profile.providerId, profile.registration);
    if (!options.parentInvocation) {
      pi.on("tool_execution_start", async (event) => {
        const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
        if (typeof args.runId === "string") activeRunId = safeRunId(args.runId);
        if (!activeRunId || ["run_init", "spawn_agent"].includes(event.toolName)) return;
        await appendWorkflowLifecycleEvent(workspaceDir, activeRunId, {
          type: "primary_tool_started",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: workflowObservation(event.args, 900),
          status: "running",
          from: "design-primary",
        });
      });
      pi.on("tool_execution_end", async (event) => {
        if (event.toolName === "run_init" && !event.isError) {
          const match = workflowObservation(event.result, 4_000).match(/"runId"\s*:\s*"([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})"/u);
          if (match?.[1]) activeRunId = safeRunId(match[1]);
        }
        if (!activeRunId || ["run_init", "spawn_agent"].includes(event.toolName)) return;
        await appendWorkflowLifecycleEvent(workspaceDir, activeRunId, {
          type: "primary_tool_finished",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: workflowObservation(event.result, 1_200),
          isError: event.isError,
          status: event.isError ? "error" : "completed",
          from: "design-primary",
        });
      });
    }
    // Generated images remain in the durable Pi session, but only the newest
    // visual tool observation is sent back to the model on later turns. Paths
    // and textual metadata remain available, so older images can be reloaded
    // explicitly with view_image when needed.
    pi.on("context", (event) => {
      const messages = structuredClone(event.messages);
      let visualMessagesKept = 0;
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
        visualMessagesKept += 1;
        if (visualMessagesKept <= 1) continue;
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
      parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 12 })) }),
      async execute(_id, params) {
        return textResult(await webSearch(params.query, params.limit));
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
        return textResult(await researchFetch(workspaceDir, params));
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
        return textResult(await fetchResearchAsset(workspaceDir, params));
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
      description: "Run any registered Dreamatic persona in an isolated Pi session and return its final response. Pass runId for every invocation that belongs to a Run so the session is persisted and appears in the workflow stream.",
      parameters: Type.Object({
        agent: Type.String({ description: "Persona name such as design-research, design-planner, design-designer, or design-critic" }),
        task: Type.String(),
        runId: Type.Optional(Type.String({ description: "Existing Dreamatic Run id. Required for durable stage sessions and completion validation." })),
      }),
      async execute(invocationId, params, signal, onUpdate, context) {
        if (!context.model) throw new Error("The parent session has no active model to pass to the design agent");
        const personaPath = join(context.cwd, ".pi", "agents", `${safeRunId(params.agent)}.md`);
        const source = await readFile(personaPath, "utf8");
        const { frontmatter, body } = parseFrontmatter<PersonaFrontmatter>(source);
        const inferredRunId = params.runId ? safeRunId(params.runId) : runIdFromTask(params.task);
        if (inferredRunId) activeRunId = inferredRunId;
        const childLoader = new DefaultResourceLoader({
          cwd: context.cwd,
          agentDir: getAgentDir(),
          systemPromptOverride: () => body,
          appendSystemPromptOverride: (base) => base,
          extensionFactories: [createDreamaticExtension({
            ...options,
            parentInvocation: { id: invocationId, agent: params.agent, ...(inferredRunId ? { runId: inferredRunId } : {}) },
          })],
        });
        await childLoader.reload();
        const tools = personaTools(frontmatter.allowed_tools);
        if (STAGE_COMPLETION_EVENTS[params.agent] && !inferredRunId) {
          throw new Error(`spawn_agent requires runId for workflow stage ${params.agent}`);
        }
        const childSessionDir = inferredRunId
          ? resolveInside(workspaceDir, join("runs", inferredRunId, "sessions", safeRunId(params.agent)))
          : resolveInside(workspaceDir, join("sessions", "subagents", safeRunId(params.agent)));
        await mkdir(childSessionDir, { recursive: true });
        const { session } = await createAgentSession({
          cwd: context.cwd,
          model: context.model,
          resourceLoader: childLoader,
          // Each Run/persona pair owns one Pi history. continueRecent creates
          // the first file and resumes it on retry, repair, or process restart.
          sessionManager: SessionManager.continueRecent(context.cwd, childSessionDir),
          ...(context.thinkingLevel ? { thinkingLevel: context.thinkingLevel } : {}),
          ...(tools ? { tools } : {}),
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
        await emitLifecycle({ type: "agent_started", task: params.task, status: "running", from: "design-primary" });
        const unsubscribe = session.subscribe((event) => {
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            onUpdate?.({
              content: [{ type: "text", text: event.assistantMessageEvent.delta }],
              details: { agent: params.agent, running: true },
            });
            return;
          }
          if (event.type === "tool_execution_start") {
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
            const output = workflowObservation(event.result, 1_200);
            void emitLifecycle({
              type: "tool_finished",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              output,
              isError: event.isError,
              status: event.isError ? "error" : "completed",
            });
            if (!event.isError && event.toolName === "research_asset_fetch" && inferredRunId) {
              const path = workflowReferencePath(event.result, inferredRunId);
              if (path) void emitLifecycle({ type: "reference_added", toolCallId: event.toolCallId, path, status: "completed" });
            }
          }
        });
        const abort = () => void session.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const childSessionFile = session.sessionFile;
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
          const output = finalAssistantText(session.messages);
          const committedEvent = inferredRunId
            ? await assertStageCommitted(workspaceDir, inferredRunId, params.agent)
            : "not-required";
          await lifecycleWrites;
          await emitLifecycle({ type: "agent_finished", output, committedEvent, status: "completed" });
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
          });
          throw error;
        } finally {
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
        const brief = {
          runId,
          createdAt: typeof existingBrief.createdAt === "string" ? existingBrief.createdAt : new Date().toISOString(),
          ...(typeof existingBrief.sessionId === "string" ? { sessionId: existingBrief.sessionId } : {}),
          title: projectTitle,
          titleStatus: "canonical",
          brief: params.brief,
          workflowSkill: params.workflowSkill ?? "",
          context,
          resolvedScope: namedScope,
          domainContext,
        };
        await writeFile(join(runDir, "brief.json"), JSON.stringify(brief, null, 2), "utf8");
        await writeFile(join(runDir, "bus.jsonl"), "", { encoding: "utf8", flag: "a" });
        await updateRunState(workspaceDir, runId, "initialized");
        return textResult({
          ok: true,
          runId,
          projectTitle,
          runDir,
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
        const runDir = resolveInside(workspaceDir, join("runs", runId));
        await mkdir(runDir, { recursive: true });
        const event = { id: randomUUID(), ...params, runId, at: new Date().toISOString() };
        await appendFile(join(runDir, "bus.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
        await updateRunState(workspaceDir, runId, params.type);
        return textResult({ ok: true, event });
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
      description: "Load a local image into the model's visual context for design inspection.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, params) {
        const observationKey = params.path.replaceAll("\\", "/").toLowerCase();
        if (viewedPaths.has(observationKey)) {
          throw new Error(`Visual evidence already loaded in this stage invocation: ${params.path}. Use the existing observation instead of adding the same image to context again.`);
        }
        viewedPaths.add(observationKey);
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
        const apiKey = process.env.DREAMATIC_IMAGE_API_KEY ?? process.env.DREAMATIC_API_KEY ?? process.env.OPENAI_API_KEY;
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
            size: params.size ?? process.env.DREAMATIC_IMAGE_DEFAULT_SIZE ?? "1536x1024",
            n: 1,
            response_format: process.env.DREAMATIC_IMAGE_RESPONSE_FORMAT ?? "b64_json",
          }),
        }, {
          workspaceDir,
          runId: params.runId,
          operation: "image_generate",
          budgetScope: params.id,
          ...(signal ? { signal } : {}),
          onRetry: (notice) => onUpdate?.({
            content: [{ type: "text", text: `Image generation retry ${notice.nextAttempt}: ${notice.error}` }],
            details: { retry: notice },
          }),
        });
        if (!response.ok) throw new Error(`Image generation failed (${response.status}): ${await response.text()}`);
        const payload = (await response.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
        const saved = await saveImageResponse(
          workspaceDir,
          safeRunId(params.runId),
          safeRunId(params.id),
          params.prompt,
          "image_generate",
          payload,
          [],
          params.outputPath,
          {
            intent: params.intent,
            acceptanceCriteria: params.acceptanceCriteria,
            preserve: params.preserve ?? [],
          },
        );
        const summary = {
          ok: true,
          action: "image_generate",
          path: saved.path,
          sidecarPath: saved.sidecarPath,
          intent: params.intent,
          acceptanceCriteria: params.acceptanceCriteria,
          instruction: "Inspect the returned image itself against every acceptance criterion before continuing.",
        };
        const preview = createModelImagePreview(saved.bytes, saved.mimeType);
        return {
          content: [jsonText({ ...summary, preview: { bytes: preview.bytes, width: preview.width, height: preview.height } }), { type: "image", data: preview.data, mimeType: preview.mimeType }],
          details: summary,
        };
      },
    });

    pi.registerTool({
      name: "image_edit",
      label: "Edit image",
      description: "Edit one or more reference images and save the result inside a Dreamatic run.",
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
        const apiKey = process.env.DREAMATIC_IMAGE_API_KEY ?? process.env.DREAMATIC_API_KEY ?? process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error("DREAMATIC_IMAGE_API_KEY, DREAMATIC_API_KEY, or OPENAI_API_KEY is not configured");
        const form = new FormData();
        form.set("model", process.env.DREAMATIC_IMAGE_MODEL ?? "gpt-image-1");
        form.set("prompt", params.prompt);
        form.set("size", params.size ?? process.env.DREAMATIC_IMAGE_DEFAULT_SIZE ?? "1536x1024");
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
          instruction: "Inspect the edited image itself. Confirm requested changes occurred and preserved features did not drift.",
        };
        const preview = createModelImagePreview(saved.bytes, saved.mimeType);
        return {
          content: [jsonText({ ...summary, preview: { bytes: preview.bytes, width: preview.width, height: preview.height } }), { type: "image", data: preview.data, mimeType: preview.mimeType }],
          details: summary,
        };
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
        }), { minItems: 2, maxItems: 4 }),
        criteria: Type.Array(Type.String(), { minItems: 1 }),
      }),
      async execute(_id, params) {
        const comparisonKey = params.candidates.map((candidate) => candidate.path.replaceAll("\\", "/").toLowerCase()).sort().join("|");
        if (comparedSets.has(comparisonKey)) {
          throw new Error("This candidate set is already in the current stage's visual context. Reuse that comparison rather than loading the same images again.");
        }
        comparedSets.add(comparisonKey);
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
        const artifactsDir = resolveInside(workspaceDir, join("runs", runId, "artifacts"));
        const validateArtifact = async (workspacePath: string) => {
          const path = resolveInside(workspaceDir, workspacePath);
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
        const files = await listFiles(runDir);
        const issues: string[] = [];
        for (const file of files) {
          const info = await stat(join(runDir, file));
          if (info.size === 0) issues.push(`${file}: empty file`);
          if (file.endsWith(".html")) {
            const html = await readFile(join(runDir, file), "utf8");
            if (/https?:\/\//i.test(html)) issues.push(`${file}: external URL found`);
            if (/<script\b/i.test(html)) issues.push(`${file}: script element found`);
          }
        }
        const images = files.filter((file) => /\.(png|jpe?g|webp)$/i.test(file));
        const requiredImages = Math.max(0, params.minPngs ?? 1);
        if (images.length < requiredImages) issues.push(`Expected at least ${requiredImages} visual artifacts, found ${images.length}`);
        if (params.requireGallery && !files.some((file) => file.endsWith("00-gallery.html"))) issues.push("Required 00-gallery.html is missing");
        return textResult({ ok: issues.length === 0, runId, stats: { files: files.length, images: images.length, required_png_count: requiredImages }, issues });
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
        return textResult({ ok: true, runId, finalDir, files: await listFiles(finalDir) });
      },
    });
  };
}
