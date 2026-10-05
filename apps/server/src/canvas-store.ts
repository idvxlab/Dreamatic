import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CanvasElementState {
  id: string;
  kind: "image" | "html" | "text" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  assetPath?: string;
  text?: string;
  role?: string;
}

export interface CanvasState {
  version: 1;
  runId: string;
  updatedAt: string;
  camera: { x: number; y: number; zoom: number };
  elements: CanvasElementState[];
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
  const elements = Array.isArray(source.elements) ? source.elements.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== "string" || !["image", "html", "text", "group"].includes(String(item.kind))) return [];
    return [{
      id: item.id.slice(0, 180),
      kind: item.kind as CanvasElementState["kind"],
      x: finite(item.x),
      y: finite(item.y),
      width: Math.max(80, Math.min(2400, finite(item.width, 320))),
      height: Math.max(40, Math.min(2400, finite(item.height, 220))),
      ...(typeof item.assetPath === "string" ? { assetPath: item.assetPath } : {}),
      ...(typeof item.text === "string" ? { text: item.text.slice(0, 20_000) } : {}),
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
  };
}

export async function readCanvasState(workspaceDir: string, runId: string): Promise<CanvasState | null> {
  const path = join(workspaceDir, "runs", safeRunId(runId), "canvas", "canvas-state.json");
  return readFile(path, "utf8")
    .then((source) => normalizeCanvasState(runId, JSON.parse(source) as unknown))
    .catch(() => null);
}

export async function writeCanvasState(workspaceDir: string, runId: string, value: unknown): Promise<CanvasState> {
  const state = { ...normalizeCanvasState(runId, value), updatedAt: new Date().toISOString() };
  const path = join(workspaceDir, "runs", state.runId, "canvas", "canvas-state.json");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
  await rename(temporary, path);
  return state;
}
