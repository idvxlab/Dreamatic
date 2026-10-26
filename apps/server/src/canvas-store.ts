import { PROMPT_MIN_SIZE } from '@dreamatic/project-data/canvas-graph';
import { normalizeCanvasEdges, type CanvasEdge } from '@dreamatic/project-data/canvas-graph';
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CanvasElementState {
  id: string;
  kind: "image" | "video" | "html" | "text" | "group" | "prompt";
  x: number;
  y: number;
  width: number;
  height: number;
  assetPath?: string;
  fileId?: string;
  text?: string;
  role?: string;
  taskId?: string;
  outputTaskId?: string;
}

export interface CanvasState {
  version: 1;
  runId: string;
  updatedAt: string;
  camera: { x: number; y: number; zoom: number };
  elements: CanvasElementState[];
  edges?: CanvasEdge[];
  handledTaskIds?: string[];
}

function safeRunId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new Error("Invalid run id");
  return value;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeCanvasState(runId: string, value: unknown): CanvasState {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const camera = source.camera && typeof source.camera === "object" && !Array.isArray(source.camera) ? source.camera as Record<string, unknown> : {};
  const seen = new Set<string>();
  const elements = Array.isArray(source.elements) ? source.elements.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== "string" || !["image", "video", "html", "text", "group", "prompt"].includes(String(item.kind))) return [];
    if (!item.id || seen.has(item.id.slice(0, 180))) return [];
    seen.add(item.id.slice(0, 180));
    return [{
      id: item.id.slice(0, 180),
      kind: item.kind as CanvasElementState["kind"],
      x: finite(item.x),
      y: finite(item.y),
      width: Math.max(item.kind === "prompt" ? PROMPT_MIN_SIZE.width : 80, Math.min(2400, finite(item.width, 320))),
      height: Math.max(item.kind === "prompt" ? PROMPT_MIN_SIZE.height : 40, Math.min(2400, finite(item.height, 220))),
      ...(typeof item.fileId === "string" ? { fileId: item.fileId } : {}),
      ...(typeof item.assetPath === "string" ? { assetPath: item.assetPath } : {}),
      ...(typeof item.text === "string" ? { text: item.text.slice(0, 20_000) } : {}),
      ...(typeof item.taskId === "string" ? { taskId: item.taskId } : {}),
      ...(typeof item.outputTaskId === "string" ? { outputTaskId: item.outputTaskId } : {}),
      ...(typeof item.role === "string" ? { role: item.role } : {}),
    }];
  }) : [];
  return {
    version: 1,
    runId: safeRunId(runId),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : new Date().toISOString(),
    camera: {
      x: finite(camera.x),
      y: finite(camera.y),
      zoom: Math.max(.2, Math.min(2.4, finite(camera.zoom, .8))),
    },
    elements,
    edges: normalizeCanvasEdges(elements, source.edges),
    handledTaskIds: Array.isArray(source.handledTaskIds) ? [...new Set(source.handledTaskIds.filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)))] : [],
  };
}

export async function readCanvasState(workspaceDir: string, runId: string): Promise<CanvasState | null> {
  const path = join(workspaceDir, "runs", safeRunId(runId), "canvas", "canvas-state.json");
  return readFile(path, "utf8")
    .then((source) => normalizeCanvasState(runId, JSON.parse(source) as unknown))
    .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
}

const writes = new Map<string, Promise<CanvasState>>();
export async function writeCanvasState(workspaceDir: string, runId: string, value: unknown): Promise<CanvasState> {
  const state = { ...normalizeCanvasState(runId, value), updatedAt: new Date().toISOString() };
  const key = join(workspaceDir, 'runs', state.runId);
  const operation = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const workspace = await realpath(workspaceDir);
    const runs = join(workspace, 'runs');
    await mkdir(runs, { recursive: true });
    if (await realpath(runs) !== runs) throw new Error('Invalid canvas directory');
    const root = join(runs, state.runId);
    await mkdir(root, { recursive: true });
    if (await realpath(root) !== root) throw new Error('Invalid canvas directory');
    const folder = join(root, 'canvas');
    await mkdir(folder, { recursive: true });
    if (await realpath(folder) !== folder) throw new Error('Invalid canvas directory');
    const path = join(folder, 'canvas-state.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8'); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
    return state;
  });
  writes.set(key, operation);
  try { return await operation; } finally { if (writes.get(key) === operation) writes.delete(key); }
}
