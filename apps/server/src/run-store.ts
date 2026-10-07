import type { Dirent } from "node:fs";
import { indexedJsonl } from "./jsonl-index.js";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { RUN_CONTEXT_SECTIONS, RUN_FILES, findRunDocument } from "@dreamatic/design-agent";

export type TimelineKind = "thought" | "tool" | "result" | "error";

export interface AssetView {
  path: string;
  kind: string;
  role: "reference" | "generated" | "edited" | "showcase" | "other";
  size: number;
  modifiedAt: string;
  runId?: string;
  label: string;
}

export interface TimelineView {
  id: string;
  kind: TimelineKind;
  label: string;
  detail?: string;
  at?: string;
  stage?: string;
  artifactRefs?: string[];
  retryCount?: number;
}

function checkedRunId(runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)) throw new Error("Invalid run id");
  return runId;
}

export function newProjectId(): string {
  return `project-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
}

export async function createDraftRun(workspaceDir: string, sessionId: string, title = "Untitled design", projectId = newProjectId()): Promise<{ id: string; title: string }> {
  const runId = checkedRunId(projectId);
  const runDir = join(workspaceDir, "runs", runId);
  const createdAt = new Date().toISOString();
  await mkdir(join(workspaceDir, "runs"), { recursive: true });
  await mkdir(runDir, { recursive: false });
  await Promise.all([
    writeFile(join(runDir, "brief.json"), JSON.stringify({ runId, sessionId, title, titleStatus: "temporary", brief: "", resolvedScope: {}, createdAt }, null, 2), "utf8"),
    writeFile(join(runDir, "run-state.json"), JSON.stringify({ runId, status: "draft", stages: { research: "pending", design: "pending", review: "pending", build: "pending", export: "pending" }, createdAt, updatedAt: createdAt, lastEvent: "project_created" }, null, 2), "utf8"),
    writeFile(join(runDir, "design-context.json"), JSON.stringify({
      schemaVersion: 1,
      runId,
      status: "collecting",
      revision: 0,
      sections: structuredClone(RUN_CONTEXT_SECTIONS),
      updatedAt: createdAt,
    }, null, 2), "utf8"),
    writeFile(join(runDir, "bus.jsonl"), "", "utf8"),
  ]);
  return { id: runId, title };
}

export async function primeDraftRun(workspaceDir: string, unsafeRunId: string, sessionId: string, rawBrief: string): Promise<void> {
  const runId = checkedRunId(unsafeRunId);
  const runDir = join(workspaceDir, "runs", runId);
  const state = await readFile(join(runDir, "run-state.json"), "utf8").then((source) => record(JSON.parse(source) as unknown));
  if (state.status !== "draft") return;
  const briefPath = join(runDir, "brief.json");
  const brief = await readFile(briefPath, "utf8").then((source) => record(JSON.parse(source) as unknown));
  if (typeof brief.brief === "string" && brief.brief.trim()) return;
  const text = rawBrief.trim();
  if (!text) return;
  brief.sessionId = sessionId;
  brief.brief = text;
  brief.originalRequest = rawBrief;
  brief.originalRequestSource = "server_user_input";
  brief.title = text.slice(0, 72);
  brief.titleStatus = "temporary";
  await writeFile(briefPath, JSON.stringify(brief, null, 2), "utf8");
  state.updatedAt = new Date().toISOString();
  state.lastEvent = "brief_received";
  await writeFile(join(runDir, "run-state.json"), JSON.stringify(state, null, 2), "utf8");
}

export async function attachSessionToRun(workspaceDir: string, unsafeRunId: string, sessionId: string): Promise<{ id: string; title: string }> {
  const runId = checkedRunId(unsafeRunId);
  const briefPath = join(workspaceDir, "runs", runId, "brief.json");
  const brief = await readFile(briefPath, "utf8").then((source) => record(JSON.parse(source) as unknown));
  brief.sessionId = sessionId;
  await writeFile(briefPath, JSON.stringify(brief, null, 2), "utf8");
  const title = typeof brief.title === "string" && brief.title.trim()
    ? brief.title.trim()
    : typeof brief.brief === "string" && brief.brief.trim()
    ? brief.brief.trim().slice(0, 72)
    : runId;
  return { id: runId, title };
}

export async function renameRun(workspaceDir: string, unsafeRunId: string, unsafeTitle: string): Promise<{ id: string; title: string }> {
  const runId = checkedRunId(unsafeRunId);
  const title = unsafeTitle.trim();
  if (!title || title.length > 120) throw new Error("Project title must contain 1–120 characters");
  const runDir = join(workspaceDir, "runs", runId);
  const info = await stat(runDir).catch(() => null);
  if (!info?.isDirectory()) throw new Error("Project not found");
  const briefPath = join(runDir, "brief.json");
  const brief: Record<string, unknown> = await readFile(briefPath, "utf8").then((source) => record(JSON.parse(source) as unknown)).catch(() => ({}));
  brief.title = title;
  brief.resolvedScope = { ...record(brief.resolvedScope), human_title: title };
  const temporary = `${briefPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(brief, null, 2), "utf8");
  await rename(temporary, briefPath);
  return { id: runId, title };
}

export async function deleteRun(workspaceDir: string, unsafeRunId: string): Promise<{ id: string; trashedPath: string }> {
  const runId = checkedRunId(unsafeRunId);
  const run = (await runInventory(workspaceDir)).find((candidate) => candidate.id === runId);
  if (!run) throw new Error("Project not found");
  if (run.status === "active") throw new Error("An active project cannot be deleted while its agent is running");
  const source = join(workspaceDir, "runs", runId);
  const trashDir = join(workspaceDir, ".trash", "runs");
  await mkdir(trashDir, { recursive: true });
  const trashedPath = join(trashDir, `${runId}-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
  await rename(source, trashedPath);
  return { id: runId, trashedPath: relative(workspaceDir, trashedPath).replaceAll("\\", "/") };
}

export interface AgentActionView {
  id: string;
  tool: string;
  status: "running" | "completed" | "error";
  input?: string;
  output?: string;
  at?: string;
}

export interface AgentSessionView {
  id: string;
  agent: string;
  title: string;
  status: "running" | "completed" | "interrupted";
  createdAt?: string;
  updatedAt?: string;
  task?: string;
  followUps?: string[];
  output?: string;
  actionCount: number;
  actions: AgentActionView[];
  errors: string[];
}

export interface RunNoteView {
  id: "research" | "plan" | "review";
  title: string;
  text: string;
  path: string;
}

export interface RunView {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  stages: Record<string, string>;
  assetCount: number;
  documents: string[];
  notes: RunNoteView[];
  activity: TimelineView[];
  agentSessions: AgentSessionView[];
  modelUsage?: { schemaVersion: 1; reasoning: Array<{ model: string; provider: string; role?: string }>; generation: Array<{ model: string; provider: string; method?: string; deliverableId?: string }> };
  showcasePath?: string;
  presentation?: { mode: "gallery" | "html"; entry: string };
  htmlEntries?: string[];
  sessionId?: string;
}

const NOTE_FILES: Array<{ id: RunNoteView["id"]; title: string; path: string }> = [
  { id: "research", title: "Research findings", path: RUN_FILES.researchFindings },
  { id: "plan", title: "Design rationale", path: "plan/task_breakdown.md" },
  { id: "review", title: "Design challenges", path: "review/design-review.md" },
];

function compactMarkdown(source: string): string {
  return source
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "• ")
    .replace(/\[(.+?)\]\([^)]+\)/gu, "$1")
    .replace(/[*_`>|]/gu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, 1200);
}

async function runNotes(runDir: string): Promise<RunNoteView[]> {
  const notes: RunNoteView[] = [];
  for (const candidate of NOTE_FILES) {
    const existing = await findRunDocument(runDir, candidate.path);
    const text = await readFile(existing?.absolutePath ?? join(runDir, candidate.path), "utf8").then(compactMarkdown).catch(() => "");
    if (text) notes.push({ ...candidate, path: existing?.path ?? candidate.path, text });
  }
  return notes;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const directoryEntries = new Map<string, { mtimeMs: number; entries: Dirent[] }>();
async function cachedEntries(directory: string): Promise<Dirent[]> {
  const info = await stat(directory).catch(() => undefined);
  if (!info) { directoryEntries.delete(directory); return []; }
  const cached = directoryEntries.get(directory);
  if (cached?.mtimeMs === info.mtimeMs) return cached.entries;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  directoryEntries.delete(directory); directoryEntries.set(directory, { mtimeMs: info.mtimeMs, entries });
  while (directoryEntries.size > 2048) directoryEntries.delete(directoryEntries.keys().next().value!);
  return entries;
}

async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const child of await cachedEntries(directory)) {
    if (child.name === "history" && basename(dirname(directory)) === "runs") continue;
    const path = join(directory, child.name);
    if (child.isDirectory()) found.push(...await walk(path));
    else found.push(path);
  }
  return found;
}

function assetRole(path: string): AssetView["role"] {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (/\/(research\/assets|references)\//.test(normalized)) return "reference";
  if (/\/artifacts\/edits\//.test(normalized)) return "edited";
  if (/\/artifacts\/generated-images\//.test(normalized)) return "generated";
  if (/\/(00-gallery|00-index|gallery-edited).*\.html$/.test(normalized)) return "showcase";
  return "other";
}

function assetLabel(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

function runIdFromPath(workspaceDir: string, path: string): string | undefined {
  const segments = relative(workspaceDir, path).replaceAll("\\", "/").split("/");
  return segments[0] === "runs" ? segments[1] : undefined;
}

export async function assetInventory(workspaceDir: string, runId?: string): Promise<AssetView[]> {
  const root = runId ? join(workspaceDir, "runs", runId) : join(workspaceDir, "runs");
  const result: AssetView[] = [];
  for (const path of await walk(root)) {
    if (!/\.(png|jpe?g|webp|gif|svg|html|mp4|webm|glb|gltf)$/i.test(path)) continue;
    const workspacePath = relative(workspaceDir, path).replaceAll("\\", "/");
    const resolvedRunId = runId ?? runIdFromPath(workspaceDir, path);
    if (resolvedRunId) {
      const runDir = join(workspaceDir, "runs", resolvedRunId);
      const runPath = relative(runDir, path).replaceAll("\\", "/");
      if (runPath.startsWith("plan/html/") || runPath.startsWith(".performance/")) continue;
      if (runPath.startsWith("final/") && runPath !== "final/00-index.html") {
        const sourcePath = join(runDir, runPath.slice("final/".length));
        if (await stat(sourcePath).then(() => true).catch(() => false)) continue;
      }
    }
    const info = await stat(path);
    result.push({
      path: workspacePath,
      kind: extname(path).slice(1).toLowerCase(),
      role: assetRole(workspacePath),
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      ...(resolvedRunId ? { runId: resolvedRunId } : {}),
      label: assetLabel(path),
    });
  }
  return result.sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt));
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string");
  return values.length ? values : undefined;
}

interface SessionFileIndex {
  mtimeMs: number;
  source: string;
  sessionId?: string;
  canonicalRunIds: Set<string>;
  activity: TimelineView[];
}

const sessionFileCache = new Map<string, SessionFileIndex>();

const AGENT_TITLES: Record<string, string> = {
  researcher: "Researcher",
  designer: "Designer",
  reviewer: "Reviewer",
  builder: "Builder",
};

function limitedText(value: string, limit = 1_200): string {
  const compact = value.replace(/data:[^;]+;base64,[a-zA-Z0-9+/=]+/gu, "[image payload omitted]").trim();
  return compact.length > limit ? `${compact.slice(0, limit).trimEnd()}…` : compact;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return limitedText(value);
  if (!Array.isArray(value)) return "";
  return limitedText(value.map(record).flatMap((part) => typeof part.text === "string" ? [part.text] : []).join("\n"));
}

function compactArguments(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value, (key, item) => {
      if (["data", "imageData", "base64"].includes(key) && typeof item === "string") return `[payload omitted · ${item.length} chars]`;
      return item;
    }, 2);
    return text ? limitedText(text, 900) : undefined;
  } catch {
    return limitedText(String(value), 900);
  }
}

interface AgentSessionCacheEntry {
  mtimeMs: number;
  session: AgentSessionView;
}

const agentSessionCache = new Map<string, AgentSessionCacheEntry>();

async function indexAgentSession(path: string, agent: string): Promise<AgentSessionView> {
  const info = await stat(path);
  const cached = agentSessionCache.get(path);
  if (cached?.mtimeMs === info.mtimeMs) return cached.session;

  const jsonl = await indexedJsonl(path);
  const source = jsonl.source;
  const actions = new Map<string, AgentActionView>();
  const tasks: string[] = [];
  const assistantOutputs: string[] = [];
  const errors: string[] = [];
  let id = basename(path, extname(path));
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let finalAssistantState: "running" | "completed" | "interrupted" = "running";

  for (const [index, value] of jsonl.rows.entries()) {
    try {
      const envelope = record(value);
      const at = typeof envelope.timestamp === "string" ? envelope.timestamp : undefined;
      if (at) {
        createdAt ??= at;
        updatedAt = at;
      }
      if (envelope.type === "session" && typeof envelope.id === "string") id = envelope.id;
      if (envelope.type !== "message") continue;
      const message = record(envelope.message);
      const role = typeof message.role === "string" ? message.role : "";
      if (role === "user") {
        const text = contentText(message.content);
        if (text) tasks.push(text);
        finalAssistantState = "running";
      }
      if (role === "assistant") {
        const content = Array.isArray(message.content) ? message.content : [];
        const text = contentText(content);
        if (text) assistantOutputs.push(text);
        for (const [partIndex, rawPart] of content.entries()) {
          const part = record(rawPart);
          if (part.type !== "toolCall" || typeof part.name !== "string") continue;
          const actionId = typeof part.id === "string" ? part.id : `${id}-${index}-${partIndex}`;
          const input = compactArguments(part.arguments);
          actions.set(actionId, {
            id: actionId,
            tool: part.name,
            status: "running",
            ...(input ? { input } : {}),
            ...(at ? { at } : {}),
          });
        }
        if (message.stopReason === "error") {
          const error = typeof message.errorMessage === "string" ? limitedText(message.errorMessage, 700) : "Agent execution was interrupted";
          errors.push(error);
          finalAssistantState = "interrupted";
        } else if (message.stopReason === "stop") {
          finalAssistantState = "completed";
        }
      }
      if (role === "toolResult") {
        const actionId = typeof message.toolCallId === "string" ? message.toolCallId : `${id}-result-${index}`;
        const previous = actions.get(actionId);
        const output = contentText(message.content);
        const isError = message.isError === true;
        const actionAt = previous?.at ?? at;
        actions.set(actionId, {
          id: actionId,
          tool: typeof message.toolName === "string" ? message.toolName : previous?.tool ?? "tool",
          status: isError ? "error" : "completed",
          ...(previous?.input ? { input: previous.input } : {}),
          ...(output ? { output: limitedText(output, 900) } : {}),
          ...(actionAt ? { at: actionAt } : {}),
        });
        if (isError && output) errors.push(limitedText(output, 700));
      }
    } catch {
      // Ignore partial records while Pi is appending to the session.
    }
  }

  const task = tasks[0];
  const output = assistantOutputs.at(-1);
  const session: AgentSessionView = {
    id,
    agent,
    title: AGENT_TITLES[agent] ?? agent.replaceAll("-", " "),
    status: finalAssistantState,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(task ? { task } : {}),
    ...(tasks.length > 1 ? { followUps: tasks.slice(1).slice(-4) } : {}),
    ...(output ? { output } : {}),
    actionCount: actions.size,
    actions: [...actions.values()].slice(-60),
    errors: [...new Set(errors)].slice(-8),
  };
  agentSessionCache.set(path, { mtimeMs: info.mtimeMs, session });
  return session;
}

async function agentSessions(runDir: string): Promise<AgentSessionView[]> {
  const root = join(runDir, "sessions");
  const sessions: AgentSessionView[] = [];
  for (const agentEntry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!agentEntry.isDirectory()) continue;
    const directory = join(root, agentEntry.name);
    for (const file of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      sessions.push(await indexAgentSession(join(directory, file.name), agentEntry.name));
    }
  }
  return sessions.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
}

export async function runAgentSessions(workspaceDir: string, runId: string): Promise<AgentSessionView[]> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId)) throw new Error("Invalid run id");
  return agentSessions(join(workspaceDir, "runs", runId));
}

function agentSessionSummary(session: AgentSessionView): AgentSessionView {
  return {
    id: session.id,
    agent: session.agent,
    title: session.title,
    status: session.status,
    ...(session.createdAt ? { createdAt: session.createdAt } : {}),
    ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
    actionCount: session.actionCount,
    actions: [],
    errors: [],
  };
}

async function indexSessionFile(path: string, label: "CLI task" | "Design brief"): Promise<SessionFileIndex> {
  const info = await stat(path);
  const cached = sessionFileCache.get(path);
  if (cached?.mtimeMs === info.mtimeMs) return cached;
  const jsonl = await indexedJsonl(path);
  const source = jsonl.source;
  const activity: TimelineView[] = [];
  const canonicalRunIds = new Set<string>();
  let sessionId: string | undefined;
  for (const [index, value] of jsonl.rows.entries()) {
    try {
      const envelope = record(value);
      if (envelope.type === "session" && typeof envelope.id === "string") sessionId = envelope.id;
      if (envelope.type !== "message") continue;
      const message = record(envelope.message);
      const at = typeof envelope.timestamp === "string" ? envelope.timestamp : undefined;
      if (message.role === "toolResult" && message.toolName === "run_init" && message.isError !== true) {
        const text = JSON.stringify(message.content);
        for (const match of text.matchAll(/runId[^a-zA-Z0-9]+([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})/g)) canonicalRunIds.add(match[1]!);
      }
      if (message.role === "user" && Array.isArray(message.content)) {
        const text = message.content.map(record).flatMap((part) => typeof part.text === "string" ? [part.text] : []).join("\n").trim();
        if (text) activity.push({ id: `session-${basename(path)}-${index}`, kind: "thought", label, detail: text.slice(0, 360), ...(at ? { at } : {}) });
      }
      if (message.role === "assistant" && message.stopReason === "error") {
        activity.push({
          id: `session-${basename(path)}-${index}`,
          kind: "error",
          label: "Agent run interrupted",
          detail: typeof message.errorMessage === "string" ? message.errorMessage : "Agent execution was interrupted",
          ...(at ? { at } : {}),
        });
      }
    } catch {
      // Ignore partial session records.
    }
  }
  const indexed: SessionFileIndex = { mtimeMs: info.mtimeMs, source, canonicalRunIds, activity, ...(sessionId ? { sessionId } : {}) };
  sessionFileCache.set(path, indexed);
  return indexed;
}

async function busActivity(runDir: string): Promise<TimelineView[]> {
  const result: TimelineView[] = [];
  const retryByOperation = new Map<string, TimelineView>();
  const rows = (await indexedJsonl(join(runDir, "bus.jsonl")).catch(() => ({ rows: [] }))).rows;
  for (const [index, value] of rows.entries()) {
    try {
      const event = record(value);
      if (["agent_cleanup_metrics", "image_request_metrics", "image_item_finished"].includes(String(event.type))) continue;
      const type = typeof event.type === "string" ? event.type : "workflow_update";
      const operation = typeof event.operation === "string" ? event.operation : type;
      if (type === "operation_retry") {
        const scope = typeof event.scope === "string" ? event.scope : undefined;
        const retryKey = scope ? `${operation}:${scope}` : operation;
        const existing = retryByOperation.get(retryKey);
        if (existing) {
          existing.retryCount = (existing.retryCount ?? 1) + 1;
          if (typeof event.error === "string") existing.detail = event.error;
          if (typeof event.at === "string") existing.at = event.at;
        } else {
          const item: TimelineView = {
            id: `bus-retry-${retryKey}-${index}`,
            kind: "tool",
            label: `${operation}${scope ? ` · ${scope}` : ""} reconnecting`,
            detail: typeof event.error === "string" ? event.error : "A retryable operation is being resumed.",
            retryCount: 1,
            ...(typeof event.at === "string" ? { at: event.at } : {}),
          };
          retryByOperation.set(retryKey, item);
          result.push(item);
        }
        continue;
      }
      const failed = type.includes("interrupted") || event.severity === "error";
      const artifactRefs = stringArray(event.artifactRefs);
      result.push({
        id: typeof event.id === "string" ? event.id : `bus-${index}`,
        kind: failed ? "error" : "result",
        label: typeof event.summary === "string" ? event.summary : type.replaceAll("_", " "),
        ...(event.type === "design_categories_identified" && typeof event.detail === "string" ? { detail: event.detail } : typeof event.requestedAction === "string" ? { detail: event.requestedAction } : {}),
        ...(typeof event.at === "string" ? { at: event.at } : {}),
        ...(typeof event.phase === "string" ? { stage: event.phase } : {}),
        ...(artifactRefs ? { artifactRefs } : {}),
      });
    } catch {
      // A process may have stopped while writing the final JSONL line.
    }
  }
  return result;
}

async function sessionActivity(workspaceDir: string, runId: string): Promise<{ activity: TimelineView[]; sessionId?: string }> {
  const result: TimelineView[] = [];
  let sessionId: string | undefined;
  let canonicalSessionId: string | undefined;
  for (const sessionDir of [join(workspaceDir, "sessions"), join(workspaceDir, "sessions", "cli")]) {
    for (const item of await readdir(sessionDir, { withFileTypes: true }).catch(() => [])) {
      if (!item.isFile() || !item.name.endsWith(".jsonl")) continue;
      const indexed = await indexSessionFile(join(sessionDir, item.name), sessionDir.endsWith("cli") ? "CLI task" : "Design brief");
      if (!indexed.source.includes(runId)) continue;
      if (indexed.sessionId) sessionId = indexed.sessionId;
      if (indexed.sessionId && indexed.canonicalRunIds.has(runId)) canonicalSessionId = indexed.sessionId;
      result.push(...indexed.activity);
    }
  }
  const linkedSessionId = canonicalSessionId ?? sessionId;
  return { activity: result, ...(linkedSessionId ? { sessionId: linkedSessionId } : {}) };
}

async function showcasePath(runDir: string, manifest?: Record<string, unknown>): Promise<string | undefined> {
  const presentation = record(manifest?.presentation);
  if (manifest?.schemaVersion === 2 && presentation.mode === "html" && typeof presentation.entry === "string" && /^artifacts\/(?!.*(?:^|\/)\.\.\/).+\.html$/u.test(presentation.entry)) {
    for (const path of [join(runDir, "final", presentation.entry), join(runDir, presentation.entry)]) if (await stat(path).then((info) => info.isFile()).catch(() => false)) return path;
    return undefined;
  }
  const candidates = [
    join(runDir, "final", "00-index.html"),
    join(runDir, "final", "artifacts", "00-gallery.html"),
    join(runDir, "artifacts", "00-gallery.html"),
  ];
  for (const path of candidates) if (await stat(path).then(() => true).catch(() => false)) return path;
  return undefined;
}

export async function runInventory(workspaceDir: string, options: { summary?: boolean; runId?: string } = {}): Promise<RunView[]> {
  const runsDir = join(workspaceDir, "runs");
  const runs: RunView[] = [];
  for (const entry of await readdir(runsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || (options.runId && entry.name !== options.runId)) continue;
    const runDir = join(runsDir, entry.name);
    const info = await stat(runDir);
    const brief: Record<string, unknown> = await readFile(join(runDir, "brief.json"), "utf8").then((source) => record(JSON.parse(source) as unknown)).catch(() => ({}));
    const state: Record<string, unknown> = await readFile(join(runDir, "run-state.json"), "utf8").then((source) => record(JSON.parse(source) as unknown)).catch(() => ({}));
    const scope = record(brief.resolvedScope);
    const files = await walk(runDir);
    const documents = files
      .filter((path) => {
        const runPath = relative(runDir, path).replaceAll("\\", "/");
        return !runPath.startsWith("final/") && !runPath.startsWith(".performance/") && !/\.(page-cache|acquisition-budget)\.json$/u.test(path) && /\.(md|json)$/i.test(path) && !/[\\/](brief|run-state)\.json$/i.test(path);
      })
      .map((path) => relative(runDir, path).replaceAll("\\", "/"));
    const session = options.summary && typeof brief.sessionId === "string" ? { sessionId: brief.sessionId, activity: [] } : await sessionActivity(workspaceDir, entry.name);
    const childSessions = options.summary ? [] : await agentSessions(runDir);
    const activity = options.summary ? [] : [...await busActivity(runDir), ...session.activity]
      .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")))
      .slice(-40);
    const rawBrief = typeof brief.brief === "string" ? brief.brief.trim() : "";
    const title = [scope.human_title, brief.title, scope.run_name]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()))
      ?? (rawBrief ? rawBrief.slice(0, 72) : entry.name);
    const stages = Object.fromEntries(Object.entries(record(state.stages)).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
    const builtManifest = await readFile(join(runDir, "artifacts/artifact-manifest.json"), "utf8").then((source) => record(JSON.parse(source))).catch(() => undefined);
    const path = await showcasePath(runDir, builtManifest);
    const presentation = record(builtManifest?.presentation);
    const updatedAt = typeof state.updatedAt === "string" ? state.updatedAt : info.mtime.toISOString();
    const lastError = activity.filter((item) => item.kind === "error").at(-1);
    const persistedStatus = typeof state.status === "string" ? state.status : "existing";
    runs.push({
      id: entry.name,
      title,
      createdAt: typeof brief.createdAt === "string" ? brief.createdAt : info.birthtime.toISOString(),
      updatedAt,
      status: persistedStatus === "active" && lastError?.at && lastError.at > updatedAt ? "interrupted" : persistedStatus,
      stages,
      assetCount: files.filter((file) => {
        const runPath = relative(runDir, file).replaceAll("\\", "/");
        return !runPath.startsWith("plan/html/") && !runPath.startsWith(".performance/") && /\.(png|jpe?g|webp|gif|svg|html)$/i.test(file) && (!runPath.startsWith("final/") || runPath === "final/00-index.html");
      }).length,
      documents: options.summary ? [] : documents,
      notes: options.summary ? [] : await runNotes(runDir),
      activity,
      agentSessions: childSessions.map(agentSessionSummary),
      ...(builtManifest?.modelUsage ? { modelUsage: builtManifest.modelUsage as NonNullable<RunView["modelUsage"]> } : {}),
      ...(path ? { showcasePath: relative(workspaceDir, path).replaceAll("\\", "/") } : {}),
      ...(builtManifest?.schemaVersion === 2 && ["html", "gallery"].includes(String(presentation.mode)) && typeof presentation.entry === "string" ? { presentation: { mode: presentation.mode as "html" | "gallery", entry: presentation.entry } } : {}),
      ...(Array.isArray(builtManifest?.htmlEntries) ? { htmlEntries: builtManifest.htmlEntries.filter((path): path is string => typeof path === "string" && path.startsWith("artifacts/") && path.endsWith(".html")) } : {}),
      ...(session.sessionId || typeof brief.sessionId === "string" ? { sessionId: session.sessionId ?? brief.sessionId as string } : {}),
    });
  }
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
