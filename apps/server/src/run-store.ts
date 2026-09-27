import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

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

export interface RunNoteView {
  id: "research" | "plan" | "critique";
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
  showcasePath?: string;
  sessionId?: string;
}

const NOTE_FILES: Array<{ id: RunNoteView["id"]; title: string; path: string }> = [
  { id: "research", title: "Research findings", path: "research/research.md" },
  { id: "plan", title: "Design rationale", path: "plan/task_breakdown.md" },
  { id: "critique", title: "Visual critique", path: "review/critique.md" },
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
    const text = await readFile(join(runDir, candidate.path), "utf8").then(compactMarkdown).catch(() => "");
    if (text) notes.push({ ...candidate, text });
  }
  return notes;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const child of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
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
    if (!/\.(png|jpe?g|webp|gif|html|mp4|webm|glb|gltf)$/i.test(path)) continue;
    const workspacePath = relative(workspaceDir, path).replaceAll("\\", "/");
    const resolvedRunId = runId ?? runIdFromPath(workspaceDir, path);
    if (resolvedRunId) {
      const runDir = join(workspaceDir, "runs", resolvedRunId);
      const runPath = relative(runDir, path).replaceAll("\\", "/");
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

async function indexSessionFile(path: string, label: "CLI task" | "Design brief"): Promise<SessionFileIndex> {
  const info = await stat(path);
  const cached = sessionFileCache.get(path);
  if (cached?.mtimeMs === info.mtimeMs) return cached;
  const source = await readFile(path, "utf8").catch(() => "");
  const activity: TimelineView[] = [];
  const canonicalRunIds = new Set<string>();
  let sessionId: string | undefined;
  for (const [index, line] of source.split(/\r?\n/).filter(Boolean).entries()) {
    try {
      const envelope = record(JSON.parse(line) as unknown);
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
  const lines = await readFile(join(runDir, "bus.jsonl"), "utf8").catch(() => "");
  for (const [index, line] of lines.split(/\r?\n/).filter(Boolean).entries()) {
    try {
      const event = record(JSON.parse(line) as unknown);
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
      const failed = type.includes("fail") || type.includes("interrupted") || event.severity === "error";
      const artifactRefs = stringArray(event.artifactRefs);
      result.push({
        id: typeof event.id === "string" ? event.id : `bus-${index}`,
        kind: failed ? "error" : "result",
        label: typeof event.summary === "string" ? event.summary : type.replaceAll("_", " "),
        ...(typeof event.requestedAction === "string" ? { detail: event.requestedAction } : {}),
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

async function showcasePath(runDir: string): Promise<string | undefined> {
  const candidates = [
    join(runDir, "final", "00-index.html"),
    join(runDir, "final", "artifacts", "00-gallery.html"),
    join(runDir, "artifacts", "00-gallery.html"),
  ];
  for (const path of candidates) if (await stat(path).then(() => true).catch(() => false)) return path;
  return undefined;
}

export async function runInventory(workspaceDir: string): Promise<RunView[]> {
  const runsDir = join(workspaceDir, "runs");
  const runs: RunView[] = [];
  for (const entry of await readdir(runsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const runDir = join(runsDir, entry.name);
    const info = await stat(runDir);
    const brief: Record<string, unknown> = await readFile(join(runDir, "brief.json"), "utf8").then((source) => record(JSON.parse(source) as unknown)).catch(() => ({}));
    const state: Record<string, unknown> = await readFile(join(runDir, "run-state.json"), "utf8").then((source) => record(JSON.parse(source) as unknown)).catch(() => ({}));
    const scope = record(brief.resolvedScope);
    const files = await walk(runDir);
    const documents = files
      .filter((path) => {
        const runPath = relative(runDir, path).replaceAll("\\", "/");
        return !runPath.startsWith("final/") && /\.(md|json)$/i.test(path) && !/[\\/](brief|run-state)\.json$/i.test(path);
      })
      .map((path) => relative(runDir, path).replaceAll("\\", "/"));
    const session = await sessionActivity(workspaceDir, entry.name);
    const activity = [...await busActivity(runDir), ...session.activity]
      .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")))
      .slice(-40);
    const rawBrief = typeof brief.brief === "string" ? brief.brief.trim() : "";
    const title = [scope.human_title, scope.run_name]
      .find((value): value is string => typeof value === "string" && Boolean(value.trim()))
      ?? (rawBrief ? rawBrief.slice(0, 72) : entry.name);
    const stages = Object.fromEntries(Object.entries(record(state.stages)).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
    const path = await showcasePath(runDir);
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
        return /\.(png|jpe?g|webp|gif|html)$/i.test(file) && (!runPath.startsWith("final/") || runPath === "final/00-index.html");
      }).length,
      documents,
      notes: await runNotes(runDir),
      activity,
      ...(path ? { showcasePath: relative(workspaceDir, path).replaceAll("\\", "/") } : {}),
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    });
  }
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
